import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TokenEncryptionService } from '@app/common';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ClerkService } from './clerk.service';
import { ClerkAuthGuard } from './clerk-auth.guard';

/**
 * Clerk-based auth. Passport (GitHub strategy + JWT strategy + refresh cookies)
 * is gone; Clerk owns the OAuth flow and issues the session token, this app
 * verifies it (ClerkAuthGuard) and syncs users via webhook + lazy get-or-create.
 *
 * Exports the guard so ReposModule/JobsModule can apply it without re-declaring
 * its dependencies.
 */
@Module({
  imports: [ConfigModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    ClerkService,
    ClerkAuthGuard,
    TokenEncryptionService,
  ],
  exports: [AuthService, ClerkService, ClerkAuthGuard],
})
export class AuthModule {}
