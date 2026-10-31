import {
  IsNotEmpty,
  IsOptional,
  ValidateIf,
  IsString,
  IsUUID,
  MaxLength,
  Matches,
} from 'class-validator';
import {
  NO_TEMPLATE_CHARS_MESSAGE,
  NO_TEMPLATE_CHARS_PATTERN,
  TITLE_MESSAGE,
  TITLE_PATTERN,
} from '../../../common/dto/text-patterns';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateBookDto {
  @ApiProperty({
    description: 'Book title.',
    example: 'Introduction to Algorithms',
    maxLength: 200,
  })
  @IsString()
  @IsNotEmpty({ message: 'Title is required' })
  @MaxLength(200)
  @Matches(TITLE_PATTERN, { message: TITLE_MESSAGE })
  title!: string;

  /**
   * Optional: the empty string is "Other", i.e. no department. IsOptional only
   * skips undefined, so the ValidateIf is what lets '' through.
   */
  @ApiPropertyOptional({
    description:
      'Department the book is most relevant to. Omit or send an empty string for none.',
    format: 'uuid',
  })
  @IsOptional()
  @ValidateIf((o: CreateBookDto) => o.department !== '')
  @IsUUID('4', { message: 'Department must be a valid selection' })
  department?: string;

  @ApiPropertyOptional({
    description:
      'Condition, edition, anything a borrower should know. Must not contain $, { or }.',
    maxLength: 1000,
  })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  @Matches(NO_TEMPLATE_CHARS_PATTERN, { message: NO_TEMPLATE_CHARS_MESSAGE })
  description?: string;

  @ApiProperty({
    description: 'URL returned by POST /books/upload-cover.',
    example: 'https://cdn.example.org/covers/abc.jpg',
    maxLength: 2000,
  })
  @IsString()
  @IsNotEmpty({ message: 'Cover image is required' })
  @MaxLength(2000)
  cover_image_url!: string;
}
