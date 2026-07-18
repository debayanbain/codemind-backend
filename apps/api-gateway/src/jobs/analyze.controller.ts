import {
  BadRequestException,
  Controller,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ClerkAuthGuard } from '../auth/clerk-auth.guard';
import { AuthService } from '../auth/auth.service';
import { JobRateLimitGuard } from './job-rate-limit.guard';
import { JobsService } from './jobs.service';

const REPO_FULL_NAME_RE = /^[\w.-]+\/[\w.-]+$/;

@Controller()
@UseGuards(ClerkAuthGuard, JobRateLimitGuard)
export class AnalyzeController {
  constructor(
    private readonly jobsService: JobsService,
    private readonly authService: AuthService,
  ) {}

  @Post('analyze/:repoId')
  async analyze(@Param('repoId') repoId: string, @Req() req: Request) {
    const repoFullName = decodeURIComponent(repoId);
    if (!REPO_FULL_NAME_RE.test(repoFullName)) {
      throw new BadRequestException(
        'repoId must be "owner/repo" (URL-encoded)',
      );
    }

    const userId = (req.user as { id: string }).id;
    // Pull a fresh GitHub token from Clerk and persist it before enqueueing, so
    // the orchestrator (separate process, no request context) can read it from
    // the DB to download the tarball. Throws 409 github_not_connected for a
    // user who hasn't linked GitHub — the frontend turns that into the Connect
    // GitHub prompt instead of a failed analysis.
    await this.authService.ensureGithubToken(userId);

    const job = await this.jobsService.createAnalysisJob(userId, repoFullName);
    return { jobId: job.id, status: job.status };
  }
}
