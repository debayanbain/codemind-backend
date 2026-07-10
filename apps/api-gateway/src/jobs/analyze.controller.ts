import {
  BadRequestException,
  Controller,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { JobRateLimitGuard } from './job-rate-limit.guard';
import { JobsService } from './jobs.service';

const REPO_FULL_NAME_RE = /^[\w.-]+\/[\w.-]+$/;

@Controller()
@UseGuards(JwtAuthGuard, JobRateLimitGuard)
export class AnalyzeController {
  constructor(private readonly jobsService: JobsService) {}

  @Post('analyze/:repoId')
  async analyze(@Param('repoId') repoId: string, @Req() req: Request) {
    const repoFullName = decodeURIComponent(repoId);
    if (!REPO_FULL_NAME_RE.test(repoFullName)) {
      throw new BadRequestException(
        'repoId must be "owner/repo" (URL-encoded)',
      );
    }

    const userId = (req.user as { id: string }).id;
    const job = await this.jobsService.createAnalysisJob(userId, repoFullName);
    return { jobId: job.id, status: job.status };
  }
}
