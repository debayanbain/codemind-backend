import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ClerkAuthGuard } from '../auth/clerk-auth.guard';
import { ReposService } from './repos.service';

@Controller('repos')
@UseGuards(ClerkAuthGuard)
export class ReposController {
  constructor(private readonly reposService: ReposService) {}

  @Get()
  list(@Req() req: Request) {
    const userId = (req.user as { id: string }).id;
    return this.reposService.listRepos(userId);
  }
}
