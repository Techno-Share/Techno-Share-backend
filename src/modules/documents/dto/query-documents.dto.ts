import {
  IsIn,
  IsOptional,
  IsUUID,
  IsEnum,
  IsString,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { DocType } from './create-document.dto';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class QueryDocumentsDto {
  @ApiPropertyOptional({
    description: 'Only documents in this department.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  major_id?: string;

  @ApiPropertyOptional({
    description: 'Only documents for this subject.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  subject_id?: string;

  @ApiPropertyOptional({
    description: 'Only this document type.',
    enum: DocType,
  })
  @IsOptional()
  @IsEnum(DocType)
  doc_type?: DocType;

  @ApiPropertyOptional({
    description: 'Case-insensitive partial match on the title.',
    example: 'signals',
  })
  @IsOptional()
  @IsString()
  search?: string; // matches against title

  @ApiPropertyOptional({
    description: 'Exact title match, unlike `search`.',
  })
  @IsOptional()
  @IsString()
  title?: string; // exact title match

  @ApiPropertyOptional({
    description: 'All documents uploaded together in one submission.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  group_id?: string;

  @ApiPropertyOptional({
    description: 'Only this year.',
    minimum: 1,
    maximum: 5,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  year_level?: number;

  @ApiPropertyOptional({
    description: 'Only this academic year.',
    example: '2024-2025',
  })
  @IsOptional()
  @IsString()
  academic_year?: string; // e.g. "2024-2025"

  // query-documents.dto.ts
  @ApiPropertyOptional({
    description: 'Only documents from this uploader.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  uploader_id?: string;

  /**
   * How the list is ordered. 'pinned' (the default) floats the viewer's pins to
   * the top, which is what a browse feed wants. 'date' is a plain reverse
   * chronology — the owner's own dashboard is a record of what they uploaded
   * and when, so a pin reordering it there makes the dates look wrong.
   */
  @ApiPropertyOptional({
    description:
      '`pinned` puts pinned documents first; `date` is newest first.',
    enum: ['pinned', 'date'],
  })
  @IsOptional()
  @IsIn(['pinned', 'date'])
  sort?: 'pinned' | 'date';

  /**
   * Review state to list. Defaults to 'active' — the public feed.
   *
   * Anything other than 'active' is only honoured when listing your OWN
   * uploads (uploader_id === the caller); see findAll. Without that gate,
   * `?status=pending` would list every unreviewed upload in the institute.
   */
  @ApiPropertyOptional({
    description:
      'Review state. Only your own pending or rejected documents are visible to you.',
    enum: ['pending', 'active', 'rejected'],
  })
  @IsOptional()
  @IsIn(['pending', 'active', 'rejected'])
  status?: 'pending' | 'active' | 'rejected';

  /**
   * List only hidden uploads. Like `status`, honoured only when listing your
   * own — hiding is the uploader's switch, so nobody else may enumerate them.
   *
   * A string, not a boolean: query params arrive as text, and `Type(() =>
   * Boolean)` would turn the string "false" into `true`.
   */
  @ApiPropertyOptional({
    description: "Filter on the uploader's hide switch.",
    enum: ['true', 'false'],
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  hidden?: 'true' | 'false';

  /**
   * List only uploads whose expiry has passed.
   *
   * Not a `status` value: expiry is a date, and the row stays 'active' in the
   * database precisely so the owner keeps seeing it after it stops being
   * visible to anyone else. Making it a status would need a job to flip rows
   * and would break the visibility rules, which key off 'active'.
   *
   * Gated like `hidden` — only when listing your own, and only the owner's own
   * list returns expired uploads at all (see applyVisibility).
   */
  @ApiPropertyOptional({
    description: 'Filter on soft expiry.',
    enum: ['true', 'false'],
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  expired?: 'true' | 'false';

  @ApiPropertyOptional({
    description: '1-based page number.',
    minimum: 1,
    example: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    description: 'Page size, capped at 50 for this endpoint.',
    minimum: 1,
    maximum: 50,
    example: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
