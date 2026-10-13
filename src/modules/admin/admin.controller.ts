import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Request,
  UseGuards,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from './guards/admin.guard';
// `import type` because it appears in decorated signatures: with
// emitDecoratorMetadata a value import would be emitted and fail at runtime.
import type { ReviewerRequest } from './guards/reviewer.guard';
import { AdminService } from './admin.service';
import { PromotionSettingsService } from '../settings/promotion-settings.service';
import { SetPromotionDto } from './dto/set-promotion.dto';
import { ModerationService } from './moderation.service';
import { EditSubjectDto } from './dto/edit-subject.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { IMAGE_UPLOAD_OPTIONS } from '../../common/upload/image-upload.options';
import {
  BanUserDto,
  SetUserPlacementDto,
  SetUserRoleDto,
} from './dto/user-admin.dto';
import { SetBookHiddenDto } from './dto/book-admin.dto';
import {
  ListDocumentsDto,
  ListSubjectsDto,
  ListUsersDto,
} from './dto/list-admin.dto';
import { RateLimitTier } from '../../common/rate-limit/rate-limit.decorator';

// Admin-only, without exception — the class guard is the whole boundary.
//
// The review queue lives in ModerationController, which department moderators
// can reach. It is a separate class on purpose: Nest guards accumulate, so a
// per-route @UseGuards(ReviewerGuard) here would ADD to AdminGuard rather than
// replace it, and moderators would keep being rejected by a rule nobody meant
// to apply to them.
@Controller('admin')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly moderation: ModerationService,
    private readonly promotionSettings: PromotionSettingsService,
  ) {}

  // ── Promotion schedule ────────────────────────────────────────────────
  // When the whole institute moves up a year. Admin-only: it changes every
  // student's year level, which decides what they can see.

  /** GET /admin/promotion — the scheduled rollover, if any. */
  @Get('promotion')
  getPromotionSchedule() {
    return this.promotionSettings.get();
  }

  /**
   * PUT /admin/promotion — body: { rollover_at: string | null }
   *
   * An ISO instant schedules one rollover; null clears it. Students advance
   * lazily, on their next visit after the moment passes, so nothing happens on
   * the stroke of the clock and nobody is missed for being away.
   */
  @Put('promotion')
  setPromotionSchedule(
    @Request() req: ReviewerRequest,
    @Body() dto: SetPromotionDto,
  ) {
    return this.promotionSettings.set(dto.rollover_at ?? null, req.user!.sub!);
  }

  /** GET /admin/stats */
  @Get('stats')
  getStats() {
    return this.adminService.getStats();
  }

  /**
   * GET /admin/users?page=&limit=&search=&status=&sortBy=&order=
   *
   * Paginated: the handler answers `{ items, total, page, limit }`, the shape
   * the student feed already uses, so the client reads every list the same way.
   */
  @RateLimitTier('search')
  @Get('users')
  getAllUsers(@Query() query: ListUsersDto) {
    return this.adminService.getAllUsers(query);
  }

  /** GET /admin/subjects?page=&limit=&search=&major_id=&sortBy=&order= */
  @RateLimitTier('search')
  @Get('subjects')
  getAllSubjects(@Query() query: ListSubjectsDto) {
    return this.adminService.getAllSubjects(query);
  }

  /**
   * PATCH /admin/subjects/:id — edit name / acronym / semester / cover.
   *
   * Accepts JSON, or multipart/form-data with an `image` file. Same contract
   * as POST /subjects and PATCH /majors/:id: a sent file wins over any
   * `subject_url` in the body, and an empty `subject_url` clears the cover.
   */
  @Patch('subjects/:id')
  @UseInterceptors(FileInterceptor('image', IMAGE_UPLOAD_OPTIONS))
  editSubject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EditSubjectDto,
    @UploadedFile() image?: Express.Multer.File,
  ) {
    return this.adminService.editSubject(id, dto, image);
  }

  /** DELETE /admin/subjects/:id */
  @Delete('subjects/:id')
  removeSubject(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.removeSubject(id);
  }

  // ─── Books (admin only) ──────────────────────────────────────────────────
  // No approval step: books go live on donation. These exist to correct a
  // status or remove a listing.

  /** GET /admin/books?search= */
  @RateLimitTier('search')
  @Get('books')
  getAllBooks(@Query('search') search?: string) {
    return this.adminService.getAllBooks(search);
  }

  /** PATCH /admin/books/:id/hidden — body: { hidden: boolean } */
  @Patch('books/:id/hidden')
  setBookHidden(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetBookHiddenDto,
  ) {
    return this.adminService.setBookHidden(id, dto.hidden);
  }

  /** DELETE /admin/books/:id */
  @Delete('books/:id')
  deleteBook(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.deleteBook(id);
  }

  // ─── Users (admin only) ──────────────────────────────────────────────────

  /** PATCH /admin/users/:id/role — body: { role: 'user' | 'admin' } */
  @Patch('users/:id/role')
  setUserRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetUserRoleDto,
    @Request() req: ReviewerRequest,
  ) {
    return this.adminService.setUserRole(id, dto.role, req.user!.sub!);
  }

  /** PATCH /admin/users/:id/placement — body: { major_id, year_level } */
  @Patch('users/:id/placement')
  setUserPlacement(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetUserPlacementDto,
  ) {
    return this.adminService.setUserPlacement(id, dto.major_id, dto.year_level);
  }

  /** PATCH /admin/users/:id/ban — body: { reason? } */
  @Patch('users/:id/ban')
  banUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: BanUserDto,
    @Request() req: ReviewerRequest,
  ) {
    return this.adminService.banUser(id, req.user!.sub!, dto.reason);
  }

  /** PATCH /admin/users/:id/unban */
  @Patch('users/:id/unban')
  unbanUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: ReviewerRequest,
  ) {
    return this.adminService.unbanUser(id, req.user!.sub!);
  }

  /** GET /admin/users/:id/bans — every ban this account has had. */
  @Get('users/:id/bans')
  getUserBans(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.getUserBans(id);
  }

  // ─── Moderators (admin only) ─────────────────────────────────────────────

  /** GET /admin/majors/:majorId/moderators */
  @Get('majors/:majorId/moderators')
  listModerators(@Param('majorId', ParseUUIDPipe) majorId: string) {
    return this.moderation.listByMajor(majorId);
  }

  /** POST /admin/majors/:majorId/moderators — body: { user_id } */
  @Post('majors/:majorId/moderators')
  assignModerator(
    @Param('majorId', ParseUUIDPipe) majorId: string,
    @Body('user_id', ParseUUIDPipe) userId: string,
  ) {
    return this.moderation.assign(userId, majorId);
  }

  /** DELETE /admin/majors/:majorId/moderators/:userId */
  @Delete('majors/:majorId/moderators/:userId')
  removeModerator(
    @Param('majorId', ParseUUIDPipe) majorId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.moderation.unassign(userId, majorId);
  }

  /**
   * DELETE /admin/users/:id/moderator — strip every department at once.
   *
   * The per-department picker is for adjusting who covers what; this is for
   * "they are not a moderator any more", which otherwise meant unticking each
   * department in turn and hoping none was missed.
   */
  @Delete('users/:id/moderator')
  removeAllModeratorAccess(@Param('id', ParseUUIDPipe) id: string) {
    return this.moderation.unassignAllFor(id);
  }

  /**
   * GET /admin/majors/without-moderator — departments nobody reviews yet.
   * Not an error state (admins can still review them), a prompt for the
   * dashboard.
   */
  @Get('majors/without-moderator')
  majorsWithoutModerator() {
    return this.moderation.majorsWithoutModerator();
  }

  /**
   * GET /admin/documents
   *   ?page=&limit=&search=&doc_type=&major_id=&uploader_id=&status=&since=
   *   &sortBy=&order=
   *
   * `status` is one of the four the tab displays — active, rejected, hidden,
   * expired — not the two in the column. Hidden and expired are sub-states of
   * an active upload, and the service turns them into predicates so that the
   * browser no longer has to fetch every row to narrow them.
   */
  @RateLimitTier('search')
  @Get('documents')
  getAllDocuments(@Query() query: ListDocumentsDto) {
    return this.adminService.getAllDocuments(query);
  }

  /** DELETE /admin/documents/:id */
  @Delete('documents/:id')
  deleteDocument(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.deleteDocument(id);
  }
}
