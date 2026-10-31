import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { CatalogSyncService } from '../catalog/catalog-sync.service';
import { STORE_DOMAIN_RE } from '../common/security/public-limits';
import { PrismaService } from '../database/prisma.service';
import { PurchaseStoreService } from '../purchase/purchase-store.service';
import { HmacVerifierService } from './hmac-verifier.service';
import { SapoService } from './sapo.service';
import { normalizeShopDomain, ShopDomainService } from './shop-domain.service';
import { UninstallService } from './uninstall.service';
import { normalizeWebhookTopic } from './webhook-topic-normalizer';

export type RawBodyRequest = {
  headers: Record<string, unknown>;
  query: Record<string, unknown>;
  body: unknown;
  rawBody?: Buffer;
};

type WebhookIdentity = { storeDomain: string | null; domain: string | null };

const SENSITIVE_HEADER_REGEX = /^(authorization|cookie|set-cookie|x-forwarded-|cf-access-|cf-connecting-ip|x-real-ip)/i;

const asString = (value: unknown): string | null => {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0].trim()) return value[0].trim();
  return null;
};

export const asEntityId = (value: unknown): string | null => {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  const text = asString(value);
  return text && /^[1-9]\d{0,19}$/.test(text) ? text : null;
};

const getHeader = (headers: Record<string, unknown>, names: string[]): string | undefined => {
  const normalized = new Map(Object.entries(headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
  for (const name of names) {
    const value = normalized.get(name.toLowerCase());
    const text = asString(value);
    if (text) return text;
  }
  return undefined;
};

const payloadHash = (payload: unknown): string =>
  createHash('sha256').update(JSON.stringify(payload || {})).digest('hex');

const redactHeaders = (headers: Record<string, unknown>): Prisma.InputJsonObject =>
  Object.fromEntries(
    Object.entries(headers || {}).filter(([key]) => !SENSITIVE_HEADER_REGEX.test(key)),
  ) as Prisma.InputJsonObject;

const isLifecycleTopic = (topic: string): boolean => topic.startsWith('app/') || topic.startsWith('store/');

const STALLED_PROCESSING_MS = 10 * 60_000;
const STALLED_ERROR = 'Worker stalled before the event reached a terminal state';
const PAYLOAD_PURGED_ERROR = 'payload purged';
const RETRY_BACKOFF_BASE_MS = 120_000;
const RETRY_BACKOFF_CAP_MS = 60 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 8;
const SWEEP_PAGE = 50;
const SWEEP_MAX_EVENTS = 200;

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hmacVerifier: HmacVerifierService,
    private readonly shopDomains: ShopDomainService,
    private readonly uninstallService: UninstallService,
    private readonly sapo: SapoService,
    private readonly catalogSync: CatalogSyncService,
    private readonly purchases: PurchaseStoreService,
  ) {}

  private getPayload(body: unknown): Record<string, unknown> {
    return body && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
  }

  private orderBody(payload: Record<string, unknown>): Record<string, unknown> {
    const nested = this.getPayload(payload.order);
    return Object.keys(nested).length ? nested : payload;
  }

  private compatibilityStoreDomain(input: RawBodyRequest): string | null {
    return (
      getHeader(input.headers, ['x-sapo-store-domain', 'x-sapo-store']) ||
      asString(input.query.storeDomain) ||
      asString(input.query.store_domain)
    );
  }

  private payloadStoreDomain(payload: Record<string, unknown>): string | null {
    return (
      asString(payload.storeDomain) ||
      asString(payload.store_domain)
    );
  }

  private async storeDomainFromDomains(input: RawBodyRequest, payload: Record<string, unknown>): Promise<WebhookIdentity> {
    const domains = this.shopDomains.collectDomains(
      payload,
      { shop: input.query.shop, shop_domain: input.query.shop_domain },
      {
        shop_domain: getHeader(input.headers, [
          'x-sapo-shop-domain',
          'x-shop-domain',
          'x-sapo-shop',
          'x-shop',
          'x-sapo-domain',
        ]),
      },
    );
    for (const domain of domains) {
      const storeDomain = await this.shopDomains.resolveStoreDomain(domain);
      if (storeDomain) return { storeDomain, domain };
    }
    return { storeDomain: null, domain: domains[0] || null };
  }

  private async resolveIdentity(input: RawBodyRequest, payload: Record<string, unknown>, topic: string): Promise<WebhookIdentity> {
    const payloadStoreDomain = this.payloadStoreDomain(payload);
    const compatibilityStoreDomain = this.compatibilityStoreDomain(input);
    const domainIdentity = await this.storeDomainFromDomains(input, payload);

    if (payloadStoreDomain && domainIdentity.domain && !domainIdentity.storeDomain && topic !== 'app/uninstalled') {
      throw new BadRequestException('Webhook domain is not mapped to an active install');
    }
    if (payloadStoreDomain && domainIdentity.storeDomain && payloadStoreDomain !== domainIdentity.storeDomain) {
      throw new BadRequestException('Webhook payload/domain storeDomain mismatch');
    }

    const resolvedStoreDomain = domainIdentity.storeDomain || payloadStoreDomain;
    if (compatibilityStoreDomain && resolvedStoreDomain && compatibilityStoreDomain !== resolvedStoreDomain) {
      throw new BadRequestException('Webhook compatibility storeDomain mismatch');
    }

    return { storeDomain: resolvedStoreDomain, domain: domainIdentity.domain };
  }

  // Safety: the HMAC covers the body only, so the store in an unsigned header is a claim; an id known only under another store is rejected.
  private async assertEntityBelongsToStore(topic: string, shopId: string, payload: Record<string, unknown>): Promise<void> {
    if (topic === 'products/delete') {
      const productId = asEntityId(payload.id) || asEntityId(payload.product_id) || asEntityId(payload.productId);
      if (!productId) return;
      const [own, other] = await Promise.all([
        this.prisma.catalogProduct.findFirst({ where: { shopId, productId }, select: { id: true } }),
        this.prisma.catalogProduct.findFirst({ where: { productId, shopId: { not: shopId }, deletedAt: null }, select: { id: true } }),
      ]);
      if (!own && other) throw new BadRequestException('Webhook product belongs to another store');
      return;
    }
    if (topic.startsWith('orders/')) {
      const order = this.orderBody(payload);
      const orderId = asEntityId(order.id) || asEntityId(order.order_id) || asEntityId(order.orderId);
      if (!orderId) return;
      const [own, other] = await Promise.all([
        this.prisma.customerPurchase.findFirst({ where: { shopId, orderId }, select: { id: true } }),
        this.prisma.customerPurchase.findFirst({ where: { orderId, shopId: { not: shopId } }, select: { id: true } }),
      ]);
      if (!own && other) throw new BadRequestException('Webhook order belongs to another store');
    }
  }

  private buildIdempotencyKey(input: {
    providerEventId?: string;
    topic: string;
    storeDomain?: string | null;
    domain?: string | null;
    hash: string;
    lifecycleGeneration: number | null;
  }): string {
    const identity = input.storeDomain ? `store:${input.storeDomain}` : `domain:${normalizeShopDomain(input.domain || '')}`;
    const scope = input.lifecycleGeneration === null ? identity : `${identity}:gen:${input.lifecycleGeneration}`;
    if (input.providerEventId) return `provider:${input.topic}:${scope}:${input.providerEventId}`;
    return createHash('sha256').update(`${input.topic}:${scope}:${input.hash}`).digest('hex');
  }

  async handle(input: RawBodyRequest): Promise<Record<string, unknown>> {
    const signature = getHeader(input.headers, ['x-sapo-hmac-sha256']);
    this.hmacVerifier.verifyWebhookBody(input.rawBody || Buffer.alloc(0), signature);

    const rawTopic = getHeader(input.headers, ['x-sapo-topic', 'x-sapo-webhook-topic']);
    const normalizedTopic = normalizeWebhookTopic(rawTopic);
    const payload = this.getPayload(input.body);
    const identity = await this.resolveIdentity(input, payload, normalizedTopic);

    if (!identity.storeDomain && normalizedTopic !== 'app/uninstalled') {
      throw new BadRequestException('Missing webhook storeDomain');
    }

    const install = identity.storeDomain
      ? await this.prisma.appInstall.findUnique({
          where: { storeDomain: identity.storeDomain },
          select: { shopId: true, status: true, lifecycleGeneration: true },
        })
      : null;
    if (install?.shopId && install.status !== 'uninstalled') {
      await this.assertEntityBelongsToStore(normalizedTopic, install.shopId, payload);
    }

    const hash = payloadHash(payload);
    const lifecycleGeneration = isLifecycleTopic(normalizedTopic) ? install?.lifecycleGeneration ?? 0 : null;
    const providerEventId = getHeader(input.headers, ['x-sapo-event-id']);
    const idempotencyKey = this.buildIdempotencyKey({
      providerEventId,
      topic: normalizedTopic,
      storeDomain: identity.storeDomain,
      domain: identity.domain,
      hash,
      lifecycleGeneration,
    });
    const storedPayload = normalizedTopic.startsWith('orders/')
      ? this.purchases.toStoredOrder(payload)
      : (payload as Prisma.InputJsonObject);

    let event: { id: string } | null = null;
    let claimed = false;
    try {
      event = await this.prisma.webhookEvent.create({
        data: {
          providerEventId,
          idempotencyKey,
          topic: rawTopic || 'unknown',
          normalizedTopic,
          resolvedStoreDomain: identity.storeDomain,
          resolvedDomain: identity.domain,
          lifecycleGeneration,
          payloadHash: hash,
          payload: storedPayload,
          headers: redactHeaders(input.headers),
          status: 'received',
        },
        select: { id: true, status: true },
      });
    } catch (error) {
      const existing = await this.prisma.webhookEvent.findUnique({
        where: { idempotencyKey },
        select: { id: true, status: true, nextRetryAt: true, updatedAt: true },
      }).catch(() => null);
      if (!existing) throw error;
      const outcome = await this.claimExisting(existing);
      if (outcome !== 'claimed') {
        return { ok: true, [outcome]: true, eventId: existing.id, topic: normalizedTopic };
      }
      event = { id: String(existing.id) };
      claimed = true;
    }

    if (!event) throw new Error('Webhook event was not created');

    if (!claimed) {
      await this.prisma.webhookEvent.update({
        where: { id: event.id },
        data: { status: 'processing', attempts: { increment: 1 } },
      });
    }
    return this.runEvent(event.id, normalizedTopic, identity, payload);
  }

  private async claimExisting(existing: {
    id: string;
    status: string;
    nextRetryAt?: Date | null;
    updatedAt?: Date | null;
  }): Promise<'claimed' | 'inProgress' | 'duplicate' | 'deferred'> {
    const status = String(existing.status);
    const now = new Date();
    if (status === 'failed') {
      if (existing.nextRetryAt && existing.nextRetryAt.getTime() > now.getTime()) return 'deferred';
      const result = await this.prisma.webhookEvent.updateMany({
        where: {
          id: existing.id,
          status: 'failed',
          OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
        },
        data: { status: 'processing', lastError: null, nextRetryAt: null, attempts: { increment: 1 } },
      });
      return result.count > 0 ? 'claimed' : 'inProgress';
    }
    if (status === 'received' || status === 'processing') {
      const updatedAt = existing.updatedAt instanceof Date ? existing.updatedAt : null;
      if (!updatedAt || now.getTime() - updatedAt.getTime() < STALLED_PROCESSING_MS) return 'inProgress';
      const result = await this.prisma.webhookEvent.updateMany({
        where: { id: existing.id, status: { in: ['received', 'processing'] }, updatedAt },
        data: { status: 'processing', lastError: null, attempts: { increment: 1 } },
      });
      return result.count > 0 ? 'claimed' : 'inProgress';
    }
    return 'duplicate';
  }

  private async runEvent(
    eventId: string,
    normalizedTopic: string,
    identity: WebhookIdentity,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    try {
      const result = await this.dispatch(normalizedTopic, identity, payload);
      await this.prisma.webhookEvent.update({
        where: { id: eventId },
        data: { status: result.ignored ? 'ignored' : 'processed', processedAt: new Date(), lastError: null, nextRetryAt: null },
      });
      return { ...result, eventId };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Webhook processing failed';
      await this.markFailed(eventId, message);
      throw error;
    }
  }

  private async dispatch(
    topic: string,
    identity: WebhookIdentity,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { storeDomain } = identity;
    if (!storeDomain) return { ok: true, ignored: true, topic };
    if (topic === 'app/uninstalled') return this.uninstallService.uninstall(storeDomain, payload);

    const storeScoped = topic === 'store/update' || topic.startsWith('products/') || topic.startsWith('orders/');
    if (!storeScoped) return { ok: true, ignored: true, topic };

    const install = await this.prisma.appInstall.findUnique({
      where: { storeDomain },
      select: { shopId: true, status: true },
    });
    if (install?.status === 'uninstalled') return { ok: true, ignored: true, topic, storeDomain, reason: 'store_uninstalled' };

    if (topic === 'store/update') {
      await this.mapStoreDomains(storeDomain, install?.shopId ?? null, payload);
      return { ok: true, topic, storeDomain };
    }
    if (topic.startsWith('products/')) {
      await this.syncCatalogProduct(topic, storeDomain, payload);
      return { ok: true, topic, storeDomain, queued: true };
    }
    await this.syncOrderPurchase(topic, storeDomain, install?.shopId ?? null, payload);
    return { ok: true, topic, storeDomain, queued: true };
  }

  // Safety: never re-point a domain that another store owns; only domains with no active owner are added.
  private async mapStoreDomains(storeDomain: string, shopId: string | null, payload: Record<string, unknown>): Promise<void> {
    for (const domain of this.shopDomains.collectDomains(payload)) {
      const owner = await this.shopDomains.resolveStoreDomain(domain);
      if (owner === storeDomain) {
        await this.shopDomains.saveMapping(storeDomain, domain);
        continue;
      }
      if (owner || !shopId || !STORE_DOMAIN_RE.test(domain)) continue;
      const id = `${storeDomain}:${domain}`;
      await this.prisma.shopDomain.upsert({
        where: { id },
        create: { id, shopId, storeDomain, domain, kind: 'custom', active: true },
        update: { active: true, tombstonedAt: null, shopId, storeDomain },
      });
      await this.shopDomains.saveMapping(storeDomain, domain);
    }
  }

  private async markFailed(eventId: string, message: string): Promise<void> {
    const row = await this.prisma.webhookEvent
      .findUnique({ where: { id: eventId }, select: { attempts: true, maxAttempts: true } })
      .catch(() => null);
    const attempts = Math.max(1, Number(row?.attempts) || 1);
    const maxAttempts = Number(row?.maxAttempts) || DEFAULT_MAX_ATTEMPTS;
    const exhausted = attempts >= maxAttempts;
    const delay = Math.min(RETRY_BACKOFF_CAP_MS, RETRY_BACKOFF_BASE_MS * 2 ** (attempts - 1));
    await this.prisma.webhookEvent.update({
      where: { id: eventId },
      data: {
        status: 'failed',
        lastError: message.slice(0, 500),
        nextRetryAt: exhausted ? null : new Date(Date.now() + delay),
      },
    });
  }

  async reclaimStalled(now = new Date()): Promise<{ reclaimed: number; failed: number }> {
    const cutoff = new Date(now.getTime() - STALLED_PROCESSING_MS);
    const totals = { reclaimed: 0, failed: 0 };
    let cursor = '';
    for (;;) {
      const rows = await this.prisma.webhookEvent.findMany({
        where: {
          status: { in: ['received', 'processing'] },
          updatedAt: { lt: cutoff },
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: 'asc' },
        take: SWEEP_PAGE,
        select: { id: true, updatedAt: true, attempts: true, maxAttempts: true },
      });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1].id;
      for (const row of rows) {
        try {
          const exhausted = row.attempts >= row.maxAttempts;
          const result = await this.prisma.webhookEvent.updateMany({
            where: { id: row.id, status: { in: ['received', 'processing'] }, updatedAt: row.updatedAt },
            data: {
              status: 'failed',
              lastError: STALLED_ERROR,
              nextRetryAt: exhausted ? null : now,
            },
          });
          if (result.count > 0) {
            totals.reclaimed += 1;
            if (exhausted) totals.failed += 1;
          }
        } catch (error) {
          this.logger.warn(`Stalled webhook reclaim failed for ${row.id}: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
      }
      if (rows.length < SWEEP_PAGE) break;
    }
    return totals;
  }

  async retryDueFailed(options: { maxEvents?: number; now?: Date } = {}): Promise<{ attempted: number; succeeded: number; failed: number }> {
    const now = options.now ?? new Date();
    const maxEvents = options.maxEvents ?? SWEEP_MAX_EVENTS;
    const totals = { attempted: 0, succeeded: 0, failed: 0 };
    let cursor = '';
    while (totals.attempted < maxEvents) {
      const rows = await this.prisma.webhookEvent.findMany({
        where: { status: 'failed', nextRetryAt: { lte: now }, ...(cursor ? { id: { gt: cursor } } : {}) },
        orderBy: { id: 'asc' },
        take: SWEEP_PAGE,
      });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1].id;
      for (const row of rows) {
        if (totals.attempted >= maxEvents) break;
        if (row.attempts >= row.maxAttempts) continue;
        try {
          if (row.payload === null || row.payload === undefined) {
            await this.prisma.webhookEvent.updateMany({
              where: { id: row.id, status: 'failed', nextRetryAt: row.nextRetryAt },
              data: { lastError: PAYLOAD_PURGED_ERROR, nextRetryAt: null },
            });
            continue;
          }
          if (await this.predatesCurrentInstall(row)) {
            await this.prisma.webhookEvent.updateMany({
              where: { id: row.id, status: 'failed', nextRetryAt: row.nextRetryAt },
              data: { status: 'ignored', processedAt: now, lastError: null, nextRetryAt: null },
            });
            continue;
          }
          const claim = await this.prisma.webhookEvent.updateMany({
            where: { id: row.id, status: 'failed', nextRetryAt: row.nextRetryAt },
            data: { status: 'processing', lastError: null, nextRetryAt: null, attempts: { increment: 1 } },
          });
          if (claim.count === 0) continue;
          totals.attempted += 1;
          await this.runEvent(
            row.id,
            row.normalizedTopic,
            { storeDomain: row.resolvedStoreDomain, domain: row.resolvedDomain },
            this.getPayload(row.payload),
          );
          totals.succeeded += 1;
        } catch (error) {
          totals.failed += 1;
          this.logger.warn(`Webhook retry failed for ${row.id}: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
      }
      if (rows.length < SWEEP_PAGE) break;
    }
    return totals;
  }

  private async predatesCurrentInstall(row: {
    normalizedTopic: string;
    resolvedStoreDomain: string | null;
    receivedAt: Date;
    lifecycleGeneration: number | null;
  }): Promise<boolean> {
    if (!isLifecycleTopic(row.normalizedTopic) || !row.resolvedStoreDomain) return false;
    const install = await this.prisma.appInstall.findUnique({
      where: { storeDomain: row.resolvedStoreDomain },
      select: { installedAt: true, lifecycleGeneration: true },
    });
    if (!install) return false;
    if (row.lifecycleGeneration !== null && row.lifecycleGeneration < install.lifecycleGeneration) return true;
    return !!install.installedAt && row.receivedAt.getTime() < install.installedAt.getTime();
  }

  private async syncCatalogProduct(topic: string, storeDomain: string, payload: Record<string, unknown>): Promise<void> {
    const productId = asEntityId(payload.id) || asEntityId(payload.product_id) || asEntityId(payload.productId);
    if (!productId) {
      this.logger.warn(`Catalog sync skipped: no product id in ${topic} payload for ${storeDomain}`);
      return;
    }
    const accessToken = await this.sapo.resolveAccessToken(storeDomain);
    await this.catalogSync.handleProductWebhookWithToken(storeDomain, productId, topic, accessToken);
  }

  private async syncOrderPurchase(topic: string, storeDomain: string, shopId: string | null, payload: Record<string, unknown>): Promise<void> {
    const order = this.orderBody(payload);
    if (!asEntityId(order.id) && !asEntityId(order.order_id) && !asEntityId(order.orderId)) {
      this.logger.warn(`Order sync skipped: no order id in ${topic} payload for ${storeDomain}`);
      return;
    }
    if (!shopId) {
      this.logger.warn(`Order sync skipped: no install for ${storeDomain}`);
      return;
    }
    await this.purchases.syncOrder({ shopId, order: payload });
  }
}
