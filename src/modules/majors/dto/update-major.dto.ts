import {
  IsString,
  MaxLength,
  IsUrl,
  IsOptional,
  Matches,
} from 'class-validator';
import { MAJOR_ACRONYM_PATTERN } from './create-major.dto';
import { ACADEMIC_NAME_PATTERN } from '../../../common/dto/text-patterns';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Every field optional — the form sends only what changed, and a multipart
 * request can carry just a new logo.
 */
export class UpdateMajorDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(ACADEMIC_NAME_PATTERN, {
    message: 'Major name must not contain special characters',
  })
  @ApiPropertyOptional({
    description: 'New department name.',
    maxLength: 100,
  })
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  @Matches(MAJOR_ACRONYM_PATTERN, {
    message: 'Acronym must be uppercase letters and numbers only',
  })
  @ApiPropertyOptional({
    description: 'New acronym. Uppercase letters and numbers only, and unique.',
    maxLength: 10,
  })
  acronym?: string;

  @ApiPropertyOptional({
    description: 'New logo URL.',
  })
  @IsOptional()
  @IsUrl()
  image_url?: string;
}
