import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { AppEnv } from '../src/config/env.schema';
import type { PrismaService } from '../src/database/prisma.service';
import { DurabilitySweepService } from '../src/ops/durability-sweep.service';
import { PurchaseStoreService, isEligiblePurchaseStatus } from '../src/purchase/purchase-store.service';
import { SapoApiService } from '../src/sapo/sapo-api.service';
import { UninstallService } from '../src/sapo/uninstall.service';
import { WebhookRegistrationService } from '../src/sapo/webhook-registration.service';
import { WebhookService } from '../src/sapo/webhook.service';
import type { MediaService } from '../src/media/media.service';
import { normalizeWebhookTopic } from '../src/sapo/webhook-topic-normalizer';

const cast = <T>(value: unknown): T => value as T;

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const env = cast<AppEnv>({ DATA_ENCRYPTION_KEY: ENCRYPTION_KEY, API_BASE_URL: 'https://app.test/', NODE_ENV: 'test' });
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const ORDER = {
  id: 5001,
  order_number: 'SO5001',
  financial_status: 'paid',
  created_on: '2026-10-01T00:00:00Z',
  modified_on: '2026-10-02T00:00:00Z',
  customer: { email: 'Buyer@Example.com', phone: '+84 912 345 678' },
  line_items: [{ product_id: 11 }, { product_id: 12 }, { product_id: 11 }],
};

const makePurchases = (prisma: unknown = {}): PurchaseStoreService =>
  new PurchaseStoreService(cast<PrismaService>(prisma), env);

test('normalizeOrder reads *_on names, writes v2 HMAC hashes and tracks the source update time', () => {
  const rows = makePurchases().normalizeOrder('shop_1', ORDER);
  assert.deepEqual(rows.map((row) => row.productId), ['11', '12']);
  const [row] = rows;
  assert.equal(row.hashVersion, 2);
  assert.match(row.emailHash ?? '', /^[a-f0-9]{64}$/);
  assert.notEqual(row.emailHash, sha256('buyer@example.com'));
  assert.notEqual(row.phoneHash, sha256('0912345678'));
  assert.equal(row.sourceUpdatedAt, BigInt(Date.parse('2026-10-02T00:00:00Z')));
  assert.equal(row.purchasedAt, BigInt(Date.parse('2026-10-01T00:00:00Z')));
  assert.equal(row.cancelledAt, null);
  assert.equal(isEligiblePurchaseStatus(row), true);

  const cancelled = makePurchases().normalizeOrder('shop_1', { ...ORDER, cancelled_on: '2026-10-03T00:00:00Z' });
  assert.notEqual(cancelled[0].cancelledAt, null);
  assert.equal(isEligiblePurchaseStatus(cancelled[0]), false);
});

test('normalizeOrder falls back to billing_address identity and skips orders with no identity', () => {
  const service = makePurchases();
  const billed = service.normalizeOrder('shop_1', {
    id: 7,
    created_at: '2026-10-01T00:00:00Z',
    billing_address: { email: 'buyer@example.com' },
    line_items: [{ product_id: 1 }],
  });
  assert.equal(billed.length, 1);
  assert.equal(billed[0].emailHash, service.normalizeOrder('shop_1', ORDER)[0].emailHash);
  assert.deepEqual(service.normalizeOrder('shop_1', { id: 8, line_items: [{ product_id: 1 }] }), []);
});

