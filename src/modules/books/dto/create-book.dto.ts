import {
  IsNotEmpty,
  IsOptional,
  ValidateIf,
  IsString,
  IsUUID,
  MaxLength,
  Matches,
} from 'class-validator';

// Letters (any language, incl. Khmer marks), numbers, spaces and hyphens —
// at least one letter/number. No special characters.
const TITLE_PATTERN = /^(?=.*[\p{L}\p{N}])[\p{L}\p{M}\p{N}\s_-]+$/u;
// Free text that simply must not contain template-injection characters.
const NO_FORBIDDEN_PATTERN = /^[^${}]*$/;
const FORBIDDEN_MESSAGE = 'Must not contain $, { or }';

export class CreateBookDto {
  @IsString()
  @IsNotEmpty({ message: 'Title is required' })
  @MaxLength(200)
  @Matches(TITLE_PATTERN, {
    message: 'Title must not contain special characters',
  })
  title!: string;

  /**
   * Optional: the empty string is "Other", i.e. no department. IsOptional only
   * skips undefined, so the ValidateIf is what lets '' through.
   */
  @IsOptional()
  @ValidateIf((o: CreateBookDto) => o.department !== '')
  @IsUUID('4', { message: 'Department must be a valid selection' })
  department?: string;

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  @Matches(NO_FORBIDDEN_PATTERN, { message: FORBIDDEN_MESSAGE })
  description?: string;

  @IsString()
  @IsNotEmpty({ message: 'Cover image is required' })
  @MaxLength(2000)
  cover_image_url!: string;
}
