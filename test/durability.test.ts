import test from 'node:test';
import assert from 'node:assert/strict';

import { WebhookService, asEntityId } from '../src/sapo/webhook.service';
import { SapoService } from '../src/sapo/sapo.service';
import { isSapoAuthRevoked, sapoErrorStatus } from '../src/sapo/install-revocation';
import { ReviewService, buildSummaryMetafields, type SummaryMetafield } from '../src/review/review.service';
import { MetafieldSyncPendingService, PENDING_MAX_ATTEMPTS, pendingBackoffMs } from '../src/database/metafield-sync-pending.service';
import { CatalogProductStoreService } from '../src/catalog/catalog-product-store.service';
import { CatalogSyncService } from '../src/catalog/catalog-sync.service';
import { countRecentFailures, deriveHealthVerdict, FAILURE_WINDOW_MINUTES } from '../src/health/health-verdict';
import type { AppEnv } from '../src/config/env.schema';
import type { MediaService } from '../src/media/media.service';
import type { PrismaService } from '../src/database/prisma.service';
import type { PurchaseStoreService } from '../src/purchase/purchase-store.service';
import type { RedisService } from '../src/redis/redis.service';
import type { ReviewProductStoreService } from '../src/review/review-product-store.service';
import type { HmacVerifierService } from '../src/sapo/hmac-verifier.service';
import type { LifecycleLockService } from '../src/sapo/lifecycle-lock.service';
import type { OAuthStateService } from '../src/sapo/oauth-state.service';
import type { SapoApiService } from '../src/sapo/sapo-api.service';
import type { SessionService } from '../src/sapo/session.service';
import type { ShopDomainService } from '../src/sapo/shop-domain.service';
import type { TokenEncryptionService } from '../src/sapo/token-encryption.service';
import type { UninstallService } from '../src/sapo/uninstall.service';
import type { WebhookRegistrationService } from '../src/sapo/webhook-registration.service';
import type { StorefrontService } from '../src/storefront/storefront.service';
import { fake } from './support/fakes';

const MIN = 60_000;

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

const sameValue = (a: unknown, b: unknown): boolean =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;

const matches = (row: Row, where: Where = {}): boolean =>
  Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Where[]).some((sub) => matches(row, sub));
    const value = row[key];
    if (cond instanceof Date || cond === null || typeof cond !== 'object') {
      return cond === null ? value === null || value === undefined : sameValue(value, cond);
    }
    return Object.entries(cond as Where).every(([op, expected]) => {
      if (op === 'in') return (expected as unknown[]).includes(value);
      if (op === 'not') return expected === null ? value !== null && value !== undefined : value !== expected;
      if (value === null || value === undefined) return false;
      if (op === 'lte') return (value as number) <= (expected as number);
      if (op === 'lt') return (value as number) < (expected as number);
      if (op === 'gte') return (value as number) >= (expected as number);
      if (op === 'gt') return (value as number) > (expected as number);
      return false;
    });
  });

const applyData = (row: Row, data: Where): void => {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && !(value instanceof Date) && 'increment' in value) {
      row[key] = (Number(row[key]) || 0) + Number(value.increment);
    } else {
      row[key] = value;
    }
  }
  row.updatedAt = new Date(Math.max(Date.now(), ((row.updatedAt as Date | undefined)?.getTime() || 0) + 1));
};

const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

type WebhookRow = {
  id: string;
  idempotencyKey: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  nextRetryAt: Date | null;
  processedAt: Date | null;
  updatedAt: Date;
  [key: string]: unknown;
};

const makeWebhookDb = () => {
  const rows: WebhookRow[] = [];
  let seq = 0;
  const webhookEvent = {
    rows,
    create: async ({ data }: { data: Row & { idempotencyKey: string } }) => {
      if (rows.some((r) => r.idempotencyKey === data.idempotencyKey)) throw new Error('P2002 unique constraint');
      seq += 1;
      const row = {
        attempts: 0,
        maxAttempts: 8,
        lastError: null,
        nextRetryAt: null,
        processedAt: null,
        ...data,
        id: `evt_${String(seq).padStart(4, '0')}`,
        updatedAt: new Date(),
      } as WebhookRow;
      rows.push(row);
      return { id: row.id, status: row.status };
    },
    findUnique: async ({ where }: { where: { id?: string; idempotencyKey?: string } }) => {
      const row = rows.find((r) => (where.id ? r.id === where.id : r.idempotencyKey === where.idempotencyKey));
      return row ? { ...row } : null;
    },
    update: async ({ where, data }: { where: { id: string }; data: Where }) => {
      const row = rows.find((r) => r.id === where.id);
      if (!row) throw new Error(`no webhook row ${where.id}`);
      applyData(row, data);
      return { ...row };
    },
    updateMany: async ({ where, data }: { where: Where; data: Where }) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => applyData(r, data));
      return { count: hit.length };
    },
    findMany: async ({ where, orderBy, take }: { where: Where; orderBy?: { id?: string }; take?: number }) => {
      let hit = rows.filter((r) => matches(r, where));
      if (orderBy?.id === 'asc') hit = hit.sort(byId);
      return hit.slice(0, take ?? hit.length).map((r) => ({ ...r }));
    },
  };
  return {
    appInstall: { findUnique: async () => ({ shopId: 'shop_1' }) },
    catalogProduct: { findFirst: async () => null },
    customerPurchase: { findFirst: async () => null },
    webhookEvent,
  };
};

type WebhookDb = ReturnType<typeof makeWebhookDb>;
type SyncedOrder = { shopId: string; order: Record<string, unknown> };

const storedOrderProjection = (order: Record<string, unknown>) => ({
  id: order.id === undefined ? null : String(order.id),
  line_items: ((order.line_items as { product_id: unknown }[] | undefined) ?? []).map((item) => ({ product_id: String(item.product_id) })),
  email_hash: order.email ? 'email-digest' : null,
  phone_hash: null,
  hash_version: 1,
});

