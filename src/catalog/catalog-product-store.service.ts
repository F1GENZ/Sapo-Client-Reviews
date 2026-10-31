import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

const STALE_SCAN_CHUNK = 500;

export type CatalogProductInput = {
  shopId: string;
  productId: string | number;
  title?: string | null;
  handle?: string | null;
  image?: string | null;
  vendor?: string | null;
  productType?: string | null;
  tags?: string | null;
  status?: string | null;
  published?: boolean | null;
  deletedAt?: number | null;
  rawPayload?: unknown;
  source?: 'sapo' | 'import' | 'webhook' | 'derived';
  updatedAt?: number;
};

export type CatalogProduct = {
  id: string;
  productId: string;
  title: string;
  handle: string;
  image?: { src?: string };
  productImage?: string;
  vendor?: string;
  productType?: string;
  tags?: string;
  status?: string;
  deletedAt?: number;
  source?: string;
  updatedAt: number;
};

const toText = (value: unknown): string => {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value).trim();
  }
  return '';
};

const getNested = (
  value: Record<string, unknown>,
  path: string[],
): unknown => {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
};

@Injectable()
export class CatalogProductStoreService {
  private readonly logger = new Logger(CatalogProductStoreService.name);

  constructor(private readonly prisma: PrismaService) {}

  normalizeSapoProduct(
    shopId: string,
    product: Record<string, unknown>,
    source: CatalogProductInput['source'] = 'sapo',
  ): CatalogProductInput | null {
    const productId = toText(product.id || product.product_id || product.productId);
    if (!productId) return null;
    const image =
      toText(getNested(product, ['image', 'src'])) ||
      toText(getNested(product, ['images', '0', 'src'])) ||
      toText(product.image_url || product.productImage);
    return {
      shopId,
      productId,
      title: toText(product.title || product.name || product.productName),
      handle: toText(product.handle || product.alias || product.productHandle),
      image: image || null,
      vendor: toText(product.vendor) || null,
      productType: toText(product.product_type || product.productType) || null,
      tags: toText(product.tags) || null,
      status: toText(product.status) || null,
      published:
        typeof product.published === 'boolean'
          ? product.published
          : typeof product.published_on === 'string' || typeof product.published_at === 'string'
            ? Boolean(product.published_on || product.published_at)
            : null,
      rawPayload: product,
      source,
      updatedAt: Date.now(),
    };
  }

  async upsertProduct(input: CatalogProductInput): Promise<void> {
    await this.upsertProducts([input]);
  }

