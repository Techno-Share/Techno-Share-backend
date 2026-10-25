import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BooksService } from './books.service';
import { BooksController } from './books.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { Book } from './entities/book.entity';
import { BookRequest } from './entities/book-request.entity';
import { Notification } from '../notifications/entities/notification.entity';
import { User } from '../users/entities/user.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Book, BookRequest, Notification, User]),
    MulterModule.register({ storage: undefined }),
    NotificationsModule,
  ],
  controllers: [BooksController],
  providers: [BooksService],
})
export class BooksModule {}
