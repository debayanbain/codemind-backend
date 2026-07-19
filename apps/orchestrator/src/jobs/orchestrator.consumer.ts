import { Controller, Logger } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import {
  ANALYSIS_REQUESTED_QUEUE,
  PrismaService,
  JobEventPayload,
  CodeGraphService,
  TokenEncryptionService,
  AgentType,
  jobStatusKey,
  jobGraphPathKey,
  jobAgentsExpectedKey,
  jobEpochKey,
  jobEventsChannel,
  jobRepoFactsKey,
} from '@app/common';

import { GithubTarballService } from '../github/github-tarball.service';
import { RepoManifestService } from '../manifest/repo-manifest.service';
import { AgentDispatchService } from '../dispatch/agent-dispatch.service';
import { JobFailureRecorderService } from './job-failure-recorder.service';
import { RepoFactsService } from '../facts/repo-facts.service';

export interface AnalysisRequestedMessage {
  jobId: string;
  userId: string;
  repoFullName: string;
  /**
   * Set only by JobsService.retryJob()'s per-agent retry path — repo dir was
   * deleted on the previous run's completion, so a retry always re-downloads
   * + re-indexes, but re-dispatches ONLY these agent types instead of
   * re-running ones that already succeeded. `agents_expected` in Redis is
   * left untouched (it already holds the original full set); the caller is
   * responsible for SREM-ing these types out of `agents_done` first.
   */
  retryAgentTypes?: AgentType[];
  /**
   * The value of `job:{id}:epoch` when this message was published — NOT when it
   * is consumed. Force-stop-and-retry INCRs the epoch and republishes, so the
   * superseded message is still sitting in the queue. Reading the epoch at
   * consume time gave both messages the *current* value, so both resolved the
   * same runKey, extracted to the same `/tmp/repos/{runKey}` and wrote the same
   * `{runKey}.tar.gz` concurrently — corrupting each other's gzip
   * ("invalid stored block lengths") and deleting the archive out from under
   * each other on cleanup. Stamping it at publish is what lets the consumer
   * tell a superseded run from the live one, the same way agents are fenced.
   *
   * Optional: messages published before this field existed carry no epoch and
   * fall back to the consume-time read.
   */
  epoch?: number;
}

interface AckableChannel {
  ack(message: unknown): void;
  nack(message: unknown, allUpTo: boolean, requeue: boolean): void;
}

@Controller()
export class OrchestratorConsumer {
  private readonly logger = new Logger(OrchestratorConsumer.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectRedis() private readonly redis: Redis,
    private readonly tokenEncryption: TokenEncryptionService,
    private readonly tarballService: GithubTarballService,
    private readonly codeGraphService: CodeGraphService,
    private readonly manifestService: RepoManifestService,
    private readonly dispatchService: AgentDispatchService,
    private readonly failureRecorder: JobFailureRecorderService,
    private readonly repoFactsService: RepoFactsService,
  ) {}

  @EventPattern(ANALYSIS_REQUESTED_QUEUE)
  async onAnalysisRequested(
    @Payload() msg: AnalysisRequestedMessage,
    @Ctx() ctx: RmqContext,
  ) {
    const channel = ctx.getChannelRef() as AckableChannel;
    const originalMsg = ctx.getMessage();
    const { jobId, userId, repoFullName, retryAgentTypes } = msg;
    const isRetry = !!retryAgentTypes?.length;

    // Fence before any work: a force-stop bumped the epoch and republished, so
    // this message may belong to a run that has already been abandoned. Drop it
    // rather than let it race the live run over the same checkout. Ack, don't
    // nack — the message isn't failed, it's obsolete; nacking would DLQ it and
    // mark a job that is currently running as failed.
    const currentEpoch = Number(
      (await this.redis.get(jobEpochKey(jobId))) ?? 0,
    );
    if (msg.epoch !== undefined && msg.epoch !== currentEpoch) {
      this.logger.warn(
        `Dropping superseded analysis.requested [job=${jobId}] — message epoch ${msg.epoch}, current ${currentEpoch}`,
      );
      channel.ack(originalMsg);
      return;
    }

    this.logger.log(
      `Received analysis.requested for ${repoFullName} [job=${jobId}]${
        isRetry ? ` (retry: ${retryAgentTypes.join(', ')})` : ''
      }`,
    );

    try {
      await this.markRunning(jobId);

      const user = await this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
      });
      // Token is optional: a Google-only user pasting a PUBLIC repo URL has
      // none, and GitHub's tarball API serves public repos unauthenticated. When
      // a token is present we use it (private repos + higher rate limit). A
      // private repo with no token simply 404s the download and the job fails
      // with a clear reason — no crash.
      const accessToken = user.githubAccessTokenEncrypted
        ? this.tokenEncryption.decrypt(user.githubAccessTokenEncrypted)
        : null;

