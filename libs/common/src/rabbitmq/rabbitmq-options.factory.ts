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

/**
 * How often the broker and client exchange heartbeats, in seconds.
 *
 * This became load-bearing when agents became loops. amqplib sends heartbeats on
 * the same event loop as everything else, and every CodeGraph read is
 * *synchronous* (`node:sqlite`) — only `getCode` and file reads actually await.
 * A long enough uninterrupted run of sync graph calls misses two heartbeats, the
 * broker drops the connection, and the in-flight message is redelivered: the
 * agent re-runs from scratch, three times, then dead-letters. You pay 3x the
 * tokens and still get a failed agent.
 *
 * 30s (vs the server default of 60) fails faster and more predictably, and the
 * tool loop yields via setImmediate between tool executions so the beats land.
 * Pinning it on the URL means every connection in every service agrees.
 *
 * **Env-tunable, and here is why it must be.** The agent loop yields, so 30s is
 * right for it. But `CodeGraph.indexAll()` in the orchestrator is a single
 * ~6-minute *synchronous* block on a large repo (5000+ files) — library code we
 * cannot sprinkle `breathe()` into. It sails past any 30s heartbeat, the broker
 * drops the connection mid-index, dispatch never fires, and the job hangs at
 * "running" until it dead-letters. Raising this (and the matching server value —
 * AMQP negotiates the LOWER of the two, so the client alone is not enough) lets
 * a long index finish. The cost is slower liveness detection, which in a
 * background indexer is an acceptable trade for actually completing.
 */
const DEFAULT_HEARTBEAT_SECONDS = 30;

/** Read the heartbeat once, from env, so every service in the process agrees. */
function heartbeatSeconds(): number {
  const raw = Number(process.env.RABBITMQ_HEARTBEAT_SECONDS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_HEARTBEAT_SECONDS;
}

function rabbitmqUrl(config: ConfigService): string {
  const base = config.get<string>(
    'RABBITMQ_URL',
    'amqp://codemind:codemind@localhost:5672',
  );
  return withHeartbeat(base);
}

/** Add `heartbeat` to an AMQP URL unless it already specifies one. */
export function withHeartbeat(url: string): string {
  if (/[?&]heartbeat=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}heartbeat=${heartbeatSeconds()}`;
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
 * How many messages one agent consumer may hold unacked at a time.
 *
 * This was 1, justified as "keeps head-of-line blocking off the table". It does
 * the opposite: one unacked message per consumer is *precisely* head-of-line
 * blocking. Job B's architecture agent cannot start until job A's has acked.
 *
 * At ~5s per agent that was invisible. Now that an agent is a tool loop running
 * for a minute or more, two concurrent jobs meant the second user waited minutes
 * before their first agent moved, with no progress event to explain the silence.
 *
 * 3 is safe because the loop is I/O-bound on the LLM — it spends its life
 * awaiting HTTP, not burning CPU — so overlapping three costs almost nothing and
 * they interleave on the event loop. It is deliberately not higher: each
 * in-flight agent holds an open graph handle and a growing conversation in
 * memory, and unacked messages are redelivered on a crash, so a big prefetch
 * means a big re-run.
 */
const AGENT_PREFETCH = 3;

/**
 * One of these per agent type — agent-worker calls `app.connectMicroservice()`
 * once per entry in AGENT_QUEUES so each gets its own channel and its own
 * prefetch, matching Section 11's "one queue per agent type" (a shared queue
 * would serialize all 5 agent types behind one prefetch slot). Since
 * `routingKey` is set (not `wildcards`), ServerRMQ binds exactly one queue to
 * exactly one routing key on the same `agents.topic` exchange the publisher
 * asserts.
 */
export function buildAgentQueueOptions(
  url: string,
  agentType: keyof typeof AGENT_ROUTING_KEYS,
): RmqOptions {
  return {
    transport: Transport.RMQ,
    options: {
      urls: [withHeartbeat(url)],
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
      prefetchCount: AGENT_PREFETCH,
      isGlobalPrefetchCount: false,
      noAck: false,
    },
  };
}
