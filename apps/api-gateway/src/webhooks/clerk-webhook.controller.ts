import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { Webhook } from 'svix';
import { AuthService } from '../auth/auth.service';

interface ClerkWebhookEvent {
  type: string;
  data: { id?: string } & Record<string, unknown>;
}

/**
 * Clerk → DB sync. Public endpoint (no ClerkAuthGuard) but every request is
 * Svix-signature-verified against CLERK_WEBHOOK_SIGNING_SECRET, so an unsigned
 * POST can't touch the users table.
 *
 * Verification needs the *raw* body (see main.ts `rawBody: true`) — Svix signs
 * the exact bytes, and re-serializing the parsed JSON would change them.
 */
@Controller('webhooks')
export class ClerkWebhookController {
  private readonly logger = new Logger(ClerkWebhookController.name);

  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Post('clerk')
  @HttpCode(200)
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('svix-id') svixId: string,
    @Headers('svix-timestamp') svixTimestamp: string,
    @Headers('svix-signature') svixSignature: string,
  ): Promise<{ received: boolean }> {
    const secret = this.config.getOrThrow<string>(
      'CLERK_WEBHOOK_SIGNING_SECRET',
    );
    const payload = req.rawBody?.toString('utf8');
    if (!payload) throw new BadRequestException('Missing raw body');

    let evt: ClerkWebhookEvent;
    try {
      evt = new Webhook(secret).verify(payload, {
        'svix-id': svixId,
        'svix-timestamp': svixTimestamp,
        'svix-signature': svixSignature,
      }) as ClerkWebhookEvent;
    } catch (e: unknown) {
      this.logger.warn(`Rejected webhook — bad signature: ${String(e)}`);
      throw new BadRequestException('Invalid signature');
    }

    switch (evt.type) {
      case 'user.created':
      case 'user.updated':
        await this.authService.syncFromWebhook(evt.data);
        this.logger.log(`Synced user from ${evt.type} [clerk=${evt.data.id}]`);
        break;
      case 'user.deleted':
        if (evt.data.id) await this.authService.deleteByClerkId(evt.data.id);
        break;
      default:
        this.logger.debug(`Ignoring webhook type ${evt.type}`);
    }
    return { received: true };
  }
}
