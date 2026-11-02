import {
  IsInt,
  IsString,
  IsArray,
  IsOptional,
  IsBoolean,
  IsIn,
  IsEmail,
  IsUrl,
  Min,
  Max,
  MaxLength,
  ValidateNested,
  ArrayMaxSize,
  Matches,
  IsPositive,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { STRICT_EMAIL_RE, isNonEmptyValue } from '../../common/security/public-limits';

class MediaItemDto {
  @IsUrl({ protocols: ['https'], require_protocol: true })
  url!: string;

  @IsIn(['image', 'video'])
  type!: 'image' | 'video';
}

export class CreateReviewDto {
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @IsString()
  @IsOptional()
  @MaxLength(2000)
  content?: string;

  @IsString()
  @MaxLength(100)
  author!: string;

  @IsEmail()
  @Matches(STRICT_EMAIL_RE, { message: 'Email is invalid' })
  @ValidateIf(isNonEmptyValue)
  @MaxLength(200)
  email?: string;

  @IsString()
  @IsOptional()
  @MaxLength(20)
  phone?: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  title?: string;

  @IsArray()
  @IsOptional()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => MediaItemDto)
  media?: MediaItemDto[];

  @IsIn(['approved', 'pending', 'hidden'])
  @IsOptional()
  status?: 'approved' | 'pending' | 'hidden';

  @IsBoolean()
  @IsOptional()
  verified?: boolean;

  @IsBoolean()
  @IsOptional()
  pinned?: boolean;

  @IsPositive()
  @IsOptional()
  created_at?: number;
}
