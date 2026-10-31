import { Logger } from '@nestjs/common';
import type { PrismaService } from '../database/prisma.service';

const logger = new Logger('ProductLabel');

export interface ProductLabelInput {
  productTitle?: string | null;
  productName?: string | null;
  productHandle?: string | null;
  productImage?: string | null;
}

export interface ProductLabel {
  productTitle: string | null;
  productName: string | null;
  productHandle: string | null;
  productImage: string | null;
}

export interface CatalogLabel {
  title: string;
  handle: string;
  image: string | null;
}

export async function resolveProductLabel(
  prisma: PrismaService,
  shopId: string,
  productId: string,
  input: ProductLabelInput,
): Promise<ProductLabel> {
  const complete = input.productTitle && input.productHandle && input.productImage;
  const row = complete
    ? null
    : await prisma.catalogProduct
        .findUnique({
          where: { shopId_productId: { shopId, productId } },
          select: { title: true, handle: true, image: true },
        })
        .catch((error: unknown) => {
          logger.warn(`Catalog label lookup failed for ${shopId}/${productId}: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        });

  const title = input.productTitle || row?.title || null;
  return {
    productTitle: title,
    productName: input.productName || title,
    productHandle: input.productHandle || row?.handle || null,
    productImage: input.productImage || row?.image || null,
  };
}

export function labelUpdateFields(label: ProductLabel): Partial<ProductLabel> {
  const fields: Partial<ProductLabel> = {};
  if (label.productTitle) fields.productTitle = label.productTitle;
  if (label.productName) fields.productName = label.productName;
  if (label.productHandle) fields.productHandle = label.productHandle;
  if (label.productImage) fields.productImage = label.productImage;
  return fields;
}

export async function catalogLabels(
  prisma: PrismaService,
  shopId: string,
  productIds: string[],
): Promise<Map<string, CatalogLabel>> {
  const ids = Array.from(new Set(productIds.filter(Boolean)));
  if (!ids.length) return new Map();
  const rows = await prisma.catalogProduct
    .findMany({
      where: { shopId, productId: { in: ids } },
      select: { productId: true, title: true, handle: true, image: true },
    })
    .catch((error: unknown) => {
      logger.warn(`Catalog label batch lookup failed for ${shopId}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    });
  return new Map<string, CatalogLabel>(
    rows
      .filter((row) => row.title)
      .map((row): [string, CatalogLabel] => [row.productId, { title: row.title, handle: row.handle, image: row.image }]),
  );
}

export async function catalogTitles(
  prisma: PrismaService,
  shopId: string,
  productIds: string[],
): Promise<Map<string, string>> {
  const labels = await catalogLabels(prisma, shopId, productIds);
  return new Map<string, string>(Array.from(labels, ([productId, label]): [string, string] => [productId, label.title]));
}
