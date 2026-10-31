import {
  detectKind,
  isProcessableImage,
  validateFileContent,
} from './file-signature';

/**
 * These tests are the security boundary for "is this file what it says it is".
 *
 * Since malware scanning was removed, they are also the ONLY thing standing
 * between an uploaded byte stream and object storage — so the negative cases
 * carry more weight than they used to, and the positive ones use genuine
 * archives rather than bare signatures.
 */

// ── Fixtures ──────────────────────────────────────────────────────────────

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const PDF = Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'binary');
const RAR5 = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);

/**
 * A real OLE2 header: signature, then the sector shift the format requires.
 * 9 means 512-byte sectors, which is what every legacy Office file uses.
 */
function makeOle(sectorShift = 9): Buffer {
  const b = Buffer.alloc(64);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(b, 0);
  b.writeUInt16LE(0xfffe, 0x1c); // byte-order mark
  b.writeUInt16LE(sectorShift, 0x1e);
  return b;
}

/**
 * Build a genuine, uncompressed ZIP — local headers, central directory and
 * end-of-central-directory record. Nothing here is compressed, so a fixture
 * cannot accidentally become a zip bomb.
 */
function makeZip(entries: { name: string; data: string }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data, 'utf8');

    const local = Buffer.alloc(30 + name.length + data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 8); // stored, no compression
    local.writeUInt32LE(0, 14); // crc — not checked by the validator
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    data.copy(local, 30 + name.length);
    locals.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length;
  }

  const body = Buffer.concat(locals);
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(body.length, 16);

  return Buffer.concat([body, directory, eocd]);
}

/** An Open Packaging Convention package — what a real .docx/.pptx is. */
const OOXML = makeZip([
  { name: '[Content_Types].xml', data: '<Types/>' },
  { name: 'word/document.xml', data: '<document/>' },
]);

/** A genuine archive that is not an Office document. */
const PLAIN_ZIP = makeZip([{ name: 'lecture-notes.txt', data: 'hello' }]);

/** The signature and nothing behind it — the case a header check alone misses. */
const BARE_ZIP_HEADER = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.alloc(512, 0x41),
]);

/** PK\x05\x06 on its own: a valid *empty* archive, carrying no document. */
const EMPTY_ZIP = Buffer.alloc(22);
EMPTY_ZIP.writeUInt32LE(0x06054b50, 0);

const HTML = Buffer.from('<!doctype html><script>alert(1)</script>', 'utf8');
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  'utf8',
);
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);

// ── Signature detection ───────────────────────────────────────────────────

describe('detectKind', () => {
  it.each([
    ['JPEG', JPEG, 'jpeg'],
    ['PNG', PNG, 'png'],
    ['PDF', PDF, 'pdf'],
    ['ZIP', OOXML, 'zip'],
    ['OLE2', makeOle(), 'ole'],
    ['RAR5', RAR5, 'rar'],
  ])('recognises %s', (_label, buffer, expected) => {
    expect(detectKind(buffer).kind).toBe(expected);
  });

  it('returns null for content with no known signature', () => {
    expect(detectKind(HTML).kind).toBeNull();
    expect(detectKind(SVG).kind).toBeNull();
    expect(detectKind(ELF).kind).toBeNull();
  });

  it('returns null for a buffer too short to carry a signature', () => {
    expect(detectKind(Buffer.from([0xff])).kind).toBeNull();
    expect(detectKind(Buffer.alloc(0)).kind).toBeNull();
  });

  it('no longer treats an empty-archive record as an uploadable ZIP', () => {
    expect(detectKind(EMPTY_ZIP).kind).toBeNull();
  });
});

// ── Accepting genuine files ───────────────────────────────────────────────

