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

type AuthenticatedRequest = { user: { sub: string; email: string } };

const ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

@Controller('subjects')
export class SubjectsController {
  constructor(private readonly subjectsService: SubjectsService) {}

  /**
   * GET /subjects/counts?major_id=<uuid>
   * Returns subject count per year level: { "3": 5, "4": 8, ... }
   */
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
  @UseGuards(JwtAuthGuard)
  @Get('mine')
  getMine(@Request() req: AuthenticatedRequest) {
    return this.subjectsService.findMine(req.user.sub);
  }

  /** PATCH /subjects/:id — update own subject (name / semester) */
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
  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  removeOwn(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.subjectsService.removeOwn(id, req.user.sub);
  }
}
