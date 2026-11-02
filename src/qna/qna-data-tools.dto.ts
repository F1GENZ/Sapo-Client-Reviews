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

export const QNA_IMPORT_FORMATS = ['csv', 'json'] as const;
export const QNA_BULK_ACTIONS = ['approve', 'pending', 'hidden', 'delete'] as const;

export class QnaImportDto {
  @IsIn(QNA_IMPORT_FORMATS)
  format!: 'csv' | 'json';

  @IsString()
  @Length(2, 1_500_000)
  body!: string;

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

export class QnaBulkItemDto {
  @Matches(/^[1-9]\d{0,19}$/)
  productId!: string;

  @IsString()
  @Length(1, 64)
  questionId!: string;
}

export class QnaBulkDto {
  @IsIn(QNA_BULK_ACTIONS)
  action!: 'approve' | 'pending' | 'hidden' | 'delete';

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => QnaBulkItemDto)
  items!: QnaBulkItemDto[];
}
