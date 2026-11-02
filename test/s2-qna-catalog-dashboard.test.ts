import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';

import { QnaService } from '../src/qna/qna.service';
import { QnaStoreService } from '../src/qna/qna-store.service';
import type { QnaQuestionRecord } from '../src/qna/qna-store.service';
import { CatalogProductStoreService } from '../src/catalog/catalog-product-store.service';
import type { CatalogProductInput } from '../src/catalog/catalog-product-store.service';
import { CatalogSyncService } from '../src/catalog/catalog-sync.service';
import { DashboardService } from '../src/dashboard/dashboard.service';
import { OpsService } from '../src/ops/ops.service';
import { MetafieldSyncPendingService, PENDING_MAX_ATTEMPTS } from '../src/database/metafield-sync-pending.service';
import { PrismaService } from '../src/database/prisma.service';
import { deriveHealthVerdict } from '../src/health/health-verdict';
import { PUBLIC_MAX_OFFSET } from '../src/common/security/public-limits';
import { RedisService } from '../src/redis/redis.service';
import { ReviewService } from '../src/review/review.service';
import { ReviewProductStoreService } from '../src/review/review-product-store.service';
import { SapoApiService } from '../src/sapo/sapo-api.service';
import { SapoService } from '../src/sapo/sapo.service';
import { WebhookRegistrationService } from '../src/sapo/webhook-registration.service';
import type { WebhookRegistrationResult } from '../src/sapo/webhook-registration.service';
import { PurchaseStoreService } from '../src/purchase/purchase-store.service';
import { StorefrontService } from '../src/storefront/storefront.service';
import type { AppEnv } from '../src/config/env.schema';
import { fake } from './support/fakes';

const qnaRow = (overrides: Partial<QnaQuestionRecord> = {}): QnaQuestionRecord => ({
  id: 'row',
  shopId: 'shop_1',
  productId: 'p1',
  productTitle: 'Stale title',
  productName: null,
  productHandle: 'old-handle',
  productImage: null,
  questionId: 'q1',
  question: 'Is it waterproof?',
  author: 'An',
  email: null,
  phone: null,
  answer: null,
  answeredBy: null,
  status: 'pending',
  answeredAt: null,
  sourceRawJson: null,
  createdAt: 1n,
  updatedAt: 1n,
  ...overrides,
});

const hasStatus = (code: number) => (error: unknown): boolean =>
  error instanceof HttpException && error.getStatus() === code;

interface CatalogRow {
  id: string;
  shopId: string;
  productId: string;
  title: string;
  handle: string;
  image: string | null;
  vendor: string | null;
  productType: string | null;
  tags: string | null;
  status: string | null;
  published: boolean | null;
  deletedAt: bigint | null;
  rawPayload: unknown;
  source: string;
  createdAt: Date;
  updatedAt: bigint;
}
interface CatalogUpdateArgs {
  data: { deletedAt: bigint | null; updatedAt: bigint };
}

const makeCatalogDb = (existing: CatalogRow[] = []) => {
  const calls = { create: [] as unknown[], update: [] as CatalogUpdateArgs[] };
  const db = {
    catalogProduct: {
      findMany: async () => existing,
      create: (args: unknown) => { calls.create.push(args); return Promise.resolve(args); },
      update: (args: CatalogUpdateArgs) => { calls.update.push(args); return Promise.resolve(args); },
    },
    $transaction: (ops: Array<Promise<unknown>>) => Promise.all(ops),
  };
  return { db: fake<PrismaService>(db), calls };
};

const sapoRow = (overrides: Partial<CatalogProductInput> = {}): CatalogProductInput => ({
  shopId: 'shop_1',
  productId: '1001',
  title: 'Soap',
  handle: 'soap',
  rawPayload: { id: 1001 },
  source: 'sapo',
  updatedAt: 50,
  ...overrides,
});

const tombstone = (overrides: Partial<CatalogRow> = {}): CatalogRow => ({
  id: 'c1', shopId: 'shop_1', productId: '1001', title: 'Soap', handle: 'soap', image: null, vendor: null,
  productType: null, tags: null, status: null, published: null, deletedAt: 90n, rawPayload: null,
  source: 'webhook', createdAt: new Date(), updatedAt: 100n, ...overrides,
});

