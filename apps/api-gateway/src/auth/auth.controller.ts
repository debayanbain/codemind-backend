import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { AuthedUser, ClerkAuthGuard } from './clerk-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * Session identity for the frontend. `githubConnected` gates the repo/analyze
   * flow — a Google sign-in returns false until they link GitHub, and the
   * dashboard shows the "Connect GitHub" card off this flag.
   *
   * Sign-in, sign-out and account linking all happen in the Clerk client SDK;
   * there are no OAuth-redirect or logout routes here anymore.
   */
  @Get('me')
  @UseGuards(ClerkAuthGuard)
  async me(@Req() req: Request) {
    const user = req.user as AuthedUser;
    // Pass the DB-known state as the fallback so a Clerk API blip degrades to
    // "connected if we've already stored a github_username" instead of 500ing.
    const githubConnected = await this.authService.isGithubConnected(
      user.clerkId,
      !!user.githubUsername,
    );
    return {
      id: user.id,
      githubConnected,
      email: user.email,
      name: user.name,
      githubUsername: user.githubUsername,
      avatarUrl: user.avatarUrl,
    };
  }
}
