import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { AdminService } from './admin.service';
import {
  ListDocumentsDto,
  ListSubjectsDto,
  ListUsersDto,
} from './dto/list-admin.dto';

/**
 * Server-side pagination for the three admin tables.
 *
 * These tables used to fetch every row and page over them in the browser, so
 * the defect being guarded against is not "the wrong rows came back" — it is
 * the endpoint quietly going back to loading the whole table. That is invisible
 * in the UI, which looks identical either way, and only shows up as a slow
 * dashboard once the institute has real data.
 *
 * Driven through fake repositories rather than a database: what is under test
 * is which query the service BUILDS — that it bounds the window, counts the
 * filtered set, and never lets a client string reach the ORDER BY — and a real
 * Postgres would not make any of that clearer.
 */

interface Probe {
  users: unknown;
  uploads: unknown;
  subjects: unknown;
  moderation: unknown;
  bans: unknown;
  storage: unknown;
  getAllUsers(query?: ListUsersDto): Promise<{
    items: unknown[];
    total: number;
    page: number;
    limit: number;
  }>;
  getAllSubjects(query?: ListSubjectsDto): Promise<{
    items: unknown[];
    total: number;
    page: number;
    limit: number;
  }>;
  getAllDocuments(query?: ListDocumentsDto): Promise<{
    items: unknown[];
    total: number;
    page: number;
    limit: number;
  }>;
}

/** Everything the service asked the query builder for. */
interface Recorded {
  skip: number | null;
  take: number | null;
  orderBy: [string, string][];
  where: string[];
  params: Record<string, unknown>;
  /** True when the rows were read through getManyAndCount, not getMany. */
  countedWithPage: boolean;
  /** True when the whole table was asked for — the regression being guarded. */
  fetchedEverything: boolean;
}

function makeQueryBuilder(rows: unknown[], total: number) {
  const seen: Recorded = {
    skip: null,
    take: null,
    orderBy: [],
    where: [],
    params: {},
    countedWithPage: false,
    fetchedEverything: false,
  };

  const qb = {
    leftJoinAndSelect: () => qb,
    where: (sql: string, params?: Record<string, unknown>) => {
      seen.where.push(sql);
      Object.assign(seen.params, params ?? {});
      return qb;
    },
    andWhere: (sql: string, params?: Record<string, unknown>) => {
      seen.where.push(sql);
      Object.assign(seen.params, params ?? {});
      return qb;
    },
    orderBy: (column: string, direction: string) => {
      seen.orderBy = [[column, direction]];
      return qb;
    },
    addOrderBy: (column: string, direction: string) => {
      seen.orderBy.push([column, direction]);
      return qb;
    },
    skip: (n: number) => {
      seen.skip = n;
      return qb;
    },
    take: (n: number) => {
      seen.take = n;
      return qb;
    },
    getManyAndCount: () => {
      seen.countedWithPage = true;
      return Promise.resolve([rows, total] as [unknown[], number]);
    },
    getMany: () => {
      seen.fetchedEverything = true;
      return Promise.resolve(rows);
    },
  };

  return { qb, seen };
}

function makeService(rows: unknown[] = [], total = rows.length) {
  const { qb, seen } = makeQueryBuilder(rows, total);
  const repo = { createQueryBuilder: () => qb };

  const service = Object.create(AdminService.prototype) as unknown as Probe;
  service.users = repo;
  service.uploads = repo;
  service.subjects = repo;
  // Both are batch lookups keyed by the ids on the page; empty is enough here.
  service.moderation = { assignmentsByUser: () => Promise.resolve(new Map()) };
  service.bans = { activeBansFor: () => Promise.resolve(new Map()) };
  service.storage = { signedUrlForRef: () => Promise.resolve(null) };

  return { service, seen };
}

const user = (id: string) => ({
  id,
  first_name: 'A',
  last_name: 'B',
  major: null,
});
const subject = (id: string) => ({
  id,
  name: 'Maths',
  major: null,
  submitter: null,
});

