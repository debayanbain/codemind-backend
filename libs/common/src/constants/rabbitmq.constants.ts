/**
 * RabbitMQ topology — Section 11 of CLAUDE.md. Do not rename without updating
 * every producer/consumer that binds against these strings.
 */

// Simple direct queue: api-gateway -> orchestrator. Not part of the topic exchange.
export const ANALYSIS_REQUESTED_QUEUE = 'analysis.requested';

// One topic exchange fans out to the 5 agent queues below.
export const AGENTS_TOPIC_EXCHANGE = 'agents.topic';

export const AGENT_ROUTING_KEYS = {
  architecture: 'agent.architecture',
  security: 'agent.security',
  dependency: 'agent.dependencies',
  quality: 'agent.quality',
  docs: 'agent.docs',
} as const;

export type AgentRoutingKey =
  (typeof AGENT_ROUTING_KEYS)[keyof typeof AGENT_ROUTING_KEYS];

// One queue per agent type, each bound to its routing key above, prefetch: 1.
export const AGENT_QUEUES = {
  architecture: 'agent.architecture.queue',
  security: 'agent.security.queue',
  dependency: 'agent.dependencies.queue',
  quality: 'agent.quality.queue',
  docs: 'agent.docs.queue',
} as const;

/**
 * Dead-letter topology (CLAUDE.md section 5.4's recommended enhancement).
 * Quorum queues carry a native `x-delivery-limit` — after N failed
 * deliveries (nack/requeue, or consumer-connection-drop redelivery on a
 * hard crash), RabbitMQ auto-routes the message to `dlx.exchange` instead
 * of requeuing forever. This replaces the classic-queue "TTL + x-death
 * header counting" trick with a built-in RabbitMQ 3.8+ mechanism.
 */
export const DLX_EXCHANGE = 'dlx.exchange';
export const DELIVERY_LIMIT = 3;

export const ANALYSIS_DLQ = 'analysis.requested.dlq';
export const ANALYSIS_DLQ_ROUTING_KEY = 'dead-letter.analysis';

export const AGENT_DLQS = {
  architecture: 'agent.architecture.dlq',
  security: 'agent.security.dlq',
  dependency: 'agent.dependencies.dlq',
  quality: 'agent.quality.dlq',
  docs: 'agent.docs.dlq',
} as const;

export const AGENT_DLQ_ROUTING_KEYS = {
  architecture: 'dead-letter.agent.architecture',
  security: 'dead-letter.agent.security',
  dependency: 'dead-letter.agent.dependencies',
  quality: 'dead-letter.agent.quality',
  docs: 'dead-letter.agent.docs',
} as const;

/**
 * synthesizer <-> api-gateway are decoupled processes. Rather than a second
 * RabbitMQ queue for "report.ready", we relay job lifecycle events through
 * Redis pub/sub (see redis.constants.ts) since api-gateway already needs a
 * Redis connection for job status, and pub/sub avoids a second broker hop for
 * what is purely a "wake up and push a Socket.io event" signal. Documented
 * per CLAUDE.md section 5 step 7's "your choice, document which you pick".
 */
