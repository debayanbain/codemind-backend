import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule } from '@nestjs/microservices';
import {
  buildAnalysisQueueOptions,
  CodeGraphModule,
  LlmClient,
  GithubTarballService,
} from '@app/common';

import { AuthModule } from '../auth/auth.module';
import { AnalyzeController } from './analyze.controller';
import { JobsController } from './jobs.controller';
import { ExportController } from './export.controller';
import { ShareController } from './share.controller';
import { JobsService, ANALYSIS_QUEUE_CLIENT } from './jobs.service';
import { ShareService } from './share.service';
import { ChatService } from './chat.service';
import { JobRateLimitGuard } from './job-rate-limit.guard';

@Module({
  imports: [
    ConfigModule,
    AuthModule,
    // Lets the chat re-open the job's on-disk CodeGraph read-only — and, when
    // it's missing, rebuild it on demand via GithubTarballService +
    // CodeGraphService.initAndIndex (see ChatService.ensureGraph).
    CodeGraphModule,
    ClientsModule.registerAsync([
      {
        name: ANALYSIS_QUEUE_CLIENT,
        inject: [ConfigService],
        useFactory: buildAnalysisQueueOptions,
      },
    ]),
  ],
  controllers: [
    AnalyzeController,
    JobsController,
    ExportController,
    ShareController,
  ],
  providers: [
    JobsService,
    ShareService,
    ChatService,
    LlmClient,
    GithubTarballService,
    JobRateLimitGuard,
  ],
})
export class JobsModule {}