describe('admin list pagination', () => {
  describe('the window sent to Postgres', () => {
    it('asks for only the requested page', async () => {
      const { service, seen } = makeService([user('u-1')], 97);

      const result = await service.getAllUsers({ page: 3, limit: 20 });

      expect(seen.skip).toBe(40); // (3 - 1) * 20
      expect(seen.take).toBe(20);
      expect(result).toMatchObject({ total: 97, page: 3, limit: 20 });
    });

    it('defaults to page 1 at the default size when neither is given', async () => {
      const { service, seen } = makeService([user('u-1')], 1);

      const result = await service.getAllUsers();

      expect(seen.skip).toBe(0);
      expect(seen.take).toBe(10);
      expect(result).toMatchObject({ page: 1, limit: 10 });
    });

    /**
     * The point of the whole change. A paginated endpoint that reaches for
     * getMany() is back to loading the table, which no test of the returned
     * rows would notice.
     */
    it.each([
      ['users', (s: Probe) => s.getAllUsers({ page: 2, limit: 5 })],
      ['subjects', (s: Probe) => s.getAllSubjects({ page: 2, limit: 5 })],
      ['documents', (s: Probe) => s.getAllDocuments({ page: 2, limit: 5 })],
    ])(
      'never loads the whole table to paginate it (%s)',
      async (_name, call) => {
        const { service, seen } = makeService([], 0);

        await call(service);

        expect(seen.fetchedEverything).toBe(false);
        expect(seen.countedWithPage).toBe(true);
        expect(seen.take).toBe(5);
      },
    );

    it('reports the filtered total, not the table size', async () => {
      // Three rows on the page, nine matching the search overall.
      const { service } = makeService([user('a'), user('b'), user('c')], 9);

      const result = await service.getAllUsers({ search: 'sok', limit: 3 });

      expect(result.total).toBe(9);
      expect(result.items).toHaveLength(3);
    });

    it('returns empty metadata rather than nothing when a search matches none', async () => {
      const { service } = makeService([], 0);

      const result = await service.getAllUsers({ search: 'nobody', page: 1 });

      expect(result).toEqual({ items: [], total: 0, page: 1, limit: 10 });
    });
  });

  describe('search', () => {
    it('binds the term as a parameter rather than inlining it', async () => {
      const { service, seen } = makeService();

      await service.getAllUsers({ search: "'; drop table users; --" });

      expect(seen.params.s).toBe("%'; drop table users; --%");
      // The clause mentions the placeholder, never the value.
      expect(seen.where.join(' ')).toContain(':s');
      expect(seen.where.join(' ')).not.toContain('drop table');
    });

    it('adds no search clause when the term is absent', async () => {
      const { service, seen } = makeService();

      await service.getAllUsers({ page: 1 });

      expect(seen.where.join(' ')).not.toContain('ILIKE');
    });
  });

  describe('sorting', () => {
    it('orders by the whitelisted column, with a stable tie-break', async () => {
      const { service, seen } = makeService();

      await service.getAllUsers({ sortBy: 'email', order: 'ASC' });

      expect(seen.orderBy).toEqual([
        ['u.email', 'ASC'],
        ['u.id', 'DESC'],
      ]);
    });

    it('falls back to the default column when sortBy is absent', async () => {
      const { service, seen } = makeService();

      await service.getAllUsers({});

      expect(seen.orderBy[0]).toEqual(['u.created_at', 'DESC']);
    });

    /**
     * Belt and braces. The DTO rejects an unknown field before the service is
     * reached, but the column map is what guarantees a string can never be
     * concatenated into SQL even if it somehow arrives.
     */
    it('ignores a sort field that is not on the whitelist', async () => {
      const { service, seen } = makeService();

      await service.getAllUsers({
        sortBy: 'password_hash; drop table users' as never,
      });

      expect(seen.orderBy[0]).toEqual(['u.created_at', 'DESC']);
    });

    it('treats any order other than ASC as DESC', async () => {
      const { service, seen } = makeService();

      await service.getAllUsers({ order: 'sideways' as never });

      expect(seen.orderBy[0][1]).toBe('DESC');
    });
  });

  describe('user status filter', () => {
    it('selects banned accounts with EXISTS on the ban in force', async () => {
      const { service, seen } = makeService();

      await service.getAllUsers({ status: 'banned' });

      const sql = seen.where.join(' ');
      expect(sql).toContain('EXISTS');
      expect(sql).toContain('b.lifted_at IS NULL');
      expect(sql).not.toContain('NOT EXISTS');
    });

    it('selects unbanned accounts with NOT EXISTS', async () => {
      const { service, seen } = makeService();

      await service.getAllUsers({ status: 'active' });

      expect(seen.where.join(' ')).toContain('NOT EXISTS');
    });

    it('filters on neither when no status is given', async () => {
      const { service, seen } = makeService();

      await service.getAllUsers({});

      expect(seen.where.join(' ')).not.toContain('EXISTS');
    });
  });

  describe('document display status', () => {
    /**
     * These four are what the browser used to compute from each row. They must
     * stay mutually exclusive and keep their precedence — hidden beats
     * rejected, which beats expired — or rows move between tabs rather than
     * merely being paginated.
     */
    it('treats hidden as any upload with hidden_at set', async () => {
      const { service, seen } = makeService();

      await service.getAllDocuments({ status: 'hidden' });

      expect(seen.where.join(' ')).toContain('u.hidden_at IS NOT NULL');
    });

    it('excludes hidden uploads from the rejected view', async () => {
      const { service, seen } = makeService();

      await service.getAllDocuments({ status: 'rejected' });

      const sql = seen.where.join(' ');
      expect(sql).toContain('u.hidden_at IS NULL');
      expect(sql).toContain("u.status = 'rejected'");
    });

    it('treats expired as an active upload whose date has passed', async () => {
      const { service, seen } = makeService();

      await service.getAllDocuments({ status: 'expired' });

      const sql = seen.where.join(' ');
      expect(sql).toContain('u.expires_at <= now()');
      expect(sql).toContain("u.status <> 'rejected'");
    });

    it('defaults to active, excluding hidden and expired', async () => {
      const { service, seen } = makeService();

      await service.getAllDocuments({});

      const sql = seen.where.join(' ');
      expect(sql).toContain('u.hidden_at IS NULL');
      expect(sql).toContain('u.expires_at > now()');
    });

    it('never lists pending uploads, whichever view is asked for', async () => {
      for (const status of [
        'active',
        'rejected',
        'hidden',
        'expired',
      ] as const) {
        const { service, seen } = makeService();
        await service.getAllDocuments({ status });
        expect(seen.where.join(' ')).toContain("u.status <> 'pending'");
      }
    });
  });

  describe('subjects', () => {
    it('pages and keeps the active-only restriction', async () => {
      const { service, seen } = makeService([subject('s-1')], 31);

      const result = await service.getAllSubjects({ page: 2, limit: 15 });

      expect(seen.skip).toBe(15);
      expect(seen.take).toBe(15);
      expect(seen.params.active).toBe('active');
      expect(result).toMatchObject({ total: 31, page: 2, limit: 15 });
    });
  });
});

