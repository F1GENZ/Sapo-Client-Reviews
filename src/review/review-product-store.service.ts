import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { catalogTitles, labelUpdateFields, resolveProductLabel } from '../catalog/product-label';
import type { RatingSummary } from './interfaces/review.interface';
import { UNREPLIED_WHERE } from './review-where';

export interface ReviewProductUpsertInput {
  shopId: string;
  productId: string;
  reviewId: string;
  rating: number;
  content: string;
  author: string;
  email?: string | null;
  phone?: string | null;
  title?: string | null;
  media?: Prisma.InputJsonValue | null;
  status?: string;
  verified?: boolean;
  pinned?: boolean;
  reply?: string | null;
  repliedAt?: number | null;
  sourceRawJson?: string | null;
  createdAt?: number;
  productTitle?: string | null;
  productName?: string | null;
  productHandle?: string | null;
  productImage?: string | null;
}

export interface ReviewProduct {
  id: string;
  shopId: string;
  productId: string;
  productTitle: string | null;
  productName: string | null;
  productHandle: string | null;
  productImage: string | null;
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
  createdAt: bigint;
  updatedAt: bigint;
}

export interface ReviewPageOptions {
  status?: string;
  page?: number;
  size?: number;
  sort?: string;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface ProductStats {
  total: number;
  avgRating: number;
  approved: number;
  pending: number;
  hidden: number;
  spam: number;
}

const DEFAULT_PAGE = 0;
const DEFAULT_SIZE = 20;
const MAX_SIZE = 100;
const STATUS_KEYS = ['approved', 'pending', 'hidden', 'spam'] as const;

type StatusKey = (typeof STATUS_KEYS)[number];

const isStatusKey = (value: string): value is StatusKey =>
  (STATUS_KEYS as readonly string[]).includes(value);

const normalizeInt = (value: unknown, fallback: number): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
};

const clampSize = (raw: unknown): number => {
  const n = normalizeInt(raw, DEFAULT_SIZE);
  return Math.max(1, Math.min(MAX_SIZE, n));
};

const clampPage = (raw: unknown): number => {
  return Math.max(0, normalizeInt(raw, DEFAULT_PAGE));
};

const buildOrderBy = (
  sort?: string,
): Record<string, 'asc' | 'desc'> => {
  if (!sort) return { createdAt: 'desc' };

  const [rawField, rawDir] = sort.split(',');
  const field = (rawField ?? '').trim();
  const direction = (rawDir ?? '').trim().toLowerCase() === 'asc' ? 'asc' : 'desc';

  switch (field) {
    case 'rating':
    case 'numberStar':
      return { rating: direction };
    case 'createdDate':
    case 'created_at':
      return { createdAt: direction };
    case 'updated_at':
    case 'lastModifiedDate':
      return { updatedAt: direction };
    default:
      return { createdAt: direction };
  }
};

const toMediaColumn = (
  media: Prisma.InputJsonValue | null | undefined,
): Prisma.InputJsonValue | typeof Prisma.DbNull | undefined => {
  if (media === undefined) return undefined;
  return media === null ? Prisma.DbNull : media;
};

@Injectable()
export class ReviewProductStoreService {
  constructor(private readonly prisma: PrismaService) {}

  async upsertReview(input: ReviewProductUpsertInput): Promise<ReviewProduct> {
    const now = BigInt(Date.now());
    const label = await resolveProductLabel(this.prisma, input.shopId, input.productId, input);

    const data = {
      shopId: input.shopId,
      productId: input.productId,
      reviewId: input.reviewId,
      rating: input.rating,
      content: input.content,
      author: input.author,
      email: input.email ?? null,
      phone: input.phone ?? null,
      title: input.title ?? null,
      media: toMediaColumn(input.media),
      status: input.status || 'pending',
      verified: input.verified ?? false,
      pinned: input.pinned ?? false,
      reply: input.reply ?? null,
      repliedAt: input.repliedAt != null ? BigInt(input.repliedAt) : null,
      sourceRawJson: input.sourceRawJson ?? null,
      updatedAt: now,
    };

    return this.prisma.reviewProduct.upsert({
      where: {
        shopId_productId_reviewId: {
          shopId: input.shopId,
          productId: input.productId,
          reviewId: input.reviewId,
        },
      },
      create: {
        ...data,
        ...label,
        createdAt: input.createdAt ? BigInt(input.createdAt) : now,
      },
      update: { ...data, ...labelUpdateFields(label) },
    });
  }

