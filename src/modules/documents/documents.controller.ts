import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Request,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DocumentsService } from './documents.service';
import {
  CreateDocumentDto,
  DEPARTMENT_DOC_TYPES,
  DOC_TYPES,
  LANGUAGE_DOC_TYPES,
} from './dto/create-document.dto';
import { AddFilesDto } from './dto/add-files.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { QueryDocumentsDto } from './dto/query-documents.dto';
import { RateLimitTier } from '../../common/rate-limit/rate-limit.decorator';
import {
  MAX_FILE_SIZE_BYTES,
  MAX_FILES_PER_UPLOAD,
} from '../../common/upload-limits';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiAuth,
  ApiNotFound,
  ApiOwnerOnly,
  ApiRateLimited,
  ApiUploadLimits,
  ERROR_SCHEMA,
  envelope,
} from '../../common/swagger/api-responses.decorator';
import { API_TAGS } from '../../common/swagger/swagger.config';

type AuthenticatedRequest = {
  user: {
    sub: string;
    email: string;
  };
};

const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/jpeg',
  'image/png',
  'application/zip',
  'application/x-zip-compressed',
  'application/x-rar-compressed',
  'application/vnd.rar',
];
// Limits live in common/upload-limits.ts — the byte quota and the error
// messages are derived from the same numbers.

