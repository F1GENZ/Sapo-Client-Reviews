import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { parseCsvRecords, toCsv } from '../common/csv';
import { STRICT_EMAIL_RE, isValidPhone } from '../common/security/public-limits';
import { CatalogProductStoreService } from '../catalog/catalog-product-store.service';
import { MetafieldSyncPendingService } from '../database/metafield-sync-pending.service';
import { PrismaService } from '../database/prisma.service';
import { MediaService } from '../media/media.service';
import { OutboundWebhookService } from '../outbound/outbound-webhook.service';
import { ReviewProductStoreService } from './review-product-store.service';
import { ReviewService } from './review.service';

export const MAX_IMPORT_ROWS = 2000;
export const MAX_BULK_ITEMS = 500;
export const MAX_EXPORT_ROWS = 10_000;
const INLINE_SUMMARY_SYNC = 25;
const MAX_ERRORS_RETURNED = 50;
const MAX_MEDIA_ITEMS = 6;
const STATUS_VALUES = ['pending', 'approved', 'hidden', 'spam'] as const;

export type ReviewImportFormat = 'csv' | 'json';
export type ReviewBulkAction = 'approve' | 'pending' | 'hidden' | 'spam' | 'delete';

export type ImportRowError = { row: number; reviewId?: string; message: string };

export type ReviewImportResult = {
  mode: 'dry_run' | 'apply';
  format: ReviewImportFormat;
  total: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: ImportRowError[];
  summarySync: { synced: number; queued: number };
  runId: string | null;
};

export type ReviewBulkResult = {
  requested: number;
  updated: number;
  deleted: number;
  skipped: number;
  failed: number;
  summarySync: { synced: number; queued: number };
};

export type ReviewExportResult = {
  filename: string;
  contentType: string;
  body: string;
};

type ParsedRow = {
  productId: string;
  reviewId: string;
  rating: number;
  author: string;
  content: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  status: (typeof STATUS_VALUES)[number];
  verified: boolean;
  pinned: boolean;
  reply: string | null;
  createdAt: number | null;
  media: Array<{ url: string; type: 'image' | 'video' }>;
};

const asText = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';

const parseBoolean = (value: unknown): boolean | null => {
  const text = asText(value).toLowerCase();
  if (!text) return null;
  if (['true', '1', 'yes', 'y', 'có'].includes(text)) return true;
  if (['false', '0', 'no', 'n', 'không'].includes(text)) return false;
  return null;
};

const parseTimestamp = (value: unknown): number | null => {
  const text = asText(value);
  if (!text) return null;
  const numeric = Number(text);
  const parsed = Number.isFinite(numeric) && numeric > 0 ? numeric : Date.parse(text);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  const lowerBound = Date.parse('2020-01-01T00:00:00Z');
  const upperBound = Date.now() + 86_400_000;
  return Math.min(upperBound, Math.max(lowerBound, Math.trunc(parsed)));
};

const parseMedia = (value: unknown): Array<{ url: string; type: 'image' | 'video' }> => {
  const text = asText(value);
  if (!text) return [];
  let items: unknown[];
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text) as unknown;
      items = Array.isArray(parsed) ? parsed : [];
    } catch {
      throw new BadRequestException('media must be a JSON array');
    }
  } else {
    items = text.split(/[|,\s]+/).filter(Boolean);
  }
  const media: Array<{ url: string; type: 'image' | 'video' }> = [];
  for (const item of items.slice(0, MAX_MEDIA_ITEMS)) {
    const record = item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
    const url = record ? asText(record.url) : asText(item);
    if (!url) continue;
    if (!/^https:\/\//i.test(url)) throw new BadRequestException('media url must be https');
    const type = record && asText(record.type) === 'video' ? 'video' : 'image';
    media.push({ url, type });
  }
  return media;
};

const parseRow = (record: Record<string, unknown>): ParsedRow => {
  const productId = asText(record.product_id ?? record.productId);
  if (!/^[1-9]\d{0,19}$/.test(productId)) throw new BadRequestException('product_id is required');
  const reviewId = asText(record.review_id ?? record.reviewId ?? record.id);
  if (!reviewId || reviewId.length > 64) throw new BadRequestException('review_id must be 1-64 characters');
  const rating = Number(asText(record.rating ?? record.star));
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new BadRequestException('rating must be an integer 1-5');
  const author = asText(record.author);
  if (!author || author.length > 100) throw new BadRequestException('author must be 1-100 characters');
  const content = typeof record.content === 'string' ? record.content : asText(record.content);
  if (content.length > 2000) throw new BadRequestException('content must be at most 2000 characters');
  const title = asText(record.title);
  if (title.length > 100) throw new BadRequestException('title must be at most 100 characters');
  const email = asText(record.email);
  if (email && (!STRICT_EMAIL_RE.test(email) || email.length > 200)) throw new BadRequestException('email is invalid');
  const phone = asText(record.phone);
  if (phone && (!isValidPhone(phone) || phone.length > 20)) throw new BadRequestException('phone is invalid');
  const statusText = asText(record.status).toLowerCase() || 'pending';
  if (!(STATUS_VALUES as readonly string[]).includes(statusText)) {
    throw new BadRequestException('status must be pending, approved, hidden or spam');
  }
  const reply = asText(record.reply);
  if (reply.length > 2000) throw new BadRequestException('reply must be at most 2000 characters');
  return {
    productId,
    reviewId,
    rating,
    author,
    content,
    title: title || null,
    email: email || null,
    phone: phone || null,
    status: statusText as ParsedRow['status'],
    verified: parseBoolean(record.verified) ?? false,
    pinned: parseBoolean(record.pinned) ?? false,
    reply: reply || null,
    createdAt: parseTimestamp(record.created_at ?? record.createdAt),
    media: parseMedia(record.media),
  };
};

