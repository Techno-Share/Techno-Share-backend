import { Transform } from 'class-transformer';
import { IsArray, IsOptional, IsUUID } from 'class-validator';
import { parseJsonArray } from './create-document.dto';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Body of POST /documents/:id/files. The files themselves may arrive as
 * multipart, or as ids of files the form staged earlier — same two routes in as
 * a new upload.
 */
export class AddFilesDto {
  @ApiPropertyOptional({
    description:
      'Ids from POST /documents/staged-files to attach to this document. Either these or multipart `files` must be present.',
    type: [String],
    format: 'uuid',
  })
  @IsOptional()
  @Transform(parseJsonArray)
  @IsArray()
  @IsUUID('4', { each: true })
  staged_file_ids?: string[];
}
