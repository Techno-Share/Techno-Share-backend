import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RedisService } from '../../common/redis/redis.service';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { API_TAGS } from '../../common/swagger/swagger.config';

type Dep = 'up' | 'down' | 'not-configured';

/**
 * Probes for the orchestrator and for monitoring.
 *
 *  - `/health/live` — is this process alive? Touches nothing. Docker restarts
 *    on it, so it must not fail for a reason a restart cannot fix; a
 *    dependency outage would otherwise restart-loop every replica.
 *  - `/health/ready` — should this replica take traffic? Checks Postgres only.
 *
 * Readiness is narrow on purpose, because it feeds the load balancer: any
 * dependency it checks becomes one that can take the whole site down. Redis
 * serves rate limits and socket rooms, MinIO serves already-uploaded files,
 * and a blip in either would leave nginx with no upstream at all. Postgres is
 * the only dependency without which no request can be served.
 *
 * Other dependencies appear in the body as information, never as a verdict —
 * the body is for dashboards, the status code is for the balancer.
 *
 * Unauthenticated: a prober has no session, and the body reveals nothing a
 * caller could not learn by watching the site work or not work.
 */
@ApiTags(API_TAGS.health)
@Controller('health')
export class HealthController {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly redis: RedisService,
  ) {}

  /**
   * Liveness. No dependencies, no I/O — if the process answers, it is alive.
   *
   * `@Res()` here only to match /ready's flat body: a monitor matching on
   * `"status":"ok"` should get the same shape from both probes rather than one
   * wrapped in the API envelope and one not.
   */
  @ApiOperation({
    summary: 'Liveness probe',
    description:
      'Answers whether the process is running and touches no dependency. Docker restarts on this, so it must not fail for anything a restart cannot fix. Bypasses the success envelope - the body is exactly as shown.',
  })
  @ApiOkResponse({
    description: 'The process is up.',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', example: 'ok' },
        uptime_seconds: { type: 'number', example: 4213 },
      },
    },
  })
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
  @ApiOperation({
    summary: 'Readiness probe',
    description:
      'Answers whether this replica should receive traffic. Checks Postgres only - readiness feeds the load balancer, so any dependency listed here becomes one that can take the whole site down. Redis and object storage appear in the body as information, never as a verdict. Bypasses the success envelope.',
  })
  @ApiOkResponse({
    description: 'Postgres reachable; this replica can serve traffic.',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', example: 'ok' },
        database: { type: 'string', enum: ['up', 'down', 'not-configured'] },
        redis: { type: 'string', enum: ['up', 'down', 'not-configured'] },
        storage: { type: 'string', enum: ['up', 'down', 'not-configured'] },
      },
    },
  })
  @ApiServiceUnavailableResponse({
    description:
      'Postgres unreachable. The balancer should stop sending traffic here.',
  })
  @Get('ready')
  async ready(@Res() res: Response) {
    // checkRedis is synchronous — it reads a getter rather than issuing a
    // command — so only the database probe does I/O.
    const db = await this.checkDb();
    const redis = this.checkRedis();

    const healthy = db === 'up';
    res.status(healthy ? 200 : 503).json({
      // Only the database decides this. See the class comment.
      status: healthy ? 'ok' : 'degraded',
      db,
      // Informational: visible to a dashboard, never acted on by the balancer.
      redis,
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
}
