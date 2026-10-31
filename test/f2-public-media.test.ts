import { test } from 'node:test';
import assert from 'node:assert/strict';
import { of, lastValueFrom } from 'rxjs';
import { HttpException } from '@nestjs/common';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';

import { IngressRateLimitService } from '../src/common/security/ingress-rate-limit.service';
import { publicRateLimitMiddleware } from '../src/common/security/public-rate-limit';
import { PublicResponseInterceptor, sanitizePublicResponse } from '../src/common/security/public-response';
import { applySecurityHeaders } from '../src/common/security/security-headers';
import { MediaService } from '../src/media/media.service';
import { DurabilitySweepService } from '../src/ops/durability-sweep.service';
import { UPLOAD_ERROR } from '../src/media/media-errors';
import { toPublicQuestion } from '../src/qna/qna.service';
import type { QnaQuestionRecord } from '../src/qna/qna-store.service';
import { RedisService } from '../src/redis/redis.service';
import { PublicReviewController } from '../src/review/public-review.controller';
import { sanitizePublicMedia } from '../src/review/public-review-input';
import { ReviewService, toPublicReview } from '../src/review/review.service';
import type { MediaItem } from '../src/review/interfaces/review.interface';
import type { AppEnv } from '../src/config/env.schema';
import type { PrismaService } from '../src/database/prisma.service';
import type { CatalogProductStoreService } from '../src/catalog/catalog-product-store.service';
import type { MetafieldSyncPendingService } from '../src/database/metafield-sync-pending.service';
import type { PurchaseStoreService } from '../src/purchase/purchase-store.service';
import type { ReviewProductStoreService } from '../src/review/review-product-store.service';
import type { SapoApiService } from '../src/sapo/sapo-api.service';
import type { SapoService } from '../src/sapo/sapo.service';
import type { WebhookService } from '../src/sapo/webhook.service';
import { fake } from './support/fakes';

const STORE = 'demo.mysapo.net';
const mediaEnv = {
  R2_UPLOAD_SECRET: 'f2-upload-ticket-secret',
  R2_WORKER_URL: 'https://r2-worker.example.test',
  R2_PUBLIC_DOMAIN: 'cdn.example.test',
};
const makeMedia = (env: Record<string, string>, prefix: string) =>
  new MediaService(fake<AppEnv>(env), new RedisService({ keyPrefix: prefix }));

const statusOf = (error: unknown): number | undefined => (error instanceof HttpException ? error.getStatus() : undefined);
const codeOf = (error: unknown): unknown => {
  if (!(error instanceof HttpException)) return undefined;
  const body = error.getResponse();
  return typeof body === 'object' && 'code' in body ? body.code : undefined;
};

const nonceOf = (n: number): string => String(n).padStart(16, 'a');
const keyOf = (n: number, product = '100'): string => `reviews/${STORE}/${product}/${nonceOf(n)}.jpg`;
const urlOf = (n: number, product = '100'): string => `https://${mediaEnv.R2_PUBLIC_DOMAIN}/${keyOf(n, product)}`;

test('public GET reads are throttled per client only: no shared store bucket is consulted', async () => {
  const buckets: string[] = [];
  const rateLimit = fake<IngressRateLimitService>({
    check: async (bucket: string) => {
      buckets.push(bucket);
      return { allowed: true, remaining: 1, resetInSeconds: 1 };
    },
  });
  const middleware = publicRateLimitMiddleware(rateLimit);
  let passed = false;
  const req = fake<Request>({ method: 'GET', ip: '203.0.113.5', headers: { 'x-store-domain': STORE }, query: {}, socket: {} });
  await middleware(req, fake<Response>({}), () => { passed = true; });
  assert.equal(passed, true);
  assert.deepEqual(buckets, ['public-read-client']);
});

