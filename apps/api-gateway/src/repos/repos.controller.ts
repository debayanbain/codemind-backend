import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ClerkAuthGuard } from '../auth/clerk-auth.guard';
import { ReposService } from './repos.service';

@Controller('repos')
@UseGuards(ClerkAuthGuard)
export class ReposController {
  constructor(private readonly reposService: ReposService) {}

  /** `?refresh=1` bypasses the Redis cache and rebuilds it from GitHub. */
  @Get()
  list(@Req() req: Request, @Query('refresh') refresh?: string) {
    const userId = (req.user as { id: string }).id;
    return this.reposService.listRepos(userId, refresh === '1');
  }
}
