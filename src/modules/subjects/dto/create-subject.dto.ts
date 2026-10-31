import {
  IsString,
  IsUUID,
  IsInt,
  Min,
  Max,
  IsIn,
  MaxLength,
  IsUrl,
  IsOptional,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ACADEMIC_NAME_PATTERN } from '../../../common/dto/text-patterns';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// A subject's acronym: letters/numbers with no lowercase, e.g. WD, DS, A1.
// Letters are matched by Unicode class rather than [A-Z0-9] so a Khmer name can
// still produce one — scripts without case pass the "no lowercase" test.
export const SUBJECT_ACRONYM_PATTERN = /^(?!.*\p{Ll})[\p{L}\p{M}\p{N}]+$/u;

export class CreateSubjectDto {
  @ApiProperty({
    description: 'Department the subject belongs to.',
    format: 'uuid',
  })
  @IsUUID()
  major_id!: string;

  @IsString()
  @MaxLength(100)
  @Matches(ACADEMIC_NAME_PATTERN, {
    message: 'Subject name must not contain special characters',
  })
  @ApiProperty({
    description: 'Subject name. Letters, numbers, spaces and hyphens.',
    example: 'Signals and Systems',
  })
  name!: string;

  @ApiProperty({
    description: 'Year the subject is taught in.',
    minimum: 1,
    maximum: 5,
    example: 4,
  })
  @IsInt()
  @Type(() => Number)
  @Min(1)
  @Max(5)
  year_level!: number;

  @ApiProperty({
    description: 'Semester within that year.',
    example: 1,
  })
  @IsInt()
  @Type(() => Number)
  @IsIn([1, 2])
  semester!: number;

  @ApiPropertyOptional({
    description: 'Optional link to a syllabus or course page.',
  })
  @IsOptional()
  @IsUrl()
  subject_url?: string;
}
