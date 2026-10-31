import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { User } from './entities/user.entity';
import { PromotionEvent } from './entities/promotion-event.entity';
import { DepartmentModerator } from '../admin/entities/department-moderator.entity';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, PromotionEvent, DepartmentModerator]),
    SettingsModule,
  ],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService], // exported so AuthService can reuse getMe() if needed
})
export class UsersModule {}