const readRecords = (format: ReviewImportFormat, body: string): Array<Record<string, unknown>> => {
  if (format === 'csv') return parseCsvRecords(body) as Array<Record<string, unknown>>;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new BadRequestException('JSON body is invalid');
  }
  if (!Array.isArray(parsed)) throw new BadRequestException('JSON body must be an array of rows');
  return parsed.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object');
};

const toDate = (value: bigint | number | null): number | null => {
  if (value === null) return null;
  const numeric = typeof value === 'bigint' ? Number(value) : value;
  return Number.isFinite(numeric) ? numeric : null;
};

@Injectable()
export class ReviewDataToolsService {
  private readonly logger = new Logger(ReviewDataToolsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reviewStore: ReviewProductStoreService,
    private readonly reviewService: ReviewService,
    private readonly catalogStore: CatalogProductStoreService,
    private readonly pending: MetafieldSyncPendingService,
    private readonly media: MediaService,
    private readonly outbound: OutboundWebhookService,
  ) {}

  private async requireInstall(storeDomain: string): Promise<string> {
    const install = await this.prisma.appInstall.findUnique({
      where: { storeDomain },
      select: { shopId: true },
    });
    if (!install) throw new ConflictException('App not installed for this store');
    return install.shopId;
  }

  async exportReviews(storeDomain: string, format: ReviewImportFormat): Promise<ReviewExportResult> {
    const shopId = await this.requireInstall(storeDomain);
    const rows = await this.prisma.reviewProduct.findMany({
      where: { shopId },
      orderBy: { createdAt: 'desc' },
      take: MAX_EXPORT_ROWS,
    });
    const records = rows.map((row) => ({
      product_id: row.productId,
      review_id: row.reviewId,
      rating: row.rating,
      author: row.author,
      title: row.title ?? '',
      content: row.content,
      email: row.email ?? '',
      phone: row.phone ?? '',
      status: row.status,
      verified: row.verified,
      pinned: row.pinned,
      reply: row.reply ?? '',
      created_at: toDate(row.createdAt) ?? '',
      media: Array.isArray(row.media) ? JSON.stringify(row.media) : '',
    }));
    if (format === 'json') {
      return {
        filename: `f1genz-reviews-${storeDomain}.json`,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(records, null, 0),
      };
    }
    const header = [
      'product_id', 'review_id', 'rating', 'author', 'title', 'content', 'email', 'phone',
      'status', 'verified', 'pinned', 'reply', 'created_at', 'media',
    ];
    const csvRows = [header, ...records.map((record) => header.map((key) => record[key as keyof typeof record]))];
    return {
      filename: `f1genz-reviews-${storeDomain}.csv`,
      contentType: 'text/csv; charset=utf-8',
      body: toCsv(csvRows),
    };
  }

