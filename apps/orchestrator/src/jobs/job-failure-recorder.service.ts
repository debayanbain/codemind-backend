import { Injectable } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import {
  PrismaService,
  JobEventPayload,
  jobEventsChannel,
  jobStatusKey,
} from '@app/common';

/**
 * Marks a job permanently failed at the whole-pipeline level (tarball
 * download/index crash, or the analysis.requested message exhausting
 * RabbitMQ's delivery-limit). Shared by OrchestratorConsumer's in-process
 * catch and AnalysisDlqConsumer's delivery-limit-exhausted path.
 */
@Injectable()
export class JobFailureRecorderService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async markFailed(jobId: string, reason: string): Promise<void> {
    await this.prisma.job.update({
      where: { id: jobId },
      data: { status: 'failed', completedAt: new Date() },
    });
    await this.redis.set(jobStatusKey(jobId), 'failed');

    const event: JobEventPayload = { type: 'job:failed', jobId, reason };
    await this.redis.publish(jobEventsChannel(jobId), JSON.stringify(event));
  }
}
