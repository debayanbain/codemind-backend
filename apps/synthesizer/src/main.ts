import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createWinstonLogger } from '@app/common';
import { SynthesizerModule } from './synthesizer.module';

async function bootstrap() {
  // No HTTP server, no RabbitMQ consumer — the synthesizer is driven entirely
  // by a Redis pub/sub subscription (SynthesizerService.onModuleInit), so an
  // application context is all it needs to stay alive and keep listening.
  await NestFactory.createApplicationContext(SynthesizerModule, {
    logger: createWinstonLogger('synthesizer'),
  });

  new Logger('Bootstrap').log('ready, waiting for job:*:ready_for_synthesis');
}
bootstrap().catch((err: unknown) => {
  new Logger('Bootstrap').error(
    'failed to start',
    err instanceof Error ? err.stack : undefined,
  );
  process.exit(1);
});
