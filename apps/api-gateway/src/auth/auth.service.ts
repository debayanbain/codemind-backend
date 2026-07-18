import { Injectable, Logger } from '@nestjs/common';
import { PrismaService, TokenEncryptionService, User } from '@app/common';
import type { User as ClerkUser } from '@clerk/backend';
import { ClerkService } from './clerk.service';
import { GithubNotConnectedException } from './github-not-connected.exception';

// Re-pull a known user's profile from Clerk at most this often. The backstop
// for a permanently-lost `user.updated` webhook — bounds it to one Clerk call
// per user per window instead of every request.
const REFRESH_TTL_MS = 60 * 60 * 1000; // 1h

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
    const existing = await this.prisma.user.findUnique({
      where: { clerkId: clerkUserId },
    });
    if (existing) {
      const fresh =
        Date.now() - existing.updatedAt.getTime() <= REFRESH_TTL_MS;
      if (fresh) return existing;
      try {
        const clerkUser = await this.clerk.getUser(clerkUserId);
        return await this.upsertUser(fromClerkUser(clerkUser));
      } catch (e: unknown) {
        this.logger.warn(
          `Profile refresh failed for clerkId=${clerkUserId}, serving cached row: ${String(e)}`,
        );
        return existing;
      }
    }
    const clerkUser = await this.clerk.getUser(clerkUserId);
    return this.upsertUser(fromClerkUser(clerkUser));
  }

  /** Clerk webhook (user.created / user.updated) → keep the row fresh. */
  syncFromWebhook(data: unknown): Promise<User> {
    return this.upsertUser(fromWebhookData(data));
  }

  /** Clerk webhook (user.deleted). FK cascades drop jobs/results/reports/shares. */
  async deleteByClerkId(clerkUserId: string): Promise<void> {
    await this.prisma.user.deleteMany({ where: { clerkId: clerkUserId } });
    this.logger.log(`Deleted user for clerkId=${clerkUserId}`);
  }

  isGithubConnected(clerkUserId: string): Promise<boolean> {
    return this.clerk.hasGithub(clerkUserId);
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
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const token = await this.clerk.getGithubToken(user.clerkId);
    if (!token) throw new GithubNotConnectedException();
    await this.prisma.user.update({
      where: { id: userId },
      data: { githubAccessTokenEncrypted: this.tokenEncryption.encrypt(token) },
    });
    return token;
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
