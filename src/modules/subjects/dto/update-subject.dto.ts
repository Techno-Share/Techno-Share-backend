import {
  IsInt,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ACADEMIC_NAME_PATTERN } from '../../../common/dto/text-patterns';
import { ApiPropertyOptional } from '@nestjs/swagger';

// The acronym isn't here on purpose: it's derived from the name (renaming
// re-derives it), and only an admin can override it — see EditSubjectDto.
export class UpdateSubjectDto {
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

  @ApiPropertyOptional({
    description: 'New semester.',
  })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  @IsIn([1, 2])
  semester?: number;
}
