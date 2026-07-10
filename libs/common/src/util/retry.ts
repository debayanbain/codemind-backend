import { Logger } from '@nestjs/common';

export interface RetryOptions {
  /** Max attempts before giving up and rethrowing. */
  retries?: number;
  /** Delay before the first retry, in ms. */
  minDelayMs?: number;
  /** Upper bound on any single backoff delay, in ms. */
  maxDelayMs?: number;
  /** Backoff multiplier applied after each failed attempt. */
  factor?: number;
  /** Human label used in log lines (e.g. "RabbitMQ topology"). */
  label?: string;
  logger?: Logger;
}

/**
 * Runs `fn`, retrying with exponential backoff on any thrown error. Exists so a
 * cold `docker compose up` — where an app boots before RabbitMQ/Postgres accept
 * connections — retries the connect instead of crashing bootstrap. (In dev the
 * container's PID 1 is `nest --watch`, which survives a bootstrap crash, so
 * `restart: unless-stopped` never fires and the app would otherwise sit dead.)
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const {
    retries = 10,
    minDelayMs = 1000,
    maxDelayMs = 15000,
    factor = 2,
    label = 'operation',
    logger = new Logger('retryWithBackoff'),
  } = opts;

  let delay = minDelayMs;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries) {
        logger.error(`${label} failed after ${attempt} attempts, giving up`);
        throw err;
      }
      const wait = Math.min(delay, maxDelayMs);
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        `${label} attempt ${attempt}/${retries} failed (${message}); retrying in ${wait}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, wait));
      delay = Math.min(delay * factor, maxDelayMs);
    }
  }
}
