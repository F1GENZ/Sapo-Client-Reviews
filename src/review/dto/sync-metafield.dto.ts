import { IsOptional, IsString, Matches } from 'class-validator';

export class SyncMetafieldDto {
  @IsOptional()
  @IsString()
  @Matches(/^\d{1,20}$/, { message: 'productId must be a numeric id' })
  productId?: string;
}
