import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RedisModule } from '@nestjs-modules/ioredis';
import { PrismaModule, buildRedisOptions, CodeGraphModule } from '@app/common';

import { AgentsModule } from './agents/agents.module';
import { AgentConsumer } from './jobs/agent.consumer';
import { AgentDlqConsumer } from './jobs/agent-dlq.consumer';
import { AgentFailureRecorderService } from './jobs/agent-failure-recorder.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    RedisModule.forRootAsync({
      inject: [ConfigService],
      useFactory: buildRedisOptions,
    }),
    CodeGraphModule,
    AgentsModule,
  ],
  controllers: [AgentConsumer],
  providers: [AgentFailureRecorderService, AgentDlqConsumer],
})
export class AgentWorkerModule {}
