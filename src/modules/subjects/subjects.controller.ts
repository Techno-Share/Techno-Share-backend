import {
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
  UseGuards,
  BadRequestException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SubjectsService } from './subjects.service';
import { CreateSubjectDto } from './dto/create-subject.dto';
import { UpdateSubjectDto } from './dto/update-subject.dto';
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
  ApiAuth,
  ApiNotFound,
  ApiOwnerOnly,
  ApiRateLimited,
  ApiUploadLimits,
  ERROR_SCHEMA,
  envelope,
} from '../../common/swagger/api-responses.decorator';
import { API_TAGS } from '../../common/swagger/swagger.config';

type AuthenticatedRequest = { user: { sub: string; email: string } };

const ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

@ApiTags(API_TAGS.subjects)
@Controller('subjects')
export class SubjectsController {
  constructor(private readonly subjectsService: SubjectsService) {}

  /**
   * GET /subjects/counts?major_id=<uuid>
   * Returns subject count per year level: { "3": 5, "4": 8, ... }
   */
  @ApiOperation({
    summary: 'Document counts per subject',
    description:
      'Public. How many approved documents each subject has, for the subject grid.',
  })
  @ApiOkResponse({
    description: 'Counts keyed by subject id.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @Get('counts')
  getCounts(@Query('major_id') majorId: string) {
    if (!majorId) throw new BadRequestException('major_id is required');
    return this.subjectsService.countsByMajor(majorId);
  }

  /**
   * GET /subjects?major_id=<uuid>
   * Public — used to populate subject dropdowns filtered by major.
   *
   */
  @ApiOperation({
    summary: 'List subjects',
    description:
      'Public. Filtered by department, year and semester. This is the list the upload form picks from.',
  })
  @ApiOkResponse({
    description: 'Matching subjects.',
    schema: envelope({
      type: 'array',
      items: { type: 'object', additionalProperties: true },
    }),
  })
  @ApiRateLimited()
  @RateLimitTier('search')
  @Get()
  findByMajor(
    @Query('major_id') majorId: string,
    @Query('year_level') yearLevel?: string,
    @Query('semester') semester?: string,
    @Query('search') search?: string,
  ) {
    if (!majorId) throw new BadRequestException('major_id is required');
    return this.subjectsService.findByMajor(
      majorId,
      yearLevel ? Number(yearLevel) : undefined,
      semester ? Number(semester) : undefined,
      search,
    );
  }

  /**
   * POST /subjects
   * Any logged-in user can contribute a missing subject
   * Multipart form-data supported: image + subject fields
   */
  @ApiAuth()
  @ApiOperation({
    summary: 'Suggest a subject',
    description:
      'Signed in. Students may add a subject their department is missing. Created immediately - subjects are no longer held for review. An optional syllabus image may be sent as multipart.',
  })
  @ApiConsumes('multipart/form-data', 'application/json')
  @ApiCreatedResponse({
    description: 'Subject created.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiBadRequestResponse({
    description: 'Validation failed.',
    schema: ERROR_SCHEMA,
  })
  @ApiConflictResponse({
    description: 'That subject already exists for this department and year.',
    schema: ERROR_SCHEMA,
  })
  @ApiUploadLimits(5)
  @UseGuards(JwtAuthGuard)
  @Post()
  @UseInterceptors(
    FileInterceptor('image', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_IMAGE_SIZE_BYTES },
      fileFilter: (_req, file, cb) => {
        if (ALLOWED_IMAGE_MIME_TYPES.includes(file.mimetype)) {
          cb(null, true);
        } else {
          cb(new Error('Unsupported image type'), false);
        }
      },
    }),
  )
  create(
    @Request() req: AuthenticatedRequest,
    @Body() dto: CreateSubjectDto,
    @UploadedFile() image?: Express.Multer.File,
  ) {
    return this.subjectsService.create(dto, image, req.user.sub);
  }

  /** GET /subjects/mine — current user's submitted subjects (all statuses) */
  @ApiAuth()
  @ApiOperation({
    summary: 'List subjects you added',
    description: 'Signed in. Only the subjects this account created.',
  })
  @ApiOkResponse({
    description: 'Your subjects.',
    schema: envelope({
      type: 'array',
      items: { type: 'object', additionalProperties: true },
    }),
  })
  @UseGuards(JwtAuthGuard)
  @Get('mine')
  getMine(@Request() req: AuthenticatedRequest) {
    return this.subjectsService.findMine(req.user.sub);
  }

  /** PATCH /subjects/:id — update own subject (name / semester) */
  @ApiAuth()
  @ApiOperation({
    summary: 'Edit a subject you added',
    description:
      'Signed in, and only your own - an admin edits any subject through PATCH /admin/subjects/:id instead.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'The subject to edit.' })
  @ApiOkResponse({
    description: 'Subject updated.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiOwnerOnly('You did not create this subject.')
  @ApiNotFound('No such subject.')
  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  updateOwn(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSubjectDto,
  ) {
    return this.subjectsService.updateOwn(id, req.user.sub, dto);
  }

  /** DELETE /subjects/:id — delete own subject */
  @ApiAuth()
  @ApiOperation({
    summary: 'Delete a subject you added',
    description:
      'Signed in, and only your own. Refused once documents reference it.',
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
  @ApiOwnerOnly('You did not create this subject.')
  @ApiNotFound('No such subject.')
  @ApiConflictResponse({
    description: 'Documents still reference this subject.',
    schema: ERROR_SCHEMA,
  })
  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  removeOwn(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.subjectsService.removeOwn(id, req.user.sub);
  }
}
