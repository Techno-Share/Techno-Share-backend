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
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateBookDto {
  @ApiPropertyOptional({
    description: 'New title.',
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(TITLE_PATTERN, { message: TITLE_MESSAGE })
  title?: string;

  /** '' clears it — the "Other" choice. */
  @ApiPropertyOptional({
    description: 'New department, or an empty string for none.',
    format: 'uuid',
  })
  @IsOptional()
  @ValidateIf((o: UpdateBookDto) => o.department !== '')
  @IsUUID('4', { message: 'Department must be a valid selection' })
  department?: string;

  @ApiPropertyOptional({
    description: 'New description.',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @Matches(NO_TEMPLATE_CHARS_PATTERN, { message: NO_TEMPLATE_CHARS_MESSAGE })
  description?: string;

  /** Omit to keep the current cover; a book is never without one. */
  @ApiPropertyOptional({
    description: 'New cover, from POST /books/upload-cover.',
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Cover image is required' })
  @MaxLength(2000)
  cover_image_url?: string;
}
