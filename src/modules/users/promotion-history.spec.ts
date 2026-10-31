import { Logger } from '@nestjs/common';
import { UsersService } from './users.service';
import type { User } from './entities/user.entity';

/**
 * What gets written to the promotion log, and what must not.
 *
 * The log exists to be shown to the student, so the invariant that matters is
 * that it agrees with what they were told: a row exists exactly when `getMe`
 * reported `promoted_to_year`. A row for a promotion the student was never
 * told about would appear in their history out of nowhere; a missing row would
 * leave the notice announcing a promotion the history denies.
 *
 * The service is built by hand rather than through a Nest testing module —
 * `applyPendingPromotion` is reached through `getMe`, and the only
 * collaborators it touches are the two repositories and the schedule.
 */

const ROLLOVER = new Date('2026-07-01T00:00:00Z');
const ACCOUNT_CREATED = new Date('2024-09-01T00:00:00Z');

type Captured = {
  values: Record<string, unknown>[];
  /** Set when the insert is told to swallow a unique-key conflict. */
  ignored: boolean;
};

function build(
  user: Partial<User>,
  options: { insertFails?: boolean; rolloverAt?: Date | null } = {},
) {
  const captured: Captured = { values: [], ignored: false };
  const row = {
    id: 'u1',
    year_level: null,
    major_id: null,
    major: null,
    promoted_rollover_at: null,
    created_at: ACCOUNT_CREATED,
    telegram_handles: [],
    ...user,
  } as unknown as User;

  const users = {
    findOne: jest.fn().mockResolvedValue(row),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };

  const insertBuilder = {
    insert: () => insertBuilder,
    values: (v: Record<string, unknown>) => {
      captured.values.push(v);
      return insertBuilder;
    },
    orIgnore: () => {
      captured.ignored = true;
      return insertBuilder;
    },
    execute: () =>
      options.insertFails
        ? Promise.reject(
            new Error('duplicate key value violates unique constraint'),
          )
        : Promise.resolve({ identifiers: [] }),
  };

  const promotions = {
    createQueryBuilder: jest.fn(() => insertBuilder),
    find: jest.fn().mockResolvedValue([]),
  };

  const service = new UsersService(
    users as never,
    promotions as never,
    { countBy: jest.fn().mockResolvedValue(0) } as never,
    {} as never,
    {
      rolloverAt: jest
        .fn()
        .mockResolvedValue(
          options.rolloverAt === undefined ? ROLLOVER : options.rolloverAt,
        ),
    } as never,
  );

  return { service, captured, users, promotions, row };
}

describe('promotion history', () => {
  beforeEach(() =>
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {}),
  );
  afterEach(() => jest.restoreAllMocks());

  it('records a promotion that moved the student', async () => {
    const { service, captured } = build({
      year_level: 3,
      major_id: 'm-gic',
      major: { acronym: 'GIC' } as never,
    });

    const me = await service.getMe('u1');

    expect(me.promoted_to_year).toBe(4);
    expect(captured.values).toHaveLength(1);
    expect(captured.values[0]).toMatchObject({
      user_id: 'u1',
      from_year: 3,
      to_year: 4,
      major_id: 'm-gic',
      rollover_at: ROLLOVER,
    });
  });

  /**
   * The row is dated by the scheduled rollover, not by the visit that collected
   * it. The advance is lazy, so a student who was away for a fortnight would
   * otherwise see the promotion dated to the day they came back.
   */
  it('dates the row by the rollover, not by now', async () => {
    const { service, captured } = build({
      year_level: 1,
      major_id: 'm-tc',
      major: { acronym: 'TC' } as never,
    });

    await service.getMe('u1');

    expect(captured.values[0].rollover_at).toBe(ROLLOVER);
  });

  /**
   * A year 5 student is stamped as having received the rollover without
   * moving — `advanceYearLevel` caps there. They are told nothing, so there
   * must be nothing in their history either.
   */
  it('writes no row for a capped advance', async () => {
    const { service, captured } = build({
      year_level: 5,
      major_id: 'm-gic',
      major: { acronym: 'GIC' } as never,
    });

    const me = await service.getMe('u1');

    expect(me.promoted_to_year).toBeNull();
    expect(captured.values).toHaveLength(0);
  });

  /**
   * Foundation year 2 is asked which department they joined instead of being
   * advanced, so there is no promotion yet to record.
   */
  it('writes no row for a Foundation year 2 student awaiting a department', async () => {
    const { service, captured } = build({
      year_level: 2,
      major_id: 'm-tc',
      major: { acronym: 'TC' } as never,
    });

    const me = await service.getMe('u1');

    expect(me.needs_department_choice).toBe(true);
    expect(me.promoted_to_year).toBeNull();
    expect(captured.values).toHaveLength(0);
  });

  it('writes no row when no rollover is scheduled', async () => {
    const { service, captured } = build(
      { year_level: 3, major_id: 'm-gic', major: { acronym: 'GIC' } as never },
      { rolloverAt: null },
    );

    const me = await service.getMe('u1');

    expect(me.promoted_to_year).toBeNull();
    expect(captured.values).toHaveLength(0);
  });

  /**
   * The promotion is committed before the log row is attempted, so a failed
   * insert must cost the row and not the student's session — `getMe` is the
   * call the whole app waits on before it renders anything.
   */
  it('still returns the profile when the log write fails', async () => {
    const { service } = build(
      { year_level: 3, major_id: 'm-gic', major: { acronym: 'GIC' } as never },
      { insertFails: true },
    );

    await expect(service.getMe('u1')).resolves.toMatchObject({
      promoted_to_year: 4,
    });
  });

  /**
   * Two `getMe` calls can be in flight at once — two tabs, or the two replicas
   * behind the load balancer — and both see the rollover as due. The unique key
   * on (user_id, rollover_at) decides which one records it, which only works if
   * the insert actually asks to ignore the conflict.
   */
  it('inserts with conflicts ignored, so a concurrent call cannot double-record', async () => {
    const { service, captured } = build({
      year_level: 3,
      major_id: 'm-gic',
      major: { acronym: 'GIC' } as never,
    });

    await service.getMe('u1');

    expect(captured.ignored).toBe(true);
  });

  /**
   * The department is captured per event because the profile only holds the
   * current one: this promotion happened while the student was still in
   * Foundation, and reading `major_id` back after they join GIC would relabel
   * it as a GIC promotion.
   */
  it('records the department the promotion happened in', async () => {
    const { service, captured } = build({
      year_level: 1,
      major_id: 'm-tc',
      major: { acronym: 'TC' } as never,
    });

    await service.getMe('u1');

    expect(captured.values[0].major_id).toBe('m-tc');
    expect(captured.values[0].to_year).toBe(2);
  });
});
