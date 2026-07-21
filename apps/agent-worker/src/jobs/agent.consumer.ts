import { Controller, Logger } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import { ConfigService } from '@nestjs/config';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import * as fs from 'fs/promises';
import * as path from 'path';

import {
  AGENT_ROUTING_KEYS,
  PrismaService,
  AgentType,
  CodeGraphService,
  JobEventPayload,
  jobAgentsDoneKey,
  jobAgentsExpectedKey,
  jobEventsChannel,
  jobReadyForSynthesisChannel,
  jobTokensUsedKey,
  jobEpochKey,
  runKeyOf,
  noTokens,
  totalTokens,
  Prisma,
  RepoFacts,
  jobRepoFactsKey,
  EpochFencedError,
} from '@app/common';

import { ArchitectureAgent } from '../agents/architecture.agent';
import { SecurityAgent } from '../agents/security.agent';
import { DependencyAgent } from '../agents/dependency.agent';
import { QualityAgent } from '../agents/quality.agent';
import { DocsAgent } from '../agents/docs.agent';
import { AgentContext, AgentResult } from '../agents/base.agent';
import { AgentFailureRecorderService } from './agent-failure-recorder.service';

export interface AgentJobMessage {
  jobId: string;
  repoPath: string; // /tmp/repos/{jobId}-{epoch}/ — this run's extracted tarball
  agentType: AgentType;
  totalAgents: number; // informational only — completion is decided via Redis agents_expected
  epoch?: number; // run generation; message is dropped if it doesn't match Redis job:{id}:epoch
  manifest: {
    hasDockerfile: boolean;
    dominantLanguage: string | null;
    languageSupported: boolean;
  };
}

interface AckableChannel {
  ack(message: unknown): void;
  nack(message: unknown, allUpTo: boolean, requeue: boolean): void;
}

@Controller()
export class AgentConsumer {
  private readonly logger = new Logger(AgentConsumer.name);

  // Execution gate shared by all 5 agent consumers — see the constructor.
  private readonly maxConcurrentAgents: number;
  private availableSlots: number;
  private readonly slotWaiters: Array<{
    agentType: AgentType;
    resolve: () => void;
  }> = [];
  private grantTimer: NodeJS.Timeout | null = null;

  // Fixed pipeline order — agents run one-by-one in THIS order regardless of
  // which RabbitMQ queue happens to deliver first, so the pipeline lights up
  // top-to-bottom (architecture first) rather than in arbitrary arrival order.
  private static readonly ORDER: AgentType[] = [
    'architecture',
    'security',
    'dependency',
    'quality',
    'docs',
  ];

  constructor(
    private readonly codeGraphService: CodeGraphService,
    private readonly architectureAgent: ArchitectureAgent,
    private readonly securityAgent: SecurityAgent,
    private readonly dependencyAgent: DependencyAgent,
    private readonly qualityAgent: QualityAgent,
    private readonly docsAgent: DocsAgent,
    private readonly prisma: PrismaService,
    @InjectRedis() private readonly redis: Redis,
    private readonly config: ConfigService,
    private readonly failureRecorder: AgentFailureRecorderService,
  ) {
    // How many agents may run at once across ALL five consumers. Default 1 =
    // strictly one-by-one: Mistral's low-tier rate limit 429s when five agents
    // call concurrently, and a 429-killed agent wastes the tokens it already
    // spent before its retry re-spends them. One at a time removes the burst.
    // Raise AGENT_CONCURRENCY on a higher tier to reclaim parallelism.
    this.maxConcurrentAgents = Math.max(
      1,
      this.config.get<number>('AGENT_CONCURRENCY', 1),
    );
    this.availableSlots = this.maxConcurrentAgents;
    this.logger.log(`Agent execution concurrency: ${this.maxConcurrentAgents}`);
  }

  // A job's five agents are dispatched together but arrive across five queues a
  // few ms apart. Hold the first grant this long so they all register as waiters
  // before we pick the earliest in ORDER — otherwise whichever queue delivered
  // first would win the slot. Small enough to be imperceptible.
  private static readonly SLOT_COLLECT_MS = 150;

  /**
   * Enqueue for an execution slot. Grants are made in fixed pipeline ORDER, not
   * arrival order: the first grant waits SLOT_COLLECT_MS for the whole batch to
   * register, and every grant after that (on release) picks the earliest
   * still-waiting agent in ORDER. So execution is deterministic — architecture,
   * then security, dependency, quality, docs — regardless of queue delivery.
   */
  private acquireSlot(agentType: AgentType): Promise<void> {
    return new Promise<void>((resolve) => {
      this.slotWaiters.push({ agentType, resolve });
      if (this.grantTimer === null) {
        this.grantTimer = setTimeout(() => {
          this.grantTimer = null;
          this.grantNext();
        }, AgentConsumer.SLOT_COLLECT_MS);
      }
    });
  }

