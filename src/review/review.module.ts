import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { DatabaseModule } from '../database/database.module';
import { PurchaseModule } from '../purchase/purchase.module';
import { RedisModule } from '../redis/redis.module';
import { SapoApiModule } from '../sapo/sapo-api.module';
import { ReviewController } from './review.controller';
import { PublicReviewController } from './public-review.controller';
import { MediaService } from '../media/media.service';
import { ReviewProductStoreService } from './review-product-store.service';
import { ReviewService } from './review.service';

@Module({
  imports: [
    DatabaseModule,
    RedisModule,
    SapoApiModule,
    CatalogModule,
    PurchaseModule,
  ],
  controllers: [ReviewController, PublicReviewController],
  providers: [ReviewProductStoreService, ReviewService, MediaService],
  exports: [ReviewProductStoreService, ReviewService, MediaService],
})
export class ReviewModule {}
