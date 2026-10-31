import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { API_TAGS } from './common/swagger/swagger.config';

@ApiTags(API_TAGS.health)
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @ApiOperation({
    summary: 'Service banner',
    description:
      'Public. A plain string confirming the API is reachable. Use /health/live for an orchestrator probe - this route has no uptime or dependency information.',
  })
  @ApiOkResponse({
    description: 'A short banner string, wrapped in the usual envelope.',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        data: { type: 'string', example: 'Hello World!' },
        message: { type: 'string', example: 'Request successful' },
      },
    },
  })
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}
