/**
 * What a file actually is, read from its bytes.
 *
 * `file.mimetype` is the Content-Type the CLIENT declared. Renaming
 * `payload.html` to `photo.jpg` and sending `Content-Type: image/jpeg` passes
 * that check and nothing else — which, with objects served from a storage
 * origin, is a stored-XSS primitive. Everything accepted here is confirmed
 * against its own signature instead.
 *
 * Hand-written rather than pulled from a library, deliberately: the allowlist
 * is eight fixed formats, `file-type`'s current major is ESM-only (awkward in a
 * CommonJS Nest build and in Jest), and its last CJS release is unmaintained.
 * Sixty lines of explicit, tested signature checks are easier to audit than a
 * dependency, and the tests below pin every branch.
 */

/** The families the platform accepts. */
export type DetectedKind =
  | 'pdf'
  | 'jpeg'
  | 'png'
  | 'zip' // also docx / pptx / xlsx — they are ZIP containers
  | 'ole' // legacy doc / ppt / xls — OLE2 compound files
  | 'rar';

export interface DetectionResult {
  kind: DetectedKind | null;
  /** A canonical MIME for the detected family, for logging and headers. */
  mime: string | null;
}

/** Magic numbers, longest-first where prefixes overlap. */
const SIGNATURES: {
  kind: DetectedKind;
  mime: string;
  offset: number;
  bytes: number[];
}[] = [
  // %PDF-
  {
    kind: 'pdf',
    mime: 'application/pdf',
    offset: 0,
    bytes: [0x25, 0x50, 0x44, 0x46, 0x2d],
  },
  // JPEG SOI + marker
  { kind: 'jpeg', mime: 'image/jpeg', offset: 0, bytes: [0xff, 0xd8, 0xff] },
  // \x89PNG\r\n\x1a\n
  {
    kind: 'png',
    mime: 'image/png',
    offset: 0,
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  // PK\x03\x04 — a ZIP local file header. docx/pptx/xlsx are ZIPs.
  {
    kind: 'zip',
    mime: 'application/zip',
    offset: 0,
    bytes: [0x50, 0x4b, 0x03, 0x04],
  },
  // Deliberately NOT matched here: PK\x05\x06 (an empty archive) and
  // PK\x07\x08 (a spanned one). Neither can carry a document, and admitting
  // them meant a zero-entry file passed as a .docx. A real archive begins
  // with a local file header, which is the case above.
  // OLE2 compound file — legacy .doc/.ppt/.xls
  {
    kind: 'ole',
    mime: 'application/msword',
    offset: 0,
    bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
  },
  // Rar!\x1a\x07\x00 (v1.5) and Rar!\x1a\x07\x01\x00 (v5)
  {
    kind: 'rar',
    mime: 'application/vnd.rar',
    offset: 0,
    bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00],
  },
  {
    kind: 'rar',
    mime: 'application/vnd.rar',
    offset: 0,
    bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00],
  },
];

/** Read a buffer's leading bytes and say what family it belongs to. */
export function detectKind(buffer: Buffer): DetectionResult {
  if (!buffer || buffer.length < 4) return { kind: null, mime: null };

  for (const sig of SIGNATURES) {
    const end = sig.offset + sig.bytes.length;
    if (buffer.length < end) continue;
    let match = true;
    for (let i = 0; i < sig.bytes.length; i++) {
      if (buffer[sig.offset + i] !== sig.bytes[i]) {
        match = false;
        break;
      }
    }
    if (match) return { kind: sig.kind, mime: sig.mime };
  }

  return { kind: null, mime: null };
}

/**
 * Which detected families each accepted extension may be.
 *
 * Keyed by extension rather than by declared MIME, because the extension is
 * what the rest of the system uses to pick an icon and a preview strategy — so
 * the name and the bytes have to agree, not just the bytes and a header the
 * client wrote.
 *
 * The Office formats are the subtle case: .docx/.pptx are ZIP containers, and
 * their legacy .doc/.ppt counterparts are OLE2. Both are allowed for those
 * extensions, and neither is allowed for, say, .png.
 */
const ALLOWED_BY_EXTENSION: Record<string, DetectedKind[]> = {
  pdf: ['pdf'],
  jpg: ['jpeg'],
  jpeg: ['jpeg'],
  png: ['png'],
  doc: ['ole', 'zip'],
  docx: ['zip'],
  ppt: ['ole', 'zip'],
  pptx: ['zip'],
  zip: ['zip'],
  rar: ['rar'],
};

/**
 * ── Structural validation for container formats ──────────────────────────
 *
 * A signature is four bytes. `PK\x03\x04` followed by a megabyte of anything
 * at all still "looks like" a ZIP, and .docx/.pptx are ZIPs — so for the
 * container formats the header alone proves almost nothing.
 *
 * These helpers open the archive far enough to prove it is really one: find
 * the End of Central Directory record, walk the central directory, and read
 * the entry names. That is enough to tell a real document from a header with
 * junk behind it, and enough to tell an OOXML package from an arbitrary ZIP.
 *
 * It is NOT a full ZIP implementation and does not decompress anything —
 * nothing here grows with the compressed content, so a zip bomb cannot be
 * detonated by validating it.
 */

/** ZIP record signatures, little-endian. */
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;

/** The EOCD sits in the last 22 bytes plus up to 64 KB of archive comment. */
const EOCD_MAX_SEARCH = 22 + 0xffff;

