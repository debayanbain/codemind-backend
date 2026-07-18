import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * 409 carrying a machine-readable `code` the frontend keys off to render the
 * "Connect GitHub" prompt — a next step, not a crash. Thrown when a repo-scoped
 * action runs for a user (typically a Google sign-in) with no linked GitHub.
 */
export class GithubNotConnectedException extends HttpException {
  constructor() {
    super(
      {
        statusCode: HttpStatus.CONFLICT,
        code: 'github_not_connected',
        message: 'GitHub account is not connected.',
      },
      HttpStatus.CONFLICT,
    );
  }
}
