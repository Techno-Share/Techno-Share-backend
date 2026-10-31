import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Request,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UsersService } from './users.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { RateLimitTier } from '../../common/rate-limit/rate-limit.decorator';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiAuth,
  ApiRateLimited,
  ApiUploadLimits,
  ERROR_SCHEMA,
  envelope,
} from '../../common/swagger/api-responses.decorator';
import { API_TAGS } from '../../common/swagger/swagger.config';

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_AVATAR_SIZE = 20 * 1024 * 1024; // 20 MB

type AuthenticatedRequest = {
  user: {
    sub: string;
    email: string;
  };
};

@UseGuards(JwtAuthGuard) // All routes in this controller require a valid JWT
@ApiTags(API_TAGS.users)
@ApiAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /**
   * GET /users/me
   * Returns the full profile of the currently authenticated user.
   */
  @ApiOperation({
    summary: 'Get the signed-in profile',
    description:
      "Returns the caller's own profile. Also applies a scheduled promotion if one is owed: the year advances here rather than by a batch job, so promoted_to_year is non-null on exactly the one response that moved them and null on every call after. needs_department_choice is true for a Foundation year 2 student who must pick a department before advancing.",
  })
  @ApiOkResponse({
    description: 'The profile, with moderation and promotion flags.',
    schema: envelope({
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        first_name: { type: 'string' },
        last_name: { type: 'string' },
        email: { type: 'string', format: 'email' },
        role: { type: 'string', enum: ['user', 'admin'] },
        year_level: { type: 'number', nullable: true },
        major_id: { type: 'string', format: 'uuid', nullable: true },
        majors: { type: 'object', nullable: true, additionalProperties: true },
        is_moderator: {
          type: 'boolean',
          description:
            'Moderates at least one department. A capability, not a role.',
        },
        needs_department_choice: { type: 'boolean' },
        promoted_to_year: {
          type: 'number',
          nullable: true,
          description: 'Non-null on the single response that advanced them.',
        },
      },
    }),
  })
  @Get('me')
  getMe(@Request() req: AuthenticatedRequest) {
    return this.usersService.getMe(req.user.sub);
  }

  /**
   * PATCH /users/me
   * Partially updates the authenticated user's profile.
   * All fields are optional — only provided fields are written.
   */
  @ApiOperation({
    summary: 'Update the signed-in profile',
    description:
      'Partial update - only the fields sent are written. Department and year are what document visibility is matched against, so changing them changes which documents the account can see.',
  })
  @ApiOkResponse({
    description: 'The updated profile.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiBadRequestResponse({
    description: 'Validation failed.',
    schema: ERROR_SCHEMA,
  })
  @Patch('me')
  updateMe(@Request() req: AuthenticatedRequest, @Body() dto: UpdateUserDto) {
    return this.usersService.updateMe(req.user.sub, dto);
  }

  /**
   * POST /users/avatar
   * Uploads a new profile picture and returns its public URL.
   */
  @ApiOperation({
    summary: 'Upload a profile photo',
    description:
      'JPEG, PNG or WebP, up to 20 MB. The image is re-encoded and stored; the returned URL is what to send back as avatar_url.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'JPEG, PNG or WebP, max 20 MB.',
        },
      },
    },
  })
  @ApiCreatedResponse({
    description: 'Stored. Returns the URL to save on the profile.',
    schema: envelope({
      type: 'object',
      properties: { avatar_url: { type: 'string' } },
    }),
  })
  @ApiBadRequestResponse({
    description: 'No file sent, or an unsupported image type.',
    schema: ERROR_SCHEMA,
  })
  @ApiUploadLimits(20)
  @ApiRateLimited()
  @RateLimitTier('upload')
  @Post('avatar')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_AVATAR_SIZE },
      fileFilter: (_req, file, cb) => {
        if (ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
          cb(null, true);
        } else {
          cb(
            new BadRequestException(
              'Only JPEG, PNG, and WebP images are allowed',
            ),
            false,
          );
        }
      },
    }),
  )
  uploadAvatar(
    @Request() req: AuthenticatedRequest,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('No file provided');
    return this.usersService.uploadAvatar(req.user.sub, file);
  }
}
