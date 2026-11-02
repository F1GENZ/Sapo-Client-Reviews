import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  ValidateNested,
} from 'class-validator';

export const IMPORT_FORMATS = ['csv', 'json'] as const;
export const BULK_ACTIONS = ['approve', 'pending', 'hidden', 'spam', 'delete'] as const;

export class ReviewImportDto {
  @IsIn(IMPORT_FORMATS)
  format!: 'csv' | 'json';

  @IsString()
  @Length(2, 1_500_000)
  body!: string;

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

export class ReviewBulkItemDto {
  @Matches(/^[1-9]\d{0,19}$/)
  productId!: string;

  @IsString()
  @Length(1, 64)
  reviewId!: string;
}

export class ReviewBulkDto {
  @IsIn(BULK_ACTIONS)
  action!: 'approve' | 'pending' | 'hidden' | 'spam' | 'delete';

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ReviewBulkItemDto)
  items!: ReviewBulkItemDto[];
}
