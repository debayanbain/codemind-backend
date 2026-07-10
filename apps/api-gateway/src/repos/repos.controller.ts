import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ReposService } from './repos.service';

@Controller('repos')
@UseGuards(JwtAuthGuard)
export class ReposController {
  constructor(private readonly reposService: ReposService) {}

  @Get()
  list(@Req() req: Request) {
    const userId = (req.user as { id: string }).id;
    return this.reposService.listRepos(userId);
  }
}
