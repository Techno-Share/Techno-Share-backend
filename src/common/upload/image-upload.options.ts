import { BadRequestException } from '@nestjs/common';
import { memoryStorage } from 'multer';

/**
 * Multer options for a single user-supplied image.
 *
 * Memory storage, because every image here is handed straight to the object
 * store — writing it to the container's disk first would only create a file
 * nobody deletes.
 *
 * The same three rules the majors and subjects controllers already apply,
 * lifted out so a new upload route cannot quietly disagree with them about
 * what an acceptable image is.
 */
export const ALLOWED_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
];
export const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

export const IMAGE_UPLOAD_OPTIONS = {
  storage: memoryStorage(),
  limits: { fileSize: MAX_IMAGE_SIZE_BYTES },
  fileFilter: (
    _req: unknown,
    file: Express.Multer.File,
    cb: (error: Error | null, acceptFile: boolean) => void,
  ) => {
    if (ALLOWED_IMAGE_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      // A plain Error here surfaces as a 500; this keeps it a 400.
      cb(
        new BadRequestException(
          `Unsupported image type '${file.mimetype}' — use JPEG, PNG or WebP`,
        ),
        false,
      );
    }
  },
};
