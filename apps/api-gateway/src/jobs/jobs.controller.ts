import {
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { JobRateLimitGuard } from './job-rate-limit.guard';
import { JobsService } from './jobs.service';

@Controller('jobs')
@UseGuards(JwtAuthGuard)
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  @Get(':id')
  async getJob(@Param('id') id: string, @Req() req: Request) {
    const userId = (req.user as { id: string }).id;
    return this.jobsService.getJob(id, userId);
  }

  @Post(':id/retry')
  @UseGuards(JobRateLimitGuard)
  async retryJob(@Param('id') id: string, @Req() req: Request) {
    const userId = (req.user as { id: string }).id;
    const job = await this.jobsService.retryJob(id, userId);
    return { jobId: job.id, status: job.status };
  }

  // Force-stop a wedged (pending/running) job and re-run it from scratch —
  // retryJob() refuses in-progress jobs, this is the "Stop & retry" escape hatch.
  @Post(':id/stop-retry')
  @UseGuards(JobRateLimitGuard)
  async stopAndRetryJob(@Param('id') id: string, @Req() req: Request) {
    const userId = (req.user as { id: string }).id;
    const job = await this.jobsService.forceStopAndRetry(id, userId);
    return { jobId: job.id, status: job.status };
  }
}
