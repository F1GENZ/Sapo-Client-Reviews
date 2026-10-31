import { Inject, Injectable, Logger } from '@nestjs/common';
import { BadGatewayException, BadRequestException, UnauthorizedException } from '@nestjs/common/exceptions';
import { APP_ENV } from '../config/app-config.module';
import type { AppEnv } from '../config/env.schema';
import type {
  GetProductsCountParams,
  GetProductsParams,
  OAuthTokenPayload,
  SapoListResponse,
  SapoMetafield,
  SapoMetafieldCreatePayload,
  SapoMetafieldUpdatePayload,
  SapoProduct,
  SapoShop,
  SapoWebhook,
} from './sapo.types';
import { normalizeMetafieldPayload } from './sapo.types';

const NUMERIC_ID_REGEX = /^\d{1,20}$/;
const METAFIELD_PAGE_LIMIT = 250;
const METAFIELD_MAX_PAGES = 20;
const DEFAULT_RETRY_AFTER_SECONDS = 2;
const MAX_RETRIES = 5;

const parseRetryAfterHeader = (headers: Headers): number => {
  const value = headers.get('retry-after');
  if (!value) return DEFAULT_RETRY_AFTER_SECONDS;
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : DEFAULT_RETRY_AFTER_SECONDS;
};

const CALL_LIMIT_HEADROOM = 4;
const CALL_LIMIT_LEAK_PER_SECOND = 2;

export const callLimitPauseMs = (headers: Headers): number => {
  const match = /^(\d+)\/(\d+)$/.exec((headers.get('x-sapo-api-call-limit') || '').trim());
  if (!match) return 0;
  const excess = Number(match[1]) - (Number(match[2]) - CALL_LIMIT_HEADROOM);
  return excess > 0 ? Math.ceil(excess / CALL_LIMIT_LEAK_PER_SECOND) * 1000 : 0;
};

const assertNumericId = (value: string, label: string): void => {
  if (!NUMERIC_ID_REGEX.test(value)) {
    throw new BadRequestException(`Invalid ${label}: must be numeric`);
  }
};

interface PerStoreLimiter {
  inflight: number;
  waitQueue: Array<() => void>;
  cooldownUntil: number;
}

const sameWebhookAddress = (a: string, b: string): boolean =>
  a.trim().replace(/\/+$/, '').toLowerCase() === b.trim().replace(/\/+$/, '').toLowerCase();

@Injectable()
export class SapoApiService {
  private readonly logger = new Logger(SapoApiService.name);
  private readonly limiters = new Map<string, PerStoreLimiter>();

  constructor(@Inject(APP_ENV) private readonly env: AppEnv) {}

  private limiterFor(storeDomain: string): PerStoreLimiter {
    let limiter = this.limiters.get(storeDomain);
    if (!limiter) {
      limiter = { inflight: 0, waitQueue: [], cooldownUntil: 0 };
      this.limiters.set(storeDomain, limiter);
    }
    return limiter;
  }

