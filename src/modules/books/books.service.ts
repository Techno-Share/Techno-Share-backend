import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { Book } from './entities/book.entity';
import { BookRequest } from './entities/book-request.entity';
import { Notification } from '../notifications/entities/notification.entity';
import { User } from '../users/entities/user.entity';
import { BUCKETS, StorageService } from '../storage/storage.service';
import { pgCode } from '../../common/utils/pg-error';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateBookDto } from './dto/create-book.dto';
import { UpdateBookDto } from './dto/update-book.dto';
import { CreateRequestDto } from './dto/create-request.dto';

@Injectable()
export class BooksService {
  constructor(
    @InjectRepository(Book)
    private readonly books: Repository<Book>,
    @InjectRepository(BookRequest)
    private readonly requests: Repository<BookRequest>,
    @InjectRepository(Notification)
    private readonly notificationsRepo: Repository<Notification>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly storage: StorageService,
    private readonly notifications: NotificationsService,
    private readonly dataSource: DataSource,
  ) {}

  // Shape a Book (+ donor + major relations) like the old Supabase BOOK_SELECT.
  /**
   * Whether the two sides may see each other's Telegram.
   *
   * Only while the handover is actually pending. Before acceptance a request is
   * a stranger asking for a book, and neither party has agreed to be contacted;
   * once the receiver confirms they have it, the reason to be in touch is gone,
   * so the details stop being returned rather than lingering on a finished
   * exchange.
   */
  private static readonly SHARED_STATUSES = ['accepted'];
  private shared(status: string) {
    return BooksService.SHARED_STATUSES.includes(status);
  }

  private bookShape(b: Book) {
    return {
      id: b.id,
      title: b.title,
      description: b.description,
      status: b.status,
      /** Non-null when an admin hid it. Only reachable in the donor's own list. */
      hidden_at: b.hidden_at,
      cover_image_url: b.cover_image_url,
      created_at: b.created_at,
      majors: b.major ? { id: b.major.id, acronym: b.major.acronym } : null,
      users: b.donor
        ? {
            id: b.donor.id,
            first_name: b.donor.first_name,
            last_name: b.donor.last_name,
            avatar_url: b.donor.avatar_url,
          }
        : null,
    };
  }

  private async loadBookShape(id: string) {
    const book = await this.books.findOne({
      where: { id },
      relations: { donor: true, major: true },
    });
    return book ? this.bookShape(book) : null;
  }

  // ─── Donate (list) a book ──────────────────────────────────────────────────

  async donate(donorId: string, dto: CreateBookDto) {
    let saved: Book;
    try {
      saved = await this.books.save(
        this.books.create({
          donor_id: donorId,
          // '' is the "Other" choice — stored as no department at all.
          major_id: dto.department || null,
          title: dto.title,
          description: dto.description ?? null,
          cover_image_url: dto.cover_image_url ?? null,
          status: 'available',
        }),
      );
    } catch (err) {
      if (pgCode(err) === '23503')
        throw new BadRequestException('Invalid department');
      throw new InternalServerErrorException('Failed to list book');
    }

    return this.loadBookShape(saved.id);
  }

  // ─── List available books ──────────────────────────────────────────────────

