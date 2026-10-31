import { Global, Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { DatabaseModule } from '../database/database.module';
import { PurchaseModule } from '../purchase/purchase.module';
import { StorefrontModule } from '../storefront/storefront.module';
import { SapoApiModule } from './sapo-api.module';
import { SapoService } from './sapo.service';
import { HmacVerifierService } from './hmac-verifier.service';
import { LifecycleLockService } from './lifecycle-lock.service';
import { OAuthStateService } from './oauth-state.service';
import { SessionService } from './session.service';
import { ShopDomainService } from './shop-domain.service';
import { TokenEncryptionService } from './token-encryption.service';
import { UninstallService } from './uninstall.service';
import { WebhookRegistrationService } from './webhook-registration.service';
import { WebhookService } from './webhook.service';

@Global()
@Module({
  imports: [DatabaseModule, StorefrontModule, SapoApiModule, CatalogModule, PurchaseModule],
  providers: [
    SapoService,
    HmacVerifierService,
    LifecycleLockService,
    OAuthStateService,
    SessionService,
    ShopDomainService,
    TokenEncryptionService,
    UninstallService,
    WebhookRegistrationService,
    WebhookService,
  ],
  exports: [
    SapoService,
    HmacVerifierService,
    LifecycleLockService,
    OAuthStateService,
    SessionService,
    ShopDomainService,
    TokenEncryptionService,
    UninstallService,
    WebhookRegistrationService,
    WebhookService,
  ],
})
export class SapoModule {}
