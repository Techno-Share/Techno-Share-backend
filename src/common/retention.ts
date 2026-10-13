/**
 * How long a rejected upload's files survive before they are really deleted.
 *
 * Rejection used to delete the objects the instant a moderator pressed the
 * button, which left no way back from a misclick: the row said "rejected" and
 * the bytes were gone. A student who had deleted their own copy had nothing to
 * appeal with, and a moderator who rejected the wrong submission could not undo
 * it.
 *
 * Thirty days is long enough for the uploader to notice the notification and
 * ask, and short enough that refused material is not kept indefinitely. The
 * window is measured from `rejected_at`; the sweep that enforces it runs hourly,
 * so files outlive the deadline by up to an hour, which does not matter at this
 * scale.
 */
export const REJECTED_FILE_RETENTION_DAYS = 30;

export const REJECTED_FILE_RETENTION_MS =
  REJECTED_FILE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
