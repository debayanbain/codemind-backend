import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RedisModule } from '@nestjs-modules/ioredis';
import { PrismaModule, buildRedisOptions } from '@app/common';

import { AuthModule } from './auth/auth.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { ReposModule } from './repos/repos.module';
import { JobsModule } from './jobs/jobs.module';
import { EventsGatewayModule } from './gateway/gateway.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    RedisModule.forRootAsync({
      inject: [ConfigService],
      useFactory: buildRedisOptions,
    }),
    AuthModule,
    WebhooksModule,
    ReposModule,
    JobsModule,
    EventsGatewayModule,
    HealthModule,
  ],
})
export class ApiGatewayModule {}
