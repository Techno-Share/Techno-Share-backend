import { AdminService } from './admin.service';
import { REJECTED_FILE_RETENTION_MS } from '../../common/retention';

/**
 * The sweep that finally deletes a rejected upload's files.
 *
 * Rejection keeps the bytes for a retention window so a decision can be
 * questioned; this is what makes it real afterwards. Three things matter and
 * none of them are visible by reading the happy path:
 *
 *  - rows are CLAIMED before anything is deleted, because production runs two
 *    backend replicas and both fire the same cron;
 *  - a storage failure RELEASES the claim, or those objects are abandoned in
 *    the bucket with nothing left pointing at them;
 *  - the cutoff is the retention window, not "everything rejected".
 *
 * Driven through a fake repository rather than a database: what is under test
 * is the order of operations, which a real Postgres would not make any clearer.
 */
type Claimed = { id: string };

interface Probe {
  uploads: unknown;
  documents: unknown;
  storage: unknown;
  purgeRejectedUploads(now?: Date): Promise<{ purged: number; files: number }>;
}

/** Records every where-clause parameter the claim UPDATE was built with. */
function makeService(options: {
  claims: Claimed[];
  files?: { file_url: string }[];
  removeFails?: boolean;
}) {
  const calls = {
    params: {} as Record<string, unknown>,
    setTo: [] as unknown[],
    removed: [] as (string | null | undefined)[][],
    released: [] as unknown[],
  };

  const qb = {
    update: () => qb,
    set: (values: unknown) => {
      calls.setTo.push(values);
      return qb;
    },
    where: (_sql: string, params?: Record<string, unknown>) => {
      Object.assign(calls.params, params ?? {});
      return qb;
    },
    andWhere: (_sql: string, params?: Record<string, unknown>) => {
      Object.assign(calls.params, params ?? {});
      return qb;
    },
    returning: () => qb,
    execute: () => Promise.resolve({ raw: options.claims }),
  };

  const service = Object.create(AdminService.prototype) as unknown as Probe;
  service.uploads = {
    createQueryBuilder: () => qb,
    update: (_criteria: unknown, values: unknown) => {
      calls.released.push(values);
      return Promise.resolve({});
    },
  };
  service.documents = {
    find: () => Promise.resolve(options.files ?? []),
  };
  service.storage = {
    extractKey: (url: string) => url.replace('https://store/bucket/', ''),
    remove: (keys: (string | null | undefined)[]) => {
      calls.removed.push(keys);
      return options.removeFails
        ? Promise.reject(new Error('storage unreachable'))
        : Promise.resolve();
    },
  };

  return { service, calls };
}

const fileAt = (key: string) => ({ file_url: `https://store/bucket/${key}` });

describe('purging rejected uploads after the retention window', () => {
  it('deletes nothing when no upload is old enough', async () => {
    const { service, calls } = makeService({ claims: [] });

    await expect(service.purgeRejectedUploads()).resolves.toEqual({
      purged: 0,
      files: 0,
    });
    expect(calls.removed).toHaveLength(0);
  });

  it('deletes the files of every claimed upload', async () => {
    const { service, calls } = makeService({
      claims: [{ id: 'up-1' }, { id: 'up-2' }],
      files: [fileAt('a.pdf'), fileAt('b.png')],
    });

    await expect(service.purgeRejectedUploads()).resolves.toEqual({
      purged: 2,
      files: 2,
    });
    expect(calls.removed).toEqual([['a.pdf', 'b.png']]);
  });

  it('claims rows by stamping files_purged_at before deleting anything', async () => {
    const now = new Date('2026-06-01T12:00:00.000Z');
    const { service, calls } = makeService({
      claims: [{ id: 'up-1' }],
      files: [fileAt('a.pdf')],
    });

    await service.purgeRejectedUploads(now);

    // The stamp is the lock: the other replica's identical UPDATE matches
    // nothing once this one has committed.
    expect(calls.setTo).toEqual([{ files_purged_at: now }]);
  });

  it('only claims uploads rejected longer ago than the window', async () => {
    const now = new Date('2026-06-01T12:00:00.000Z');
    const { service, calls } = makeService({ claims: [] });

    await service.purgeRejectedUploads(now);

    expect(calls.params.rejected).toBe('rejected');
    expect((calls.params.cutoff as Date).getTime()).toBe(
      now.getTime() - REJECTED_FILE_RETENTION_MS,
    );
  });

  it('releases the claim when storage refuses, so the next sweep retries', async () => {
    const { service, calls } = makeService({
      claims: [{ id: 'up-1' }],
      files: [fileAt('a.pdf')],
      removeFails: true,
    });

    await expect(service.purgeRejectedUploads()).rejects.toThrow(
      'storage unreachable',
    );
    expect(calls.released).toEqual([{ files_purged_at: null }]);
  });

  it('skips the storage call when a claimed upload has no files left', async () => {
    const { service, calls } = makeService({
      claims: [{ id: 'up-1' }],
      files: [],
    });

    await expect(service.purgeRejectedUploads()).resolves.toEqual({
      purged: 1,
      files: 0,
    });
    expect(calls.removed).toHaveLength(0);
  });
});