  /** Hand each free slot to the waiting agent earliest in ORDER. */
  private grantNext(): void {
    while (this.availableSlots > 0 && this.slotWaiters.length > 0) {
      this.slotWaiters.sort(
        (a, b) =>
          AgentConsumer.ORDER.indexOf(a.agentType) -
          AgentConsumer.ORDER.indexOf(b.agentType),
      );
      const next = this.slotWaiters.shift()!;
      this.availableSlots--;
      next.resolve();
    }
  }

  /** Return a slot and immediately hand it to the next agent in ORDER. */
  private releaseSlot(): void {
    this.availableSlots++;
    this.grantNext();
  }

  @EventPattern(AGENT_ROUTING_KEYS.architecture)
  async onArchitecture(
    @Payload() msg: AgentJobMessage,
    @Ctx() ctx: RmqContext,
  ) {
    await this.handle(msg, ctx, async (agentCtx) => {
      const fileTree = await this.buildFileTree(msg.repoPath);
      return this.architectureAgent.run({ ...agentCtx, fileTree });
    });
  }

  @EventPattern(AGENT_ROUTING_KEYS.security)
  async onSecurity(@Payload() msg: AgentJobMessage, @Ctx() ctx: RmqContext) {
    await this.handle(msg, ctx, async (agentCtx) => {
      const note = msg.manifest.hasDockerfile
        ? 'Dockerfile present — container-security checks are in scope.'
        : 'No Dockerfile found — do not report container-security findings.';
      return this.securityAgent.run({ ...agentCtx, additionalContext: note });
    });
  }

  @EventPattern(AGENT_ROUTING_KEYS.dependency)
  async onDependency(@Payload() msg: AgentJobMessage, @Ctx() ctx: RmqContext) {
    await this.handle(msg, ctx, async (agentCtx) => {
      // Dependency agent needs the raw manifest — read directly, tiny file, zero graph cost.
      const manifest = await this.readManifest(msg.repoPath);
      return this.dependencyAgent.run({
        ...agentCtx,
        additionalContext: manifest,
      });
    });
  }

  @EventPattern(AGENT_ROUTING_KEYS.quality)
  async onQuality(@Payload() msg: AgentJobMessage, @Ctx() ctx: RmqContext) {
    await this.handle(msg, ctx, async (agentCtx) =>
      this.qualityAgent.run(agentCtx),
    );
  }

  @EventPattern(AGENT_ROUTING_KEYS.docs)
  async onDocs(@Payload() msg: AgentJobMessage, @Ctx() ctx: RmqContext) {
    await this.handle(msg, ctx, async (agentCtx) => {
      // Docs agent needs the README — read directly, tiny file, zero graph cost.
      const readme = await this.readReadme(msg.repoPath);
      return this.docsAgent.run({ ...agentCtx, additionalContext: readme });
    });
  }

  // ─── Core dispatch logic ────────────────────────────────────────────────────

