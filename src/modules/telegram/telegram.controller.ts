import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RateLimitTier } from '../../common/rate-limit/rate-limit.decorator';
import { TelegramService } from './telegram.service';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiAuth,
  ApiRateLimited,
  envelope,
} from '../../common/swagger/api-responses.decorator';
import { API_TAGS } from '../../common/swagger/swagger.config';

type AuthenticatedRequest = { user: { sub: string; email: string } };

@ApiTags(API_TAGS.telegram)
@Controller('telegram')
export class TelegramController {
  constructor(private readonly telegram: TelegramService) {}

  /**
   * GET /telegram/status — what Settings renders.
   *
   * `available` is separate from `connected`: with no bot configured there is
   * nothing to connect to, and the page says so rather than offering a button
   * that cannot work.
   */
  @ApiAuth()
  @ApiOperation({
    summary: 'Telegram connection status',
    description:
      'Signed in. `available` is false when the server has no bot configured, in which case there is nothing to connect to.',
  })
  @ApiOkResponse({
    description: 'Connection state for this account.',
    schema: envelope({
      type: 'object',
      properties: {
        connected: { type: 'boolean' },
        available: { type: 'boolean' },
        handle: { type: 'string', nullable: true },
      },
    }),
  })
  @Get('status')
  @UseGuards(JwtAuthGuard)
  status(@Request() req: AuthenticatedRequest) {
    return this.telegram.status(req.user.sub);
  }

  /**
   * POST /telegram/link-token — start linking.
   *
   * Authenticated, because the token it returns is what proves to the bot which
   * account a chat belongs to. The bot token itself never leaves the server;
   * the client only ever sees a t.me URL.
   */
  @ApiAuth()
  @ApiOperation({
    summary: 'Start linking Telegram',
    description:
      'Signed in. Returns a short-lived deep link to open in Telegram; the bot completes the link when the user presses start. The token lasts ten minutes.',
  })
  @ApiOkResponse({
    description: 'Deep link to open in Telegram.',
    schema: envelope({
      type: 'object',
      properties: { url: { type: 'string' } },
    }),
  })
  @ApiRateLimited()
  @RateLimitTier('telegram-link')
  @Post('link-token')
  @UseGuards(JwtAuthGuard)
  createLinkToken(@Request() req: AuthenticatedRequest) {
    this.telegram.assertConfigured();
    return this.telegram.createLinkToken(req.user.sub);
  }

  /** DELETE /telegram/link — stop delivering to Telegram. */
  @ApiAuth()
  @ApiOperation({
    summary: 'Disconnect Telegram',
    description: 'Signed in. Stops Telegram notifications for this account.',
  })
  @ApiOkResponse({
    description: 'Disconnected.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @Delete('link')
  @UseGuards(JwtAuthGuard)
  unlink(@Request() req: AuthenticatedRequest) {
    return this.telegram.unlink(req.user.sub);
  }

  /**
   * POST /telegram/webhook — where Telegram delivers updates.
   *
   * Public by necessity, so the shared secret is the whole of the
   * authentication: Telegram echoes the value registered with setWebhook in
   * this header, and anything without it is dropped.
   *
   * Always answers 200. A non-2xx tells Telegram to redeliver, which turns one
   * malformed update into a retry loop — and there is nothing a caller could do
   * with an error here anyway.
   */
  @ApiOperation({
    summary: 'Telegram bot webhook',
    description:
      'Called by Telegram, not by clients. Public by necessity - Telegram cannot present a token - so the handler verifies the update instead. Always answers 200 so Telegram does not retry.',
  })
  @ApiOkResponse({
    description: 'Acknowledged.',
    schema: { type: 'object', additionalProperties: true },
  })
  @ApiRateLimited()
  @RateLimitTier('telegram-webhook')
  @Post('webhook')
  @HttpCode(200)
  async webhook(
    @Headers('x-telegram-bot-api-secret-token') secret: string | undefined,
    @Body() update: unknown,
  ) {
    if (!this.telegram.verifyWebhookSecret(secret)) return { ok: true };
    await this.telegram.handleUpdate(update);
    return { ok: true };
  }
}