  async getReview(
    shopId: string,
    productId: string,
    reviewId: string,
  ): Promise<ReviewProduct | null> {
    return this.prisma.reviewProduct.findUnique({
      where: {
        shopId_productId_reviewId: { shopId, productId, reviewId },
      },
    });
  }

  async deleteReview(shopId: string, productId: string, reviewId: string): Promise<boolean> {
    const result = await this.prisma.reviewProduct.deleteMany({
      where: { shopId, productId, reviewId },
    });
    return result.count > 0;
  }

  async getReviews(
    shopId: string,
    productId: string,
    options: ReviewPageOptions = {},
  ): Promise<PaginatedResult<ReviewProduct>> {
    const page = clampPage(options.page);
    const pageSize = clampSize(options.size);
    const skip = page * pageSize;

    const where: Prisma.ReviewProductWhereInput = {
      shopId,
      productId,
      ...(options.status ? { status: options.status } : {}),
    };

    const orderBy = buildOrderBy(options.sort);

    const [items, total] = await Promise.all([
      this.prisma.reviewProduct.findMany({ where, orderBy, skip, take: pageSize }),
      this.prisma.reviewProduct.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  async getAllReviews(
    shopId: string,
    options: ReviewPageOptions = {},
  ): Promise<PaginatedResult<ReviewProduct>> {
    const page = clampPage(options.page);
    const pageSize = clampSize(options.size);
    const skip = page * pageSize;

    const where: Prisma.ReviewProductWhereInput = {
      shopId,
      ...(options.status ? { status: options.status } : {}),
    };

    const orderBy = buildOrderBy(options.sort);

    const [items, total] = await Promise.all([
      this.prisma.reviewProduct.findMany({ where, orderBy, skip, take: pageSize }),
      this.prisma.reviewProduct.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  async updateStatus(
    shopId: string,
    productId: string,
    reviewId: string,
    status: string,
  ): Promise<ReviewProduct> {
    return this.prisma.reviewProduct.update({
      where: {
        shopId_productId_reviewId: { shopId, productId, reviewId },
      },
      data: {
        status,
        updatedAt: BigInt(Date.now()),
      },
    });
  }

  async getStatsForProduct(
    shopId: string,
    productId: string,
  ): Promise<ProductStats> {
    const [aggregation, statusCounts] = await Promise.all([
      this.prisma.reviewProduct.aggregate({
        where: { shopId, productId },
        _count: { id: true },
        _avg: { rating: true },
      }),
      this.prisma.reviewProduct.groupBy({
        by: ['status'],
        where: { shopId, productId },
        _count: { id: true },
      }),
    ]);

    const counts: Record<StatusKey, number> = {
      approved: 0,
      pending: 0,
      hidden: 0,
      spam: 0,
    };

    for (const row of statusCounts) {
      const key = row.status.toLowerCase();
      if (isStatusKey(key)) {
        counts[key] = row._count.id;
      }
    }

    return {
      total: aggregation._count.id,
      avgRating:
        Math.round((aggregation._avg.rating ?? 0) * 10) / 10,
      approved: counts.approved,
      pending: counts.pending,
      hidden: counts.hidden,
      spam: counts.spam,
    };
  }

  async calculatePublicSummary(
    shopId: string,
    productId: string,
  ): Promise<RatingSummary> {
    const ratings = await this.prisma.reviewProduct.groupBy({
      by: ['rating'],
      where: { shopId, productId, status: 'approved' },
      _count: { id: true },
    });

    return this.buildSummary(ratings);
  }

  async calculatePublicSummaries(
    shopId: string,
    productIds: string[],
  ): Promise<Map<string, RatingSummary>> {
    const byProduct = new Map<string, Array<{ rating: number; _count: { id: number } }>>();
    for (const id of productIds) byProduct.set(id, []);
    if (productIds.length > 0) {
      const groups = await this.prisma.reviewProduct.groupBy({
        by: ['productId', 'rating'],
        where: { shopId, productId: { in: productIds }, status: 'approved' },
        _count: { id: true },
      });
      for (const group of groups) {
        byProduct.get(group.productId)?.push({ rating: group.rating, _count: group._count });
      }
    }
    const summaries = new Map<string, RatingSummary>();
    for (const [id, ratings] of byProduct) summaries.set(id, this.buildSummary(ratings));
    return summaries;
  }

  async getStatsForShop(shopId: string) {
    const [
      totalResult,
      statusGroups,
      verifiedCount,
      mediaCount,
      avgResult,
      products,
      ratingGroups,
      unrepliedCount,
    ] = await Promise.all([
      this.prisma.reviewProduct.count({ where: { shopId } }),
      this.prisma.reviewProduct.groupBy({ by: ['status'], where: { shopId }, _count: true }),
      this.prisma.reviewProduct.count({ where: { shopId, verified: true } }),
      this.prisma.reviewProduct.count({ where: { shopId, media: { not: Prisma.DbNull } } }),
      this.prisma.reviewProduct.aggregate({ where: { shopId, status: 'approved' }, _avg: { rating: true } }),
      this.prisma.reviewProduct.groupBy({ by: ['productId'], where: { shopId }, _count: true, _avg: { rating: true }, _max: { productTitle: true } }),
      this.prisma.reviewProduct.groupBy({ by: ['rating'], where: { shopId, status: 'approved' }, _count: true }),
      this.prisma.reviewProduct.count({ where: { shopId, ...UNREPLIED_WHERE } }),
    ]);

    const titles = await catalogTitles(this.prisma, shopId, products.map((p) => p.productId));
    const globalDist: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const g of ratingGroups) {
      if (g.rating >= 1 && g.rating <= 5) globalDist[g.rating] = g._count;
    }

    const statusCounts: Record<StatusKey | 'unreplied', number> = {
      approved: 0,
      pending: 0,
      hidden: 0,
      spam: 0,
      unreplied: unrepliedCount,
    };
    for (const g of statusGroups) {
      if (isStatusKey(g.status)) statusCounts[g.status] = g._count;
    }

    return {
      totalReviews: totalResult,
      statusCounts,
      verifiedCount,
      withMediaCount: mediaCount,
      globalAvg: Math.round((avgResult._avg.rating || 0) * 10) / 10,
      globalDist,
      products: products.map((p) => ({
        productId: p.productId,
        title: titles.get(p.productId) || p._max.productTitle || '',
        reviewCount: p._count,
        reviewAvg: Math.round((p._avg.rating || 0) * 10) / 10,
      })),
      productCount: products.length,
    };
  }

  private buildSummary(
    ratings: Array<{ rating: number; _count: { id: number } }>,
  ): RatingSummary {
    type Dist = RatingSummary["distribution"];
    const distribution: Dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let count = 0;
    let sum = 0;

    for (const r of ratings) {
      if (r.rating >= 1 && r.rating <= 5) {
        distribution[r.rating as 1 | 2 | 3 | 4 | 5] = r._count.id;
        count += r._count.id;
        sum += r.rating * r._count.id;
      }
    }

    return {
      avg: count > 0 ? Math.round((sum / count) * 10) / 10 : 0,
      count,
      distribution,
    };
  }
}
