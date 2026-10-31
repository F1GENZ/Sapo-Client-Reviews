import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, createHmac, hkdfSync } from 'crypto';
import { APP_ENV } from '../config/app-config.module';
import type { AppEnv } from '../config/env.schema';
import { assertEncryptionKey } from '../config/secret-guard';
import { PrismaService } from '../database/prisma.service';

export type CustomerPurchaseIdentity = {
  email?: string | null;
  phone?: string | null;
};

export type CustomerPurchaseOrderInput = {
  shopId: string;
  order: Record<string, unknown>;
};

type PurchaseRowInput = {
  shopId: string;
  productId: string;
  orderId: string;
  orderCode: string | null;
  emailHash: string | null;
  phoneHash: string | null;
  hashVersion: number;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  cancelledAt: bigint | null;
  refundedAt: bigint | null;
  purchasedAt: bigint;
  sourceUpdatedAt: bigint | null;
  rawPayload: Prisma.InputJsonObject;
};

type ParsedOrder = {
  shopId: string;
  orderId: string;
  sourceUpdatedAt: bigint | null;
  productIds: string[];
  rows: PurchaseRowInput[];
};

type PurchaseStatusRow = {
  financialStatus?: string | null;
  fulfillmentStatus?: string | null;
  cancelledAt?: bigint | null;
  refundedAt?: bigint | null;
};

const IDENTITY_HASH_VERSION = 2;
const IDENTITY_KEY_LABEL = 'purchase-identity-v1';
const HASH_HEX = /^[a-f0-9]{64}$/;

const ORDER_TIMESTAMP_FIELDS = {
  created: ['created_at', 'created_on', 'createdAt'],
  processed: ['processed_at', 'processed_on'],
  updated: ['modified_on', 'updated_at', 'updated_on', 'updatedAt'],
  cancelled: ['cancelled_at', 'cancelled_on'],
  closed: ['closed_at', 'closed_on'],
  refunded: ['refunded_at', 'refunded_on'],
} as const;

const ELIGIBLE_FINANCIAL_STATUSES = new Set(['paid', 'partially_paid']);
const ELIGIBLE_FULFILLMENT_STATUSES = new Set(['fulfilled', 'partial']);
const BLOCKED_FINANCIAL_STATUSES = new Set([
  'voided',
  'refunded',
  'partially_refunded',
  'cancelled',
  'canceled',
]);
const BLOCKED_FULFILLMENT_STATUSES = new Set(['cancelled', 'canceled']);

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

const toObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const toArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const scalar = (value: unknown): string | number | null => {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
};

const pick = (source: Record<string, unknown>, names: readonly string[]): unknown => {
  for (const name of names) {
    const value = source[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
};

const parseTimestamp = (value: unknown): bigint | null => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return BigInt(Math.trunc(value > 10_000_000_000 ? value : value * 1000));
  }
  const text = toText(value);
  if (!text) return null;
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 0) {
    return BigInt(Math.trunc(numeric > 10_000_000_000 ? numeric : numeric * 1000));
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? BigInt(parsed) : null;
};

const normalizeEmail = (value: unknown): string => toText(value).toLowerCase();

export const normalizePhone = (value: unknown): string => {
  const phone = toText(value).replace(/[\s\-().]/g, '');
  if (!phone) return '';
  if (phone.startsWith('+84')) return `0${phone.slice(3)}`;
  if (phone.startsWith('84')) return `0${phone.slice(2)}`;
  return phone;
};

const legacyHash = (value: string): string => createHash('sha256').update(value).digest('hex');

const normalizeStatus = (value: unknown): string =>
  toText(value).toLowerCase().replace(/[\s-]+/g, '_');

const hasTimestamp = (value: unknown): boolean => {
  if (typeof value === 'bigint') return value > 0n;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0;
  return !!toText(value);
};

const nullIfEmpty = (value: string): string | null =>
  value ? value : null;

const projectedHash = (source: Record<string, unknown>, field: string): string | null => {
  if (source.hash_version !== IDENTITY_HASH_VERSION) return null;
  const value = source[field];
  return typeof value === 'string' && HASH_HEX.test(value) ? value : null;
};

export function isEligiblePurchaseStatus(row: PurchaseStatusRow): boolean {
  if (hasTimestamp(row.cancelledAt) || hasTimestamp(row.refundedAt)) {
    return false;
  }

  const financialStatus = normalizeStatus(row.financialStatus);
  const fulfillmentStatus = normalizeStatus(row.fulfillmentStatus);

  if (
    BLOCKED_FINANCIAL_STATUSES.has(financialStatus) ||
    BLOCKED_FULFILLMENT_STATUSES.has(fulfillmentStatus)
  ) {
    return false;
  }

  return (
    ELIGIBLE_FINANCIAL_STATUSES.has(financialStatus) ||
    ELIGIBLE_FULFILLMENT_STATUSES.has(fulfillmentStatus)
  );
}

