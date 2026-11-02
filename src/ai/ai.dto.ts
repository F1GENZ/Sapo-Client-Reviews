import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class ReplySuggestionDto {
  @IsString()
  @Length(1, 2000)
  content!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @IsOptional()
  @IsString()
  @Length(0, 100)
  author?: string;

  @IsOptional()
  @IsString()
  @Length(0, 120)
  storeName?: string;
}
