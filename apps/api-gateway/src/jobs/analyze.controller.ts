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
import { GithubNotConnectedException } from '../auth/github-not-connected.exception';
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
    // Best-effort token: if the user has linked GitHub, pull + persist a fresh
    // token so the orchestrator can download private repos (and dodge the anon
    // rate limit). A user with no GitHub can still analyze a PUBLIC repo pasted
    // by URL — the orchestrator downloads it unauthenticated — so a missing link
    // is not an error here, only for private repos (which then 404 downstream).
    try {
      await this.authService.ensureGithubToken(userId);
    } catch (e: unknown) {
      if (!(e instanceof GithubNotConnectedException)) throw e;
    }

    const job = await this.jobsService.createAnalysisJob(userId, repoFullName);
    return { jobId: job.id, status: job.status };
  }
}
