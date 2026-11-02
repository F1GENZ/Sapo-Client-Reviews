import {
  IsString,
  IsOptional,
  MaxLength,
  IsEmail,
  Matches,
  ValidateIf,
} from 'class-validator';
import { STRICT_EMAIL_RE, isNonEmptyValue } from '../../common/security/public-limits';

export class CreateQuestionDto {
  @IsString()
  @MaxLength(1000)
  question!: string;

  @IsString()
  @MaxLength(100)
  author!: string;

  @IsEmail()
  @Matches(STRICT_EMAIL_RE, { message: 'Email is invalid' })
  @ValidateIf(isNonEmptyValue)
  email?: string;

  @IsString()
  @IsOptional()
  @MaxLength(20)
  phone?: string;
}
