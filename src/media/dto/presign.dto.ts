import { IsInt, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { Transform } from 'class-transformer';

export class PresignDto {
  @Transform(({ value }) => (typeof value === 'number' ? String(value) : value))
  @IsString()
  @Matches(/^\d{1,20}$/, { message: 'productId must be a numeric id' })
  productId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  filename?: string;

  @IsString()
  @MaxLength(100)
  contentType!: string;

  @IsInt()
  @Min(1)
  fileSize!: number;
}
