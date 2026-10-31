import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { mergeInstallMetadataKey } from '../database/install-metadata';
import {
  MetafieldSyncPendingService,
  type PendingMetafieldSync,
} from '../database/metafield-sync-pending.service';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../redis/redis.service';
import type { RedisLock } from '../redis/redis.service';
import { SapoApiService } from '../sapo/sapo-api.service';
import { isSapoAuthRevoked, markInstallNeedsReinstall, sapoErrorStatus } from '../sapo/install-revocation';
import { catalogTitles } from '../catalog/product-label';
import { NUMERIC_ID_RE, PUBLIC_MAX_OFFSET } from '../common/security/public-limits';
import { MediaService } from '../media/media.service';
import { ReviewProductStoreService } from './review-product-store.service';
import { CatalogProductStoreService } from '../catalog/catalog-product-store.service';
import { PurchaseStoreService } from '../purchase/purchase-store.service';
import type { Review, RatingSummary, MediaItem } from './interfaces/review.interface';
import type { SpamConfig } from './interfaces/spam-config.interface';
import { DEFAULT_SPAM_CONFIG } from './interfaces/spam-config.interface';
import type { WidgetConfig } from './interfaces/widget-config.interface';
import { DEFAULT_WIDGET_CONFIG } from './interfaces/widget-config.interface';
import type { CreateReviewDto } from './dto/create-review.dto';
import type { UpdateReviewDto } from './dto/update-review.dto';
import type { UpdateWidgetConfigDto } from './dto/update-widget-config.dto';
import type { UpdateSpamConfigDto } from './dto/update-spam-config.dto';
import { applyFormModes, type PublicIdentity, type PublicReviewInput } from './public-review-input';
import { UNREPLIED_WHERE } from './review-where';

const LOCK_TTL = 30;
const LOCK_MAX_RETRIES = 4;
const LOCK_BASE_DELAY = 500;
const METAFIELD_NAMESPACE = 'f1genz_reviews';
const WIDGET_CONFIG_METADATA_KEY = 'reviewWidgetConfig';
const SPAM_CONFIG_METADATA_KEY = 'reviewSpamConfig';
const PRODUCT_LOAD_CHUNK = 200;
const PRODUCT_LOAD_MAX_ROWS = 10_000;
const PUBLIC_SUMMARY_MAX_IDS = 100;
const RECONCILE_PAGE = 25;
const RECONCILE_MAX_ROWS = 100;
const INLINE_SYNC_ROWS = 25;
const NEEDS_REINSTALL_RETRY_MS = 30 * 60_000;
const NON_SERVING_STATUSES = new Set(['uninstalled', 'declined']);

export type AllReviewsSort = 'newest' | 'oldest';
export type AllReviewsStatus =
  | 'all'
  | 'approved'
  | 'pending'
  | 'hidden'
  | 'spam'
  | 'unreplied';

export type ReviewListItem = Review & {
  productId: string;
  productTitle?: string;
  productName?: string;
  productHandle?: string;
  productImage?: string;
};

export type AllReviewsPage = {
  items: ReviewListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  statusCounts: Record<AllReviewsStatus, number>;
};

export type ListAllReviewsOptions = {
  page?: number;
  limit?: number;
  status?: string;
  sort?: string;
  productId?: string;
  search?: string;
  star?: number;
};

export type PublicReviewsOptions = {
  page?: number;
  limit?: number;
  sort?: string;
};

export type ProductStats = {
  total: number;
  avgRating: number;
  approved: number;
  pending: number;
  hidden: number;
  spam: number;
  summary: RatingSummary;
};

export type PublicReviewSubmission = Pick<
  Review,
  'id' | 'rating' | 'content' | 'author' | 'title' | 'media' | 'status' | 'created_at' | 'updated_at'
>;

export type PublicIdentityHook = (identity: PublicIdentity) => Promise<void>;

export type PublicSubmitHooks = {
  chargeIdentity: PublicIdentityHook;
  resolveToken: () => Promise<string>;
};

export type PurchaseEligibility = { eligible: boolean; reason: string };

const generateId = (): string => randomUUID();

const EMPTY_STATUS_COUNTS = (): Record<AllReviewsStatus, number> => ({
  all: 0,
  approved: 0,
  pending: 0,
  hidden: 0,
  spam: 0,
  unreplied: 0,
});

const EMPTY_SUMMARY = (): RatingSummary => ({
  avg: 0,
  count: 0,
  distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
});

const stripUndefined = (value: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));

const LEGACY_WIDGET_KEYS: readonly string[] = ['emailDisplay', 'phoneDisplay'];

const toWidgetConfig = (saved: unknown): WidgetConfig => {
  const entries = saved && typeof saved === 'object' ? Object.entries(saved) : [];
  return {
    ...DEFAULT_WIDGET_CONFIG,
    ...(Object.fromEntries(entries.filter(([key]) => !LEGACY_WIDGET_KEYS.includes(key))) as Partial<WidgetConfig>),
  };
};