  async upsertProducts(inputs: CatalogProductInput[]): Promise<void> {
    if (!inputs.length) return;
    const now = Date.now();

    const rows = inputs
      .map((input) => ({
        shopId: input.shopId,
        productId: toText(input.productId),
        title: toText(input.title),
        handle: toText(input.handle),
        image: toText(input.image) || null,
        vendor: toText(input.vendor) || null,
        productType: toText(input.productType) || null,
        tags: toText(input.tags) || null,
        status: toText(input.status) || null,
        published:
          typeof input.published === 'boolean' ? input.published : null,
        deletedAt: input.deletedAt ?? null,
        rawPayload:
          input.rawPayload === undefined || input.rawPayload === null
            ? undefined
            : (input.rawPayload as Prisma.InputJsonValue),
        source: input.source || 'derived',
        updatedAt: BigInt(input.updatedAt || now),
      }))
      .filter((row) => row.shopId && row.productId);

    if (!rows.length) return;

    const shopId = rows[0].shopId;
    const productIds = rows.map((r) => r.productId);

    const existingRecords = await this.prisma.catalogProduct.findMany({
      where: { shopId, productId: { in: productIds } },
    });
    const existingMap = new Map(
      existingRecords.map((e) => [e.productId, e]),
    );

    const operations: Prisma.PrismaPromise<unknown>[] = [];

    for (const row of rows) {
      const prev = existingMap.get(row.productId);

      if (!prev) {
        operations.push(
          this.prisma.catalogProduct.create({
            data: {
              shopId: row.shopId,
              productId: row.productId,
              title: row.title,
              handle: row.handle,
              image: row.image,
              vendor: row.vendor,
              productType: row.productType,
              tags: row.tags,
              status: row.status,
              published: row.published,
              deletedAt:
                row.deletedAt !== null ? BigInt(row.deletedAt) : null,
              rawPayload: row.rawPayload,
              source: row.source,
              createdAt: new Date(),
              updatedAt: row.updatedAt,
            },
          }),
        );
        continue;
      }

      const reviveFromSapo =
        row.source === 'sapo' && row.deletedAt === null && prev.deletedAt !== null;

      if (!reviveFromSapo && prev.updatedAt >= row.updatedAt) continue;

      let deletedAt: bigint | null = prev.deletedAt;
      if (reviveFromSapo) deletedAt = null;
      else if (row.deletedAt !== null) deletedAt = BigInt(row.deletedAt);

      operations.push(
        this.prisma.catalogProduct.update({
          where: {
            shopId_productId: {
              shopId: row.shopId,
              productId: row.productId,
            },
          },
          data: {
            title: row.title || prev.title,
            handle: row.handle || prev.handle,
            image: row.image,
            vendor: row.vendor,
            productType: row.productType,
            tags: row.tags,
            status: row.status,
            published: row.published,
            deletedAt,
            rawPayload: row.rawPayload,
            source: row.source,
            updatedAt: row.updatedAt > prev.updatedAt ? row.updatedAt : prev.updatedAt,
          },
        }),
      );
    }

    if (!operations.length) return;

    try {
      await this.prisma.$transaction(operations);
    } catch (error) {
      this.logger.warn(
        `Catalog product upsert failed: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
      );
      throw error;
    }
  }

  async softDeleteProduct(
    shopId: string,
    productId: string,
  ): Promise<void> {
    const now = BigInt(Date.now());
    await this.prisma.catalogProduct.upsert({
      where: { shopId_productId: { shopId, productId } },
      create: {
        shopId,
        productId,
        title: '',
        handle: '',
        deletedAt: now,
        source: 'webhook',
        createdAt: new Date(),
        updatedAt: now,
      },
      update: {
        deletedAt: now,
        source: 'webhook',
        updatedAt: now,
      },
    });
  }

  async getProduct(
    shopId: string,
    productId: string,
  ): Promise<CatalogProduct | null> {
    const row = await this.prisma.catalogProduct.findUnique({
      where: { shopId_productId: { shopId, productId } },
    });
    return row ? this.toCatalogProduct(row) : null;
  }

  async listProducts(
    shopId: string,
    options: { limit?: number; page?: number; title?: string } = {},
  ): Promise<{ products: CatalogProduct[]; total: number }> {
    const limit = Math.min(250, Math.max(1, Number(options.limit) || 50));
    const page = Math.max(1, Number(options.page) || 1);
    const search = toText(options.title);

    const where: Prisma.CatalogProductWhereInput = {
      shopId,
      deletedAt: null,
    };

    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { handle: { contains: search, mode: 'insensitive' } },
        { productId: search },
      ];
    }

    const [products, total] = await Promise.all([
      this.prisma.catalogProduct.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.catalogProduct.count({ where }),
    ]);

    return {
      products: products.map((row) => this.toCatalogProduct(row)),
      total,
    };
  }

  async getAudit(shopId: string): Promise<{
    total: number;
    active: number;
    deleted: number;
    lastUpdated: number | null;
    sources: Record<string, number>;
    activeSources: Record<string, number>;
    deletedSources: Record<string, number>;
    sapoActive: number;
    nonSapoActive: number;
  }> {
    const [total, deleted, lastUpdatedAgg, sourceGroups, deletedGroups] = await Promise.all([
      this.prisma.catalogProduct.count({ where: { shopId } }),
      this.prisma.catalogProduct.count({ where: { shopId, deletedAt: { not: null } } }),
      this.prisma.catalogProduct.aggregate({ where: { shopId }, _max: { updatedAt: true } }),
      this.prisma.catalogProduct.groupBy({ by: ['source'], where: { shopId }, _count: true }),
      this.prisma.catalogProduct.groupBy({ by: ['source'], where: { shopId, deletedAt: { not: null } }, _count: true }),
    ]);

    const active = total - deleted;
    const lastUpdated =
      lastUpdatedAgg._max.updatedAt != null ? Number(lastUpdatedAgg._max.updatedAt) : null;

    const sources: Record<string, number> = {};
    const deletedSources: Record<string, number> = {};
    for (const g of sourceGroups) {
      sources[g.source || 'unknown'] = g._count;
    }
    for (const g of deletedGroups) {
      deletedSources[g.source || 'unknown'] = g._count;
    }

    const activeSources: Record<string, number> = {};
    for (const [srcKey, count] of Object.entries(sources)) {
      activeSources[srcKey] = count - (deletedSources[srcKey] || 0);
    }

    const sapoActive = activeSources.sapo || 0;

    return {
      total,
      active,
      deleted,
      lastUpdated,
      sources,
      activeSources,
      deletedSources,
      sapoActive,
      nonSapoActive: Math.max(0, active - sapoActive),
    };
  }

  // The deletedAt: null guard on the update keeps a concurrent webhook delete from being overwritten.
  async markMissingSapoProductsDeleted(
    shopId: string,
    activeProductIds: string[],
    deletedAt = Date.now(),
  ): Promise<number> {
    if (!activeProductIds.length) return 0;

    const active = new Set(activeProductIds);
    const ts = BigInt(deletedAt);
    let cursor = '';
    let marked = 0;
    for (;;) {
      const rows = await this.prisma.catalogProduct.findMany({
        where: { shopId, source: 'sapo', deletedAt: null, ...(cursor ? { id: { gt: cursor } } : {}) },
        orderBy: { id: 'asc' },
        take: STALE_SCAN_CHUNK,
        select: { id: true, productId: true },
      });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1].id;
      const missing = rows.filter((row) => !active.has(row.productId)).map((row) => row.id);
      if (missing.length > 0) {
        const result = await this.prisma.catalogProduct.updateMany({
          where: { id: { in: missing }, deletedAt: null },
          data: { deletedAt: ts, updatedAt: ts },
        });
        marked += result.count;
      }
      if (rows.length < STALE_SCAN_CHUNK) break;
    }
    return marked;
  }

  private toCatalogProduct(
    row: Awaited<
      ReturnType<PrismaService['catalogProduct']['findUnique']>
    >,
  ): CatalogProduct {
    if (!row) {
      return {
        id: '',
        productId: '',
        title: 'Không rõ sản phẩm',
        handle: '',
        updatedAt: 0,
      };
    }
    const image = row.image || undefined;
    return {
      id: row.productId,
      productId: row.productId,
      title: row.title || 'Không rõ sản phẩm',
      handle: row.handle || '',
      ...(image ? { image: { src: image }, productImage: image } : {}),
      ...(row.vendor ? { vendor: row.vendor } : {}),
      ...(row.productType ? { productType: row.productType } : {}),
      ...(row.tags ? { tags: row.tags } : {}),
      ...(row.status ? { status: row.status } : {}),
      ...(row.deletedAt ? { deletedAt: Number(row.deletedAt) } : {}),
      source: row.source,
      updatedAt: Number(row.updatedAt),
    };
  }
}