describe('validateFileContent — accepts genuine files', () => {
  it.each([
    ['photo.jpg', JPEG],
    ['photo.jpeg', JPEG],
    ['diagram.png', PNG],
    ['lecture.pdf', PDF],
    ['slides.pptx', OOXML],
    ['report.docx', OOXML],
    ['archive.zip', PLAIN_ZIP],
    ['archive.rar', RAR5],
  ])('accepts %s', (name, buffer) => {
    expect(validateFileContent(name, buffer).ok).toBe(true);
  });

  it('accepts a legacy OLE2 .doc with a valid sector size', () => {
    expect(validateFileContent('legacy.doc', makeOle()).ok).toBe(true);
    expect(validateFileContent('legacy.ppt', makeOle(12)).ok).toBe(true);
  });

  it('accepts a modern document renamed to its legacy extension', () => {
    // Still a valid OOXML package, just under its legacy extension — which
    // is the only reason the office extensions admit a ZIP at all.
    expect(validateFileContent('report.doc', OOXML).ok).toBe(true);
  });

  it('is case-insensitive about the extension', () => {
    expect(validateFileContent('PHOTO.JPG', JPEG).ok).toBe(true);
    expect(validateFileContent('Report.DOCX', OOXML).ok).toBe(true);
  });
});

// ── Rejecting disguised files ─────────────────────────────────────────────

describe('validateFileContent — rejects disguised files', () => {
  it('rejects HTML renamed to .jpg — the stored-XSS case', () => {
    const out = validateFileContent('payload.jpg', HTML);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('undetectable');
  });

  it('rejects SVG renamed to .png — active content with an inert name', () => {
    expect(validateFileContent('payload.png', SVG).ok).toBe(false);
  });

  it('rejects an ELF executable with an allowed extension', () => {
    expect(validateFileContent('setup.pdf', ELF).ok).toBe(false);
  });

  it('rejects a PDF renamed to .jpg — real file, wrong extension', () => {
    const out = validateFileContent('actually.jpg', PDF);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('mismatch');
  });

  it('rejects a JPEG renamed to .pdf', () => {
    expect(validateFileContent('actually.pdf', JPEG).ok).toBe(false);
  });

  it('does not let a ZIP masquerade as a PNG', () => {
    const out = validateFileContent('sneaky.png', OOXML);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('mismatch');
  });

  it('rejects an extension that is not on the allowlist', () => {
    expect(validateFileContent('script.html', HTML).ok).toBe(false);
    expect(validateFileContent('drawing.svg', SVG).ok).toBe(false);
    expect(validateFileContent('tool.exe', ELF).ok).toBe(false);
    expect(validateFileContent('sheet.xlsx', OOXML).reason).toBe(
      'unknown-extension',
    );
  });

  it('rejects a file with no extension at all', () => {
    expect(validateFileContent('README', PDF).ok).toBe(false);
  });

  it('rejects an empty buffer', () => {
    const out = validateFileContent('empty.pdf', Buffer.alloc(0));
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('empty');
  });
});

// ── Structure, not just the first four bytes ──────────────────────────────

describe('validateFileContent — container structure', () => {
  it('rejects a ZIP signature with junk behind it', () => {
    const out = validateFileContent('archive.zip', BARE_ZIP_HEADER);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('malformed-archive');
  });

  it('rejects a real archive that is not an Office package as .docx', () => {
    const out = validateFileContent('report.docx', PLAIN_ZIP);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('not-an-office-document');
  });

  it('applies the same rule to .pptx and to a renamed .doc', () => {
    expect(validateFileContent('slides.pptx', PLAIN_ZIP).reason).toBe(
      'not-an-office-document',
    );
    expect(validateFileContent('report.doc', PLAIN_ZIP).reason).toBe(
      'not-an-office-document',
    );
  });

  it('rejects an OLE2 header with an impossible sector size', () => {
    const out = validateFileContent('legacy.doc', makeOle(7));
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('malformed-archive');
  });

  it('does not walk an absurd entry count declared by a crafted archive', () => {
    // A central directory claiming 65535 entries that are not there must fail
    // fast rather than scanning to the end of the buffer.
    const forged = Buffer.from(OOXML);
    forged.writeUInt16LE(0xffff, forged.length - 22 + 10);
    const started = Date.now();
    expect(validateFileContent('report.docx', forged).ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('isProcessableImage', () => {
  it('is true only for the two formats the image pipeline handles', () => {
    expect(isProcessableImage('jpeg')).toBe(true);
    expect(isProcessableImage('png')).toBe(true);
    expect(isProcessableImage('pdf')).toBe(false);
    expect(isProcessableImage('zip')).toBe(false);
    expect(isProcessableImage(null)).toBe(false);
  });
});