  private async handle(
    msg: AgentJobMessage,
    ctx: RmqContext,
    run: (agentCtx: AgentContext) => Promise<AgentResult>,
  ) {
    const channel = ctx.getChannelRef() as AckableChannel;
    const originalMsg = ctx.getMessage();
    const { jobId, repoPath, agentType } = msg;

    // Wait for a free execution slot so agents run one-by-one (see constructor)
    // instead of all bursting Mistral's rate limit at once. The message sits
    // unacked in the queue meanwhile — which is the point: it isn't started
    // until there's capacity.
    this.logger.log(`[${agentType}] queued job=${jobId}`);
    await this.acquireSlot(agentType);
    this.logger.log(`[${agentType}] starting job=${jobId}`);

    try {
      // Step -1: fencing. A force-stop bumps job:{id}:epoch; any message from
      // the superseded run carries the old epoch and is dropped here — before
      // it can write a stale AgentResult or SADD into agents_done and trip
      // completion for a run the user already abandoned. Ack (not nack) so it
      // leaves the queue for good rather than dead-lettering.
      const currentEpoch = Number(
        (await this.redis.get(jobEpochKey(jobId))) ?? 0,
      );
      if ((msg.epoch ?? 0) !== currentEpoch) {
        this.logger.warn(
          `[${agentType}] dropping stale message (msg epoch ${msg.epoch ?? 0} != current ${currentEpoch}) [job=${jobId}]`,
        );
        channel.ack(originalMsg);
        return;
      }

      // Step 0: cost cap. This job-wide check is a *secondary* gate and always
      // has been a weak one: all five agents dispatch at once and all five read
      // ~0 here at t=0, so it has never actually fenced a concurrent agent —
      // only a retry or a late redelivery. The cap that really bounds spend is
      // the per-agent one enforced inside the loop, which needs no Redis and so
      // has no race.
      const budget = this.config.get<number>('JOB_TOKEN_BUDGET', 500_000);
      const agentBudget = this.config.get<number>(
        'AGENT_TOKEN_BUDGET',
        120_000,
      );
      const spent = Number(
        (await this.redis.get(jobTokensUsedKey(jobId))) ?? 0,
      );

      let result: AgentResult;
      if (spent >= budget) {
        this.logger.warn(
          `[${agentType}] skipped — job token budget exceeded (${spent}/${budget}) [job=${jobId}]`,
        );
        result = {
          agentType,
          jobId,
          output: {},
          tokensUsed: noTokens(),
          success: false,
          error: `Job token budget exceeded (${spent}/${budget})`,
          durationMs: 0,
        };
      } else {
        // Step 1: re-open the already-built graph read-only (built by the orchestrator,
        // in a different process — WAL mode means readers never block on that writer).
        const cg = await this.codeGraphService.openReadOnly(repoPath, jobId);

        // Step 2: agent-specific semantic query -> only relevant nodes returned.
        // Cache scope is the runKey, not the jobId: the context is derived from
        // this checkout's graph and the entry outlives the run (24h TTL).
        const graphContext = await this.codeGraphService.buildContext(
          cg,
          this.queryFor(agentType),
          runKeyOf(jobId, msg.epoch),
          agentType,
          20, // max nodes = hard cap on context size
        );

        // Step 3: load the orchestrator's zero-LLM ground truth and run the
        // agent. Facts are best-effort — a missing key means a degraded prompt,
        // not a failed job, and the agent still has the graph context.
        const facts = await this.loadFacts(runKeyOf(jobId, msg.epoch));
        result = await run({
          jobId,
          repoPath,
          graphContext,
          facts,
          tools: { cg, repoPath },
          agentTokenBudget: agentBudget,
          checkAlive: () => this.assertNotFenced(jobId, msg.epoch),
          onActivity: ({ turn, maxTurns, activity }) => {
            // Fire-and-forget. `job:progress` only fires when an agent
            // *finishes*; with a minute-scale loop that left the UI showing
            // five running agents and no movement, which reads as hung. This is
            // the missing heartbeat. Dropping one costs the UI ~3s (it polls
            // underneath) — blocking the loop on it would cost far more.
            const event: JobEventPayload = {
              type: 'job:agent_activity',
              jobId,
              agentType,
              turn,
              maxTurns,
              activity,
            };
            void this.redis
              .publish(jobEventsChannel(jobId), JSON.stringify(event))
              .catch(() => undefined);
          },
        });

        if (result.success) {
          await this.redis.incrby(
            jobTokensUsedKey(jobId),
            totalTokens(result.tokensUsed),
          );
        }
      }

      // Step 4: persist result to Postgres. Malformed/failed output never crashes
      // the job — it's recorded as a failed agent and the synthesizer proceeds
      // with whatever succeeded.
      await this.prisma.agentResult.create({
        data: {
          jobId,
          agentType,
          rawOutput: result.output,
          tokensUsed: result.tokensUsed as unknown as Prisma.InputJsonValue,
          status: result.success ? 'success' : 'failed',
          durationMs: result.durationMs,
          error: result.error ?? null,
        },
      });

      // Step 5: track completion in Redis against what the orchestrator actually
      // dispatched (agents_expected), not the message's own totalAgents field.
      await this.redis.sadd(jobAgentsDoneKey(jobId), agentType);
      const [doneCount, expectedCount] = await Promise.all([
        this.redis.scard(jobAgentsDoneKey(jobId)),
        this.redis.scard(jobAgentsExpectedKey(jobId)),
      ]);

      this.logger.log(
        `[${agentType}] saved. Progress: ${doneCount}/${expectedCount} [job=${jobId}]`,
      );

      const progressEvent: JobEventPayload = {
        type: 'job:progress',
        jobId,
        agentType,
        done: doneCount,
        total: expectedCount,
      };
      await this.redis.publish(
        jobEventsChannel(jobId),
        JSON.stringify(progressEvent),
      );

      if (doneCount >= expectedCount) {
        // Close the write handle by path (not jobId — the same key openReadOnly
        // used, so a superseded run can never close the live run's handle). The
        // checkout + its CodeGraph SQLite are deliberately RETAINED on disk so
        // the repo chat can re-open the graph read-only and reason over the real
        // code after the job finishes. The orchestrator bounds /tmp/repos by
        // pruning the oldest checkouts on each new extraction, so retention
        // doesn't leak unboundedly.
        this.codeGraphService.close(repoPath);
        await this.redis.publish(jobReadyForSynthesisChannel(jobId), jobId);
        this.logger.log(`All agents done, synthesis triggered [job=${jobId}]`);
      }

      channel.ack(originalMsg);
    } catch (err: unknown) {
      // A fence trip mid-loop is not a failure of this agent — it's a run the
      // user abandoned. Write nothing, do NOT SADD into agents_done (that would
      // advance completion for the *live* run and could fire synthesis early),
      // and ack so the message leaves the queue for good. Same semantics as the
      // pre-flight fence above; the only difference is how far in we got.
      if (err instanceof EpochFencedError) {
        this.logger.warn(`[${agentType}] aborted mid-run — ${err.message}`);
        channel.ack(originalMsg);
        return;
      }

      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[${agentType}] fatal error job=${jobId}: ${message}`);
      // An infra failure here (graph open, buildContext, Postgres write) means
      // this agent never reached Step 4/5 — without recording *something*,
      // agents_done never reaches agents_expected and the job hangs forever.
      // Record it as failed and still advance completion tracking so the
      // synthesizer proceeds with whatever other agents succeeded.
      await this.failureRecorder
        .recordInfraFailure(jobId, repoPath, agentType, message)
        .catch((e: unknown) => {
          this.logger.error(
            `[${agentType}] failed to record infra failure: ${String(e)}`,
          );
        });
      channel.nack(originalMsg, false, false);
    } finally {
      // Release the slot however the handler exited (ack, nack, fence, throw)
      // so the next queued agent can start.
      this.releaseSlot();
    }
  }

  /**
   * The per-turn fence. One Redis GET against a local Redis is ~0.2ms, against
   * a multi-second LLM call — free, next to the cost of not checking.
   */
  private async assertNotFenced(
    jobId: string,
    msgEpoch: number | undefined,
  ): Promise<void> {
    const current = Number((await this.redis.get(jobEpochKey(jobId))) ?? 0);
    if ((msgEpoch ?? 0) !== current) {
      throw new EpochFencedError(jobId, msgEpoch ?? 0, current);
    }
  }

  /**
   * Read the run's AST ground truth, written by the orchestrator after
   * indexing. Deliberately non-fatal: if it's missing or unparseable the agent
   * runs without it and produces a weaker analysis, which beats failing a job
   * over a cache read.
   */
  private async loadFacts(runKey: string): Promise<RepoFacts | undefined> {
    try {
      const raw = await this.redis.get(jobRepoFactsKey(runKey));
      if (!raw) {
        this.logger.warn(`No repo_facts for run=${runKey} — degraded prompt`);
        return undefined;
      }
      return JSON.parse(raw) as RepoFacts;
    } catch (e: unknown) {
      this.logger.warn(
        `Failed to read repo_facts for run=${runKey}: ${String(e)}`,
      );
      return undefined;
    }
  }

  // ─── Agent-specific graph queries (Section 8) ──────────────────────────────

  private queryFor(agentType: AgentType): string {
    const queries: Record<AgentType, string> = {
      architecture:
        'entry point main module bootstrap controller service provider dependency injection',
      security:
        'authentication authorization guard jwt token password hash input validation user request',
      dependency: 'import require external library package third party module',
      quality:
        'error handling exception try catch async await promise rejection type any unknown',
      docs: 'export public interface type definition API contract decorator description',
    };
    return queries[agentType];
  }

  // ─── File helpers (zero LLM cost) ───────────────────────────────────────────

  private async readManifest(repoPath: string): Promise<string> {
    const candidates = [
      'package.json',
      'requirements.txt',
      'go.mod',
      'Cargo.toml',
      'pom.xml',
    ];
    for (const f of candidates) {
      try {
        return await fs.readFile(path.join(repoPath, f), 'utf-8');
      } catch {
        // try next candidate
      }
    }
    return 'No manifest file found';
  }

  private async readReadme(repoPath: string): Promise<string> {
    const candidates = ['README.md', 'README.txt', 'README', 'readme.md'];
    for (const f of candidates) {
      try {
        const content = await fs.readFile(path.join(repoPath, f), 'utf-8');
        return content.slice(0, 8000); // README can be huge, cap it
      } catch {
        // try next candidate
      }
    }
    return 'No README found';
  }

  private async buildFileTree(
    repoPath: string,
    maxFiles = 200,
  ): Promise<string> {
    const lines: string[] = [];
    let count = 0;

    const walk = async (dir: string, indent = 0) => {
      if (count >= maxFiles) return;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        lines.push(`${'  '.repeat(indent)}${e.name}`);
        count++;
        if (e.isDirectory()) await walk(path.join(dir, e.name), indent + 1);
        if (count >= maxFiles) {
          lines.push('  ... (truncated)');
          return;
        }
      }
    };

    await walk(repoPath);
    return lines.join('\n');
  }
}
