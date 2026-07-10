import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';

export const OAUTH_NEXT_COOKIE = 'oauth_next';

/** Long enough to complete an OAuth round-trip, short enough to not linger. */
const OAUTH_NEXT_MAX_AGE = 10 * 60 * 1000;

/**
 * Parks `?next=` in a short-lived cookie before Passport redirects to GitHub, so
 * the callback can land the user where they started — e.g. the share link that
 * bounced them to login. The value never leaves our origin, so it can't be
 * tampered with in transit the way an OAuth `state` round-trip can.
 *
 * Must be listed *before* `AuthGuard('github')`: that guard redirects, and a
 * guard after it never runs.
 */
@Injectable()
export class OauthNextGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    const next = sanitizeNext(req.query.next);
    if (next) res.cookie(OAUTH_NEXT_COOKIE, next, cookieOptions(req));

    return true;
  }
}

/**
 * Only same-origin, absolute *paths* survive. Rejects `//evil.com` and
 * `/\evil.com` — both of which browsers resolve as protocol-relative
 * cross-origin URLs — so this can never become an open redirect.
 */
export function sanitizeNext(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.length > 512) return null;
  if (!value.startsWith('/')) return null;
  if (value.startsWith('//') || value.startsWith('/\\')) return null;
  return value;
}

function cookieOptions(req: Request): CookieOptions {
  return {
    httpOnly: true,
    secure: req.secure,
    sameSite: 'lax',
    maxAge: OAUTH_NEXT_MAX_AGE,
  };
}
