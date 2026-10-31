import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Req,
  Res,
  HttpCode,
} from '@nestjs/common';
import type { Request, Response, CookieOptions } from 'express';
import { AuthService } from './auth.service';
import { randomBytes } from 'crypto';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import {
  EmailDto,
  ResetPasswordDto,
  VerifyCodeDto,
} from './dto/email-flows.dto';
import { RateLimitTier } from '../../common/rate-limit/rate-limit.decorator';
import { contextFrom } from '../../common/alerts/request-context';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  ApiRateLimited,
  ERROR_SCHEMA,
  envelope,
} from '../../common/swagger/api-responses.decorator';
import {
  API_TAGS,
  REFRESH_COOKIE_AUTH,
} from '../../common/swagger/swagger.config';

const REFRESH_COOKIE = 'refresh_token';
// Short-lived, and only exists between the redirect out and the callback back.
const OAUTH_STATE_COOKIE = 'g_oauth_state';

// httpOnly cookie. The SPA and API are on different origins (localhost:5173 vs
// :3000, or separate prod domains), so the cookie must be SameSite=None; Secure
// to be stored/sent on credentialed cross-origin requests. Chrome treats
// http://localhost as a secure context, so Secure works in local dev too.
function refreshCookieOptions(maxAge: number): CookieOptions {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    path: '/',
    maxAge,
  };
}

function readRefreshCookie(req: Request): string | undefined {
  const cookies = req.cookies as Record<string, string> | undefined;
  return cookies?.[REFRESH_COOKIE];
}

