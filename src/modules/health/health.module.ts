import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/**
 * No providers and no imports: RedisModule and SecurityModule are both @Global,
 * so their services are already injectable, and the DataSource comes from the
 * root TypeORM registration.
 */
@Module({ controllers: [HealthController] })
export class HealthModule {}