test('normalizeOrder prefers modified_on for the update time and *_at over *_on for the other timestamps', () => {
  const service = makePurchases();
  const mixed = {
    id: 9001,
    order_number: 'SO9001',
    financial_status: 'paid',
    created_at: '2026-10-05T00:00:00Z',
    created_on: '2026-10-01T00:00:00Z',
    modified_on: '2026-10-06T00:00:00Z',
    updated_at: '2026-10-07T00:00:00Z',
    customer: { email: 'Buyer@Example.com', phone: '0912345678' },
    line_items: [{ product_id: 21 }],
  };
  const [row] = service.normalizeOrder('shop_1', { order: mixed });
  assert.equal(row.purchasedAt, BigInt(Date.parse('2026-10-05T00:00:00Z')));
  assert.equal(row.sourceUpdatedAt, BigInt(Date.parse('2026-10-06T00:00:00Z')));
  assert.equal(row.emailHash, service.normalizeOrder('shop_1', ORDER)[0].emailHash);
  assert.equal(isEligiblePurchaseStatus(row), true);

  const cancelledAt = service.normalizeOrder('shop_1', { ...mixed, cancelled_at: '2026-10-08T00:00:00Z' })[0];
  assert.equal(cancelledAt.cancelledAt, BigInt(Date.parse('2026-10-08T00:00:00Z')));
  assert.equal(isEligiblePurchaseStatus(cancelledAt), false);

  const refundedOn = service.normalizeOrder('shop_1', { ...mixed, refunded_on: '2026-10-08T00:00:00Z' })[0];
  assert.equal(refundedOn.refundedAt, BigInt(Date.parse('2026-10-08T00:00:00Z')));
  assert.equal(isEligiblePurchaseStatus(refundedOn), false);
});

test('normalizeOrder falls back to updated_at, then updated_on, when modified_on is absent', () => {
  const service = makePurchases();
  const base = { id: 9002, financial_status: 'paid', created_at: '2026-10-05T00:00:00Z', customer: { email: 'buyer@example.com' }, line_items: [{ product_id: 21 }] };
  const both = service.normalizeOrder('shop_1', { ...base, updated_on: '2026-10-06T00:00:00Z', updated_at: '2026-10-07T00:00:00Z' })[0];
  assert.equal(both.sourceUpdatedAt, BigInt(Date.parse('2026-10-07T00:00:00Z')));
  const onlyOn = service.normalizeOrder('shop_1', { ...base, updated_on: '2026-10-06T00:00:00Z' })[0];
  assert.equal(onlyOn.sourceUpdatedAt, BigInt(Date.parse('2026-10-06T00:00:00Z')));
});

test('the stored orders/* projection carries no buyer PII and still normalizes to the same rows', () => {
  const service = makePurchases();
  const stored = service.toStoredOrder({
    ...ORDER,
    note: 'leave at the door',
    billing_address: { name: 'Nguyen Van A', address1: '1 Example Street', phone: '0912345678' },
  });
  const text = JSON.stringify(stored).toLowerCase();
  for (const leak of ['buyer', 'example.com', 'nguyen', 'example street', '0912', '912 345', 'leave at the door']) {
    assert.ok(!text.includes(leak), `projection leaked ${leak}`);
  }
  const fromStored = service.normalizeOrder('shop_1', cast<Record<string, unknown>>(stored));
  const fromOrder = service.normalizeOrder('shop_1', ORDER);
  assert.equal(fromStored.length, fromOrder.length);
  assert.equal(fromStored[0].emailHash, fromOrder[0].emailHash);
  assert.equal(fromStored[0].phoneHash, fromOrder[0].phoneHash);
  assert.equal(fromStored[0].sourceUpdatedAt, fromOrder[0].sourceUpdatedAt);
  assert.equal(fromStored[0].purchasedAt, fromOrder[0].purchasedAt);
});

test('the stored projection keeps modified_on so a replay from the stored payload retains the ordering signal', () => {
  const service = makePurchases();
  const stored = cast<Record<string, unknown>>(service.toStoredOrder(ORDER));
  assert.equal(stored.modified_on, '2026-10-02T00:00:00Z');
  assert.equal(service.normalizeOrder('shop_1', stored)[0].sourceUpdatedAt, BigInt(Date.parse('2026-10-02T00:00:00Z')));
});

test('hasPurchasedProduct matches both the legacy sha256 and the v2 HMAC hash', async () => {
  type Where = { OR: Array<{ emailHash?: { in: string[] }; phoneHash?: { in: string[] } }> };
  const captured: { where?: Where } = {};
  const service = makePurchases({
    customerPurchase: {
      findMany: async (args: { where: Where }) => {
        captured.where = args.where;
        return [{ financialStatus: 'paid', fulfillmentStatus: null, cancelledAt: null, refundedAt: null }];
      },
    },
  });
  assert.equal(await service.hasPurchasedProduct('shop_1', '11', { email: ' Buyer@Example.com ', phone: '0912345678' }), true);
  const v2Email = service.normalizeOrder('shop_1', ORDER)[0].emailHash;
  const matchers = captured.where?.OR ?? [];
  const emailMatcher = matchers.find((entry) => entry.emailHash)?.emailHash?.in ?? [];
  const phoneMatcher = matchers.find((entry) => entry.phoneHash)?.phoneHash?.in ?? [];
  assert.ok(emailMatcher.includes(sha256('buyer@example.com')));
  assert.ok(emailMatcher.includes(v2Email ?? ''));
  assert.ok(phoneMatcher.includes(sha256('0912345678')));
  assert.equal(await service.hasPurchasedProduct('shop_1', '11', {}), false);
});

