import { Logger } from '@nestjs/common';
import * as amqplib from 'amqplib';
import type { AgentType } from '@prisma/client';
import {
  AGENT_DLQ_ROUTING_KEYS,
  AGENT_DLQS,
  ANALYSIS_DLQ,
  ANALYSIS_DLQ_ROUTING_KEY,
  DLX_EXCHANGE,
} from '../constants/rabbitmq.constants';

const logger = new Logger('DeadLetterTopology');

/**
 * Asserts the dead-letter exchange + every DLQ + their bindings, so that
 * queues declared later with `x-dead-letter-exchange` / `-routing-key`
 * arguments have somewhere real to land — RabbitMQ silently drops dead
 * letters if the target exchange/queue/binding doesn't exist yet.
 *
 * Idempotent (assert* is a no-op if the topology already matches) — safe to
 * call from both orchestrator and agent-worker's bootstrap, since either
 * process might start first.
 */
export async function setupDeadLetterTopology(
  rabbitmqUrl: string,
): Promise<void> {
  const conn = await amqplib.connect(rabbitmqUrl);
  const channel = await conn.createChannel();

  await channel.assertExchange(DLX_EXCHANGE, 'direct', { durable: true });

  await channel.assertQueue(ANALYSIS_DLQ, { durable: true });
  await channel.bindQueue(ANALYSIS_DLQ, DLX_EXCHANGE, ANALYSIS_DLQ_ROUTING_KEY);

  for (const agentType of Object.keys(AGENT_DLQS) as AgentType[]) {
    await channel.assertQueue(AGENT_DLQS[agentType], { durable: true });
    await channel.bindQueue(
      AGENT_DLQS[agentType],
      DLX_EXCHANGE,
      AGENT_DLQ_ROUTING_KEYS[agentType],
    );
  }

  await channel.close();
  await conn.close();

  logger.log('Dead-letter topology asserted (exchange + 6 DLQs + bindings)');
}
