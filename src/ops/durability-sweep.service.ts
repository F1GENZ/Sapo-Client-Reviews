import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { APP_ENV } from '../config/app-config.module';
import type { AppEnv } from '../config/env.schema';
import { PrismaService } from '../database/prisma.service';
import { MediaService, type StoredMediaObject } from '../media/media.service';
import { OutboundDispatcherService } from '../outbound/outbound-dispatcher.service';
import { RedisService, type RedisLock } from '../redis/redis.service';
import { ReviewService } from '../review/review.service';
import { SapoService } from '../sapo/sapo.service';
import { WebhookService } from '../sapo/webhook.service';

const SWEEP_INTERVAL_MS = 60_000;
const SWEEP_LOCK_KEY = 'lock:durability-sweep';
const SWEEP_LOCK_TTL_SECONDS = 120;

const DAY_MS = 24 * 60 * 60_000;
const RETENTION_INTERVAL_MS = 60 * 60_000;
const EVENT_DONE_TTL_MS = 30 * DAY_MS;
const EVENT_FAILED_TTL_MS = 90 * DAY_MS;
const UNINSTALL_RETENTION_MS = 90 * DAY_MS;
const PURGE_BATCH = 500;
const PURGE_MAX_BATCHES = 20;
const UNINSTALL_PURGE_PAGE = 20;

const ORPHAN_PAGE_SIZE = 200;
const ORPHAN_STEP_INTERVAL_MS = 5 * 60_000;
const ORPHAN_CURSOR_KEY = 'media-orphan-sweep:cursor';
const ORPHAN_CURSOR_TTL_SECONDS = 7 * 24 * 60 * 60;
const ORPHAN_REST_KEY = 'media-orphan-sweep:rest';
const ORPHAN_REST_SECONDS = 6 * 60 * 60;

export type SweepReport = {
  skipped?: 'already_running' | 'lock_held';
  webhookReclaim?: { reclaimed: number; failed: number };
  webhookRetry?: { attempted: number; succeeded: number; failed: number };
  metafields?: { processed: number; synced: number; failed: number; deferred: number };
  webhookRetention?: { deleted: number };
  outboundDispatch?: { attempted: number; delivered: number; failed: number };
  outboundReclaim?: { reclaimed: number };
  uninstallRetention?: { shops: number; purchases: number; events: number };
  mediaOrphans?: { scanned: number; deleted: number; kept: number };
  errors: string[];
};

type SweepStep =
  | 'outboundReclaim'
  | 'outboundDispatch'
  | 'webhookReclaim'
  | 'webhookRetry'
  | 'metafields'
  | 'webhookRetention'
  | 'uninstallRetention'
  | 'mediaOrphans';