type FakeTx = {
  upserts: Array<{ create: { productId: string } }>;
  deletes: Array<{ where: { productId: { notIn: string[] } } }>;
};

const makeOrderPrisma = (storedAt: bigint | null): { prisma: unknown; calls: FakeTx } => {
  const calls: FakeTx = { upserts: [], deletes: [] };
  const tx = {
    $executeRaw: async () => 1,
    customerPurchase: {
      aggregate: async () => ({ _max: { sourceUpdatedAt: storedAt } }),
      deleteMany: async (args: FakeTx['deletes'][number]) => {
        calls.deletes.push(args);
        return { count: 1 };
      },
      upsert: async (args: FakeTx['upserts'][number]) => {
        calls.upserts.push(args);
        return {};
      },
    },
  };
  return { prisma: { $transaction: async (run: (client: typeof tx) => Promise<boolean>) => run(tx) }, calls };
};

test('a replayed order older than the stored one does not touch purchase rows', async () => {
  const { prisma, calls } = makeOrderPrisma(BigInt(Date.parse('2026-10-03T00:00:00Z')));
  assert.equal(await makePurchases(prisma).syncOrder({ shopId: 'shop_1', order: ORDER }), 0);
  assert.equal(calls.upserts.length, 0);
  assert.equal(calls.deletes.length, 0);
});

test('a newer order update upserts its rows and deletes rows for dropped line items', async () => {
  const { prisma, calls } = makeOrderPrisma(BigInt(Date.parse('2026-10-01T12:00:00Z')));
  assert.equal(await makePurchases(prisma).syncOrder({ shopId: 'shop_1', order: ORDER }), 2);
  assert.deepEqual(calls.upserts.map((call) => call.create.productId), ['11', '12']);
  assert.deepEqual(calls.deletes[0].where.productId.notIn, ['11', '12']);
});

type StoredRow = { financialStatus: string | null; cancelledAt: bigint | null; sourceUpdatedAt: bigint | null };

const makeStatefulOrderPrisma = (): { prisma: unknown; rows: Map<string, StoredRow> } => {
  const rows = new Map<string, StoredRow>();
  const tx = {
    $executeRaw: async () => 1,
    customerPurchase: {
      aggregate: async () => {
        const stamps = [...rows.values()].map((row) => row.sourceUpdatedAt).filter((value): value is bigint => value !== null);
        return { _max: { sourceUpdatedAt: stamps.length ? stamps.reduce((a, b) => (a > b ? a : b)) : null } };
      },
      deleteMany: async ({ where }: { where: { productId: { notIn: string[] } } }) => {
        for (const productId of [...rows.keys()]) if (!where.productId.notIn.includes(productId)) rows.delete(productId);
        return { count: 0 };
      },
      upsert: async ({ create, update }: { create: Record<string, unknown> & { productId: string }; update: Record<string, unknown> }) => {
        const existing = rows.get(create.productId);
        const next = existing ? { ...existing, ...update } : { ...create };
        rows.set(create.productId, cast<StoredRow>(next));
        return {};
      },
    },
  };
  return { prisma: { $transaction: async (run: (client: typeof tx) => Promise<boolean>) => run(tx) }, rows };
};

