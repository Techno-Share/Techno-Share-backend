import { IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Take a listing out of circulation, or put it back.
 *
 * Not a status change: `status` describes the donation (available vs donated)
 * and is the donor's business. Hiding is moderation, and the two are
 * independent — a book can be available and hidden at once.
 */
export class SetBookHiddenDto {
  @ApiProperty({
    description:
      'True hides the listing from the browse feed; the donor still sees it.',
    example: true,
  })
  @IsBoolean()
  hidden!: boolean;
}
