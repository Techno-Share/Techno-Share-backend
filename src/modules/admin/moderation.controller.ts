import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ReviewerGuard, type ReviewerRequest } from './guards/reviewer.guard';
import { AdminService } from './admin.service';
import { RejectDto } from './dto/reject.dto';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiNotFound,
  ApiReviewerOnly,
  ERROR_SCHEMA,
  envelope,
} from '../../common/swagger/api-responses.decorator';
import { API_TAGS } from '../../common/swagger/swagger.config';

/**
 * The review queue: everything a department moderator does.
 *
 * Split from AdminController because the two have different audiences and
 * therefore need different class-level guards. They previously shared one
 * controller, with ReviewerGuard added per route — which never worked, because
 * Nest guards accumulate rather than override: the class-level AdminGuard still
 * ran and rejected every moderator. Nothing here may carry AdminGuard.
 *
 * ReviewerGuard admits admins as well, so an admin keeps full access to these
 * routes without a second decorator.
 *
 * Passing the guard is only half of it. The guard cannot know which upload is
 * being actioned, so every handler hands the resolved reviewer to the service,
 * which loads the resource and checks ITS department. A major_id from the
 * client is never consulted.
 *
 * Paths stay under /admin so no client has to change.
 */
@ApiTags(API_TAGS.moderation)
@ApiReviewerOnly()
@Controller('admin')
@UseGuards(JwtAuthGuard, ReviewerGuard)
export class ModerationController {
  constructor(private readonly adminService: AdminService) {}

  /**
   * GET /admin/scope — the departments this reviewer answers for.
   *
   * Read-only and derived from the server's own assignment table, never from
   * anything the client sends: it names the scope, it does not set it.
   */
  @ApiOperation({
    summary: 'What you may review',
    description:
      'The departments this reviewer answers for. `majors` is null for an admin, who reviews everything - which is not the same as an empty list, meaning nothing.',
  })
  @ApiOkResponse({
    description: 'Your review scope.',
    schema: envelope({
      type: 'object',
      properties: {
        isAdmin: { type: 'boolean' },
        majors: {
          type: 'array',
          nullable: true,
          items: { type: 'object', additionalProperties: true },
        },
      },
    }),
  })
  @Get('scope')
  getScope(@Request() req: ReviewerRequest) {
    return this.adminService.getReviewerScope(req.reviewer!);
  }

  // Subjects have no review queue: only a moderator of a department (or an
  // admin) may add one, and what they add is published immediately. There is
  // nobody left for a pending subject to be waiting on.

  /** GET /admin/pending/documents */
  @ApiOperation({
    summary: 'The review queue',
    description:
      'Submissions awaiting review, already narrowed to departments you moderate. An admin sees every department.',
  })
  @ApiOkResponse({
    description: 'Pending submissions.',
    schema: envelope({
      type: 'array',
      items: { type: 'object', additionalProperties: true },
    }),
  })
  @Get('pending/documents')
  getPendingDocuments(@Request() req: ReviewerRequest) {
    return this.adminService.getPendingDocuments(req.reviewer!);
  }

  /**
   * GET /admin/documents/group/:groupId — the review screen's data.
   *
   * Takes the reviewer like every sibling: passing the guard means "you review
   * something", never "you may open this upload". The service checks the
   * upload's own department, so changing the id in the URL cannot reach
   * another department's submission.
   */
  @ApiOperation({
    summary: 'Get one submission',
    description:
      'Every file uploaded together in one submission, for side-by-side review.',
  })
  @ApiParam({ name: 'groupId', format: 'uuid', description: 'The submission.' })
  @ApiOkResponse({
    description: 'The submission with its files.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiNotFound('No such submission.')
  @Get('documents/group/:groupId')
  getDocumentsByGroup(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Request() req: ReviewerRequest,
  ) {
    return this.adminService.getDocumentsByGroup(groupId, req.reviewer!);
  }

  /** PATCH /admin/documents/group/:groupId/approve */
  @ApiOperation({
    summary: 'Approve a whole submission',
    description:
      'Approves every pending file in it and notifies the uploader. The document becomes visible to its audience.',
  })
  @ApiParam({
    name: 'groupId',
    format: 'uuid',
    description: 'The submission to approve.',
  })
  @ApiOkResponse({
    description: 'Approved and the uploader notified.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiNotFound('No such submission.')
  @Patch('documents/group/:groupId/approve')
  approveDocumentGroup(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Request() req: ReviewerRequest,
  ) {
    return this.adminService.approveDocumentGroup(groupId, req.reviewer!);
  }

  /** PATCH /admin/documents/group/:groupId/reject */
  @ApiOperation({
    summary: 'Reject a whole submission',
    description:
      'Rejects every pending file and sends the reason to the uploader so they can fix and resubmit. Rejected files are purged after the retention window.',
  })
  @ApiParam({
    name: 'groupId',
    format: 'uuid',
    description: 'The submission to reject.',
  })
  @ApiOkResponse({
    description: 'Rejected and the uploader notified.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiNotFound('No such submission.')
  @ApiBadRequestResponse({
    description: 'A reason is required.',
    schema: ERROR_SCHEMA,
  })
  @Patch('documents/group/:groupId/reject')
  rejectDocumentGroup(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Request() req: ReviewerRequest,
    @Body() dto: RejectDto,
  ) {
    return this.adminService.rejectDocumentGroup(
      groupId,
      req.reviewer!,
      dto.reason,
    );
  }

  /**
   * PATCH /admin/documents/files/:fileId/approve — clear a single file added
   * to an upload that is already approved. Its upload never left the feed, so
   * there is no group to act on.
   */
  @ApiOperation({
    summary: 'Approve one file',
    description: 'For a submission where some files pass and others do not.',
  })
  @ApiParam({
    name: 'fileId',
    format: 'uuid',
    description: 'The file to approve.',
  })
  @ApiOkResponse({
    description: 'Approved.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiNotFound('No such file.')
  @Patch('documents/files/:fileId/approve')
  approveFile(
    @Param('fileId', ParseUUIDPipe) fileId: string,
    @Request() req: ReviewerRequest,
  ) {
    return this.adminService.approveFile(fileId, req.reviewer!);
  }

  /** PATCH /admin/documents/files/:fileId/reject */
  @ApiOperation({
    summary: 'Reject one file',
    description:
      'Rejects a single file with a reason, leaving the rest of the submission alone.',
  })
  @ApiParam({
    name: 'fileId',
    format: 'uuid',
    description: 'The file to reject.',
  })
  @ApiOkResponse({
    description: 'Rejected.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiNotFound('No such file.')
  @ApiBadRequestResponse({
    description: 'A reason is required.',
    schema: ERROR_SCHEMA,
  })
  @Patch('documents/files/:fileId/reject')
  rejectFile(
    @Param('fileId', ParseUUIDPipe) fileId: string,
    @Request() req: ReviewerRequest,
    @Body() dto: RejectDto,
  ) {
    return this.adminService.rejectFile(fileId, req.reviewer!, dto.reason);
  }
}
