import { Injectable, Logger } from '@nestjs/common';
import { PrismaService, TokenEncryptionService, User } from '@app/common';
import type { User as ClerkUser } from '@clerk/backend';
import { ClerkService } from './clerk.service';
import { GithubNotConnectedException } from './github-not-connected.exception';

// Re-pull a known user's profile from Clerk at most this often. The backstop
// for a permanently-lost `user.updated` webhook — bounds it to one Clerk call
// per user per window instead of every request.
const REFRESH_TTL_MS = 60 * 60 * 1000; // 1h

/** Prisma error codes that mean "DB was momentarily unreachable" — safe to retry. */
function isTransientDbError(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  return (
    code === 'P1001' || // can't reach database server
    code === 'P1002' || // server reached but timed out
    code === 'P1008' || // operations timed out
    code === 'P1017' //   server closed the connection
  );
}

/** The subset of profile we persist, normalized from either Clerk shape. */
interface NormalizedUser {
  clerkId: string;
  email: string | null;
  name: string | null;
  githubId: string | null;
  githubUsername: string | null;
  avatarUrl: string | null;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenEncryption: TokenEncryptionService,
    private readonly clerk: ClerkService,
  ) {}

  /**
   * Resolve the app user for a Clerk id, creating it on first sight and
   * refreshing a stale one.
   *
   * This is the *authoritative* sync path, not the webhook. The webhook is
   * eventually-consistent and can arrive after a just-signed-up user's first
   * request (or fail entirely), so the guard must be able to mint the row
   * itself rather than 404. And because a lost `user.updated` webhook would
   * otherwise leave a profile stale forever, an existing row older than
   * REFRESH_TTL_MS is re-pulled from Clerk here — bounded to one Clerk call per
   * user per window. If Clerk is unreachable during that refresh, the existing
   * row is served rather than failing the request.
   */
  async getOrCreateUser(clerkUserId: string): Promise<User> {
    const existing = await this.withDbRetry(() =>
      this.prisma.user.findUnique({ where: { clerkId: clerkUserId } }),
    );
    if (existing) {
      const fresh = Date.now() - existing.updatedAt.getTime() <= REFRESH_TTL_MS;
      if (fresh) return existing;
      // Stale → best-effort refresh. A Clerk or DB error here must never fail a
      // request for a user we already have: serve the cached row.
      try {
        const clerkUser = await this.clerk.getUser(clerkUserId);
        return await this.withDbRetry(() =>
          this.upsertUser(fromClerkUser(clerkUser)),
        );
      } catch (e: unknown) {
        this.logger.warn(
          `Profile refresh failed for clerkId=${clerkUserId}, serving cached row: ${String(e)}`,
        );
        return existing;
      }
    }
    // No row yet. The Bearer token already verified, so this is a real Clerk
    // user — mint the row even if Clerk's profile fetch fails (a minimal row,
    // backfilled later by the webhook or the TTL refresh) rather than 500 a
    // legitimate first request during a Clerk API blip.
    let normalized: NormalizedUser;
    try {
      normalized = fromClerkUser(await this.clerk.getUser(clerkUserId));
    } catch (e: unknown) {
      this.logger.warn(
        `Clerk profile fetch failed for new clerkId=${clerkUserId}; creating minimal row: ${String(e)}`,
      );
      normalized = {
        clerkId: clerkUserId,
        email: null,
        name: null,
        githubId: null,
        githubUsername: null,
        avatarUrl: null,
      };
    }
    return this.createUserSafely(normalized);
  }

  /**
   * Upsert a brand-new user, surviving a concurrent create. Two of a new user's
   * first requests can both miss the row and race to insert; upsert's ON
   * CONFLICT covers the clerkId collision, but any residual unique clash (or a
   * driver-level race) surfaces as P2002 — re-read and return the winner's row
   * instead of failing.
   */
  private async createUserSafely(n: NormalizedUser): Promise<User> {
    try {
      return await this.withDbRetry(() => this.upsertUser(n));
    } catch (e: unknown) {
      if ((e as { code?: string }).code === 'P2002') {
        const row = await this.withDbRetry(() =>
          this.prisma.user.findUnique({ where: { clerkId: n.clerkId } }),
        );
        if (row) return row;
      }
      throw e;
    }
  }

  /**
   * Retry a DB op through a transient connectivity blip (Supabase pooler drop /
   * timeout) instead of surfacing it as a 500. Only the known-transient Prisma
   * codes retry; anything else (constraint violation, bad query) throws at once.
   */
  private async withDbRetry<T>(op: () => Promise<T>): Promise<T> {
    const delaysMs = [150, 400];
    for (let attempt = 0; ; attempt++) {
      try {
        return await op();
      } catch (e: unknown) {
        if (attempt >= delaysMs.length || !isTransientDbError(e)) throw e;
        this.logger.warn(
          `Transient DB error (${(e as { code?: string }).code}), retry ${attempt + 1}/${delaysMs.length}`,
        );
        await new Promise((r) => setTimeout(r, delaysMs[attempt]));
      }
    }
  }

  /** Clerk webhook (user.created / user.updated) → keep the row fresh. */
  syncFromWebhook(data: unknown): Promise<User> {
    return this.withDbRetry(() => this.upsertUser(fromWebhookData(data)));
  }

  /** Clerk webhook (user.deleted). FK cascades drop jobs/results/reports/shares. */
  async deleteByClerkId(clerkUserId: string): Promise<void> {
    await this.withDbRetry(() =>
      this.prisma.user.deleteMany({ where: { clerkId: clerkUserId } }),
    );
    this.logger.log(`Deleted user for clerkId=${clerkUserId}`);
  }

  /**
   * Whether the user has a *verified* GitHub link. Never throws: a Clerk API
   * blip degrades to `fallback` (the caller passes the DB-known state, e.g.
   * whether a github_username is already stored) so /auth/me can't 500 here.
   */
  async isGithubConnected(
    clerkUserId: string,
    fallback = false,
  ): Promise<boolean> {
    try {
      return await this.clerk.hasGithub(clerkUserId);
    } catch (e: unknown) {
      this.logger.warn(
        `hasGithub failed for clerkId=${clerkUserId}, falling back to ${fallback}: ${String(e)}`,
      );
      return fallback;
    }
  }

  /**
   * Fetch the user's live GitHub token from Clerk, persist it encrypted, and
   * return the plaintext. Throws 409 GithubNotConnected if GitHub isn't linked.
   *
   * Called at repo-list and analyze time so the token in the DB is fresh — the
   * orchestrator downloads the tarball from a separate process with no request
   * context and reads the stored token, so it must already be there and current.
   */
  async ensureGithubToken(userId: string): Promise<string> {
    const user = await this.withDbRetry(() =>
      this.prisma.user.findUniqueOrThrow({ where: { id: userId } }),
    );
    const token = await this.clerk.getGithubToken(user.clerkId);
    if (!token) throw new GithubNotConnectedException();
    // Persist the encrypted token AND backfill the GitHub identity. We read
    // id/login straight from GitHub's /user with the token we already hold —
    // Clerk's external-account `username`/`provider_user_id` come back empty for
    // a custom-credentials GitHub connection, so it can't be the source. This
    // runs on repo-list/analyze, right after Connect, so github_id/username land
    // as soon as GitHub is linked. Sparse: never null a field GitHub didn't give.
    const identity = await this.fetchGithubIdentity(token);
    await this.withDbRetry(() =>
      this.prisma.user.update({
        where: { id: userId },
        data: {
          githubAccessTokenEncrypted: this.tokenEncryption.encrypt(token),
          ...(identity ? { githubId: identity.id } : {}),
          ...(identity ? { githubUsername: identity.login } : {}),
        },
      }),
    );
    return token;
  }

  /**
   * The GitHub user's numeric id + login, read from `/user` with their OAuth
   * token. Returns null on any failure — identity backfill is best-effort and
   * must never block the token the caller actually needs.
   */
  private async fetchGithubIdentity(
    token: string,
  ): Promise<{ id: string; login: string } | null> {
    try {
      const res = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': 'CodeMind',
          Accept: 'application/vnd.github+json',
        },
      });
      if (!res.ok) return null;
      const u = (await res.json()) as { id?: number; login?: string };
      return u.id && u.login ? { id: String(u.id), login: u.login } : null;
    } catch {
      return null;
    }
  }

  private upsertUser(n: NormalizedUser): Promise<User> {
    return this.prisma.user.upsert({
      where: { clerkId: n.clerkId },
      create: {
        clerkId: n.clerkId,
        email: n.email,
        name: n.name,
        githubId: n.githubId,
        githubUsername: n.githubUsername,
        avatarUrl: n.avatarUrl,
      },
      // Only overwrite optional fields when present, so a sparse update event
      // can't null out a githubId/username we already captured.
      update: {
        ...(n.email ? { email: n.email } : {}),
        ...(n.name ? { name: n.name } : {}),
        ...(n.githubId ? { githubId: n.githubId } : {}),
        ...(n.githubUsername ? { githubUsername: n.githubUsername } : {}),
        ...(n.avatarUrl ? { avatarUrl: n.avatarUrl } : {}),
      },
    });
  }
}