test('a ticket signature with multibyte characters is a 401, not a 500', () => {
  const media = makeMedia(mediaEnv, 'f2-multibyte');
  const { ticket } = media.createUploadTicket({ storeDomain: STORE, productId: '123', contentType: 'image/png', fileSize: 1024 });
  const [encoded, signature] = ticket.split('.');
  const sameLengthMultibyte = `${signature.slice(0, -1)}é`;
  assert.equal(sameLengthMultibyte.length, signature.length);
  assert.notEqual(Buffer.byteLength(sameLengthMultibyte), Buffer.byteLength(signature));
  assert.throws(
    () => media.inspectUploadTicket(`${encoded}.${sameLengthMultibyte}`, STORE),
    (error) => statusOf(error) === 401 && codeOf(error) === UPLOAD_ERROR.ticketInvalid,
  );
});

test('minting an upload ticket needs the whole storage configuration', () => {
  const input = { storeDomain: STORE, productId: '123', contentType: 'image/png', fileSize: 1024 };
  for (const missing of ['R2_WORKER_URL', 'R2_PUBLIC_DOMAIN', 'R2_UPLOAD_SECRET']) {
    const media = makeMedia({ ...mediaEnv, [missing]: '' }, `f2-unconfigured-${missing}`);
    assert.throws(
      () => media.createUploadTicket(input),
      (error) => statusOf(error) === 503 && codeOf(error) === UPLOAD_ERROR.notConfigured,
      missing,
    );
  }
  assert.equal(typeof makeMedia(mediaEnv, 'f2-configured').createUploadTicket(input).ticket, 'string');
});

type HeaderRecorder = { headers: Record<string, string>; setHeader(name: string, value: string): void; removeHeader(name: string): void };

const headersFor = (path: string): Record<string, string> => {
  const res: HeaderRecorder = {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    removeHeader() {},
  };
  let advanced = false;
  applySecurityHeaders(fake<Request>({ path, headers: {}, secure: false }), fake<Response>(res), fake<NextFunction>(() => { advanced = true; }));
  assert.equal(advanced, true);
  return res.headers;
};

test('API security headers apply to case and percent-encoding variants of /api', () => {
  for (const path of ['/api/public/reviews/1', '/API/PUBLIC/REVIEWS/123', '/%61pi/public/reviews/1', '/Api']) {
    const headers = headersFor(path);
    assert.equal(headers['Cache-Control'], 'no-store', path);
    assert.equal(headers['X-Frame-Options'], 'DENY', path);
  }
  assert.equal(headersFor('/storefront/f1genz.js')['Cache-Control'], undefined);
  assert.equal(headersFor('/%E0%A4%A')['Cache-Control'], undefined, 'a malformed escape neither throws nor matches');
});

test('public response whitelist survives case and percent-encoding variants of the row routes', async () => {
  const leaky = { data: { id: 'x', email: 'a@b.c', phone: '09', source_raw_json: '{}', internalNote: 'staff' } };
  for (const path of [
    '/API/PUBLIC/REVIEWS/123',
    '/api/public/reviews/%31%32%33',
    '/Api/Public/Qna/55',
    '/api/public/qna/%35%35/',
  ]) {
    const data = fake<{ data: Record<string, unknown> }>(sanitizePublicResponse(path, leaky)).data;
    assert.deepEqual(Object.keys(data), ['id'], path);
  }
  const untouched = sanitizePublicResponse('/api/public/reviews/%E0%A4%A', leaky);
  assert.deepEqual(untouched, leaky, 'a malformed escape falls back to the raw path without throwing');

  const interceptor = new PublicResponseInterceptor();
  const out = fake<{ data: Record<string, unknown> }>(await lastValueFrom(interceptor.intercept(
    fake<ExecutionContext>({ switchToHttp: () => ({ getRequest: () => ({ path: '/API/PUBLIC/REVIEWS/123' }) }) }),
    fake<CallHandler>({ handle: () => of(leaky) }),
  )));
  assert.equal('email' in out.data, false);
  assert.equal('source_raw_json' in out.data, false);
});

test('service mappers for public rows drop the raw import payload', () => {
  const review = toPublicReview({
    reviewId: 'r1', rating: 5, content: 'c', author: 'a', email: 'a@b.c', phone: '09', title: null, media: null,
    status: 'approved', verified: false, pinned: false, reply: null, repliedAt: null, sourceRawJson: '{"x":1}',
  });
  assert.equal('source_raw_json' in review, false);
  const question = toPublicQuestion(fake<QnaQuestionRecord>({
    questionId: 'q1', question: 'Q', author: 'a', email: 'a@b.c', phone: '09', answer: null, answeredBy: null,
    status: 'approved', createdAt: 1n, updatedAt: 1n, answeredAt: null, sourceRawJson: '{"x":1}',
  }));
  assert.equal('source_raw_json' in question, false);
  assert.equal('email' in question, false);
});