  private acquireSlot(storeDomain: string): Promise<void> {
    const limiter = this.limiterFor(storeDomain);
    if (limiter.inflight < this.env.SAPO_API_MAX_CONCURRENT) {
      limiter.inflight++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      limiter.waitQueue.push(() => { limiter.inflight++; resolve(); });
    });
  }

  private releaseSlot(storeDomain: string): void {
    const limiter = this.limiterFor(storeDomain);
    limiter.inflight = Math.max(0, limiter.inflight - 1);
    limiter.waitQueue.shift()?.();
  }

  private extendCooldown(storeDomain: string, delayMs: number): void {
    const limiter = this.limiterFor(storeDomain);
    limiter.cooldownUntil = Math.max(limiter.cooldownUntil, Date.now() + delayMs);
  }

  private async waitForCooldown(storeDomain: string): Promise<void> {
    const delay = this.limiterFor(storeDomain).cooldownUntil - Date.now();
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  }

  private async throttledRequest<T>(storeDomain: string, fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    while (true) {
      await this.waitForCooldown(storeDomain);
      await this.acquireSlot(storeDomain);
      try {
        return await fn();
      } catch (error: unknown) {
        if (error instanceof ResponseError && error.status === 429 && attempt < MAX_RETRIES) {
          const retryAfter = parseRetryAfterHeader(error.headers);
          const delay = Math.max(retryAfter, 1) * 1000 + attempt * 500;
          this.extendCooldown(storeDomain, delay);
          this.logger.warn(`Rate limited store=${storeDomain} attempt=${attempt + 1}/${MAX_RETRIES} delay=${delay}ms`);
          attempt++;
        } else {
          throw error;
        }
      } finally {
        this.releaseSlot(storeDomain);
      }
    }
  }

  private buildUrl(storeDomain: string, path: string, params?: URLSearchParams): string {
    const qs = params?.toString();
    return `https://${storeDomain}/admin${path}${qs ? '?' + qs : ''}`;
  }

  private buildQueryParams(record: Record<string, string | number | boolean | null | undefined>): URLSearchParams {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(record)) {
      if (value === null || value === undefined || value === '') continue;
      params.append(key, String(value));
    }
    return params;
  }

  private async fetch(storeDomain: string, accessToken: string, path: string, init: RequestInit = {}): Promise<Response> {
    return this.throttledRequest(storeDomain, async () => {
      const url = this.buildUrl(storeDomain, path);
      const res = await fetch(url, {
        ...init,
        headers: {
          'X-Sapo-Access-Token': accessToken,
          Accept: 'application/json',
          ...init.headers,
        },
      });
      const pauseMs = callLimitPauseMs(res.headers);
      if (pauseMs > 0) this.extendCooldown(storeDomain, pauseMs);
      if (!res.ok) {
        const err = new ResponseError(res.status, res.headers);
        throw err;
      }
      return res;
    });
  }

  private async sendJson(
    storeDomain: string, accessToken: string, method: 'POST' | 'PUT', path: string, body: unknown, failMessage: string,
  ): Promise<Response> {
    try {
      return await this.fetch(storeDomain, accessToken, path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (error instanceof ResponseError) throw new BadRequestException({ message: failMessage, status: error.status });
      throw error;
    }
  }

  async exchangeCode(code: string, storeDomain: string): Promise<OAuthTokenPayload> {
    const params = new URLSearchParams({
      code,
      client_id: this.env.SAPO_CLIENT_ID,
      client_secret: this.env.SAPO_CLIENT_SECRET,
    });
    const url = `https://${storeDomain}/admin/oauth/access_token`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: params.toString(),
    });
    if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404) {
      throw new UnauthorizedException('Sapo rejected the authorization code');
    }
    if (!res.ok) {
      this.logger.warn(`Sapo token exchange failed for ${storeDomain}: HTTP ${res.status}`);
      throw new BadGatewayException('Sapo token exchange failed');
    }
    return res.json() as Promise<OAuthTokenPayload>;
  }

  async getShop(storeDomain: string, accessToken: string): Promise<SapoShop> {
    const res = await this.fetch(storeDomain, accessToken, '/store.json');
    const payload = await res.json() as { store?: SapoShop; shop?: SapoShop };
    const store = payload.store ?? payload.shop;
    if (!store) throw new BadRequestException('Failed to fetch store info');
    return store;
  }

  async getProducts(storeDomain: string, accessToken: string, params: GetProductsParams = {}): Promise<SapoProduct[]> {
    const qp = this.buildQueryParams(params as Record<string, string | number | boolean | null | undefined>);
    const path = `/products.json${qp.toString() ? '?' + qp.toString() : ''}`;
    const res = await this.fetch(storeDomain, accessToken, path);
    const payload = await res.json() as SapoListResponse<SapoProduct>;
    const key = Object.keys(payload).find((k) => Array.isArray(payload[k]));
    return key ? payload[key] : [];
  }

  async getProductsCount(storeDomain: string, accessToken: string, params: GetProductsCountParams = {}): Promise<number> {
    const qp = this.buildQueryParams(params as Record<string, string | number | boolean | null | undefined>);
    const path = `/products/count.json${qp.toString() ? '?' + qp.toString() : ''}`;
    const res = await this.fetch(storeDomain, accessToken, path);
    const payload = await res.json() as { count?: number };
    if (typeof payload.count !== 'number' || payload.count < 0) {
      throw new BadRequestException('Failed to fetch products count');
    }
    return payload.count;
  }

  async getProduct(storeDomain: string, accessToken: string, productId: string): Promise<SapoProduct> {
    assertNumericId(productId, 'productId');
    const res = await this.fetch(storeDomain, accessToken, `/products/${productId}.json`);
    const payload = await res.json() as { product?: SapoProduct };
    if (!payload.product) throw new BadRequestException('Failed to fetch product');
    return payload.product;
  }

  async getProductMetafields(storeDomain: string, accessToken: string, productId: string, namespace?: string): Promise<SapoMetafield[]> {
    assertNumericId(productId, 'productId');
    const metafields = await this.getAllMetafieldPages(
      storeDomain, accessToken,
      (page, limit) => `/products/${productId}/metafields.json?page=${page}&limit=${limit}`,
    );
    return namespace ? metafields.filter((m) => m.namespace === namespace) : metafields;
  }

  async createProductMetafield(
    storeDomain: string, accessToken: string, productId: string,
    metafield: { namespace: string; key: string; value: string | number; value_type: string },
  ): Promise<SapoMetafield> {
    assertNumericId(productId, 'productId');
    const res = await this.sendJson(
      storeDomain, accessToken, 'POST', `/products/${productId}/metafields.json`, { metafield }, 'Sapo create product metafield failed',
    );
    const payload = await res.json() as { metafield?: SapoMetafield };
    if (!payload.metafield) throw new BadRequestException('Failed to create product metafield');
    return payload.metafield;
  }

  async updateProductMetafield(
    storeDomain: string, accessToken: string, productId: string, metafieldId: string,
    metafield: { value: string | number; value_type?: string },
  ): Promise<SapoMetafield> {
    assertNumericId(productId, 'productId');
    assertNumericId(metafieldId, 'metafieldId');
    const res = await this.sendJson(
      storeDomain, accessToken, 'PUT', `/products/${productId}/metafields/${metafieldId}.json`, { metafield }, 'Sapo update product metafield failed',
    );
    const payload = await res.json() as { metafield?: SapoMetafield };
    if (!payload.metafield) throw new BadRequestException('Failed to update product metafield');
    return payload.metafield;
  }

  async getMetafields(storeDomain: string, accessToken: string, ownerResource: string, ownerId?: string): Promise<SapoMetafield[]> {
    const params = new URLSearchParams();
    params.set('metafield[owner_resource]', ownerResource);
    if (ownerId) params.set('metafield[owner_id]', ownerId);
    return this.getAllMetafieldPages(storeDomain, accessToken, (page, limit) => `/metafields.json?${params.toString()}&page=${page}&limit=${limit}`);
  }

  async createMetafield(storeDomain: string, accessToken: string, payload: SapoMetafieldCreatePayload): Promise<SapoMetafield> {
    const normalized = normalizeMetafieldPayload(payload) as SapoMetafieldCreatePayload;
    const res = await this.sendJson(
      storeDomain, accessToken, 'POST', '/metafields.json', { metafield: normalized }, 'Sapo create metafield failed',
    );
    const p = await res.json() as { metafield?: SapoMetafield };
    if (!p.metafield) throw new BadRequestException('Failed to create metafield');
    return p.metafield;
  }

  async updateMetafield(storeDomain: string, accessToken: string, metafieldId: string, payload: SapoMetafieldUpdatePayload): Promise<SapoMetafield> {
    assertNumericId(metafieldId, 'metafieldId');
    const normalized = normalizeMetafieldPayload(payload) as SapoMetafieldUpdatePayload;
    const res = await this.sendJson(
      storeDomain, accessToken, 'PUT', `/metafields/${metafieldId}.json`, { metafield: normalized }, 'Sapo update metafield failed',
    );
    const p = await res.json() as { metafield?: SapoMetafield };
    if (!p.metafield) throw new BadRequestException('Failed to update metafield');
    return p.metafield;
  }

  private async getAllMetafieldPages(
    storeDomain: string, accessToken: string, buildPath: (page: number, limit: number) => string,
    config: { limit?: number; maxPages?: number } = {},
  ): Promise<SapoMetafield[]> {
    const limit = Math.max(1, config.limit ?? METAFIELD_PAGE_LIMIT);
    const maxPages = Math.max(1, config.maxPages ?? METAFIELD_MAX_PAGES);
    const collected: SapoMetafield[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const path = buildPath(page, limit);
      const res = await this.fetch(storeDomain, accessToken, path);
      const payload = await res.json() as { metafields?: SapoMetafield[] };
      if (!Array.isArray(payload.metafields)) break;
      collected.push(...payload.metafields);
      if (payload.metafields.length < limit) break;
    }
    return collected;
  }

  async getWebhooks(storeDomain: string, accessToken: string): Promise<SapoWebhook[]> {
    const res = await this.fetch(storeDomain, accessToken, '/webhooks.json');
    const payload = await res.json() as { webhooks?: SapoWebhook[] };
    return payload.webhooks ?? [];
  }

  async createWebhook(storeDomain: string, accessToken: string, topic: string, address: string): Promise<SapoWebhook> {
    let res: Response;
    try {
      res = await this.fetch(storeDomain, accessToken, '/webhooks.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhook: { topic, address, format: 'json' } }),
      });
    } catch (error) {
      if (!(error instanceof ResponseError)) throw error;
      if (error.status === 409 || error.status === 422) {
        const existing = (await this.getWebhooks(storeDomain, accessToken)).find(
          (hook) => hook.topic === topic && sameWebhookAddress(hook.address, address),
        );
        if (existing) return existing;
      }
      this.logger.error(`Sapo createWebhook failed topic=${topic} status=${error.status}`);
      throw new BadRequestException({ message: 'Sapo create webhook failed', status: error.status });
    }
    const payload = await res.json() as { webhook?: SapoWebhook };
    if (!payload.webhook) throw new BadGatewayException('Sapo create webhook returned no webhook');
    return payload.webhook;
  }

  async deleteWebhook(storeDomain: string, accessToken: string, webhookId: string): Promise<void> {
    assertNumericId(webhookId, 'webhookId');
    await this.fetch(storeDomain, accessToken, `/webhooks/${webhookId}.json`, { method: 'DELETE' });
  }
}

class ResponseError extends Error {
  constructor(public readonly status: number, public readonly headers: Headers) {
    super(`HTTP ${status}`);
  }
}