const makeWebhookService = (db: WebhookDb, overrides: { failProduct?: string } = {}) => {
  const calls: { products: string[]; orders: SyncedOrder[] } = { products: [], orders: [] };
  const service = new WebhookService(
    fake<PrismaService>(db),
    fake<HmacVerifierService>({ verifyWebhookBody: () => undefined }),
    fake<ShopDomainService>({ collectDomains: () => [], resolveStoreDomain: async () => null, saveMapping: async () => {} }),
    fake<UninstallService>({ uninstall: async () => ({ ok: true }) }),
    fake<SapoService>({ resolveAccessToken: async () => 'token' }),
    fake<CatalogSyncService>({
      handleProductWebhookWithToken: async (store: string, productId: string) => {
        calls.products.push(productId);
        if (overrides.failProduct === productId) throw new Error('upstream down');
      },
    }),
    fake<PurchaseStoreService>({
      toStoredOrder: storedOrderProjection,
      syncOrder: async (input: SyncedOrder) => { calls.orders.push(input); return 1; },
    }),
  );
  return { service, calls };
};

const rowById = (db: WebhookDb, id: string): WebhookRow => {
  const row = db.webhookEvent.rows.find((r) => r.id === id);
  if (!row) throw new Error(`no webhook row ${id}`);
  return row;
};

const productInput = (id = 100) => ({
  headers: { 'x-sapo-topic': 'products/update', 'x-sapo-hmac-sha256': 'sig' },
  query: {},
  body: { id, store_domain: 'demo.mysapo.net' },
  rawBody: Buffer.from('{}'),
});

test('redelivery reclaims an event whose worker died, but never one that is still fresh', async () => {
  const db = makeWebhookDb();
  const { service, calls } = makeWebhookService(db);
  await service.handle(productInput());
  assert.equal(calls.products.length, 1);

  const row = db.webhookEvent.rows[0];
  row.status = 'processing';
  row.updatedAt = new Date(Date.now() - 1 * MIN);
  const fresh = await service.handle(productInput());
  assert.equal(fresh.inProgress, true);
  assert.equal(calls.products.length, 1, 'a live worker must not be run twice');

  row.updatedAt = new Date(Date.now() - 30 * MIN);
  const reclaimed = await service.handle(productInput());
  assert.equal(reclaimed.ok, true);
  assert.equal(calls.products.length, 2);
  assert.equal(row.status, 'processed');
});

test('two concurrent redeliveries of a stalled event run the handler exactly once', async () => {
  const db = makeWebhookDb();
  const { service, calls } = makeWebhookService(db);
  await service.handle(productInput());
  const row = db.webhookEvent.rows[0];
  row.status = 'processing';
  row.updatedAt = new Date(Date.now() - 30 * MIN);

  const results = await Promise.all([service.handle(productInput()), service.handle(productInput())]);
  assert.equal(calls.products.length, 2, 'initial run plus exactly one reclaim');
  assert.equal(results.filter((r) => r.inProgress).length, 1);
});

test('a failed event is not re-run before nextRetryAt and is re-run once it is due', async () => {
  const db = makeWebhookDb();
  const { service, calls } = makeWebhookService(db, { failProduct: '100' });
  await assert.rejects(() => service.handle(productInput()), /upstream down/);
  const row = db.webhookEvent.rows[0];
  assert.equal(row.status, 'failed');
  assert.ok(row.nextRetryAt);
  assert.ok(row.nextRetryAt.getTime() > Date.now(), 'failure schedules a future retry');

  const early = await service.handle(productInput());
  assert.equal(early.deferred, true);
  assert.equal(calls.products.length, 1);

  row.nextRetryAt = new Date(Date.now() - 1000);
  const { service: healthy, calls: healthyCalls } = makeWebhookService(db);
  const due = await healthy.handle(productInput());
  assert.equal(due.ok, true);
  assert.equal(healthyCalls.products.length, 1);
  assert.equal(row.status, 'processed');
});

test('retry backoff grows with attempts and stops scheduling once attempts are exhausted', async () => {
  const db = makeWebhookDb();
  const { service } = makeWebhookService(db, { failProduct: '100' });
  await assert.rejects(() => service.handle(productInput()));
  const row = db.webhookEvent.rows[0];
  assert.ok(row.nextRetryAt);
  const firstDelay = row.nextRetryAt.getTime() - Date.now();

  row.nextRetryAt = new Date(Date.now() - 1);
  await assert.rejects(() => service.handle(productInput()));
  const secondDelay = row.nextRetryAt.getTime() - Date.now();
  assert.ok(secondDelay > firstDelay * 1.5, `delay should roughly double (${firstDelay} -> ${secondDelay})`);

  row.attempts = row.maxAttempts - 1;
  row.nextRetryAt = new Date(Date.now() - 1);
  await assert.rejects(() => service.handle(productInput()));
  assert.equal(row.status, 'failed');
  assert.equal(row.nextRetryAt, null, 'exhausted events leave the retry queue');
});

test('reclaimStalled turns dead processing rows into due failed rows and leaves live ones alone', async () => {
  const db = makeWebhookDb();
  const { service } = makeWebhookService(db);
  const seed = async (key: string, status: string, ageMin: number, extra: { attempts?: number } = {}) => {
    const created = await db.webhookEvent.create({
      data: { idempotencyKey: key, status, topic: 't', normalizedTopic: 'products/update', payload: { id: 1 }, ...extra },
    });
    const row = rowById(db, created.id);
    row.updatedAt = new Date(Date.now() - ageMin * MIN);
    return row;
  };
  const dead = await seed('dead', 'processing', 30);
  const live = await seed('live', 'processing', 2);
  const done = await seed('done', 'processed', 300);
  const exhausted = await seed('exhausted', 'received', 30, { attempts: 8 });

  const result = await service.reclaimStalled();
  assert.equal(result.reclaimed, 2);
  assert.equal(dead.status, 'failed');
  assert.ok(dead.nextRetryAt && dead.nextRetryAt.getTime() <= Date.now());
  assert.match(dead.lastError ?? '', /stalled/i);
  assert.equal(live.status, 'processing');
  assert.equal(done.status, 'processed');
  assert.equal(exhausted.status, 'failed');
  assert.equal(exhausted.nextRetryAt, null);
});

