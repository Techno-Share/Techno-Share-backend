import {
  IsString,
  MaxLength,
  IsUrl,
  IsOptional,
  Matches,
} from 'class-validator';
import { ACADEMIC_NAME_PATTERN } from '../../../common/dto/text-patterns';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// Acronyms are uppercase letters/digits (GIC, AMS, GTR…).
export const MAJOR_ACRONYM_PATTERN = /^[A-Z0-9]+$/;

export class CreateMajorDto {
  @IsString()
  @MaxLength(100)
  @Matches(ACADEMIC_NAME_PATTERN, {
    message: 'Major name must not contain special characters',
  })
  @ApiProperty({
    description: 'Full department name.',
    example: 'Computer Science and Engineering',
    maxLength: 100,
  })
  name!: string;

  // Kept uppercase and unique: the frontend resolves a department page by
  // lowercasing this and matching it against the route slug, so two majors
  // sharing an acronym would make that lookup ambiguous.
  @IsString()
  @MaxLength(10)
  @Matches(MAJOR_ACRONYM_PATTERN, {
    message: 'Acronym must be uppercase letters and numbers only',
  })
  @ApiProperty({
    description:
      'Uppercase letters and numbers only - the department page resolves its route by lowercasing this, so it must also be unique.',
    example: 'GIC',
    maxLength: 10,
  })
  acronym!: string;

  @ApiPropertyOptional({
    description:
      'Department logo. Usually set by uploading `image` as multipart instead.',
  })
  @IsOptional()
  @IsUrl()
  image_url?: string;
}