  async findAll(
    majorId?: string,
    page?: number,
    limit?: number,
    viewerId?: string,
  ) {
    // Opt-in pagination: skip/take only when a limit is given, so callers that
    // don't page still receive every match. `total` always reflects the full
    // filtered set so a pager can compute its page count.
    const currentPage = page && page > 0 ? page : 1;

    let books: Book[];
    let total: number;
    try {
      const qb = this.books
        .createQueryBuilder('b')
        .leftJoinAndSelect('b.donor', 'donor')
        .leftJoinAndSelect('b.major', 'major')
        .where('b.status = :status', { status: 'available' })
        // Hidden by an admin — out of the public list, but still the donor's
        // book, so it stays in "My books" and is not deleted.
        .andWhere('b.hidden_at IS NULL')
        /**
         * A pending request makes a book unrequestable without changing its
         * status, so for anyone else it would sit in the list unable to be
         * acted on. The two people it still concerns keep seeing it: the donor,
         * who has a request to answer, and the requester, who is waiting.
         *
         * 'reserved' and 'donated' are already excluded by the status filter.
         * In SQL, not after the fetch, so paging counts stay right.
         */
        .andWhere(
          `(
             not exists (
               select 1 from book_requests r
                where r.book_id = b.id and r.status = 'pending'
             )
             or b.donor_id = :viewerId
             or exists (
               select 1 from book_requests r
                where r.book_id = b.id
                  and r.status = 'pending'
                  and r.requester_id = :viewerId
             )
           )`,
          // Null for a viewerless call: both equality checks then fail, which
          // is the strict "hide anything spoken for" reading.
          { viewerId: viewerId ?? null },
        )
        .orderBy('b.created_at', 'DESC')
        // Unique tiebreaker so rows sharing a created_at can't shift between
        // pages under skip/take.
        .addOrderBy('b.id', 'ASC');
      if (majorId) qb.andWhere('b.major_id = :majorId', { majorId });
      if (limit && limit > 0) qb.skip((currentPage - 1) * limit).take(limit);
      [books, total] = await qb.getManyAndCount();
    } catch {
      throw new InternalServerErrorException('Failed to fetch books');
    }

    // Active-request lookup is scoped to the books on this page.
    const bookIds = books.map((b) => b.id);
    const activeBookIds = new Set<string>();
    if (bookIds.length) {
      const activeRequests = await this.requests.find({
        where: { book_id: In(bookIds), status: In(['pending', 'accepted']) },
        select: { book_id: true },
      });
      for (const r of activeRequests) activeBookIds.add(r.book_id);
    }

    const items = books.map((b) => ({
      ...this.bookShape(b),
      has_active_request: activeBookIds.has(b.id),
    }));
    return { items, total, page: currentPage, limit: limit ?? total };
  }

  // ─── Get single book ───────────────────────────────────────────────────────

  async findOne(id: string, viewerId?: string) {
    const book = await this.books.findOne({
      where: { id },
      relations: { donor: true, major: true },
    });

    if (!book) throw new NotFoundException('Book not found');
    // 404 rather than 403: a hidden listing should not be confirmed to exist.
    if (book.hidden_at) throw new NotFoundException('Book not found');

    const activeRequest = await this.requests.findOne({
      where: { book_id: id, status: In(['pending', 'accepted']) },
      select: { id: true, status: true, requester_id: true },
    });

    /**
     * Who is waiting, for the donor only — it is their request to answer, and
     * nobody else has any business knowing who asked. Pending rather than any
     * active request: once accepted the book is reserved and the handover has
     * its own screen.
     */
    let pending_request: {
      id: string;
      requester: { first_name: string; last_name: string };
    } | null = null;

    if (
      activeRequest?.status === 'pending' &&
      viewerId &&
      book.donor_id === viewerId
    ) {
      const requester = await this.users.findOne({
        where: { id: activeRequest.requester_id },
        select: { first_name: true, last_name: true },
      });
      if (requester)
        pending_request = {
          id: activeRequest.id,
          requester: {
            first_name: requester.first_name,
            last_name: requester.last_name,
          },
        };
    }

    return {
      ...this.bookShape(book),
      has_active_request: !!activeRequest,
      pending_request,
    };
  }

  // ─── Update own book ───────────────────────────────────────────────────────

  /**
   * A book with someone waiting on an answer is frozen: editing it would change
   * what they asked for, and deleting it would drop the request silently.
   * `status` alone cannot express this — a requested book is still 'available'
   * until the donor accepts.
   */
  /**
   * The donor may not edit or delete a book once it is out of their hands:
   * reserved means someone is on their way to collect it, donated means they
   * already have. Admins are unaffected — they have their own routes.
   */
  private assertNotLocked(status: string) {
    if (status === 'reserved')
      throw new BadRequestException(
        'This book is reserved for someone — decline the request first',
      );
    if (status === 'donated')
      throw new BadRequestException('Donated books cannot be changed');
  }

