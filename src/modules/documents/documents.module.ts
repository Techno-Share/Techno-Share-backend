import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentsService } from './documents.service';
import { DocumentsController } from './documents.controller';
import { MulterModule } from '@nestjs/platform-express';
import { Upload } from './entities/upload.entity';
import { DocumentFile } from './entities/document.entity';
import { User } from '../users/entities/user.entity';
import { Major } from '../majors/entities/major.entity';
import { StagedFile } from './entities/staged-file.entity';
import { UploadPin } from './entities/upload-pin.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { RateLimitModule } from '../../common/rate-limit/rate-limit.module';
import { AdminModule } from '../admin/admin.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Upload,
      DocumentFile,
      User,
      Major,
      StagedFile,
      UploadPin,
    ]),
    MulterModule.register({ storage: undefined }),
    // Reviewers are told when an upload enters their queue.
    NotificationsModule,
    // For the per-user upload byte budget. StorageModule is @Global, so
    // StorageService and ImageOptimizeService need no import here.
    RateLimitModule,
    // For ModerationService: an upload by someone who may approve that
    // department is approved on the spot. AdminModule does not import this
    // one, so the dependency is one-way.
    AdminModule,
  ],
  controllers: [DocumentsController],
  providers: [DocumentsService],
})
export class DocumentsModule {}