test('retryDueFailed replays due events from their stored payload and isolates a failing one', async () => {
  const db = makeWebhookDb();
  const { service, calls } = makeWebhookService(db, { failProduct: '2' });
  const seed = async (key: string, payload: Row, extra: { nextRetryAt?: Date; attempts?: number } = {}) => {
    const created = await db.webhookEvent.create({
      data: {
        idempotencyKey: key,
        status: 'failed',
        topic: 'products/update',
        normalizedTopic: 'products/update',
        resolvedStoreDomain: 'demo.mysapo.net',
        payload,
        ...extra,
      },
    });
    const row = rowById(db, created.id);
    row.nextRetryAt = extra.nextRetryAt ?? new Date(Date.now() - 1000);
    row.attempts = extra.attempts ?? 1;
    return row;
  };
  const ok1 = await seed('a', { id: 1 });
  const bad = await seed('b', { id: 2 });
  const ok3 = await seed('c', { id: 3 });
  const notDue = await seed('d', { id: 4 }, { nextRetryAt: new Date(Date.now() + 10 * MIN) });
  const spent = await seed('e', { id: 5 }, { attempts: 8 });

  const result = await service.retryDueFailed();
  assert.deepEqual(calls.products.sort(), ['1', '2', '3']);
  assert.equal(result.succeeded, 2);
  assert.equal(result.failed, 1);
  assert.equal(ok1.status, 'processed');
  assert.equal(ok3.status, 'processed');
  assert.equal(bad.status, 'failed');
  assert.ok(bad.nextRetryAt && bad.nextRetryAt.getTime() > Date.now());
  assert.equal(notDue.status, 'failed');
  assert.equal(spent.status, 'failed');
});

const makeRetryFixture = (install: { installedAt: Date | null; lifecycleGeneration: number }) => {
  const db = { ...makeWebhookDb(), appInstall: { findUnique: async () => ({ shopId: 'shop_1', ...install }) } };
  const { service, calls } = makeWebhookService(db);
  const seed = async (key: string, extra: Row) => {
    const created = await db.webhookEvent.create({
      data: {
        idempotencyKey: key,
        status: 'failed',
        topic: 'products/update',
        normalizedTopic: 'products/update',
        resolvedStoreDomain: 'demo.mysapo.net',
        payload: { id: 1 },
        ...extra,
      },
    });
    const row = rowById(db, created.id);
    row.nextRetryAt = new Date(Date.now() - 1000);
    row.attempts = 1;
    return row;
  };
  return { service, calls, seed };
};

test('retryDueFailed marks a payload-purged event failed with no retry instead of running it with an empty payload', async () => {
  const { service, calls, seed } = makeRetryFixture({ installedAt: new Date(Date.now() - 60 * MIN), lifecycleGeneration: 1 });
  const purged = await seed('purged', { payload: null });
  const live = await seed('live', { payload: { id: 7 } });

  const result = await service.retryDueFailed();
  assert.equal(purged.status, 'failed');
  assert.equal(purged.lastError, 'payload purged');
  assert.equal(purged.nextRetryAt, null);
  assert.equal(purged.attempts, 1);
  assert.deepEqual(calls.products, ['7']);
  assert.equal(live.status, 'processed');
  assert.equal(result.attempted, 1);

  const again = await service.retryDueFailed();
  assert.equal(again.attempted, 0);
  assert.equal(purged.status, 'failed');
});

test('retryDueFailed ignores a lifecycle event from an earlier install generation without dispatching it', async () => {
  const { service, seed } = makeRetryFixture({ installedAt: new Date(Date.now() - 60 * MIN), lifecycleGeneration: 3 });
  const lifecycle = { topic: 'app/uninstalled', normalizedTopic: 'app/uninstalled', receivedAt: new Date(Date.now() - 10 * MIN) };
  const stale = await seed('stale', { ...lifecycle, lifecycleGeneration: 2 });
  const current = await seed('current', { ...lifecycle, lifecycleGeneration: 3 });
  const product = await seed('product', { lifecycleGeneration: null });

  const result = await service.retryDueFailed();
  assert.equal(stale.status, 'ignored');
  assert.equal(stale.attempts, 1);
  assert.equal(stale.nextRetryAt, null);
  assert.equal(stale.lastError, null);
  assert.equal(current.status, 'processed');
  assert.equal(product.status, 'processed');
  assert.equal(result.attempted, 2);
});

test('retryDueFailed ignores a lifecycle event received before the install row was created', async () => {
  const installedAt = new Date(Date.now() - 60 * MIN);
  const { service, seed } = makeRetryFixture({ installedAt, lifecycleGeneration: 1 });
  const base = { topic: 'store/update', normalizedTopic: 'store/update', lifecycleGeneration: null };
  const before = await seed('before', { ...base, receivedAt: new Date(installedAt.getTime() - MIN) });
  const after = await seed('after', { ...base, receivedAt: new Date(installedAt.getTime() + MIN) });

  await service.retryDueFailed();
  assert.equal(before.status, 'ignored');
  assert.equal(after.status, 'processed');
});

