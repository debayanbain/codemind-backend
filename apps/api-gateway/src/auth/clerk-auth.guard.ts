import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ClerkService } from './clerk.service';
import { AuthService } from './auth.service';

/** What every protected controller reads off `req.user`. */
export interface AuthedUser {
  id: string;
  clerkId: string;
  email: string | null;
  name: string | null;
  githubUsername: string | null;
  avatarUrl: string | null;
}

/**
 * Verifies the Clerk session token on the request, resolves (or lazily creates)
 * the app user, and attaches it as `req.user`. Replaces the old Passport-JWT
 * guard; controllers keep reading `req.user.id` unchanged.
 */
@Injectable()
export class ClerkAuthGuard implements CanActivate {
  constructor(
    private readonly clerk: ClerkService,
    private readonly authService: AuthService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const token = extractToken(req);
    if (!token) throw new UnauthorizedException('Missing session token');

    const clerkUserId = await this.clerk.verifySessionToken(token);
    if (!clerkUserId) {
      throw new UnauthorizedException('Invalid or expired session');
    }

    const user = await this.authService.getOrCreateUser(clerkUserId);
    (req as Request & { user: AuthedUser }).user = {
      id: user.id,
      clerkId: user.clerkId,
      email: user.email,
      name: user.name,
      githubUsername: user.githubUsername,
      avatarUrl: user.avatarUrl,
    };
    return true;
  }
}

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  // Same-domain fallback: Clerk's __session cookie. cookie-parser augments
  // Request.cookies as `any`, so cast through `unknown` to a clean shape and
  // narrow explicitly rather than propagate that `any`.
  const cookies = (req as unknown as { cookies?: Record<string, unknown> })
    .cookies;
  const session = cookies?.['__session'];
  return typeof session === 'string' ? session : null;
}