test('a live Sapo upsert revives a tombstoned product even when its updatedAt is older', async () => {
  const { db, calls } = makeCatalogDb([tombstone()]);
  await new CatalogProductStoreService(db).upsertProducts([sapoRow({ updatedAt: 50 })]);
  assert.equal(calls.update.length, 1);
  assert.equal(calls.update[0].data.deletedAt, null);
  assert.equal(calls.update[0].data.updatedAt, 100n, 'revival must not lower updatedAt below the tombstone stamp');
});

test('a stale webhook-sourced row can neither update nor undo a tombstone', async () => {
  const { db, calls } = makeCatalogDb([tombstone()]);
  await new CatalogProductStoreService(db).upsertProducts([sapoRow({ source: 'webhook', updatedAt: 50 })]);
  assert.equal(calls.update.length, 0);
});

test('a newer webhook-sourced row keeps the tombstone', async () => {
  const { db, calls } = makeCatalogDb([tombstone()]);
  await new CatalogProductStoreService(db).upsertProducts([sapoRow({ source: 'webhook', updatedAt: 500 })]);
  assert.equal(calls.update.length, 1);
  assert.equal(calls.update[0].data.deletedAt, 90n);
});

test('a live Sapo upsert on a live product still obeys the monotonic guard', async () => {
  const { db, calls } = makeCatalogDb([tombstone({ deletedAt: null, updatedAt: 100n })]);
  await new CatalogProductStoreService(db).upsertProducts([sapoRow({ updatedAt: 50 })]);
  assert.equal(calls.update.length, 0);
});

interface QnaQueryArgs {
  where: { AND?: Array<{ OR?: Array<Record<string, unknown>> }> } & Record<string, unknown>;
  take?: number;
  orderBy?: Array<Record<string, string>>;
}
interface CatalogLabelRow {
  productId: string;
  title: string;
  handle: string;
  image: string;
}

const makeQnaPrisma = (rows: QnaQuestionRecord[], labels: CatalogLabelRow[] = []) => {
  const calls = { findMany: [] as QnaQueryArgs[], count: [] as QnaQueryArgs[], groupBy: [] as QnaQueryArgs[] };
  const prisma = {
    appInstall: { findUnique: async () => ({ shopId: 'shop_1', status: 'active' }) },
    catalogProduct: { findMany: async () => labels },
    qnaQuestion: {
      groupBy: async (args: QnaQueryArgs) => {
        calls.groupBy.push(args);
        return [{ status: 'pending', _count: { _all: 3 } }, { status: 'hidden', _count: { _all: 1 } }, { status: 'approved', _count: { _all: 6 } }];
      },
      count: async (args: QnaQueryArgs) => { calls.count.push(args); return JSON.stringify(args.where).includes('"not":null') ? 4 : rows.length; },
      findMany: async (args: QnaQueryArgs) => { calls.findMany.push(args); return rows; },
    },
  };
  return { prisma: fake<PrismaService>(prisma), calls };
};

const makeQnaService = (prisma: PrismaService) =>
  new QnaService(prisma, fake<QnaStoreService>({}), fake<CatalogProductStoreService>({}), { enqueue: async () => 0 } as never);

test('qna admin list computes status counts with groupBy and prefers the catalog title', async () => {
  const { prisma, calls } = makeQnaPrisma([qnaRow()], [{ productId: 'p1', title: 'Fresh title', handle: 'fresh', image: 'https://cdn.test/i.jpg' }]);
  const service = makeQnaService(prisma);
  const page = await service.getAllQuestions('demo.mysapo.net', { page: 1, limit: 500 });
  assert.deepEqual(page.statusCounts, { all: 10, pending: 3, hidden: 1, answered: 4, unanswered: 6 });
  assert.equal(page.pageSize, 100);
  assert.equal(calls.groupBy.length, 1);
  assert.equal(calls.findMany.length, 1, 'only the requested page is loaded');
  assert.equal(calls.findMany[0].take, 100);
  assert.equal(page.items[0].productTitle, 'Fresh title');
  assert.equal(page.items[0].productHandle, 'fresh');
  assert.equal(page.items[0].productImage, 'https://cdn.test/i.jpg');
});

test('qna per-product list is paged, scoped and returns product-scoped counts', async () => {
  const { prisma, calls } = makeQnaPrisma([qnaRow()]);
  const page = await makeQnaService(prisma).getQuestions('demo.mysapo.net', '77', { page: 2, limit: 10, status: 'unanswered', sort: 'oldest' });
  assert.equal(page.pageSize, 10);
  assert.deepEqual(calls.groupBy[0].where, { shopId: 'shop_1', productId: '77' });
  const where = JSON.stringify(calls.findMany[0].where);
  assert.ok(where.includes('"productId":"77"'));
  assert.equal(calls.findMany[0].orderBy?.[0]?.createdAt, 'asc');
});

