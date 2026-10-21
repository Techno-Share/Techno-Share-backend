import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RedisService } from '../../common/redis/redis.service';
import { ClamAvService } from '../../common/security/clamav.service';

type Dep = 'up' | 'down' | 'not-configured';

/**
 * Probes for the orchestrator and for monitoring.
 *
 * Two endpoints, kept deliberately different:
 *
 *  - /health/live  answers "is this process alive?" and touches nothing. It is
 *    what Docker restarts on, so it must not fail for a reason a restart
 *    cannot fix — a dependency outage would otherwise put every replica into
 *    a restart loop while the application itself was fine.
 *
 *  - /health/ready answers "should this replica receive traffic?" and checks
 *    POSTGRES ONLY.
 *
 * The narrowness of the readiness check is the important decision. It is
 * tempting to verify every dependency here, but readiness feeds the load
 * balancer: anything listed becomes a thing that can take the whole site down.
 * ClamAV only matters for uploads, and MinIO only for files already uploaded —
 * if a scanner blip marked both replicas unready, nginx would have no upstream
 * at all and the site would go dark because nobody could scan a file nobody was
 * uploading. Postgres is the only dependency without which no request can be
 * served, so it is the only one that gates traffic.
 *
 * Everything else is reported in the body as information, never as a verdict.
 * That is what a dashboard reads; the status code is what the balancer reads.
 *
 * Unauthenticated on purpose: a prober has no session, and the body says
 * nothing a caller could not learn by watching the site work or not work.
 */
@Controller('health')
export class HealthController {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly redis: RedisService,
    private readonly clamav: ClamAvService,
  ) {}

  /**
   * Liveness. No dependencies, no I/O — if the process answers, it is alive.
   *
   * `@Res()` here only to match /ready's flat body: a monitor matching on
   * `"status":"ok"` should get the same shape from both probes rather than one
   * wrapped in the API envelope and one not.
   */
  @Get('live')
  live(@Res() res: Response) {
    res.status(200).json({
      status: 'ok',
      uptime_seconds: Math.round(process.uptime()),
    });
  }

  /**
   * Readiness. 200 while Postgres answers, 503 when it does not.
   *
   * Plain `@Res()`, NOT passthrough, for two reasons that both matter:
   *
   *  - A 503 returned the usual way would travel through AllExceptionsFilter,
   *    which alerts the developer chat on every status >= 500. Docker probes
   *    this every 30s on each replica, so a database outage would become four
   *    Telegram messages a minute for as long as it lasted — the alert storm
   *    that makes people mute the channel that is supposed to warn them.
   *  - Writing directly also skips TransformInterceptor's { success, data }
   *    envelope. A prober wants a flat body it can match a keyword against,
   *    not an envelope it has to unwrap.
   */
  @Get('ready')
  async ready(@Res() res: Response) {
    // checkRedis is synchronous — it reads a getter rather than issuing a
    // command — so only the two that do I/O are awaited together.
    const [db, clamav] = await Promise.all([
      this.checkDb(),
      this.checkClamav(),
    ]);
    const redis = this.checkRedis();

    const healthy = db === 'up';
    res.status(healthy ? 200 : 503).json({
      // Only the database decides this. See the class comment.
      status: healthy ? 'ok' : 'degraded',
      db,
      // Informational: visible to a dashboard, never acted on by the balancer.
      redis,
      clamav,
    });
  }

  /**
   * Cheapest possible round trip to Postgres — proves the pool can hand out a
   * live connection, which is the thing that actually breaks.
   */
  private async checkDb(): Promise<Dep> {
    try {
      await this.db.query('select 1');
      return 'up';
    } catch {
      return 'down';
    }
  }

  /**
   * Reads the getter rather than issuing a command: RedisService already
   * returns null while the socket is reconnecting or closed, and that check is
   * free. A PING here would sit in ioredis's offline queue during an outage and
   * make the probe hang — the opposite of what a health check is for.
   */
  private checkRedis(): Dep {
    if (!this.redis.configured) return 'not-configured';
    return this.redis.client ? 'up' : 'down';
  }

  /** clamd answers PING with PONG once its signature database is loaded. */
  private async checkClamav(): Promise<Dep> {
    try {
      return (await this.clamav.ping()) ? 'up' : 'down';
    } catch {
      return 'down';
    }
  }
}
