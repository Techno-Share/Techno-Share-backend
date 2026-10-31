import { Logger } from '@nestjs/common';
import { JwtStrategy } from './strategies/jwt.strategy';

/**
 * Recording when an account was last active.
 *
 * This runs inside `validate`, which every authenticated request passes
 * through, so the properties that matter are not about the timestamp at all —
 * they are about the write staying out of the way: it must be throttled, it
 * must not delay the request, and it must never be able to turn a signed-in
 * user away. The throttle itself was checked against Postgres; what is pinned
 * here is that the clause is actually sent, and that a failure is contained.
 */

type Captured = {
  updates: number;
  where: string[];
  set: Record<string, unknown> | null;
};

function makeStrategy(
  row: { id: string; banned: boolean } | undefined,
  options: { updateFails?: boolean } = {},
) {
  const captured: Captured = { updates: 0, where: [], set: null };

  const selectQb = {
    leftJoin: () => selectQb,
    select: () => selectQb,
    addSelect: () => selectQb,
    where: () => selectQb,
    getRawOne: () => Promise.resolve(row),
  };

  const updateQb = {
    update: () => updateQb,
    set: (v: Record<string, unknown>) => {
      captured.set = v;
      return updateQb;
    },
    where: (c: string) => {
      captured.where.push(c);
      return updateQb;
    },
    andWhere: (c: string) => {
      captured.where.push(c);
      return updateQb;
    },
    execute: () => {
      captured.updates += 1;
      return options.updateFails
        ? Promise.reject(new Error('connection terminated'))
        : Promise.resolve({ affected: 1 });
    },
  };

  const users = {
    // validate() passes an alias; touchLastSeen() passes nothing.
    createQueryBuilder: (alias?: string) => (alias ? selectQb : updateQb),
  };

  const config = { getOrThrow: () => 'test-secret' };
  const strategy = new JwtStrategy(config as never, users as never);

  return { strategy, captured };
}

/** The write is deliberately not awaited, so let its microtasks run. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('last seen', () => {
  beforeEach(() =>
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {}),
  );
  afterEach(() => jest.restoreAllMocks());

  it('records activity for an accepted request', async () => {
    const { strategy, captured } = makeStrategy({ id: 'u-1', banned: false });

    const result = await strategy.validate({ sub: 'u-1', email: 'a@itc.edu' });
    await flush();

    expect(result).toEqual({ sub: 'u-1', email: 'a@itc.edu' });
    expect(captured.updates).toBe(1);
  });

  /**
   * The throttle. Without this clause every authenticated request in the app
   * would write a row to maintain a value one admin screen reads.
   */
  it('writes only when the stored timestamp is stale', async () => {
    const { strategy, captured } = makeStrategy({ id: 'u-1', banned: false });

    await strategy.validate({ sub: 'u-1', email: 'a@itc.edu' });
    await flush();

    const clause = captured.where.join(' ');
    expect(clause).toContain('last_seen_at is null');
    expect(clause).toContain("last_seen_at < now() - interval '1 minute'");
  });

  /** Postgres' clock, not the Node process's — one clock, not two. */
  it('takes the timestamp from the database', async () => {
    const { strategy, captured } = makeStrategy({ id: 'u-1', banned: false });

    await strategy.validate({ sub: 'u-1', email: 'a@itc.edu' });
    await flush();

    const value = captured.set?.last_seen_at as () => string;
    expect(typeof value).toBe('function');
    expect(value()).toBe('now()');
  });

  it('records nothing for a banned account', async () => {
    const { strategy, captured } = makeStrategy({ id: 'u-1', banned: true });

    await expect(
      strategy.validate({ sub: 'u-1', email: 'a@itc.edu' }),
    ).rejects.toThrow('Account is banned');
    await flush();

    expect(captured.updates).toBe(0);
  });

  it('records nothing for an account that no longer exists', async () => {
    const { strategy, captured } = makeStrategy(undefined);

    await expect(
      strategy.validate({ sub: 'gone', email: 'a@itc.edu' }),
    ).rejects.toThrow('Account no longer exists');
    await flush();

    expect(captured.updates).toBe(0);
  });

  /**
   * The property this whole design rests on: "last seen" is advisory, and a
   * database that cannot take the write must not become the reason a valid
   * session is rejected.
   */
  it('still accepts the request when the write fails', async () => {
    const { strategy } = makeStrategy(
      { id: 'u-1', banned: false },
      { updateFails: true },
    );

    await expect(
      strategy.validate({ sub: 'u-1', email: 'a@itc.edu' }),
    ).resolves.toEqual({ sub: 'u-1', email: 'a@itc.edu' });
    await flush();
  });

  /** And the failure is logged rather than left as an unhandled rejection. */
  it('logs a failed write instead of letting it escape', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    const { strategy } = makeStrategy(
      { id: 'u-1', banned: false },
      { updateFails: true },
    );

    await strategy.validate({ sub: 'u-1', email: 'a@itc.edu' });
    await flush();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not record last_seen for u-1'),
    );
  });
});
