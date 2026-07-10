import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule } from '@nestjs/microservices';
import { buildAnalysisQueueOptions } from '@app/common';

import { AnalyzeController } from './analyze.controller';
import { JobsController } from './jobs.controller';
import { ExportController } from './export.controller';
import { ShareController } from './share.controller';
import { JobsService, ANALYSIS_QUEUE_CLIENT } from './jobs.service';
import { ShareService } from './share.service';
import { JobRateLimitGuard } from './job-rate-limit.guard';

@Module({
  imports: [
    ConfigModule,
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
  providers: [JobsService, ShareService, JobRateLimitGuard],
})
export class JobsModule {}
