import { Injectable, Logger } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import * as fs from 'fs/promises';

import {
  PrismaService,
  AgentType,
  CodeGraphService,
  JobEventPayload,
  jobAgentsDoneKey,
  jobAgentsExpectedKey,
  jobEventsChannel,
  jobReadyForSynthesisChannel,
} from '@app/common';

/**
 * Records an agent as permanently failed (infra error caught in-process, or
 * a message that exhausted RabbitMQ's delivery-limit and was dead-lettered)
 * and advances the job's completion tracking regardless — without this,
 * `agents_done` never reaches `agents_expected` and the job hangs forever
 * (CLAUDE.md section 5.3's "avoiding pipeline deadlocks" guard). Shared by
 * AgentConsumer (in-process catch) and AgentDlqConsumer (delivery-limit
 * exhausted) so both failure paths converge on identical bookkeeping.
 */
@Injectable()
export class AgentFailureRecorderService {
  private readonly logger = new Logger(AgentFailureRecorderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly codeGraphService: CodeGraphService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async recordInfraFailure(
    jobId: string,
    repoPath: string,
    agentType: AgentType,
    message: string,
  ): Promise<void> {
    await this.prisma.agentResult.create({
      data: {
        jobId,
        agentType,
        rawOutput: {},
        tokensUsed: { input: 0, output: 0 },
        status: 'failed',
        durationMs: null,
        error: message,
      },
    });

    await this.redis.sadd(jobAgentsDoneKey(jobId), agentType);
    const [doneCount, expectedCount] = await Promise.all([
      this.redis.scard(jobAgentsDoneKey(jobId)),
      this.redis.scard(jobAgentsExpectedKey(jobId)),
    ]);

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
      this.codeGraphService.close(jobId);
      await fs
        .rm(repoPath, { recursive: true, force: true })
        .catch((e: unknown) => {
          this.logger.warn(`Failed to clean up ${repoPath}: ${String(e)}`);
        });
      await this.redis.publish(jobReadyForSynthesisChannel(jobId), jobId);
      this.logger.log(
        `All agents done (via infra-failure path), synthesis triggered [job=${jobId}]`,
      );
    }
  }
}