  private async assertNoPendingRequest(bookId: string) {
    const pending = await this.requests.count({
      where: { book_id: bookId, status: 'pending' },
    });
    if (pending)
      throw new BadRequestException(
        'This book has a pending request — answer it first',
      );
  }

  async update(id: string, userId: string, dto: UpdateBookDto) {
    const book = await this.books.findOne({
      where: { id },
      select: { id: true, donor_id: true, status: true },
    });

    if (!book) throw new NotFoundException('Book not found');
    if (book.donor_id !== userId) throw new ForbiddenException('Not your book');
    this.assertNotLocked(book.status);
    await this.assertNoPendingRequest(id);

    const { department, ...rest } = dto;
    const patch: Partial<Book> = { ...rest };
    // undefined leaves it alone; '' clears it, which is how "Other" is saved.
    if (department !== undefined) patch.major_id = department || null;

    try {
      await this.books.update({ id }, patch);
    } catch {
      throw new InternalServerErrorException('Failed to update book');
    }
    return this.loadBookShape(id);
  }

  // ─── Delete own book ───────────────────────────────────────────────────────

  async remove(id: string, userId: string) {
    const book = await this.books.findOne({
      where: { id },
      select: { id: true, donor_id: true, status: true },
    });

    if (!book) throw new NotFoundException('Book not found');
    if (book.donor_id !== userId) throw new ForbiddenException('Not your book');
    this.assertNotLocked(book.status);
    await this.assertNoPendingRequest(id);

    // Remove notifications that point to this book's requests — once the book
    // (and its requests, via cascade) is deleted they'd become dead links that
    // 404 when a recipient opens them.
    const reqs = await this.requests.find({
      where: { book_id: id },
      select: { id: true },
    });
    const reqIds = reqs.map((r) => r.id);
    if (reqIds.length) {
      await this.notificationsRepo.delete({
        ref_type: 'book_request',
        ref_id: In(reqIds),
      });
    }

    try {
      await this.books.delete({ id });
    } catch {
      throw new InternalServerErrorException('Failed to delete book');
    }

    return { message: 'Book deleted' };
  }

  // ─── Request a book ────────────────────────────────────────────────────────

  async request(bookId: string, requesterId: string, dto: CreateRequestDto) {
    const book = await this.books.findOne({
      where: { id: bookId },
      select: {
        id: true,
        donor_id: true,
        status: true,
        title: true,
        hidden_at: true,
      },
    });

    if (!book || book.hidden_at)
      // 404, not 403: a hidden listing should not be confirmed to exist.
      throw new NotFoundException('Book not found');
    if (book.status !== 'available')
      throw new BadRequestException(
        book.status === 'reserved'
          ? 'This book is reserved for someone else'
          : 'Book is not available',
      );
    if (book.donor_id === requesterId)
      throw new ForbiddenException('You cannot request your own book');

    const existing = await this.requests.findOne({
      where: { book_id: bookId, status: In(['pending', 'accepted']) },
      select: { id: true },
    });

    if (existing)
      throw new BadRequestException('This book already has an active request');

    /**
     * A refusal is final for this pairing.
     *
     * Without this, the only thing "decline" bought a donor was a moment's
     * quiet — the same person could ask again immediately, and every re-ask
     * notifies them afresh. Scoped to this requester, so a decline never takes
     * the book away from anyone else.
     */
    const refused = await this.requests.findOne({
      where: { book_id: bookId, requester_id: requesterId, status: 'declined' },
      select: { id: true },
    });

    if (refused)
      throw new ForbiddenException(
        'You cannot request this book again — the owner declined your earlier request',
      );

    const requester = await this.users.findOne({
      where: { id: requesterId },
      select: { first_name: true, last_name: true },
    });

    // No Telegram needed to request. Contact runs one way — the receiver
    // reaches out to the donor once accepted — so the requester's handle is
    // never used and requiring it only blocked people for nothing.

    let saved: BookRequest;
    try {
      saved = await this.requests.save(
        this.requests.create({
          book_id: bookId,
          requester_id: requesterId,
          message: dto.message ?? null,
          status: 'pending',
        }),
      );
    } catch {
      throw new InternalServerErrorException('Failed to create request');
    }

    const requesterName = requester
      ? `${requester.first_name} ${requester.last_name}`
      : 'Someone';

    this.notifications
      .create({
        user_id: book.donor_id,
        type: 'book_request',
        message: `${requesterName} requested your book "${book.title}".`,
        key: 'bookRequest',
        params: { name: requesterName, title: book.title },
        ref_id: saved.id,
        ref_type: 'book_request',
      })
      .catch(() => {});

    return {
      id: saved.id,
      book_id: saved.book_id,
      requester_id: saved.requester_id,
      message: saved.message,
      status: saved.status,
    };
  }