test('a stale orders/paid carrying only modified_on cannot overwrite an orders/cancelled state', async () => {
  const { prisma, rows } = makeStatefulOrderPrisma();
  const service = makePurchases(prisma);
  const base = {
    id: 7001,
    created_on: '2026-10-01T00:00:00Z',
    customer: { email: 'buyer@example.com' },
    line_items: [{ product_id: 31 }],
  };
  const paid = { ...base, financial_status: 'paid', modified_on: '2026-10-02T00:00:00Z' };
  const cancelled = { ...base, financial_status: 'voided', cancelled_on: '2026-10-04T00:00:00Z', modified_on: '2026-10-04T00:00:00Z' };

  assert.equal(await service.syncOrder({ shopId: 'shop_1', order: paid }), 1);
  assert.equal(await service.syncOrder({ shopId: 'shop_1', order: cancelled }), 1);
  assert.notEqual(rows.get('31')?.cancelledAt, null);

  assert.equal(await service.syncOrder({ shopId: 'shop_1', order: paid }), 0);
  const row = rows.get('31');
  assert.notEqual(row?.cancelledAt, null);
  assert.equal(row?.financialStatus, 'voided');
  assert.equal(row?.sourceUpdatedAt, BigInt(Date.parse('2026-10-04T00:00:00Z')));
  assert.equal(isEligiblePurchaseStatus(row ?? {}), false);

  const storedReplay = cast<Record<string, unknown>>(service.toStoredOrder(paid));
  assert.equal(await service.syncOrder({ shopId: 'shop_1', order: storedReplay }), 0);
  assert.notEqual(rows.get('31')?.cancelledAt, null);
});

test('getAudit counts distinct orders with one aggregate query instead of loading rows', async () => {
  const sql: Array<{ text: string; values: unknown[] }> = [];
  const calls: string[] = [];
  const service = makePurchases({
    customerPurchase: {
      count: async () => { calls.push('count'); return 9; },
      findMany: async () => { calls.push('findMany'); return []; },
      findFirst: async () => ({ updatedAt: 1760000000000n }),
    },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      sql.push({ text: strings.join('?'), values });
      return [{ orders: 4n }];
    },
  });
  assert.deepEqual(await service.getAudit('shop_1'), { total: 9, orders: 4, lastUpdated: 1760000000000 });
  assert.ok(!calls.includes('findMany'));
  assert.equal(sql.length, 1);
  assert.match(sql[0].text, /COUNT\(DISTINCT "order_id"\)/);
  assert.match(sql[0].text, /"shop_id" = \?/);
  assert.deepEqual(sql[0].values, ['shop_1']);

  const empty = makePurchases({
    customerPurchase: { count: async () => 0, findFirst: async () => null },
    $queryRaw: async () => [],
  });
  assert.deepEqual(await empty.getAudit('shop_2'), { total: 0, orders: 0, lastUpdated: null });
});

test('removed charge topics no longer normalize to a billing topic', () => {
  assert.equal(normalizeWebhookTopic('app_charge_update'), 'unknown');
  assert.equal(normalizeWebhookTopic('app/charge'), 'unknown');
});

type CreatedEvent = { idempotencyKey: string; providerEventId?: string; payload: Record<string, unknown> };
type Install = { shopId: string; status: string; lifecycleGeneration: number } | null;

const makeWebhooks = (install: Install, overrides: { domains?: string[]; ownerOf?: (domain: string) => string | null; foreignIds?: boolean } = {}) => {
  const created: CreatedEvent[] = [];
  const updates: Array<Record<string, unknown>> = [];
  const catalogCalls: string[] = [];
  const upserts: Array<Record<string, unknown>> = [];
  const mapped: string[] = [];
  const prisma = {
    appInstall: { findUnique: async () => install },
    catalogProduct: {
      findFirst: async ({ where }: { where: { shopId: unknown } }) =>
        overrides.foreignIds && typeof where.shopId === 'object' ? { id: 'foreign' } : null,
    },
    customerPurchase: {
      findFirst: async ({ where }: { where: { shopId: unknown } }) =>
        overrides.foreignIds && typeof where.shopId === 'object' ? { id: 'foreign' } : null,
    },
    shopDomain: { upsert: async (args: Record<string, unknown>) => { upserts.push(args); return {}; } },
    webhookEvent: {
      create: async ({ data }: { data: CreatedEvent }) => {
        created.push(data);
        return { id: `evt_${created.length}`, status: 'received' };
      },
      update: async ({ data }: { data: Record<string, unknown> }) => { updates.push(data); return {}; },
      findUnique: async () => null,
    },
  };
  const purchases = makePurchases();
  const service = new WebhookService(
    cast<PrismaService>(prisma),
    cast({ verifyWebhookBody: () => undefined }),
    cast({
      collectDomains: () => overrides.domains ?? [],
      resolveStoreDomain: async (domain: string) => (overrides.ownerOf ? overrides.ownerOf(domain) : null),
      saveMapping: async (_store: string, domain: string) => { mapped.push(domain); },
    }),
    cast({ uninstall: async (storeDomain: string) => ({ storeDomain, uninstalled: true, domainsCleared: 0 }) }),
    cast({ resolveAccessToken: async () => 'token' }),
    cast({ handleProductWebhookWithToken: async (_store: string, productId: string) => { catalogCalls.push(productId); } }),
    cast({
      toStoredOrder: purchases.toStoredOrder.bind(purchases),
      syncOrder: async () => 1,
    }),
  );
  return { service, created, updates, catalogCalls, upserts, mapped };
};

