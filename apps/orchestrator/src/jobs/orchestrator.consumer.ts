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
} from '@app/common';

import {
  GithubTarballService,
  TarballDownloadError,
} from '../github/github-tarball.service';
import { RepoManifestService } from '../manifest/repo-manifest.service';
import { AgentDispatchService } from '../dispatch/agent-dispatch.service';
import { JobFailureRecorderService } from './job-failure-recorder.service';

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
      const accessToken = this.tokenEncryption.decrypt(
        user.githubAccessTokenEncrypted,
      );

      // Repo dir is always re-downloaded — the previous run's checkout +
      // CodeGraph DB were deleted by the last agent to finish (success or
      // fail), whether this is a fresh run or a retry.
      const { repoPath } = await this.tarballService.downloadAndExtract(
        repoFullName,
        accessToken,
        jobId,
      );

      // Pure AST parsing — zero LLM cost.
      await this.codeGraphService.initAndIndex(repoPath, jobId);
      await this.redis.set(jobGraphPathKey(jobId), repoPath);

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

      // Stamp every dispatched message with the job's current run epoch, so a
      // force-stop (which bumps this) fences stale in-flight messages out. Unset
      // == generation 0.
      const epoch = Number((await this.redis.get(jobEpochKey(jobId))) ?? 0);
      this.dispatchService.dispatch(jobId, repoPath, agentTypes, manifest, epoch);

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
        err instanceof TarballDownloadError ? error.message : 'Analysis failed',
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