/** Clerk SDK User object (camelCase) → normalized. */
function fromClerkUser(u: ClerkUser): NormalizedUser {
  const github = (u.externalAccounts ?? []).find(
    (a) =>
      a.provider.toLowerCase().includes('github') &&
      a.verification?.status === 'verified',
  ) as { externalId?: string; username?: string | null } | undefined;
  const primary =
    u.emailAddresses?.find((e) => e.id === u.primaryEmailAddressId) ??
    u.emailAddresses?.[0];
  return {
    clerkId: u.id,
    email: primary?.emailAddress ?? null,
    name: [u.firstName, u.lastName].filter(Boolean).join(' ') || null,
    githubId: github?.externalId ?? null,
    githubUsername: github?.username ?? u.username ?? null,
    avatarUrl: u.imageUrl ?? null,
  };
}

/** Clerk webhook payload (snake_case) → normalized. */
function fromWebhookData(data: unknown): NormalizedUser {
  const d = data as {
    id: string;
    username?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    image_url?: string | null;
    primary_email_address_id?: string | null;
    email_addresses?: Array<{ id: string; email_address: string }>;
    external_accounts?: Array<{
      provider?: string;
      provider_user_id?: string;
      username?: string | null;
      verification?: { status?: string } | null;
    }>;
  };
  const github = (d.external_accounts ?? []).find(
    (a) =>
      a.provider?.toLowerCase().includes('github') &&
      a.verification?.status === 'verified',
  );
  const primary =
    d.email_addresses?.find((e) => e.id === d.primary_email_address_id) ??
    d.email_addresses?.[0];
  return {
    clerkId: d.id,
    email: primary?.email_address ?? null,
    name: [d.first_name, d.last_name].filter(Boolean).join(' ') || null,
    githubId: github?.provider_user_id ?? null,
    githubUsername: github?.username ?? d.username ?? null,
    avatarUrl: d.image_url ?? null,
  };
}