  async importReviews(
    token: string,
    storeDomain: string,
    input: { format: ReviewImportFormat; body: string; dryRun: boolean },
  ): Promise<ReviewImportResult> {
    const shopId = await this.requireInstall(storeDomain);
    const records = readRecords(input.format, input.body);
    if (records.length === 0) throw new BadRequestException('No rows to import');
    if (records.length > MAX_IMPORT_ROWS) {
      throw new BadRequestException(`At most ${MAX_IMPORT_ROWS} rows per import`);
    }

    const result: ReviewImportResult = {
      mode: input.dryRun ? 'dry_run' : 'apply',
      format: input.format,
      total: records.length,
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      errors: [],
      summarySync: { synced: 0, queued: 0 },
      runId: null,
    };
    const affected = new Set<string>();

    for (let index = 0; index < records.length; index += 1) {
      const rowNumber = index + 1;
      let parsed: ParsedRow;
      try {
        parsed = parseRow(records[index]);
      } catch (error) {
        result.failed += 1;
        if (result.errors.length < MAX_ERRORS_RETURNED) {
          result.errors.push({ row: rowNumber, message: error instanceof Error ? error.message : 'invalid row' });
        }
        continue;
      }
      const product = await this.catalogStore.getProduct(shopId, parsed.productId);
      if (!product || product.deletedAt) {
        result.skipped += 1;
        if (result.errors.length < MAX_ERRORS_RETURNED) {
          result.errors.push({ row: rowNumber, reviewId: parsed.reviewId, message: 'product_not_in_catalog' });
        }
        continue;
      }
      const existing = await this.reviewStore.getReview(shopId, parsed.productId, parsed.reviewId);
      if (!input.dryRun) {
        await this.reviewStore.upsertReview({
          shopId,
          productId: parsed.productId,
          reviewId: parsed.reviewId,
          rating: parsed.rating,
          content: parsed.content,
          author: parsed.author,
          email: parsed.email,
          phone: parsed.phone,
          title: parsed.title,
          media: parsed.media.length ? parsed.media : null,
          status: parsed.status,
          verified: parsed.verified,
          pinned: parsed.pinned,
          reply: parsed.reply,
          repliedAt: parsed.reply ? Date.now() : null,
          createdAt: parsed.createdAt ?? Date.now(),
        });
        affected.add(parsed.productId);
      }
      if (existing) result.updated += 1;
      else result.created += 1;
    }

    if (!input.dryRun) {
      result.summarySync = await this.syncSummaries(token, storeDomain, [...affected]);
      const run = await this.prisma.importRun.create({
        data: {
          shopId,
          storeDomain,
          kind: 'reviews',
          mode: result.mode,
          format: result.format,
          total: result.total,
          created: result.created,
          updated: result.updated,
          skipped: result.skipped,
          failed: result.failed,
          errors: result.errors.length
            ? (result.errors.slice(0, MAX_ERRORS_RETURNED) as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
        },
        select: { id: true },
      });
      result.runId = run.id;
    }
    return result;
  }

  async bulkReviews(
    token: string,
    storeDomain: string,
    action: ReviewBulkAction,
    items: Array<{ productId: string; reviewId: string }>,
  ): Promise<ReviewBulkResult> {
    const shopId = await this.requireInstall(storeDomain);
    if (items.length === 0) throw new BadRequestException('At least one review is required');
    if (items.length > MAX_BULK_ITEMS) throw new BadRequestException(`At most ${MAX_BULK_ITEMS} reviews per bulk action`);

    const result: ReviewBulkResult = {
      requested: items.length,
      updated: 0,
      deleted: 0,
      skipped: 0,
      failed: 0,
      summarySync: { synced: 0, queued: 0 },
    };
    const affected = new Set<string>();

    for (const item of items) {
      try {
        const existing = await this.reviewStore.getReview(shopId, item.productId, item.reviewId);
        if (!existing) {
          result.skipped += 1;
          continue;
        }
        if (action === 'delete') {
          const deleted = await this.reviewStore.deleteReview(shopId, item.productId, item.reviewId);
          if (!deleted) {
            result.skipped += 1;
            continue;
          }
          const urls = Array.isArray(existing.media)
            ? existing.media
                .filter((entry): entry is object => Boolean(entry) && typeof entry === 'object')
                .map((entry) => ('url' in entry && typeof entry.url === 'string' ? entry.url : ''))
                .filter(Boolean)
            : [];
          if (urls.length) await this.media.deleteByUrls(urls, storeDomain).catch(() => undefined);
          result.deleted += 1;
          affected.add(item.productId);
          void this.outbound.enqueue(storeDomain, 'review.deleted', {
            productId: item.productId,
            reviewId: item.reviewId,
          });
          continue;
        }
        const targetStatus = action === 'approve' ? 'approved' : action;
        if (existing.status === targetStatus) {
          result.skipped += 1;
          continue;
        }
        await this.reviewStore.updateStatus(shopId, item.productId, item.reviewId, targetStatus);
        result.updated += 1;
        affected.add(item.productId);
        void this.outbound.enqueue(
          storeDomain,
          targetStatus === 'approved' ? 'review.approved' : 'review.updated',
          { productId: item.productId, reviewId: item.reviewId, rating: existing.rating, status: targetStatus },
        );
      } catch (error) {
        result.failed += 1;
        this.logger.warn(
          `Bulk ${action} failed for ${item.productId}/${item.reviewId}: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }

    result.summarySync = await this.syncSummaries(token, storeDomain, [...affected]);
    return result;
  }

  async listImportRuns(storeDomain: string, kind: 'reviews' | 'qna'): Promise<Array<{
    id: string;
    mode: string;
    format: string;
    total: number;
    created: number;
    updated: number;
    skipped: number;
    failed: number;
    createdAt: Date;
  }>> {
    const rows = await this.prisma.importRun.findMany({
      where: { storeDomain, kind },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true, mode: true, format: true, total: true, created: true,
        updated: true, skipped: true, failed: true, createdAt: true,
      },
    });
    return rows;
  }

  private async syncSummaries(
    token: string,
    storeDomain: string,
    productIds: string[],
  ): Promise<{ synced: number; queued: number }> {
    let synced = 0;
    let queued = 0;
    for (const productId of productIds) {
      await this.pending.markDirty(storeDomain, productId).catch(() => null);
      if (synced < INLINE_SUMMARY_SYNC) {
        const outcome = await this.reviewService
          .syncPublicSummaryMetafield(token, storeDomain, productId)
          .catch(() => ({ synced: 0, queued: 1 }));
        synced += outcome.synced;
        queued += outcome.queued;
      } else {
        queued += 1;
      }
    }
    return { synced, queued };
  }
}
