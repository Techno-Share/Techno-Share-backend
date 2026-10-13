import {
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { MulterError } from 'multer';
import { UPLOAD_LIMITS } from '../upload-limits';

/**
 * Turn Multer's rejections into answers a person can act on.
 *
 * Multer throws `MulterError`, which is not an HttpException — so without this
 * it falls through to AllExceptionsFilter as an unknown failure and the caller
 * gets `500 Internal server error`. Two things were wrong with that: the
 * student is told the server broke when in fact their file is simply too big,
 * and the operator gets an ERROR line with a stack trace for something that is
 * not a fault at all. Picking a large file is ordinary use, and it should read
 * like a limit, not a crash.
 *
 * The messages carry the actual numbers. "File too large" leaves the reader to
 * guess whether they are slightly over or need a different approach entirely;
 * "larger than the 50 MB limit" tells them which.
 */
@Catch(MulterError)
export class MulterExceptionFilter implements ExceptionFilter {
  // `host` is unused on purpose: this filter re-throws rather than writing the
  // response, so AllExceptionsFilter still gets to log the result.
  catch(error: MulterError) {
    const { status, message } = describe(error);

    // Re-thrown as an HttpException rather than written to the response here,
    // so AllExceptionsFilter still logs it — at WARN, as the 4xx it now is.
    throw new HttpException({ statusCode: status, message }, status, {
      cause: error,
    });
  }
}

function describe(error: MulterError): { status: number; message: string } {
  switch (error.code) {
    case 'LIMIT_FILE_SIZE':
      return {
        status: HttpStatus.PAYLOAD_TOO_LARGE,
        message: `This file is larger than the ${UPLOAD_LIMITS.maxFileMb} MB limit. Try compressing it, or split it into smaller files.`,
      };

    case 'LIMIT_FILE_COUNT':
      return {
        status: HttpStatus.BAD_REQUEST,
        message: `You can upload up to ${UPLOAD_LIMITS.maxFiles} files at a time.`,
      };

    case 'LIMIT_UNEXPECTED_FILE':
      return {
        status: HttpStatus.BAD_REQUEST,
        message: 'That file was sent under an unexpected field name.',
      };

    default:
      // Still a 400 rather than a 500: every MulterError is about what the
      // client sent, not about this server failing.
      return {
        status: HttpStatus.BAD_REQUEST,
        message: 'That upload could not be read.',
      };
  }
}