const webhookInput = (topic: string, body: Record<string, unknown>, headers: Record<string, string> = {}) => ({
  headers: { 'x-sapo-topic': topic, 'x-sapo-hmac-sha256': 'sig', ...headers },
  query: {},
  body: { store_domain: 'demo.mysapo.net', ...body },
  rawBody: Buffer.from('{}'),
});

test('app/uninstalled idempotency key changes with the install lifecycle generation', async () => {
  const keys: string[] = [];
  for (const lifecycleGeneration of [1, 1, 2]) {
    const { service, created } = makeWebhooks({ shopId: 's1', status: 'active', lifecycleGeneration });
    await service.handle(webhookInput('app/uninstalled', { id: 1 }));
    keys.push(created[0].idempotencyKey);
  }
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[1], keys[2]);
});

test('product events keep the generation-free key; x-sapo-event-id is the provider id only when non-empty', async () => {
  const first = makeWebhooks({ shopId: 's1', status: 'active', lifecycleGeneration: 1 });
  await first.service.handle(webhookInput('products/update', { id: 100 }, { 'x-sapo-event-id': '', 'x-request-id': 'req-1' }));
  const second = makeWebhooks({ shopId: 's1', status: 'active', lifecycleGeneration: 9 });
  await second.service.handle(webhookInput('products/update', { id: 100 }, { 'x-request-id': 'req-2' }));
  assert.equal(first.created[0].providerEventId, undefined);
  assert.equal(first.created[0].idempotencyKey, second.created[0].idempotencyKey);

  const withId = makeWebhooks({ shopId: 's1', status: 'active', lifecycleGeneration: 1 });
  await withId.service.handle(webhookInput('products/update', { id: 100 }, { 'x-sapo-event-id': 'evt-42' }));
  assert.equal(withId.created[0].providerEventId, 'evt-42');
  assert.match(withId.created[0].idempotencyKey, /^provider:products\/update:store:demo\.mysapo\.net:evt-42$/);
});

test('orders/* payload is stored as a PII-free projection while the sync receives the full order', async () => {
  const { service, created } = makeWebhooks({ shopId: 's1', status: 'active', lifecycleGeneration: 1 });
  await service.handle(webhookInput('orders/paid', { ...ORDER, billing_address: { name: 'Nguyen Van A' } }));
  const stored = JSON.stringify(created[0].payload).toLowerCase();
  assert.ok(!stored.includes('buyer@example.com'));
  assert.ok(!stored.includes('nguyen'));
  assert.ok(stored.includes('email_hash'));
});

test('webhooks for an uninstalled install are ignored and never call the catalog', async () => {
  const { service, updates, catalogCalls } = makeWebhooks({ shopId: 's1', status: 'uninstalled', lifecycleGeneration: 4 });
  const result = await service.handle(webhookInput('products/update', { id: 100 }));
  assert.equal(result.ignored, true);
  assert.equal(updates[updates.length - 1].status, 'ignored');
  assert.deepEqual(catalogCalls, []);
});

