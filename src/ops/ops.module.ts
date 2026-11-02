import { Module } from '@nestjs/common';
import { OpsController } from './ops.controller';
import { OpsService } from './ops.service';
import { DurabilitySweepService } from './durability-sweep.service';
import { DatabaseModule } from '../database/database.module';
import { CatalogModule } from '../catalog/catalog.module';
import { ReviewModule } from '../review/review.module';
import { QnaModule } from '../qna/qna.module';
import { OutboundModule } from '../outbound/outbound.module';
import { PurchaseModule } from '../purchase/purchase.module';
import { StorefrontModule } from '../storefront/storefront.module';
import { SapoApiModule } from '../sapo/sapo-api.module';

@Module({
  imports: [DatabaseModule, CatalogModule, ReviewModule, QnaModule, PurchaseModule, StorefrontModule, SapoApiModule, OutboundModule],
  controllers: [OpsController],
  providers: [OpsService, DurabilitySweepService],
})
export class OpsModule {}