/**
 * The DTOs are the first gate: they run under the global ValidationPipe with
 * `whitelist` and `forbidNonWhitelisted`, so anything they accept is what the
 * service must cope with, and anything they reject never arrives.
 */
describe('admin list query validation', () => {
  const check = async (
    cls: new () => object,
    query: Record<string, unknown>,
  ) => {
    const dto = plainToInstance(cls, query, {
      enableImplicitConversion: false,
    });
    return validate(dto);
  };

  it('accepts a well-formed query', async () => {
    const errors = await check(ListUsersDto, {
      page: '2',
      limit: '20',
      search: 'sok',
      sortBy: 'email',
      order: 'ASC',
      status: 'banned',
    });
    expect(errors).toHaveLength(0);
  });

  it.each([
    ['page below 1', { page: '0' }],
    ['a negative page', { page: '-3' }],
    ['a non-numeric page', { page: 'two' }],
    ['limit below 1', { limit: '0' }],
    // The cap is what stops ?limit=100000 being a supported way to ask for
    // the whole table.
    ['limit above the cap', { limit: '1000' }],
  ])('rejects %s', async (_name, query) => {
    const errors = await check(ListUsersDto, query);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a sort field that is not whitelisted', async () => {
    const errors = await check(ListUsersDto, { sortBy: 'password_hash' });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('sortBy');
  });

  it('rejects an unknown sort direction', async () => {
    const errors = await check(ListUsersDto, { order: 'RANDOM' });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('order');
  });

  it('rejects a user status outside active/banned', async () => {
    const errors = await check(ListUsersDto, { status: 'deleted' });
    expect(errors).toHaveLength(1);
  });

  it("refuses 'pending' as a document view, which belongs to Approvals", async () => {
    const errors = await check(ListDocumentsDto, { status: 'pending' });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('status');
  });

  it('accepts all four document views', async () => {
    for (const status of ['active', 'rejected', 'hidden', 'expired']) {
      expect(await check(ListDocumentsDto, { status })).toHaveLength(0);
    }
  });

  it('rejects a malformed uuid filter', async () => {
    const errors = await check(ListDocumentsDto, { major_id: 'not-a-uuid' });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('major_id');
  });

  it('rejects an over-long search term', async () => {
    const errors = await check(ListSubjectsDto, { search: 'x'.repeat(201) });
    expect(errors).toHaveLength(1);
  });

  it('allows every field to be omitted', async () => {
    expect(await check(ListUsersDto, {})).toHaveLength(0);
    expect(await check(ListDocumentsDto, {})).toHaveLength(0);
    expect(await check(ListSubjectsDto, {})).toHaveLength(0);
  });

  /**
   * The promotions table is not a list of rows from one table at all.
   *
   * It groups promotion_events by the rollover an admin scheduled, and adds
   * the currently scheduled one even when it has promoted nobody yet — so it
   * is raw SQL with a CTE rather than a query builder, and none of the
   * assertions above reach it. The SQL itself was checked against Postgres;
   * what is pinned here is the window it asks for and the shape it returns.
   */
  describe('the promotions table', () => {
    function makeRolloverService(
      rows: {
        rollover_at: Date;
        promoted_users: string;
        eligible_users: string;
      }[],
      total = rows.length,
      scheduled: Date | null = null,
    ) {
      const calls: { sql: string; params: unknown[] }[] = [];
      const service = Object.create(AdminService.prototype) as unknown as {
        promotionEvents: unknown;
        promotionSettings: unknown;
        getAllPromotions(q?: Record<string, unknown>): Promise<{
          items: {
            rollover_at: Date;
            promoted_users: number;
            eligible_users: number;
          }[];
          total: number;
          page: number;
          limit: number;
        }>;
      };
      service.promotionEvents = {
        query: (sql: string, params: unknown[]) => {
          calls.push({ sql, params });
          return Promise.resolve(
            sql.includes('count(*) as n') ? [{ n: String(total) }] : rows,
          );
        },
      };
      service.promotionSettings = {
        rolloverAt: () => Promise.resolve(scheduled),
      };
      return { service, calls };
    }

    const AT = new Date('2026-07-01T00:00:00Z');
    const row = (promoted: string, eligible: string, at = AT) => ({
      rollover_at: at,
      promoted_users: promoted,
      eligible_users: eligible,
    });

    it('bounds the window to the requested page', async () => {
      const { service, calls } = makeRolloverService([row('1', '5')], 9);

      const result = await service.getAllPromotions({ page: 3, limit: 20 });

      const page = calls.find((c) => c.sql.includes('offset'))!;
      expect(page.params.slice(1)).toEqual([40, 20]); // (3 - 1) * 20, then the size
      expect(result).toMatchObject({ total: 9, page: 3, limit: 20 });
    });

    /** Newest first — the schedule most likely still rolling out. */
    it('orders by the scheduled instant, newest first', async () => {
      const { service, calls } = makeRolloverService([], 0);

      await service.getAllPromotions({});

      const page = calls.find((c) => c.sql.includes('offset'))!;
      expect(page.sql).toContain('order by r.rollover_at desc');
    });

    /**
     * Counts come back from Postgres as strings — `count()` is bigint, and
     * node-postgres will not narrow it to a JS number on its own. Left as they
     * arrive, "9" and "10" would sort and compare as text in the client.
     */
    it('returns the counts as numbers, not bigint strings', async () => {
      const { service } = makeRolloverService([row('3', '12')]);

      const { items } = await service.getAllPromotions({});

      expect(items[0].promoted_users).toBe(3);
      expect(items[0].eligible_users).toBe(12);
      expect(items[0].rollover_at).toBe(AT);
    });

    /**
     * The scheduled rollover is passed into the CTE so it can be listed even
     * before anybody has collected it — otherwise an admin who has just set a
     * date sees an empty table at exactly the moment they want to watch it.
     */
    it('passes the scheduled rollover to the query', async () => {
      const scheduled = new Date('2026-10-29T14:27:00Z');
      const { service, calls } = makeRolloverService([], 0, scheduled);

      await service.getAllPromotions({});

      expect(calls).toHaveLength(2); // the page and its count
      for (const call of calls) {
        expect(call.params[0]).toBe(scheduled);
        expect(call.sql).toContain('union');
      }
    });

    /** No schedule set is not an error — the union branch simply adds nothing. */
    it('copes with no rollover scheduled', async () => {
      const { service, calls } = makeRolloverService([], 0, null);

      const result = await service.getAllPromotions({});

      expect(result.items).toEqual([]);
      expect(calls[0].params[0]).toBeNull();
    });

    /** An empty result still reports a usable page, not NaN. */
    it('reports zero rather than NaN when nothing has been scheduled', async () => {
      const { service } = makeRolloverService([], 0);

      const result = await service.getAllPromotions({ page: 1, limit: 10 });

      expect(result.total).toBe(0);
    });
  });
});
