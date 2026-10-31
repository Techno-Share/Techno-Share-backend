import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Promote to admin or demote back. Moderator is an assignment, not a role. */
export class SetUserRoleDto {
  @ApiProperty({
    description: 'The role to set. You cannot change your own.',
    enum: ['user', 'admin'],
    example: 'admin',
  })
  @IsIn(['user', 'admin'])
  role!: 'user' | 'admin';
}

export class BanUserDto {
  /** Shown to the user when they try to sign in. */
  @ApiPropertyOptional({
    description:
      'Why the account was banned. Kept in the ban history even after the ban is lifted.',
    maxLength: 200,
    example: 'Repeated copyright complaints',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

/**
 * Move a student to a different department and year.
 *
 * Students cannot do this to themselves — the pair decides which documents they
 * can see, so PATCH /users/me refuses it once their profile is set. Placement
 * is the institute's call, which makes this an admin-only correction.
 */
export class SetUserPlacementDto {
  @ApiProperty({
    description: 'The department to place the student in.',
    format: 'uuid',
  })
  @IsUUID('4', { message: 'Department must be a valid selection' })
  major_id!: string;

  @ApiProperty({
    description:
      'The year within that department. Must be one the department actually has: Foundation runs 1-2 and departments run 3-5.',
    minimum: 1,
    maximum: 5,
    example: 4,
  })
  @Type(() => Number)
  @IsInt({ message: 'Year must be a whole number' })
  @Min(1)
  @Max(5)
  year_level!: number;
}
