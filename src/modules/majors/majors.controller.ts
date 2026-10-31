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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { MajorsService } from './majors.service';
import { CreateMajorDto } from './dto/create-major.dto';
import { UpdateMajorDto } from './dto/update-major.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../admin/guards/admin.guard';
import {
  ApiBadRequestResponse,
  ApiBody,
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
  ApiUploadLimits,
  ERROR_SCHEMA,
  envelope,
} from '../../common/swagger/api-responses.decorator';
import { API_TAGS } from '../../common/swagger/swagger.config';

const ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

const IMAGE_UPLOAD_OPTIONS = {
  storage: memoryStorage(),
  limits: { fileSize: MAX_IMAGE_SIZE_BYTES },
  fileFilter: (
    _req: unknown,
    file: Express.Multer.File,
    cb: (error: Error | null, acceptFile: boolean) => void,
  ) => {
    if (ALLOWED_IMAGE_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      // A plain Error here surfaces as a 500; this keeps it a 400.
      cb(
        new BadRequestException(
          `Unsupported image type '${file.mimetype}' — use JPEG, PNG or WebP`,
        ),
        false,
      );
    }
  },
};

@ApiTags(API_TAGS.majors)
@Controller('majors')
export class MajorsController {
  constructor(private readonly majorsService: MajorsService) {}

  /**
   * GET /majors
   * Public — no auth required (used on registration screen)
   */
  @ApiOperation({
    summary: 'List departments',
    description:
      'Public. Every department with its acronym and logo; this is what the welcome page and the upload form choose from.',
  })
  @ApiOkResponse({
    description: 'All departments.',
    schema: envelope({
      type: 'array',
      items: { type: 'object', additionalProperties: true },
    }),
  })
  @Get()
  findAll() {
    return this.majorsService.findAll();
  }

  /**
   * POST /majors
   * Admin only — majors are reference data the whole navigation tree hangs off.
   *
   * Accepts JSON, or multipart/form-data with an `image` file. When a file is
   * sent it is uploaded and wins over any `image_url` in the body.
   */
  @ApiAdminOnly()
  @ApiOperation({
    summary: 'Create a department',
    description:
      'Admin only. The acronym must be unique and uppercase ASCII - the department page resolves its route by lowercasing it, so a duplicate would make that lookup ambiguous. Send the logo as multipart `image`, or give `image_url`.',
  })
  @ApiConsumes('multipart/form-data', 'application/json')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['name', 'acronym'],
      properties: {
        name: { type: 'string', example: 'Computer Science and Engineering' },
        acronym: { type: 'string', example: 'GIC' },
        image: {
          type: 'string',
          format: 'binary',
          description: 'Logo. JPEG, PNG or WebP, max 5 MB.',
        },
      },
    },
  })
  @ApiCreatedResponse({
    description: 'Department created.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiBadRequestResponse({
    description: 'Validation failed, or an unsupported image type.',
    schema: ERROR_SCHEMA,
  })
  @ApiConflictResponse({
    description: 'That acronym is already in use.',
    schema: ERROR_SCHEMA,
  })
  @ApiUploadLimits(5)
  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post()
  @UseInterceptors(FileInterceptor('image', IMAGE_UPLOAD_OPTIONS))
  create(
    @Body() dto: CreateMajorDto,
    @UploadedFile() image?: Express.Multer.File,
  ) {
    return this.majorsService.create(dto, image);
  }

  /**
   * PATCH /majors/:id — rename, re-letter, or replace the logo.
   * Admin only. Same body/multipart contract as create, all fields optional.
   */
  @ApiAdminOnly()
  @ApiOperation({
    summary: 'Update a department',
    description: 'Admin only. Partial update. A new logo replaces the old one.',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'The department to update.',
  })
  @ApiConsumes('multipart/form-data', 'application/json')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        acronym: { type: 'string' },
        image: {
          type: 'string',
          format: 'binary',
          description: 'Replacement logo. JPEG, PNG or WebP, max 5 MB.',
        },
      },
    },
  })
  @ApiOkResponse({
    description: 'Department updated.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiNotFound('No such department.')
  @ApiConflictResponse({
    description: 'That acronym is already in use.',
    schema: ERROR_SCHEMA,
  })
  @ApiUploadLimits(5)
  @UseGuards(JwtAuthGuard, AdminGuard)
  @Patch(':id')
  @UseInterceptors(FileInterceptor('image', IMAGE_UPLOAD_OPTIONS))
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMajorDto,
    @UploadedFile() image?: Express.Multer.File,
  ) {
    return this.majorsService.update(id, dto, image);
  }

  /**
   * DELETE /majors/:id — admin only, and refused (409) while the department
   * still holds subjects, documents or books, which would cascade away with it.
   */
  @ApiAdminOnly()
  @ApiOperation({
    summary: 'Delete a department',
    description:
      'Admin only. Refused while documents, subjects or students still reference it.',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'The department to delete.',
  })
  @ApiOkResponse({
    description: 'Department deleted.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiNotFound('No such department.')
  @ApiConflictResponse({
    description: 'Still referenced by subjects, documents or students.',
    schema: ERROR_SCHEMA,
  })
  @UseGuards(JwtAuthGuard, AdminGuard)
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.majorsService.remove(id);
  }
}
