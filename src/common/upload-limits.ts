/**
 * The upload limits, in one place.
 *
 * They were spelled out at each use — the Multer config, the error messages,
 * the byte quota's comment — and a change to one had to be remembered in the
 * others. The quota default in particular is DERIVED from these two: it is
 * sized to let one full batch through, so raising the file cap without raising
 * it makes the quota, not the cap, the thing that refuses an ordinary upload.
 *
 * nginx's `client_max_body_size` in infrastructure/nginx/backend-lb.conf is the
 * same product plus headroom, and cannot read this file — raise it there too.
 */
export const UPLOAD_LIMITS = {
  /** Per file. */
  maxFileMb: 50,
  /** Per request. */
  maxFiles: 10,
} as const;

export const MAX_FILE_SIZE_BYTES = UPLOAD_LIMITS.maxFileMb * 1024 * 1024;
export const MAX_FILES_PER_UPLOAD = UPLOAD_LIMITS.maxFiles;

/** One batch at full size — what the hourly byte quota is sized to admit. */
export const MAX_BATCH_BYTES = MAX_FILE_SIZE_BYTES * MAX_FILES_PER_UPLOAD;
