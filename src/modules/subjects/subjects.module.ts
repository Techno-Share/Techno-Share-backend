import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SubjectsService } from './subjects.service';
import { SubjectsController } from './subjects.controller';
import { Subject } from './entities/subject.entity';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  // NotificationsModule: reviewers are told when a subject is submitted.
  imports: [
    TypeOrmModule.forFeature([Subject]),
    NotificationsModule,
    // ModerationService: only a reviewer for the department may add a subject
    // to it, and the same check decides whether it needs approving.
    AdminModule,
  ],
  controllers: [SubjectsController],
  providers: [SubjectsService],
})
export class SubjectsModule {}