export type SummaryMetafield = {
  key: string;
  value: string | number;
  value_type: 'string' | 'integer';
};

export const buildSummaryMetafields = (summary: RatingSummary): SummaryMetafield[] => [
  { key: 'rating_count', value: summary.count, value_type: 'integer' },
  { key: 'rating_avg', value: summary.count > 0 ? summary.avg.toFixed(1) : '0', value_type: 'string' },
  {
    key: 'public_summary',
    value: JSON.stringify({ avg: summary.avg, count: summary.count, distribution: summary.distribution }),
    value_type: 'string',
  },
];

const toMedia = (value: unknown): MediaItem[] => {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is { url: unknown; type: unknown } =>
        item !== null && typeof item === 'object',
    )
    .map((item) => ({
      url: typeof item.url === 'string' ? item.url : '',
      type: item.type === 'video' ? ('video' as const) : ('image' as const),
    }))
    .filter((item) => item.url && /^https:\/\//i.test(item.url));
};

const toMediaInput = (
  media: ReadonlyArray<MediaItem> | undefined,
): Prisma.InputJsonValue | null | undefined => {
  if (media === undefined) return undefined;
  return media.length ? media.map(({ url, type }) => ({ url, type })) : null;
};

const toNum = (value: unknown): number => {
  if (typeof value === 'bigint') return Number(value);
  if (value && typeof value === 'object' && typeof (value as { toNumber?: () => number }).toNumber === 'function') {
    return (value as { toNumber: () => number }).toNumber();
  }
  return Number(value) || 0;
};

type ReviewRow = {
  reviewId: string;
  rating: number;
  content: string;
  author: string;
  email: string | null;
  phone: string | null;
  title: string | null;
  media: unknown;
  status: string;
  verified: boolean;
  pinned: boolean;
  reply: string | null;
  repliedAt: bigint | null;
  sourceRawJson: string | null;
  productId?: string;
  productTitle?: string | null;
  productName?: string | null;
  productHandle?: string | null;
  productImage?: string | null;
  createdAt?: bigint | unknown;
  updatedAt?: bigint | unknown;
};

const toDomainReview = (row: ReviewRow): Review => ({
  id: row.reviewId,
  rating: row.rating,
  content: row.content,
  author: row.author,
  email: row.email || undefined,
  phone: row.phone || undefined,
  title: row.title || undefined,
  media: toMedia(row.media),
  status: row.status as Review['status'],
  verified: row.verified,
  pinned: row.pinned,
  reply: row.reply || undefined,
  replied_at: row.repliedAt ? Number(row.repliedAt) : undefined,
  source_raw_json: row.sourceRawJson || undefined,
  created_at: toNum(row.createdAt),
  updated_at: toNum(row.updatedAt),
});

export const toPublicReview = (row: ReviewRow): Review => {
  const review = toDomainReview(row);
  delete review.email;
  delete review.phone;
  delete review.source_raw_json;
  return review;
};

const toPublicSubmission = (review: Review): PublicReviewSubmission => ({
  id: review.id,
  rating: review.rating,
  content: review.content,
  author: review.author,
  title: review.title,
  media: review.media,
  status: review.status,
  created_at: review.created_at,
  updated_at: review.updated_at,
});

const toReviewListItem = (
  row: ReviewRow & { productId: string },
  catalogTitle: string | undefined,
): ReviewListItem => {
  const title = catalogTitle || row.productTitle || row.productName || undefined;
  return {
    ...toDomainReview(row),
    productId: row.productId,
    productTitle: title,
    productName: catalogTitle || row.productName || row.productTitle || undefined,
    productHandle: row.productHandle || undefined,
    productImage: row.productImage || undefined,
  };
};

const isAllReviewsStatus = (value: unknown): value is AllReviewsStatus =>
  ['all', 'approved', 'pending', 'hidden', 'spam', 'unreplied'].includes(String(value));

const isStoredStatus = (value: string): value is Exclude<AllReviewsStatus, 'all' | 'unreplied'> =>
  ['approved', 'pending', 'hidden', 'spam'].includes(value);

export function detectSpam(
  content: string,
  author: string,
  cfg: SpamConfig,
  existingReviews: Array<{ author: string; content: string }>,
  autoApproveClean = false,
): Review['status'] {
  const lower = content.toLowerCase();

  if (cfg.blockedWords.length > 0) {
    const found = cfg.blockedWords.some((word) =>
      lower.includes(word.toLowerCase()),
    );
    if (found) return 'spam';
  }

  if (content.length > cfg.maxContentLength) return 'spam';

  const isDuplicate = existingReviews.some(
    (r) =>
      r.author.toLowerCase() === author.toLowerCase() &&
      r.content.toLowerCase() === lower,
  );
  if (isDuplicate) return 'spam';

  return autoApproveClean ? 'approved' : 'pending';
}