test('a needs_reinstall install still runs product events so a revoked token retries', async () => {
  const { service, catalogCalls } = makeWebhooks({ shopId: 's1', status: 'needs_reinstall', lifecycleGeneration: 2 });
  const result = await service.handle(webhookInput('products/update', { id: 100 }));
  assert.equal(result.ok, true);
  assert.deepEqual(catalogCalls, ['100']);
});

test('ids that exist only under another store are rejected before an event is stored', async () => {
  const deleted = makeWebhooks({ shopId: 's1', status: 'active', lifecycleGeneration: 1 }, { foreignIds: true });
  await assert.rejects(() => deleted.service.handle(webhookInput('products/delete', { id: 100 })), BadRequestException);
  assert.equal(deleted.created.length, 0);
  const ordered = makeWebhooks({ shopId: 's1', status: 'active', lifecycleGeneration: 1 }, { foreignIds: true });
  await assert.rejects(() => ordered.service.handle(webhookInput('orders/paid', ORDER)), BadRequestException);
});

test('store/update maps a newly seen domain and leaves domains owned by another store alone', async () => {
  const { service, upserts, mapped } = makeWebhooks(
    { shopId: 's1', status: 'active', lifecycleGeneration: 1 },
    {
      domains: ['demo.mysapo.net', 'new-shop.example.com', 'taken.example.com'],
      ownerOf: (domain) => (domain === 'demo.mysapo.net' ? 'demo.mysapo.net' : domain === 'taken.example.com' ? 'other.mysapo.net' : null),
    },
  );
  const result = await service.handle(webhookInput('store/update', { name: 'Demo' }));
  assert.equal(result.ok, true);
  assert.equal(upserts.length, 1);
  assert.deepEqual(upserts[0], {
    where: { id: 'demo.mysapo.net:new-shop.example.com' },
    create: { id: 'demo.mysapo.net:new-shop.example.com', shopId: 's1', storeDomain: 'demo.mysapo.net', domain: 'new-shop.example.com', kind: 'custom', active: true },
    update: { active: true, tombstonedAt: null, shopId: 's1', storeDomain: 'demo.mysapo.net' },
  });
  assert.deepEqual(mapped.sort(), ['demo.mysapo.net', 'new-shop.example.com']);
});

test('uninstall nulls payload and headers of the store events in the same transaction', async () => {
  const operations: Array<{ model: string; args: Record<string, unknown> }> = [];
  const op = (model: string) => async (args: Record<string, unknown>) => {
    operations.push({ model, args });
    return { count: 0 };
  };
  const prisma = {
    shopDomain: { findMany: async () => [{ domain: 'demo.mysapo.net' }], updateMany: op('shopDomain') },
    appInstall: { updateMany: op('appInstall') },
    webhookEvent: { updateMany: op('webhookEvent') },
    $transaction: async (queue: Array<Promise<unknown>>) => Promise.all(queue),
  };
  const service = new UninstallService(
    cast<PrismaService>(prisma),
    cast({ delMany: async () => 0 }),
    cast({ collectDomains: () => ['demo.mysapo.net'], domainKey: (domain: string) => `domain:${domain}` }),
    cast({ acquireLifecycleLock: async () => ({}), release: async () => undefined }),
    cast({ clearStoreHandoffs: async () => undefined }),
  );
  const result = await service.uninstall('demo.mysapo.net', {});
  assert.equal(result.uninstalled, true);
  const events = operations.find((entry) => entry.model === 'webhookEvent');
  assert.ok(events);
  assert.deepEqual(events.args.data, { payload: Prisma.DbNull, headers: Prisma.DbNull });
  assert.ok(operations.some((entry) => entry.model === 'appInstall'));
});