@Injectable()
export class PurchaseStoreService {
  private readonly logger = new Logger(PurchaseStoreService.name);
  private readonly identityKey: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_ENV) env: AppEnv,
  ) {
    this.identityKey = Buffer.from(
      hkdfSync('sha256', assertEncryptionKey(env.DATA_ENCRYPTION_KEY), Buffer.alloc(0), IDENTITY_KEY_LABEL, 32),
    );
  }

  private hashIdentity(kind: 'email' | 'phone', value: string): string {
    return createHmac('sha256', this.identityKey).update(`${kind}:${value}`).digest('hex');
  }

  async hasPurchasedProduct(
    shopId: string,
    productId: string,
    identity: CustomerPurchaseIdentity,
  ): Promise<boolean> {
    const email = normalizeEmail(identity.email);
    const phone = normalizePhone(identity.phone);
    const matchers: Prisma.CustomerPurchaseWhereInput[] = [];
    if (email) matchers.push({ emailHash: { in: [this.hashIdentity('email', email), legacyHash(email)] } });
    if (phone) matchers.push({ phoneHash: { in: [this.hashIdentity('phone', phone), legacyHash(phone)] } });
    if (!matchers.length) return false;

    const rows = await this.prisma.customerPurchase.findMany({
      where: { shopId, productId, OR: matchers },
      select: {
        financialStatus: true,
        fulfillmentStatus: true,
        cancelledAt: true,
        refundedAt: true,
      },
      take: 50,
    });

    return rows.some((row: PurchaseStatusRow) => isEligiblePurchaseStatus(row));
  }

  async syncOrder(input: CustomerPurchaseOrderInput): Promise<number> {
    const parsed = this.parseOrder(input.shopId, input.order);
    if (!parsed) return 0;
    const applied = await this.applyOrder(parsed);
    return applied ? parsed.rows.length : 0;
  }

  async getAudit(shopId: string): Promise<{
    total: number;
    orders: number;
    lastUpdated: number | null;
  }> {
    const [totalResult, orderCountRows, lastRow] = await Promise.all([
      this.prisma.customerPurchase.count({ where: { shopId } }),
      this.prisma.$queryRaw<Array<{ orders: bigint }>>`
        SELECT COUNT(DISTINCT "order_id") AS orders
        FROM "customer_purchases"
        WHERE "shop_id" = ${shopId}
      `,
      this.prisma.customerPurchase.findFirst({
        where: { shopId },
        select: { updatedAt: true },
        orderBy: { updatedAt: 'desc' },
      }),
    ]);

    return {
      total: totalResult,
      orders: Number(orderCountRows[0]?.orders ?? 0),
      lastUpdated: lastRow?.updatedAt ? Number(lastRow.updatedAt) : null,
    };
  }

  normalizeOrder(shopId: string, order: Record<string, unknown>): PurchaseRowInput[] {
    return this.parseOrder(shopId, order)?.rows ?? [];
  }

  toStoredOrder(order: Record<string, unknown>): Prisma.InputJsonObject {
    const source = toObject(order.order) || order;
    const { emailHash, phoneHash } = this.orderIdentityHashes(source);
    const projected: Record<string, Prisma.InputJsonValue | null> = {
      id: nullIfEmpty(toText(source.id || source.order_id || source.orderId)),
      order_number: scalar(source.order_number),
      name: scalar(source.name),
      financial_status: scalar(source.financial_status ?? source.financialStatus),
      fulfillment_status: scalar(source.fulfillment_status ?? source.fulfillmentStatus),
    };
    for (const names of Object.values(ORDER_TIMESTAMP_FIELDS)) {
      for (const name of names) {
        const value = scalar(source[name]);
        if (value !== null) projected[name === 'createdAt' ? 'created_at' : name === 'updatedAt' ? 'updated_at' : name] = value;
      }
    }
    projected.line_items = this.orderProductIds(source).map((productId) => ({ product_id: productId }));
    projected.email_hash = emailHash;
    projected.phone_hash = phoneHash;
    projected.hash_version = IDENTITY_HASH_VERSION;
    return projected;
  }

  private orderIdentityHashes(source: Record<string, unknown>): { emailHash: string | null; phoneHash: string | null } {
    const email =
      normalizeEmail(source.email) ||
      normalizeEmail(toObject(source.customer)?.email) ||
      normalizeEmail(toObject(source.billing_address)?.email);
    const phone =
      normalizePhone(source.phone) ||
      normalizePhone(toObject(source.customer)?.phone) ||
      normalizePhone(toObject(source.billing_address)?.phone) ||
      normalizePhone(toObject(source.shipping_address)?.phone);
    return {
      emailHash: projectedHash(source, 'email_hash') ?? (email ? this.hashIdentity('email', email) : null),
      phoneHash: projectedHash(source, 'phone_hash') ?? (phone ? this.hashIdentity('phone', phone) : null),
    };
  }

  private orderProductIds(source: Record<string, unknown>): string[] {
    return toArray(source.line_items || source.lineItems)
      .map((item) => toObject(item))
      .filter((item): item is Record<string, unknown> => !!item)
      .map((item) => toText(item.product_id || item.productId))
      .filter(Boolean)
      .filter((productId, index, list) => list.indexOf(productId) === index);
  }

  private parseOrder(shopId: string, order: Record<string, unknown>): ParsedOrder | null {
    const source = toObject(order.order) || order;
    const orderId = toText(source.id || source.order_id || source.orderId);
    if (!shopId || !orderId) return null;

    const { emailHash, phoneHash } = this.orderIdentityHashes(source);
    if (!emailHash && !phoneHash) return null;

    const purchasedAt =
      parseTimestamp(pick(source, ORDER_TIMESTAMP_FIELDS.created)) ??
      parseTimestamp(pick(source, ORDER_TIMESTAMP_FIELDS.processed)) ??
      BigInt(Date.now());
    const cancelledRaw = pick(source, ORDER_TIMESTAMP_FIELDS.cancelled);
    const refundedRaw = pick(source, ORDER_TIMESTAMP_FIELDS.refunded);
    const updatedRaw = pick(source, ORDER_TIMESTAMP_FIELDS.updated);
    const closedRaw = pick(source, ORDER_TIMESTAMP_FIELDS.closed);
    const cancelledAt = cancelledRaw === undefined ? null : parseTimestamp(cancelledRaw) ?? purchasedAt;
    const refundedAt = refundedRaw === undefined ? null : parseTimestamp(refundedRaw) ?? purchasedAt;
    const sourceUpdatedAt = updatedRaw === undefined ? null : parseTimestamp(updatedRaw);
    const financialStatus = normalizeStatus(source.financial_status || source.financialStatus);
    const fulfillmentStatus = normalizeStatus(source.fulfillment_status || source.fulfillmentStatus);
    const orderCode =
      toText(source.order_number) ||
      toText(source.name) ||
      toText(source.order_code) ||
      null;
    const rawPayload: Prisma.InputJsonObject = {
      id: orderId,
      order_number: scalar(source.order_number),
      name: scalar(source.name),
      financial_status: scalar(source.financial_status ?? source.financialStatus),
      fulfillment_status: scalar(source.fulfillment_status ?? source.fulfillmentStatus),
      created_at: scalar(pick(source, ORDER_TIMESTAMP_FIELDS.created)),
      updated_at: scalar(updatedRaw),
      closed_at: scalar(closedRaw),
      cancelled_at: scalar(cancelledRaw),
      refunded_at: scalar(refundedRaw),
    };

    const productIds = this.orderProductIds(source);
    return {
      shopId,
      orderId,
      sourceUpdatedAt,
      productIds,
      rows: productIds.map((productId) => ({
        shopId,
        productId,
        orderId,
        orderCode,
        emailHash,
        phoneHash,
        hashVersion: IDENTITY_HASH_VERSION,
        financialStatus: nullIfEmpty(financialStatus),
        fulfillmentStatus: nullIfEmpty(fulfillmentStatus),
        cancelledAt,
        refundedAt,
        purchasedAt,
        sourceUpdatedAt,
        rawPayload,
      })),
    };
  }

  private async applyOrder(parsed: ParsedOrder): Promise<boolean> {
    const { shopId, orderId } = parsed;
    const lockKey = `${shopId}:${orderId}`;
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
        if (parsed.sourceUpdatedAt !== null) {
          const stored = await tx.customerPurchase.aggregate({
            where: { shopId, orderId },
            _max: { sourceUpdatedAt: true },
          });
          const storedAt = stored._max.sourceUpdatedAt;
          if (storedAt !== null && parsed.sourceUpdatedAt < storedAt) return false;
        }
        await tx.customerPurchase.deleteMany({
          where: { shopId, orderId, productId: { notIn: parsed.productIds } },
        });
        for (const row of parsed.rows) {
          await tx.customerPurchase.upsert({
            where: {
              shopId_productId_orderId: {
                shopId: row.shopId,
                productId: row.productId,
                orderId: row.orderId,
              },
            },
            create: {
              shopId: row.shopId,
              productId: row.productId,
              orderId: row.orderId,
              orderCode: row.orderCode,
              emailHash: row.emailHash,
              phoneHash: row.phoneHash,
              hashVersion: row.hashVersion,
              financialStatus: row.financialStatus,
              fulfillmentStatus: row.fulfillmentStatus,
              cancelledAt: row.cancelledAt,
              refundedAt: row.refundedAt,
              purchasedAt: row.purchasedAt,
              sourceUpdatedAt: row.sourceUpdatedAt,
              rawPayload: row.rawPayload,
              createdAt: new Date(),
              updatedAt: BigInt(Date.now()),
            },
            update: {
              orderCode: row.orderCode,
              emailHash: row.emailHash,
              phoneHash: row.phoneHash,
              hashVersion: row.hashVersion,
              financialStatus: row.financialStatus,
              fulfillmentStatus: row.fulfillmentStatus,
              cancelledAt: row.cancelledAt,
              refundedAt: row.refundedAt,
              purchasedAt: row.purchasedAt,
              ...(row.sourceUpdatedAt === null ? {} : { sourceUpdatedAt: row.sourceUpdatedAt }),
              rawPayload: row.rawPayload,
              updatedAt: BigInt(Date.now()),
            },
          });
        }
        return true;
      });
    } catch (error) {
      this.logger.warn(
        `Customer purchase sync failed: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
      );
      throw error;
    }
  }
}
