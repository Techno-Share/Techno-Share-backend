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

@Controller('documents')
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  /**
   * GET /documents/types  — public, no auth required
   * Every valid document type, plus the subset each kind of course offers:
   * `department` for the engineering departments, `language` for the
   * Department of Foreign Languages. `types` is the union of both.
   */
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
  @UseGuards(JwtAuthGuard)
  @Get('stats')
  getStats(@Request() req: AuthenticatedRequest) {
    return this.documentsService.getStats(req.user.sub);
  }

  /**
   * GET /documents/:id
   */
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
  @UseGuards(JwtAuthGuard)
  @Delete('files/:fileId')
  removeFile(
    @Param('fileId', ParseUUIDPipe) fileId: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.documentsService.removeFile(fileId, req.user.sub);
  }
}