test('product and order webhooks with numeric Sapo ids reach their sync, ids are never fabricated', async () => {
  assert.equal(asEntityId(1234), '1234');
  assert.equal(asEntityId('1234'), '1234');
  assert.equal(asEntityId(' 1234 '), '1234');
  for (const bad of [0, -5, 1.5, NaN, Infinity, 'abc', '12ab', '', null, undefined, {}, true]) {
    assert.equal(asEntityId(bad), null, `rejects ${String(bad)}`);
  }

  const db = makeWebhookDb();
  const { service, calls } = makeWebhookService(db);
  await service.handle(productInput(987654321));
  assert.deepEqual(calls.products, ['987654321']);

  await service.handle({
    headers: { 'x-sapo-topic': 'orders/paid', 'x-sapo-hmac-sha256': 'sig' },
    query: {},
    body: { id: 555, store_domain: 'demo.mysapo.net', email: 'buyer@example.com', line_items: [{ product_id: 987654321 }] },
    rawBody: Buffer.from('{}'),
  });
  assert.equal(calls.orders.length, 1);
  assert.equal(calls.orders[0].shopId, 'shop_1');
  assert.equal(calls.orders[0].order.id, 555);

  await service.handle({
    headers: { 'x-sapo-topic': 'orders/paid', 'x-sapo-hmac-sha256': 'sig' },
    query: {},
    body: { store_domain: 'demo.mysapo.net', email: 'buyer@example.com' },
    rawBody: Buffer.from('{}'),
  });
  assert.equal(calls.orders.length, 1, 'an order payload without an id is skipped');

  const storedOrder = db.webhookEvent.rows.find((r) => r.normalizedTopic === 'orders/paid' && (r.payload as Row).id === '555');
  assert.ok(storedOrder);
  const projected = {
    id: '555',
    line_items: [{ product_id: '987654321' }],
    email_hash: 'email-digest',
    phone_hash: null,
    hash_version: 1,
  };
  assert.deepEqual(storedOrder.payload, projected, 'the stored event keeps a PII-free projection, never the raw order');

  storedOrder.status = 'failed';
  storedOrder.nextRetryAt = new Date(Date.now() - 1000);
  storedOrder.attempts = 1;
  const replay = await service.retryDueFailed();
  assert.equal(replay.succeeded, 1);
  assert.equal(calls.orders.length, 2);
  assert.deepEqual(calls.orders[1], { shopId: 'shop_1', order: projected }, 'replay syncs the projected payload');
});

type UpsertArgs = { create: Row; update: Row };

const runInstall = async (existingInstall: Row | null): Promise<UpsertArgs> => {
  const captured: { args: UpsertArgs | null } = { args: null };
  const prisma = {
    appInstall: {
      findUnique: async () => existingInstall,
      upsert: async (args: UpsertArgs) => { captured.args = args; return {}; },
    },
    shop: { upsert: async () => ({ id: 'shop_1' }) },
    shopDomain: {
      updateMany: async () => ({ count: 0 }),
      upsert: async () => ({}),
    },
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  };
  const service = new SapoService(
    fake<AppEnv>({ SAPO_CLIENT_ID: 'id' }),
    fake<PrismaService>(prisma),
    fake<OAuthStateService>({ consume: async () => ({ storeDomain: 'demo.mysapo.net', createdAt: Date.now(), redirectTo: undefined }) }),
    fake<SapoApiService>({ exchangeCode: async () => ({ access_token: 'tok' }), getShop: async () => ({ domain: 'demo.mysapo.net' }) }),
    fake<SessionService>({ createHandoff: async () => ({ url: '/ok' }) }),
    fake<TokenEncryptionService>({ encrypt: () => ({ ciphertext: 'c', iv: 'i', tag: 't' }) }),
    fake<ShopDomainService>({ collectDomains: () => ['demo.mysapo.net'], saveMapping: async () => {} }),
    fake<LifecycleLockService>({ acquireLifecycleLock: async () => ({ key: 'k', owner: 'o' }), release: async () => {} }),
    fake<WebhookRegistrationService>({ registerForInstall: async () => ({}) }),
    fake<StorefrontService>({ writeStorefrontConfig: async () => {} }),
  );
  await service.processInstallCallback('code', 'state');
  if (!captured.args) throw new Error('the install never reached appInstall.upsert');
  return captured.args;
};

test('reinstalling after an uninstall keeps the original installedAt so no new trial is minted', async () => {
  const original = new Date('2026-01-10T00:00:00.000Z');
  const args = await runInstall({
    status: 'uninstalled',
    installedAt: original,
    uninstalledAt: new Date(Date.now() - 60_000),
  });
  assert.equal('installedAt' in args.update, false, 'reinstall must not overwrite installedAt');
  assert.equal(args.update.uninstalledAt, null);

  const fresh = await runInstall(null);
  assert.ok(fresh.create.installedAt instanceof Date, 'a first install records installedAt');
});

const statusError = (status: number, message = `HTTP ${status}`): Error => Object.assign(new Error(message), { status });

