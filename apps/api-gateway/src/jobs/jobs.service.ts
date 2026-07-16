import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { firstValueFrom } from 'rxjs';
import {
  PrismaService,
  Job,
  Report,
  RenderedDiagram,
  SonnetSynthesisOutput,
  AgentType,
  TokenUsage,
  noTokens,
  totalTokens,
  agentModel,
  estimateCostUsd,
  formatUsd,
  ANALYSIS_REQUESTED_QUEUE,
  jobStatusKey,
  jobAgentsDoneKey,
  jobAgentsExpectedKey,
  jobGraphPathKey,
  jobTokensUsedKey,
  jobSynthesizingLockKey,
  jobEpochKey,
} from '@app/common';

export const ANALYSIS_QUEUE_CLIENT = 'ANALYSIS_QUEUE_CLIENT';

export interface AgentResultSummary {
  agentType: AgentType;
  status: 'success' | 'failed';
  error: string | null;
  /**
   * The agent's validated JSON output. Shipped so the frontend can render the
   * report as data — severity-ranked vulnerabilities, issue categories, dep
   * risks — rather than scraping the Markdown the same JSON was rendered into.
   * Null on a failed agent run.
   */
  rawOutput: unknown;
  /**
   * All four token classes, as stored. `input` is only the **uncached**
   * remainder — with prompt caching on, most of a loop's input arrives as
   * `cacheRead`, so a client that adds `input + output` under-reports real spend
   * by a wide margin and gets more wrong the better caching works.
   *
   * `totalTokens` is served alongside precisely so no client has to know that.
   */
  tokensUsed: TokenUsage;
  /** Total tokens processed — the number to display. */
  totalTokens: number;
  durationMs: number | null;
}

export interface ReportPayload {
  markdownContent: string;
  /**
   * Pre-rendered SVG per diagram, spliced into the Markdown client-side (see
   * `inlineDiagrams`). No diagram library runs in the browser — it only ever
   * embeds strings.
   */
  diagrams: RenderedDiagram[];
  /** Null for reports written before synthesis was persisted structurally. */
  synthesis: SonnetSynthesisOutput | null;
  totalTokens: number;
  /**
   * What this job cost, computed server-side.
   *
   * Served rather than left to the client because the client had its own copy of
   * the pricing math, commented "kept identical so the dashboard and the
   * Markdown agree" — and it wasn't identical, it was wrong, and fixing the
   * renderer made the two disagree on screen. Two copies that must agree are one
   * copy that hasn't been written yet.
   */
  estimatedCostUsd: number;
  /** Pre-formatted (`$0.576`) so every surface renders it the same way. */
  estimatedCostLabel: string;
  /** The model the figure above prices. */
  model: string;
}

export interface JobWithReport extends Job {
  report: ReportPayload | null;
  agentResults: AgentResultSummary[];
}