  // ─── Accept a request (reveal contact, mark donated) ───────────────────────

  /**
   * Donor accepts a request and says where to meet.
   *
   * The book becomes RESERVED, not donated — the handover has not happened yet.
   * Only the receiver can close that out, with complete().
   *
   * Transactional because three things must agree or none of them should hold:
   * the request becomes accepted, the book becomes reserved, and every rival
   * pending request is declined. A half-applied version of that leaves a book
   * reserved for two people, or reserved for nobody.
   */
  async accept(bookId: string, requestId: string, userId: string) {
    const donor = await this.users.findOne({
      where: { id: userId },
      select: { telegram: true },
    });

    if (!donor?.telegram)
      throw new BadRequestException(
        'Add your Telegram to your profile before accepting a request',
      );

    const losers: string[] = [];

    await this.dataSource.transaction(async (manager) => {
      const books = manager.getRepository(Book);
      const requests = manager.getRepository(BookRequest);

      const book = await books
        .createQueryBuilder('b')
        .setLock('pessimistic_write')
        .where('b.id = :id', { id: bookId })
        .getOne();

      if (!book) throw new NotFoundException('Book not found');
      if (book.donor_id !== userId)
        throw new ForbiddenException('Only the donor can accept requests');
      if (book.status !== 'available')
        throw new BadRequestException(
          book.status === 'reserved'
            ? 'This book is already reserved'
            : 'This book has already been donated',
        );

      const req = await requests.findOne({
        where: { id: requestId, book_id: bookId },
      });
      if (!req) throw new NotFoundException('Request not found');
      if (req.status !== 'pending')
        throw new BadRequestException('Request is no longer pending');

      const now = new Date();
      await requests.update(
        { id: requestId },
        {
          status: 'accepted',
          resolved_at: now,
          accepted_at: now,
        },
      );
      await books.update({ id: bookId }, { status: 'reserved' });

      const rivals = await requests.find({
        where: { book_id: bookId, status: 'pending' },
        select: { id: true, requester_id: true },
      });
      for (const rival of rivals) {
        if (rival.id === requestId) continue;
        await requests.update(
          { id: rival.id },
          {
            status: 'declined',
            resolved_at: now,
            decline_reason: 'The book was given to someone else',
          },
        );
        losers.push(rival.requester_id);
      }

      return req;
    });

    const book = await this.books.findOne({
      where: { id: bookId },
      select: { title: true },
    });
    const req = await this.requests.findOne({
      where: { id: requestId },
      select: { requester_id: true },
    });

    if (req)
      this.notifications
        .create({
          user_id: req.requester_id,
          type: 'book_accepted',
          message: `Your request for "${book?.title ?? 'a book'}" was accepted! Contact the book owner on Telegram to arrange the handover.`,
          key: 'bookAccepted',
          params: { title: book?.title ?? 'a book' },
          ref_id: requestId,
          ref_type: 'book_request',
        })
        .catch(() => {});

    for (const loser of losers) {
      this.notifications
        .create({
          user_id: loser,
          type: 'book_declined',
          message: `"${book?.title ?? 'A book'}" is no longer available. It was given to another student.`,
          key: 'bookGivenToAnother',
          params: { title: book?.title ?? 'A book' },
          ref_id: bookId,
          ref_type: 'book',
        })
        .catch(() => {});
    }

    return { message: 'Request accepted', status: 'reserved' };
  }