test('qna search composes with the unanswered filter instead of replacing it', async () => {
  const { prisma, calls } = makeQnaPrisma([qnaRow()]);
  await makeQnaService(prisma).getAllQuestions('demo.mysapo.net', { status: 'unanswered', search: 'water' });
  const and = calls.findMany[0].where.AND;
  assert.ok(and);
  assert.ok(and.some((c) => Array.isArray(c.OR) && c.OR.some((o) => o.answer === null)));
  assert.ok(and.some((c) => Array.isArray(c.OR) && c.OR.some((o) => o.question)));
});

test('public qna reads stop scanning past the offset cap but keep the true total', async () => {
  const { prisma, calls } = makeQnaPrisma([qnaRow()]);
  const page = Math.floor(PUBLIC_MAX_OFFSET / 20) + 5;
  const result = await makeQnaService(prisma).getPublicQuestions('demo.mysapo.net', 'p1', { page, limit: 20 });
  assert.equal(calls.findMany.length, 0);
  assert.deepEqual(result.items, []);
  assert.equal(result.page, page);
});

test('public qna reads below the offset cap are served and carry no contact PII', async () => {
  const { prisma, calls } = makeQnaPrisma([qnaRow({ email: 'a@b.co', phone: '0900000000', answer: 'Yes', status: 'approved' })]);
  const result = await makeQnaService(prisma).getPublicQuestions('demo.mysapo.net', 'p1', { page: 1, limit: 20 });
  assert.equal(calls.findMany.length, 1);
  assert.equal(result.items[0].email, undefined);
  assert.equal(result.items[0].phone, undefined);
});

interface PendingRow {
  attempts: number;
  lastError: string | null;
  nextAttemptAt: Date;
}

const makePendingDb = (attempts: number) => {
  const row: PendingRow = { attempts, lastError: null, nextAttemptAt: new Date(0) };
  const calls = { deleteMany: 0, updateMany: [] as Array<Partial<PendingRow>> };
  const prisma = {
    metafieldSyncPending: {
      findUnique: async () => ({ attempts: row.attempts }),
      deleteMany: async () => { calls.deleteMany += 1; return { count: 1 }; },
      updateMany: async ({ data }: { data: Partial<PendingRow> }) => { calls.updateMany.push(data); Object.assign(row, data); return { count: 1 }; },
    },
  };
  return { prisma, calls, row };
};

test('a pending metafield intent that exhausts its attempts is kept as failed, never deleted', async () => {
  const { prisma, calls, row } = makePendingDb(PENDING_MAX_ATTEMPTS - 1);
  const service = new MetafieldSyncPendingService(fake<PrismaService>(prisma));
  const first = await service.recordFailure('demo.mysapo.net', '100', 'boom');
  assert.equal(first.exhausted, true);
  assert.equal(calls.deleteMany, 0);
  assert.equal(row.attempts, PENDING_MAX_ATTEMPTS);
  const again = await service.recordFailure('demo.mysapo.net', '100', 'boom again');
  assert.equal(again.exhausted, true);
  assert.equal(row.attempts, PENDING_MAX_ATTEMPTS, 'attempts stay capped');
  assert.ok(row.nextAttemptAt.getTime() > Date.now(), 'the row is rescheduled, not hot-looped');
});

test('a pending intent below the attempt budget is not exhausted', async () => {
  const { prisma } = makePendingDb(0);
  const result = await new MetafieldSyncPendingService(fake<PrismaService>(prisma)).recordFailure('demo.mysapo.net', '100', 'boom');
  assert.equal(result.exhausted, false);
});

test('an unanswerable health probe makes the verdict degraded, never ok', () => {
  assert.deepEqual(deriveHealthVerdict({ healthy: true, recentFailures: 0, probeFailed: true }), { ok: false, degraded: true, status: 'degraded' });
  assert.deepEqual(deriveHealthVerdict({ healthy: true, recentFailures: 0 }), { ok: true, degraded: false, status: 'ok' });
  assert.equal(deriveHealthVerdict({ healthy: false, recentFailures: 0, probeFailed: true }).status, 'down');
});

const localDay = (offsetDays = 0) =>
  new Date(Math.floor((Date.now() + 7 * 3_600_000) / 86_400_000) * 86_400_000 - offsetDays * 86_400_000).toISOString().slice(0, 10);

