import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  AGENT_ROUTING_KEYS,
  buildAgentQueueOptions,
  createWinstonLogger,
  retryWithBackoff,
  setupDeadLetterTopology,
} from '@app/common';
import { AgentWorkerModule } from './agent-worker.module';

async function bootstrap() {
  const url =
    process.env.RABBITMQ_URL ?? 'amqp://codemind:codemind@localhost:5672';

  // Idempotent — safe even if orchestrator already asserted this topology.
  // Whichever process starts first must not find the DLX/DLQs missing.
  await retryWithBackoff(() => setupDeadLetterTopology(url), {
    label: 'RabbitMQ dead-letter topology',
  });

  const app = await NestFactory.create(AgentWorkerModule, {
    logger: createWinstonLogger('agent-worker'),
  });

  // One connectMicroservice() per agent type -> its own channel, its own
  // `prefetch: 1` -> a slow LLM call for one agent type never blocks another
  // agent type's queue. Still a single process (Section 4: orchestrator-worker,
  // not 5 deployable services).
  for (const agentType of Object.keys(
    AGENT_ROUTING_KEYS,
  ) as (keyof typeof AGENT_ROUTING_KEYS)[]) {
    app.connectMicroservice(buildAgentQueueOptions(url, agentType));
  }

  await app.startAllMicroservices();

  new Logger('Bootstrap').log(
    `listening on ${Object.keys(AGENT_ROUTING_KEYS).length} agent queues`,
  );
}
bootstrap().catch((err) => {
  new Logger('Bootstrap').error('failed to start', err?.stack);
  process.exit(1);
});