  /**
   * Call off a reservation, from either side.
   *
   * The only way a reservation ends without a handover. Either side may call
   * it: the receiver went quiet, or the donor changed their mind. Both routes
   * end the same way — the request is cancelled and the book goes back on the
   * shelf.
   *
   * Nothing releases a reservation on a timer, so a book stays reserved until
   * one of the two people involved says otherwise.
   *
   * Distinct from decline, which is the donor turning down a request they have
   * not yet accepted.
   */
  async cancel(bookId: string, requestId: string, userId: string) {
    let title = 'a book';
    let notify = '';

    await this.dataSource.transaction(async (manager) => {
      const books = manager.getRepository(Book);
      const requests = manager.getRepository(BookRequest);

      const req = await requests.findOne({
        where: { id: requestId, book_id: bookId },
      });
      if (!req) throw new NotFoundException('Request not found');

      const book = await books
        .createQueryBuilder('b')
        .setLock('pessimistic_write')
        .where('b.id = :id', { id: bookId })
        .getOne();
      if (!book) throw new NotFoundException('Book not found');

      const isRequester = req.requester_id === userId;
      const isDonor = book.donor_id === userId;
      if (!isRequester && !isDonor)
        throw new ForbiddenException('This is not your request');

      // Only a live reservation can be called off. Declined, expired and
      // completed ones are already finished.
      if (req.status !== 'pending' && req.status !== 'accepted')
        throw new BadRequestException('This request is no longer active');

      const now = new Date();
      await requests.update(
        { id: requestId },
        { status: 'cancelled', cancelled_at: now, resolved_at: now },
      );
      // Back on the shelf. Pending requests never moved the book off it, so
      // this is only a real change for an accepted one.
      await books.update({ id: bookId }, { status: 'available' });

      title = book.title;
      // Tell the other party, not the one who just clicked cancel.
      notify = isRequester ? book.donor_id : req.requester_id;
    });

    if (notify)
      this.notifications
        .create({
          user_id: notify,
          type: 'book_request_cancelled',
          message: `The handover for "${title}" was cancelled. The book is available again.`,
          key: 'bookHandoverCancelled',
          params: { title },
          ref_id: bookId,
          ref_type: 'book',
        })
        .catch(() => {});

    return { message: 'Reservation cancelled', status: 'available' };
  }

  // ─── Receiver confirms the handover ────────────────────────────────────────

  /**
   * The receiver confirms the book physically changed hands. This — not
   * acceptance — is what marks a book donated.
   *
   * Only the requester may call it: the donor saying "I handed it over" is a
   * claim, the receiver saying "I have it" is the fact.
   */
  async complete(bookId: string, requestId: string, userId: string) {
    let title = 'a book';
    let donorId = '';

    await this.dataSource.transaction(async (manager) => {
      const books = manager.getRepository(Book);
      const requests = manager.getRepository(BookRequest);

      const req = await requests.findOne({
        where: { id: requestId, book_id: bookId },
      });
      if (!req) throw new NotFoundException('Request not found');
      if (req.requester_id !== userId)
        throw new ForbiddenException(
          'Only the person receiving the book can confirm this',
        );
      if (req.status !== 'accepted')
        throw new BadRequestException(
          req.status === 'completed'
            ? 'This handover is already confirmed'
            : 'This request has not been accepted',
        );

      const book = await books
        .createQueryBuilder('b')
        .setLock('pessimistic_write')
        .where('b.id = :id', { id: bookId })
        .getOne();
      if (!book) throw new NotFoundException('Book not found');

      title = book.title;
      donorId = book.donor_id;

      const now = new Date();
      await requests.update(
        { id: requestId },
        { status: 'completed', completed_at: now },
      );
      await books.update({ id: bookId }, { status: 'donated' });
    });

    this.notifications
      .create({
        user_id: donorId,
        type: 'book_received',
        message: `Your book "${title}" has been received. Thank you for giving it a new life!`,
        key: 'bookReceived',
        params: { title },
        ref_id: requestId,
        ref_type: 'book_request',
      })
      .catch(() => {});

    return { message: 'Handover confirmed', status: 'donated' };
  }

  // ─── Decline a request ─────────────────────────────────────────────────────

