import {
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { APP_ENV } from '../config/app-config.module';
import type { AppEnv } from '../config/env.schema';
import { SapoApiService } from '../sapo/sapo-api.service';
import { SapoService } from '../sapo/sapo.service';
import { ReviewService } from '../review/review.service';
import { WebhookRegistrationService } from '../sapo/webhook-registration.service';
import { CatalogSyncService } from '../catalog/catalog-sync.service';
import { CatalogProductStoreService } from '../catalog/catalog-product-store.service';
import { ReviewProductStoreService } from '../review/review-product-store.service';
import { QnaStoreService } from '../qna/qna-store.service';
import { PurchaseStoreService } from '../purchase/purchase-store.service';
import { PrismaService } from '../database/prisma.service';
import { MetafieldSyncPendingService } from '../database/metafield-sync-pending.service';
import { RedisService } from '../redis/redis.service';
import { StorefrontService } from '../storefront/storefront.service';
import { runSection } from '../health/degraded-section';
import { countRecentFailures, deriveHealthVerdict, FAILURE_WINDOW_MINUTES } from '../health/health-verdict';

const WEBHOOK_LATEST_LIMIT = 8;

const latestActivityAt = (
  webhooks: { latest?: Array<{ processedAt?: Date | null }> } | null,
  installUpdatedAt: Date,
): number => {
  const processed = webhooks?.latest?.find((row) => row.processedAt instanceof Date)?.processedAt;
  return (processed instanceof Date ? processed : installUpdatedAt).getTime();
};
const ORDERS_SYNC_MAX_PAGES = 5;
const ORDERS_SYNC_PAGE_SIZE = 50;
const ORDERS_SYNC_LOCK_TTL_SECONDS = 600;
const BACKFILL_LOCK_TTL_SECONDS = 900;
const BACKFILL_COOLDOWN_SECONDS = 300;

@Injectable()
export class OpsService {
  private readonly logger = new Logger(OpsService.name);

  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly sapo: SapoService,
    private readonly webhookRegistration: WebhookRegistrationService,
    private readonly catalogSync: CatalogSyncService,
    private readonly catalogStore: CatalogProductStoreService,
    private readonly reviewStore: ReviewProductStoreService,
    private readonly qnaStore: QnaStoreService,
    private readonly purchaseStore: PurchaseStoreService,
    private readonly prisma: PrismaService,
    private readonly storefront: StorefrontService,
    private readonly pendingMetafields: MetafieldSyncPendingService,
    private readonly redis: RedisService,
    private readonly sapoApi: SapoApiService,
    private readonly reviewService: ReviewService,
  ) {}

  async getHealth(storeDomain: string) {
    const install = await this.prisma.appInstall.findUnique({ where: { storeDomain } });
    if (!install) {
      throw new NotFoundException({ code: 'install_not_found', message: 'App not installed for this store' });
    }
    const shopId = install.shopId;
    const degradedSections: string[] = [];
    const run = <T>(name: string, load: () => Promise<T>): Promise<T | null> =>
      runSection(this.logger, name, degradedSections, load);

    const [reviewStats, qnaStats, catalogAudit, purchaseAudit, webhookStats, metafieldSync, dbOk] = await Promise.all([
      run('reviewStats', () => this.reviewStore.getStatsForShop(shopId)),
      run('qnaStats', () => this.qnaStore.getStats(shopId)),
      run('catalogAudit', () => this.catalogStore.getAudit(shopId)),
      run('purchaseAudit', () => this.purchaseStore.getAudit(shopId)),
      run('webhooks', () => this.getWebhookSummary(storeDomain)),
      run('metafieldSync', () => this.pendingMetafields.countsFor(storeDomain)),
      this.prisma.ping().catch((error: unknown) => {
        this.logger.warn(`Database ping failed: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }),
    ]);

    const recentFailures = dbOk
      ? (await run('recentFailures', () => countRecentFailures(this.prisma, { storeDomain }))) ?? 0
      : 0;
    const verdict = deriveHealthVerdict({
      healthy: dbOk,
      recentFailures,
      probeFailed: degradedSections.length > 0,
    });

    return {
      ok: verdict.ok,
      degraded: verdict.degraded,
      degradedSections,
      health: verdict.status,
      recentFailures,
      failureWindowMinutes: FAILURE_WINDOW_MINUTES,
      storeDomain,
      status: install.status,
      featuresUnlocked: install.featuresUnlocked,
      webhookStatus: install.webhookRegistrationStatus,
      counts: {
        products: catalogAudit?.active ?? 0,
        deletedProducts: catalogAudit?.deleted ?? 0,
        purchases: purchaseAudit?.total ?? 0,
        purchaseOrders: purchaseAudit?.orders ?? 0,
        reviews: reviewStats?.totalReviews ?? 0,
        questions: qnaStats?.total ?? 0,
        answered: qnaStats?.answered ?? 0,
      },
      catalog: catalogAudit,
      purchases: purchaseAudit,
      webhooks: webhookStats ?? { totals: [], latest: [] },
      metafieldSync,
      lastUpdated: latestActivityAt(webhookStats, install.updatedAt),
    };
  }

  private async getWebhookSummary(storeDomain: string) {
    const [groups, latest] = await Promise.all([
      this.prisma.webhookEvent.groupBy({
        by: ['status'],
        where: { resolvedStoreDomain: storeDomain },
        _count: { _all: true },
      }),
      this.prisma.webhookEvent.findMany({
        where: { resolvedStoreDomain: storeDomain },
        orderBy: { updatedAt: 'desc' },
        take: WEBHOOK_LATEST_LIMIT,
        select: { id: true, topic: true, status: true, attempts: true, lastError: true, processedAt: true },
      }),
    ]);
    return {
      totals: groups.map((group) => ({ status: group.status, count: group._count._all })),
      latest,
    };
  }

  async syncOrders(storeDomain: string, options: { pages?: number } = {}) {
    const pages = Math.max(1, Math.min(ORDERS_SYNC_MAX_PAGES, Math.trunc(options.pages ?? 1)));
    const lock = await this.redis.acquireLock(`lock:ops:orders-sync:${storeDomain}`, ORDERS_SYNC_LOCK_TTL_SECONDS);
    if (!lock) {
      throw new ConflictException({ code: 'orders_sync_in_progress', message: 'An order sync is already running for this store' });
    }
    try {
      const install = await this.prisma.appInstall.findUnique({
        where: { storeDomain },
        select: { shopId: true },
      });
      if (!install) throw new NotFoundException({ code: 'install_not_found', message: 'App not installed for this store' });
      const accessToken = await this.sapo.resolveAccessToken(storeDomain);
      let orders = 0;
      let purchases = 0;
      for (let page = 1; page <= pages; page += 1) {
        const rows = await this.sapoApi.getOrders(storeDomain, accessToken, {
          page,
          limit: ORDERS_SYNC_PAGE_SIZE,
        });
        if (rows.length === 0) break;
        for (const order of rows) {
          orders += 1;
          purchases += await this.purchaseStore.syncOrder({ shopId: install.shopId, order });
        }
        if (rows.length < ORDERS_SYNC_PAGE_SIZE) break;
      }
      return { ok: true, storeDomain, pages, orders, purchases };
    } finally {
      await this.redis.releaseLock(lock).catch(() => false);
    }
  }

  async syncAllMetafields(storeDomain: string) {
    const accessToken = await this.sapo.resolveAccessToken(storeDomain);
    const result = await this.reviewService.syncPublicSummaryMetafield(accessToken, storeDomain);
    return { ok: true, storeDomain, ...result };
  }

  async exportDiagnostics(storeDomain: string) {
    const health = await this.getHealth(storeDomain);
    const events = await this.prisma.webhookEvent.findMany({
      where: { resolvedStoreDomain: storeDomain },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      select: {
        id: true, topic: true, normalizedTopic: true, status: true, attempts: true,
        maxAttempts: true, lastError: true, receivedAt: true, processedAt: true, nextRetryAt: true,
      },
    });
    return {
      generatedAt: new Date().toISOString(),
      storeDomain,
      build: this.env.BUILD_SHA,
      health,
      webhookEvents: events,
    };
  }

  async resyncConfig(storeDomain: string) {
    const accessToken = await this.sapo.resolveAccessToken(storeDomain);
    const config = { apiUrl: this.env.API_BASE_URL.replace(/\/+$/, ''), storeDomain };
    let configError: string | null = null;
    try {
      await this.storefront.writeStorefrontConfig(storeDomain, accessToken);
    } catch (e) {
      configError = e instanceof Error ? e.message : 'failed';
      this.logger.warn(`Config metafield write failed for ${storeDomain}: ${configError}`);
    }
    return { ok: configError === null, storeDomain, config, ...(configError ? { configError } : {}) };
  }

  async resyncWebhooks(storeDomain: string) {
    const accessToken = await this.sapo.resolveAccessToken(storeDomain);
    const result = await this.webhookRegistration.registerForInstall(storeDomain, accessToken);
    return { ok: result.status === 'registered', storeDomain, ...result };
  }

  async backfillCatalog(storeDomain: string) {
    const lock = await this.redis.acquireLock(`lock:ops:backfill-catalog:${storeDomain}`, BACKFILL_LOCK_TTL_SECONDS);
    if (!lock) {
      throw new ConflictException({ code: 'backfill_in_progress', message: 'A catalog backfill is already running for this store' });
    }
    try {
      const accessToken = await this.sapo.resolveAccessToken(storeDomain);
      const cooldownKey = `ratelimit:ops:backfill-catalog:${storeDomain}`;
      if (!(await this.redis.setNx(cooldownKey, Date.now(), BACKFILL_COOLDOWN_SECONDS))) {
        const retryAfterSeconds = Math.max(1, await this.redis.ttl(cooldownKey));
        throw new HttpException(
          { code: 'backfill_rate_limited', message: `Catalog backfill is limited; retry in ${retryAfterSeconds}s`, retryAfterSeconds },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      const result = await this.catalogSync.backfillStore(storeDomain, accessToken);
      return {
        ok: result.stopReason !== 'failed_page' && result.stopReason !== 'max_pages',
        storeDomain,
        ...result,
      };
    } finally {
      await this.redis.releaseLock(lock).catch((error: unknown) => {
        this.logger.warn(`Backfill lock release failed for ${storeDomain}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }
}