test('only Sapo 401/403 count as revoked; throttling, 5xx and network errors do not', () => {
  assert.equal(isSapoAuthRevoked(statusError(401)), true);
  assert.equal(isSapoAuthRevoked(statusError(403)), true);
  assert.equal(isSapoAuthRevoked(new Error('Metafield create failed: 401')), true);
  for (const status of [400, 404, 408, 409, 422, 429, 500, 502, 503]) {
    assert.equal(isSapoAuthRevoked(statusError(status)), false, `status ${status}`);
  }
  assert.equal(isSapoAuthRevoked(new Error('fetch failed')), false);
  assert.equal(isSapoAuthRevoked(Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' })), false);
  assert.equal(isSapoAuthRevoked(null), false);
  assert.equal(sapoErrorStatus(new Error('Metafield update failed: 503')), 503);
});

type PendingRow = {
  id: string;
  storeDomain: string;
  productId: string;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: Date;
  updatedAt: Date;
  [key: string]: unknown;
};
type PendingKey = { storeDomain_productId: { storeDomain: string; productId: string } };

const makePendingDb = () => {
  const rows: PendingRow[] = [];
  let seq = 0;
  const find = (where: PendingKey): PendingRow | undefined =>
    rows.find((r) => r.storeDomain === where.storeDomain_productId.storeDomain && r.productId === where.storeDomain_productId.productId);
  return {
    rows,
    metafieldSyncPending: {
      upsert: async ({ where, create, update }: { where: PendingKey; create: Row; update: Row }) => {
        const row = find(where);
        if (row) {
          Object.assign(row, update);
          return { updatedAt: row.updatedAt };
        }
        seq += 1;
        const created = { attempts: 0, lastError: null, ...create, id: `p_${String(seq).padStart(4, '0')}` } as PendingRow;
        rows.push(created);
        return { updatedAt: created.updatedAt };
      },
      findUnique: async ({ where }: { where: PendingKey }) => {
        const row = find(where);
        return row ? { ...row } : null;
      },
      updateMany: async ({ where, data }: { where: Where; data: Where }) => {
        const hit = rows.filter((r) => matches(r, where));
        hit.forEach((r) => applyData(r, data));
        return { count: hit.length };
      },
      deleteMany: async ({ where }: { where: Where }) => {
        const keep = rows.filter((r) => !matches(r, where));
        const removed = rows.length - keep.length;
        rows.length = 0;
        rows.push(...keep);
        return { count: removed };
      },
      findMany: async ({ where, orderBy, take }: { where: Where; orderBy?: { id?: string }; take?: number }) => {
        let hit = rows.filter((r) => matches(r, where));
        if (orderBy?.id === 'asc') hit = hit.sort(byId);
        return hit.slice(0, take ?? hit.length).map((r) => ({ ...r }));
      },
      count: async ({ where }: { where?: Where } = {}) => rows.filter((r) => matches(r, where)).length,
    },
  };
};

type ReviewApi = {
  getProductMetafields: (store: string, token: string, productId: string) => Promise<unknown[]>;
  createProductMetafield: (store: string, token: string, productId: string, metafield: Row) => Promise<void>;
  updateProductMetafield: (...args: unknown[]) => Promise<void>;
};

type InstallRow = { shopId: string; tokenVersion: number; status: string; metadata?: Row };

const makeReviewHarness = ({ sapoApi, installs }: { sapoApi?: Partial<ReviewApi>; installs?: Record<string, InstallRow> } = {}) => {
  const pendingDb = makePendingDb();
  const statusUpdates: string[] = [];
  const installRows: Record<string, InstallRow> = installs ?? {
    'demo.mysapo.net': { shopId: 'shop_1', tokenVersion: 3, status: 'active' },
  };
  const prisma: Row = {
    ...pendingDb,
    appInstall: {
      findUnique: async ({ where }: { where: { storeDomain: string } }) =>
        installRows[where.storeDomain] ? { ...installRows[where.storeDomain] } : null,
      updateMany: async ({ where, data }: { where: { storeDomain: string; status: { in: string[] }; tokenVersion?: number }; data: Row }) => {
        const row = installRows[where.storeDomain];
        const live = row && where.status.in.includes(row.status) && (where.tokenVersion === undefined || where.tokenVersion === row.tokenVersion);
        if (live) { Object.assign(row, data); statusUpdates.push(where.storeDomain); }
        return { count: live ? 1 : 0 };
      },
    },
  };
  const pending = new MetafieldSyncPendingService(fake<PrismaService>(prisma));
  const created: Row[] = [];
  const defaultApi: ReviewApi = {
    getProductMetafields: async () => [],
    createProductMetafield: async (store, token, productId, metafield) => { created.push({ productId, ...metafield }); },
    updateProductMetafield: async () => {},
  };
  const api: ReviewApi = { ...defaultApi, ...sapoApi };
  const reviewStore = {
    calculatePublicSummary: async () => ({ avg: 4.5, count: 2, distribution: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 1 } }),
  };
  const service = new ReviewService(
    fake<RedisService>({ acquireLock: async () => ({ key: 'k', owner: 'o' }), releaseLock: async () => true }),
    fake<PrismaService>(prisma),
    fake<SapoApiService>(api),
    fake<ReviewProductStoreService>(reviewStore),
    fake<CatalogProductStoreService>({}),
    fake<PurchaseStoreService>({}),
    pending,
    fake<MediaService>({}),
  );
  return { service, pending, pendingDb, prisma, api, statusUpdates, installRows, created };
};

test('a 401 from Sapo marks the install needs_reinstall; 429, 5xx and network errors do not and stay queued', async () => {
  for (const failure of [statusError(429), statusError(500), statusError(503), new Error('fetch failed')]) {
    const h = makeReviewHarness({ sapoApi: { getProductMetafields: async () => { throw failure; } } });
    const result = await h.service.syncPublicSummaryMetafield('tok', 'demo.mysapo.net', '100');
    assert.deepEqual(result, { synced: 0, queued: 1 });
    assert.deepEqual(h.statusUpdates, [], `${failure.message} must not touch install status`);
    assert.equal(h.installRows['demo.mysapo.net'].status, 'active');
    assert.equal(h.pendingDb.rows.length, 1, 'intent stays queued for retry');
    assert.equal(h.pendingDb.rows[0].attempts, 1);
    assert.ok(h.pendingDb.rows[0].nextAttemptAt.getTime() > Date.now());
  }

  for (const status of [401, 403]) {
    const h = makeReviewHarness({ sapoApi: { createProductMetafield: async () => { throw statusError(status); } } });
    await h.service.syncPublicSummaryMetafield('tok', 'demo.mysapo.net', '100');
    assert.equal(h.installRows['demo.mysapo.net'].status, 'needs_reinstall');
    assert.equal(h.pendingDb.rows.length, 1, 'intent survives so the reinstall repairs the storefront');
  }
});

test('a revoked token never downgrades a shop that reinstalled while the call was in flight', async () => {
  const h = makeReviewHarness({
    sapoApi: {
      getProductMetafields: async () => {
        h.installRows['demo.mysapo.net'].tokenVersion = 4;
        throw statusError(401);
      },
    },
  });
  await h.service.syncPublicSummaryMetafield('tok', 'demo.mysapo.net', '100');
  assert.equal(h.installRows['demo.mysapo.net'].status, 'active');
});

test('a successful push clears the intent, but a newer review write during the push survives', async () => {
  const h = makeReviewHarness();
  const ok = await h.service.syncPublicSummaryMetafield('tok', 'demo.mysapo.net', '100');
  assert.deepEqual(ok, { synced: 1, queued: 0 });
  assert.equal(h.pendingDb.rows.length, 0);

  const racing = makeReviewHarness();
  racing.api.getProductMetafields = async () => {
    await racing.pending.markDirty('demo.mysapo.net', '100');
    return [];
  };
  await racing.service.syncPublicSummaryMetafield('tok', 'demo.mysapo.net', '100');
  assert.equal(racing.pendingDb.rows.length, 1, 'the later intent must not be erased by the earlier push');
});

test('pending intents are kept as exhausted after the attempt budget and backoff is capped', async () => {
  const h = makeReviewHarness();
  await h.pending.markDirty('demo.mysapo.net', '100');
  for (let i = 0; i < PENDING_MAX_ATTEMPTS; i += 1) {
    const { exhausted } = await h.pending.recordFailure('demo.mysapo.net', '100', 'boom');
    assert.equal(exhausted, i === PENDING_MAX_ATTEMPTS - 1, `attempt ${i + 1}`);
  }
  assert.equal(h.pendingDb.rows.length, 1, 'an exhausted intent is never deleted');
  const [row] = h.pendingDb.rows;
  assert.equal(row.attempts, PENDING_MAX_ATTEMPTS);
  assert.equal(row.lastError, 'boom');
  const cap = 6 * 60 * MIN;
  assert.equal(pendingBackoffMs(PENDING_MAX_ATTEMPTS + 30), cap);
  const delay = row.nextAttemptAt.getTime() - Date.now();
  assert.ok(delay <= cap && delay > cap - 10_000, `capped backoff, got ${delay}`);
  assert.equal(await h.pending.countFailed(), 1);

  const again = await h.pending.recordFailure('demo.mysapo.net', '100', 'boom again');
  assert.equal(again.exhausted, true);
  assert.equal(row.attempts, PENDING_MAX_ATTEMPTS, 'attempts never exceed the budget');
  assert.equal(row.lastError, 'boom again');
});

test('the reconciler drains due intents, isolates a failing product and defers a revoked shop without blocking others', async () => {
  const installs: Record<string, InstallRow> = {
    'good.mysapo.net': { shopId: 's_good', tokenVersion: 1, status: 'active' },
    'revoked.mysapo.net': { shopId: 's_rev', tokenVersion: 1, status: 'needs_reinstall' },
    'gone.mysapo.net': { shopId: 's_gone', tokenVersion: 1, status: 'uninstalled' },
  };
  const h = makeReviewHarness({
    installs,
    sapoApi: {
      getProductMetafields: async (store: string, token: string, productId: string) => {
        if (productId === 'bad') throw statusError(500);
        return [];
      },
    },
  });
  await h.pending.markDirty('revoked.mysapo.net', '1');
  await h.pending.markDirty('revoked.mysapo.net', '2');
  await h.pending.markDirty('good.mysapo.net', 'bad');
  await h.pending.markDirty('good.mysapo.net', 'ok1');
  await h.pending.markDirty('good.mysapo.net', 'ok2');
  await h.pending.markDirty('gone.mysapo.net', '9');
  const later = await h.pending.markDirty('good.mysapo.net', 'later');
  const laterRow = h.pendingDb.rows.find((r) => r.productId === 'later');
  assert.ok(laterRow);
  laterRow.nextAttemptAt = new Date(Date.now() + 10 * MIN);

  const resolveToken = async (store: string) => {
    if (installs[store].status !== 'active') throw new Error('App needs reinstall');
    return 'tok';
  };
  const result = await h.service.reconcilePendingSummaries(resolveToken);
  assert.equal(result.synced, 2);
  assert.equal(result.failed, 1);
  assert.ok(result.deferred >= 2);
  const remaining = h.pendingDb.rows.map((r) => `${r.storeDomain}/${r.productId}`).sort();
  assert.deepEqual(remaining, ['good.mysapo.net/bad', 'good.mysapo.net/later', 'revoked.mysapo.net/1', 'revoked.mysapo.net/2']);
  assert.ok(later instanceof Date);
});

test('reconciler paging walks a backlog larger than one page exactly once', async () => {
  const h = makeReviewHarness();
  const seen: string[] = [];
  h.api.getProductMetafields = async (store: string, token: string, productId: string) => { seen.push(productId); return []; };
  for (let i = 0; i < 60; i += 1) await h.pending.markDirty('demo.mysapo.net', String(1000 + i));
  const result = await h.service.reconcilePendingSummaries(async () => 'tok', { maxRows: 1000 });
  assert.equal(result.synced, 60);
  assert.equal(new Set(seen).size, 60);
  assert.equal(h.pendingDb.rows.length, 0);
});

const reviewRow = (i: number) => ({
  id: `rv_${String(i).padStart(5, '0')}`,
  reviewId: `r${i}`,
  rating: 5,
  content: 'ok',
  author: 'a',
  email: 'a@example.com',
  phone: null,
  title: null,
  media: null,
  status: 'approved',
  verified: false,
  pinned: false,
  reply: null,
  repliedAt: null,
  sourceRawJson: null,
  productId: '100',
  createdAt: BigInt(1_000_000 - i),
  updatedAt: BigInt(1_000_000 - i),
});

test('public totals stay true beyond 200 reviews and contact PII never leaves; non-serving shops get nothing', async () => {
  const all = Array.from({ length: 450 }, (_, i) => reviewRow(i));
  const h = makeReviewHarness({
    installs: {
      'demo.mysapo.net': { shopId: 'shop_1', tokenVersion: 1, status: 'active', metadata: {} },
      'gone.mysapo.net': { shopId: 'shop_2', tokenVersion: 1, status: 'uninstalled', metadata: { reviewWidgetConfig: { titleText: 'secret' } } },
    },
  });
  h.prisma.reviewProduct = {
    findMany: async ({ skip = 0, take, cursor }: { skip?: number; take: number; cursor?: { id: string } }) => {
      const start = cursor ? all.findIndex((r) => r.id === cursor.id) + skip : skip;
      return all.slice(start, start + take);
    },
    count: async () => all.length,
  };

  const page = await h.service.getPublicReviews('demo.mysapo.net', '100', { page: 9, limit: 50 });
  assert.equal(page.total, 450);
  assert.equal(page.items.length, 50);
  assert.equal(page.items[0].id, 'r400');
  assert.equal(page.items[0].email, undefined);
  assert.equal(page.items[0].phone, undefined);

  const admin = await h.service.getReviews('tok', 'demo.mysapo.net', '100');
  assert.equal(admin.length, 450, 'admin list is not truncated to the first store page');
  assert.equal(new Set(admin.map((r) => r.id)).size, 450);

  const gone = await h.service.getPublicReviews('gone.mysapo.net', '100', {});
  assert.deepEqual({ items: gone.items.length, total: gone.total }, { items: 0, total: 0 });
  const goneConfig: Row = { ...(await h.service.getPublicWidgetConfig('gone.mysapo.net')) };
  assert.notEqual(goneConfig.titleText, 'secret');
  const goneSummaries = await h.service.getPublicSummaries('gone.mysapo.net', ['100']);
  assert.equal(goneSummaries['100'].count, 0);
  assert.equal(await h.service.isStoreServing('unknown.mysapo.net'), false);
});

test('status counts come from grouped counts, not from loading every review', async () => {
  const h = makeReviewHarness();
  let loadedRows = false;
  h.prisma.reviewProduct = {
    groupBy: async () => [
      { status: 'approved', _count: { _all: 700 } },
      { status: 'pending', _count: { _all: 5 } },
    ],
    count: async ({ where }: { where: { OR?: unknown } }) => (where.OR ? 12 : 3),
    findMany: async () => { loadedRows = true; return []; },
  };
  const page = await h.service.listAllReviews('tok', 'demo.mysapo.net', {});
  assert.equal(page.statusCounts.all, 705);
  assert.equal(page.statusCounts.approved, 700);
  assert.equal(page.statusCounts.pending, 5);
  assert.equal(page.statusCounts.unreplied, 12);
});

test('widget config save merges into one atomic statement and answers with the stored value', async () => {
  const h = makeReviewHarness();
  const statements: { sql: string; values: unknown[] }[] = [];
  h.prisma.$queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    statements.push({ sql: strings.join('?'), values });
    return [{ value: { accentColor: '#fff', titleText: 'Hi' } }];
  };
  const saved: Row = { ...(await h.service.updateWidgetConfig('tok', { accentColor: '#fff', titleText: undefined }, 'demo.mysapo.net')) };
  assert.equal(statements.length, 1, 'a single UPDATE, never read-modify-write');
  assert.match(statements[0].sql, /UPDATE "AppInstall"/);
  assert.equal(saved.accentColor, '#fff');
  assert.ok(statements[0].values.includes(JSON.stringify({ accentColor: '#fff' })), 'undefined fields are not written');

  h.prisma.$queryRaw = async () => [];
  await assert.rejects(() => h.service.updateWidgetConfig('tok', { accentColor: '#fff' }, 'nobody.mysapo.net'), /not installed/i);
});