@Injectable()
export class ReviewService {
  private readonly logger = new Logger(ReviewService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly sapoApi: SapoApiService,
    private readonly reviewStore: ReviewProductStoreService,
    private readonly catalogStore: CatalogProductStoreService,
    private readonly purchaseStore: PurchaseStoreService,
    private readonly pending: MetafieldSyncPendingService,
    private readonly media: MediaService,
  ) {}

  private lockKey(shopId: string, productId: string): string {
    return `lock:review:${shopId}:${productId}`;
  }

  private async acquireLock(shopId: string, productId: string): Promise<RedisLock | null> {
    const key = this.lockKey(shopId, productId);
    for (let attempt = 1; attempt <= LOCK_MAX_RETRIES; attempt++) {
      try {
        const lock = await this.redis.acquireLock(key, LOCK_TTL);
        if (lock) return lock;
      } catch (err) {
        this.logger.warn(
          `Review write lock unavailable, continuing unlocked: ${err instanceof Error ? err.message : 'unknown error'}`,
        );
        return null;
      }
      await new Promise((r) => setTimeout(r, LOCK_BASE_DELAY * 2 ** attempt));
    }
    throw new ConflictException('Could not acquire review write lock');
  }

  private async releaseLock(lock: RedisLock | null): Promise<void> {
    if (!lock) return;
    await this.redis.releaseLock(lock).catch(() => false);
  }

  private async resolveInstall(storeDomain: string): Promise<{ shopId: string; metadata: unknown }> {
    const install = await this.prisma.appInstall.findUnique({
      where: { storeDomain },
      select: { shopId: true, metadata: true },
    });
    if (!install) {
      throw new ConflictException('App not installed for this store');
    }
    return install;
  }

  private async resolveServingInstall(
    storeDomain: string,
  ): Promise<{ shopId: string; metadata: unknown } | null> {
    const install = await this.prisma.appInstall.findUnique({
      where: { storeDomain },
      select: { shopId: true, metadata: true, status: true },
    });
    if (!install || NON_SERVING_STATUSES.has(String(install.status))) return null;
    return { shopId: install.shopId, metadata: install.metadata };
  }

  private async requireServingInstall(
    storeDomain: string,
  ): Promise<{ shopId: string; metadata: unknown }> {
    const install = await this.resolveServingInstall(storeDomain);
    if (!install) {
      throw new ConflictException({ code: 'store_not_serving', message: 'Store is not serving' });
    }
    return install;
  }

  private async pushSummary(
    storeDomain: string,
    token: string,
    shopId: string,
    productId: string,
  ): Promise<void> {
    const summary = await this.reviewStore.calculatePublicSummary(shopId, productId);
    const existing = await this.sapoApi.getProductMetafields(
      storeDomain,
      token,
      productId,
      METAFIELD_NAMESPACE,
    );
    for (const wanted of buildSummaryMetafields(summary)) {
      const current = existing.find(
        (m) => m.namespace === METAFIELD_NAMESPACE && m.key === wanted.key,
      );
      if (current?.id) {
        if (String(current.value) === String(wanted.value)) continue;
        await this.sapoApi.updateProductMetafield(storeDomain, token, productId, String(current.id), {
          value: wanted.value,
          value_type: wanted.value_type,
        });
      } else {
        await this.sapoApi.createProductMetafield(storeDomain, token, productId, {
          namespace: METAFIELD_NAMESPACE,
          ...wanted,
        });
      }
    }
  }

  private async runSync(ctx: {
    storeDomain: string;
    token: string;
    shopId: string;
    tokenVersion: number;
    productId: string;
    stamp: Date | null;
  }): Promise<boolean> {
    const { storeDomain, productId } = ctx;
    try {
      await this.pushSummary(storeDomain, ctx.token, ctx.shopId, productId);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.warn(`Metafield sync failed for product ${productId} at ${storeDomain}: ${message}`);
      try {
        if (isSapoAuthRevoked(err)) {
          await markInstallNeedsReinstall(this.prisma, storeDomain, ctx.tokenVersion);
          await this.pending.recordFailure(storeDomain, productId, message, {
            retryInMs: NEEDS_REINSTALL_RETRY_MS,
          });
        } else if (sapoErrorStatus(err) === 404) {
          await this.pending.drop(storeDomain, productId);
        } else {
          await this.pending.recordFailure(storeDomain, productId, message);
        }
      } catch (bookkeepingError) {
        this.logger.warn(
          `Could not record metafield sync failure: ${bookkeepingError instanceof Error ? bookkeepingError.message : 'unknown error'}`,
        );
      }
      return false;
    }
    if (ctx.stamp) {
      await this.pending.clear(storeDomain, productId, ctx.stamp).catch(() => false);
    }
    return true;
  }

