import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { UserBan } from '../../users/entities/user-ban.entity';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly logger = new Logger(JwtStrategy.name);

  constructor(
    private configService: ConfigService,
    @InjectRepository(User)
    private readonly users: Repository<User>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: configService.getOrThrow<string>('JWT_SECRET'),
    });
  }

  /**
   * A valid signature isn't enough: an access token issued before a ban would
   * otherwise keep working until it expired. One lookup per request makes a ban
   * take effect on the next call.
   *
   * Existence and the ban are asked in a single statement, not through
   * BanLookupService like the rest of the codebase. This runs on every
   * authenticated request, and the join is what keeps it to one round trip
   * after the flag on `users` was dropped. The partial index it probes holds
   * only accounts actually banned, so it is nearly empty.
   */
  async validate(payload: { sub: string; email: string }) {
    const row = await this.users
      .createQueryBuilder('u')
      .leftJoin(UserBan, 'b', 'b.user_id = u.id and b.lifted_at is null')
      .select('u.id', 'id')
      .addSelect('b.id is not null', 'banned')
      .where('u.id = :id', { id: payload.sub })
      .getRawOne<{ id: string; banned: boolean }>();

    if (!row) throw new UnauthorizedException('Account no longer exists');
    if (row.banned) throw new UnauthorizedException('Account is banned');

    this.touchLastSeen(payload.sub);

    return { sub: payload.sub, email: payload.email };
  }

  /**
   * Record that this account is active, at most once a minute.
   *
   * The WHERE clause is the throttle, and it is the whole point: this method is
   * reached on EVERY authenticated request, so an unconditional write would put
   * a row update behind every call in the app to maintain a value read by one
   * admin screen. With it, almost every call matches no row and writes nothing.
   *
   * Deliberately not awaited. Whether the write lands has no bearing on whether
   * the request is allowed, and making every request wait on it would charge
   * the whole app for an admin convenience. The returned promise is given a
   * catch rather than left floating, so a database hiccup here is logged
   * instead of surfacing as an unhandled rejection — and it must never be the
   * reason a signed-in user is turned away.
   *
   * `() => 'now()'` so the timestamp comes from Postgres, like the comparison
   * beside it. Taking it from the Node process would mean two clocks deciding
   * whether a minute has passed.
   */
  private touchLastSeen(userId: string): void {
    void this.users
      .createQueryBuilder()
      .update(User)
      .set({ last_seen_at: () => 'now()' })
      .where('id = :id', { id: userId })
      .andWhere(
        "(last_seen_at is null or last_seen_at < now() - interval '1 minute')",
      )
      .execute()
      .catch((error: unknown) =>
        this.logger.warn(
          `Could not record last_seen for ${userId}: ` +
            (error instanceof Error ? error.message : String(error)),
        ),
      );
  }
}