  async decline(
    bookId: string,
    requestId: string,
    userId: string,
    reason: string,
  ) {
    const book = await this.books.findOne({
      where: { id: bookId },
      select: { id: true, donor_id: true, title: true },
    });

    if (!book) throw new NotFoundException('Book not found');
    if (book.donor_id !== userId)
      throw new ForbiddenException('Only the donor can decline requests');

    const req = await this.requests.findOne({
      where: { id: requestId, book_id: bookId },
      select: { id: true, requester_id: true, status: true },
    });

    if (!req) throw new NotFoundException('Request not found');
    if (req.status !== 'pending')
      throw new BadRequestException('Request is no longer pending');

    await this.requests.update(
      { id: requestId },
      {
        status: 'declined',
        resolved_at: new Date(),
        decline_reason: reason.trim(),
      },
    );

    // The reason is not repeated here — it is required on every decline and is
    // shown in full on the notification's detail page.
    const declineMessage = `Your request for "${book.title}" was declined.`;

    this.notifications
      .create({
        user_id: req.requester_id,
        type: 'book_declined',
        message: declineMessage,
        key: 'bookDeclined',
        params: { title: book.title },
        ref_id: requestId,
        ref_type: 'book_request',
      })
      .catch(() => {});

    return { message: 'Request declined' };
  }

  // ─── Incoming requests on the donor's books (Dashboard) ────────────────────

