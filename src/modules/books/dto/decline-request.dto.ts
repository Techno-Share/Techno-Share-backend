import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class DeclineRequestDto {
  /**
   * Required: a decline is the end of the road for that student's request, and
   * the reason is all they get back. Silent refusals are what this prevents.
   *
   * The pattern is what actually enforces it — IsNotEmpty passes a string of
   * spaces, which would store as an empty reason once trimmed.
   */
  @ApiProperty({
    description: 'Shown to the requester so a refusal is not silent.',
    example: 'Already promised to another student',
  })
  @IsString()
  @IsNotEmpty({ message: 'Tell the requester why you are declining' })
  @Matches(/\S/, { message: 'Tell the requester why you are declining' })
  @MaxLength(300)
  reason: string;
}
