import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import type { Request } from 'express';
import { jobSubmitRateLimitKey } from '@app/common';

const WINDOW_SECONDS = 3600;

/**
 * Caps job submissions per user per hour (Section 6: "rate limit key per user").
 * Simple Redis INCR+EXPIRE window — cheap, atomic enough for this project's scale
 * without pulling in a distributed-lock library (explicitly out of scope).
 */
@Injectable()
export class JobRateLimitGuard implements CanActivate {
  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly config: ConfigService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const userId = (req.user as { id: string }).id;
    const limit = this.config.get<number>('JOB_RATE_LIMIT_PER_HOUR', 10);

    const key = jobSubmitRateLimitKey(userId);
    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, WINDOW_SECONDS);
    }

    if (count > limit) {
      throw new HttpException(
        `Job submission rate limit exceeded (${limit}/hour)`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}