@ApiTags(API_TAGS.auth)
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  /**
   * Create the account and sign in, in one call. Mirrors login: same body
   * shape back, same refresh cookie set.
   */
  /**
   * Create the account. Does NOT sign anyone in.
   *
   * It used to return the same token pair as login, which is what made the
   * address unproven — an account was usable the moment somebody typed an
   * address they did not own. The caller now gets a message and an email.
   */
  @ApiOperation({
    summary: 'Create an account',
    description:
      'Creates the account and emails a six-digit code. It does NOT sign anyone in and returns no token — the address is unproven until the code is confirmed, and login refuses until then. Student id, department and year are not collected here; the welcome page sets them afterwards.',
  })
  @ApiCreatedResponse({
    description: 'Account created and the verification email sent.',
    schema: envelope({
      type: 'object',
      properties: {
        message: {
          type: 'string',
          example: 'Check your email for the verification code',
        },
      },
    }),
  })
  @ApiBadRequestResponse({
    description: 'Validation failed.',
    schema: ERROR_SCHEMA,
  })
  @ApiConflictResponse({
    description: 'That email is already registered.',
    schema: ERROR_SCHEMA,
  })
  @ApiRateLimited()
  @RateLimitTier('signup')
  @Post('register')
  async register(@Body() dto: RegisterDto, @Req() req: Request) {
    return this.authService.register(dto, contextFrom(req));
  }

  /**
   * Confirm an address with the six-digit code from the sign-up email.
   *
   * On its own tier: a code is guessable in a way a reset link is not, so the
   * budget for hammering this endpoint is tighter than for redeeming a link.
   * The per-code attempt cap in the service is the real control; this bounds
   * how fast someone can burn through codes to get more attempts.
   */
  @ApiOperation({
    summary: 'Confirm an email address',
    description:
      'Redeems the six-digit code from the sign-up email and signs the account in: the access token comes back in the body and the refresh cookie is set, so a confirmed address goes straight into the app. A code allows five attempts before it is burned.',
  })
  @ApiOkResponse({
    description: 'Address confirmed. Sets the `refresh_token` cookie.',
    schema: envelope({
      type: 'object',
      properties: {
        message: { type: 'string' },
        user: { type: 'object', additionalProperties: true },
        token: { type: 'string', description: 'Access token (JWT).' },
      },
    }),
  })
  @ApiBadRequestResponse({
    description: 'Wrong or expired code, or the attempt cap was reached.',
    schema: ERROR_SCHEMA,
  })
  @ApiRateLimited()
  @RateLimitTier('email-code')
  @Post('verify-email')
  @HttpCode(200)
  async verifyEmail(
    @Body() dto: VerifyCodeDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Returns a session, so the same cookie login sets is set here — a
    // confirmed address goes straight into the app rather than back to a
    // sign-in form it has already earned the right to skip.
    const { message, user, accessToken, refreshToken } =
      await this.authService.verifyEmailCode(dto.email, dto.code);

    res.cookie(
      REFRESH_COOKIE,
      refreshToken,
      refreshCookieOptions(this.authService.refreshTtlMs),
    );

    return { message, user, token: accessToken };
  }

  /** Send the verification link again. Answers the same for any address. */
  @ApiOperation({
    summary: 'Resend the verification code',
    description:
      'Answers the same for any address, registered or not, so this cannot be used to discover who has an account.',
  })
  @ApiOkResponse({
    description: 'Always the same acknowledgement.',
    schema: envelope({
      type: 'object',
      properties: { message: { type: 'string' } },
    }),
  })
  @ApiRateLimited()
  @RateLimitTier('email-send')
  @Post('resend-verification')
  @HttpCode(200)
  async resendVerification(@Body() dto: EmailDto) {
    return this.authService.resendVerification(dto.email);
  }

  /** Start a password reset. Answers the same for any address. */
  @ApiOperation({
    summary: 'Start a password reset',
    description:
      'Emails a six-digit reset code. Answers the same for any address, registered or not.',
  })
  @ApiOkResponse({
    description: 'Always the same acknowledgement.',
    schema: envelope({
      type: 'object',
      properties: { message: { type: 'string' } },
    }),
  })
  @ApiRateLimited()
  @RateLimitTier('email-send')
  @Post('forgot-password')
  @HttpCode(200)
  async forgotPassword(@Body() dto: EmailDto, @Req() req: Request) {
    return this.authService.forgotPassword(dto.email, contextFrom(req));
  }

  /**
   * Check a reset code without spending it.
   *
   * Lets the client confirm the code before collecting a new password, so a
   * wrong code costs six digits rather than a password typed twice. A wrong
   * guess still counts against the same five-attempt cap — a check that did
   * not count would be an unlimited oracle.
   */
  @ApiOperation({
    summary: 'Check a reset code without spending it',
    description:
      'Lets the client confirm a code before collecting a new password. A wrong guess still counts against the same five-attempt cap, so this is not an unlimited oracle.',
  })
  @ApiOkResponse({
    description: 'The code is valid and still unspent.',
    schema: envelope({
      type: 'object',
      properties: { message: { type: 'string' } },
    }),
  })
  @ApiBadRequestResponse({
    description: 'Wrong or expired code, or the attempt cap was reached.',
    schema: ERROR_SCHEMA,
  })
  @ApiRateLimited()
  @RateLimitTier('email-code')
  @Post('reset-code/check')
  @HttpCode(200)
  async checkResetCode(@Body() dto: VerifyCodeDto) {
    return this.authService.checkResetCode(dto.email, dto.code);
  }

  /**
   * Finish a password reset with the emailed code.
   *
   * Same tier as confirming an address: both submit a six-digit code, so both
   * need the budget that bounds guessing at one.
   *
   * Deliberately does not sign the caller in. The password is being set by
   * someone who could not produce the old one, so the session waits until they
   * can type the new one — which also means an abandoned reset leaves no
   * logged-in tab behind.
   */
  @ApiOperation({
    summary: 'Finish a password reset',
    description:
      'Sets the new password and revokes every existing session. Deliberately does NOT sign the caller in — the password was set by someone who could not produce the old one, so they must now type the new one.',
  })
  @ApiOkResponse({
    description: 'Password changed and all sessions revoked.',
    schema: envelope({
      type: 'object',
      properties: { message: { type: 'string' } },
    }),
  })
  @ApiBadRequestResponse({
    description: 'Wrong or expired code, or the attempt cap was reached.',
    schema: ERROR_SCHEMA,
  })
  @ApiRateLimited()
  @RateLimitTier('email-code')
  @Post('reset-password')
  @HttpCode(200)
  async resetPassword(@Body() dto: ResetPasswordDto, @Req() req: Request) {
    return this.authService.resetPassword(
      dto.email,
      dto.code,
      dto.password,
      contextFrom(req),
    );
  }

  @ApiOperation({
    summary: 'Sign in',
    description:
      'Returns a short-lived access token in the body and sets the long-lived `refresh_token` cookie (httpOnly, Secure, SameSite=None). Refused while the address is unconfirmed, and while the account is banned.',
  })
  @ApiOkResponse({
    description: 'Signed in. Sets the `refresh_token` cookie.',
    schema: envelope({
      type: 'object',
      properties: {
        user: { type: 'object', additionalProperties: true },
        token: { type: 'string', description: 'Access token (JWT).' },
      },
    }),
  })
  @ApiUnauthorizedResponse({
    description: 'Wrong credentials, or the address is not yet confirmed.',
    schema: ERROR_SCHEMA,
  })
  @ApiForbiddenResponse({
    description: 'The account is banned.',
    schema: ERROR_SCHEMA,
  })
  @ApiRateLimited()
  @RateLimitTier('auth')
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user, accessToken, refreshToken } = await this.authService.login(
      dto,
      contextFrom(req),
    );
    res.cookie(
      REFRESH_COOKIE,
      refreshToken,
      refreshCookieOptions(this.authService.refreshTtlMs),
    );
    return { user, token: accessToken };
  }

  /**
   * GET /auth/google — send the browser to Google's consent screen.
   *
   * The `state` value is stored in a short-lived cookie and echoed back by
   * Google, so the callback can tell its own redirect apart from one someone
   * else constructed.
   */
  @RateLimitTier('oauth')
  /**
   * Plain `@Res()`, NOT passthrough.
   *
   * `passthrough: true` means "I will touch the response, but Nest still sends
   * the reply from my return value". This handler sends its own reply —
   * res.redirect() writes the 302 and ends the response — so Nest then tried to
   * send `undefined` on top of a finished response and Express threw
   * ERR_HTTP_HEADERS_SENT. The redirect still reached the browser, so Google
   * sign-in worked while every click logged a 500 behind it.
   *
   * googleCallback below has always used plain `@Res()` for the same reason.
   */
  @ApiOperation({
    summary: 'Start Google sign-in',
    description:
      'Redirects the browser to Google and sets a short-lived `g_oauth_state` cookie the callback checks. Open this in a browser — it answers with a 302, not JSON, so it cannot be exercised from this page.',
  })
  @ApiFoundResponse({ description: "Redirect to Google's consent screen." })
  @ApiRateLimited()
  @Get('google')
  googleRedirect(@Res() res: Response) {
    const state = randomBytes(16).toString('hex');
    // Built first: if Google isn't configured this throws, and we'd rather not
    // leave a stray state cookie behind on a request that never left.
    const url = this.authService.buildGoogleAuthUrl(state);
    res.cookie(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 10 * 60 * 1000,
    });
    res.redirect(url);
  }

  /**
   * GET /auth/google/callback — Google sends the browser back here.
   *
   * Ends in a redirect to the SPA, never a JSON body: this is a top-level
   * navigation, so the user must land on a page. The session travels in the
   * httpOnly refresh cookie rather than a token in the URL, which would end up
   * in browser history and in any referrer.
   */
  @ApiOperation({
    summary: 'Google sign-in callback',
    description:
      'Where Google returns the browser. Always ends in a redirect to the SPA, never JSON: the session travels in the httpOnly refresh cookie rather than a token in the URL, which would be left in history and referrers. Called by Google, not by clients.',
  })
  @ApiFoundResponse({
    description:
      'Redirect back to the frontend, with the refresh cookie set on success.',
  })
  @ApiRateLimited()
  @RateLimitTier('oauth')
  @Get('google/callback')
  async googleCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const frontend = (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(
      ',',
    )[0];
    const cookies = req.cookies as Record<string, string> | undefined;
    const expectedState = cookies?.[OAUTH_STATE_COOKIE];
    res.clearCookie(OAUTH_STATE_COOKIE, { path: '/' });

    const fail = (reason: string) =>
      res.redirect(
        `${frontend}/auth/login?google_error=${encodeURIComponent(reason)}`,
      );

    // The user pressed cancel, or Google refused outright.
    if (error) return fail(error);
    if (!code) return fail('missing_code');
    if (!state || !expectedState || state !== expectedState)
      return fail('state_mismatch');

    try {
      const { refreshToken } = await this.authService.completeGoogleLogin(
        code,
        contextFrom(req),
      );
      res.cookie(
        REFRESH_COOKIE,
        refreshToken,
        refreshCookieOptions(this.authService.refreshTtlMs),
      );
      // The SPA trades this cookie for an access token on landing.
      return res.redirect(`${frontend}/auth/callback`);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Google sign-in failed';
      return fail(message);
    }
  }

  @ApiOperation({
    summary: 'Exchange the refresh cookie for a new access token',
    description:
      'Reads the `refresh_token` cookie — not a bearer token — and rotates it: the old token is consumed and a new one is set. Reusing a consumed token revokes the whole family, which is how a stolen cookie is contained. Cannot be called from this page, since scripts cannot set an httpOnly cookie.',
  })
  @ApiCookieAuth(REFRESH_COOKIE_AUTH)
  @ApiOkResponse({
    description: 'New access token issued and the cookie rotated.',
    schema: envelope({
      type: 'object',
      properties: { token: { type: 'string' } },
    }),
  })
  @ApiUnauthorizedResponse({
    description: 'Missing, expired, already-used or revoked refresh token.',
    schema: ERROR_SCHEMA,
  })
  @ApiRateLimited()
  @RateLimitTier('refresh')
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { accessToken, refreshToken } = await this.authService.refresh(
      readRefreshCookie(req),
    );
    res.cookie(
      REFRESH_COOKIE,
      refreshToken,
      refreshCookieOptions(this.authService.refreshTtlMs),
    );
    return { token: accessToken };
  }

  @ApiOperation({
    summary: 'Sign out',
    description:
      'Revokes the refresh token in the cookie and clears it. Succeeds even when no cookie is present, so a client can always reach a signed-out state.',
  })
  @ApiCookieAuth(REFRESH_COOKIE_AUTH)
  @ApiOkResponse({
    description: 'Session revoked and the cookie cleared.',
    schema: envelope({
      type: 'object',
      properties: { message: { type: 'string', example: 'Logged out' } },
    }),
  })
  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.authService.logout(readRefreshCookie(req));
    res.clearCookie(REFRESH_COOKIE, {
      path: '/',
      secure: true,
      sameSite: 'none',
    });
    return { message: 'Logged out' };
  }
}