test('public uploads must live under the exact product prefix', () => {
  const scope = { publicDomain: mediaEnv.R2_PUBLIC_DOMAIN, storeDomain: STORE, productId: '100' };
  const media = [
    { url: urlOf(1, '100'), type: 'image' },
    { url: urlOf(2, '101'), type: 'image' },
    { url: urlOf(3, '1000'), type: 'image' },
    { url: `https://${mediaEnv.R2_PUBLIC_DOMAIN}/reviews/${STORE}/x.jpg`, type: 'image' },
  ];
  assert.deepEqual(sanitizePublicMedia(media, scope).map((item) => item.url), [urlOf(1, '100')]);
  assert.deepEqual(sanitizePublicMedia(media, { ...scope, productId: '101' }).map((item) => item.url), [urlOf(2, '101')]);
});

type StoredReview = { shopId: string; productId: string; reviewId: string; media: MediaItem[] | null; [key: string]: unknown };

const storedReview = (reviewId: string, media: MediaItem[] | null, productId = '100'): StoredReview => ({
  shopId: 'shop_1', productId, reviewId, rating: 5, content: 'ok', author: 'A', email: null, phone: null, title: null,
  media, status: 'approved', verified: false, pinned: false, reply: null, repliedAt: null, sourceRawJson: null,
  createdAt: 1n, updatedAt: 1n,
});

type FindManyArgs = {
  where: { shopId: string; productId: string; reviewId: { not: string }; media: { not: unknown } };
  select: { media: boolean };
};

const makeDeletionHarness = (initial: StoredReview[]) => {
  const rows = new Map(initial.map((row) => [row.reviewId, row]));
  const released: { urls: string[]; store?: string }[] = [];
  const lookups: FindManyArgs[] = [];
  const prisma = {
    appInstall: { findUnique: async () => ({ shopId: 'shop_1', metadata: {}, status: 'active' }) },
    reviewProduct: {
      findMany: async (args: FindManyArgs) => {
        lookups.push(args);
        return [...rows.values()]
          .filter((row) => row.shopId === args.where.shopId && row.productId === args.where.productId)
          .filter((row) => row.reviewId !== args.where.reviewId.not && row.media !== null)
          .map((row) => ({ media: row.media }));
      },
    },
  };
  const reviewStore = {
    getReview: async (_shop: string, product: string, reviewId: string) => {
      const row = rows.get(reviewId);
      return row && row.productId === product ? { ...row } : null;
    },
    deleteReview: async (_shop: string, _product: string, reviewId: string) => rows.delete(reviewId),
    upsertReview: async (input: { reviewId: string; media?: MediaItem[] | null }) => {
      const current = rows.get(input.reviewId);
      if (current && input.media !== undefined) current.media = input.media;
    },
  };
  const media = { deleteByUrls: async (urls: string[], store?: string) => { released.push({ urls, store }); } };
  const service = new ReviewService(
    fake<RedisService>({ acquireLock: async () => ({ key: 'k', owner: 'o' }), releaseLock: async () => true }),
    fake<PrismaService>(prisma),
    fake<SapoApiService>({}),
    fake<ReviewProductStoreService>(reviewStore),
    fake<CatalogProductStoreService>({}),
    fake<PurchaseStoreService>({}),
    fake<MetafieldSyncPendingService>({}),
    fake<MediaService>(media),
  );
  Reflect.set(service, 'syncPublicSummary', async () => true);
  return { service, released, lookups };
};

