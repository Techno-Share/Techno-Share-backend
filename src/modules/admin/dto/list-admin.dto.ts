import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

/**
 * Query shapes for the three paginated admin tables.
 *
 * These replace the loose `@Query('search')` parameters the endpoints used to
 * take. That matters for more than tidiness: the global ValidationPipe runs
 * with `forbidNonWhitelisted`, so a DTO turns an unrecognised parameter into a
 * 400 instead of silently ignoring it — which is what hid a misspelled filter
 * before.
 *
 * `sortBy` is an enum, never a free string. The value is used to pick a column
 * from a map in the service; a client-supplied field name never reaches SQL.
 */

/** Ascending or descending, defaulting to DESC at the service. */
export const SORT_ORDERS = ['ASC', 'DESC'] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

class SortableQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(SORT_ORDERS)
  order?: SortOrder;

  /**
   * Capped because it is interpolated into an ILIKE pattern. The bound is not
   * a security control — the value is still a bound parameter — but a
   * megabyte-long term is a pointless scan, and refusing it is cheaper than
   * running it.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}

// ─── Users ───────────────────────────────────────────────────────────────────

export const USER_SORT_FIELDS = [
  'created_at',
  'first_name',
  'last_name',
  'email',
  'role',
  'year_level',
] as const;
export type UserSortField = (typeof USER_SORT_FIELDS)[number];

/**
 * Which accounts to list. 'banned' is the ban currently in force (a user_bans
 * row with no lifted_at), not "has ever been banned" — the table shows the
 * state now, and the history has its own endpoint.
 */
export const USER_STATUSES = ['active', 'banned'] as const;

export class ListUsersDto extends SortableQueryDto {
  @IsOptional()
  @IsIn(USER_SORT_FIELDS)
  sortBy?: UserSortField;

  @IsOptional()
  @IsIn(USER_STATUSES)
  status?: (typeof USER_STATUSES)[number];
}

// ─── Promotions ──────────────────────────────────────────────────────────────

/**
 * The promotion history table — one row per scheduled rollover.
 *
 * Page and limit only. It carried `search` and `sortBy` while rows were
 * individual students; a rollover has neither a name to match nor a second
 * column worth ordering by, and the global ValidationPipe runs with
 * `forbidNonWhitelisted`, so leaving them declared would accept parameters the
 * service silently ignores.
 */
export class ListPromotionsDto extends PaginationQueryDto {}

// ─── Documents ───────────────────────────────────────────────────────────────

export const DOCUMENT_SORT_FIELDS = [
  'uploaded_at',
  'title',
  'doc_type',
  'year_level',
  'status',
] as const;
export type DocumentSortField = (typeof DOCUMENT_SORT_FIELDS)[number];

/**
 * The four states the Documents tab shows, which are not the four values in
 * the `status` column.
 *
 * 'hidden' and 'expired' are sub-states of an ACTIVE upload — hiding is the
 * uploader's switch and expiry is a date, and the row deliberately stays
 * 'active' through both. The browser used to fetch every active row and narrow
 * it here; now the service translates these into predicates so a page really is
 * a page. See docDisplayStatus() in AdminDashboardView.vue, which this mirrors.
 *
 * 'pending' is absent on purpose: those uploads belong to Approvals, where
 * there is something to do about them.
 */
export const DOCUMENT_VIEW_STATUSES = [
  'active',
  'rejected',
  'hidden',
  'expired',
] as const;
export type DocumentViewStatus = (typeof DOCUMENT_VIEW_STATUSES)[number];

export class ListDocumentsDto extends SortableQueryDto {
  @IsOptional()
  @IsIn(DOCUMENT_SORT_FIELDS)
  sortBy?: DocumentSortField;

  @IsOptional()
  @IsIn(DOCUMENT_VIEW_STATUSES)
  status?: DocumentViewStatus;

  @IsOptional()
  @IsString()
  doc_type?: string;

  @IsOptional()
  @IsUUID()
  major_id?: string;

  @IsOptional()
  @IsUUID()
  uploader_id?: string;

  /** ISO timestamp; only uploads at or after it are returned. */
  @IsOptional()
  @IsString()
  since?: string;
}

// ─── Subjects ────────────────────────────────────────────────────────────────

export const SUBJECT_SORT_FIELDS = [
  'created_at',
  'name',
  'acronym',
  'year_level',
  'semester',
] as const;
export type SubjectSortField = (typeof SUBJECT_SORT_FIELDS)[number];

export class ListSubjectsDto extends SortableQueryDto {
  @IsOptional()
  @IsIn(SUBJECT_SORT_FIELDS)
  sortBy?: SubjectSortField;

  @IsOptional()
  @IsUUID()
  major_id?: string;
}