@Injectable()
export class JobsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectRedis() private readonly redis: Redis,
    @Inject(ANALYSIS_QUEUE_CLIENT) private readonly client: ClientProxy,
  ) {}

  async createAnalysisJob(userId: string, repoFullName: string): Promise<Job> {
    const job = await this.prisma.job.create({
      data: { userId, repoFullName, status: 'pending' },
    });

    await this.redis.set(jobStatusKey(job.id), 'pending');

    // ClientProxy#emit() returns a cold Observable — it never actually
    // publishes unless subscribed, so this must be awaited, not fire-and-forget.
    await firstValueFrom(
      this.client.emit(ANALYSIS_REQUESTED_QUEUE, {
        jobId: job.id,
        userId,
        repoFullName,
        // Freshly-created job — nothing has bumped `job:{id}:epoch` yet, so
        // this run is generation 0. Stamped rather than left undefined so the
        // orchestrator can fence this message if a force-stop supersedes it
        // before it's consumed.
        epoch: 0,
      }),
    );

    return job;
  }

  async getJob(jobId: string, userId: string): Promise<JobWithReport> {
    const job = await this.prisma.job.findUnique({
      where: { id: jobId },
      include: { report: true },
    });
    // 404 (not 403) on ownership mismatch — don't leak job existence to non-owners.
    if (!job || job.userId !== userId) {
      throw new NotFoundException('Job not found');
    }

    return {
      ...job,
      report: job.report ? toReportPayload(job.report) : null,
      agentResults: await this.getLatestAgentResults(jobId),
    };
  }

  /** Ownership-checked report lookup for the export endpoint. */
  async getReportForExport(jobId: string, userId: string): Promise<Report> {
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job || job.userId !== userId) {
      throw new NotFoundException('Job not found');
    }

    const report = await this.prisma.report.findUnique({ where: { jobId } });
    if (!report) {
      throw new NotFoundException('Report not found or not yet ready');
    }
    return report;
  }

  /**
   * Re-triggers a job that didn't make it to a usable report. Two distinct
   * cases, since only one of them has enough information to retry narrowly:
   *
   * - `status === 'failed'` — the orchestrator crashed before any agent ran
   *   (bad tarball, index failure). No AgentResult rows exist, so there's
   *   nothing to retry selectively: re-run the whole pipeline.
   * - `status === 'done'` with one or more failed AgentResults — the
   *   pipeline completed, some agents just didn't. Re-dispatch only those
   *   (repo gets re-downloaded either way — see AnalysisRequestedMessage's
   *   retryAgentTypes doc comment — but 4/5 already-succeeded agents don't
   *   re-spend LLM tokens).
   */
  async retryJob(jobId: string, userId: string): Promise<Job> {
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job || job.userId !== userId) {
      throw new NotFoundException('Job not found');
    }

    if (job.status === 'pending' || job.status === 'running') {
      throw new BadRequestException('Job is already in progress');
    }

    let retryAgentTypes: AgentType[] | undefined;

    if (job.status === 'done') {
      const results = await this.getLatestAgentResults(jobId);
      retryAgentTypes = results
        .filter((r) => r.status === 'failed')
        .map((r) => r.agentType);

      if (retryAgentTypes.length === 0) {
        throw new BadRequestException(
          'Nothing to retry — all agents succeeded',
        );
      }
      // Don't let the worker's next completion-count check see these as
      // already done — they're about to be re-dispatched.
      await this.redis.srem(jobAgentsDoneKey(jobId), ...retryAgentTypes);
    }
    // job.status === 'failed': whole-job retry, no agents_done/expected
    // touch-up needed — the orchestrator repopulates agents_expected fresh
    // and no agent ever ran to populate agents_done in the first place.

    await this.prisma.job.update({
      where: { id: jobId },
      data: { status: 'pending', completedAt: null },
    });
    await this.redis.set(jobStatusKey(jobId), 'pending');

    await firstValueFrom(
      this.client.emit(ANALYSIS_REQUESTED_QUEUE, {
        jobId,
        userId,
        repoFullName: job.repoFullName,
        retryAgentTypes,
        // Retry re-runs the *current* generation — it doesn't fence anything,
        // so carry the epoch as it stands rather than bumping it.
        epoch: Number((await this.redis.get(jobEpochKey(jobId))) ?? 0),
      }),
    );

    return { ...job, status: 'pending', completedAt: null };
  }

  /**
   * Force-stop a job wedged in `pending`/`running` (worker died mid-run,
   * message lost, orchestrator crashed) and re-run it from scratch. retryJob()
   * deliberately refuses in-progress jobs; this is the escape hatch behind the
   * frontend's "Stop & retry" button.
   *
   * Bumping `job:{id}:epoch` fences the old run: any agent message still in
   * flight now carries a stale epoch and is dropped by the worker before it can
   * write a result or trip completion tracking for the abandoned run. We can't
   * hard-kill an in-flight LLM call or selectively purge one job's messages from
   * the shared agent queues, so fencing is how the old run is neutralised.
   */
  async forceStopAndRetry(jobId: string, userId: string): Promise<Job> {
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job || job.userId !== userId) {
      throw new NotFoundException('Job not found');
    }

    // Fence first, so nothing from the old run survives the state wipe below.
    // INCR returns the new generation — carry it on the message below so the
    // orchestrator can drop any still-queued message from the superseded run
    // instead of running it concurrently against the same checkout.
    const epoch = await this.redis.incr(jobEpochKey(jobId));

    // Clear per-run state; the orchestrator repopulates agents_expected +
    // graph_path on the fresh run.
    await this.redis.del(
      jobAgentsDoneKey(jobId),
      jobAgentsExpectedKey(jobId),
      jobGraphPathKey(jobId),
      jobTokensUsedKey(jobId),
      jobSynthesizingLockKey(jobId),
    );

    await this.prisma.job.update({
      where: { id: jobId },
      data: { status: 'pending', completedAt: null },
    });
    await this.redis.set(jobStatusKey(jobId), 'pending');

    // Full re-run (no retryAgentTypes) — every agent re-dispatched fresh.
    await firstValueFrom(
      this.client.emit(ANALYSIS_REQUESTED_QUEUE, {
        jobId,
        userId,
        repoFullName: job.repoFullName,
        epoch,
      }),
    );

    return { ...job, status: 'pending', completedAt: null };
  }

  async getLatestAgentResults(jobId: string): Promise<AgentResultSummary[]> {
    const rows = await this.prisma.agentResult.findMany({
      where: { jobId },
      orderBy: { createdAt: 'desc' },
      select: {
        agentType: true,
        status: true,
        error: true,
        rawOutput: true,
        tokensUsed: true,
        durationMs: true,
      },
    });

    const latestByType = new Map<AgentType, AgentResultSummary>();
    for (const row of rows) {
      if (latestByType.has(row.agentType)) continue;
      const usage = (row.tokensUsed as TokenUsage | null) ?? noTokens();
      latestByType.set(row.agentType, {
        agentType: row.agentType,
        status: row.status,
        error: row.error,
        // A failed agent's rawOutput is `{}` — surface it as absent, not as an
        // empty object the frontend would render as a section with no findings.
        rawOutput: row.status === 'success' ? row.rawOutput : null,
        tokensUsed: usage,
        totalTokens: totalTokens(usage),
        durationMs: row.durationMs,
      });
    }
    return [...latestByType.values()];
  }
}

/** Report row -> API payload. Shared by the owner and share-link read paths. */
export function toReportPayload(report: Report): ReportPayload {
  const model = agentModel();
  const usd = estimateCostUsd(report.totalTokens, model);
  return {
    markdownContent: report.markdownContent,
    diagrams: (report.diagrams ?? []) as unknown as RenderedDiagram[],
    synthesis: (report.synthesis ?? null) as SonnetSynthesisOutput | null,
    totalTokens: report.totalTokens,
    // Computed here, by the same helper the Markdown uses, so the dashboard and
    // the report can't drift apart.
    estimatedCostUsd: usd,
    estimatedCostLabel: formatUsd(usd),
    model,
  };
}
