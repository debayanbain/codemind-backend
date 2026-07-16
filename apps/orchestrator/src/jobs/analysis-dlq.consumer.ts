import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqplib from 'amqplib';
import { ANALYSIS_DLQ, DELIVERY_LIMIT, withHeartbeat } from '@app/common';
import { AnalysisRequestedMessage } from './orchestrator.consumer';
import { JobFailureRecorderService } from './job-failure-recorder.service';

type AmqpConnection = Awaited<ReturnType<typeof amqplib.connect>>;
type AmqpChannel = Awaited<ReturnType<AmqpConnection['createChannel']>>;

/**
 * Consumes the analysis.requested DLQ directly via amqplib (not a Nest
 * `@EventPattern`) — see AgentDlqConsumer's file comment for why: a
 * dead-lettered message keeps its original embedded pattern and would
 * otherwise re-match OrchestratorConsumer's own handler.
 */
@Injectable()
export class AnalysisDlqConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AnalysisDlqConsumer.name);
  private connection: AmqpConnection | undefined;
  private channel: AmqpChannel | undefined;

  constructor(
    private readonly config: ConfigService,
    private readonly failureRecorder: JobFailureRecorderService,
  ) {}

  async onModuleInit(): Promise<void> {
    const url = this.config.get<string>(
      'RABBITMQ_URL',
      'amqp://codemind:codemind@localhost:5672',
    );
    // withHeartbeat: this bypasses the Nest transport factory and would
    // otherwise keep the server's 60s default.
    this.connection = await amqplib.connect(withHeartbeat(url));
    this.channel = await this.connection.createChannel();
    await this.channel.prefetch(1);

    await this.channel.consume(ANALYSIS_DLQ, (msg) => {
      if (!msg) return;
      void this.handle(msg);
    });
    this.logger.log(`Consuming DLQ "${ANALYSIS_DLQ}"`);
  }

  private async handle(msg: amqplib.ConsumeMessage): Promise<void> {
    try {
      const envelope = JSON.parse(msg.content.toString()) as {
        data: AnalysisRequestedMessage;
      };
      const { jobId } = envelope.data;

      this.logger.warn(
        `Job exhausted delivery-limit (${DELIVERY_LIMIT}) [job=${jobId}] — marking failed`,
      );

      await this.failureRecorder.markFailed(
        jobId,
        `Orchestrator crashed/failed ${DELIVERY_LIMIT}x processing this job — exhausted delivery-limit`,
      );
    } catch (err: unknown) {
      this.logger.error(
        `Failed to process analysis DLQ message: ${String(err)}`,
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
