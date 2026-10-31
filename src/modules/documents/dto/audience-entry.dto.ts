import { IsInt, IsUUID, Max, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * One department + year that may see an upload. The form adds these one at a
 * time — pick a department, pick a year — so "GIC year 3" is stored as exactly
 * that, not as an intersection of two independent lists.
 */
export class AudienceEntryDto {
  @ApiProperty({
    description: 'The department this pair targets.',
    format: 'uuid',
    example: '2f1c9a42-61b0-4a7e-9f3c-9a1b2c3d4e5f',
  })
  @IsUUID()
  major_id!: string;

  @ApiProperty({
    description:
      'Year within that department. Foundation (TC) runs 1–2, departments run 3–5; DFL uses 1 for English and 2 for French.',
    minimum: 1,
    maximum: 5,
    example: 4,
  })
  @IsInt()
  @Min(1)
  @Max(5)
  year_level!: number;
}
