import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RedisModule } from '@nestjs-modules/ioredis';
import { ClientsModule } from '@nestjs/microservices';
import {
  PrismaModule,
  buildRedisOptions,
  buildAgentTopicClientOptions,
  CodeGraphModule,
  TokenEncryptionService,
} from '@app/common';

import { OrchestratorConsumer } from './jobs/orchestrator.consumer';
import { AnalysisDlqConsumer } from './jobs/analysis-dlq.consumer';
import { JobFailureRecorderService } from './jobs/job-failure-recorder.service';
import { GithubTarballService } from '@app/common';
import { RepoManifestService } from './manifest/repo-manifest.service';
import { RepoFactsService } from './facts/repo-facts.service';
import {
  AgentDispatchService,
  AGENT_TOPIC_CLIENT,
} from './dispatch/agent-dispatch.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    RedisModule.forRootAsync({
      inject: [ConfigService],
      useFactory: buildRedisOptions,
    }),
    ClientsModule.registerAsync([
      {
        name: AGENT_TOPIC_CLIENT,
        inject: [ConfigService],
        useFactory: buildAgentTopicClientOptions,
      },
    ]),
    CodeGraphModule,
  ],
  controllers: [OrchestratorConsumer],
  providers: [
    TokenEncryptionService,
    GithubTarballService,
    RepoManifestService,
    RepoFactsService,
    AgentDispatchService,
    JobFailureRecorderService,
    AnalysisDlqConsumer,
  ],
})
export class OrchestratorModule {}
