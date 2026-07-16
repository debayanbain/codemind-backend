import { ConfigService } from '@nestjs/config';
import {
  withHeartbeat,
  buildAgentQueueOptions,
} from './rabbitmq-options.factory';

describe('withHeartbeat', () => {
  it('pins a heartbeat on a bare URL', () => {
    expect(withHeartbeat('amqp://user:pw@localhost:5672')).toBe(
      'amqp://user:pw@localhost:5672?heartbeat=30',
    );
  });

  it('appends to a URL that already has query params', () => {
    expect(withHeartbeat('amqp://host:5672?frameMax=131072')).toBe(
      'amqp://host:5672?frameMax=131072&heartbeat=30',
    );
  });

  it('never overrides an operator-set heartbeat', () => {
    // If someone has deliberately tuned this in RABBITMQ_URL, that decision wins.
    const url = 'amqp://host:5672?heartbeat=90';
    expect(withHeartbeat(url)).toBe(url);
  });

  it('is idempotent', () => {
    const once = withHeartbeat('amqp://host:5672');
    expect(withHeartbeat(once)).toBe(once);
  });
});

describe('buildAgentQueueOptions', () => {
  it('lets an agent consumer hold more than one message', () => {
    // prefetch 1 was justified as preventing head-of-line blocking; it IS
    // head-of-line blocking. One unacked message per consumer means job B's
    // architecture agent cannot start until job A's has acked — invisible at 5s
    // per agent, minutes of dead air once an agent is a tool loop.
    const opts = buildAgentQueueOptions('amqp://host:5672', 'architecture');
    const options = opts.options as { prefetchCount: number; urls: string[] };

    expect(options.prefetchCount).toBeGreaterThan(1);
    expect(options.urls[0]).toContain('heartbeat=');
  });

  it('keeps manual ack and per-consumer prefetch', () => {
    const opts = buildAgentQueueOptions('amqp://host:5672', 'security');
    const options = opts.options as {
      noAck: boolean;
      isGlobalPrefetchCount: boolean;
    };

    // Manual ack is what lets a crashed agent's message be redelivered rather
    // than silently lost; global prefetch would pool the budget across all five
    // agent types instead of giving each its own.
    expect(options.noAck).toBe(false);
    expect(options.isGlobalPrefetchCount).toBe(false);
  });

  it('still dead-letters and caps deliveries', () => {
    const opts = buildAgentQueueOptions('amqp://host:5672', 'docs');
    const args = (
      opts.options as {
        queueOptions: { arguments: Record<string, unknown> };
      }
    ).queueOptions.arguments;

    expect(args['x-queue-type']).toBe('quorum');
    expect(args['x-delivery-limit']).toBeGreaterThan(0);
    expect(args['x-dead-letter-exchange']).toBeTruthy();
  });
});

describe('config-driven URLs', () => {
  it('adds the heartbeat to whatever RABBITMQ_URL provides', () => {
    const config = {
      get: (_k: string, d: string) => d,
    } as unknown as ConfigService;

    // buildAnalysisQueueOptions goes through the same rabbitmqUrl() helper.
    const { buildAnalysisQueueOptions } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('./rabbitmq-options.factory') as typeof import('./rabbitmq-options.factory');
    const opts = buildAnalysisQueueOptions(config);

    expect((opts.options as { urls: string[] }).urls[0]).toContain(
      'heartbeat=30',
    );
  });
});