const makeDashboard = ({
  reviewStore = {},
  prismaOverrides = {},
}: { reviewStore?: Record<string, unknown>; prismaOverrides?: Record<string, unknown> } = {}) => {
  const reviewStoreStub = {
    getStatsForShop: async () => ({ totalReviews: 12, productCount: 2, products: [], statusCounts: { approved: 8, pending: 2, hidden: 1, spam: 1 }, globalAvg: 4.2, globalDist: { 1: 0, 2: 1, 3: 1, 4: 3, 5: 7 }, verifiedCount: 0, withMediaCount: 0 }),
    getAllReviews: async () => ({ items: [], total: 0 }),
    ...reviewStore,
  };
  const qnaStore = {
    getStats: async () => ({ total: 4, answered: 1, unanswered: 3 }),
    getStatusCounts: async () => ({ pending: 2, hidden: 0 }),
    getAllQuestions: async () => ({ items: [], total: 0 }),
  };
  const prisma = {
    appInstall: { findUnique: async () => ({ shopId: 'shop_1' }) },
    catalogProduct: {
      findMany: async () => [
        { productId: 'p1', title: 'Soap', handle: 'soap', image: 'https://cdn.test/soap.jpg' },
        { productId: 'p2', title: 'Cream', handle: 'cream', image: null },
      ],
    },
    reviewProduct: {
      count: async () => 5,
      groupBy: async ({ where }: { where: Record<string, unknown> }) => {
        if (where.status === 'approved') {
          return [
            { productId: 'p1', _count: { _all: 4 }, _avg: { rating: 3.2 } },
            { productId: 'p2', _count: { _all: 1 }, _avg: { rating: 5 } },
          ];
        }
        return [
          { productId: 'p1', _count: { _all: 5 }, _max: { productTitle: 'Old soap', productImage: null } },
          { productId: 'p2', _count: { _all: 1 }, _max: { productTitle: null, productImage: null } },
        ];
      },
    },
    qnaQuestion: {
      groupBy: async ({ where }: { where: Record<string, unknown> }) => {
        if (where.AND) return [{ productId: 'p2', _count: { _all: 1 } }];
        return [
          { productId: 'p2', _count: { _all: 3 }, _max: { productTitle: null, productImage: null } },
        ];
      },
    },
    $queryRaw: async () => [{ day: localDay(0), count: 3 }, { day: localDay(2), count: 1 }],
    ...prismaOverrides,
  };
  return new DashboardService(
    fake<ReviewProductStoreService>(reviewStoreStub),
    fake<QnaStoreService>(qnaStore),
    fake<PrismaService>(prisma),
  );
};

test('dashboard overview carries every field the SPA reads, with a real unreplied count', async () => {
  const overview = await makeDashboard().getOverview('demo.mysapo.net');
  assert.equal(overview.statusCounts.unreplied, 5);
  assert.equal(overview.reviewTrend.length, 14);
  assert.equal(overview.reviewTrend[13].date, localDay(0));
  assert.equal(overview.reviewTrend[13].count, 3);
  assert.equal(overview.reviewTrend[11].count, 1);
  assert.equal(overview.reviewTrend.filter((d) => d.count === 0).length, 12);
  assert.deepEqual(overview.degraded, []);
  assert.deepEqual(overview.productStats.map((p) => p.productId).sort(), ['p1', 'p2']);
  const p1 = overview.productStats.find((p) => p.productId === 'p1');
  assert.deepEqual(p1, { productId: 'p1', title: 'Soap', image: 'https://cdn.test/soap.jpg', reviewCount: 5, avgRating: 3.2, qnaTotal: 0, qnaUnanswered: 0 });
  const p2 = overview.productStats.find((p) => p.productId === 'p2');
  assert.ok(p2);
  assert.equal(p2.qnaTotal, 3);
  assert.equal(p2.qnaUnanswered, 2);
  const byId = Object.fromEntries(overview.attentionProducts.map((p) => [p.productId, p.reason]));
  assert.deepEqual(byId, { p1: 'low_rating', p2: 'unanswered_qna' });
  assert.deepEqual(overview.rankedProducts.map((p) => p.id), ['p1', 'p2']);
});

