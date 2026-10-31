import {
  Matches,
  IsArray,
  ArrayMaxSize,
  IsString,
  IsOptional,
  IsUUID,
  IsInt,
  Min,
  Max,
  IsUrl,
  MaxLength,
} from 'class-validator';
import {
  PERSON_NAME_MESSAGE,
  PERSON_NAME_PATTERN,
} from '../../../common/dto/text-patterns';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Same rule as registration — see RegisterDto for why the Khmer block sits in
 * the first position too. Enforced here as well so the profile editor cannot
 * be used to set a name that sign-up would have refused.
 */

export class UpdateUserDto {
  @ApiPropertyOptional({
    description: 'New given name.',
    maxLength: 50,
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Matches(PERSON_NAME_PATTERN, { message: PERSON_NAME_MESSAGE })
  first_name?: string;

  @ApiPropertyOptional({
    description: 'New family name.',
    maxLength: 50,
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Matches(PERSON_NAME_PATTERN, { message: PERSON_NAME_MESSAGE })
  last_name?: string;

  @ApiPropertyOptional({
    description:
      'Department. Settable once through the welcome page; with year_level it decides which documents are visible.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  major_id?: string;

  @ApiPropertyOptional({
    description: 'Year level. Foundation runs 1-2, departments 3-5.',
    minimum: 1,
    maximum: 5,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  year_level?: number;

  /**
   * `require_tld: false`, which is the whole reason avatar uploads worked in
   * production and failed locally.
   *
   * The URL comes from our own storage service — `${S3_PUBLIC_URL}/user-avatar/…`
   * — and in development that is `http://localhost:9000`. validator.isURL
   * demands a top-level domain by default, so `localhost` is refused and the
   * upload succeeded while the save that recorded it did not: the file landed
   * in MinIO and the row never learned about it.
   *
   * Still a URL check, not a free string. Note it does NOT constrain the host
   * to our own storage — that was already true before this change — so a
   * client can set any valid URL here and it will be rendered as an <img src>.
   * Tightening that means comparing against S3_PUBLIC_URL, which is a
   * deployment value and would invalidate stored avatars if it ever changed.
   */
  @ApiPropertyOptional({
    description: 'Profile photo URL. POST /users/avatar returns one.',
  })
  @IsOptional()
  @IsUrl({ require_tld: false })
  avatar_url?: string;

  /**
   * Telegram handle or t.me link. The empty string is allowed so the field can
   * be cleared — IsOptional only skips `undefined`.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @ApiPropertyOptional({
    description:
      'The handle in use for notifications, as @name or a t.me link.',
    example: '@sophea',
  })
  @Matches(
    /^$|^@?[A-Za-z0-9_]{4,32}$|^(https?:\/\/)?t\.me\/[A-Za-z0-9_]{4,32}$/,
    {
      message: 'Enter a Telegram username like @student or a t.me link',
    },
  )
  telegram?: string;

  /**
   * The whole saved set, replacing what is stored. No empty string here — an
   * account is removed by leaving it out of the list, not by blanking it.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5, { message: 'You can save up to 5 Telegram accounts' })
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  @Matches(/^@?[A-Za-z0-9_]{4,32}$|^(https?:\/\/)?t\.me\/[A-Za-z0-9_]{4,32}$/, {
    each: true,
    message: 'Enter a Telegram username like @student or a t.me link',
  })
  @ApiPropertyOptional({
    description: 'Every saved handle. `telegram` must be one of them.',
    type: [String],
  })
  telegram_handles?: string[];
}
