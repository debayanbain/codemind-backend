import { ConfigService } from '@nestjs/config';
import { RedisModuleOptions } from '@nestjs-modules/ioredis';

/** Shared single-node Redis connection options for every app in the monorepo. */
export function buildRedisOptions(config: ConfigService): RedisModuleOptions {
  return {
    type: 'single',
    url: `redis://${config.get<string>('REDIS_HOST', 'localhost')}:${config.get<number>('REDIS_PORT', 6379)}`,
  };
}
