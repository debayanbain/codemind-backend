import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Profile } from 'passport-github2';
import { PrismaService, TokenEncryptionService, User } from '@app/common';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenEncryption: TokenEncryptionService,
    private readonly jwtService: JwtService,
  ) {}

  async validateOAuthLogin(
    profile: Profile,
    accessToken: string,
  ): Promise<User> {
    const githubId = profile.id;
    const encrypted = this.tokenEncryption.encrypt(accessToken);
    const githubUsername = profile.username ?? null;
    const avatarUrl = profile.photos?.[0]?.value ?? null;

    const user = await this.prisma.user.upsert({
      where: { githubId },
      create: {
        githubId,
        githubAccessTokenEncrypted: encrypted,
        githubUsername,
        avatarUrl,
      },
      update: {
        githubAccessTokenEncrypted: encrypted,
        ...(githubUsername ? { githubUsername } : {}),
        ...(avatarUrl ? { avatarUrl } : {}),
      },
    });

    this.logger.log(`OAuth login: ${profile.username} [user=${user.id}]`);
    return user;
  }

  /** Short-lived token used on every API request. */
  issueAccessToken(user: User): string {
    return this.jwtService.sign(
      { sub: user.id, type: 'access' },
      { expiresIn: ACCESS_TOKEN_TTL },
    );
  }

  /**
   * Long-lived token the browser exchanges for a fresh access token once the
   * access token expires. Stateless (a signed JWT with a `refresh` type claim)
   * so it needs no DB storage; rotated on every use.
   */
  issueRefreshToken(user: User): string {
    return this.jwtService.sign(
      { sub: user.id, type: 'refresh' },
      { expiresIn: REFRESH_TOKEN_TTL },
    );
  }

  /** Verifies a refresh token and returns the user, or null if invalid. */
  async userFromRefreshToken(token: string): Promise<User | null> {
    try {
      const payload = this.jwtService.verify<{ sub: string; type?: string }>(
        token,
      );
      if (payload.type !== 'refresh') return null;
      return await this.prisma.user.findUnique({ where: { id: payload.sub } });
    } catch {
      return null;
    }
  }

  decryptAccessToken(user: User): string {
    return this.tokenEncryption.decrypt(user.githubAccessTokenEncrypted);
  }
}

export const ACCESS_TOKEN_TTL = '15m';
export const REFRESH_TOKEN_TTL = '30d';
export const ACCESS_COOKIE_MAX_AGE = 15 * 60 * 1000;
export const REFRESH_COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