test('health verdict ranks down over degraded over ok', () => {
  assert.deepEqual(deriveHealthVerdict({ healthy: true, recentFailures: 0 }), { ok: true, degraded: false, status: 'ok' });
  assert.deepEqual(deriveHealthVerdict({ healthy: true, recentFailures: 2 }), { ok: false, degraded: true, status: 'degraded' });
  assert.deepEqual(deriveHealthVerdict({ healthy: false, recentFailures: 0 }), { ok: false, degraded: false, status: 'down' });
  assert.deepEqual(deriveHealthVerdict({ healthy: false, recentFailures: 9 }), { ok: false, degraded: false, status: 'down' });
});

test('only failures inside the window degrade health; old and recovered failures age out', async () => {
  const now = new Date('2026-10-31T12:00:00.000Z');
  const events = [
    { status: 'failed', updatedAt: new Date(now.getTime() - 5 * MIN), resolvedStoreDomain: 'a.mysapo.net' },
    { status: 'failed', updatedAt: new Date(now.getTime() - (FAILURE_WINDOW_MINUTES + 5) * MIN), resolvedStoreDomain: 'a.mysapo.net' },
    { status: 'processed', updatedAt: new Date(now.getTime() - 1 * MIN), resolvedStoreDomain: 'a.mysapo.net' },
    { status: 'failed', updatedAt: new Date(now.getTime() - 2 * MIN), resolvedStoreDomain: 'b.mysapo.net' },
  ];
  const pendingRows = [
    { lastError: 'boom', updatedAt: new Date(now.getTime() - 3 * MIN), storeDomain: 'a.mysapo.net' },
    { lastError: null, updatedAt: new Date(now.getTime() - 3 * MIN), storeDomain: 'a.mysapo.net' },
    { lastError: 'old', updatedAt: new Date(now.getTime() - 3 * 60 * MIN), storeDomain: 'a.mysapo.net' },
  ];
  const prisma = {
    webhookEvent: { count: async ({ where }: { where: Where }) => events.filter((r) => matches(r, where)).length },
    metafieldSyncPending: { count: async ({ where }: { where: Where }) => pendingRows.filter((r) => matches(r, where)).length },
  };
  const db = fake<Pick<PrismaService, 'webhookEvent' | 'metafieldSyncPending'>>(prisma);
  assert.equal(await countRecentFailures(db, { now }), 3);
  assert.equal(await countRecentFailures(db, { now, storeDomain: 'a.mysapo.net' }), 2);
  assert.equal(await countRecentFailures(db, { now: new Date(now.getTime() + 3 * 60 * MIN) }), 0);
});

