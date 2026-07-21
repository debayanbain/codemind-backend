import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ClerkAuthGuard } from '../auth/clerk-auth.guard';
import { JobRateLimitGuard } from './job-rate-limit.guard';
import { JobsService } from './jobs.service';
import { ShareService } from './share.service';
import { ChatService, ChatMessage } from './chat.service';

// Bound the request so a client can't push an unbounded transcript at the LLM.
const MAX_CHAT_MESSAGES = 40;

interface ChatRequestBody {
  messages?: ChatMessage[];
}

@Controller('jobs')
@UseGuards(ClerkAuthGuard)
export class JobsController {
  constructor(
    private readonly jobsService: JobsService,
    private readonly shareService: ShareService,
    private readonly chatService: ChatService,
  ) {}

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

  // Cancel a pending/running job outright — fences the run and marks it
  // `cancelled`, with no re-dispatch. Deliberately NOT behind JobRateLimitGuard:
  // it enqueues no new work, and a user must always be able to abort a run they
  // started by mistake.
  @Post(':id/cancel')
  async cancelJob(@Param('id') id: string, @Req() req: Request) {
    const userId = (req.user as { id: string }).id;
    const job = await this.jobsService.cancelJob(id, userId);
    return { jobId: job.id, status: job.status };
  }

  /**
   * Ask a grounded question about this job's repository. Answers from the code
   * graph (primary) + the persisted report (fallback). Owner-only — the
   * ChatService re-checks ownership via getJob.
   */
  @Post(':id/chat')
  async chat(
    @Param('id') id: string,
    @Body() body: ChatRequestBody,
    @Req() req: Request,
  ) {
    const userId = (req.user as { id: string }).id;
    const messages = body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new BadRequestException('messages is required.');
    }
    if (messages.length > MAX_CHAT_MESSAGES) {
      throw new BadRequestException(
        `Conversation too long (max ${MAX_CHAT_MESSAGES} messages).`,
      );
    }
    for (const m of messages) {
      if (
        (m.role !== 'user' && m.role !== 'assistant') ||
        typeof m.content !== 'string'
      ) {
        throw new BadRequestException(
          'Each message needs a role of "user" or "assistant" and string content.',
        );
      }
    }
    return this.chatService.ask(id, userId, messages);
  }

  /** The live share link for this job, or null if the owner never made one. */
  @Get(':id/share')
  async getShareLink(@Param('id') id: string, @Req() req: Request) {
    const userId = (req.user as { id: string }).id;
    return this.shareService.getLink(id, userId);
  }

  /** Idempotent — re-sharing returns the existing token instead of minting one. */
  @Post(':id/share')
  async createShareLink(@Param('id') id: string, @Req() req: Request) {
    const userId = (req.user as { id: string }).id;
    return this.shareService.createOrGetLink(id, userId);
  }

  @Delete(':id/share')
  @HttpCode(204)
  async revokeShareLink(@Param('id') id: string, @Req() req: Request) {
    const userId = (req.user as { id: string }).id;
    await this.shareService.revokeLinks(id, userId);
  }
}