test('deleting a review keeps media that another review of the same product still shows', async () => {
  const shared: MediaItem = { url: urlOf(1), type: 'image' };
  const own: MediaItem = { url: urlOf(2), type: 'image' };
  const harness = makeDeletionHarness([
    storedReview('victim', [shared, own]),
    storedReview('spam', [shared]),
    storedReview('elsewhere', [own], '200'),
  ]);
  const result = await harness.service.deleteReview('tok', STORE, '100', 'victim');
  assert.equal(result.deleted, true);
  assert.deepEqual(harness.released, [{ urls: [own.url], store: STORE }]);

  const [lookup] = harness.lookups;
  assert.equal(lookup.where.shopId, 'shop_1');
  assert.equal(lookup.where.productId, '100');
  assert.equal(lookup.where.reviewId.not, 'victim');
  assert.equal(lookup.where.media.not, Prisma.DbNull);
});

test('deleting the last reference releases everything; a youtube link is passed through untouched', async () => {
  const only: MediaItem = { url: urlOf(3), type: 'image' };
  const embed: MediaItem = { url: 'https://youtu.be/abc', type: 'video' };
  const harness = makeDeletionHarness([storedReview('r1', [only, embed])]);
  await harness.service.deleteReview('tok', STORE, '100', 'r1');
  assert.deepEqual(harness.released, [{ urls: [only.url, embed.url], store: STORE }]);
});

test('editing a review keeps removed media that another review of the same product still shows', async () => {
  const shared: MediaItem = { url: urlOf(4), type: 'image' };
  const own: MediaItem = { url: urlOf(5), type: 'image' };
  const harness = makeDeletionHarness([storedReview('r1', [shared, own]), storedReview('r2', [shared])]);
  await harness.service.editReview('tok', STORE, '100', 'r1', { media: [] });
  assert.deepEqual(harness.released, [{ urls: [own.url], store: STORE }]);
  assert.equal(harness.lookups.length, 1);

  const untouched = makeDeletionHarness([storedReview('r1', [shared])]);
  await untouched.service.editReview('tok', STORE, '100', 'r1', { content: 'changed' });
  assert.equal(untouched.lookups.length, 0, 'no media change, no reference lookup');
  assert.equal(untouched.released.length, 0);
});

type SweepRow = { shopId: string; productId: string; media: MediaItem[] };
type SweepWhere = { OR?: { shopId: string; productId: string }[]; shopId?: { in: string[] } };

const runSweep = async (rows: SweepRow[], keys: string[]) => {
  const deleted: string[] = [];
  const wheres: SweepWhere[] = [];
  const prisma = {
    webhookEvent: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
    appInstall: {
      findMany: async ({ where }: { where: { storeDomain?: { in: string[] } } }) =>
        (where.storeDomain?.in.includes(STORE) ? [{ shopId: 'shop_1', storeDomain: STORE }] : []),
    },
    reviewProduct: {
      findMany: async ({ where }: { where: SweepWhere }) => {
        wheres.push(where);
        return rows
          .filter((row) => (where.OR ? where.OR.some((scope) => scope.shopId === row.shopId && scope.productId === row.productId) : true))
          .filter((row) => (where.shopId ? where.shopId.in.includes(row.shopId) : true))
          .map((row) => ({ media: row.media }));
      },
    },
    $transaction: async () => null,
  };
  const old = Date.now() - 3 * 24 * 60 * 60_000;
  const media = {
    storageConfigured: true,
    listOwnedObjects: async () => ({
      objects: keys.map((key) => ({ key, url: `https://${mediaEnv.R2_PUBLIC_DOMAIN}/${key}`, uploadedAt: old })),
      cursor: null,
    }),
    deleteOwnedObjects: async (urls: string[]) => { deleted.push(...urls); return urls.length; },
  };
  const sweep = new DurabilitySweepService(
    fake<AppEnv>({ NODE_ENV: 'test' }),
    new RedisService({ keyPrefix: `f2-sweep-${Math.random()}` }),
    fake<ReviewService>({ reconcilePendingSummaries: async () => ({ processed: 0, synced: 0, failed: 0, deferred: 0 }) }),
    fake<WebhookService>({ reclaimStalled: async () => ({ reclaimed: 0, failed: 0 }), retryDueFailed: async () => ({ attempted: 0, succeeded: 0, failed: 0 }) }),
    fake<SapoService>({ resolveAccessToken: async () => 'tok' }),
    fake<PrismaService>(prisma),
    fake<MediaService>(media),
  );
  const report = await sweep.runOnce();
  assert.deepEqual(report.errors, []);
  return { report, deleted, wheres };
};

