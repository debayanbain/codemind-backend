import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import * as amqplib from 'amqplib';
import {
  AGENT_DLQS,
  AgentType,
  DELIVERY_LIMIT,
  jobEpochKey,
  withHeartbeat,
} from '@app/common';
import { AgentJobMessage } from './agent.consumer';
import { AgentFailureRecorderService } from './agent-failure-recorder.service';

type AmqpConnection = Awaited<ReturnType<typeof amqplib.connect>>;
type AmqpChannel = Awaited<ReturnType<AmqpConnection['createChannel']>>;

/**
 * Consumes the 5 agent DLQs directly via amqplib rather than a Nest
 * microservice `@EventPattern` — a dead-lettered message keeps its original
 * embedded `pattern` field (e.g. "agent.architecture"), so routing it
 * through Nest's pattern dispatch would re-match AgentConsumer's own
 * handler for that same pattern instead of a dedicated failure path.
 * Plain amqplib sidesteps that collision entirely.
 */
@Injectable()
export class AgentDlqConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentDlqConsumer.name);
  private connection: AmqpConnection | undefined;
  private channel: AmqpChannel | undefined;

  constructor(
    private readonly config: ConfigService,
    private readonly failureRecorder: AgentFailureRecorderService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async onModuleInit(): Promise<void> {
    const url = this.config.get<string>(
      'RABBITMQ_URL',
      'amqp://codemind:codemind@localhost:5672',
    );
    // withHeartbeat, not the bare URL: this connection bypasses the Nest
    // transport factory, so it would otherwise silently keep the server's 60s
    // default while every other connection in the process uses 30s.
    this.connection = await amqplib.connect(withHeartbeat(url));
    this.channel = await this.connection.createChannel();
    await this.channel.prefetch(1);

    for (const agentType of Object.keys(AGENT_DLQS) as AgentType[]) {
      const queue = AGENT_DLQS[agentType];
      await this.channel.consume(queue, (msg) => {
        if (!msg) return;
        void this.handle(agentType, msg);
      });
      this.logger.log(`Consuming DLQ "${queue}"`);
    }
  }

  private async handle(
    agentType: AgentType,
    msg: amqplib.ConsumeMessage,
  ): Promise<void> {
    try {
      const envelope = JSON.parse(msg.content.toString()) as {
        data: AgentJobMessage;
      };
      const { jobId, repoPath } = envelope.data;

      // Same fence as AgentConsumer.handle, for the same reason. A message that
      // burned its 3 deliveries during run 0 can land here *after* a force-retry
      // started run 1. `recordInfraFailure` SADDs into `job:{id}:agents_done`,
      // which is scoped by jobId and shared across runs — so a stale DLQ message
      // would advance the *live* run's completion count and could trip synthesis
      // before run 1's agents have finished. It also rm -rf's the repoPath it was
      // handed. Drop it: the run it belonged to is gone and nothing is waiting.
      const currentEpoch = Number(
        (await this.redis.get(jobEpochKey(jobId))) ?? 0,
      );
      if ((envelope.data.epoch ?? 0) !== currentEpoch) {
        this.logger.warn(
          `[${agentType}] dropping dead-lettered message from superseded run ` +
            `(msg epoch ${envelope.data.epoch ?? 0} != current ${currentEpoch}) [job=${jobId}]`,
        );
        return;
      }

      this.logger.warn(
        `[${agentType}] exhausted delivery-limit (${DELIVERY_LIMIT}) [job=${jobId}] — recording permanent failure`,
      );

      await this.failureRecorder.recordInfraFailure(
        jobId,
        repoPath,
        agentType,
        `Worker crashed/failed ${DELIVERY_LIMIT}x processing this agent — exhausted delivery-limit`,
      );
    } catch (err: unknown) {
      this.logger.error(
        `Failed to process DLQ message for [${agentType}]: ${String(err)}`,
      );
    } finally {
      this.channel?.ack(msg);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.channel?.close();
    await this.connection?.close();
  }
}
