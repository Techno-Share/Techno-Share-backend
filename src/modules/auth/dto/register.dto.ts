import {
  IsEmail,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  PERSON_NAME_MESSAGE,
  PERSON_NAME_PATTERN,
} from '../../../common/dto/text-patterns';
import { ApiProperty } from '@nestjs/swagger';

/**
 * One capital or Khmer character, then letters, and nothing else.
 *
 * Three rules in one pattern: no spaces, no digits or punctuation, and a
 * capital first letter. The form checks the same three separately so it can say
 * which one was broken; here a single message is enough, because the only way
 * to reach this check is to post straight to the API and skip the form.
 *
 * `ក-៿` is the Khmer block, and it appears in the FIRST position as well as the
 * rest on purpose: Khmer has no letter case, so requiring a capital would make
 * it impossible to register under a Khmer name.
 */

/**
 * Everything needed to create an account, in one request.
 *
 * Submitting this creates the user but does NOT sign them in: the address is
 * unproven until the emailed link is opened, and login refuses until it is.
 *
 * Student ID, major and year are deliberately absent — all three start null and
 * the complete-profile prompt collects them. Until major and year are set,
 * audience-restricted uploads stay hidden, since canView matches on that pair.
 */
export class RegisterDto {
  @ApiProperty({
    description:
      'Given name. One capital (or any Khmer character) then letters only — no spaces, digits or punctuation.',
    example: 'Sophea',
    maxLength: 50,
  })
  @IsString()
  @IsNotEmpty({ message: 'First name is required' })
  @MaxLength(50)
  @Matches(PERSON_NAME_PATTERN, { message: PERSON_NAME_MESSAGE })
  first_name: string;

  @ApiProperty({
    description: 'Family name. Same rule as the given name.',
    example: 'Chan',
    maxLength: 50,
  })
  @IsString()
  @IsNotEmpty({ message: 'Last name is required' })
  @MaxLength(50)
  @Matches(PERSON_NAME_PATTERN, { message: PERSON_NAME_MESSAGE })
  last_name: string;

  @ApiProperty({
    description:
      'Must be unused. A six-digit code is sent here and the account cannot sign in until it is confirmed.',
    example: 'sophea.chan@itc.edu.kh',
    format: 'email',
  })
  @IsEmail({}, { message: 'Enter a valid email address' })
  email: string;

  @ApiProperty({
    description: 'At least 8 characters.',
    example: 'correct-horse-battery',
    minLength: 8,
    format: 'password',
  })
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  password: string;
}