/**
 * Entries read before giving up.
 *
 * Bounded so a crafted central directory claiming millions of entries costs a
 * fixed amount of work. Every format we care about declares its content types
 * in the first handful of entries.
 */
const MAX_ENTRIES_SCANNED = 512;

/** Filenames in a ZIP central directory, or null when it is not a real archive. */
function readZipEntryNames(buffer: Buffer): string[] | null {
  // Walk back from the end looking for the EOCD signature.
  const from = Math.max(0, buffer.length - EOCD_MAX_SEARCH);
  let eocd = -1;
  for (let at = buffer.length - 22; at >= from; at--) {
    if (buffer.readUInt32LE(at) === EOCD_SIGNATURE) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) return null;

  const total = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (cdOffset >= buffer.length) return null;

  const names: string[] = [];
  let at = cdOffset;
  const limit = Math.min(total, MAX_ENTRIES_SCANNED);

  for (let i = 0; i < limit; i++) {
    if (at + 46 > buffer.length) return null;
    if (buffer.readUInt32LE(at) !== CENTRAL_FILE_SIGNATURE) return null;

    const nameLen = buffer.readUInt16LE(at + 28);
    const extraLen = buffer.readUInt16LE(at + 30);
    const commentLen = buffer.readUInt16LE(at + 32);
    const nameAt = at + 46;
    if (nameAt + nameLen > buffer.length) return null;

    names.push(buffer.toString('utf8', nameAt, nameAt + nameLen));
    at = nameAt + nameLen + extraLen + commentLen;
  }

  return names;
}

/**
 * True when the archive carries the part every OOXML package must have.
 *
 * `[Content_Types].xml` is mandatory in the Open Packaging Convention and sits
 * at the root of every .docx and .pptx. An archive without it is a ZIP someone
 * renamed, whatever its extension says.
 */
function looksLikeOoxml(names: string[]): boolean {
  return names.some((n) => n === '[Content_Types].xml');
}

/** OLE2 compound files declare a sector size the whole format depends on. */
function looksLikeOle(buffer: Buffer): boolean {
  // Byte order mark at 0x1c, then the sector shift at 0x1e. Real documents are
  // 512-byte (shift 9) or 4096-byte (shift 12) sectors; nothing else is valid.
  if (buffer.length < 0x20) return false;
  const shift = buffer.readUInt16LE(0x1e);
  return shift === 9 || shift === 12;
}

/** Extensions whose bytes must be an Open Packaging Convention archive. */
const OOXML_EXTENSIONS = new Set(['docx', 'pptx']);
/** Extensions the office pipeline converts, whether OLE2 or OOXML. */
const OFFICE_EXTENSIONS = new Set(['doc', 'docx', 'ppt', 'pptx']);

export interface ValidationOutcome {
  ok: boolean;
  kind: DetectedKind | null;
  detectedMime: string | null;
  /** Short machine-readable reason, for the security log. Never sent to the client. */
  reason?:
    | 'empty'
    | 'unknown-extension'
    | 'undetectable'
    | 'mismatch'
    | 'malformed-archive'
    | 'not-an-office-document';
}

/**
 * Confirm a buffer really is what its filename claims.
 *
 * Returns a structured outcome rather than throwing, so the caller can log the
 * specifics and still answer the client with one generic message.
 */
export function validateFileContent(
  originalName: string | null | undefined,
  buffer: Buffer,
): ValidationOutcome {
  if (!buffer || buffer.length === 0)
    return { ok: false, kind: null, detectedMime: null, reason: 'empty' };

  const ext = (originalName ?? '').split('.').pop()?.toLowerCase() ?? '';
  const allowed = ALLOWED_BY_EXTENSION[ext];
  if (!allowed)
    return {
      ok: false,
      kind: null,
      detectedMime: null,
      reason: 'unknown-extension',
    };

  const { kind, mime } = detectKind(buffer);
  if (!kind)
    return {
      ok: false,
      kind: null,
      detectedMime: null,
      reason: 'undetectable',
    };

  if (!allowed.includes(kind))
    return { ok: false, kind, detectedMime: mime, reason: 'mismatch' };

  // ── Beyond the signature ───────────────────────────────────────────────
  // The header matched. For container formats that is the easy half: prove
  // the bytes behind it are really the structure the extension promises.

  if (kind === 'zip') {
    const names = readZipEntryNames(buffer);
    if (!names)
      return {
        ok: false,
        kind,
        detectedMime: mime,
        reason: 'malformed-archive',
      };

    // .docx/.pptx must be OOXML packages. So must a .doc/.ppt that turned out
    // to be a ZIP — that is a renamed modern document, and the only reason the
    // office extensions admit ZIP at all.
    if (OOXML_EXTENSIONS.has(ext) || OFFICE_EXTENSIONS.has(ext)) {
      if (!looksLikeOoxml(names))
        return {
          ok: false,
          kind,
          detectedMime: mime,
          reason: 'not-an-office-document',
        };
    }
    // A plain .zip only has to be a real archive, which readZipEntryNames
    // has now established. Its contents are not inspected and are never
    // served inline — see DocumentsService.inlineSafe.
  }

  if (kind === 'ole' && !looksLikeOle(buffer))
    return { ok: false, kind, detectedMime: mime, reason: 'malformed-archive' };

  return { ok: true, kind, detectedMime: mime };
}

/** True for the two formats the image pipeline handles. */
export function isProcessableImage(kind: DetectedKind | null): boolean {
  return kind === 'jpeg' || kind === 'png';
}
