import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import configuration from './config/configuration';
import { validateEnv } from './config/validation';
import { MailModule } from './modules/mail/mail.module';
import { DatabaseModule } from './database/database.module';
import { DevAlertModule } from './common/alerts/dev-alert.module';
import { RedisModule } from './common/redis/redis.module';
import { SecurityModule } from './common/security/security.module';
import { StorageModule } from './modules/storage/storage.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { MajorsModule } from './modules/majors/majors.module';
import { SubjectsModule } from './modules/subjects/subjects.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { AdminModule } from './modules/admin/admin.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { TelegramModule } from './modules/telegram/telegram.module';
import { RateLimitModule } from './common/rate-limit/rate-limit.module';
import { HealthModule } from './modules/health/health.module';
import { BooksModule } from './modules/books/books.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { MulterExceptionFilter } from './common/filters/multer-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateEnv,
    }),
    // Drives the book-reservation expiry sweep; see BooksScheduler.
    ScheduleModule.forRoot(),
    DatabaseModule,
    // Before anything that counts: the rate limiter and the upload quota both
    // resolve their store from it.
    RedisModule,
    // Global: any service may report a security event without its module
    // declaring a dependency on an observability channel.
    DevAlertModule,
    SecurityModule,
    MailModule,
    StorageModule,
    AuthModule,
    UsersModule,
    MajorsModule,
    SubjectsModule,
    DocumentsModule,
    AdminModule,
    NotificationsModule,
    TelegramModule,
    // Registers the APP_GUARD that counts every request. See its module doc.
    RateLimitModule,
    BooksModule,
    // Liveness/readiness probes for Docker and monitoring.
    HealthModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Registered as providers rather than app.useGlobal*() so Nest injects into
    // them (TransformInterceptor needs Reflector for @ResponseMessage).
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    // Together these log every request exactly once: the interceptor covers
    // successes, the filter covers failures (including guard rejections, which
    // never reach an interceptor).
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    // Order matters: Nest applies the LAST-registered filter first, so the
    // Multer one gets to turn its errors into 4xx before AllExceptionsFilter
    // would log them as 500s.
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_FILTER, useClass: MulterExceptionFilter },
  ],
})
export class AppModule {}
