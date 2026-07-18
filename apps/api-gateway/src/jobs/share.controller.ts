import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ClerkAuthGuard } from '../auth/clerk-auth.guard';
import { ShareService } from './share.service';

/**
 * Redeeming a share link requires *a* CodeMind session, not *the owner's*.
 * That is the whole access model: an unauthenticated visitor is bounced to
 * login with `?next=/share/<token>` and lands back here read-only.
 */
@Controller('share')
@UseGuards(ClerkAuthGuard)
export class ShareController {
  constructor(private readonly shareService: ShareService) {}

  @Get(':token')
  getSharedReport(@Param('token') token: string) {
    return this.shareService.getSharedReport(token);
  }
}