@ApiTags(API_TAGS.documents)
@Controller('documents')
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  /**
   * GET /documents/types  — public, no auth required
   * Every valid document type, plus the subset each kind of course offers:
   * `department` for the engineering departments, `language` for the
   * Department of Foreign Languages. `types` is the union of both.
   */
  @ApiOperation({
    summary: 'List document types',
    description:
      'Public. The full set plus the subset each kind of course offers: department courses and DFL language courses have different lists, and the API enforces the split on upload.',
  })
  @ApiOkResponse({
    description: 'Every type, and the two subsets.',
    schema: envelope({
      type: 'object',
      properties: {
        types: { type: 'array', items: { type: 'string' } },
        department: { type: 'array', items: { type: 'string' } },
        language: { type: 'array', items: { type: 'string' } },
      },
    }),
  })
  @Get('types')
  getTypes() {
    return {
      types: DOC_TYPES,
      department: DEPARTMENT_DOC_TYPES,
      language: LANGUAGE_DOC_TYPES,
    };
  }

  /**
   * POST /documents
   * Multipart upload: files + JSON fields in form-data
   */
  @ApiOperation({
    summary: 'Upload a document',
    description:
      'Signed in. Send files as multipart `files`, or reference ids from POST /documents/staged-files - one of the two is required. PDF, DOC, DOCX, PPT, PPTX, JPEG, PNG, ZIP or RAR. Up to 10 files per request, 50 MB each. Files are validated by signature as well as extension, and are NOT scanned for malware. Uploads start pending and stay out of the feed until a reviewer approves them.',
  })
  @ApiAuth()
  @ApiConsumes('multipart/form-data')
  @ApiCreatedResponse({
    description: 'Created, awaiting review.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiBadRequestResponse({
    description:
      'Validation failed, no files supplied, or a type this major does not offer.',
    schema: ERROR_SCHEMA,
  })
  @ApiUploadLimits(50)
  @ApiRateLimited()
  @UseGuards(JwtAuthGuard)
  @RateLimitTier('upload')
  @Post()
  @UseInterceptors(
    FilesInterceptor('files', MAX_FILES_PER_UPLOAD, {
      storage: memoryStorage(),
      limits: { fileSize: MAX_FILE_SIZE_BYTES },
      fileFilter: (_req, file, cb) => {
        if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
          cb(null, true);
        } else {
          cb(new Error('Unsupported file type'), false);
        }
      },
    }),
  )
  upload(
    @Request() req: AuthenticatedRequest,
    @UploadedFiles() files: Express.Multer.File[],
    @Body() dto: CreateDocumentDto,
  ) {
    return this.documentsService.uploadMany(req.user.sub, dto, files);
  }

  /**
   * POST /documents/staged-files — send one file ahead of the metadata.
   *
   * The upload form calls this as soon as a file is picked, so the transfer
   * happens while the user is still filling in the form. Returns the handle to
   * pass back as `staged_file_ids` on POST /documents.
   */
  @ApiOperation({
    summary: 'Stage one file',
    description:
      'Signed in. Uploads a single file before the form is submitted so the transfer overlaps with typing. Returns an id to pass later as `staged_file_ids`. PDF, DOC, DOCX, PPT, PPTX, JPEG, PNG, ZIP or RAR. Up to 10 files per request, 50 MB each. Files are validated by signature as well as extension, and are NOT scanned for malware.',
  })
  @ApiAuth()
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiCreatedResponse({
    description: 'Staged. Returns the id to claim it with.',
    schema: envelope({
      type: 'object',
      properties: { id: { type: 'string', format: 'uuid' } },
    }),
  })
  @ApiBadRequestResponse({
    description: 'No file sent, or an unsupported type.',
    schema: ERROR_SCHEMA,
  })
  @ApiUploadLimits(50)
  @ApiRateLimited()
  @UseGuards(JwtAuthGuard)
  @RateLimitTier('upload')
  @Post('staged-files')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_FILE_SIZE_BYTES },
      fileFilter: (_req, file, cb) => {
        if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
          cb(null, true);
        } else {
          cb(new BadRequestException('Unsupported file type'), false);
        }
      },
    }),
  )
  stageFile(
    @Request() req: AuthenticatedRequest,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('No file provided');
    return this.documentsService.stageFile(req.user.sub, file);
  }

  /** DELETE /documents/staged-files/:id — the user removed it from the form. */
  @ApiOperation({
    summary: 'Discard a staged file',
    description:
      'Signed in, and only your own. Used when a file is removed from the form before submitting.',
  })
  @ApiAuth()
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'The staged file to discard.',
  })
  @ApiOkResponse({
    description: 'Discarded.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiNotFound('No such staged file for this account.')
  @UseGuards(JwtAuthGuard)
  @Delete('staged-files/:id')
  deleteStagedFile(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.documentsService.deleteStagedFile(id, req.user.sub);
  }

  /**
   * GET /documents?major_id=&subject_id=&doc_type=&search=
   */
  @ApiOperation({
    summary: 'Browse documents',
    description:
      'Signed in. Approved documents the caller may see. Visibility matches every (department, year) the account has been in - not only the current one - so earlier years stay available. An empty audience means everyone.',
  })
  @ApiAuth()
  @ApiOkResponse({
    description: 'A page of documents.',
    schema: envelope({
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
        },
        total: { type: 'number' },
        page: { type: 'number' },
        limit: { type: 'number' },
      },
    }),
  })
  @ApiRateLimited()
  @UseGuards(JwtAuthGuard)
  @RateLimitTier('search')
  @Get()
  findAll(
    @Query() query: QueryDocumentsDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.documentsService.findAll(query, req.user.sub);
  }

  /**
   * GET /documents/mine  — user's pending + rejected submissions
   */
  @ApiOperation({
    summary: 'List your uploads',
    description:
      'Signed in. Your own documents in every state - pending, rejected, hidden and expired included, which the browse feed hides.',
  })
  @ApiAuth()
  @ApiOkResponse({
    description: 'Your documents.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @UseGuards(JwtAuthGuard)
  @Get('mine')
  findMine(@Request() req: AuthenticatedRequest) {
    return this.documentsService.findMine(req.user.sub);
  }

  /**
   * GET /documents/stats — totals for the dashboard.
   *
   * Must stay above @Get(':id') — route order decides, and 'stats' would
   * otherwise be captured as an :id (and rejected by ParseUUIDPipe).
   */
  @ApiOperation({
    summary: 'Your upload statistics',
    description: 'Signed in. Counts for the student dashboard.',
  })
  @ApiAuth()
  @ApiOkResponse({
    description: 'Counts for this account.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @UseGuards(JwtAuthGuard)
  @Get('stats')
  getStats(@Request() req: AuthenticatedRequest) {
    return this.documentsService.getStats(req.user.sub);
  }

  /**
   * GET /documents/:id
   */
  @ApiOperation({
    summary: 'Get one document',
    description:
      'Signed in, and permitted to see it. Answers 404 rather than 403 when the audience does not match, so the endpoint never confirms that a document you cannot see exists.',
  })
  @ApiAuth()
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'The document to fetch.',
  })
  @ApiOkResponse({
    description: 'The document with its files.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiNotFound('No such document, or it is not visible to you.')
  @UseGuards(JwtAuthGuard)
  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.documentsService.findOne(id, req.user.sub);
  }

  /**
   * PATCH /documents/:id/pinned — body: { pinned: boolean }
   * Pins any document you can open, yours or not. The pin is yours alone: it
   * sorts the document first in your own listings and changes nothing for
   * anyone else.
   */
  @ApiOperation({
    summary: 'Pin or unpin',
    description:
      'Signed in, owner or admin. Pinned documents sort first when `sort=pinned`.',
  })
  @ApiAuth()
  @ApiParam({ name: 'id', format: 'uuid', description: 'The document to pin.' })
  @ApiOkResponse({
    description: 'Updated.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiOwnerOnly('Only the uploader or an admin can pin this.')
  @ApiNotFound('No such document.')
  @UseGuards(JwtAuthGuard)
  @Patch(':id/pinned')
  setPinned(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('pinned') pinned: boolean,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.documentsService.setPinned(id, req.user.sub, !!pinned);
  }

  /**
   * PATCH /documents/:id/hidden — body: { hidden: boolean }
   * Uploader only. Takes the document out of the feed without deleting it and
   * without touching its review status.
   */
  @ApiOperation({
    summary: 'Hide or unhide',
    description:
      'Signed in, owner or admin. Hiding removes it from the feed for everyone; the owner still sees it in their own list.',
  })
  @ApiAuth()
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'The document to hide.',
  })
  @ApiOkResponse({
    description: 'Updated.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiOwnerOnly('Only the uploader or an admin can hide this.')
  @ApiNotFound('No such document.')
  @UseGuards(JwtAuthGuard)
  @Patch(':id/hidden')
  setHidden(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('hidden') hidden: boolean,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.documentsService.setHidden(id, req.user.sub, !!hidden);
  }

  /**
   * DELETE /documents/:id
   * Soft delete — uploader only
   */
  @ApiOperation({
    summary: 'Delete a document',
    description:
      'Signed in, owner or admin. Removes the document and its stored files.',
  })
  @ApiAuth()
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'The document to delete.',
  })
  @ApiOkResponse({
    description: 'Deleted.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiOwnerOnly('Only the uploader or an admin can delete this.')
  @ApiNotFound('No such document.')
  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  delete(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.documentsService.delete(id, req.user.sub);
  }

  /**
   * PATCH /documents/:id
   * Edit an upload's metadata (uploader only). Re-submits it for review.
   */
  @ApiOperation({
    summary: 'Edit document metadata',
    description:
      'Signed in, owner or admin. Metadata only - files have their own endpoints. A sent `audience` replaces the stored one entirely rather than merging.',
  })
  @ApiAuth()
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'The document to edit.',
  })
  @ApiOkResponse({
    description: 'Updated.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiOwnerOnly('Only the uploader or an admin can edit this.')
  @ApiNotFound('No such document.')
  @ApiBadRequestResponse({
    description: 'Validation failed.',
    schema: ERROR_SCHEMA,
  })
  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDocumentDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.documentsService.update(id, req.user.sub, dto);
  }

  /**
   * POST /documents/:id/files — add files to an existing upload (uploader only).
   */
  @ApiOperation({
    summary: 'Add files to a document',
    description:
      'Signed in, owner or admin. Added files go back through review. PDF, DOC, DOCX, PPT, PPTX, JPEG, PNG, ZIP or RAR. Up to 10 files per request, 50 MB each. Files are validated by signature as well as extension, and are NOT scanned for malware.',
  })
  @ApiAuth()
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'The document to add files to.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiCreatedResponse({
    description: 'Attached, awaiting review.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiOwnerOnly('Only the uploader or an admin can add files.')
  @ApiNotFound('No such document.')
  @ApiUploadLimits(50)
  @ApiRateLimited()
  @UseGuards(JwtAuthGuard)
  @RateLimitTier('upload')
  @Post(':id/files')
  @UseInterceptors(
    FilesInterceptor('files', MAX_FILES_PER_UPLOAD, {
      storage: memoryStorage(),
      limits: { fileSize: MAX_FILE_SIZE_BYTES },
      fileFilter: (_req, file, cb) => {
        if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
          cb(null, true);
        } else {
          cb(new Error('Unsupported file type'), false);
        }
      },
    }),
  )
  addFiles(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFiles() files: Express.Multer.File[],
    @Body() dto: AddFilesDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.documentsService.addFiles(
      id,
      req.user.sub,
      files,
      dto.staged_file_ids ?? [],
    );
  }

  /**
   * GET /documents/files/:fileId/download — a short-lived link to the original.
   *
   * The object itself is private; this is the only way to reach it. The service
   * authorises first and signs only afterwards, so a refused caller never sees
   * a URL. `search` tier rather than `write`: this is a read, and a reader
   * opening a folder of files makes several in a row.
   */
  @ApiOperation({
    summary: 'Get a download URL',
    description:
      'Signed in, and permitted to see the document. Returns a short-lived signed URL rather than the bytes, so object storage serves the file. Re-signed on every call because the caller is re-authorised each time.',
  })
  @ApiAuth()
  @ApiParam({
    name: 'fileId',
    format: 'uuid',
    description: 'The file to download.',
  })
  @ApiOkResponse({
    description: 'A short-lived signed URL.',
    schema: envelope({
      type: 'object',
      properties: { url: { type: 'string' } },
    }),
  })
  @ApiNotFound('No such file, or it is not visible to you.')
  @ApiRateLimited()
  @UseGuards(JwtAuthGuard)
  @RateLimitTier('search')
  @Get('files/:fileId/download')
  downloadFile(
    @Param('fileId', ParseUUIDPipe) fileId: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.documentsService.signFileAccess(
      fileId,
      req.user.sub,
      'download',
    );
  }

  /**
   * GET /documents/files/:fileId/preview — same, for the generated PDF.
   *
   * Served inline because it is a rendition this server produced; the original
   * is always an attachment.
   */
  @ApiOperation({
    summary: 'Get a preview URL',
    description:
      'Signed in, and permitted to see the document. Only PDF, JPEG and PNG render inline; Office files and archives have no preview and must be downloaded, since Office documents are deliberately not converted to PDF.',
  })
  @ApiAuth()
  @ApiParam({
    name: 'fileId',
    format: 'uuid',
    description: 'The file to preview.',
  })
  @ApiOkResponse({
    description:
      'A signed URL for inline display, or null when the type cannot be previewed.',
    schema: envelope({
      type: 'object',
      properties: { url: { type: 'string', nullable: true } },
    }),
  })
  @ApiNotFound('No such file, or it is not visible to you.')
  @ApiRateLimited()
  @UseGuards(JwtAuthGuard)
  @RateLimitTier('search')
  @Get('files/:fileId/preview')
  previewFile(
    @Param('fileId', ParseUUIDPipe) fileId: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.documentsService.signFileAccess(
      fileId,
      req.user.sub,
      'preview',
    );
  }

  /**
   * PATCH /documents/files/:fileId/hidden — body: { hidden: boolean }
   * Uploader only. Hiding the last visible file hides its upload too.
   */
  @ApiOperation({
    summary: 'Hide or unhide one file',
    description:
      'Signed in, owner or admin. Hides a single file without touching the rest of the document.',
  })
  @ApiAuth()
  @ApiParam({
    name: 'fileId',
    format: 'uuid',
    description: 'The file to hide.',
  })
  @ApiOkResponse({
    description: 'Updated.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiOwnerOnly('Only the uploader or an admin can hide this file.')
  @ApiNotFound('No such file.')
  @UseGuards(JwtAuthGuard)
  @Patch('files/:fileId/hidden')
  setFileHidden(
    @Param('fileId', ParseUUIDPipe) fileId: string,
    @Body('hidden') hidden: boolean,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.documentsService.setFileHidden(fileId, req.user.sub, !!hidden);
  }

  /**
   * DELETE /documents/files/:fileId — remove a single file (uploader only).
   * Removing the last file deletes the upload too; the response says which
   * happened via `upload_deleted`.
   */
  @ApiOperation({
    summary: 'Delete one file',
    description:
      'Signed in, owner or admin. Removes one file from the document.',
  })
  @ApiAuth()
  @ApiParam({
    name: 'fileId',
    format: 'uuid',
    description: 'The file to delete.',
  })
  @ApiOkResponse({
    description: 'Deleted.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiOwnerOnly('Only the uploader or an admin can delete this file.')
  @ApiNotFound('No such file.')
  @UseGuards(JwtAuthGuard)
  @Delete('files/:fileId')
  removeFile(
    @Param('fileId', ParseUUIDPipe) fileId: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.documentsService.removeFile(fileId, req.user.sub);
  }
}
