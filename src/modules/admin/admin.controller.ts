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
  ListPromotionsDto,
  ListUsersDto,
} from './dto/list-admin.dto';
import { RateLimitTier } from '../../common/rate-limit/rate-limit.decorator';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiAdminOnly,
  ApiNotFound,
  ApiRateLimited,
  ApiUploadLimits,
  ERROR_SCHEMA,
  envelope,
  envelopePage,
} from '../../common/swagger/api-responses.decorator';
import { API_TAGS } from '../../common/swagger/swagger.config';

// Admin-only, without exception — the class guard is the whole boundary.
//
// The review queue lives in ModerationController, which department moderators
// can reach. It is a separate class on purpose: Nest guards accumulate, so a
// per-route @UseGuards(ReviewerGuard) here would ADD to AdminGuard rather than
// replace it, and moderators would keep being rejected by a rule nobody meant
// to apply to them.
@ApiTags(API_TAGS.admin)
@ApiAdminOnly()
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
  @ApiOperation({
    summary: 'Get the promotion schedule',
    description:
      'The instant every student next moves up a year, or null when none is set. `has_passed` says whether it is already in effect.',
  })
  @ApiOkResponse({
    description: 'The schedule.',
    schema: envelope({
      type: 'object',
      properties: {
        rollover_at: { type: 'string', format: 'date-time', nullable: true },
        has_passed: { type: 'boolean' },
      },
    }),
  })
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
  @ApiOperation({
    summary: 'Schedule or cancel the promotion',
    description:
      'Sets the instant every student advances a year; null cancels it. Students are NOT advanced at that instant - each one moves on their next authenticated request, so the rollout trails the date. Setting a new instant after one has passed advances the whole institute again rather than amending the old one.',
  })
  @ApiOkResponse({
    description: 'Schedule saved.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiBadRequestResponse({
    description: 'Not a valid ISO 8601 instant.',
    schema: ERROR_SCHEMA,
  })
  @Put('promotion')
  setPromotionSchedule(
    @Request() req: ReviewerRequest,
    @Body() dto: SetPromotionDto,
  ) {
    return this.promotionSettings.set(dto.rollover_at ?? null, req.user!.sub!);
  }

  /** GET /admin/stats */
  @ApiOperation({
    summary: 'Dashboard statistics',
    description: 'Totals and monthly series for the admin overview.',
  })
  @ApiOkResponse({
    description: 'Counts and series.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
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
  @ApiOperation({
    summary: 'List accounts',
    description:
      'Paginated and searchable by name or email. `status=banned` filters on the ban currently in force, not on ever having been banned.',
  })
  @ApiOkResponse({
    description: 'A page of results.',
    schema: envelopePage({ type: 'object', additionalProperties: true }),
  })
  @ApiRateLimited()
  @RateLimitTier('search')
  @Get('users')
  getAllUsers(@Query() query: ListUsersDto) {
    return this.adminService.getAllUsers(query);
  }

  /** GET /admin/subjects?page=&limit=&search=&major_id=&sortBy=&order= */
  @ApiOperation({
    summary: 'List subjects',
    description: 'Paginated, across every department.',
  })
  @ApiOkResponse({
    description: 'A page of results.',
    schema: envelopePage({ type: 'object', additionalProperties: true }),
  })
  @ApiRateLimited()
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
  @ApiOperation({
    summary: 'Edit any subject',
    description:
      'Unlike PATCH /subjects/:id, this is not limited to subjects you created. An optional syllabus image may be sent as multipart `image`.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'The subject to edit.' })
  @ApiConsumes('multipart/form-data', 'application/json')
  @ApiOkResponse({
    description: 'Subject updated.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiNotFound('No such subject.')
  @ApiUploadLimits(5)
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
  @ApiOperation({
    summary: 'Delete any subject',
    description: 'Refused while documents still reference it.',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'The subject to delete.',
  })
  @ApiOkResponse({
    description: 'Subject deleted.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiNotFound('No such subject.')
  @ApiConflictResponse({
    description: 'Documents still reference this subject.',
    schema: ERROR_SCHEMA,
  })
  @Delete('subjects/:id')
  removeSubject(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.removeSubject(id);
  }

  // ─── Books (admin only) ──────────────────────────────────────────────────
  // No approval step: books go live on donation. These exist to correct a
  // status or remove a listing.

  /** GET /admin/books?search= */
  @ApiOperation({
    summary: 'List book listings',
    description: 'Paginated, including listings hidden from the browse feed.',
  })
  @ApiOkResponse({
    description: 'A page of results.',
    schema: envelopePage({ type: 'object', additionalProperties: true }),
  })
  @ApiRateLimited()
  @RateLimitTier('search')
  @Get('books')
  getAllBooks(@Query('search') search?: string) {
    return this.adminService.getAllBooks(search);
  }

  /** PATCH /admin/books/:id/hidden — body: { hidden: boolean } */
  @ApiOperation({
    summary: 'Hide or unhide a listing',
    description:
      'Hiding removes it from the browse feed; the donor still sees it.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'The listing.' })
  @ApiOkResponse({
    description: 'Updated.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiNotFound('No such book.')
  @Patch('books/:id/hidden')
  setBookHidden(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetBookHiddenDto,
  ) {
    return this.adminService.setBookHidden(id, dto.hidden);
  }

  /** DELETE /admin/books/:id */
  @ApiOperation({
    summary: 'Delete a listing',
    description: 'Removes the listing and its cover.',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'The listing to delete.',
  })
  @ApiOkResponse({
    description: 'Deleted.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiNotFound('No such book.')
  @Delete('books/:id')
  deleteBook(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.deleteBook(id);
  }

  // ─── Users (admin only) ──────────────────────────────────────────────────

  /** PATCH /admin/users/:id/role — body: { role: 'user' | 'admin' } */
  @ApiOperation({
    summary: 'Change an account role',
    description:
      'Promotes to admin or demotes to user. You cannot change your own role - an admin cannot lock themselves out.',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'The account to change.',
  })
  @ApiOkResponse({
    description: 'Role changed.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiNotFound('No such account.')
  @ApiBadRequestResponse({
    description: 'You cannot change your own role.',
    schema: ERROR_SCHEMA,
  })
  @Patch('users/:id/role')
  setUserRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetUserRoleDto,
    @Request() req: ReviewerRequest,
  ) {
    return this.adminService.setUserRole(id, dto.role, req.user!.sub!);
  }

  /** PATCH /admin/users/:id/placement — body: { major_id, year_level } */
  @ApiOperation({
    summary: 'Set a student’s department and year',
    description:
      'Corrects a placement. The year must be one the department actually has: Foundation runs 1-2 and departments run 3-5, so a year outside that range is refused.',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'The student to place.',
  })
  @ApiOkResponse({
    description: 'Placement updated.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiNotFound('No such account.')
  @ApiBadRequestResponse({
    description: 'That year does not exist in that department.',
    schema: ERROR_SCHEMA,
  })
  @Patch('users/:id/placement')
  setUserPlacement(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetUserPlacementDto,
  ) {
    return this.adminService.setUserPlacement(id, dto.major_id, dto.year_level);
  }

  /** PATCH /admin/users/:id/ban — body: { reason? } */
  @ApiOperation({
    summary: 'Ban an account',
    description:
      'Revokes every refresh token immediately and unassigns any review queues. The access token is also rejected on its next use, because the JWT guard re-checks the account on every request. You cannot ban yourself.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'The account to ban.' })
  @ApiOkResponse({
    description: 'Banned and sessions revoked.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiNotFound('No such account.')
  @ApiBadRequestResponse({
    description: 'You cannot ban yourself.',
    schema: ERROR_SCHEMA,
  })
  @Patch('users/:id/ban')
  banUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: BanUserDto,
    @Request() req: ReviewerRequest,
  ) {
    return this.adminService.banUser(id, req.user!.sub!, dto.reason);
  }

  /** PATCH /admin/users/:id/unban */
  @ApiOperation({
    summary: 'Lift a ban',
    description:
      'Stamps the ban as lifted. The record stays, so a repeat ban is still visible in the history.',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'The account to unban.',
  })
  @ApiOkResponse({
    description: 'Ban lifted.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiNotFound('No such account, or no ban in force.')
  @Patch('users/:id/unban')
  unbanUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: ReviewerRequest,
  ) {
    return this.adminService.unbanUser(id, req.user!.sub!);
  }

  /**
   * GET /admin/promotion-events?page=&limit=&search=&sortBy=&order=
   *
   * The promotion history table: one row per promotion, newest first.
   *
   * Named `promotion-events`, not `promotions`, so it cannot be mistaken for
   * `/admin/promotion` above — that one is the SCHEDULE (when the next
   * rollover fires) and this is the record of what the schedule did.
   */
  @ApiOperation({
    summary: 'List promotions',
    description:
      'One row per scheduled rollover, newest first - not per student. `promoted_users` counts distinct students who have collected it; `eligible_users` counts accounts that already existed when it fired, since a rollover cannot advance an account registered after it. The gap between the two is the rollout still in progress.',
  })
  @ApiOkResponse({
    description: 'A page of rollovers.',
    schema: envelopePage({
      type: 'object',
      properties: {
        rollover_at: { type: 'string', format: 'date-time' },
        promoted_users: { type: 'number' },
        eligible_users: { type: 'number' },
      },
    }),
  })
  @Get('promotion-events')
  getPromotionEvents(@Query() query: ListPromotionsDto) {
    return this.adminService.getAllPromotions(query);
  }

  /** GET /admin/users/:id/bans — every ban this account has had. */
  @ApiOperation({
    summary: 'Ban history for an account',
    description:
      'Every ban this account has had, newest first. A row with no `lifted_at` is the one in force.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'The account.' })
  @ApiOkResponse({
    description: 'Ban history.',
    schema: envelope({
      type: 'array',
      items: { type: 'object', additionalProperties: true },
    }),
  })
  @Get('users/:id/bans')
  getUserBans(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.getUserBans(id);
  }

  // ─── Moderators (admin only) ─────────────────────────────────────────────

  /** GET /admin/majors/:majorId/moderators */
  @ApiOperation({
    summary: 'List a department’s moderators',
    description: 'Who reviews submissions for this department.',
  })
  @ApiParam({ name: 'majorId', format: 'uuid', description: 'The department.' })
  @ApiOkResponse({
    description: 'Its moderators.',
    schema: envelope({
      type: 'array',
      items: { type: 'object', additionalProperties: true },
    }),
  })
  @Get('majors/:majorId/moderators')
  listModerators(@Param('majorId', ParseUUIDPipe) majorId: string) {
    return this.moderation.listByMajor(majorId);
  }

  /** POST /admin/majors/:majorId/moderators — body: { user_id } */
  @ApiOperation({
    summary: 'Make someone a moderator',
    description:
      'Grants review rights for one department. Moderation is a capability rather than a role: the account stays an ordinary user and gains only the review screen for that department.',
  })
  @ApiParam({ name: 'majorId', format: 'uuid', description: 'The department.' })
  @ApiCreatedResponse({
    description: 'Assigned.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiNotFound('No such department or account.')
  @Post('majors/:majorId/moderators')
  assignModerator(
    @Param('majorId', ParseUUIDPipe) majorId: string,
    @Body('user_id', ParseUUIDPipe) userId: string,
  ) {
    return this.moderation.assign(userId, majorId);
  }

  /** DELETE /admin/majors/:majorId/moderators/:userId */
  @ApiOperation({
    summary: 'Remove a moderator from a department',
    description:
      'Revokes review rights for this department only; other departments are untouched.',
  })
  @ApiParam({ name: 'majorId', format: 'uuid', description: 'The department.' })
  @ApiParam({ name: 'userId', format: 'uuid', description: 'The moderator.' })
  @ApiOkResponse({
    description: 'Removed.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiNotFound('No such assignment.')
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
  @ApiOperation({
    summary: 'Strip every moderator assignment',
    description: 'Removes the account from all departments at once.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'The moderator.' })
  @ApiOkResponse({
    description: 'All assignments removed.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiNotFound('No such account.')
  @Delete('users/:id/moderator')
  removeAllModeratorAccess(@Param('id', ParseUUIDPipe) id: string) {
    return this.moderation.unassignAllFor(id);
  }

  /**
   * GET /admin/majors/without-moderator — departments nobody reviews yet.
   * Not an error state (admins can still review them), a prompt for the
   * dashboard.
   */
  @ApiOperation({
    summary: 'Departments with no moderator',
    description: 'Departments whose submissions only an admin can review.',
  })
  @ApiOkResponse({
    description: 'Unstaffed departments.',
    schema: envelope({
      type: 'array',
      items: { type: 'object', additionalProperties: true },
    }),
  })
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
  @ApiOperation({
    summary: 'List documents',
    description:
      'Paginated, across every department and state. Admins bypass the audience restriction here for moderation, but not expiry.',
  })
  @ApiOkResponse({
    description: 'A page of results.',
    schema: envelopePage({ type: 'object', additionalProperties: true }),
  })
  @ApiRateLimited()
  @RateLimitTier('search')
  @Get('documents')
  getAllDocuments(@Query() query: ListDocumentsDto) {
    return this.adminService.getAllDocuments(query);
  }

  /** DELETE /admin/documents/:id */
  @ApiOperation({
    summary: 'Delete any document',
    description:
      'Removes the document and its stored files, whoever uploaded it.',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'The document to delete.',
  })
  @ApiOkResponse({
    description: 'Deleted.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiNotFound('No such document.')
  @Delete('documents/:id')
  deleteDocument(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.deleteDocument(id);
  }
}
