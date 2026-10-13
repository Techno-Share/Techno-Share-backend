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

// Letters (any language, incl. Khmer marks), numbers, spaces and hyphens.
const TITLE_PATTERN = /^(?=.*[\p{L}\p{N}])[\p{L}\p{M}\p{N}\s_-]+$/u;

// Metadata-only edit of an existing upload (files are not changed here).
export class UpdateDocumentDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(TITLE_PATTERN, {
    message: 'Title must not contain special characters',
  })
  title?: string;

  @IsOptional()
  @IsEnum(DocType)
  doc_type?: DocType;

  @IsOptional()
  @IsUUID()
  major_id?: string;

  @IsOptional()
  @IsUUID()
  subject_id?: string | null;

  // null clears the description; a string sets it.
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  year_level?: number;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  academic_year?: string;

  // Who may see this, as (department, year) pairs. Omit it to leave the audience
  // as it is; sending it replaces the lot. Whether it may be empty depends on
  // the major, so that check lives in DocumentsService.resolveAudience.
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
  @IsOptional()
  @IsISO8601()
  expires_at?: string | null;
}
