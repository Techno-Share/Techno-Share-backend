import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { User } from '../users/entities/user.entity';
import { TelegramLinkToken } from './entities/telegram-link-token.entity';

/** Ten minutes: long enough to switch apps, short enough to be worthless later. */
const TOKEN_TTL_MS = 10 * 60 * 1000;

/** What a /start payload may contain. Anything else is not one of ours. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;
/**
 * Telegram's own rule for a public @username. Checked rather than trusted: an
 * update is attacker-shaped input, and this value ends up offered as a contact.
 */
const USERNAME_SHAPE = /^[A-Za-z0-9_]{4,32}$/;
/** Mirrors ArrayMaxSize in the users module's update-user.dto.ts. */
const MAX_HANDLES = 5;

/** Long-poll window. Telegram holds the request open until an update arrives. */
const POLL_TIMEOUT_S = 25;

/** The slice of Telegram's update object this bot acts on. */
interface TelegramUpdate {
  update_id?: number;
  message?: {
    text?: unknown;
    chat?: { id?: unknown };
    from?: { id?: unknown; username?: unknown };
  };
}

/**
 * The Telegram bot: account linking, and outbound notification delivery.
 *
 * Optional by design, in the same way MailService is. With no TELEGRAM_BOT_TOKEN
 * the service starts, logs a warning, and every send becomes a no-op — because
 * Telegram is a second channel, and an unconfigured second channel must never
 * stop the app from running or an in-app notification from being created.
 *
 * Nothing here is allowed to throw at a caller in the delivery path. Linking,
 * which a user is waiting on, does report its failures.
 */
