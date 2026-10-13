import { plainToInstance, Transform, Type } from 'class-transformer';
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
import { IsFutureDate } from '../validators/is-future-date';
import { AudienceEntryDto } from './audience-entry.dto';

// Multipart form-data can't carry a JSON array, so array fields are sent as a
// JSON string (e.g. '["a","b"]') and parsed here; a value that's already an
// array (JSON request bodies) passes through untouched. Bad JSON → [].
export function parseJsonArray({ value }: { value: unknown }): unknown {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    if (value.trim() === '') return [];
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : value;
    } catch {
      return value; // let validation reject it
    }
  }
  return value;
}

/**
 * Same as parseJsonArray, but the entries come back as AudienceEntryDto
 * instances. A property-level @Transform replaces class-transformer's own
 * conversion, so @Type() alongside it is ignored — the entries would stay plain
 * objects, and `forbidNonWhitelisted` would then reject every one of their
 * properties as unknown.
 */
export function parseAudienceEntries({ value }: { value: unknown }): unknown {
  const parsed = parseJsonArray({ value });
  if (!Array.isArray(parsed)) return parsed;
  return parsed.map((entry) => plainToInstance(AudienceEntryDto, entry));
}

export enum DocType {
  // Department courses
  Note = 'Note',
  TD = 'TD',
  TP = 'TP',
  Project = 'Project',
  Lesson = 'Lesson',
  Thesis = 'Thesis',
  // Language courses (Department of Foreign Languages)
  Grammar = 'Grammar',
  Vocabulary = 'Vocabulary',
  Speaking = 'Speaking',
  Listening = 'Listening',
  Reading = 'Reading',
  Writing = 'Writing',
  PracticeExercises = 'Practice Exercises',
  // Both
  ExamPreparation = 'Exam Preparation',
  Other = 'Other',
}

// A language course produces a different kind of material than a department
// course, so each offers its own list — 'Exam Preparation' and 'Other' are the
// shared entries. The upload form picks the list from the doc's major; the API
// enforces it.
export const DEPARTMENT_DOC_TYPES = [
  DocType.Note,
  DocType.TD,
  DocType.ExamPreparation,
  DocType.TP,
  DocType.Project,
  DocType.Lesson,
  DocType.Thesis,
  DocType.Other,
];

export const LANGUAGE_DOC_TYPES = [
  DocType.Grammar,
  DocType.Vocabulary,
  DocType.Speaking,
  DocType.Listening,
  DocType.Reading,
  DocType.Writing,
  DocType.ExamPreparation,
  DocType.PracticeExercises,
  DocType.Other,
];

export const DOC_TYPES = Object.values(DocType);

// Letters (any language, incl. Khmer marks), numbers, spaces and hyphens —
// at least one letter/number. No special characters.
const TITLE_PATTERN = /^(?=.*[\p{L}\p{N}])[\p{L}\p{M}\p{N}\s_-]+$/u;

export class CreateDocumentDto {
  @IsString()
  @MaxLength(100)
  @Matches(TITLE_PATTERN, {
    message: 'Title must not contain special characters',
  })
  title?: string;

  @IsEnum(DocType)
  doc_type: DocType;

  @IsUUID()
  major_id: string;

  // Required: every document belongs to a subject. The upload form marks the
  // field with an asterisk and the feed groups by it, but this used to be
  // optional, so a department/year with no subjects yet could post one with no
  // subject at all. UpdateDocumentDto keeps its own optional copy — a metadata
  // edit may leave the subject alone.
  @IsUUID()
  subject_id: string;

  // Optional free-text description (replaced tags).
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsInt()
  @Type(() => Number)
  @Min(1)
  @Max(5)
  year_level: number;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  academic_year?: string;

  // Who may see this, as (department, year) pairs — sent as a JSON string
  // (multipart). Required in practice, but a doc belonging to a language course
  // carries no audience at all; since that depends on the major, emptiness is
  // checked in the service (DocumentsService.resolveAudience), not here.
  @IsOptional()
  @Transform(parseAudienceEntries)
  @IsArray()
  @ValidateNested({ each: true })
  audience?: AudienceEntryDto[];

  // Files already sent to POST /documents/staged-files while the user was
  // filling in this form. Either these or multipart `files` must be present.
  @IsOptional()
  @Transform(parseJsonArray)
  @IsArray()
  @IsUUID('4', { each: true })
  staged_file_ids?: string[];

  // Optional soft-expiry timestamp (ISO 8601). Omit = never expires. A new
  // upload can't start out already expired — the form sends the END of the
  // chosen local day, so "today" still counts as future.
  @IsOptional()
  @IsISO8601()
  @IsFutureDate({ message: 'expires_at must be in the future' })
  expires_at?: string;
}
