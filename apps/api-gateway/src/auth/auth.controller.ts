import {
  Controller,
  Get,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Request, Response } from 'express';
import { User } from '@app/common';
import {
  ACCESS_COOKIE_MAX_AGE,
  AuthService,
  REFRESH_COOKIE_MAX_AGE,
} from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

const ACCESS_COOKIE = 'access_token';
const REFRESH_COOKIE = 'refresh_token';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Get('github')
  @UseGuards(AuthGuard('github'))
  githubLogin() {
    // Passport redirects to GitHub; body never executes.
  }

  @Get('github/callback')
  @UseGuards(AuthGuard('github'))
  githubCallback(@Req() req: Request, @Res() res: Response) {
    const user = req.user as User;
    this.setAuthCookies(res, user);
    res.redirect(this.config.get<string>('FRONTEND_URL', 'http://localhost:3001'));
  }

  /**
   * Exchanges the long-lived refresh cookie for a fresh access token so the
   * session survives past the 15m access-token expiry. Rotates the refresh
   * token on every call. The frontend hits this automatically on a 401.
   */
  @Post('refresh')
  async refresh(@Req() req: Request, @Res() res: Response) {
    const cookies = req.cookies as Record<string, string> | undefined;
    const token = cookies?.[REFRESH_COOKIE];
    if (!token) throw new UnauthorizedException('missing refresh token');

    const user = await this.authService.userFromRefreshToken(token);
    if (!user) {
      this.clearAuthCookies(res);
      throw new UnauthorizedException('invalid refresh token');
    }

    this.setAuthCookies(res, user);
    res.status(204).send();
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@Req() req: Request) {
    return req.user;
  }

  @Post('logout')
  logout(@Res() res: Response) {
    this.clearAuthCookies(res);
    res.status(204).send();
  }

  private cookieBase(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.get<string>('NODE_ENV') === 'production',
      sameSite: 'lax',
    };
  }

  private setAuthCookies(res: Response, user: User) {
    res.cookie(ACCESS_COOKIE, this.authService.issueAccessToken(user), {
      ...this.cookieBase(),
      maxAge: ACCESS_COOKIE_MAX_AGE,
    });
    res.cookie(REFRESH_COOKIE, this.authService.issueRefreshToken(user), {
      ...this.cookieBase(),
      maxAge: REFRESH_COOKIE_MAX_AGE,
      path: '/auth/refresh',
    });
  }

  private clearAuthCookies(res: Response) {
    res.clearCookie(ACCESS_COOKIE, this.cookieBase());
    res.clearCookie(REFRESH_COOKIE, { ...this.cookieBase(), path: '/auth/refresh' });
  }
}
