import { Transform } from 'class-transformer';
import { IsString, IsNotEmpty, IsOptional, MaxLength, IsIn } from 'class-validator';

export class AnswerQuestionDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  answer!: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  answered_by?: string;

  @IsIn(['approved'])
  @IsOptional()
  status?: 'approved';
}

export class UpdateQuestionStatusDto {
  @IsIn(['pending', 'approved', 'hidden'])
  status!: 'pending' | 'approved' | 'hidden';
}
