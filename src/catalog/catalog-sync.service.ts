import { Injectable, Logger } from '@nestjs/common';
import { SapoApiService } from '../sapo/sapo-api.service';
import type { SapoProduct } from '../sapo/sapo.types';
import { CatalogProductStoreService } from './catalog-product-store.service';
import { PrismaService } from '../database/prisma.service';

const MAX_PAGES = 50;
const PAGE_LIMIT = 250;

@Injectable()
export class CatalogSyncService {
  private readonly logger = new Logger(CatalogSyncService.name);

  constructor(
    private readonly sapoApi: SapoApiService,
    private readonly catalogStore: CatalogProductStoreService,
    private readonly prisma: PrismaService,
  ) {}

  private async resolveShopId(storeDomain: string): Promise<string> {
    const install = await this.prisma.appInstall.findUnique({
      where: { storeDomain },
      select: { shopId: true },
    });
    if (!install?.shopId) {
      this.logger.warn(`No install found for ${storeDomain} while syncing catalog`);
    }
    return install?.shopId || '';
  }

  async backfillStore(
    storeDomain: string,
    accessToken: string,
  ): Promise<{
    synced: number;
    pages: number;
    failedPages: number;
    totalFromCount: number | null;
    stopReason: 'completed' | 'max_pages' | 'empty_page' | 'failed_page';
  }> {
    let synced = 0;
    let pages = 0;
    let failedPages = 0;

    const shopId = await this.resolveShopId(storeDomain);
    if (!shopId) return { synced: 0, pages: 0, failedPages: 0, totalFromCount: null, stopReason: 'empty_page' };

    const totalCount = await this.sapoApi
      .getProductsCount(storeDomain, accessToken)
      .catch((error) => {
        this.logger.warn(
          `Could not fetch products count for ${storeDomain}: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`,
        );
        return null;
      });

    if (totalCount === 0) {
      return {
        synced: 0,
        pages: 0,
        failedPages: 0,
        totalFromCount: 0,
        stopReason: 'completed',
      };
    }

    let stopReason: 'completed' | 'max_pages' | 'empty_page' | 'failed_page' = 'max_pages';
    const seenProductIds = new Set<string>();

    for (let page = 1; page <= MAX_PAGES; page++) {
      let products: SapoProduct[];
      try {
        products = await this.sapoApi.getProducts(
          storeDomain,
          accessToken,
          { page, limit: PAGE_LIMIT },
        );
      } catch (error) {
        failedPages += 1;
        stopReason = 'failed_page';
        this.logger.warn(
          `Backfill page ${page} failed for ${storeDomain}: ${
            error instanceof Error ? error.message : 'Unknown error'
          } — stopping with partial result`,
        );
        break;
      }

      if (!products.length) {
        stopReason = 'empty_page';
        if (pages === 0 && totalCount !== null) {
          stopReason = 'completed';
        }
        break;
      }

      const normalized = products
        .map((product) =>
          this.catalogStore.normalizeSapoProduct(
            shopId,
            product as unknown as Record<string, unknown>,
            'sapo',
          ),
        )
        .filter(
          (item): item is NonNullable<typeof item> => !!item,
        );

      for (const item of normalized) {
        seenProductIds.add(String(item.productId));
      }

      await this.catalogStore.upsertProducts(normalized);
      synced += normalized.length;
      pages += 1;

      if (
        totalCount !== null &&
        seenProductIds.size >= totalCount
      ) {
        stopReason = 'completed';
        break;
      }

      if (products.length < PAGE_LIMIT) {
        stopReason = 'completed';
        break;
      }
    }

    // Only a fully enumerated catalog proves absence; a truncated or short-counted run must never delete.
    const enumeratedAll = totalCount === null || seenProductIds.size >= totalCount;
    if (seenProductIds.size > 0 && stopReason === 'completed' && enumeratedAll) {
      const staleDeleted =
        await this.catalogStore
          .markMissingSapoProductsDeleted(
            shopId,
            Array.from(seenProductIds),
          )
          .catch((error) => {
            this.logger.warn(
              `Stale product reconciliation failed for ${storeDomain}: ${
                error instanceof Error ? error.message : 'Unknown error'
              }`,
            );
            return 0;
          });
      if (staleDeleted > 0) {
        this.logger.log(
          `Marked ${staleDeleted} stale sapo products as deleted for ${storeDomain}`,
        );
      }
    }

    this.logger.log(
      `Backfill completed for ${storeDomain}: synced=${synced} pages=${pages} stopReason=${stopReason}`,
    );

    return {
      synced,
      pages,
      failedPages,
      totalFromCount: totalCount,
      stopReason,
    };
  }

  async handleProductWebhookWithToken(
    storeDomain: string,
    productId: string,
    action: string,
    accessToken: string,
  ): Promise<void> {
    if (action === 'delete' || action === 'products/delete') {
      const shopId = await this.resolveShopId(storeDomain);
      if (shopId) {
        await this.catalogStore.softDeleteProduct(shopId, productId);
        this.logger.log(
          `Soft-deleted catalog product ${productId} for ${storeDomain} via webhook`,
        );
      }
      return;
    }

    const shopId = await this.resolveShopId(storeDomain);
    if (!shopId) {
      this.logger.warn(`Catalog webhook skipped: no install for ${storeDomain}`);
      return;
    }

    try {
      const product = await this.sapoApi.getProduct(
        storeDomain,
        accessToken,
        productId,
      );
      const normalized = this.catalogStore.normalizeSapoProduct(
        shopId,
        product as unknown as Record<string, unknown>,
        'webhook',
      );
      if (normalized) {
        await this.catalogStore.upsertProduct(normalized);
        this.logger.log(
          `Upserted catalog product ${productId} for ${storeDomain} via webhook ${action}`,
        );
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('404')
      ) {
        await this.catalogStore.softDeleteProduct(shopId, productId);
        this.logger.log(
          `Product ${productId} not found (404) for ${storeDomain}, soft-deleted`,
        );
        return;
      }
      this.logger.warn(
        `Failed to handle product webhook for ${productId} at ${storeDomain}: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
      );
      throw error;
    }
  }
}