test('registerForInstall builds one URL without //api, reconciles stale addresses and persists the status', async () => {
  const deleted: string[] = [];
  const created: Array<{ topic: string; address: string }> = [];
  const persisted: Array<Record<string, unknown>> = [];
  const service = new WebhookRegistrationService(
    cast<SapoApiService>({
      getWebhooks: async () => [
        { id: 1, topic: 'products/create', address: 'https://old.example.com/api/oauth/install/webhooks' },
        { id: 2, topic: 'products/update', address: 'https://app.test/api/oauth/install/webhooks' },
        { id: 3, topic: 'products/delete', address: 'https://other.example.com/unrelated' },
      ],
      deleteWebhook: async (_store: string, _token: string, id: string) => { deleted.push(id); },
      createWebhook: async (_store: string, _token: string, topic: string, address: string) => {
        created.push({ topic, address });
        return { id: 99, topic, address };
      },
    }),
    env,
    cast<PrismaService>({ appInstall: { updateMany: async ({ data }: { data: Record<string, unknown> }) => { persisted.push(data); return { count: 1 }; } } }),
  );
  const result = await service.registerForInstall('demo.mysapo.net', 'token');
  assert.equal(result.status, 'registered');
  assert.deepEqual(deleted, ['1']);
  assert.ok(!created.some((entry) => entry.topic === 'products/update'));
  assert.equal(created.length, 9);
  assert.ok(created.every((entry) => entry.address === 'https://app.test/api/oauth/install/webhooks'));
  assert.equal(persisted[0].webhookRegistrationStatus, 'registered');
});

test('registerForInstall reports degraded when one topic cannot be created', async () => {
  const persisted: Array<Record<string, unknown>> = [];
  const service = new WebhookRegistrationService(
    cast<SapoApiService>({
      getWebhooks: async () => [],
      deleteWebhook: async () => undefined,
      createWebhook: async (_store: string, _token: string, topic: string) => {
        if (topic === 'orders/paid') throw new BadRequestException({ message: 'Sapo create webhook failed', status: 422 });
        return { id: 1, topic, address: '' };
      },
    }),
    env,
    cast<PrismaService>({ appInstall: { updateMany: async ({ data }: { data: Record<string, unknown> }) => { persisted.push(data); return { count: 1 }; } } }),
  );
  const result = await service.registerForInstall('demo.mysapo.net', 'token');
  assert.equal(result.status, 'degraded');
  assert.match(result.error ?? '', /orders\/paid/);
  assert.equal(persisted[0].webhookRegistrationStatus, 'degraded');
});

