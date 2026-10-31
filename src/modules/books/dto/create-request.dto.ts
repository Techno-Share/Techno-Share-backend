import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateRequestDto {
  @ApiProperty({
    description: 'Note to the donor, sent with the request.',
    example: 'Could I borrow this for the exam period?',
  })
  @IsString()
  @IsNotEmpty({ message: 'Message is required' })
  @MaxLength(500)
  message!: string;
}
