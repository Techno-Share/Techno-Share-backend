import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { NotificationsService } from './notifications.service';
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiAuth,
  ApiNotFound,
  envelope,
} from '../../common/swagger/api-responses.decorator';
import { API_TAGS } from '../../common/swagger/swagger.config';

type AuthenticatedRequest = { user: { sub: string; email: string } };

@ApiTags(API_TAGS.notifications)
@ApiAuth()
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  /** GET /notifications */
  @ApiOperation({
    summary: 'List your notifications',
    description: 'Newest first, for the signed-in account only.',
  })
  @ApiOkResponse({
    description: 'Your notifications.',
    schema: envelope({
      type: 'array',
      items: { type: 'object', additionalProperties: true },
    }),
  })
  @Get()
  getAll(@Request() req: AuthenticatedRequest) {
    return this.notificationsService.getForUser(req.user.sub);
  }

  /** PATCH /notifications/read-all */
  @ApiOperation({
    summary: 'Mark every notification read',
    description: 'Marks all of your unread notifications as read in one call.',
  })
  @ApiOkResponse({
    description: 'All marked read.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @Patch('read-all')
  markAllRead(@Request() req: AuthenticatedRequest) {
    return this.notificationsService.markAllRead(req.user.sub);
  }

  /** PATCH /notifications/:id/read */
  @ApiOperation({
    summary: 'Mark one notification read',
    description:
      "Only your own notifications can be marked; another account's id is treated as not found.",
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'The notification to mark read.',
  })
  @ApiOkResponse({
    description: 'Marked read.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiNotFound('No such notification for this account.')
  @Patch(':id/read')
  markRead(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.notificationsService.markRead(req.user.sub, id);
  }
}