test('createWebhook treats 409/422 as success only when the webhook is really listed', async () => {
  const originalFetch = globalThis.fetch;
  const listed = [{ id: 5, topic: 'products/create', address: 'https://app.test/api/oauth/install/webhooks/' }];
  let list: unknown[] = listed;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) =>
    init?.method === 'POST'
      ? new Response('{}', { status: 409 })
      : new Response(JSON.stringify({ webhooks: list }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  try {
    const api = new SapoApiService(cast<AppEnv>({ SAPO_API_MAX_CONCURRENT: 2 }));
    const found = await api.createWebhook('demo.mysapo.net', 'token', 'products/create', 'https://app.test/api/oauth/install/webhooks');
    assert.equal(found.id, 5);
    list = [];
    await assert.rejects(() => api.createWebhook('demo.mysapo.net', 'token', 'products/create', 'https://app.test/api/oauth/install/webhooks'), BadRequestException);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const SWEEP_NOW = new Date('2027-01-15T00:00:00.000Z');
const DAY = 24 * 60 * 60_000;
const daysBefore = (days: number): Date => new Date(SWEEP_NOW.getTime() - days * DAY);

const makeRetentionSweep = (prisma: unknown): DurabilitySweepService =>
  new DurabilitySweepService(
    env,
    cast({ acquireLock: async () => ({}), releaseLock: async () => true, isConfigured: false }),
    cast({ reconcilePendingSummaries: async () => ({ processed: 0, synced: 0, failed: 0, deferred: 0 }) }),
    cast({ reclaimStalled: async () => ({ reclaimed: 0, failed: 0 }), retryDueFailed: async () => ({ attempted: 0, succeeded: 0, failed: 0 }) }),
    cast({ resolveAccessToken: async () => 'token' }),
    cast<PrismaService>(prisma),
    cast<MediaService>({ storageConfigured: false }),
  );

const runSweepAt = async (sweep: DurabilitySweepService) => {
  mock.timers.enable({ apis: ['Date'], now: SWEEP_NOW });
  try {
    return await sweep.runOnce();
  } finally {
    mock.timers.reset();
  }
};

type RetentionCapture = {
  eventFinds: Array<Record<string, unknown>>;
  eventDeletes: Array<Record<string, unknown>>;
  installFinds: Array<Record<string, unknown>>;
  txInstallFinds: Array<Record<string, unknown>>;
  purchaseDeletes: Array<Record<string, unknown>>;
  txEventDeletes: Array<Record<string, unknown>>;
};

const makeRetentionPrisma = (stillEligible: boolean): { prisma: unknown; capture: RetentionCapture } => {
  const capture: RetentionCapture = {
    eventFinds: [],
    eventDeletes: [],
    installFinds: [],
    txInstallFinds: [],
    purchaseDeletes: [],
    txEventDeletes: [],
  };
  const tx = {
    appInstall: {
      findFirst: async (args: Record<string, unknown>) => {
        capture.txInstallFinds.push(args);
        return stillEligible ? { id: 'inst_1' } : null;
      },
    },
    customerPurchase: {
      deleteMany: async (args: Record<string, unknown>) => {
        capture.purchaseDeletes.push(args);
        return { count: 3 };
      },
    },
    webhookEvent: {
      deleteMany: async (args: Record<string, unknown>) => {
        capture.txEventDeletes.push(args);
        return { count: 2 };
      },
    },
  };
  const prisma = {
    webhookEvent: {
      findMany: async (args: Record<string, unknown>) => {
        capture.eventFinds.push(args);
        return [{ id: `e${capture.eventFinds.length}` }];
      },
      deleteMany: async (args: Record<string, unknown>) => {
        capture.eventDeletes.push(args);
        return { count: 1 };
      },
    },
    appInstall: {
      findMany: async (args: Record<string, unknown>) => {
        capture.installFinds.push(args);
        return [{ id: 'inst_1', shopId: 'shop_1', storeDomain: 'gone.mysapo.net' }];
      },
    },
    $transaction: async (run: (client: typeof tx) => Promise<unknown>) => run(tx),
  };
  return { prisma, capture };
};

test('the sweep prunes finished events by the 30/90 day cutoffs and never touches failed events that can still retry', async () => {
  const { prisma, capture } = makeRetentionPrisma(true);
  const report = await runSweepAt(makeRetentionSweep(prisma));
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.webhookRetention, { deleted: 2 });

  const doneFilter = { status: { in: ['processed', 'ignored'] }, updatedAt: { lt: daysBefore(30) } };
  const failedFilter = { status: 'failed', nextRetryAt: null, updatedAt: { lt: daysBefore(90) } };
  assert.deepEqual(capture.eventFinds.map((args) => args.where), [doneFilter, failedFilter]);
  assert.deepEqual(capture.eventDeletes.map((args) => args.where), [
    { AND: [doneFilter, { id: { in: ['e1'] } }] },
    { AND: [failedFilter, { id: { in: ['e2'] } }] },
  ]);
});

test('the uninstall purge only selects installs uninstalled for 90 days and scopes deletes to that shop and store domain', async () => {
  const { prisma, capture } = makeRetentionPrisma(true);
  const report = await runSweepAt(makeRetentionSweep(prisma));
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.uninstallRetention, { shops: 1, purchases: 3, events: 2 });

  const eligible = { status: 'uninstalled', uninstalledAt: { lt: daysBefore(90) } };
  assert.equal(capture.installFinds.length, 1);
  assert.deepEqual(capture.installFinds[0].where, eligible);
  assert.deepEqual(capture.txInstallFinds.map((args) => args.where), [{ ...eligible, id: 'inst_1' }]);
  assert.deepEqual(capture.purchaseDeletes.map((args) => args.where), [{ shopId: 'shop_1' }]);
  assert.deepEqual(capture.txEventDeletes.map((args) => args.where), [
    { OR: [{ shopId: 'shop_1' }, { resolvedStoreDomain: 'gone.mysapo.net' }] },
  ]);
});

test('an install that is reinstalled between selection and purge keeps its purchases and events', async () => {
  const { prisma, capture } = makeRetentionPrisma(false);
  const report = await runSweepAt(makeRetentionSweep(prisma));
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.uninstallRetention, { shops: 0, purchases: 0, events: 0 });
  assert.equal(capture.txInstallFinds.length, 1);
  assert.deepEqual(capture.purchaseDeletes, []);
  assert.deepEqual(capture.txEventDeletes, []);
});