@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private readonly botToken: string | null;
  private readonly botUsername: string | null;
  private readonly webhookSecret: string | null;
  private readonly usePolling: boolean;
  private readonly appUrl: string;

  /** Set on shutdown so the poll loop stops between requests. */
  private stopped = false;
  private pollOffset = 0;

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(TelegramLinkToken)
    private readonly tokens: Repository<TelegramLinkToken>,
  ) {
    this.botToken = this.config.get<string>('TELEGRAM_BOT_TOKEN') ?? null;
    this.botUsername =
      this.config.get<string>('TELEGRAM_BOT_USERNAME')?.replace(/^@/, '') ??
      null;
    this.webhookSecret =
      this.config.get<string>('TELEGRAM_WEBHOOK_SECRET') ?? null;
    this.usePolling =
      (this.config.get<string>('TELEGRAM_USE_POLLING') ?? '').toLowerCase() ===
      'true';
    /**
     * Where a link in a message should point. Falls back to the first CORS
     * origin, which is already the address the SPA is served from — one fewer
     * variable to keep in step for anyone who never sets APP_URL.
     */
    this.appUrl = (
      this.config.get<string>('APP_URL') ??
      this.config.get<string>('CORS_ORIGIN')?.split(',')[0] ??
      'http://localhost:5173'
    ).replace(/\/+$/, '');

    if (!this.botToken || !this.botUsername) {
      this.logger.warn(
        'Telegram not configured (TELEGRAM_BOT_TOKEN/TELEGRAM_BOT_USERNAME) — ' +
          'in-app notifications are unaffected; Telegram delivery is disabled.',
      );
    }
  }

  /** False means every Telegram path degrades to a no-op rather than an error. */
  get isConfigured(): boolean {
    return !!this.botToken && !!this.botUsername;
  }

  // ── Bot API ───────────────────────────────────────────────────────────────

  /**
   * One call to the Bot API. Returns null instead of throwing: every caller is
   * either a best-effort delivery or a reply to a chat, and neither is worth
   * failing a request over.
   */
  private async callApi<T>(
    method: string,
    body: Record<string, unknown>,
  ): Promise<T | null> {
    if (!this.botToken) return null;
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${this.botToken}/${method}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          // Long polling holds the connection open; everything else is quick.
          signal: AbortSignal.timeout(
            method === 'getUpdates' ? (POLL_TIMEOUT_S + 10) * 1000 : 10_000,
          ),
        },
      );
      const json = (await res.json()) as {
        ok?: boolean;
        result?: T;
        description?: string;
        error_code?: number;
      };
      if (!json.ok) {
        this.logger.warn(
          `Telegram ${method} failed: ${json.error_code ?? '?'} ${json.description ?? ''}`,
        );
        return null;
      }
      return json.result ?? null;
    } catch (err) {
      this.logger.warn(
        `Telegram ${method} errored: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /** `text` is sent as HTML, so anything interpolated must be escaped first. */
  private static escape(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  async sendMessage(chatId: string, text: string): Promise<boolean> {
    if (!this.isConfigured) return false;
    const result = await this.callApi<unknown>('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    return result !== null;
  }

  /**
   * Deliver a notification to a user, if they have connected Telegram.
   *
   * Resolves to false for every ordinary reason not to send — no bot, no link,
   * Telegram down — and never throws. Callers are creating an in-app
   * notification, which has already succeeded by the time this runs.
   */
  async notifyUser(
    userId: string,
    message: string,
    notificationId?: string,
  ): Promise<boolean> {
    if (!this.isConfigured) return false;

    let chatId: string | null = null;
    try {
      const user = await this.users.findOne({
        where: { id: userId },
        select: { id: true, telegram_chat_id: true },
      });
      chatId = user?.telegram_chat_id ?? null;
    } catch (err) {
      this.logger.warn(
        `Could not read the Telegram link for ${userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
    if (!chatId) return false;

    /**
     * A link to the notification, not to the page it concerns: the app decides
     * where that is, through the same mapping the bell uses. See the /n/:id
     * route — encoding the destination here would be a second copy of rules
     * that are free to drift from the first.
     */
    const link = notificationId ? `${this.appUrl}/n/${notificationId}` : null;
    /**
     * Always the short form. Telegram will not make a link of a host without a
     * public TLD, so on a development APP_URL the word sits there as plain
     * text — accepted deliberately, to keep one wording everywhere. It becomes
     * tappable the moment APP_URL is a real domain.
     */
    const tail = link
      ? ['', `Open ITC Sharing: <a href="${link}">Link</a>`]
      : [];
    // Blank line under the header, so the sentence reads as its own paragraph
    // rather than as a subtitle of the app name.
    const body = [
      `🔔 <b>ITC Sharing</b>`,
      '',
      TelegramService.escape(message),
      ...tail,
    ].join('\n');

    const sent = await this.sendMessage(chatId, body);

    // A user who blocked the bot, or deleted the chat, will never receive
    // another message. Dropping the link stops the pointless calls and lets
    // settings tell them the truth: they are no longer connected.
    if (!sent) await this.forgetIfUnreachable(chatId);
    return sent;
  }

  /**
   * getChat is cheap and says plainly whether the chat is still reachable, so
   * one failed send does not unlink someone over a momentary network blip.
   */
  private async forgetIfUnreachable(chatId: string): Promise<void> {
    const chat = await this.callApi<unknown>('getChat', { chat_id: chatId });
    if (chat !== null) return;
    try {
      await this.users.update(
        { telegram_chat_id: chatId },
        { telegram_chat_id: null, telegram_linked_at: null },
      );
      this.logger.log(`Unlinked unreachable Telegram chat ${chatId}`);
    } catch {
      // Nothing to do — the next send will try again.
    }
  }

  // ── Linking ───────────────────────────────────────────────────────────────

  private static hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * A fresh single-use token and the deep link that carries it.
   *
   * 32 random bytes, base64url — 43 characters, inside Telegram's 64-character
   * limit for a /start payload. The raw token is returned to the caller and
   * then forgotten; only its hash is stored.
   */
  async createLinkToken(
    userId: string,
  ): Promise<{ url: string; expires_at: Date }> {
    if (!this.isConfigured) {
      throw new ServiceUnavailableException(
        'Telegram notifications are not available right now',
      );
    }

    const raw = randomBytes(32).toString('base64url');
    const expires_at = new Date(Date.now() + TOKEN_TTL_MS);

    try {
      // Outstanding tokens are spent first: asking for a new link should
      // invalidate the last one, so a link shared by accident goes stale.
      await this.tokens.update(
        { user_id: userId, used_at: IsNull() },
        { used_at: new Date() },
      );
      await this.tokens.save(
        this.tokens.create({
          user_id: userId,
          token_hash: TelegramService.hash(raw),
          expires_at,
          used_at: null,
        }),
      );
    } catch (err) {
      this.logger.error(
        `Could not create a Telegram link token: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new ServiceUnavailableException(
        'Could not start Telegram linking. Please try again.',
      );
    }

    return {
      url: `https://t.me/${this.botUsername}?start=${raw}`,
      expires_at,
    };
  }

  /**
   * Spend a token and attach the chat to its user.
   *
   * The spend is a single conditional UPDATE rather than a read followed by a
   * write: two /start messages racing must not both succeed, and only the
   * database can settle that.
   */
  private async redeem(
    rawToken: string,
    chatId: string,
    username: string | null,
  ): Promise<'linked' | 'already-elsewhere' | 'invalid'> {
    if (!TOKEN_SHAPE.test(rawToken)) return 'invalid';

    let userId: string | undefined;
    try {
      const spent = await this.tokens
        .createQueryBuilder()
        .update(TelegramLinkToken)
        .set({ used_at: () => 'now()' })
        .where('token_hash = :hash', { hash: TelegramService.hash(rawToken) })
        .andWhere('used_at is null')
        .andWhere('expires_at > now()')
        .returning('user_id')
        .execute();
      userId = (spent.raw as { user_id: string }[])[0]?.user_id;
    } catch (err) {
      this.logger.error(
        `Could not spend a Telegram token: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 'invalid';
    }
    if (!userId) return 'invalid';

    try {
      /**
       * One statement, because the handle has to be merged against the list as
       * it is now — reading it first and writing it back would lose whatever a
       * second /start, or the profile, wrote in between.
       *
       * The username joins the saved accounts rather than replacing the chosen
       * one: connecting the bot is not a statement about which Telegram the
       * donor wants handed out, and overwriting a deliberate choice would be.
       * It only becomes the choice when there is no choice yet.
       *
       * Capped at the same five the profile enforces, so the bot cannot grow
       * the list past what the editor can show.
       */
      await this.users
        .createQueryBuilder()
        .update(User)
        .set({
          telegram_chat_id: chatId,
          telegram_linked_at: () => 'now()',
          telegram_handles: () => `
            case
              when :handle::text is null then telegram_handles
              when :handle = any(telegram_handles) then telegram_handles
              when cardinality(telegram_handles) >= ${MAX_HANDLES} then telegram_handles
              else array_append(telegram_handles, :handle)
            end`,
          telegram: () => 'coalesce(telegram, :handle)',
        })
        .where('id = :userId', { userId })
        .setParameter('handle', username ? `@${username}` : null)
        .execute();
      return 'linked';
    } catch (err) {
      // 23505: the unique index caught this chat already belonging to another
      // account. Refusing is the point — one Telegram account, one user.
      const code = (err as { code?: string })?.code;
      if (code === '23505') return 'already-elsewhere';
      this.logger.error(
        `Could not save a Telegram link: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 'invalid';
    }
  }

  async status(userId: string): Promise<{
    connected: boolean;
    linked_at: Date | null;
    available: boolean;
  }> {
    const user = await this.users.findOne({
      where: { id: userId },
      select: { id: true, telegram_chat_id: true, telegram_linked_at: true },
    });
    return {
      connected: !!user?.telegram_chat_id,
      linked_at: user?.telegram_linked_at ?? null,
      available: this.isConfigured,
    };
  }

  /** Disconnect, and say goodbye in the chat so it is not a silent change. */
  async unlink(userId: string): Promise<{ connected: false }> {
    const user = await this.users.findOne({
      where: { id: userId },
      select: { id: true, telegram_chat_id: true },
    });
    const chatId = user?.telegram_chat_id ?? null;

    try {
      await this.users.update(
        { id: userId },
        { telegram_chat_id: null, telegram_linked_at: null },
      );
      await this.tokens.update(
        { user_id: userId, used_at: IsNull() },
        { used_at: new Date() },
      );
    } catch (err) {
      this.logger.error(
        `Could not unlink Telegram for ${userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new ServiceUnavailableException('Could not disconnect Telegram');
    }

    if (chatId) {
      await this.sendMessage(
        chatId,
        '🔕 This Telegram account has been disconnected from ITC Sharing. ' +
          'You will no longer receive notifications here.',
      );
    }
    return { connected: false };
  }

  // ── Incoming updates ──────────────────────────────────────────────────────

  /**
   * Telegram sets this header to the secret registered with setWebhook, and it
   * is the only thing separating a real delivery from anyone who guessed the
   * URL. Compared in constant time.
   */
  verifyWebhookSecret(provided: string | undefined): boolean {
    if (!this.webhookSecret) return false;
    if (typeof provided !== 'string') return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(this.webhookSecret);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * Act on one update. Everything arriving here is attacker-controllable, so
   * each field is checked for shape before it is used, and anything unexpected
   * is ignored rather than rejected — Telegram retries what it thinks failed.
   */
  async handleUpdate(update: unknown): Promise<void> {
    if (typeof update !== 'object' || update === null) return;
    const message = (update as TelegramUpdate).message;
    if (!message) return;

    const rawChatId = message.chat?.id;
    const rawUsername = message.from?.username;
    const text = message.text;
    if (typeof rawChatId !== 'number' && typeof rawChatId !== 'string') return;
    if (typeof text !== 'string') return;

    const chatId = String(rawChatId);
    // Commands can arrive as "/start@BotName payload" in groups.
    const match = /^\/start(?:@\w+)?(?:\s+(\S+))?/.exec(text.trim());
    if (!match) return;

    const payload = match[1];
    if (!payload) {
      await this.sendMessage(
        chatId,
        'Hello! To receive ITC Sharing notifications here, open ITC Sharing → ' +
          'Settings → Telegram Notifications and press <b>Connect Telegram</b>.',
      );
      return;
    }

    // Absent when the Telegram account has no public @username — there is
    // simply nothing to offer then, and linking still succeeds.
    const username =
      typeof rawUsername === 'string' && USERNAME_SHAPE.test(rawUsername)
        ? rawUsername
        : null;
    const result = await this.redeem(payload, chatId, username);
    if (result === 'linked') {
      await this.sendMessage(
        chatId,
        '✅ <b>Connected.</b>\nYou will now receive ITC Sharing notifications here. ' +
          'You can disconnect any time from Settings.',
      );
      return;
    }
    if (result === 'already-elsewhere') {
      await this.sendMessage(
        chatId,
        '⚠️ This Telegram account is already connected to a different ITC Sharing ' +
          'account. Disconnect it there first, then try again.',
      );
      return;
    }
    await this.sendMessage(
      chatId,
      '⚠️ That link has expired or was already used. Open ITC Sharing → Settings → ' +
        'Telegram Notifications and press <b>Connect Telegram</b> for a fresh one.',
    );
  }

  // ── Dev transport ─────────────────────────────────────────────────────────

  /**
   * Long polling, for development only.
   *
   * Telegram cannot reach a laptop, so a webhook is untestable locally without
   * a tunnel. With TELEGRAM_USE_POLLING=true the bot asks for its own updates
   * instead, through the same handler the webhook uses — so what is tested here
   * is what runs in production.
   *
   * The two transports are mutually exclusive at Telegram's end: a registered
   * webhook makes getUpdates fail with 409, hence the deleteWebhook first.
   */
  onModuleInit(): void {
    if (!this.isConfigured || !this.usePolling) return;
    this.logger.log('Telegram polling enabled (development transport)');
    void this.poll();
  }

  onModuleDestroy(): void {
    this.stopped = true;
  }

  private async poll(): Promise<void> {
    await this.callApi('deleteWebhook', { drop_pending_updates: false });

    while (!this.stopped) {
      const updates = await this.callApi<TelegramUpdate[]>('getUpdates', {
        offset: this.pollOffset,
        timeout: POLL_TIMEOUT_S,
        allowed_updates: ['message'],
      });

      if (updates === null) {
        // Backs off rather than hammering a failing API.
        await new Promise((r) => setTimeout(r, 5_000));
        continue;
      }

      for (const update of updates) {
        if (typeof update.update_id === 'number') {
          this.pollOffset = Math.max(this.pollOffset, update.update_id + 1);
        }
        await this.handleUpdate(update);
      }
    }
  }

  /** Guards the controller: linking is meaningless without a configured bot. */
  assertConfigured(): void {
    if (!this.isConfigured) {
      throw new BadRequestException(
        'Telegram notifications are not available right now',
      );
    }
  }
}
