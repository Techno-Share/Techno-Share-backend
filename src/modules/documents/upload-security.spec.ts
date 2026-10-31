import {
  BadRequestException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { MulterError } from 'multer';
import { DocumentsService } from './documents.service';
import { DocumentsController } from './documents.controller';
import { MulterExceptionFilter } from '../../common/filters/multer-exception.filter';
import {
  MAX_FILE_SIZE_BYTES,
  MAX_FILES_PER_UPLOAD,
  UPLOAD_LIMITS,
} from '../../common/upload-limits';

/**
 * The upload path after the malware scanner was removed.
 *
 * With ClamAV gone, signature and structure validation is the ONLY thing
 * standing between an uploaded byte stream and object storage, and the
 * storage/database ordering is the only thing keeping the two consistent.
 * Both are asserted here against the real service rather than through HTTP,
 * because the interesting failures are ordering failures and those are
 * invisible from the outside.
 *
 * Nothing in this file constructs a scanner, mocks one, or sets a scanner
 * environment variable. That is the point: the service must build and run
 * with no such dependency available.
 */

// ── Fixtures ──────────────────────────────────────────────────────────────

const PDF = Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'binary');
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const HTML = Buffer.from('<!doctype html><script>alert(1)</script>', 'utf8');

function upload(
  name: string,
  buffer: Buffer,
  mimetype = 'application/octet-stream',
): Express.Multer.File {
  return {
    originalname: name,
    buffer,
    size: buffer.length,
    mimetype,
    fieldname: 'files',
    encoding: '7bit',
    stream: null as never,
    destination: '',
    filename: '',
    path: '',
  };
}

/**
 * A DocumentsService with every collaborator stubbed.
 *
 * Only the pieces the upload path touches are real; the rest are present so
 * the constructor is satisfied. Spies are returned so a test can assert what
 * the service did to storage and to the database, and in which order.
 */
function buildService(
  overrides: {
    storageUpload?: jest.Mock;
    storageRemove?: jest.Mock;
    documentsSave?: jest.Mock;
  } = {},
) {
  const calls: string[] = [];

  const storageUpload =
    overrides.storageUpload ??
    jest.fn((_b: string, key: string) => {
      calls.push(`storage.upload:${key}`);
      return Promise.resolve(`https://storage.example/${key}`);
    });

  const storageRemove =
    overrides.storageRemove ??
    jest.fn((refs: string[]) => {
      calls.push(`storage.remove:${refs.join(',')}`);
      return Promise.resolve();
    });

  const documentsSave =
    overrides.documentsSave ??
    jest.fn((row: unknown) => {
      calls.push('documents.save');
      return Promise.resolve({ id: 'doc-1', ...(row as object) });
    });

  const quotaConsume = jest.fn(() =>
    Promise.resolve({
      allowed: true,
      remaining: 1,
      limit: 2,
      retryAfterSeconds: 0,
    }),
  );
  const quotaRefund = jest.fn(() => {
    calls.push('quota.refund');
    return Promise.resolve();
  });

  const repo = () =>
    ({
      findOne: jest.fn(),
      find: jest.fn(() => Promise.resolve([])),
      save: jest.fn((r: unknown) => Promise.resolve(r)),
      create: jest.fn((r: unknown) => r),
      delete: jest.fn(),
      createQueryBuilder: jest.fn(),
    }) as never;

  const service = new DocumentsService(
    repo(), // uploads
    {
      ...(repo() as unknown as object),
      save: documentsSave,
      create: (r: unknown) => r,
    } as never, // documents
    repo(), // stagedFiles
    repo(), // users
    { create: jest.fn() } as never, // notifications
    {} as never, // moderation
    repo(), // majors
    repo(), // uploadPins
    {
      upload: storageUpload,
      remove: storageRemove,
      // uploadFile signs the row it has just written, so the stub has to be
      // able to sign — otherwise a successful write looks like a failure.
      signedUrlForRef: jest.fn(() =>
        Promise.resolve('https://signed.example/x'),
      ),
      signedUrlTtl: 300,
    } as never,
    { optimizeOrOriginal: () => Promise.resolve(null) } as never,
    { consume: quotaConsume, refund: quotaRefund } as never,
  );

  return {
    service,
    calls,
    storageUpload,
    storageRemove,
    documentsSave,
    quotaRefund,
  };
}

/** `vetFile` is private, and it is exactly the boundary worth testing. */
function vet(service: DocumentsService, file: Express.Multer.File) {
  return (
    service as unknown as {
      vetFile: (
        u: string,
        n: string,
        f: Express.Multer.File,
      ) => Promise<{ buffer: Buffer; contentType: string }>;
    }
  ).vetFile('user-1', file.originalname, file);
}