test('storefront rating metafields: zero reviews yield count 0 (no rating), N reviews yield scalars within the size budget', () => {
  const empty = buildSummaryMetafields({ avg: 0, count: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } });
  const byKey = (list: SummaryMetafield[]): Record<string, SummaryMetafield> => Object.fromEntries(list.map((m) => [m.key, m]));
  assert.equal(byKey(empty).rating_count.value, 0);
  assert.equal(byKey(empty).rating_count.value_type, 'integer');
  assert.equal(byKey(empty).rating_avg.value, '0');

  const many = buildSummaryMetafields({ avg: 4.6, count: 12345, distribution: { 1: 100, 2: 200, 3: 300, 4: 4000, 5: 7745 } });
  assert.equal(byKey(many).rating_count.value, 12345);
  assert.equal(byKey(many).rating_avg.value, '4.6');
  assert.equal(byKey(many).rating_avg.value_type, 'string');
  const summary = JSON.parse(String(byKey(many).public_summary.value)) as { avg: number; count: number };
  assert.deepEqual([summary.avg, summary.count], [4.6, 12345]);
  for (const mf of many) {
    assert.ok(Buffer.byteLength(String(mf.value)) <= 120, `${mf.key} stays small`);
    assert.ok(['string', 'integer'].includes(mf.value_type), 'Sapo only accepts string and integer');
  }
  assert.equal(byKey(buildSummaryMetafields({ avg: 5, count: 1, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 } })).rating_avg.value, '5.0');
});