      // The run epoch (bumped by force-stop-and-retry) both fences stale
      // in-flight agent messages AND keys this run's repo directory, so a late
      // straggler from a superseded run can't delete the folder this run just
      // indexed. Taken from the fence check above, which prefers the epoch
      // stamped at publish time. Unset == gen 0.
      const epoch = msg.epoch ?? currentEpoch;
      const runKey = `${jobId}-${epoch}`;

      // Repo dir is always re-downloaded — the previous run's checkout +
      // CodeGraph DB were deleted by the last agent to finish (success or
      // fail), whether this is a fresh run or a retry.
      const { repoPath } = await this.tarballService.downloadAndExtract(
        repoFullName,
        accessToken,
        jobId,
        runKey,
      );

      // Pure AST parsing — zero LLM cost.
      const cg = await this.codeGraphService.initAndIndex(repoPath, jobId);

      // CodeGraph writes its SQLite DB only when there's indexable source
      // (JS/TS/Python/Go). A repo with none — a CSS/HTML-only project like a
      // pasted gradient generator — leaves no graph, so every downstream query
      // ENOENTs on the missing DB. That crash otherwise nacks the message and
      // re-downloads the repo three times into the DLQ. Detect it here and fail
      // once, clearly, with an ACK (not a nack) so it isn't redelivered.
      let nodeCount = 0;
      try {
        nodeCount = cg.getStats().nodeCount;
      } catch {
        nodeCount = 0;
      }
      if (nodeCount === 0) {
        await this.failureRecorder.markFailed(
          jobId,
          'No supported source files (JS, TS, Python, or Go) found to analyze in this repository.',
        );
        channel.ack(originalMsg);
        return;
      }

      await this.redis.set(jobGraphPathKey(jobId), repoPath);

      // Everything the AST already knows: real routes, real module edges,
      // measured complexity, framework detection, counts. Computed once here
      // while the graph is hot rather than per-agent (the cycle and dead-code
      // passes are full-graph traversals), and published for the workers to
      // read. Still zero LLM cost — this is what stops the agents guessing at
      // facts and lets them spend their tokens on judgment instead.
      const facts = await this.repoFactsService.build(cg, repoPath, runKey);
      await this.redis.set(
        jobRepoFactsKey(runKey),
        JSON.stringify(facts),
        'EX',
        86400,
      );

      const manifest = await this.manifestService.build(repoPath);

      let agentTypes: AgentType[];
      if (isRetry) {
        // agents_expected already holds the original full set from the
        // first run — only re-dispatch the ones that failed.
        agentTypes = retryAgentTypes;
      } else {
        agentTypes = this.dispatchService.selectAgents(manifest);
        await this.redis.sadd(jobAgentsExpectedKey(jobId), ...agentTypes);
      }

      this.dispatchService.dispatch(
        jobId,
        repoPath,
        agentTypes,
        manifest,
        epoch,
      );

      this.logger.log(
        `Dispatched ${agentTypes.length} agent(s) for job=${jobId}: ${agentTypes.join(', ')}`,
      );
      channel.ack(originalMsg);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.logger.error(
        `Failed to process job=${jobId}: ${error.message}`,
        error.stack,
      );
      await this.failureRecorder.markFailed(
        jobId,
        // Surface the real reason (capped in the recorder) so a failure is
        // diagnosable, instead of a blanket "Analysis failed".
        error.message,
      );
      // Don't requeue — a failed download/index won't succeed on redelivery without intervention.
      channel.nack(originalMsg, false, false);
    }
  }

  private async markRunning(jobId: string): Promise<void> {
    await this.prisma.job.update({
      where: { id: jobId },
      data: { status: 'running' },
    });
    await this.redis.set(jobStatusKey(jobId), 'running');
    await this.publishEvent({ type: 'job:status', jobId, status: 'running' });
  }

  private async publishEvent(event: JobEventPayload): Promise<void> {
    await this.redis.publish(
      jobEventsChannel(event.jobId),
      JSON.stringify(event),
    );
  }
}