  async getIncomingRequests(userId: string) {
    const myBooks = await this.books.find({
      where: { donor_id: userId },
      select: { id: true },
    });
    const myBookIds = myBooks.map((b) => b.id);
    if (myBookIds.length === 0) return [];

    let rows: BookRequest[];
    try {
      rows = await this.requests.find({
        where: { book_id: In(myBookIds) },
        relations: { book: true, requester: true },
        order: { requested_at: 'DESC' },
      });
    } catch {
      throw new InternalServerErrorException('Failed to fetch requests');
    }

    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      message: row.message,
      /**
       * Always null. This list is donor-facing, and contact runs one way: the
       * receiver reaches out. It previously returned the donor their own
       * handle, which told them nothing.
       */
      contact: null,
      requested_at: row.requested_at,
      resolved_at: row.resolved_at,
      accepted_at: row.accepted_at,
      completed_at: row.completed_at,
      book: {
        id: row.book?.id,
        title: row.book?.title,
        cover_image_url: row.book?.cover_image_url,
      },
      requester: {
        id: row.requester?.id,
        first_name: row.requester?.first_name,
        last_name: row.requester?.last_name,
        avatar_url: row.requester?.avatar_url,
      },
    }));
  }

  // ─── Books I donated (with their active request, if any) ───────────────────

  async getMyBooks(
    userId: string,
    filter:
      | 'all'
      | 'pending'
      | 'donated'
      | 'available'
      | 'received'
      | 'reserved' = 'all',
  ) {
    // For the "pending requests" filter, narrow to the books that currently
    // have a pending incoming request — resolved in the DB, not the browser.
    let pendingBookIds: string[] | null = null;
    if (filter === 'pending') {
      const reqRows = await this.requests
        .createQueryBuilder('r')
        .innerJoin('r.book', 'b')
        .select('r.book_id', 'book_id')
        .where('r.status = :status', { status: 'pending' })
        .andWhere('b.donor_id = :userId', { userId })
        .getRawMany<{ book_id: string }>();
      pendingBookIds = [...new Set(reqRows.map((r) => r.book_id))];
      if (!pendingBookIds.length) return [];
    }

    let books: Book[];
    try {
      /**
       * Your shelf is what you hold, not only what you listed: a book you have
       * received joins the books you are giving away.
       *
       * donor_id is deliberately left alone — rewriting it would erase who gave
       * the book, which is exactly what the donor's own card reports.
       */
      const qb = this.books
        .createQueryBuilder('b')
        .leftJoinAndSelect('b.major', 'major')
        .leftJoinAndSelect('b.donor', 'donor')
        .where(
          `(b.donor_id = :userId
            or exists (
              select 1 from book_requests r
               where r.book_id = b.id
                 and r.requester_id = :userId
                 and r.status = 'completed'
            ))`,
          { userId },
        )
        .orderBy('b.created_at', 'DESC');
      /**
       * Donated means "given away BY you". The donor_id test matters now that
       * the shelf also holds books you were given — those are donated too, and
       * would otherwise show up under the wrong heading.
       */
      if (filter === 'donated')
        qb.andWhere('b.status = :status', { status: 'donated' }).andWhere(
          'b.donor_id = :userId',
          { userId },
        );
      // The other side of the same handover: books given TO you.
      if (filter === 'received')
        qb.andWhere('b.donor_id != :userId', { userId });
      // Accepted and waiting on the receiver to confirm — your handovers in
      // flight, which is why they get their own Book Activity entry.
      if (filter === 'reserved')
        qb.andWhere('b.status = :status', { status: 'reserved' }).andWhere(
          'b.donor_id = :userId',
          { userId },
        );
      // The complement of donated: still up for grabs.
      if (filter === 'available')
        qb.andWhere('b.status = :status', { status: 'available' });
      if (pendingBookIds)
        qb.andWhere('b.id IN (:...pendingBookIds)', { pendingBookIds });
      books = await qb.getMany();
    } catch {
      throw new InternalServerErrorException('Failed to fetch your books');
    }

    const bookIds = books.map((b) => b.id);
    const reqByBook: Record<string, BookRequest> = {};
    if (bookIds.length) {
      /**
       * 'completed' included: once the receiver confirms, the request leaves
       * 'accepted', and without it a donated book arrived with no request
       * attached — so the card could only say "Donated" and never who got it.
       */
      const reqs = await this.requests.find({
        where: {
          book_id: In(bookIds),
          status: In(['pending', 'accepted', 'completed']),
        },
        relations: { requester: true },
        order: { requested_at: 'DESC' },
      });
      for (const r of reqs) {
        // keep the most relevant active request per book (latest first)
        if (!reqByBook[r.book_id]) reqByBook[r.book_id] = r;
      }
    }

    return books.map((b) => {
      const r = reqByBook[b.id];
      // Which side of the handover you are on, for a list that now holds both.
      const role = b.donor_id === userId ? 'donor' : 'receiver';
      return {
        id: b.id,
        role,
        /** Who gave it to you. Null on your own listings. */
        donor:
          role === 'receiver' && b.donor
            ? {
                id: b.donor.id,
                first_name: b.donor.first_name,
                last_name: b.donor.last_name,
              }
            : null,
        title: b.title,
        description: b.description,
        cover_image_url: b.cover_image_url,
        status: b.status,
        /**
         * Set when an admin hid the listing. Included so the donor is told
         * their book is out of circulation, rather than wondering why nobody
         * can see it — this list is the only place they can find that out.
         */
        hidden_at: b.hidden_at,
        created_at: b.created_at,
        majors: b.major ? { id: b.major.id, acronym: b.major.acronym } : null,
        request: r
          ? {
              id: r.id,
              status: r.status,
              message: r.message,
              /**
               * Always null. Contact runs one way — the receiver reaches out to
               * arrange collection — so the donor is never handed the
               * requester's Telegram, not even after accepting.
               */
              contact: null,
              requested_at: r.requested_at,
              requester: {
                id: r.requester?.id,
                first_name: r.requester?.first_name,
                last_name: r.requester?.last_name,
                avatar_url: r.requester?.avatar_url,
              },
            }
          : null,
      };
    });
  }

  // ─── Dashboard counts (cheap COUNT queries, no rows fetched) ───────────────

  async getBookStats(userId: string) {
    const [listed, donated, received, pendingIncoming] = await Promise.all([
      // Everything you have put up, whatever became of it.
      this.books.count({ where: { donor_id: userId } }),
      // The subset that actually changed hands.
      this.books.count({ where: { donor_id: userId, status: 'donated' } }),
      /**
       * 'completed', not 'accepted': accepted means reserved for you, a book you
       * are still going to collect. The count read 0 for anyone who had actually
       * finished a handover, because confirming receipt is exactly what moves
       * the request off 'accepted'.
       */
      this.requests.count({
        where: { requester_id: userId, status: 'completed' },
      }),
      this.requests
        .createQueryBuilder('r')
        .innerJoin('r.book', 'b')
        .where('r.status = :status', { status: 'pending' })
        .andWhere('b.donor_id = :userId', { userId })
        .getCount(),
    ]);

    return { listed, donated, received, pendingIncoming };
  }

  // ─── Books I requested (outgoing requests) ─────────────────────────────────

  async getOutgoingRequests(
    userId: string,
    status?: 'pending' | 'accepted' | 'declined',
  ) {
    let rows: BookRequest[];
    try {
      const qb = this.requests
        .createQueryBuilder('r')
        .leftJoinAndSelect('r.book', 'book')
        .leftJoinAndSelect('book.donor', 'donor')
        .where('r.requester_id = :userId', { userId })
        .orderBy('r.requested_at', 'DESC');
      if (status) qb.andWhere('r.status = :status', { status });
      rows = await qb.getMany();
    } catch {
      throw new InternalServerErrorException('Failed to fetch your requests');
    }

    return rows.map((row) => {
      const book = row.book;
      const donor = book?.donor;
      return {
        id: row.id,
        status: row.status,
        requested_at: row.requested_at,
        // Donor's Telegram, revealed to the requester once accepted.
        contact: this.shared(row.status)
          ? (book?.donor?.telegram ?? null)
          : null,
        accepted_at: row.accepted_at,
        completed_at: row.completed_at,
        book: {
          id: book?.id,
          title: book?.title,
          description: book?.description ?? null,
          cover_image_url: book?.cover_image_url,
        },
        donor: {
          id: donor?.id,
          first_name: donor?.first_name,
          last_name: donor?.last_name,
          avatar_url: donor?.avatar_url,
        },
      };
    });
  }

  // ─── Single request detail (notification detail page) ──────────────────────

  async getRequestDetail(requestId: string, userId: string) {
    let row: BookRequest | null;
    try {
      row = await this.requests.findOne({
        where: { id: requestId },
        relations: { book: { donor: true }, requester: true },
      });
    } catch (err) {
      throw new InternalServerErrorException(String(err));
    }
    if (!row) throw new NotFoundException('Request not found');

    const book = row.book;
    const requester = row.requester;
    const donor = book?.donor;
    const isDonor = book?.donor_id === userId;
    const isRequester = requester?.id === userId;
    if (!isDonor && !isRequester)
      throw new ForbiddenException('Not your request');

    const accepted = row.status === 'accepted';

    return {
      id: row.id,
      role: isDonor ? 'donor' : 'requester',
      status: row.status,
      message: row.message,
      requested_at: row.requested_at,
      resolved_at: row.resolved_at,
      decline_reason: row.decline_reason,
      book: {
        id: book?.id,
        title: book?.title,
        description: book?.description ?? null,
        cover_image_url: book?.cover_image_url,
      },
      requester: {
        id: requester?.id,
        first_name: requester?.first_name,
        last_name: requester?.last_name,
        avatar_url: requester?.avatar_url,
      },
      donor: {
        id: donor?.id ?? book?.donor_id,
        first_name: donor?.first_name,
        last_name: donor?.last_name,
        avatar_url: donor?.avatar_url,
      },
      /**
       * The other person's Telegram, revealed only from acceptance onwards:
       * the donor gets the requester's, the requester gets the donor's. Both
       * come from the profile — nothing is copied onto the request any more.
       */
      /**
       * Only the receiver is given a handle, and only once accepted: they are
       * the one who arranges collection. A donor viewing this gets null.
       */
      contact: accepted && !isDonor ? (donor?.telegram ?? null) : null,
    };
  }

  // ─── Upload cover image ────────────────────────────────────────────────────

  async uploadCover(userId: string, file: Express.Multer.File) {
    const ext = file.originalname.split('.').pop();
    const key = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    try {
      const url = await this.storage.upload(
        BUCKETS.BOOK_COVERS,
        key,
        file.buffer,
        file.mimetype,
      );
      return { url };
    } catch {
      throw new InternalServerErrorException('Cover image upload failed');
    }
  }
}
