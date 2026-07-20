import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';

import {
  PrismaService,
  JobEventPayload,
  AgentOutputsByType,
  SonnetSynthesisOutput,
  LlmClient,
  Prisma,
  jobStatusKey,
  jobAgentsDoneKey,
  jobAgentsExpectedKey,
  jobEventsChannel,
  jobSynthesizingLockKey,
  jobEpochKey,
  jobRepoFactsKey,
  runKeyOf,
  RepoFacts,
  TokenUsage,
  totalTokens,
} from '@app/common';
import { DiagramsService } from '../diagrams/diagrams.service';
import { ReportRenderer } from '../report/report-renderer.service';

const SONNET_MODEL =
  process.env.ANTHROPIC_SYNTHESIS_MODEL ?? 'claude-sonnet-4-6';
const OPENAI_SYNTHESIS_MODEL = process.env.OPENAI_SYNTHESIS_MODEL ?? 'gpt-4o';
const MISTRAL_SYNTHESIS_MODEL =
  process.env.MISTRAL_SYNTHESIS_MODEL ?? 'mistral-large-latest';

/**
 * How often to look for jobs whose wakeup was dropped. Long enough to be
 * negligible (one indexed query + two SCARDs per running job), short enough
 * that a lost message costs a wait, not the job.
 */
const SWEEP_INTERVAL_MS = 30_000;

/**
 * When Redis's completion counters have lapsed — evicted, or expired while this
 * process was down long enough (e.g. an OOM kill) — a `running` job that already
 * has agent results in Postgres and is older than this is treated as stalled and
 * recovered from durable state. Long enough that a just-dispatched job whose
 * agents are still running is never pre-empted.
 */
const STALLED_MIN_AGE_MS = 5 * 60_000; // 5 min

