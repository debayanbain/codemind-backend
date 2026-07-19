import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Transport, RmqOptions } from '@nestjs/microservices';
import {
  ANALYSIS_REQUESTED_QUEUE,
  analysisQueueOptions,
  createWinstonLogger,
  retryWithBackoff,
  setupDeadLetterTopology,
} from '@app/common';
import { OrchestratorModule } from './orchestrator.module';

function rabbitmqUrl(): string {
  return process.env.RABBITMQ_URL ?? 'amqp://codemind:codemind@localhost:5672';
}

// Built from raw process.env (not ConfigService) because the microservice
// transport options must exist before Nest's DI container — and therefore
// ConfigModule — has been instantiated.
function buildOptions(): RmqOptions {
  return {
    transport: Transport.RMQ,
    options: {
      urls: [rabbitmqUrl()],
      queue: ANALYSIS_REQUESTED_QUEUE,
      queueOptions: analysisQueueOptions(),
      noAck: false,
      persistent: true,
    },
  };
}

async function bootstrap() {
  // Dead-letter exchange + DLQs must exist before analysisQueueOptions()'s
  // x-dead-letter-exchange arg is asserted below, or dead-lettered messages
  // vanish silently instead of landing in the DLQ. AnalysisDlqConsumer (a
  // plain provider in OrchestratorModule, not a Nest microservice handler —
  // see its file for why) starts consuming the DLQ once the module's
  // providers are instantiated by createMicroservice() below.
  await retryWithBackoff(() => setupDeadLetterTopology(rabbitmqUrl()), {
    label: 'RabbitMQ dead-letter topology',
  });

  const app = await NestFactory.createMicroservice(OrchestratorModule, {
    ...buildOptions(),
    logger: createWinstonLogger('orchestrator'),
  });
  await app.listen();

  new Logger('Bootstrap').log(
    `listening on queue "${ANALYSIS_REQUESTED_QUEUE}"`,
  );
}
bootstrap().catch((err: unknown) => {
  new Logger('Bootstrap').error(
    'failed to start',
    err instanceof Error ? err.stack : undefined,
  );
  process.exit(1);
});
