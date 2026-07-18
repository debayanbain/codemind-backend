import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createClerkClient,
  verifyToken,
  type ClerkClient,
  type User as ClerkUser,
} from '@clerk/backend';

// Clerk exposes the linked GitHub connection under a provider id that has
// varied across instances/versions ('oauth_github' vs 'github'). Read the token
// by trying both rather than hard-coding one and silently getting null.
const GITHUB_PROVIDERS = ['oauth_github', 'github'];

/**
 * Thin wrapper over the Clerk backend SDK. Two jobs:
 *  - verify the session JWT the frontend sends as a Bearer token, and
 *  - read the user's GitHub OAuth token / linked-account state, since Clerk —
 *    not this app — now owns the GitHub OAuth flow.
 */
@Injectable()
export class ClerkService {
  private readonly logger = new Logger(ClerkService.name);
  private readonly secretKey: string;
  private readonly client: ClerkClient;

  constructor(config: ConfigService) {
    this.secretKey = config.getOrThrow<string>('CLERK_SECRET_KEY');
    this.client = createClerkClient({ secretKey: this.secretKey });
  }

  /**
   * Verify a Clerk session JWT (the frontend's `getToken()` output) and return
   * the Clerk user id (`sub`), or null if invalid/expired. Networkless after
   * the first JWKS fetch.
   */
  async verifySessionToken(token: string): Promise<string | null> {
    try {
      const claims = await verifyToken(token, { secretKey: this.secretKey });
      return claims.sub ?? null;
    } catch (e: unknown) {
      this.logger.debug(`Token verification failed: ${String(e)}`);
      return null;
    }
  }

  getUser(clerkUserId: string): Promise<ClerkUser> {
    return this.client.users.getUser(clerkUserId);
  }

  /**
   * True only if this Clerk user has a *verified* linked GitHub account.
   *
   * `createExternalAccount` adds an `unverified` github account the instant the
   * user clicks Connect — before GitHub consent. Counting that would hide the
   * Connect card (and fail repo calls) the moment someone cancels the OAuth. So
   * gate on `verification.status === 'verified'`: a pending/cancelled link
   * doesn't count as connected.
   */
  async hasGithub(clerkUserId: string): Promise<boolean> {
    const user = await this.client.users.getUser(clerkUserId);
    return (user.externalAccounts ?? []).some(
      (a) =>
        a.provider.toLowerCase().includes('github') &&
        a.verification?.status === 'verified',
    );
  }

  /**
   * The user's live GitHub OAuth token from Clerk, or null if GitHub isn't
   * linked. Tried at request time (not cached at connect) so a rotated/re-authed
   * token is always current.
   */
  async getGithubToken(clerkUserId: string): Promise<string | null> {
    for (const provider of GITHUB_PROVIDERS) {
      try {
        const res = (await this.client.users.getUserOauthAccessToken(
          clerkUserId,
          provider as 'oauth_github',
        )) as { data?: Array<{ token?: string }> };
        const token = res.data?.[0]?.token;
        if (token) return token;
      } catch {
        // Wrong provider id for this instance — fall through to the next.
      }
    }
    return null;
  }
}