@Injectable()
export class SynthesizerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SynthesizerService.name);
  private readonly client = new LlmClient();
  private subscriber: Redis;
  private sweepTimer?: NodeJS.Timeout;

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly prisma: PrismaService,
    private readonly diagrams: DiagramsService,
    private readonly renderer: ReportRenderer,
  ) {
    // Dedicated subscriber connection — a client used for pub/sub can't also issue commands.
    this.subscriber = redis.duplicate();
  }

  async onModuleInit(): Promise<void> {
    this.subscriber.on(
      'pmessage',
      (_pattern: string, channel: string, jobId: string) => {
        if (channel.endsWith(':ready_for_synthesis')) {
          this.synthesize(jobId).catch((err: unknown) => {
            this.logger.error(`Unhandled synthesis error [job=${jobId}]`, err);
          });
        }
      },
    );
    await this.subscriber.psubscribe('job:*:ready_for_synthesis');
    this.logger.log('Synthesizer listening for completed jobs');

    // Redis pub/sub has no durability: it delivers to whoever is connected at
    // publish time and forgets. If this process is down for even a moment —
    // OOM kill, redeploy, crash — the `ready_for_synthesis` for a job whose
    // last agent just finished is delivered to nobody, and that job sits at
    // "synthesizing" forever with every agent result already paid for and
    // sitting in Postgres. That is exactly what happened.
    //
    // So pub/sub stays as the fast path (sub-second), and this sweep is the
    // backstop that makes a missed wakeup recoverable rather than terminal.
    // Section 7 explicitly allows "SCARD after each SADD, or a lightweight
    // poll — your choice, document which you pick": this is both, and the
    // reason for both is that the first one alone can drop the message.
    await this.sweepStalledJobs();
    this.sweepTimer = setInterval(() => {
      this.sweepStalledJobs().catch((err: unknown) => {
        this.logger.error('Stalled-job sweep failed', err);
      });
    }, SWEEP_INTERVAL_MS);
    // Don't hold the event loop open on shutdown.
    this.sweepTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  /**
   * Find jobs whose agents have all finished but which never got synthesized,
   * and drive them. `synthesize()` is already idempotent — it claims a Redis
   * lock and bails if a report exists — so a job picked up here that is
   * genuinely in flight is a no-op, not a double Sonnet call.
   */
  private async sweepStalledJobs(): Promise<void> {
    const running = await this.prisma.job.findMany({
      where: { status: 'running' },
      select: { id: true, createdAt: true },
    });

    for (const { id: jobId, createdAt } of running) {
      try {
        const [done, expected] = await Promise.all([
          this.redis.scard(jobAgentsDoneKey(jobId)),
          this.redis.scard(jobAgentsExpectedKey(jobId)),
        ]);

        if (expected > 0) {
          // Fast path: Redis still holds the completion counters.
          if (done < expected) continue;
        } else {
          // Redis counters are gone — evicted, or lapsed while this process was
          // down (an OOM kill can strand a job here for hours). Fall back to
          // DURABLE Postgres so the job stays recoverable: synthesize only if it
          // already has agent results AND is old enough to be genuinely stalled,
          // so a just-dispatched job whose agents are still running is never
          // pre-empted.
          const agentCount = await this.prisma.agentResult.count({
            where: { jobId },
          });
          const stalledLongEnough =
            Date.now() - createdAt.getTime() > STALLED_MIN_AGE_MS;
          if (agentCount === 0 || !stalledLongEnough) continue;
        }

        this.logger.warn(
          `Recovering stalled job — agents done but never synthesized [job=${jobId}]`,
        );
        await this.synthesize(jobId);
      } catch (err: unknown) {
        this.logger.error(`Sweep failed for job=${jobId}`, err);
      }
    }
  }

  async synthesize(jobId: string): Promise<void> {
    // Claim the job before doing anything — harmless at 1 replica, required
    // if this ever scales to more than 1 (every replica hears the same
    // pub/sub message). Lock expires on its own so a crash mid-synthesis
    // doesn't strand the job unclaimed forever.
    const claimed = await this.redis.set(
      jobSynthesizingLockKey(jobId),
      '1',
      'EX',
      300,
      'NX',
    );
    if (!claimed) {
      this.logger.debug(`Synthesis already claimed [job=${jobId}], skipping`);
      return;
    }

    // The claim lock expires after 300s so a crash mid-synthesis can't strand a
    // job — which means it is a concurrency guard, NOT an idempotency guard.
    // `ready_for_synthesis` can legitimately fire twice for one job: a message
    // that burned its delivery-limit dead-letters, and the DLQ consumer's
    // recordInfraFailure re-runs the same completion bookkeeping — SADD (no-op),
    // SCARD (still complete), publish. Arriving more than 300s after the first
    // synthesis, that lock is long gone and the job gets a second Sonnet call and
    // a duplicate report row.
    //
    // A report already existing is the honest "this is done" signal, and it needs
    // no new Redis key.
    const existing = await this.prisma.report.findFirst({ where: { jobId } });
    if (existing) {
      this.logger.warn(
        `Synthesis re-triggered for a job that already has a report — ignoring [job=${jobId}]`,
      );
      return;
    }

    // Resurrection guard. A cancel bumps the epoch and wipes the completion
    // counters, but an agent that finished between its last fence check and its
    // SADD can still push the (freshly wiped) done-set to completion and publish
    // ready_for_synthesis. Without this check that would mint a report for a job
    // the user explicitly abandoned and flip it back to `done`. The DB status is
    // the durable source of truth for "the user cancelled".
    const current = await this.prisma.job.findUnique({
      where: { id: jobId },
      select: { status: true },
    });
    if (current?.status === 'cancelled') {
      this.logger.warn(
        `Synthesis skipped — job was cancelled by the user [job=${jobId}]`,
      );
      return;
    }

    this.logger.log(`Synthesis started [job=${jobId}]`);
    const t = Date.now();

    try {
      // 1. Load agent results from Postgres. rawOutput is untyped LLM JSON at
      //    the DB boundary — one explicit cast here, typed everywhere after.
      //    Retries append new rows rather than replacing, so a job can carry
      //    several rows per agent type; collapse to the most recent attempt per
      //    type (same rule the API's getLatestAgentResults uses) so superseded
      //    rows never poison the Sonnet input or double-count tokens.
      const allRows = await this.prisma.agentResult.findMany({
        where: { jobId },
        orderBy: { createdAt: 'desc' },
      });
      const latestByType = new Map<string, (typeof allRows)[number]>();
      for (const row of allRows) {
        if (!latestByType.has(row.agentType))
          latestByType.set(row.agentType, row);
      }
      const results = [...latestByType.values()];

      // If not one agent produced usable output there is nothing to synthesize
      // — a Sonnet call over five empty objects yields a hallucinated report.
      // This is the signature of a broken run (e.g. the code graph failed to
      // build, so every agent errored with "CodeGraph not initialized"). Fail
      // the job with a clear, user-actionable reason instead of emitting junk
      // or hanging forever; the frontend turns job:failed into a retry action.
      const succeeded = results.filter((r) => r.status === 'success');
      if (succeeded.length === 0) {
        this.logger.warn(
          `All ${results.length} agent(s) failed — marking job failed instead of synthesizing [job=${jobId}]`,
        );
        await this.failJob(
          jobId,
          'Analysis could not be completed — none of the agents produced a result. ' +
            'This usually means the code graph failed to build for this repository. Please retry.',
        );
        return;
      }

      const byType = Object.fromEntries(
        results.map((r) => [r.agentType, r.rawOutput]),
      ) as AgentOutputsByType;

      // The same AST ground truth the agents were given. The report quotes it
      // directly — counts, real routes, the real module graph — so the numbers
      // in the output are measured rather than recalled. Best-effort: an older
      // job whose facts have aged out of Redis still renders, just without them.
      const facts = await this.loadFacts(jobId);

      // 2. ONE Sonnet call for executive summary + recommendations only.
      //    Agents already did the extraction — Sonnet does cross-agent reasoning.
      const { synthesis, usage: synthesisUsage } =
        await this.callSonnet(byType);

      // 3. Build every diagram from structured agent JSON and render each to
      //    SVG — still ZERO LLM calls; D2 layout and the charts are pure code.
      //    Runs after synthesis because the health gauge needs its score.
      const diagrams = await this.diagrams.buildAll(
        byType,
        synthesis.overallHealthScore ?? 0,
        facts,
      );

      // Every token the job actually processed: each agent's row plus the
      // synthesis call itself, which was previously never counted at all — the
      // reported cost understated the real cost by one Sonnet call on every job.
      // totalTokens() covers all four usage classes; see TokenUsage for why
      // input + output alone stops being the truth once caching is on.
      const agentTokens = results.reduce((sum, r) => {
        const tokens = r.tokensUsed as TokenUsage | null;
        return sum + (tokens ? totalTokens(tokens) : 0);
      }, 0);
      const reportTotalTokens = agentTokens + totalTokens(synthesisUsage);

      // 4. Render the full Markdown report
      const markdown = this.renderer.render({
        jobId,
        agentOutputs: byType,
        diagrams,
        synthesis,
        totalTokens: reportTotalTokens,
        facts,
      });

      // 5. Persist. Markdown carries the diagram *sources*; the rendered SVGs
      //    ride alongside so neither the exporter nor the frontend re-renders.
      //    `synthesis` is stored structurally as well as prose-rendered — the
      //    dashboard reads the health score as a number, not from the heading.
      await this.prisma.report.create({
        data: {
          jobId,
          markdownContent: markdown,
          diagrams: diagrams as unknown as Prisma.InputJsonValue,
          synthesis: synthesis as unknown as Prisma.InputJsonValue,
          totalTokens: reportTotalTokens,
        },
      });
      await this.prisma.job.update({
        where: { id: jobId },
        data: { status: 'done', completedAt: new Date() },
      });
      await this.redis.set(jobStatusKey(jobId), 'done');
      await this.redis.del(
        jobAgentsDoneKey(jobId),
        jobAgentsExpectedKey(jobId),
      );

      const event: JobEventPayload = { type: 'job:complete', jobId };
      await this.redis.publish(jobEventsChannel(jobId), JSON.stringify(event));

      this.logger.log(
        `Synthesis complete in ${Date.now() - t}ms [job=${jobId}] | report=${markdown.length} chars`,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Synthesis failed [job=${jobId}]: ${message}`);
      await this.failJob(jobId, message);
    }
  }

  /**
   * Move a job to a terminal `failed` state and tell the frontend why. Clears
   * the completion-tracking sets too, so a subsequent retry starts from a clean
   * slate rather than inheriting a half-full agents_done. Shared by the
   * all-agents-failed guard and the catch-all synthesis error path.
   */
  private async failJob(jobId: string, reason: string): Promise<void> {
    await this.prisma.job.update({
      where: { id: jobId },
      data: { status: 'failed', completedAt: new Date() },
    });
    await this.redis.set(jobStatusKey(jobId), 'failed');
    await this.redis.del(jobAgentsDoneKey(jobId), jobAgentsExpectedKey(jobId));

    const event: JobEventPayload = { type: 'job:failed', jobId, reason };
    await this.redis.publish(jobEventsChannel(jobId), JSON.stringify(event));
  }

  /**
   * Read this job's AST ground truth.
   *
   * The synthesizer only knows the jobId — the facts are keyed by runKey
   * (`{jobId}-{epoch}`), because they describe one specific checkout and a
   * force-retry produces a different one. So resolve the epoch first; reading
   * `job:{jobId}:repo_facts` would be reading a key that never existed.
   */
  private async loadFacts(jobId: string): Promise<RepoFacts | undefined> {
    try {
      const epoch = Number((await this.redis.get(jobEpochKey(jobId))) ?? 0);
      const raw = await this.redis.get(jobRepoFactsKey(runKeyOf(jobId, epoch)));
      if (!raw) {
        this.logger.warn(
          `No repo_facts for job=${jobId} epoch=${epoch} — report will omit the measured sections`,
        );
        return undefined;
      }
      return JSON.parse(raw) as RepoFacts;
    } catch (e: unknown) {
      this.logger.warn(
        `Failed to read repo_facts [job=${jobId}]: ${String(e)}`,
      );
      return undefined;
    }
  }

  private async callSonnet(
    byType: AgentOutputsByType,
  ): Promise<{ synthesis: SonnetSynthesisOutput; usage: TokenUsage }> {
    const response = await this.client.complete({
      anthropicModel: SONNET_MODEL,
      openaiModel: OPENAI_SYNTHESIS_MODEL,
      mistralModel: MISTRAL_SYNTHESIS_MODEL,
      maxTokens: 1400,
      system: `You are a principal engineer writing the executive assessment at the top of a codebase intelligence report that a developer will actually read. Respond ONLY with valid JSON. No preamble, no markdown fences.
        Schema:
        {
          "executiveSummary": string,    // 5-8 sentences. Lead with what the system IS and its architecture, then weave in the cross-cutting findings — the most important security, quality, dependency, and documentation signals — and end with the overall risk posture. Reference concrete specifics from the agent outputs (frameworks, real modules, named vulnerabilities/issues). No filler, no generic praise.
          "recommendations": string[],  // top 5 concrete, actionable recommendations ordered by priority (highest impact first). Each names the specific problem and the fix.
          "overallHealthScore": number  // 0-100 codebase health score, justified by the findings below
        }`,
      user: `Here are structured outputs from specialized analysis agents for the same codebase.

          Synthesize them into one coherent assessment. Do not just restate each agent — connect findings across agents (e.g. a security gap that is worse because tests are absent). Ground every claim in the data below.

          ## Architecture Agent Output
          ${JSON.stringify(byType.architecture ?? {}, null, 2)}

          ## Security Agent Output
          ${JSON.stringify(byType.security ?? {}, null, 2)}

          ## Dependency Agent Output
          ${JSON.stringify(byType.dependency ?? {}, null, 2)}

          ## Quality Agent Output
          ${JSON.stringify(byType.quality ?? {}, null, 2)}

          ## Docs Agent Output
          ${JSON.stringify(byType.docs ?? {}, null, 2)}

          Return only JSON.`,
    });

    try {
      const synthesis = JSON.parse(
        response.text.replace(/```json\n?|```/g, '').trim(),
      ) as SonnetSynthesisOutput;
      return { synthesis, usage: response.usage };
    } catch (err: unknown) {
      // This fallback ships a canned summary and a hardcoded health score of 50
      // as if they were real findings. It used to do so silently — an empty
      // `response.text` (the old content[0] bug) produced a plausible-looking
      // report with no trace of the failure anywhere. If this fires, the report
      // is fiction and someone needs to know.
      this.logger.error(
        `Synthesis JSON parse FAILED — report will ship a canned summary and a ` +
          `placeholder health score of 50. Raw response (first 500 chars): ` +
          `${JSON.stringify(response.text.slice(0, 500))} | ${String(err)}`,
      );
      return {
        synthesis: {
          executiveSummary: 'Analysis complete. See individual sections below.',
          recommendations: [],
          overallHealthScore: 50,
        },
        usage: response.usage,
      };
    }
  }
}