@Injectable()
export class DurabilitySweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DurabilitySweepService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastRetentionAt = 0;
  private lastOrphanAt = 0;
  private orphanSkipLogged = false;

  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly redis: RedisService,
    private readonly reviews: ReviewService,
    private readonly webhooks: WebhookService,
    private readonly sapo: SapoService,
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly outbound: OutboundDispatcherService,
  ) {}

  onModuleInit(): void {
    if (this.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.runOnce(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer ?? undefined);
    this.timer = null;
  }

  async runOnce(): Promise<SweepReport> {
    const report: SweepReport = { errors: [] };
    if (this.running) return { ...report, skipped: 'already_running' };
    this.running = true;
    let lock: RedisLock | null = null;
    try {
      lock = await this.redis.acquireLock(SWEEP_LOCK_KEY, SWEEP_LOCK_TTL_SECONDS).catch(() => null);
      if (!lock && this.redis.isConfigured) return { ...report, skipped: 'lock_held' };

      await this.step(report, 'outboundReclaim', async () => ({ reclaimed: await this.outbound.reclaimStuck() }));
      await this.step(report, 'outboundDispatch', () => this.outbound.dispatchDue());
      await this.step(report, 'webhookReclaim', () => this.webhooks.reclaimStalled());
      await this.step(report, 'webhookRetry', () => this.webhooks.retryDueFailed());
      await this.step(report, 'metafields', () =>
        this.reviews.reconcilePendingSummaries((storeDomain) => this.sapo.resolveAccessToken(storeDomain)),
      );

      const now = new Date();
      if (now.getTime() - this.lastRetentionAt >= RETENTION_INTERVAL_MS) {
        await this.step(report, 'webhookRetention', () => this.purgeExpiredEvents(now));
        await this.step(report, 'uninstallRetention', () => this.purgeUninstalledShops(now));
        this.lastRetentionAt = now.getTime();
      }

      if (now.getTime() - this.lastOrphanAt >= ORPHAN_STEP_INTERVAL_MS) {
        if (this.media.storageConfigured) {
          await this.step(report, 'mediaOrphans', () => this.sweepMediaOrphans(now));
        } else if (!this.orphanSkipLogged) {
          this.logger.log('Media orphan sweep skipped: R2 is not configured');
          this.orphanSkipLogged = true;
        }
        this.lastOrphanAt = now.getTime();
      }
      return report;
    } finally {
      if (lock) await this.redis.releaseLock(lock).catch(() => false);
      this.running = false;
    }
  }

  private async sweepMediaOrphans(now: Date): Promise<{ scanned: number; deleted: number; kept: number }> {
    if (await this.redis.get(ORPHAN_REST_KEY)) return { scanned: 0, deleted: 0, kept: 0 };
    const saved = await this.redis.get<{ cursor?: string }>(ORPHAN_CURSOR_KEY);
    const page = await this.media.listOwnedObjects(saved?.cursor || null, ORPHAN_PAGE_SIZE);

    const cutoff = now.getTime() - DAY_MS;
    const aged = page.objects.filter((object) => object.uploadedAt < cutoff);
    const orphans = aged.length ? await this.findUnreferencedMedia(aged) : [];
    const deleted = orphans.length ? await this.media.deleteOwnedObjects(orphans.map((object) => object.url)) : 0;

    if (page.cursor) {
      await this.redis.set(ORPHAN_CURSOR_KEY, { cursor: page.cursor }, ORPHAN_CURSOR_TTL_SECONDS);
    } else {
      await this.redis.del(ORPHAN_CURSOR_KEY);
      await this.redis.set(ORPHAN_REST_KEY, '1', ORPHAN_REST_SECONDS);
    }
    return { scanned: page.objects.length, deleted, kept: page.objects.length - deleted };
  }

  // Safety: objects whose store has no install row are kept, because the owning shop cannot be resolved to prove they are unreferenced.
  private async findUnreferencedMedia(objects: StoredMediaObject[]): Promise<StoredMediaObject[]> {
    const storeDomains = [...new Set(objects.map((object) => object.key.split('/')[1]))];
    const installs = await this.prisma.appInstall.findMany({
      where: { storeDomain: { in: storeDomains } },
      select: { shopId: true, storeDomain: true },
    });
    const shopByStore = new Map(installs.map((install) => [install.storeDomain, install.shopId]));

    const candidates: StoredMediaObject[] = [];
    const shopIds = new Set<string>();
    for (const object of objects) {
      const shopId = shopByStore.get(object.key.split('/')[1]);
      if (!shopId) continue;
      candidates.push(object);
      shopIds.add(shopId);
    }
    if (candidates.length === 0) return [];

    const rows = await this.prisma.reviewProduct.findMany({
      where: { shopId: { in: [...shopIds] }, media: { not: Prisma.DbNull } },
      select: { media: true },
    });

    const referenced = new Set<string>();
    for (const row of rows) {
      if (!Array.isArray(row.media)) continue;
      for (const item of row.media) {
        if (item === null || typeof item !== 'object' || Array.isArray(item) || typeof item.url !== 'string') continue;
        try {
          referenced.add(new URL(item.url).pathname.slice(1));
        } catch {
          continue;
        }
      }
    }
    return candidates.filter((object) => !referenced.has(object.key));
  }

  private async purgeExpiredEvents(now: Date): Promise<{ deleted: number }> {
    const filters: Prisma.WebhookEventWhereInput[] = [
      { status: { in: ['processed', 'ignored'] }, updatedAt: { lt: new Date(now.getTime() - EVENT_DONE_TTL_MS) } },
      { status: 'failed', nextRetryAt: null, updatedAt: { lt: new Date(now.getTime() - EVENT_FAILED_TTL_MS) } },
    ];
    let deleted = 0;
    for (const filter of filters) {
      for (let batch = 0; batch < PURGE_MAX_BATCHES; batch += 1) {
        const rows = await this.prisma.webhookEvent.findMany({ where: filter, select: { id: true }, take: PURGE_BATCH });
        if (rows.length === 0) break;
        const result = await this.prisma.webhookEvent.deleteMany({
          where: { AND: [filter, { id: { in: rows.map((row) => row.id) } }] },
        });
        deleted += result.count;
        if (rows.length < PURGE_BATCH) break;
      }
    }
    return { deleted };
  }

  // Safety: only installs that stayed uninstalled past the window are purged, and the predicate is re-checked inside the transaction so a reinstall wins.
  private async purgeUninstalledShops(now: Date): Promise<{ shops: number; purchases: number; events: number }> {
    const cutoff = new Date(now.getTime() - UNINSTALL_RETENTION_MS);
    const eligible: Prisma.AppInstallWhereInput = { status: 'uninstalled', uninstalledAt: { lt: cutoff } };
    const totals = { shops: 0, purchases: 0, events: 0 };
    let cursor = '';
    for (;;) {
      const installs = await this.prisma.appInstall.findMany({
        where: { ...eligible, ...(cursor ? { id: { gt: cursor } } : {}) },
        select: { id: true, shopId: true, storeDomain: true },
        orderBy: { id: 'asc' },
        take: UNINSTALL_PURGE_PAGE,
      });
      if (installs.length === 0) break;
      cursor = installs[installs.length - 1].id;
      for (const install of installs) {
        try {
          const purged = await this.prisma.$transaction(async (tx) => {
            const stillEligible = await tx.appInstall.findFirst({
              where: { ...eligible, id: install.id },
              select: { id: true },
            });
            if (!stillEligible) return null;
            const purchases = await tx.customerPurchase.deleteMany({ where: { shopId: install.shopId } });
            const events = await tx.webhookEvent.deleteMany({
              where: { OR: [{ shopId: install.shopId }, { resolvedStoreDomain: install.storeDomain }] },
            });
            return { purchases: purchases.count, events: events.count };
          });
          if (purged) {
            totals.shops += 1;
            totals.purchases += purged.purchases;
            totals.events += purged.events;
          }
        } catch (error) {
          this.logger.warn(`Uninstall retention purge failed for ${install.storeDomain}: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
      }
      if (installs.length < UNINSTALL_PURGE_PAGE) break;
    }
    return totals;
  }

  private async step<K extends SweepStep>(
    report: SweepReport,
    name: K,
    run: () => Promise<NonNullable<SweepReport[K]>>,
  ): Promise<void> {
    try {
      report[name] = await run();
    } catch (error) {
      const message = `${name}: ${error instanceof Error ? error.message : 'unknown error'}`;
      report.errors.push(message);
      this.logger.warn(`Durability sweep step failed: ${message}`);
    }
  }
}
