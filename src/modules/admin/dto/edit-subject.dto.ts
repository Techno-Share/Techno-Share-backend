import {
  IsInt,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SUBJECT_ACRONYM_PATTERN } from '../../subjects/dto/create-subject.dto';
import { ACADEMIC_NAME_PATTERN } from '../../../common/dto/text-patterns';
import { ApiPropertyOptional } from '@nestjs/swagger';

// Admin edit of an existing subject — name, acronym and/or semester. Everyone
// else gets the acronym derived from the name; this is the only way to override
// it.
export class EditSubjectDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(ACADEMIC_NAME_PATTERN, {
    message: 'Subject name must not contain special characters',
  })
  @ApiPropertyOptional({
    description: 'New subject name.',
  })
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  @Matches(SUBJECT_ACRONYM_PATTERN, {
    message: 'Acronym can only contain letters and numbers, with no lowercase',
  })
  @ApiPropertyOptional({
    description:
      'Letters and numbers, no lowercase. Khmer is allowed here, unlike a department acronym.',
  })
  acronym?: string;

  @ApiPropertyOptional({
    description: 'New semester.',
  })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  @IsIn([1, 2])
  semester?: number;

  /**
   * The cover, as a URL. An uploaded `image` file wins over this; the empty
   * string clears the cover, which is how the form removes one — IsOptional
   * only skips `undefined`, so '' still reaches the service.
   */
  @ApiPropertyOptional({
    description: 'New syllabus link.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  subject_url?: string;
}