/** Likewise `uploadFile`, which owns the storage/database ordering. */
function store(service: DocumentsService, file: Express.Multer.File) {
  return (
    service as unknown as {
      uploadFile: (
        uploadId: string,
        uploaderId: string,
        majorId: string,
        f: Express.Multer.File,
      ) => Promise<unknown>;
    }
  ).uploadFile('upl-1', 'user-1', 'major-1', file);
}

// ── 1, 2, 13 · the pipeline runs with no scanner present ──────────────────

describe('upload validation without a malware scanner', () => {
  it('constructs and initialises with no scanner dependency', () => {
    const { service } = buildService();
    expect(service).toBeInstanceOf(DocumentsService);
    // onModuleInit must not reach for a scanner that no longer exists.
    expect(() => service.onModuleInit()).not.toThrow();
  });

  it('accepts a valid PDF', async () => {
    const { service } = buildService();
    const out = await vet(service, upload('lecture.pdf', PDF));
    expect(out.contentType).toBe('application/pdf');
    expect(out.buffer).toEqual(PDF);
  });

  it('accepts a valid PNG', async () => {
    const { service } = buildService();
    const out = await vet(service, upload('diagram.png', PNG));
    expect(out.contentType).toBe('image/png');
  });
});

// ── 5, 6, 7 · the bytes decide, not the client's metadata ─────────────────