type CatalogRow = { id: string; shopId: string; productId: string; source: string; deletedAt: unknown };

const makeCatalogDb = (count: number) => {
  const rows: CatalogRow[] = Array.from({ length: count }, (_, i) => ({
    id: `c_${String(i).padStart(5, '0')}`,
    shopId: 'shop_1',
    productId: String(i),
    source: 'sapo',
    deletedAt: null,
  }));
  const queries: Where[] = [];
  return {
    rows,
    queries,
    catalogProduct: {
      findMany: async ({ where, take }: { where: Where; orderBy?: unknown; take: number }) => {
        queries.push(where);
        return rows.filter((r) => matches(r, where)).sort(byId).slice(0, take);
      },
      updateMany: async ({ where, data }: { where: Where; data: Where }) => {
        const hit = rows.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      },
    },
  };
};

test('stale product reconcile pages by keyset, deletes only what is missing and never uses a giant NOT IN', async () => {
  const db = makeCatalogDb(1300);
  const store = new CatalogProductStoreService(fake<PrismaService>(db));
  const present = Array.from({ length: 1300 }, (_, i) => String(i)).filter((id) => Number(id) % 100 !== 0);
  const marked = await store.markMissingSapoProductsDeleted('shop_1', present, 1234);
  assert.equal(marked, 13);
  assert.deepEqual(
    db.rows.filter((r) => r.deletedAt !== null).map((r) => r.productId),
    ['0', '100', '200', '300', '400', '500', '600', '700', '800', '900', '1000', '1100', '1200'],
  );
  assert.ok(db.queries.every((q) => !('productId' in q)), 'no NOT IN list on productId');
  assert.ok(db.queries.length >= 3, 'scanned in chunks');
});

test('a truncated backfill never soft-deletes products it did not enumerate', async () => {
  const deleted: number[] = [];
  const catalogStore = {
    normalizeSapoProduct: (shopId: string, product: { id: number }) => ({ shopId, productId: String(product.id) }),
    upsertProducts: async () => {},
    markMissingSapoProductsDeleted: async (shopId: string, ids: string[]) => { deleted.push(ids.length); return 0; },
  };
  const prisma = { appInstall: { findUnique: async () => ({ shopId: 'shop_1' }) } };

  let nextId = 1;
  const endlessApi = {
    getProductsCount: async () => null,
    getProducts: async () => Array.from({ length: 250 }, () => ({ id: nextId++ })),
  };
  const truncated = await new CatalogSyncService(fake<SapoApiService>(endlessApi), fake<CatalogProductStoreService>(catalogStore), fake<PrismaService>(prisma)).backfillStore('demo.mysapo.net', 'tok');
  assert.equal(truncated.stopReason, 'max_pages');
  assert.deepEqual(deleted, [], 'max_pages is incomplete, absence proves nothing');

  const smallApi = {
    getProductsCount: async () => 3,
    getProducts: async () => [{ id: 1 }, { id: 2 }, { id: 3 }],
  };
  const complete = await new CatalogSyncService(fake<SapoApiService>(smallApi), fake<CatalogProductStoreService>(catalogStore), fake<PrismaService>(prisma)).backfillStore('demo.mysapo.net', 'tok');
  assert.equal(complete.stopReason, 'completed');
  assert.deepEqual(deleted, [3]);
});

const runBackfill = async (api: { getProductsCount: () => Promise<number | null>; getProducts: (...args: unknown[]) => Promise<Array<{ id: number }>> }) => {
  const deleted: number[] = [];
  const catalogStore = {
    normalizeSapoProduct: (shopId: string, product: { id: number }) => ({ shopId, productId: String(product.id) }),
    upsertProducts: async () => {},
    markMissingSapoProductsDeleted: async (_shopId: string, ids: string[]) => { deleted.push(ids.length); return 0; },
  };
  const prisma = { appInstall: { findUnique: async () => ({ shopId: 'shop_1' }) } };
  const result = await new CatalogSyncService(fake<SapoApiService>(api), fake<CatalogProductStoreService>(catalogStore), fake<PrismaService>(prisma)).backfillStore('demo.mysapo.net', 'tok');
  return { result, deleted };
};

test('backfill completion counts distinct products, so duplicate rows do not end the run early and delete live products', async () => {
  const pages: number[] = [];
  const { result, deleted } = await runBackfill({
    getProductsCount: async () => 240,
    getProducts: async (...args: unknown[]) => {
      const { page } = args[2] as { page: number };
      pages.push(page);
      return page === 1
        ? Array.from({ length: 250 }, (_, i) => ({ id: (i % 200) + 1 }))
        : Array.from({ length: 60 }, (_, i) => ({ id: 201 + i }));
    },
  });
  assert.deepEqual(pages, [1, 2]);
  assert.equal(result.stopReason, 'completed');
  assert.equal(result.synced, 310);
  assert.deepEqual(deleted, [260]);
});

test('backfill never soft-deletes when the enumerated distinct products fall short of the reported count', async () => {
  const short = await runBackfill({
    getProductsCount: async () => 4,
    getProducts: async () => [{ id: 1 }, { id: 2 }, { id: 2 }, { id: 3 }],
  });
  assert.equal(short.result.stopReason, 'completed');
  assert.deepEqual(short.deleted, [], 'three distinct products against a count of four proves nothing');

  const paged = await runBackfill({
    getProductsCount: async () => 240,
    getProducts: async (...args: unknown[]) => {
      const { page } = args[2] as { page: number };
      return page === 1 ? Array.from({ length: 250 }, (_, i) => ({ id: (i % 200) + 1 })) : [];
    },
  });
  assert.equal(paged.result.stopReason, 'empty_page');
  assert.deepEqual(paged.deleted, []);

  const unknownCount = await runBackfill({
    getProductsCount: async () => null,
    getProducts: async () => [{ id: 1 }, { id: 2 }],
  });
  assert.equal(unknownCount.result.stopReason, 'completed');
  assert.deepEqual(unknownCount.deleted, [2]);
});