test('orphan sweep treats a reference from any product of the same shop as a live reference', async () => {
  const crossProduct = keyOf(6, '100');
  const orphan = keyOf(7, '100');
  const { deleted, report, wheres } = await runSweep(
    [{ shopId: 'shop_1', productId: '200', media: [{ url: urlOf(6, '100'), type: 'image' }] }],
    [crossProduct, orphan],
  );
  assert.deepEqual(deleted, [`https://${mediaEnv.R2_PUBLIC_DOMAIN}/${orphan}`]);
  assert.deepEqual(report.mediaOrphans, { scanned: 2, deleted: 1, kept: 1 });
  assert.deepEqual(wheres.map((where) => where.shopId), [{ in: ['shop_1'] }]);
  assert.equal(wheres[0].OR, undefined);
});

test('eligibility and submit charge the same bucket for equivalent phone spellings', async () => {
  const keys: string[] = [];
  const rateLimit = {
    assertAllowed: async (bucket: string, key: string) => { if (bucket === 'public-review:identity') keys.push(key); },
  };
  const service = {
    checkPurchaseEligibility: async (_s: string, _p: string, identity: Record<string, string>, charge: (i: Record<string, string>) => Promise<void>) => {
      await charge(identity);
      return { eligible: true, reason: 'verified' };
    },
  };
  const env = { PUBLIC_WRITE_RATE_LIMIT_WINDOW_SECONDS: 60, PUBLIC_WRITE_RATE_LIMIT_MAX: 20, APP_SESSION_SECRET: 'x'.repeat(48), R2_PUBLIC_DOMAIN: 'cdn.example.test' };
  const controller = new PublicReviewController(fake<ReviewService>(service), fake<SapoService>({}), fake<AppEnv>(env), fake<IngressRateLimitService>(rateLimit));
  const req = fake<Request>({ ip: '203.0.113.9', headers: {} });
  await controller.checkPurchaseEligibility('4242', req, { phone: '0901234567' }, STORE);
  await controller.checkPurchaseEligibility('4242', req, { phone: '+84 901 234 567' }, STORE);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1], 'both spellings map to one identity budget');
});

const makeSubmitHarness = (config: Record<string, unknown>) => {
  const purchaseCalls: unknown[] = [];
  const prisma = { appInstall: { findUnique: async () => ({ shopId: 'shop_1', tokenVersion: 1, status: 'active', metadata: { reviewWidgetConfig: config } }) } };
  const service = new ReviewService(
    fake<RedisService>({ acquireLock: async () => ({ key: 'k', owner: 'o' }), releaseLock: async () => true }),
    fake<PrismaService>(prisma),
    fake<SapoApiService>({}),
    fake<ReviewProductStoreService>({ getReviews: async () => ({ items: [] }), upsertReview: async () => undefined }),
    fake<CatalogProductStoreService>({ getProduct: async () => ({ productId: '100', deletedAt: null }) }),
    fake<PurchaseStoreService>({ hasPurchasedProduct: async (_s: string, _p: string, identity: unknown) => { purchaseCalls.push(identity); return true; } }),
    fake<MetafieldSyncPendingService>({}),
    fake<MediaService>({}),
  );
  return { service, purchaseCalls };
};

test('a submission with an identity is charged even when the purchase gate is off', async () => {
  const charged: unknown[] = [];
  const hooks = { chargeIdentity: async (identity: unknown) => { charged.push(identity); }, resolveToken: async () => 'tok' };
  const base = { rating: 5, content: 'ok', author: 'A', media: [] };

  const open = makeSubmitHarness({});
  await open.service.submitPublicReview(STORE, '100', { ...base, email: 'a@example.com' }, hooks);
  assert.deepEqual(charged, [{ email: 'a@example.com', phone: undefined }]);
  assert.equal(open.purchaseCalls.length, 1, 'the purchase lookup behind the verified flag is the thing being throttled');

  charged.length = 0;
  const anonymous = makeSubmitHarness({});
  await anonymous.service.submitPublicReview(STORE, '100', base, hooks);
  assert.equal(charged.length, 0, 'no identity, nothing to charge');
  assert.equal(anonymous.purchaseCalls.length, 0);
});
