import {
  IsInt,
  IsArray,
  IsString,
  IsOptional,
  Min,
  Max,
  ArrayMaxSize,
  MaxLength,
} from 'class-validator';

export class UpdateSpamConfigDto {
  @IsArray()
  @IsOptional()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  blockedWords?: string[];

  @IsInt()
  @IsOptional()
  @Min(1)
  @Max(5000)
  maxContentLength?: number;
}