  private async syncPublicSummary(
    storeDomain: string,
    token: string,
    productId: string,
  ): Promise<boolean> {
    const install = await this.prisma.appInstall
      .findUnique({ where: { storeDomain }, select: { shopId: true, tokenVersion: true } })
      .catch((err: unknown) => {
        this.logger.warn(`Install lookup failed during metafield sync: ${err instanceof Error ? err.message : 'unknown error'}`);
        return null;
      });
    if (!install) return false;
    const stamp = await this.pending.markDirty(storeDomain, productId).catch((err: unknown) => {
      this.logger.warn(`Could not persist metafield sync intent: ${err instanceof Error ? err.message : 'unknown error'}`);
      return null;
    });
    return this.runSync({
      storeDomain,
      token,
      shopId: install.shopId,
      tokenVersion: install.tokenVersion,
      productId,
      stamp,
    });
  }

  async reconcilePendingSummaries(
    resolveToken: (storeDomain: string) => Promise<string>,
    options: { maxRows?: number } = {},
  ): Promise<{ processed: number; synced: number; failed: number; deferred: number }> {
    const maxRows = options.maxRows ?? RECONCILE_MAX_ROWS;
    const totals = { processed: 0, synced: 0, failed: 0, deferred: 0 };
    const blockedStores = new Set<string>();
    let cursor = '';
    while (totals.processed < maxRows) {
      const rows: PendingMetafieldSync[] = await this.pending.listDue(cursor, RECONCILE_PAGE);
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1].id;
      for (const row of rows) {
        if (totals.processed >= maxRows) break;
        totals.processed += 1;
        try {
          if (blockedStores.has(row.storeDomain)) {
            totals.deferred += 1;
            continue;
          }
          const outcome = await this.reconcileRow(row, resolveToken);
          if (outcome === 'synced') totals.synced += 1;
          else if (outcome === 'failed') totals.failed += 1;
          else {
            totals.deferred += 1;
            blockedStores.add(row.storeDomain);
          }
        } catch (err) {
          totals.failed += 1;
          this.logger.warn(
            `Pending metafield row ${row.id} failed: ${err instanceof Error ? err.message : 'unknown error'}`,
          );
        }
      }
      if (rows.length < RECONCILE_PAGE) break;
    }
    return totals;
  }

  private async reconcileRow(
    row: PendingMetafieldSync,
    resolveToken: (storeDomain: string) => Promise<string>,
  ): Promise<'synced' | 'failed' | 'deferred'> {
    const install = await this.prisma.appInstall.findUnique({
      where: { storeDomain: row.storeDomain },
      select: { shopId: true, tokenVersion: true, status: true },
    });
    if (!install || NON_SERVING_STATUSES.has(String(install.status))) {
      await this.pending.drop(row.storeDomain, row.productId);
      return 'deferred';
    }
    let token: string;
    try {
      token = await resolveToken(row.storeDomain);
    } catch (err) {
      await this.pending.recordFailure(
        row.storeDomain,
        row.productId,
        err instanceof Error ? err.message : 'token unavailable',
        { retryInMs: NEEDS_REINSTALL_RETRY_MS },
      );
      return 'deferred';
    }
    const ok = await this.runSync({
      storeDomain: row.storeDomain,
      token,
      shopId: install.shopId,
      tokenVersion: install.tokenVersion,
      productId: row.productId,
      stamp: row.updatedAt,
    });
    return ok ? 'synced' : 'failed';
  }

  async syncPublicSummaryMetafield(
    token: string,
    storeDomain: string,
    productId?: string,
  ): Promise<{ synced: number; queued: number }> {
    if (productId) {
      const ok = await this.syncPublicSummary(storeDomain, token, productId);
      return { synced: ok ? 1 : 0, queued: ok ? 0 : 1 };
    }

    const install = await this.prisma.appInstall.findUnique({
      where: { storeDomain },
      select: { shopId: true, tokenVersion: true },
    });
    if (!install) throw new ConflictException('App not installed for this store');

    let total = 0;
    let synced = 0;
    let cursor = '';
    for (;;) {
      const page = await this.prisma.reviewProduct.groupBy({
        by: ['productId'],
        where: { shopId: install.shopId, ...(cursor ? { productId: { gt: cursor } } : {}) },
        orderBy: { productId: 'asc' },
        take: 200,
      });
      if (page.length === 0) break;
      cursor = page[page.length - 1].productId;
      for (const { productId: pid } of page) {
        total += 1;
        const stamp = await this.pending.markDirty(storeDomain, pid);
        if (total <= INLINE_SYNC_ROWS) {
          const ok = await this.runSync({
            storeDomain,
            token,
            shopId: install.shopId,
            tokenVersion: install.tokenVersion,
            productId: pid,
            stamp,
          });
          if (ok) synced += 1;
        }
      }
      if (page.length < 200) break;
    }
    return { synced, queued: total - synced };
  }

  async addReview(
    token: string,
    storeDomain: string,
    productId: string,
    dto: CreateReviewDto,
    options: { autoApproveClean?: boolean; verified?: boolean } = {},
  ): Promise<Review> {
    const install = await this.resolveInstall(storeDomain);
    const shopId = install.shopId;

    const lock = await this.acquireLock(shopId, productId);
    try {
      const existingRows = await this.reviewStore.getReviews(shopId, productId, { size: 100 });
      const spamCfg = await this.getSpamConfig(token, storeDomain);
      const status = dto.status ?? detectSpam(
        dto.content || '',
        dto.author,
        spamCfg,
        existingRows.items.map((r) => ({ author: r.author, content: r.content })),
        options.autoApproveClean === true,
      );
      const verified = options.verified ?? dto.verified ?? false;

      const now = Date.now();
      const reviewId = generateId();

      await this.reviewStore.upsertReview({
        shopId,
        productId,
        reviewId,
        rating: dto.rating,
        content: dto.content || '',
        author: dto.author,
        email: dto.email ?? null,
        phone: dto.phone ?? null,
        title: dto.title ?? null,
        media: toMediaInput(dto.media),
        status,
        verified,
        pinned: dto.pinned ?? false,
        createdAt: dto.created_at ?? now,
      });

      if (status === 'approved') {
        await this.syncPublicSummary(storeDomain, token, productId);
      }

      return {
        id: reviewId,
        rating: dto.rating,
        content: dto.content || '',
        author: dto.author,
        email: dto.email,
        phone: dto.phone,
        title: dto.title,
        media: (dto.media ?? []).map(({ url, type }) => ({ url, type })),
        status,
        verified,
        pinned: dto.pinned,
        created_at: dto.created_at ?? now,
        updated_at: now,
      };
    } finally {
      await this.releaseLock(lock);
    }
  }

  async submitPublicReview(
    storeDomain: string,
    productId: string,
    input: PublicReviewInput,
    hooks: PublicSubmitHooks,
  ): Promise<PublicReviewSubmission> {
    const install = await this.requireServingInstall(storeDomain);
    const product = await this.catalogStore.getProduct(install.shopId, productId);
    if (!product || product.deletedAt) {
      throw new NotFoundException({ code: 'product_not_found', message: 'Product not found' });
    }

    const config = this.readWidgetConfig(install.metadata);
    for (const item of input.media) {
      const allowed = item.type === 'video' ? config.allowVideo !== false : config.allowImage !== false;
      if (!allowed) {
        throw new BadRequestException({
          code: 'media_type_not_allowed',
          message: `${item.type === 'video' ? 'Video' : 'Image'} attachments are disabled for this store`,
        });
      }
    }
    const fields = applyFormModes(config, input);
    const identity: PublicIdentity = { email: input.email, phone: input.phone };
    const hasIdentity = Boolean(identity.email || identity.phone);
    const gated = config.requirePurchaseToReview === true;

    if (gated && !hasIdentity) {
      throw new BadRequestException({
        code: 'identity_required',
        message: 'Email or phone is required to verify your purchase',
      });
    }
    if (hasIdentity) await hooks.chargeIdentity(identity);

    const verified = hasIdentity
      ? await this.lookupPurchase(install.shopId, productId, identity, gated)
      : false;
    if (gated && !verified) {
      throw new ForbiddenException({
        code: 'purchase_required',
        message: 'Only customers who bought this product can review it',
      });
    }

    const token = await hooks.resolveToken();
    const review = await this.addReview(
      token,
      storeDomain,
      productId,
      {
        rating: input.rating,
        content: fields.content,
        author: input.author,
        email: fields.email,
        phone: fields.phone,
        title: fields.title,
        media: input.media,
      },
      { autoApproveClean: config.autoApprove === true, verified },
    );
    return toPublicSubmission(review);
  }

  private async lookupPurchase(
    shopId: string,
    productId: string,
    identity: PublicIdentity,
    strict: boolean,
  ): Promise<boolean> {
    try {
      return await this.purchaseStore.hasPurchasedProduct(shopId, productId, identity);
    } catch (err) {
      this.logger.warn(
        `Purchase lookup failed for product ${productId}: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
      if (strict) {
        throw new ServiceUnavailableException({
          code: 'purchase_check_unavailable',
          message: 'Purchase verification is unavailable',
        });
      }
      return false;
    }
  }

  private async releasableMedia(
    shopId: string,
    productId: string,
    reviewId: string,
    urls: string[],
  ): Promise<string[]> {
    if (!urls.length) return [];
    const others = await this.prisma.reviewProduct.findMany({
      where: { shopId, NOT: { productId, reviewId }, media: { not: Prisma.DbNull } },
      select: { media: true },
    });
    const referenced = new Set(others.flatMap((row) => toMedia(row.media).map((item) => item.url)));
    return urls.filter((url) => !referenced.has(url));
  }

  async editReview(
    token: string,
    storeDomain: string,
    productId: string,
    reviewId: string,
    dto: UpdateReviewDto,
  ): Promise<Review | null> {
    const install = await this.resolveInstall(storeDomain);
    const shopId = install.shopId;

    let removedMedia: string[] = [];
    let result: Review;
    const lock = await this.acquireLock(shopId, productId);
    try {
      const existing = await this.reviewStore.getReview(shopId, productId, reviewId);
      if (!existing) return null;

      await this.reviewStore.upsertReview({
        shopId,
        productId,
        reviewId,
        rating: dto.rating !== undefined ? dto.rating : existing.rating,
        content: dto.content !== undefined ? dto.content : existing.content,
        author: dto.author !== undefined ? dto.author : existing.author,
        email: dto.email !== undefined ? dto.email : existing.email,
        phone: dto.phone !== undefined ? dto.phone : existing.phone,
        title: dto.title !== undefined ? dto.title : existing.title,
        media: toMediaInput(dto.media),
        status: dto.status !== undefined ? dto.status : existing.status,
        verified: dto.verified !== undefined ? dto.verified : existing.verified,
        pinned: dto.pinned !== undefined ? dto.pinned : existing.pinned,
        reply: existing.reply,
        repliedAt: existing.repliedAt ? Number(existing.repliedAt) : null,
        sourceRawJson: existing.sourceRawJson,
        createdAt: dto.created_at !== undefined ? dto.created_at : toNum(existing.createdAt),
      });

      if (dto.media !== undefined) {
        const kept = new Set(dto.media.map((item) => item.url));
        removedMedia = await this.releasableMedia(
          shopId,
          productId,
          reviewId,
          toMedia(existing.media).map((item) => item.url).filter((url) => !kept.has(url)),
        );
      }

      await this.syncPublicSummary(storeDomain, token, productId);

      const updated = await this.reviewStore.getReview(shopId, productId, reviewId);
      result = updated ? toDomainReview(updated) : toDomainReview(existing);
    } finally {
      await this.releaseLock(lock);
    }

    if (removedMedia.length) await this.media.deleteByUrls(removedMedia, storeDomain);
    return result;
  }

  async updateReviewStatus(
    token: string,
    storeDomain: string,
    productId: string,
    reviewId: string,
    status: 'approved' | 'pending' | 'hidden' | 'spam',
  ): Promise<Review | null> {
    const install = await this.resolveInstall(storeDomain);
    const shopId = install.shopId;

    const lock = await this.acquireLock(shopId, productId);
    try {
      const existing = await this.reviewStore.getReview(shopId, productId, reviewId);
      if (!existing) return null;

      await this.reviewStore.updateStatus(shopId, productId, reviewId, status);
      await this.syncPublicSummary(storeDomain, token, productId);

      return toDomainReview({ ...existing, status });
    } finally {
      await this.releaseLock(lock);
    }
  }

  async replyToReview(
    token: string,
    storeDomain: string,
    productId: string,
    reviewId: string,
    reply: string,
  ): Promise<Review | null> {
    const install = await this.resolveInstall(storeDomain);
    const shopId = install.shopId;

    const lock = await this.acquireLock(shopId, productId);
    try {
      const existing = await this.reviewStore.getReview(shopId, productId, reviewId);
      if (!existing) return null;

      const now = Date.now();
      await this.reviewStore.upsertReview({
        shopId,
        productId,
        reviewId,
        rating: existing.rating,
        content: existing.content,
        author: existing.author,
        email: existing.email,
        phone: existing.phone,
        title: existing.title,
        status: existing.status,
        verified: existing.verified,
        pinned: existing.pinned,
        reply,
        repliedAt: now,
        sourceRawJson: existing.sourceRawJson,
      });

      await this.syncPublicSummary(storeDomain, token, productId);
      return toDomainReview({ ...existing, reply, repliedAt: BigInt(now) });
    } finally {
      await this.releaseLock(lock);
    }
  }

  async pinReview(
    token: string,
    storeDomain: string,
    productId: string,
    reviewId: string,
    pinned?: boolean,
  ): Promise<Review | null> {
    const install = await this.resolveInstall(storeDomain);
    const shopId = install.shopId;

    const lock = await this.acquireLock(shopId, productId);
    try {
      const existing = await this.reviewStore.getReview(shopId, productId, reviewId);
      if (!existing) return null;

      const newPinned = pinned !== undefined ? pinned : !existing.pinned;

      await this.reviewStore.upsertReview({
        shopId,
        productId,
        reviewId,
        rating: existing.rating,
        content: existing.content,
        author: existing.author,
        email: existing.email,
        phone: existing.phone,
        title: existing.title,
        status: existing.status,
        verified: existing.verified,
        pinned: newPinned,
        reply: existing.reply,
        repliedAt: existing.repliedAt ? Number(existing.repliedAt) : null,
        sourceRawJson: existing.sourceRawJson,
      });

      return toDomainReview({ ...existing, pinned: newPinned });
    } finally {
      await this.releaseLock(lock);
    }
  }

  async deleteReview(
    token: string,
    storeDomain: string,
    productId: string,
    reviewId: string,
  ): Promise<{ deleted: boolean; summarySyncFailed?: boolean }> {
    const install = await this.resolveInstall(storeDomain);
    const shopId = install.shopId;

    let ownedMedia: string[] = [];
    let result: { deleted: boolean; summarySyncFailed?: boolean };
    const lock = await this.acquireLock(shopId, productId);
    try {
      const existing = await this.reviewStore.getReview(shopId, productId, reviewId);
      if (!existing) return { deleted: false };
      const deleted = await this.reviewStore.deleteReview(shopId, productId, reviewId);
      if (!deleted) return { deleted: false };
      ownedMedia = await this.releasableMedia(
        shopId,
        productId,
        reviewId,
        toMedia(existing.media).map((item) => item.url),
      );
      const summaryOk = await this.syncPublicSummary(storeDomain, token, productId);
      result = { deleted: true, ...(summaryOk ? {} : { summarySyncFailed: true }) };
    } finally {
      await this.releaseLock(lock);
    }

    if (ownedMedia.length) await this.media.deleteByUrls(ownedMedia, storeDomain);
    return result;
  }

  async getReviews(
    token: string,
    storeDomain: string,
    productId: string,
    star?: number,
  ): Promise<Review[]> {
    const install = await this.resolveInstall(storeDomain);
    const rows: Array<ReviewRow & { id: string }> = [];
    let cursor: string | undefined;
    while (rows.length < PRODUCT_LOAD_MAX_ROWS) {
      const chunk = await this.prisma.reviewProduct.findMany({
        where: { shopId: install.shopId, productId, ...(star ? { rating: star } : {}) },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: PRODUCT_LOAD_CHUNK,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      rows.push(...chunk);
      if (chunk.length < PRODUCT_LOAD_CHUNK) break;
      cursor = chunk[chunk.length - 1].id;
    }
    return rows.map((row) => toDomainReview(row));
  }

  async getProductStats(
    token: string,
    storeDomain: string,
    productId: string,
  ): Promise<ProductStats> {
    const install = await this.resolveInstall(storeDomain);
    const [summary, stats] = await Promise.all([
      this.reviewStore.calculatePublicSummary(install.shopId, productId),
      this.reviewStore.getStatsForProduct(install.shopId, productId),
    ]);

    return {
      total: stats.total,
      avgRating: stats.avgRating,
      approved: stats.approved,
      pending: stats.pending,
      hidden: stats.hidden,
      spam: stats.spam,
      summary,
    };
  }

  async isStoreServing(storeDomain: string): Promise<boolean> {
    return (await this.resolveServingInstall(storeDomain)) !== null;
  }

  async getPublicReviews(
    storeDomain: string,
    productId: string,
    options: PublicReviewsOptions = {},
  ): Promise<{ items: Review[]; total: number; page: number; pageSize: number }> {
    const page = Math.max(1, options.page ?? 1);
    const pageSize = Math.min(50, Math.max(1, options.limit ?? 20));
    const install = await this.resolveServingInstall(storeDomain);
    if (!install) return { items: [], total: 0, page, pageSize };
    const skip = (page - 1) * pageSize;

    const where = { shopId: install.shopId, productId, status: 'approved' };
    const sortDir = options.sort === 'oldest' ? 'asc' : 'desc';

    const [items, total] = await Promise.all([
      skip > PUBLIC_MAX_OFFSET
        ? Promise.resolve([])
        : this.prisma.reviewProduct.findMany({
            where,
            orderBy: [{ pinned: 'desc' }, { createdAt: sortDir }, { id: 'asc' }],
            skip,
            take: pageSize,
          }),
      this.prisma.reviewProduct.count({ where }),
    ]);

    return {
      items: items.map((row) => toPublicReview(row)),
      total,
      page,
      pageSize,
    };
  }

  async getPublicSummary(
    storeDomain: string,
    productId: string,
  ): Promise<RatingSummary> {
    const install = await this.resolveServingInstall(storeDomain);
    if (!install) return EMPTY_SUMMARY();
    return this.reviewStore.calculatePublicSummary(install.shopId, productId);
  }

  async getPublicWidgetConfig(storeDomain: string): Promise<WidgetConfig> {
    const install = await this.resolveServingInstall(storeDomain);
    if (!install) return { ...DEFAULT_WIDGET_CONFIG };
    return this.readWidgetConfig(install.metadata);
  }

  async getServingWidgetConfig(storeDomain: string): Promise<WidgetConfig> {
    const install = await this.requireServingInstall(storeDomain);
    return this.readWidgetConfig(install.metadata);
  }

  async getPublicSummaries(
    storeDomain: string,
    productIds: string[],
  ): Promise<Record<string, RatingSummary>> {
    const install = await this.resolveServingInstall(storeDomain);
    const unique = [...new Set(productIds.filter((id) => NUMERIC_ID_RE.test(id)))].slice(
      0,
      PUBLIC_SUMMARY_MAX_IDS,
    );
    const summaries = install
      ? await this.reviewStore.calculatePublicSummaries(install.shopId, unique)
      : new Map<string, RatingSummary>();
    const out: Record<string, RatingSummary> = {};
    for (const id of unique) out[id] = summaries.get(id) ?? EMPTY_SUMMARY();
    return out;
  }

  async checkPurchaseEligibility(
    storeDomain: string,
    productId: string,
    identity: PublicIdentity,
    chargeIdentity: PublicIdentityHook,
  ): Promise<PurchaseEligibility> {
    const install = await this.resolveServingInstall(storeDomain);
    if (!install) return { eligible: false, reason: 'not_purchased' };
    if (this.readWidgetConfig(install.metadata).requirePurchaseToReview !== true) {
      return { eligible: true, reason: 'not_required' };
    }
    const email = String(identity?.email || '').trim();
    const phone = String(identity?.phone || '').trim();
    if (!email && !phone) return { eligible: false, reason: 'missing_identity' };
    await chargeIdentity({ email, phone });
    const eligible = await this.lookupPurchase(install.shopId, productId, { email, phone }, true);
    return { eligible, reason: eligible ? 'verified' : 'not_purchased' };
  }

  async listAllReviews(
    token: string,
    storeDomain: string,
    options: ListAllReviewsOptions = {},
  ): Promise<AllReviewsPage> {
    const install = await this.resolveInstall(storeDomain);
    const shopId = install.shopId;

    const page = Math.max(1, options.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, options.limit ?? 20));
    const sortBy = options.sort === 'oldest' ? 'oldest' : 'newest';
    const status: AllReviewsStatus = isAllReviewsStatus(options.status)
      ? options.status
      : 'all';

    const and: Prisma.ReviewProductWhereInput[] = [];
    if (status === 'unreplied') and.push(UNREPLIED_WHERE);
    if (options.search) {
      and.push({
        OR: [
          { content: { contains: options.search, mode: 'insensitive' } },
          { author: { contains: options.search, mode: 'insensitive' } },
        ],
      });
    }
    const where: Prisma.ReviewProductWhereInput = {
      shopId,
      ...(status !== 'all' && status !== 'unreplied' ? { status } : {}),
      ...(options.productId ? { productId: options.productId } : {}),
      ...(options.star ? { rating: options.star } : {}),
      ...(and.length ? { AND: and } : {}),
    };

    const [statusGroups, unrepliedCount] = await Promise.all([
      this.prisma.reviewProduct.groupBy({ by: ['status'], where: { shopId }, _count: { _all: true } }),
      this.prisma.reviewProduct.count({ where: { shopId, ...UNREPLIED_WHERE } }),
    ]);
    const statusCounts = EMPTY_STATUS_COUNTS();
    for (const group of statusGroups) {
      statusCounts.all += group._count._all;
      if (isStoredStatus(group.status)) {
        statusCounts[group.status] += group._count._all;
      }
    }
    statusCounts.unreplied = unrepliedCount;

    const total = await this.prisma.reviewProduct.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const currentPage = Math.min(page, totalPages);
    const skip = (currentPage - 1) * pageSize;

    const rows = await this.prisma.reviewProduct.findMany({
      where,
      orderBy: { createdAt: sortBy === 'oldest' ? 'asc' : 'desc' },
      skip,
      take: pageSize,
    });
    const titles = await catalogTitles(this.prisma, shopId, rows.map((row) => row.productId));

    return {
      items: rows.map((row) => toReviewListItem(row, titles.get(row.productId))),
      total,
      page: currentPage,
      pageSize,
      totalPages,
      statusCounts,
    };
  }

  async getWidgetConfig(token: string, storeDomain: string): Promise<WidgetConfig> {
    const install = await this.resolveInstall(storeDomain);
    return this.readWidgetConfig(install.metadata);
  }

  private readWidgetConfig(metadata: unknown): WidgetConfig {
    const saved = (metadata as Record<string, unknown> | null)?.[WIDGET_CONFIG_METADATA_KEY];
    return toWidgetConfig(saved);
  }

  async updateWidgetConfig(
    token: string,
    dto: UpdateWidgetConfigDto,
    storeDomain: string,
  ): Promise<WidgetConfig> {
    const patch = stripUndefined(dto as Record<string, unknown>);
    const saved = await mergeInstallMetadataKey(this.prisma, storeDomain, WIDGET_CONFIG_METADATA_KEY, patch);
    if (!saved) throw new ConflictException('App not installed for this store');
    return toWidgetConfig(saved);
  }

  async getSpamConfig(token: string, storeDomain: string): Promise<SpamConfig> {
    const install = await this.resolveInstall(storeDomain);
    const metadata = (install.metadata as Record<string, unknown>) || {};
    const saved = metadata[SPAM_CONFIG_METADATA_KEY] as Partial<SpamConfig> | undefined;
    return { ...DEFAULT_SPAM_CONFIG, ...saved };
  }

  async updateSpamConfig(
    token: string,
    dto: UpdateSpamConfigDto,
    storeDomain: string,
  ): Promise<SpamConfig> {
    const patch = stripUndefined(dto as Record<string, unknown>);
    const saved = await mergeInstallMetadataKey(this.prisma, storeDomain, SPAM_CONFIG_METADATA_KEY, patch);
    if (!saved) throw new ConflictException('App not installed for this store');
    return { ...DEFAULT_SPAM_CONFIG, ...(saved as Partial<SpamConfig>) };
  }
}
