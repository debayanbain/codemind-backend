import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { retryWithBackoff } from '../util/retry';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    // Retry so a cold start (or a transient Supabase pooler blip) doesn't crash
    // bootstrap before the database is reachable — see retryWithBackoff.
    await retryWithBackoff(() => this.$connect(), {
      label: 'Postgres connection',
      logger: this.logger,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Cheap connectivity check for GET /health. */
  async ping(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch (err: unknown) {
      this.logger.warn(`Postgres ping failed: ${String(err)}`);
      return false;
    }
  }
}
