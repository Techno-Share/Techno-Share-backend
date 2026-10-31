import { IsISO8601, IsOptional, ValidateIf } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * When the next promotion rollover happens.
 *
 * `null` is a meaningful value — it clears the schedule — so the field is
 * validated as an ISO instant only when it is not null, rather than simply
 * being optional.
 */
export class SetPromotionDto {
  @ApiPropertyOptional({
    description:
      'When every student moves up a year, ISO 8601. Send null to cancel. A date in the past takes effect immediately; students collect it on their next request, not at the instant itself.',
    nullable: true,
    example: '2027-07-01T00:00:00.000Z',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsISO8601()
  rollover_at?: string | null;
}
