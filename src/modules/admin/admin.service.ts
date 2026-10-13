import {
  Injectable,
  InternalServerErrorException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { UserBan } from '../users/entities/user-ban.entity';
import { BanLookupService } from '../users/ban-lookup.service';
import { Upload } from '../documents/entities/upload.entity';
import { DocumentFile } from '../documents/entities/document.entity';
import { Subject } from '../subjects/entities/subject.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { Book } from '../books/entities/book.entity';
import { BookRequest } from '../books/entities/book-request.entity';
import { Notification } from '../notifications/entities/notification.entity';
import { Major } from '../majors/entities/major.entity';
import { yearLevelsForMajor } from '../documents/utils/year-levels';
import { BUCKETS, StorageService } from '../storage/storage.service';
import { REJECTED_FILE_RETENTION_MS } from '../../common/retention';
import { NotificationsService } from '../notifications/notifications.service';
import { ModerationService, Reviewer } from './moderation.service';
import { PromotionSettingsService } from '../settings/promotion-settings.service';
import type { Paginated } from '../../common/dto/pagination.dto';
import type {
  ListDocumentsDto,
  ListSubjectsDto,
  ListUsersDto,
  SortOrder,
} from './dto/list-admin.dto';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What a caller gets when they ask for no particular page size.
 *
 * Matches the smallest option the admin tables offer, so the first paint costs
 * the least; a caller wanting more asks for it.
 */
export const DEFAULT_ADMIN_PAGE_SIZE = 10;

/**
 * Turn the validated page/limit into the two numbers the query builder needs.
 *
 * The DTO has already bounded both, so this does not re-validate; it exists so
 * the three list methods cannot disagree about the default.
 */
function pageWindow(query: { page?: number; limit?: number }) {
  const limit = query.limit ?? DEFAULT_ADMIN_PAGE_SIZE;
  const page = query.page ?? 1;
  return { limit, page, skip: (page - 1) * limit };
}

/**
 * Resolve a whitelisted sort field to the column the query builder orders by.
 *
 * `sortBy` has already been checked against an `@IsIn` list, so the lookup is
 * the second gate rather than the first — a value that somehow reached here
 * without matching a key falls back to the default instead of being
 * interpolated. No client string is ever concatenated into SQL.
 */
function orderColumn<T extends string>(
  columns: Record<T, string>,
  fallback: string,
  sortBy: T | undefined,
): string {
  return (sortBy && columns[sortBy]) || fallback;
}

/** ASC or DESC, defaulting to DESC — newest first, which every table wants. */
function sortDirection(order: SortOrder | undefined): 'ASC' | 'DESC' {
  return order === 'ASC' ? 'ASC' : 'DESC';
}

@Injectable()
export class AdminService {
  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(UserBan)
    private readonly userBans: Repository<UserBan>,
    @InjectRepository(Upload)
    private readonly uploads: Repository<Upload>,
    @InjectRepository(DocumentFile)
    private readonly documents: Repository<DocumentFile>,
    @InjectRepository(Subject)
    private readonly subjects: Repository<Subject>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokens: Repository<RefreshToken>,
    @InjectRepository(Book)
    private readonly books: Repository<Book>,
    @InjectRepository(Major)
    private readonly majors: Repository<Major>,
    @InjectRepository(BookRequest)
    private readonly bookRequests: Repository<BookRequest>,
    @InjectRepository(Notification)
    private readonly notificationsRepo: Repository<Notification>,
    private readonly storage: StorageService,
    private readonly notificationsService: NotificationsService,
    private readonly moderation: ModerationService,
    private readonly promotionSettings: PromotionSettingsService,
    private readonly bans: BanLookupService,
  ) {}

  /**
   * Filter values arrive straight from the query string, so a malformed id would
   * otherwise reach Postgres and surface as a 500 instead of a 400.
   */
  private assertUuid(value: string, field: string) {
    if (!UUID_PATTERN.test(value))
      throw new BadRequestException(`${field} must be a valid UUID`);
    return value;
  }

  // ─── Stats ─────────────────────────────────────────────────────────────────

  async getStats() {
    const [
      totalUsers,
      totalDocuments,
      totalSubjects,
      totalBooks,
      uploadsByMonth,
      documentsByDepartment,
      documentsByStatus,
    ] = await Promise.all([
      this.users.count(),
      this.uploads.count({ where: { status: 'active' } }),
      this.subjects.count({ where: { status: 'active' } }),
      this.books.count(),
      this.uploadsByMonth(),
      this.documentsByDepartment(),
      this.documentsByStatus(),
    ]);

    return {
      totalUsers,
      totalDocuments,
      totalSubjects,
      totalBooks,
      uploadsByMonth,
      documentsByDepartment,
      documentsByStatus,
    };
  }

  /**
   * Approved uploads per department, busiest first.
   *
   * A LEFT JOIN from `majors`, so a department with nothing in it comes back as
   * 0 rather than being absent — an empty department is the single most useful
   * thing this chart says, and dropping the row would hide it.
   *
   * Counts `status = 'active'`, matching the Documents stat card. The status
   * donut partitions a wider set (every non-pending upload), so the two totals
   * differ on purpose and each chart says which it is counting.
   */
  private async documentsByDepartment() {
    const rows: { acronym: string; count: string }[] = await this.uploads.query(
      `
      select m.acronym, count(u.id) as count
        from majors m
   left join uploads u
          on u.major_id = m.id
         and u.status = 'active'
    group by m.acronym
    -- Acronym breaks ties so equal departments keep a stable order between
    -- requests; without it the chart reshuffles on every refresh.
    order by count(u.id) desc, m.acronym asc
      `,
    );

    return rows.map((r) => ({ acronym: r.acronym, count: Number(r.count) }));
  }

  /**
   * Every non-pending upload, bucketed into the four states the Documents tab
   * displays.
   *
   * The CASE mirrors documentStatusClause — and docDisplayStatus in the
   * frontend — including the precedence: hidden beats rejected, which beats
   * expired. One CASE rather than four counting queries is what guarantees the
   * buckets are mutually exclusive, so the slices really do sum to the whole.
   * Four separate counts could drift apart and a donut built on them would be
   * quietly lying.
   *
   * Pending is excluded for the same reason the tab excludes it: those uploads
   * belong to Approvals.
   */
  private async documentsByStatus() {
    const rows: { status: string; count: string }[] = await this.uploads.query(
      `
      select case
               when u.hidden_at is not null then 'hidden'
               when u.status = 'rejected'   then 'rejected'
               when u.expires_at is not null and u.expires_at <= now()
                                            then 'expired'
               else 'active'
             end      as status,
             count(*) as count
        from uploads u
       where u.status <> 'pending'
    group by 1
      `,
    );

    const counts = new Map(rows.map((r) => [r.status, Number(r.count)]));
    // Fixed order, and every bucket present even at zero: the chart's colours
    // are assigned by slot, so a missing bucket would repaint the survivors.
    return (['active', 'hidden', 'expired', 'rejected'] as const).map(
      (status) => ({ status, count: counts.get(status) ?? 0 }),
    );
  }

  /**
   * Approved uploads per month for the last 6 months, oldest first.
   *
   * generate_series supplies the months, so a month with no uploads comes back
   * as 0 rather than being missing — a chart that skipped empty months would
   * imply activity that never happened.
   */
  private async uploadsByMonth(months = 6) {
    const rows: { month: string; count: string }[] = await this.uploads.query(
      `
      with span as (
        select generate_series(
          date_trunc('month', now()) - make_interval(months => $1::int - 1),
          date_trunc('month', now()),
          interval '1 month'
        ) as month
      )
      select to_char(span.month, 'YYYY-MM') as month,
             count(u.id)                   as count
        from span
   left join uploads u
          on date_trunc('month', u.uploaded_at) = span.month
         and u.status = 'active'
    group by span.month
    order by span.month
      `,
      [months],
    );

    return rows.map((r) => ({ month: r.month, count: Number(r.count) }));
  }

  // ─── Users ─────────────────────────────────────────────────────────────────

  /** Columns the users table may be ordered by, keyed by the DTO's enum. */
  private static readonly USER_SORT_COLUMNS = {
    created_at: 'u.created_at',
    first_name: 'u.first_name',
    last_name: 'u.last_name',
    email: 'u.email',
    role: 'u.role',
    year_level: 'u.year_level',
  } as const;

  async getAllUsers(query: ListUsersDto = {}): Promise<Paginated<unknown>> {
    const { limit, page, skip } = pageWindow(query);
    const qb = this.users
      .createQueryBuilder('u')
      .leftJoinAndSelect('u.major', 'major');

    if (query.search) {
      qb.andWhere(
        '(u.first_name ILIKE :s OR u.last_name ILIKE :s OR u.email ILIKE :s)',
        { s: `%${query.search}%` },
      );
    }

    /**
     * Banned or not, decided in SQL rather than after the fetch.
     *
     * `users` carries no relation to `user_bans`, and the ban in force is the
     * row with no lifted_at, so this is an EXISTS rather than a join — a join
     * would duplicate a user who has been banned more than once, which would
     * then corrupt both the page and the count.
     */
    if (query.status) {
      const clause = `${query.status === 'banned' ? 'EXISTS' : 'NOT EXISTS'} (
        SELECT 1 FROM user_bans b
         WHERE b.user_id = u.id AND b.lifted_at IS NULL
      )`;
      qb.andWhere(clause);
    }

    qb.orderBy(
      orderColumn(AdminService.USER_SORT_COLUMNS, 'u.created_at', query.sortBy),
      sortDirection(query.order),
    )
      // Without a tie-break, two accounts created in the same transaction have
      // no defined order, so the same row can appear on two pages (or neither).
      .addOrderBy('u.id', 'DESC')
      .skip(skip)
      .take(limit);

    let rows: User[];
    let total: number;
    try {
      [rows, total] = await qb.getManyAndCount();
    } catch {
      throw new InternalServerErrorException('Failed to fetch users');
    }

    // One query for every assignment, rather than one per user. Now scoped to
    // the page, so these two cost a page's worth of ids instead of the table's.
    const ids = rows.map((u) => u.id);
    const moderatedBy = await this.moderation.assignmentsByUser(ids);
    // Same reason: the ban in force now lives in user_bans, and asking per row
    // would put a query behind every line of the table.
    const activeBans = await this.bans.activeBansFor(ids);

    return {
      items: rows.map((u) => ({
        id: u.id,
        first_name: u.first_name,
        last_name: u.last_name,
        email: u.email,
        role: u.role,
        year_level: u.year_level,
        created_at: u.created_at,
        majors: u.major ? { id: u.major.id, acronym: u.major.acronym } : null,
        // Everything the admin UI needs to show state and offer the right
        // action. Shape unchanged from when these were columns on `users`, so
        // the client reads the same fields.
        banned_at: activeBans.get(u.id)?.banned_at ?? null,
        ban_reason: activeBans.get(u.id)?.reason ?? null,
        moderates: moderatedBy.get(u.id) ?? [],
      })),
      total,
      page,
      limit,
    };
  }

  // ─── All documents (admin table view) ─────────────────────────────────────

  /** Columns the documents table may be ordered by, keyed by the DTO's enum. */
  private static readonly DOCUMENT_SORT_COLUMNS = {
    uploaded_at: 'u.uploaded_at',
    title: 'u.title',
    doc_type: 'u.doc_type',
    year_level: 'u.year_level',
    status: 'u.status',
  } as const;

  /**
   * The display status the browser used to compute, expressed as SQL.
   *
   * Mirrors docDisplayStatus() in AdminDashboardView.vue, INCLUDING its
   * precedence: hidden wins over rejected, which wins over expired. Getting
   * that order wrong would move rows between tabs rather than merely paginate
   * them, so the four branches are mutually exclusive by construction — every
   * row lands in exactly one, and the four counts sum to the table.
   */
  private static documentStatusClause(view: string): string {
    switch (view) {
      case 'hidden':
        return 'u.hidden_at IS NOT NULL';
      case 'rejected':
        return "u.hidden_at IS NULL AND u.status = 'rejected'";
      case 'expired':
        return `u.hidden_at IS NULL AND u.status <> 'rejected'
                AND u.expires_at IS NOT NULL AND u.expires_at <= now()`;
      default: // 'active'
        return `u.hidden_at IS NULL AND u.status <> 'rejected'
                AND (u.expires_at IS NULL OR u.expires_at > now())`;
    }
  }

  async getAllDocuments(
    filters: ListDocumentsDto = {},
  ): Promise<Paginated<unknown>> {
    const { limit, page, skip } = pageWindow(filters);
    const {
      search,
      doc_type: docType,
      major_id: majorId,
      uploader_id: uploaderId,
      status,
      since,
    } = filters;

    const qb = this.uploads
      .createQueryBuilder('u')
      .leftJoinAndSelect('u.uploader', 'uploader')
      .leftJoinAndSelect('u.reviewer', 'reviewer')
      .leftJoinAndSelect('u.major', 'major')
      .leftJoinAndSelect('u.subject', 'subject')
      .leftJoinAndSelect('u.documents', 'documents')
      /**
       * Never 'pending' — those uploads are the review queue's, and listing
       * them here would offer a second place to see them with no way to act.
       * The DTO's @IsIn keeps 'pending' out of `status`; this keeps it out of
       * the result regardless of which of the four views is selected.
       */
      .where("u.status <> 'pending'")
      .andWhere(AdminService.documentStatusClause(status ?? 'active'));

    /**
     * Title, description, or who uploaded it — the uploader dropdown this
     * replaced made you pick from every registered user to answer "what did
     * Sok upload?".
     *
     * The name is matched as one concatenated string so "pha roth" works as
     * typed; first and last are halves of a single field, unlike the title,
     * which is tested separately so a term cannot match by straddling the two.
     */
    if (search)
      qb.andWhere(
        `(u.title ILIKE :search
          OR u.description ILIKE :search
          OR concat(uploader.first_name, ' ', uploader.last_name) ILIKE :search)`,
        { search: `%${search}%` },
      );
    if (docType) qb.andWhere('u.doc_type = :docType', { docType });
    if (majorId)
      qb.andWhere('u.major_id = :majorId', {
        majorId: this.assertUuid(majorId, 'major_id'),
      });
    if (uploaderId)
      qb.andWhere('u.uploader_id = :uploaderId', {
        uploaderId: this.assertUuid(uploaderId, 'uploader_id'),
      });
    if (since) {
      const from = new Date(since);
      if (Number.isNaN(from.getTime()))
        throw new BadRequestException('since must be an ISO date');
      qb.andWhere('u.uploaded_at >= :since', { since: from });
    }

    qb.orderBy(
      orderColumn(
        AdminService.DOCUMENT_SORT_COLUMNS,
        'u.uploaded_at',
        filters.sortBy,
      ),
      sortDirection(filters.order),
    )
      .addOrderBy('u.id', 'DESC')
      .skip(skip)
      .take(limit);

    let rows: Upload[];
    let total: number;
    try {
      /**
       * skip/take rather than limit/offset, which is what makes this correct
       * across the one-to-many join to `documents`. TypeORM answers a paginated
       * joined query by first selecting DISTINCT ids with the ordering applied
       * and only then fetching those rows' children — so a page is N uploads,
       * not N upload-file pairs, and `total` counts uploads too.
       *
       * Ordering only ever names columns on `u` for the same reason: Postgres
       * rejects a SELECT DISTINCT whose ORDER BY references an expression
       * outside the select list, which is how an inline CASE in the student
       * feed once 500'd the whole endpoint.
       */
      [rows, total] = await qb.getManyAndCount();
    } catch {
      throw new InternalServerErrorException('Failed to fetch documents');
    }

    // Signed here, not returned raw: the `documents` bucket is private, so the
    // stored URL would 403 in the admin table. Same treatment as every other
    // list — see signRef.
    const items = await Promise.all(
      rows.map(async (u) => ({
        id: u.id,
        title: u.title,
        doc_type: u.doc_type,
        uploaded_at: u.uploaded_at,
        /**
         * 'active' or 'rejected' — the only two this tab lists; pending belongs
         * to Approvals. Returned even though the caller filters on it, so a row
         * says what it is without the reader having to remember which filter is
         * selected.
         */
        status: u.status,
        users: u.uploader
          ? {
              id: u.uploader.id,
              first_name: u.uploader.first_name,
              last_name: u.uploader.last_name,
            }
          : null,
        /**
         * Who approved it. Null for anything approved before reviewers were
         * recorded, and for a reviewer whose account has since been deleted —
         * the table shows a dash for both rather than inventing a name.
         */
        approved_by: u.reviewer
          ? {
              id: u.reviewer.id,
              first_name: u.reviewer.first_name,
              last_name: u.reviewer.last_name,
            }
          : null,
        majors: u.major ? { id: u.major.id, acronym: u.major.acronym } : null,
        /** The cohort the upload is for; the table shows it as "I3-GIC". */
        year_level: u.year_level,
        /** Which academic year the material belongs to, e.g. "2025-2026". */
        academic_year: u.academic_year,
        /**
         * Who may see it, as (department, year) pairs; empty means everyone.
         * Ids rather than acronyms — the admin screen already holds the
         * department list it needs to name them.
         */
        audience: u.audience ?? [],
        /** Soft expiry. Null = never. */
        expires_at: u.expires_at,
        /**
         * Set when the uploader withdrew it from circulation. Hidden and
         * expired are not review states — they sit alongside `status`, and the
         * table folds all four into one column the way the owner's dashboard
         * does.
         */
        hidden_at: u.hidden_at,
        /**
         * Why it was turned down. Null on anything not rejected, and on
         * rejections recorded before a reason was mandatory — the table shows
         * the line only when there is one rather than an empty "Reason:".
         */
        rejection_reason: u.rejection_reason,
        subjects: u.subject ? { id: u.subject.id, name: u.subject.name } : null,
        description: u.description,
        documents: await Promise.all(
          (u.documents ?? []).map(async (d) => ({
            id: d.id,
            file_url: await this.signRef(
              d.storage_key,
              d.file_url,
              d.original_name,
              this.inlineSafe(d.storage_key),
            ),
            original_name: d.original_name,
            file_size_kb: d.file_size_kb,
            // The expanded row previews office files through their PDF
            // rendition — ours, so it may render in place.
            preview_url: await this.signRef(
              d.preview_key,
              d.preview_url,
              d.original_name,
              true,
            ),
          })),
        ),
      })),
    );

    return { items, total, page, limit };
  }

  // ─── User administration ───────────────────────────────────────────────────

  /**
   * Promote to admin or demote back to a normal user.
   *
   * Moderator is NOT a role — it's an assignment per department (see
   * ModerationService), so promoting someone to review GIC doesn't touch this.
   *
   * Two self-inflicted lockouts are refused: demoting yourself, and demoting the
   * last admin. Either would leave nobody able to promote anyone back.
   */
  // ─── Books (admin only) ──────────────────────────────────────────────────
  // Books are never reviewed — a donation goes live immediately. Admins get
  // this listing to correct a status or take a listing down, not to approve.

  /**
   * Every book, newest first, with its donor and whether a request is open.
   *
   * `open_requests` matters because "requesting" is not a stored status: a book
   * someone has asked for is still 'available' in the row, and the count is the
   * only way to see it here.
   */
  async getAllBooks(search?: string) {
    const qb = this.books
      .createQueryBuilder('b')
      .leftJoinAndSelect('b.donor', 'donor')
      .leftJoinAndSelect('b.major', 'major')
      .orderBy('b.created_at', 'DESC');

    if (search?.trim()) {
      qb.where(
        '(b.title ILIKE :q OR donor.first_name ILIKE :q OR donor.last_name ILIKE :q OR donor.email ILIKE :q)',
        { q: `%${search.trim()}%` },
      );
    }

    const books = await qb.getMany();
    if (!books.length) return [];

    const open = await this.bookRequests
      .createQueryBuilder('r')
      .select('r.book_id', 'book_id')
      .addSelect('count(*)', 'count')
      .where('r.book_id IN (:...ids)', { ids: books.map((b) => b.id) })
      .andWhere('r.status IN (:...statuses)', {
        statuses: ['pending', 'accepted'],
      })
      .groupBy('r.book_id')
      .getRawMany<{ book_id: string; count: string }>();

    const openByBook = new Map(open.map((r) => [r.book_id, Number(r.count)]));

    return books.map((b) => ({
      id: b.id,
      title: b.title,
      status: b.status,
      hidden_at: b.hidden_at,
      cover_image_url: b.cover_image_url,
      created_at: b.created_at,
      open_requests: openByBook.get(b.id) ?? 0,
      major: b.major ? { id: b.major.id, acronym: b.major.acronym } : null,
      donor: b.donor
        ? {
            id: b.donor.id,
            first_name: b.donor.first_name,
            last_name: b.donor.last_name,
            email: b.donor.email,
          }
        : null,
    }));
  }

  /**
   * Take a listing out of circulation, or put it back.
   *
   * The row is untouched otherwise: the donor keeps seeing it in "My books"
   * (marked hidden), so their book does not silently vanish, but it is gone
   * from the public list and its detail page 404s.
   */
  async setBookHidden(bookId: string, hidden: boolean) {
    const book = await this.books.findOne({
      where: { id: bookId },
      select: { id: true },
    });
    if (!book) throw new NotFoundException('Book not found');

    await this.books.update(
      { id: bookId },
      { hidden_at: hidden ? new Date() : null },
    );
    return { message: hidden ? 'Book hidden' : 'Book visible', hidden };
  }

  /**
   * Remove a book outright.
   *
   * Unlike the donor's own delete, this is not blocked by an open request or by
   * the book already being donated — it exists precisely for the listings a
   * donor cannot clean up themselves.
   */
  async deleteBook(bookId: string) {
    const book = await this.books.findOne({
      where: { id: bookId },
      select: { id: true, cover_image_url: true },
    });
    if (!book) throw new NotFoundException('Book not found');

    // Requests cascade with the book, but notifications pointing at them do
    // not — left behind they become links that 404 when a recipient opens them.
    const reqs = await this.bookRequests.find({
      where: { book_id: bookId },
      select: { id: true },
    });
    if (reqs.length) {
      await this.notificationsRepo.delete({
        ref_type: 'book_request',
        ref_id: In(reqs.map((r) => r.id)),
      });
    }

    const key = this.storage.extractKey(book.cover_image_url);
    if (key) await this.storage.remove([key]);

    try {
      await this.books.delete({ id: bookId });
    } catch {
      throw new InternalServerErrorException('Failed to delete book');
    }

    return { message: 'Book deleted' };
  }

  async setUserRole(targetId: string, role: 'user' | 'admin', actorId: string) {
    if (targetId === actorId && role !== 'admin') {
      throw new BadRequestException('You cannot demote yourself');
    }

    const target = await this.users.findOne({
      where: { id: targetId },
      select: { id: true, role: true, first_name: true, last_name: true },
    });
    if (!target) throw new NotFoundException('User not found');

    if (target.role === 'admin' && role !== 'admin') {
      const admins = await this.users.count({ where: { role: 'admin' } });
      if (admins <= 1) {
        throw new BadRequestException('The last admin cannot be demoted');
      }
    }

    await this.users.update({ id: targetId }, { role });

    void this.notificationsService.create({
      user_id: targetId,
      type: role === 'admin' ? 'role_promoted' : 'role_changed',
      message:
        role === 'admin'
          ? 'You are now an administrator.'
          : 'Your administrator access has been removed.',
      key: role === 'admin' ? 'roleAdminGranted' : 'roleAdminRemoved',
      ref_id: targetId,
      ref_type: 'user',
    });

    return { message: `Role updated to ${role}` };
  }

  /**
   * Ban an account: block sign-in and cut existing sessions.
   *
   * The row is kept — their uploads and history stay intact, and unbanning
   * clears three fields. Refresh tokens are deleted so an open browser can't
   * renew its access token; the JWT strategy rejects the current one on its
   * next request.
   *
   * Also recorded in `user_bans`, which survives the unban. Without it, lifting
   * a ban erased every trace that it happened.
   */
  async banUser(targetId: string, actorId: string, reason?: string) {
    if (targetId === actorId) {
      throw new BadRequestException('You cannot ban yourself');
    }

    const target = await this.users.findOne({
      where: { id: targetId },
      select: { id: true, role: true },
    });
    if (!target) throw new NotFoundException('User not found');
    if (target.role === 'admin') {
      // Demote first — deliberately two steps, so banning can't be used to take
      // another admin out in one move.
      throw new BadRequestException('Demote this admin before banning');
    }

    // user_bans permits one unlifted row per user, so banning over an open ban
    // would otherwise fail on that index with a raw constraint error.
    if (await this.bans.isBanned(targetId)) {
      throw new BadRequestException('This account is already banned');
    }

    // One row, one write. `users` carried banned_at/ban_reason/banned_by too
    // until DropUserBanColumns, and keeping the two in step needed a
    // transaction around this; the log is now the only place it is recorded.
    await this.userBans.insert({
      user_id: targetId,
      reason: reason?.trim() || null,
      banned_by: actorId,
    });

    // Without this, a stored refresh token would mint new access tokens.
    await this.refreshTokens.delete({ user_id: targetId });
    // A banned reviewer shouldn't keep a review queue.
    await this.moderation.unassignAll(targetId);

    return { message: 'User banned' };
  }

  /**
   * Correct a student's department and year.
   *
   * Admin-only by design: the pair decides which documents they can see, so
   * PATCH /users/me refuses it once a profile is set. Placement is the
   * institute's call, and this is where a mistake gets fixed.
   *
   * Also settles any pending rollover — an admin placing someone into a
   * department has answered the question the prompt would ask.
   */
  async setUserPlacement(targetId: string, majorId: string, yearLevel: number) {
    const target = await this.users.findOne({
      where: { id: targetId },
      select: { id: true },
    });
    if (!target) throw new NotFoundException('User not found');

    const major = await this.majors.findOne({ where: { id: majorId } });
    if (!major) throw new BadRequestException('Unknown department');

    // A GIC year 1 or a TC year 4 matches no upload's audience, so the student
    // would silently see nothing. Reject rather than store it.
    const allowed = yearLevelsForMajor(major.acronym);
    if (!allowed.includes(yearLevel))
      throw new BadRequestException(
        `${major.acronym} has years ${allowed.join(', ')} — not ${yearLevel}`,
      );

    await this.users.update(
      { id: targetId },
      {
        major_id: majorId,
        year_level: yearLevel,
        // An admin has just said where this student sits, so they are not owed
        // the current rollover — stamping it stops them being advanced again on
        // their next visit.
        promoted_rollover_at: await this.promotionSettings.rolloverAt(),
      },
    );

    void this.notificationsService.create({
      user_id: targetId,
      type: 'placement_changed',
      message: `Your academic placement has been updated to ${major.acronym}, Year ${yearLevel}.`,
      key: 'placementChanged',
      params: { acronym: major.acronym, year: yearLevel },
      ref_id: targetId,
      ref_type: 'user',
    });

    return {
      message: 'Placement updated',
      major_id: majorId,
      year_level: yearLevel,
    };
  }

  async unbanUser(targetId: string, actorId: string) {
    const target = await this.users.findOne({
      where: { id: targetId },
      select: { id: true },
    });
    if (!target) throw new NotFoundException('User not found');

    // Stamped, never deleted — keeping the record is the whole point of the
    // table. Scoped to the unlifted row, so an earlier ban keeps the date it
    // was actually lifted.
    await this.userBans.update(
      { user_id: targetId, lifted_at: IsNull() },
      { lifted_at: new Date(), lifted_by: actorId },
    );

    void this.notificationsService.create({
      user_id: targetId,
      type: 'account_unbanned',
      message:
        'Your account has been reinstated. You can now access your account again.',
      key: 'accountReinstated',
      ref_id: targetId,
      ref_type: 'user',
    });

    return { message: 'User unbanned' };
  }

  /**
   * Every ban this account has had, newest first.
   *
   * The whole reason the table exists: an admin deciding whether to ban someone
   * can see they have been banned before, and by whom — which the flag on
   * `users` could not answer, because it only ever described the ban in force.
   *
   * Not paginated — an account with enough bans to need paging has a problem no
   * page size solves.
   */
  async getUserBans(targetId: string) {
    const bans = await this.userBans.find({
      where: { user_id: targetId },
      relations: { bannedBy: true, liftedBy: true },
      order: { banned_at: 'DESC' },
    });

    const name = (u: User | null) =>
      u ? { id: u.id, first_name: u.first_name, last_name: u.last_name } : null;

    return bans.map((b) => ({
      id: b.id,
      reason: b.reason,
      banned_at: b.banned_at,
      banned_by: name(b.bannedBy),
      lifted_at: b.lifted_at,
      lifted_by: name(b.liftedBy),
      active: b.lifted_at === null,
    }));
  }

  // ─── Subjects ──────────────────────────────────────────────────────────────

  /**
   * The departments this reviewer answers for — what the review screen names in
   * its header, so a moderator can see the scope their queue is filtered to.
   *
   * `null` majors for an admin: they review everything, which is not the same
   * as reviewing an empty list, and the two must stay distinguishable (see
   * scopeMajorIds).
   */
  async getReviewerScope(reviewer: Reviewer) {
    const ids = this.moderation.scopeMajorIds(reviewer);
    if (ids === null) return { is_admin: true, majors: null };
    if (!ids.length) return { is_admin: false, majors: [] };

    const majors = await this.majors.find({
      where: { id: In(ids) },
      select: { id: true, acronym: true, name: true },
      order: { acronym: 'ASC' },
    });
    return { is_admin: false, majors };
  }

  /** Columns the subjects table may be ordered by, keyed by the DTO's enum. */
  private static readonly SUBJECT_SORT_COLUMNS = {
    created_at: 's.created_at',
    name: 's.name',
    acronym: 's.acronym',
    year_level: 's.year_level',
    semester: 's.semester',
  } as const;

  async getAllSubjects(
    query: ListSubjectsDto = {},
  ): Promise<Paginated<unknown>> {
    const { limit, page, skip } = pageWindow(query);
    const { search, major_id: majorId } = query;
    const qb = this.subjects
      .createQueryBuilder('s')
      .leftJoinAndSelect('s.major', 'major')
      .leftJoinAndSelect('s.submitter', 'submitter')
      /**
       * Active only, and not as a filter the caller can change.
       *
       * Subjects have no review: one is created by a moderator of its own
       * department and is live immediately, so there is no status to choose
       * between. What is left are rows stranded mid-review when that was
       * removed — invisible to students, since every lookup filters to active,
       * and listing them here would offer an admin something they cannot act
       * on and cannot explain.
       */
      .andWhere('s.status = :active', { active: 'active' });

    if (search) qb.andWhere('s.name ILIKE :search', { search: `%${search}%` });
    if (majorId)
      qb.andWhere('s.major_id = :majorId', {
        majorId: this.assertUuid(majorId, 'major_id'),
      });

    qb.orderBy(
      orderColumn(
        AdminService.SUBJECT_SORT_COLUMNS,
        's.created_at',
        query.sortBy,
      ),
      sortDirection(query.order),
    )
      // Newest first by default. Ordering on the uuid alone put the rows in no
      // order at all; the id now only breaks ties — which is also what keeps a
      // row from appearing on two pages when sorting by a non-unique column.
      .addOrderBy('s.id', 'DESC')
      .skip(skip)
      .take(limit);

    let rows: Subject[];
    let total: number;
    try {
      [rows, total] = await qb.getManyAndCount();
    } catch {
      throw new InternalServerErrorException('Failed to fetch subjects');
    }

    return {
      items: rows.map((s) => this.subjectAdminShape(s)),
      total,
      page,
      limit,
    };
  }

  private subjectAdminShape(s: Subject) {
    return {
      id: s.id,
      name: s.name,
      acronym: s.acronym,
      year_level: s.year_level,
      semester: s.semester,
      subject_url: s.subject_url,
      // The approvals queue filters and sorts by how long a submission has waited.
      created_at: s.created_at,
      majors: s.major ? { id: s.major.id, acronym: s.major.acronym } : null,
      users: s.submitter
        ? {
            id: s.submitter.id,
            first_name: s.submitter.first_name,
            last_name: s.submitter.last_name,
          }
        : null,
    };
  }

  async editSubject(
    id: string,
    dto: {
      name?: string;
      acronym?: string;
      semester?: number;
      subject_url?: string;
    },
    image?: Express.Multer.File,
  ) {
    const updates: Partial<Subject> = {};
    if (dto.name?.trim()) updates.name = dto.name.trim();
    if (dto.acronym?.trim()) updates.acronym = dto.acronym.trim();
    if (dto.semester !== undefined) updates.semester = dto.semester;

    /**
     * The cover, by the same rules the create route follows: a sent file wins,
     * an empty `subject_url` clears it, and absent means leave it alone.
     *
     * The previous object is read before the write and removed only after it
     * succeeds — deleting first would lose the old cover for a save that then
     * fails, and deleting unconditionally would delete one the row still
     * points at.
     */
    let previousUrl: string | null = null;
    let uploadedKey: string | null = null;

    if (image || dto.subject_url !== undefined) {
      const current = await this.subjects.findOne({
        where: { id },
        select: { id: true, major_id: true, subject_url: true },
      });
      if (!current) throw new NotFoundException('Subject not found');
      previousUrl = current.subject_url;

      if (image) {
        const ext = image.originalname.split('.').pop() ?? 'bin';
        uploadedKey = `${current.major_id}/${Date.now()}-${Math.random()
          .toString(36)
          .slice(2)}.${ext}`;
        try {
          updates.subject_url = await this.storage.upload(
            BUCKETS.SUBJECTS,
            uploadedKey,
            image.buffer,
            image.mimetype,
          );
        } catch {
          throw new InternalServerErrorException(
            'Failed to upload subject image',
          );
        }
      } else {
        updates.subject_url = dto.subject_url?.trim() || null;
      }
    }

    try {
      await this.subjects.update({ id }, updates);
    } catch {
      // The row never changed — don't leave the just-uploaded object orphaned.
      if (uploadedKey) {
        await this.storage.remove([`${BUCKETS.SUBJECTS}/${uploadedKey}`]);
      }
      throw new InternalServerErrorException('Failed to update subject');
    }

    // Unreachable once the row points somewhere else.
    if (previousUrl && previousUrl !== updates.subject_url) {
      await this.storage.remove([this.storage.extractKey(previousUrl)]);
    }

    return {
      message: 'Subject updated',
      subject_url: updates.subject_url ?? previousUrl ?? null,
    };
  }

  async removeSubject(id: string) {
    try {
      await this.subjects.delete({ id });
    } catch {
      throw new InternalServerErrorException('Failed to delete subject');
    }
    return { message: 'Subject deleted' };
  }

  // ─── Pending documents ─────────────────────────────────────────────────────

  async getPendingDocuments(reviewer: Reviewer) {
    const scope = this.moderation.scopeMajorIds(reviewer);
    if (scope?.length === 0) return [];

    let rows: Upload[];
    try {
      rows = await this.uploads.find({
        where: scope
          ? { status: 'pending', major_id: In(scope) }
          : { status: 'pending' },
        relations: {
          uploader: true,
          major: true,
          subject: true,
          documents: true,
        },
        order: { uploaded_at: 'DESC' },
      });
    } catch {
      throw new InternalServerErrorException(
        'Failed to fetch pending documents',
      );
    }

    // Flatten to match existing frontend shape: one row per file with group_id = upload id
    const groupRows = (
      await Promise.all(
        rows.map((upload) => this.flattenUpload(upload, false, 'group')),
      )
    ).flat();

    // Plus files added to an upload that is ALREADY approved. Those never
    // re-pend their upload — only the file waits — so they would otherwise
    // never reach a queue that looks at uploads.status alone.
    const fileQb = this.uploads
      .createQueryBuilder('u')
      .leftJoinAndSelect('u.uploader', 'uploader')
      .leftJoinAndSelect('u.major', 'major')
      .leftJoinAndSelect('u.subject', 'subject')
      // innerJoin: an upload with no pending file drops out entirely, and only
      // the pending files come back — an approved file is not up for review.
      .innerJoinAndSelect('u.documents', 'documents', 'documents.status = :p', {
        p: 'pending',
      })
      .where('u.status = :active', { active: 'active' })
      .orderBy('u.uploaded_at', 'DESC');

    if (scope) fileQb.andWhere('u.major_id IN (:...scope)', { scope });

    let fileUploads: Upload[];
    try {
      fileUploads = await fileQb.getMany();
    } catch {
      throw new InternalServerErrorException('Failed to fetch pending files');
    }

    const fileRows = (
      await Promise.all(
        fileUploads.map((upload) => this.flattenUpload(upload, false, 'file')),
      )
    ).flat();

    return [...groupRows, ...fileRows];
  }

  // ─── Document group (review page) ──────────────────────────────────────────

  /**
   * One upload and its files, for the review screen.
   *
   * Takes a reviewer because reaching this endpoint is not the same as being
   * allowed to read this upload: a moderator of one department must not open
   * another's by changing the id in the URL. The department is read from the
   * loaded upload, never from the request.
   */
  async getDocumentsByGroup(uploadId: string, reviewer: Reviewer) {
    const upload = await this.uploads.findOne({
      where: { id: uploadId },
      relations: {
        uploader: true,
        major: true,
        subject: true,
        documents: true,
      },
    });

    if (!upload) throw new NotFoundException('Upload not found');

    // The department comes from the upload, so the id in the URL decides WHICH
    // upload is checked, never WHETHER it is.
    this.moderation.assertCanModerate(reviewer, upload.major_id);

    // A pending upload is reviewed as a group. An active one can only be here
    // because files were added to it after approval — those are reviewed on
    // their own, and the group endpoints would find nothing to act on.
    return this.flattenUpload(
      upload,
      true,
      upload.status === 'pending' ? 'group' : 'file',
    );
  }

  // Flatten an upload into one row per file, matching the old Supabase shape.
  /**
   * `reviewScope` says what an approve/reject on this row acts on: 'group' for
   * a whole pending upload, 'file' for a single file added to an upload that is
   * already approved. The queue renders both, so it has to know which endpoint
   * to call.
   */
  private async flattenUpload(
    upload: Upload,
    includeStatus: boolean,
    reviewScope: 'group' | 'file' = 'group',
  ) {
    const meta = {
      group_id: upload.id,
      title: upload.title,
      doc_type: upload.doc_type,
      uploaded_at: upload.uploaded_at,
      users: upload.uploader
        ? {
            id: upload.uploader.id,
            first_name: upload.uploader.first_name,
            last_name: upload.uploader.last_name,
          }
        : null,
      majors: upload.major
        ? { id: upload.major.id, acronym: upload.major.acronym }
        : null,
      /** The cohort the upload is for; the queue shows it as "I3-GIC". */
      year_level: upload.year_level,
      /** Which academic year the material belongs to, e.g. "2021-2022". */
      academic_year: upload.academic_year,
      /**
       * Who may see it, as (department, year) pairs. Empty means everyone.
       * Ids rather than acronyms: this mapper is synchronous and the reviewer
       * screens already hold the department list they need to name them.
       */
      audience: upload.audience ?? [],
      /** Soft expiry. Null = never; past means hidden from all but staff. */
      expires_at: upload.expires_at,
      subjects: upload.subject
        ? {
            id: upload.subject.id,
            name: upload.subject.name,
            // The review tables show the acronym: a subject name can be long
            // enough to push every column after it off the row.
            acronym: upload.subject.acronym,
          }
        : null,
      review_scope: reviewScope,
      ...(includeStatus ? { status: upload.status } : {}),
    };

    // Signed, not stored: the documents bucket is private. A reviewer has
    // already been authorised for this department by the guard and
    // assertCanModerate above, so signing what the query returned is covered by
    // that same decision. Presigning is local, so this adds no round trips.
    return await Promise.all(
      (upload.documents ?? []).map(async (doc) => ({
        id: doc.id,
        file_url: await this.signRef(
          doc.storage_key,
          doc.file_url,
          doc.original_name,
          this.inlineSafe(doc.storage_key),
        ),
        file_size_kb: doc.file_size_kb,
        // The approvals queue expands a submission to list — and preview — its files.
        original_name: doc.original_name,
        preview_url: await this.signRef(
          doc.preview_key,
          doc.preview_url,
          doc.original_name,
          true,
        ),
        // The FILE's own review state, distinct from `status` above (the
        // upload's). Only ever 'pending' on a review_scope: 'file' row.
        file_status: doc.status,
        ...meta,
      })),
    );
  }

  /** See DocumentsService.signOrFallback — same rule, same reasons. */
  /**
   * Types safe to serve with an inline disposition.
   *
   * A display URL must be inline or the browser saves the file instead of
   * showing it — an <object type="application/pdf"> pointed at an attachment
   * downloads on render, which is what made the admin tables' thumbnails fire
   * a save on every page load.
   *
   * Matched on the STORAGE KEY, not the uploader's filename: the key is
   * generated by this server, the filename is not. Narrow on purpose — a PDF or
   * a raster image rendered on the storage origin can only draw itself, while
   * HTML and SVG would execute there.
   *
   * Duplicated from DocumentsService.inlineSafe rather than shared: these two
   * services keep separate signing helpers, and this one was missed when the
   * rule was introduced — which is the bug being fixed here.
   */
  private inlineSafe(ref: string | null | undefined): boolean {
    return /\.(pdf|jpe?g|png|gif|webp)$/i.test(ref ?? '');
  }

  private async signRef(
    ref: string | null,
    legacyUrl: string | null,
    downloadName: string | null,
    inline = false,
  ): Promise<string | null> {
    if (ref) {
      const signed = await this.storage.signedUrlForRef(ref, {
        downloadName,
        inline,
      });
      if (signed) return signed;
    }
    return legacyUrl;
  }

  // ─── Approve / reject upload group ────────────────────────────────────────

  async approveDocumentGroup(uploadId: string, reviewer: Reviewer) {
    const upload = await this.uploads.findOne({
      where: { id: uploadId, status: 'pending' },
      select: { id: true, title: true, uploader_id: true, major_id: true },
    });

    if (!upload) return { message: 'No pending upload found' };
    this.moderation.assertCanModerate(reviewer, upload.major_id);

    try {
      await this.uploads.update(
        { id: uploadId },
        { status: 'active', reviewed_by: reviewer.id },
      );
    } catch {
      throw new InternalServerErrorException('Failed to approve upload');
    }

    const fileCount = await this.documents.count({
      where: { upload_id: uploadId },
    });

    if (upload.uploader_id) {
      void this.notificationsService.create({
        user_id: upload.uploader_id,
        type: 'document_approved',
        message:
          fileCount === 1
            ? `Your document "${upload.title}" has been approved.`
            : `Your ${fileCount} documents have been approved.`,
        key: fileCount === 1 ? 'documentApproved' : 'documentsApproved',
        params: { title: upload.title, count: fileCount },
        ref_id: uploadId,
        ref_type: 'document',
      });
    }

    return { message: 'Documents approved' };
  }

  // ─── Approve / reject a single added file ─────────────────────────────────
  // A file added to an already-approved upload is reviewed on its own: the
  // upload and its approved files never left the feed, so there is no group to
  // act on — just this one file.

  /** Load a pending file with its upload, and check the reviewer covers it. */
  private async loadPendingFile(fileId: string, reviewer: Reviewer) {
    const file = await this.documents.findOne({
      where: { id: fileId, status: 'pending' },
      relations: { upload: true },
    });

    if (!file?.upload) return null;
    this.moderation.assertCanModerate(reviewer, file.upload.major_id);
    return file;
  }

  async approveFile(fileId: string, reviewer: Reviewer) {
    const file = await this.loadPendingFile(fileId, reviewer);
    if (!file) return { message: 'No pending file found' };

    try {
      await this.documents.update(
        { id: fileId },
        { status: 'active', reviewed_by: reviewer.id, rejection_reason: null },
      );
    } catch {
      throw new InternalServerErrorException('Failed to approve file');
    }

    if (file.upload.uploader_id) {
      void this.notificationsService.create({
        user_id: file.upload.uploader_id,
        type: 'document_approved',
        message: `The file you added to "${file.upload.title}" has been approved.`,
        key: 'fileApproved',
        params: { title: file.upload.title },
        ref_id: file.upload_id,
        ref_type: 'document',
      });
    }

    return { message: 'File approved' };
  }

  /** `reason` is required — see RejectDto. */
  async rejectFile(fileId: string, reviewer: Reviewer, reason: string) {
    const file = await this.loadPendingFile(fileId, reviewer);
    if (!file) return { message: 'No pending file found' };

    const why = reason.trim();

    // The row and its object are kept, unlike a rejected group: the file never
    // reached anyone else, and leaving it intact lets the uploader open it,
    // read why it was turned down, and delete it themselves. A dead file_url
    // would just render as a broken tile on their own detail page.
    try {
      await this.documents.update(
        { id: fileId },
        {
          status: 'rejected',
          rejection_reason: why,
          reviewed_by: reviewer.id,
        },
      );
    } catch {
      throw new InternalServerErrorException('Failed to reject file');
    }

    if (file.upload.uploader_id) {
      const name = file.original_name ?? 'file';
      void this.notificationsService.create({
        user_id: file.upload.uploader_id,
        type: 'document_rejected',
        message: `The file "${name}" you added to "${file.upload.title}" was not approved. Reason: ${why}`,
        // The reason-less variants of these keys are kept in the locale files
        // on purpose: rows written before the reason was mandatory still carry
        // them, and dropping the translations would blank those notifications.
        key: 'fileRejectedReason',
        params: { name, title: file.upload.title, reason: why },
        ref_id: file.upload_id,
        ref_type: 'document',
      });
    }

    return { message: 'File rejected' };
  }

  /** `reason` is required — see RejectDto. */
  async rejectDocumentGroup(
    uploadId: string,
    reviewer: Reviewer,
    reason: string,
  ) {
    const why = reason.trim();

    const upload = await this.uploads.findOne({
      where: { id: uploadId, status: 'pending' },
      select: { id: true, title: true, uploader_id: true, major_id: true },
    });

    if (!upload) return { message: 'No pending upload found' };
    this.moderation.assertCanModerate(reviewer, upload.major_id);

    const files = await this.documents.find({
      where: { upload_id: uploadId },
      select: { id: true },
    });

    /**
     * The upload and its files move together, in one transaction.
     *
     * Only the upload row used to be marked, which left its files reading
     * 'active' underneath a rejected upload — rows claiming to be live whose
     * bytes were already deleted. Nothing noticed, because every lookup checks
     * the upload's status first, but any query that filtered files by their own
     * status would have taken them for real.
     *
     * The files are NOT deleted from storage here. They are kept for the
     * retention window and removed by purgeRejectedUploads, so a rejection can
     * be questioned, or reversed, while the bytes still exist.
     */
    const rejectedAt = new Date();
    try {
      await this.uploads.manager.transaction(async (tx) => {
        await tx.update(
          Upload,
          { id: uploadId },
          {
            status: 'rejected',
            rejection_reason: why,
            rejected_at: rejectedAt,
            reviewed_by: reviewer.id,
          },
        );

        if (files.length)
          await tx.update(
            DocumentFile,
            { upload_id: uploadId },
            {
              status: 'rejected',
              rejection_reason: why,
              reviewed_by: reviewer.id,
            },
          );
      });
    } catch {
      throw new InternalServerErrorException('Failed to reject upload');
    }

    const fileCount = files.length || 1;

    if (upload.uploader_id) {
      void this.notificationsService.create({
        user_id: upload.uploader_id,
        type: 'document_rejected',
        // Names the document when there is only one, matching the approval.
        message:
          fileCount > 1
            ? `Your ${fileCount} documents were not approved. Reason: ${why}`
            : `Your document "${upload.title}" was not approved. Reason: ${why}`,
        key:
          fileCount > 1 ? 'documentsRejectedReason' : 'documentRejectedReason',
        params: { title: upload.title, count: fileCount, reason: why },
        ref_id: uploadId,
        ref_type: 'document',
      });
    }

    return { message: 'Documents rejected' };
  }

  // ─── Admin delete upload ───────────────────────────────────────────────────

  /**
   * Delete the files of uploads rejected longer ago than the retention window.
   *
   * Rejection keeps the bytes so a decision can be questioned; this is what
   * eventually makes it real. Driven by the hourly sweep in AdminScheduler.
   *
   * Rows are CLAIMED before anything is deleted — one UPDATE that stamps
   * `files_purged_at` and returns what it stamped. Production runs two backend
   * replicas, so both fire this cron: without the claim they would both read
   * the same batch and both try to delete it. The stamp is the lock, and
   * Postgres settles the race.
   *
   * If storage then refuses, the claim is released so the next sweep retries.
   * The alternative — leaving it stamped — would quietly abandon those objects
   * in the bucket with nothing left pointing at them.
   */
  async purgeRejectedUploads(now: Date = new Date()) {
    const cutoff = new Date(now.getTime() - REJECTED_FILE_RETENTION_MS);

    const claim = await this.uploads
      .createQueryBuilder()
      .update(Upload)
      .set({ files_purged_at: now })
      .where('status = :rejected', { rejected: 'rejected' })
      .andWhere('files_purged_at IS NULL')
      .andWhere('rejected_at IS NOT NULL')
      .andWhere('rejected_at <= :cutoff', { cutoff })
      .returning('id')
      .execute();

    const ids = (claim.raw as { id: string }[]).map((row) => row.id);
    if (!ids.length) return { purged: 0, files: 0 };

    const files = await this.documents.find({
      where: { upload_id: In(ids) },
      select: { file_url: true },
    });
    const keys = files
      .map((f) => this.storage.extractKey(f.file_url))
      .filter((k): k is string => k !== null);

    try {
      if (keys.length) await this.storage.remove(keys);
    } catch (err) {
      await this.uploads.update({ id: In(ids) }, { files_purged_at: null });
      throw err;
    }

    return { purged: ids.length, files: keys.length };
  }

  async deleteDocument(uploadId: string) {
    const upload = await this.uploads.findOne({
      where: { id: uploadId },
      select: { id: true },
    });

    if (!upload) throw new NotFoundException('Upload not found');

    const files = await this.documents.find({
      where: { upload_id: uploadId },
      select: { file_url: true },
    });
    const keys = files
      .map((f) => this.storage.extractKey(f.file_url))
      .filter((k): k is string => k !== null);
    if (keys.length) await this.storage.remove(keys);

    // CASCADE removes documents
    try {
      await this.uploads.delete({ id: uploadId });
    } catch {
      throw new InternalServerErrorException('Failed to delete upload');
    }

    return { message: 'Upload deleted' };
  }
}
