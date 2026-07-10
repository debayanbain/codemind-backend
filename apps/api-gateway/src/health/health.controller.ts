import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '@app/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';

/**
 * Unauthenticated on purpose — this is what a container orchestrator /
 * load balancer polls to decide whether to route traffic here, not
 * something a logged-in user calls.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  @Get()
  async check(@Res() res: Response) {
    const [postgres, redis] = await Promise.all([
      this.prisma.ping(),
      this.redis
        .ping()
        .then(() => true)
        .catch(() => false),
    ]);

    const ok = postgres && redis;
    res
      .status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE)
      .json({ status: ok ? 'ok' : 'degraded', postgres, redis });
  }
}
