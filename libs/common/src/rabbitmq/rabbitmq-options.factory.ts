import { ConfigService } from '@nestjs/config';
import { RmqOptions, Transport } from '@nestjs/microservices';
import {
  ANALYSIS_REQUESTED_QUEUE,
  ANALYSIS_DLQ_ROUTING_KEY,
  AGENTS_TOPIC_EXCHANGE,
  AGENT_ROUTING_KEYS,
  AGENT_QUEUES,
  AGENT_DLQ_ROUTING_KEYS,
  DLX_EXCHANGE,
  DELIVERY_LIMIT,
} from '../constants/rabbitmq.constants';

function rabbitmqUrl(config: ConfigService): string {
  return config.get<string>(
    'RABBITMQ_URL',
    'amqp://codemind:codemind@localhost:5672',
  );
}

/**
 * Single source of truth for the analysis.requested queue's *declaration*
 * arguments — shared between api-gateway's producer and orchestrator's
 * consumer so they never assert the queue with mismatched arguments (RabbitMQ
 * throws 406 PRECONDITION-FAILED "inequivalent arg" if two assertQueue calls
 * for the same queue name disagree on durable/quorum/dead-letter args).
 */
export function analysisQueueOptions() {
  return {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      'x-dead-letter-exchange': DLX_EXCHANGE,
      'x-dead-letter-routing-key': ANALYSIS_DLQ_ROUTING_KEY,
      'x-delivery-limit': DELIVERY_LIMIT,
    },
  } as const;
}

/**
 * Producer-side options for api-gateway's ClientProxy (publishes only, never
 * consumes ANALYSIS_REQUESTED_QUEUE itself). Manual ack (noAck: false) is the
 * orchestrator consumer's concern — see apps/orchestrator/src/main.ts — and
 * must NOT be set here: every RMQ ClientProxy auto-consumes its own
 * amq.rabbitmq.reply-to pseudo-queue internally, and that pseudo-queue
 * requires auto-ack. Setting noAck: false on the producer applies to that
 * reply consumer too and RabbitMQ rejects it with 406 PRECONDITION-FAILED
 * ("reply consumer cannot acknowledge").
 */
export function buildAnalysisQueueOptions(config: ConfigService): RmqOptions {
  return {
    transport: Transport.RMQ,
    options: {
      urls: [rabbitmqUrl(config)],
      queue: ANALYSIS_REQUESTED_QUEUE,
      queueOptions: analysisQueueOptions(),
      persistent: true,
    },
  };
}

/**
 * Publisher for the agents.topic exchange (orchestrator -> 5 agent queues).
 * `wildcards: true` is what makes @nestjs/microservices' ClientRMQ publish via
 * `channel.publish(exchange, routingKey, ...)` instead of `sendToQueue` — i.e.
 * an actual topic-exchange fan-out rather than a direct queue send. One
 * ClientProxy instance is reused for every routing key: `client.emit(AGENT_ROUTING_KEYS.security, payload)`,
 * `client.emit(AGENT_ROUTING_KEYS.docs, payload)`, etc. — the emit() pattern
 * argument becomes both the AMQP routing key and the envelope's `packet.pattern`.
 */
export function buildAgentTopicClientOptions(
  config: ConfigService,
): RmqOptions {
  return {
    transport: Transport.RMQ,
    options: {
      urls: [rabbitmqUrl(config)],
      exchange: AGENTS_TOPIC_EXCHANGE,
      exchangeType: 'topic',
      wildcards: true,
      persistent: true,
    },
  };
}

/**
 * One of these per agent type — agent-worker calls `app.connectMicroservice()`
 * once per entry in AGENT_QUEUES so each gets its own channel and its own
 * `prefetch: 1`, matching Section 11's "one queue per agent type, prefetch: 1
 * each" (a shared queue would serialize all 5 agent types behind one prefetch
 * slot). Since `routingKey` is set (not `wildcards`), ServerRMQ binds exactly
 * one queue to exactly one routing key on the same `agents.topic` exchange the
 * publisher asserts.
 */
export function buildAgentQueueOptions(
  url: string,
  agentType: keyof typeof AGENT_ROUTING_KEYS,
): RmqOptions {
  return {
    transport: Transport.RMQ,
    options: {
      urls: [url],
      queue: AGENT_QUEUES[agentType],
      queueOptions: {
        durable: true,
        arguments: {
          'x-queue-type': 'quorum',
          'x-dead-letter-exchange': DLX_EXCHANGE,
          'x-dead-letter-routing-key': AGENT_DLQ_ROUTING_KEYS[agentType],
          'x-delivery-limit': DELIVERY_LIMIT,
        },
      },
      exchange: AGENTS_TOPIC_EXCHANGE,
      exchangeType: 'topic',
      routingKey: AGENT_ROUTING_KEYS[agentType],
      prefetchCount: 1,
      isGlobalPrefetchCount: false,
      noAck: false,
    },
  };
}
