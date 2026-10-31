import { Transform, Type } from 'class-transformer';
import {
  IsString,
  IsUUID,
  IsOptional,
  IsEnum,
  IsArray,
  MaxLength,
  IsInt,
  IsISO8601,
  Min,
  Max,
  Matches,
  ValidateNested,
} from 'class-validator';
import { DocType, parseAudienceEntries } from './create-document.dto';
import { AudienceEntryDto } from './audience-entry.dto';
import {
  TITLE_MESSAGE,
  TITLE_PATTERN,
} from '../../../common/dto/text-patterns';
import { ApiPropertyOptional } from '@nestjs/swagger';

// Metadata-only edit of an existing upload (files are not changed here).
export class UpdateDocumentDto {
  @ApiPropertyOptional({
    description: 'New title.',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(TITLE_PATTERN, { message: TITLE_MESSAGE })
  title?: string;

  @ApiPropertyOptional({
    description: 'New type. Must belong to the list its major offers.',
    enum: DocType,
  })
  @IsOptional()
  @IsEnum(DocType)
  doc_type?: DocType;

  @ApiPropertyOptional({
    description: 'Move to another department.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  major_id?: string;

  @ApiPropertyOptional({
    description: 'Move to another subject. Send null to detach.',
    format: 'uuid',
    nullable: true,
  })
  @IsOptional()
  @IsUUID()
  subject_id?: string | null;

  // null clears the description; a string sets it.
  @ApiPropertyOptional({
    description: 'New description.',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @ApiPropertyOptional({
    description: 'New year.',
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
    description: 'New academic year.',
    example: '2024-2025',
  })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  academic_year?: string;

  // Who may see this, as (department, year) pairs. Omit it to leave the audience
  // as it is; sending it replaces the lot. Whether it may be empty depends on
  // the major, so that check lives in DocumentsService.resolveAudience.
  @ApiPropertyOptional({
    description: 'Replaces the audience entirely; it is not merged.',
    type: [AudienceEntryDto],
  })
  @IsOptional()
  @Transform(parseAudienceEntries)
  @IsArray()
  @ValidateNested({ each: true })
  audience?: AudienceEntryDto[];

  // null clears the expiry; an ISO 8601 string sets it. @IsOptional() also
  // permits null (validation is skipped for null/undefined).
  //
  // No IsFutureDate here, unlike the create DTO: an already-expired upload
  // prefills its own past date, and editing the title of one shouldn't force
  // the owner to also extend it. DocumentsService.update rejects a past date
  // only when it's actually being CHANGED.
  @ApiPropertyOptional({
    description: 'New soft expiry. Send null to clear it.',
    nullable: true,
  })
  @IsOptional()
  @IsISO8601()
  expires_at?: string | null;
}
