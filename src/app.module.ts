import { Module } from '@nestjs/common';
import { AiModule } from './ai/ai.module';
import { AppConfigModule } from './config/app-config.module';
import { CatalogModule } from './catalog/catalog.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { MediaModule } from './media/media.module';
import { OpsModule } from './ops/ops.module';
import { OutboundModule } from './outbound/outbound.module';
import { PurchaseModule } from './purchase/purchase.module';
import { QnaModule } from './qna/qna.module';
import { RedisModule } from './redis/redis.module';
import { ReviewModule } from './review/review.module';
import { StorefrontModule } from './storefront/storefront.module';
import { SecurityModule } from './common/security/security.module';
import { ShopAuthGuard } from './common/guards/shop-auth.guard';
import { SapoController } from './sapo/sapo.controller';
import { SapoModule } from './sapo/sapo.module';

@Module({
  imports: [
    AppConfigModule, RedisModule, DatabaseModule, SapoModule, SecurityModule,
    CatalogModule, PurchaseModule, ReviewModule, QnaModule,
    DashboardModule, OpsModule, MediaModule, StorefrontModule, OutboundModule, AiModule,
  ],
  controllers: [SapoController, HealthController],
  providers: [ShopAuthGuard],
})
export class AppModule {}