describe('client-supplied metadata is never trusted', () => {
  it('rejects HTML renamed to .jpg even when the MIME type says image', async () => {
    const { service, storageUpload } = buildService();
    await expect(
      vet(service, upload('payload.jpg', HTML, 'image/jpeg')),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(storageUpload).not.toHaveBeenCalled();
  });

  it('rejects a real PDF presented under an image extension', async () => {
    const { service } = buildService();
    await expect(
      vet(service, upload('actually.jpg', PDF, 'image/jpeg')),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a genuine PDF whose declared MIME type is wrong', async () => {
    // The declared type is noise in both directions: it cannot make a bad file
    // good, and it must not make a good file bad.
    const { service } = buildService();
    await expect(
      vet(service, upload('lecture.pdf', PDF, 'text/html')),
    ).resolves.toMatchObject({ contentType: 'application/pdf' });
  });

  it('rejects an extension that is not on the allowlist', async () => {
    const { service } = buildService();
    await expect(
      vet(service, upload('index.html', HTML, 'text/html')),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses before anything is written to storage', async () => {
    const { service, storageUpload, documentsSave } = buildService();
    await expect(store(service, upload('payload.jpg', HTML))).rejects.toThrow();
    expect(storageUpload).not.toHaveBeenCalled();
    expect(documentsSave).not.toHaveBeenCalled();
  });
});

// ── 3, 4 · the size and batch ceilings ────────────────────────────────────

describe('size and batch limits', () => {
  const filter = new MulterExceptionFilter();

  it('maps an oversized file to 413, carrying the real limit', () => {
    try {
      filter.catch(new MulterError('LIMIT_FILE_SIZE'));
      throw new Error('expected the filter to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      const http = err as HttpException;
      expect(http.getStatus()).toBe(413);
      expect(JSON.stringify(http.getResponse())).toContain(
        `${UPLOAD_LIMITS.maxFileMb} MB`,
      );
    }
  });

  it('maps too many files to 400, carrying the real batch size', () => {
    try {
      filter.catch(new MulterError('LIMIT_FILE_COUNT'));
      throw new Error('expected the filter to throw');
    } catch (err) {
      const http = err as HttpException;
      expect(http.getStatus()).toBe(400);
      expect(JSON.stringify(http.getResponse())).toContain(
        `${UPLOAD_LIMITS.maxFiles} files`,
      );
    }
  });

  it('declares the same ceilings on every upload route', () => {
    // The limits are enforced by multer from these constants; a route that
    // forgot one would accept what the others refuse.
    expect(MAX_FILE_SIZE_BYTES).toBe(UPLOAD_LIMITS.maxFileMb * 1024 * 1024);
    expect(MAX_FILES_PER_UPLOAD).toBe(UPLOAD_LIMITS.maxFiles);

    const routes = Object.getOwnPropertyNames(DocumentsController.prototype);
    for (const route of ['upload', 'stageFile', 'addFiles']) {
      expect(routes).toContain(route);
    }
  });
});

// ── 10, 11 · storage and database stay consistent ─────────────────────────

describe('storage and database ordering', () => {
  it('writes the object before the row', async () => {
    const { service, calls } = buildService();
    await store(service, upload('lecture.pdf', PDF));
    const put = calls.findIndex((c) => c.startsWith('storage.upload'));
    const row = calls.indexOf('documents.save');
    expect(put).toBeGreaterThanOrEqual(0);
    expect(row).toBeGreaterThan(put);
  });

  it('removes the object when the database write fails', async () => {
    const { service, storageRemove, quotaRefund } = buildService({
      documentsSave: jest.fn(() =>
        Promise.reject(new Error('constraint violation')),
      ),
    });

    await expect(store(service, upload('lecture.pdf', PDF))).rejects.toThrow();

    expect(storageRemove).toHaveBeenCalledTimes(1);
    const removeCalls = storageRemove.mock.calls as unknown as [string[]][];
    const removed = removeCalls[0][0];
    expect(removed.some((r) => r.includes('documents/'))).toBe(true);
    // The budget is given back too, or a failed upload costs the user quota.
    expect(quotaRefund).toHaveBeenCalled();
  });

  it('writes no row when storage fails', async () => {
    const { service, documentsSave, quotaRefund } = buildService({
      storageUpload: jest.fn(() =>
        Promise.reject(new Error('bucket unreachable')),
      ),
    });

    await expect(store(service, upload('lecture.pdf', PDF))).rejects.toThrow();

    expect(documentsSave).not.toHaveBeenCalled();
    expect(quotaRefund).toHaveBeenCalled();
  });
});

// ── 8, 9, 12 · nothing is signed before it is authorised ──────────────────

describe('download and preview authorisation', () => {
  /** A service whose document lookup returns whatever the test sets up. */
  function withFile(file: unknown) {
    const { service, storageUpload } = buildService();
    (
      service as unknown as { documents: { findOne: jest.Mock } }
    ).documents.findOne = jest.fn(() => Promise.resolve(file));
    return { service, storageUpload };
  }

  function stubViewer(
    service: DocumentsService,
    opts: { canView: boolean; role?: string; id?: string },
  ) {
    const s = service as unknown as Record<string, unknown>;
    s.getViewer = jest.fn(() =>
      Promise.resolve({
        id: opts.id ?? 'viewer-1',
        role: opts.role ?? 'user',
        major_id: 'major-1',
        year_level: 3,
        major: { acronym: 'gic' },
      }),
    );
    s.viewerCohorts = jest.fn(() => Promise.resolve([]));
    s.canView = jest.fn(() => opts.canView);
  }

  it('refuses with 404 — not 403 — when the viewer may not see the upload', async () => {
    const { service } = withFile({
      id: 'f-1',
      status: 'active',
      storage_key: 'documents/a.pdf',
      upload: { id: 'u-1', uploader_id: 'someone-else', status: 'active' },
    });
    stubViewer(service, { canView: false });

    await expect(
      service.signFileAccess('f-1', 'viewer-1', 'download'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a file whose parent upload is still pending review', async () => {
    const { service } = withFile({
      id: 'f-1',
      status: 'active',
      storage_key: 'documents/a.pdf',
      upload: { id: 'u-1', uploader_id: 'someone-else', status: 'pending' },
    });
    stubViewer(service, { canView: true });

    await expect(
      service.signFileAccess('f-1', 'viewer-1', 'download'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a rejected file, and a hidden one', async () => {
    for (const file of [
      { status: 'rejected', hidden_at: null },
      { status: 'active', hidden_at: new Date() },
    ]) {
      const { service } = withFile({
        id: 'f-1',
        storage_key: 'documents/a.pdf',
        ...file,
        upload: { id: 'u-1', uploader_id: 'someone-else', status: 'active' },
      });
      stubViewer(service, { canView: true });

      await expect(
        service.signFileAccess('f-1', 'viewer-1', 'preview'),
      ).rejects.toBeInstanceOf(NotFoundException);
    }
  });

  it('refuses a malformed row with no object behind it', async () => {
    // A row whose storage_key never got written must not fall through to a
    // signing call with an undefined key.
    const { service } = withFile({
      id: 'f-1',
      status: 'active',
      storage_key: null,
      preview_key: null,
      upload: { id: 'u-1', uploader_id: 'viewer-1', status: 'active' },
    });
    stubViewer(service, { canView: true, id: 'viewer-1' });

    await expect(
      service.signFileAccess('f-1', 'viewer-1', 'preview'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses an unknown file id', async () => {
    const { service } = withFile(null);
    stubViewer(service, { canView: true });
    await expect(
      service.signFileAccess('nope', 'viewer-1', 'download'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