test('dashboard reports failing sections in degraded instead of silently zeroing them', async () => {
  const overview = await makeDashboard({
    reviewStore: { getStatsForShop: async () => { throw new Error('db down'); } },
    prismaOverrides: { $queryRaw: async () => { throw new Error('raw failed'); } },
  }).getOverview('demo.mysapo.net');
  assert.deepEqual(overview.degraded, ['reviewStats', 'reviewTrend']);
  assert.equal(overview.reviewTrend.length, 14);
  assert.ok(overview.reviewTrend.every((d) => d.count === 0));
});

test('dashboard refuses an unknown store instead of returning healthy zeros', async () => {
  const service = makeDashboard({ prismaOverrides: { appInstall: { findUnique: async () => null } } });
  await assert.rejects(() => service.getOverview('ghost.mysapo.net'), hasStatus(404));
});

interface BackfillResult {
  synced: number;
  pages: number;
  failedPages: number;
  totalFromCount: number | null;
  stopReason: 'completed' | 'max_pages' | 'empty_page' | 'failed_page';
}

const makeOps = ({
  registerResult = { status: 'registered' },
  backfill = async () => ({ synced: 3, pages: 1, failedPages: 0, totalFromCount: 3, stopReason: 'completed' }),
}: {
  registerResult?: WebhookRegistrationResult;
  backfill?: () => Promise<BackfillResult>;
} = {}) => {
  const registered: Array<[string, string]> = [];
  const redis = new RedisService({});
  const ops = new OpsService(
    fake<AppEnv>({ API_BASE_URL: 'https://api.test' }),
    fake<SapoService>({ resolveAccessToken: async () => 'tok' }),
    fake<WebhookRegistrationService>({
      registerForInstall: async (store: string, token: string) => { registered.push([store, token]); return registerResult; },
    }),
    fake<CatalogSyncService>({ backfillStore: backfill }),
    fake<CatalogProductStoreService>({}),
    fake<ReviewProductStoreService>({}),
    fake<QnaStoreService>({}),
    fake<PurchaseStoreService>({}),
    fake<PrismaService>({}),
    fake<StorefrontService>({}),
    fake<MetafieldSyncPendingService>({}),
    redis,
    fake<SapoApiService>({}),
    fake<ReviewService>({}),
  );
  return { ops, registered, redis };
};

test('ops resync-webhooks delegates to registerForInstall and reports its status', async () => {
  const ok = makeOps();
  assert.deepEqual(await ok.ops.resyncWebhooks('demo.mysapo.net'), { ok: true, storeDomain: 'demo.mysapo.net', status: 'registered' });
  assert.deepEqual(ok.registered, [['demo.mysapo.net', 'tok']]);
  const degraded = makeOps({ registerResult: { status: 'degraded', error: 'orders/create: 500' } });
  const result = await degraded.ops.resyncWebhooks('demo.mysapo.net');
  assert.equal(result.ok, false);
  assert.equal(result.status, 'degraded');
});

test('ops backfill-catalog is rate limited per store and serialized by a lock', async () => {
  const { ops } = makeOps();
  const first = await ops.backfillCatalog('demo.mysapo.net');
  assert.equal(first.ok, true);
  await assert.rejects(() => ops.backfillCatalog('demo.mysapo.net'), hasStatus(429));
  const other = await ops.backfillCatalog('other.mysapo.net');
  assert.equal(other.ok, true, 'the limit is per store');

  const locked = makeOps();
  const lock = await locked.redis.acquireLock('lock:ops:backfill-catalog:busy.mysapo.net', 60);
  assert.ok(lock);
  await assert.rejects(() => locked.ops.backfillCatalog('busy.mysapo.net'), hasStatus(409));
  await locked.redis.releaseLock(lock);
});

test('ops backfill releases its lock when the run fails and flags a partial result as not ok', async () => {
  const partial = makeOps({ backfill: async () => ({ synced: 250, pages: 1, failedPages: 1, totalFromCount: 900, stopReason: 'failed_page' }) });
  assert.equal((await partial.ops.backfillCatalog('demo.mysapo.net')).ok, false);
  const lock = await partial.redis.acquireLock('lock:ops:backfill-catalog:demo.mysapo.net', 60);
  assert.ok(lock, 'the lock was released after the run');

  const failing = makeOps({ backfill: async () => { throw new Error('sapo down'); } });
  await assert.rejects(() => failing.ops.backfillCatalog('demo.mysapo.net'), /sapo down/);
  assert.ok(await failing.redis.acquireLock('lock:ops:backfill-catalog:demo.mysapo.net', 60), 'the lock was released after a failure');
});
