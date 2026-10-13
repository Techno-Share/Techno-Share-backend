import { MAX_BATCH_BYTES } from '../upload-limits';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';

/**
 * A rolling byte budget per user, on top of the request-count limits.
 *
 * The `upload` rate tier caps how OFTEN someone uploads; it says nothing about
 * how much. 60 requests × 10 files × 50 MB is a legal way to push 30 GB in ten
 * minutes. This caps the volume.
 *
 * Deliberately complements the existing limits rather than replacing them:
 * per-file size, per-request count and request rate all still apply.
 *
 * ── Where the counters live ──────────────────────────────────────────────
 * In Redis when REDIS_URL is set, so every replica spends from one budget;
 * in this process's memory otherwise, which is correct for the single replica
 * that runs today and wrong for the second one — each would grant the full
 * quota independently and the effective limit would become N × the configured
 * one. Same trade-off, and the same switch, as the rate limiter itself.
 *
 * Falling back to memory when a configured Redis cannot be reached is
 * deliberate: the alternative to a degraded limit is no limit or no uploads.
 * See RedisThrottlerStorage for the same reasoning at more length.
 */

/**
 * KEYS: 1 the user's window.  ARGV: 1 bytes, 2 maxBytes, 3 windowMs.
 * Returns { allowed, usedAfter, ttlMs }.
 *
 * One script because this is check-and-reserve, not check then reserve: two
 * uploads that each read the total before either wrote it would both be
 * admitted, and the budget is the one thing that must not be overrun by
 * concurrency.
 */
const CONSUME = `
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local bytes = tonumber(ARGV[1])
local max = tonumber(ARGV[2])

if used + bytes > max then
  local ttl = redis.call('PTTL', KEYS[1])
  if ttl < 0 then ttl = tonumber(ARGV[3]) end
  return { 0, used, ttl }
end

local total = redis.call('INCRBY', KEYS[1], bytes)
local ttl = redis.call('PTTL', KEYS[1])
if total == bytes or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[3])
  ttl = tonumber(ARGV[3])
end
return { 1, total, ttl }
`;

/**
 * KEYS: 1 the user's window.  ARGV: 1 bytes.
 *
 * KEEPTTL matters: a refund must not extend the window it is returning bytes
 * to, or a failing upload retried in a loop would hold the window open
 * indefinitely. Absent key means the window already expired — there is nothing
 * to give back, and recreating it would invent a debt that had been cleared.
 */
const REFUND = `
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
if used <= 0 then return 0 end
local back = used - tonumber(ARGV[1])
if back < 0 then back = 0 end
redis.call('SET', KEYS[1], back, 'KEEPTTL')
return back
`;

interface Window {
  /** Bytes accepted so far in the current window. */
  bytes: number;
  /** Epoch ms at which the window resets. */
  resetAt: number;
}

export interface QuotaDecision {
  allowed: boolean;
  /** Seconds until the window resets. Only meaningful when `allowed` is false. */
  retryAfterSeconds: number;
  /** Bytes still available in the current window. */
  remaining: number;
  limit: number;
}

@Injectable()
export class UploadQuotaService {
  private readonly logger = new Logger(UploadQuotaService.name);
  private readonly windows = new Map<string, Window>();

  private readonly maxBytes: number;
  private readonly windowMs: number;

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {
    const bytes = Number(
      this.config.get<string>('UPLOAD_MAX_BYTES_PER_WINDOW'),
    );
    const seconds = Number(
      this.config.get<string>('UPLOAD_BYTE_WINDOW_SECONDS'),
    );

    // One full batch an hour: generous for coursework and still bounded.
    // Derived rather than written out, so raising the file cap cannot leave
    // the quota behind — if it did, the quota rather than the cap would be
    // what refuses an ordinary upload, with a far less obvious message.
    this.maxBytes =
      Number.isFinite(bytes) && bytes > 0 ? bytes : MAX_BATCH_BYTES;
    this.windowMs =
      Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60 * 60 * 1000;
  }

  /**
   * Ask whether `bytes` may be accepted for this user, and count them if so.
   *
   * Check-and-reserve in one call: two concurrent uploads that each checked
   * before either recorded would both be allowed and the budget would be
   * overrun. Node's single-threaded execution makes this atomic as written.
   */
  async consume(userId: string, bytes: number): Promise<QuotaDecision> {
    const client = this.redis.client;
    if (client) {
      try {
        const [allowed, used, ttlMs] = (await client.eval(
          CONSUME,
          1,
          `quota:upload:${userId}`,
          String(bytes),
          String(this.maxBytes),
          String(this.windowMs),
        )) as [number, number, number];

        this.redis.markHealthy();

        return {
          allowed: allowed === 1,
          retryAfterSeconds:
            allowed === 1 ? 0 : Math.max(1, Math.ceil(ttlMs / 1000)),
          remaining: Math.max(0, this.maxBytes - used),
          limit: this.maxBytes,
        };
      } catch (err) {
        this.redis.markUnhealthy(
          err instanceof Error ? err.message : 'unknown error',
        );
        // Fall through to the in-process window.
      }
    }

    return this.consumeLocally(userId, bytes);
  }

  /** The original in-process implementation; also the fallback. */
  private consumeLocally(userId: string, bytes: number): QuotaDecision {
    const now = Date.now();
    const window = this.windows.get(userId);

    if (!window || window.resetAt <= now) {
      // First upload of a fresh window.
      if (bytes > this.maxBytes) {
        return {
          allowed: false,
          retryAfterSeconds: Math.ceil(this.windowMs / 1000),
          remaining: this.maxBytes,
          limit: this.maxBytes,
        };
      }
      this.windows.set(userId, { bytes, resetAt: now + this.windowMs });
      return {
        allowed: true,
        retryAfterSeconds: 0,
        remaining: this.maxBytes - bytes,
        limit: this.maxBytes,
      };
    }

    if (window.bytes + bytes > this.maxBytes) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((window.resetAt - now) / 1000),
        ),
        remaining: Math.max(0, this.maxBytes - window.bytes),
        limit: this.maxBytes,
      };
    }

    window.bytes += bytes;
    return {
      allowed: true,
      retryAfterSeconds: 0,
      remaining: this.maxBytes - window.bytes,
      limit: this.maxBytes,
    };
  }

  /**
   * Hand bytes back after a failed upload.
   *
   * Without this, a storage error would still spend the student's budget — the
   * quota is meant to bound what is stored, not what was attempted.
   */
  async refund(userId: string, bytes: number): Promise<void> {
    const client = this.redis.client;
    if (client) {
      try {
        await client.eval(REFUND, 1, `quota:upload:${userId}`, String(bytes));
        this.redis.markHealthy();
        return;
      } catch (err) {
        this.redis.markUnhealthy(
          err instanceof Error ? err.message : 'unknown error',
        );
        // Fall through: better to credit the local window than to swallow it.
      }
    }

    const window = this.windows.get(userId);
    if (!window) return;
    window.bytes = Math.max(0, window.bytes - bytes);
  }

  /**
   * Drop expired windows. Called on a timer by the module.
   *
   * In-process windows only. Redis keys carry their own TTL and expire without
   * anyone sweeping them, which is most of why the window is a key rather than
   * a row.
   */
  prune(): void {
    const now = Date.now();
    let dropped = 0;
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) {
        this.windows.delete(key);
        dropped++;
      }
    }
    if (dropped) this.logger.debug(`Pruned ${dropped} expired upload windows`);
  }

  /** Test seam: the configured ceiling. */
  get limitBytes(): number {
    return this.maxBytes;
  }
}
