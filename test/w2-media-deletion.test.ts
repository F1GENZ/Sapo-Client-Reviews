import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Prisma } from '@prisma/client';

import { RedisService } from '../src/redis/redis.service';
import { MediaService } from '../src/media/media.service';
import { ReviewService } from '../src/review/review.service';
import { QnaService } from '../src/qna/qna.service';
import { AnswerQuestionDto } from '../src/qna/dto/answer-question.dto';
import { DurabilitySweepService } from '../src/ops/durability-sweep.service';
import type { AppEnv } from '../src/config/env.schema';
import type { PrismaService } from '../src/database/prisma.service';
import type { CatalogProductStoreService } from '../src/catalog/catalog-product-store.service';
import type { ReviewProductStoreService } from '../src/review/review-product-store.service';
import type { PurchaseStoreService } from '../src/purchase/purchase-store.service';
import type { QnaStoreService } from '../src/qna/qna-store.service';
import type { PublicSubmitHooks } from '../src/review/review.service';
import type { PublicReviewInput } from '../src/review/public-review-input';
import type { MediaItem } from '../src/review/interfaces/review.interface';
import type { SapoApiService } from '../src/sapo/sapo-api.service';
import type { SapoService } from '../src/sapo/sapo.service';
import type { WebhookService } from '../src/sapo/webhook.service';
import type { MetafieldSyncPendingService } from '../src/database/metafield-sync-pending.service';
import { fake } from './support/fakes';
import { worker } from './support/worker';

const STORE = 'demo.mysapo.net';
const SECRET = 'media-secret-for-tests';
const mediaEnv = {
  R2_UPLOAD_SECRET: SECRET,
  R2_WORKER_URL: 'https://r2-worker.example.test',
  R2_PUBLIC_DOMAIN: 'cdn.example.test',
};

type KeyOptions = { store?: string; product?: string; ext?: string };
const nonce = (n: number): string => String(n).padStart(16, 'a');
const keyOf = (n: number, { store = STORE, product = '100', ext = 'jpg' }: KeyOptions = {}): string =>
  `reviews/${store}/${product}/${nonce(n)}.${ext}`;
const urlOf = (n: number, options?: KeyOptions): string => `https://${mediaEnv.R2_PUBLIC_DOMAIN}/${keyOf(n, options)}`;
const makeMedia = (env: Record<string, string>, redis: RedisService): MediaService => new MediaService(fake<AppEnv>(env), redis);

type FetchCall = { url: string; method: string; headers: Record<string, string> };

const withFetch = async <T>(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
  run: (calls: FetchCall[]) => Promise<T>,
): Promise<T> => {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = async (url: URL | RequestInfo, init: RequestInit = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: fake<Record<string, string>>(init.headers ?? {}) });
    return handler(String(url), init);
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
};

const okJson = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

test('deleteByUrls deletes only own-prefix objects of the caller store and never throws', async () => {
  const media = makeMedia(mediaEnv, new RedisService({ keyPrefix: 'w2-del-1' }));
  await withFetch(() => new Response('{}', { status: 200 }), async (calls) => {
    await media.deleteByUrls(
      [
        urlOf(1),
        urlOf(1),
        urlOf(2, { store: 'other.mysapo.net' }),
        `https://evil.example.test/${keyOf(3)}`,
        `http://${mediaEnv.R2_PUBLIC_DOMAIN}/${keyOf(4)}`,
        `https://${mediaEnv.R2_PUBLIC_DOMAIN}/uploads/${nonce(5)}.jpg`,
        `https://${mediaEnv.R2_PUBLIC_DOMAIN}/reviews/${STORE}/100/short.jpg`,
        `https://user:pw@${mediaEnv.R2_PUBLIC_DOMAIN}/${keyOf(6)}`,
        'https://www.youtube.com/watch?v=abc',
        'not a url',
      ],
      STORE,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'DELETE');
    assert.equal(calls[0].url, `${mediaEnv.R2_WORKER_URL}/${keyOf(1)}`);
    assert.equal(calls[0].headers['X-Upload-Token'], SECRET);
  });

  await withFetch(() => new Response('boom', { status: 500 }), async () => {
    await media.deleteByUrls([urlOf(1)], STORE);
  });
  await withFetch(() => { throw new Error('network down'); }, async () => {
    await media.deleteByUrls([urlOf(1)], STORE);
  });
});

test('deleteByUrls is a no-op when R2 is not configured', async () => {
  const media = makeMedia({ R2_UPLOAD_SECRET: '', R2_WORKER_URL: '', R2_PUBLIC_DOMAIN: '' }, new RedisService({ keyPrefix: 'w2-del-2' }));
  assert.equal(media.storageConfigured, false);
  await withFetch(() => new Response('{}'), async (calls) => {
    await media.deleteByUrls([urlOf(1)], STORE);
    assert.equal(calls.length, 0);
  });
});

type BucketObject = { key: string; uploaded: Date; size: number };

const makeBucket = (objects: BucketObject[]) => {
  const deleted: string[] = [];
  return {
    deleted,
    delete: async (key: string) => { deleted.push(key); },
    list: async ({ prefix, limit, cursor }: { prefix: string; limit: number; cursor?: string }) => {
      const matching = objects.filter((object) => object.key.startsWith(prefix));
      const start = cursor ? Number(cursor) : 0;
      const slice = matching.slice(start, start + limit);
      const truncated = start + limit < matching.length;
      return { objects: slice, truncated, cursor: truncated ? String(start + limit) : undefined };
    },
  };
};

const workerRequest = (path: string, { method = 'GET', token = SECRET } = {}) =>
  new Request(`https://worker.example.test${path}`, { method, headers: token ? { 'X-Upload-Token': token } : {} });

test('worker DELETE and /list require the token and validate keys and prefixes', async () => {
  const bucket = makeBucket([
    { key: keyOf(1), uploaded: new Date(1_700_000_000_000), size: 10 },
    { key: keyOf(2), uploaded: new Date(1_700_000_100_000), size: 20 },
    { key: keyOf(3), uploaded: new Date(1_700_000_200_000), size: 30 },
  ]);
  const env = { UPLOAD_SECRET: SECRET, R2_BUCKET: bucket, CDN_DOMAIN: 'cdn.example.test' };

  assert.equal((await worker.fetch(workerRequest(`/${keyOf(1)}`, { method: 'DELETE', token: '' }), env)).status, 401);
  assert.equal((await worker.fetch(workerRequest(`/${keyOf(1)}`, { method: 'DELETE', token: 'wrong' }), env)).status, 401);
  assert.equal((await worker.fetch(workerRequest('/list', { token: '' }), env)).status, 401);
  assert.equal((await worker.fetch(workerRequest('/list', { token: 'wrong' }), env)).status, 401);
  assert.equal(bucket.deleted.length, 0);

  const badKey = await worker.fetch(workerRequest('/reviews/demo.mysapo.net/100/short.jpg', { method: 'DELETE' }), env);
  assert.equal(badKey.status, 400);
  assert.equal((await badKey.json()).code, 'invalid_key');
  assert.equal((await worker.fetch(workerRequest('/other/prefix/x.jpg', { method: 'DELETE' }), env)).status, 400);

  const removed = await worker.fetch(workerRequest(`/${keyOf(1)}`, { method: 'DELETE' }), env);
  assert.equal(removed.status, 200);
  assert.deepEqual(bucket.deleted, [keyOf(1)]);

  const invalidPrefix = await worker.fetch(workerRequest('/list?prefix=other/'), env);
  assert.equal(invalidPrefix.status, 400);
  assert.equal((await worker.fetch(workerRequest('/list?prefix=reviews/../secret'), env)).status, 400);
  assert.equal((await worker.fetch(workerRequest('/list?limit=0'), env)).status, 400);
  assert.equal((await worker.fetch(workerRequest('/other'), env)).status, 404);

  type Listing = { objects: { key: string; uploaded: number }[]; cursor: string | null };
  const first = fake<Listing>(await (await worker.fetch(workerRequest('/list?prefix=reviews/&limit=2'), env)).json());
  assert.deepEqual(first.objects.map((object) => object.key), [keyOf(1), keyOf(2)]);
  assert.equal(first.objects[0].uploaded, 1_700_000_000_000);
  assert.equal(first.cursor, '2');
  const second = fake<Listing>(await (await worker.fetch(workerRequest(`/list?prefix=reviews/&limit=2&cursor=${first.cursor}`), env)).json());
  assert.deepEqual(second.objects.map((object) => object.key), [keyOf(3)]);
  assert.equal(second.cursor, null);
});

type StoredReview = {
  reviewId: string;
  productId: string;
  media: MediaItem[];
  [key: string]: unknown;
};

type ReviewCalls = { upserts: { reviewId: string; media?: MediaItem[] }[]; deletes: string[] };

const makeReviewService = ({ rows, media }: { rows: Map<string, StoredReview>; media: Pick<MediaService, 'deleteByUrls'> }) => {
  const calls: ReviewCalls = { upserts: [], deletes: [] };
  const prisma = {
    appInstall: { findUnique: async () => ({ shopId: 'shop_1', metadata: {}, status: 'active' }) },
    reviewProduct: {
      findMany: async ({ where }: { where: { NOT: { productId: string; reviewId: string } } }) =>
        [...rows.values()]
          .filter((row) => !(row.productId === where.NOT.productId && row.reviewId === where.NOT.reviewId) && row.media.length > 0)
          .map((row) => ({ media: row.media })),
    },
  };
  const reviewStore = {
    getReview: async (_shop: string, _product: string, reviewId: string) => {
      const row = rows.get(reviewId);
      return row ? { ...row } : null;
    },
    deleteReview: async (_shop: string, _product: string, reviewId: string) => {
      calls.deletes.push(reviewId);
      return rows.delete(reviewId);
    },
    upsertReview: async (input: { reviewId: string; media?: MediaItem[] }) => {
      calls.upserts.push(input);
      const current = rows.get(input.reviewId);
      if (current && input.media !== undefined) current.media = input.media;
      return input;
    },
  };
  const redis = { acquireLock: async () => ({ key: 'k', owner: 'o' }), releaseLock: async () => true };
  const service = new ReviewService(
    fake<RedisService>(redis),
    fake<PrismaService>(prisma),
    fake<SapoApiService>({}),
    fake<ReviewProductStoreService>(reviewStore),
    fake<CatalogProductStoreService>({}),
    fake<PurchaseStoreService>({}),
    fake<MetafieldSyncPendingService>({}),
    fake<MediaService>(media),
  );
  Reflect.set(service, 'syncPublicSummary', async () => true);
  return { service, calls };
};

const reviewRow = (media: MediaItem[]): StoredReview => ({
  reviewId: 'r1', productId: '100', rating: 5, content: 'ok', author: 'A', email: null, phone: null, title: null,
  media, status: 'approved', verified: false, pinned: false, reply: null, repliedAt: null, sourceRawJson: null,
  createdAt: 1n, updatedAt: 1n,
});

test('deleteReview releases the stored media of the deleted review for the caller store', async () => {
  const released: { urls: string[]; store?: string }[] = [];
  const media = { deleteByUrls: async (urls: string[], store?: string) => { released.push({ urls, store }); } };
  const rows = new Map([['r1', reviewRow([{ url: urlOf(1), type: 'image' }, { url: 'https://youtu.be/abc', type: 'video' }])]]);
  const { service } = makeReviewService({ rows, media });
  const result = await service.deleteReview('tok', STORE, '100', 'r1');
  assert.equal(result.deleted, true);
  assert.deepEqual(released, [{ urls: [urlOf(1), 'https://youtu.be/abc'], store: STORE }]);

  const missing = await service.deleteReview('tok', STORE, '100', 'missing');
  assert.equal(missing.deleted, false);
  assert.equal(released.length, 1);
});

test('editReview releases only the media removed by the edit', async () => {
  const released: { urls: string[]; store?: string }[] = [];
  const media = { deleteByUrls: async (urls: string[], store?: string) => { released.push({ urls, store }); } };
  const rows = new Map([['r1', reviewRow([{ url: urlOf(1), type: 'image' }, { url: urlOf(2), type: 'image' }])]]);
  const { service } = makeReviewService({ rows, media });

  await service.editReview('tok', STORE, '100', 'r1', { content: 'changed' });
  assert.equal(released.length, 0, 'omitting media leaves it untouched');

  await service.editReview('tok', STORE, '100', 'r1', { media: [{ url: urlOf(2), type: 'image' }] });
  assert.deepEqual(released, [{ urls: [urlOf(1)], store: STORE }]);

  await service.editReview('tok', STORE, '100', 'r1', { media: [{ url: urlOf(2), type: 'image' }] });
  assert.equal(released.length, 1, 'keeping every item releases nothing');
});

test('submitPublicReview rejects media types the widget settings disallow', async () => {
  const metadata: Record<string, { allowImage?: boolean; allowVideo?: boolean }> = { reviewWidgetConfig: { allowImage: false } };
  const prisma = { appInstall: { findUnique: async () => ({ shopId: 'shop_1', metadata, status: 'active' }) } };
  const catalogStore = { getProduct: async () => ({ productId: '100', deletedAt: null }) };
  const service = new ReviewService(
    fake<RedisService>({}),
    fake<PrismaService>(prisma),
    fake<SapoApiService>({}),
    fake<ReviewProductStoreService>({}),
    fake<CatalogProductStoreService>(catalogStore),
    fake<PurchaseStoreService>({}),
    fake<MetafieldSyncPendingService>({}),
    fake<MediaService>({}),
  );
  const hooks: PublicSubmitHooks = { chargeIdentity: async () => {}, resolveToken: async () => 'tok' };
  const input = (media: MediaItem[]): PublicReviewInput => ({ rating: 5, content: 'ok', author: 'A', media });

  await assert.rejects(
    () => service.submitPublicReview(STORE, '100', input([{ url: urlOf(1), type: 'image' }]), hooks),
    (error) => error instanceof BadRequestException && fake<{ code: string }>(error.getResponse()).code === 'media_type_not_allowed',
  );

  const videoOff = { reviewWidgetConfig: { allowVideo: false } };
  prisma.appInstall.findUnique = async () => ({ shopId: 'shop_1', metadata: videoOff, status: 'active' });
  await assert.rejects(
    () => service.submitPublicReview(STORE, '100', input([{ url: 'https://youtu.be/abc', type: 'video' }]), hooks),
    (error) => error instanceof BadRequestException && fake<{ code: string }>(error.getResponse()).code === 'media_type_not_allowed',
  );
});

test('a blank answer is rejected by the DTO and never stored by the service', async () => {
  for (const answer of ['', '   ', '\n\t']) {
    const dto = plainToInstance(AnswerQuestionDto, { answer });
    const errors = await validate(dto);
    assert.ok(errors.length > 0, `DTO accepted ${JSON.stringify(answer)}`);
  }
  const padded = plainToInstance(AnswerQuestionDto, { answer: '  Yes, it fits.  ' });
  assert.equal((await validate(padded)).length, 0);
  assert.equal(padded.answer, 'Yes, it fits.');

  const stored: { answer: string; answeredBy?: string }[] = [];
  const qnaStore = {
    getQuestion: async () => ({ questionId: 'q1' }),
    updateAnswer: async (_shop: string, _product: string, _question: string, answer: string, answeredBy?: string) => {
      stored.push({ answer, answeredBy });
      return { questionId: 'q1', answer, answeredBy, status: 'approved' };
    },
  };
  const service = new QnaService(fake<PrismaService>({}), fake<QnaStoreService>(qnaStore));
  Reflect.set(service, 'resolveInstall', async () => ({ shopId: 'shop_1' }));
  await assert.rejects(
    () => service.answerQuestion(STORE, '100', 'q1', fake<AnswerQuestionDto>({ answer: '   ' })),
    (error) => error instanceof BadRequestException && fake<{ code: string }>(error.getResponse()).code === 'answer_required',
  );
  assert.deepEqual(stored, [], 'a blank answer must never be written or approved');

  const answered = await service.answerQuestion(STORE, '100', 'q1', fake<AnswerQuestionDto>({ answer: '  Yes, it fits.  ', answered_by: '' }));
  assert.deepEqual(stored, [{ answer: 'Yes, it fits.', answeredBy: 'Shop' }]);
  assert.equal(answered?.status, 'approved');
});

type ReferencingRow = { shopId: string; media: MediaItem[] };
type Where = Record<string, unknown>;

type SweepOptions = {
  objects: BucketObject[];
  referenced: ReferencingRow[];
  installs?: { shopId: string; storeDomain: string }[];
  redis: RedisService;
  mediaConfigured?: boolean;
};

const makeSweepHarness = ({ objects, referenced, installs = [{ shopId: 'shop_1', storeDomain: STORE }], redis, mediaConfigured = true }: SweepOptions) => {
  const queries: { reviewProduct: { where: Where }[]; appInstall: { where: Where }[] } = { reviewProduct: [], appInstall: [] };
  const prisma = {
    webhookEvent: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
    appInstall: {
      findMany: async (args: { where: { storeDomain?: { in: string[] } } }) => {
        queries.appInstall.push(args);
        return args.where.storeDomain
          ? installs.filter((install) => args.where.storeDomain?.in.includes(install.storeDomain))
          : [];
      },
    },
    reviewProduct: {
      findMany: async (args: { where: { shopId: { in: string[] }; media: unknown } }) => {
        queries.reviewProduct.push(args);
        return referenced
          .filter((row) => args.where.shopId.in.includes(row.shopId))
          .map((row) => ({ media: row.media }));
      },
    },
    $transaction: async () => null,
  };
  const media = makeMedia(
    mediaConfigured ? mediaEnv : { R2_UPLOAD_SECRET: '', R2_WORKER_URL: '', R2_PUBLIC_DOMAIN: '' },
    redis,
  );
  const build = () => new DurabilitySweepService(
    fake<AppEnv>({ NODE_ENV: 'test' }),
    redis,
    fake<ReviewService>({ reconcilePendingSummaries: async () => ({ processed: 0, synced: 0, failed: 0, deferred: 0 }) }),
    fake<WebhookService>({ reclaimStalled: async () => ({ reclaimed: 0, failed: 0 }), retryDueFailed: async () => ({ attempted: 0, succeeded: 0, failed: 0 }) }),
    fake<SapoService>({ resolveAccessToken: async () => 'tok' }),
    fake<PrismaService>(prisma),
    media,
  );
  const bucket = makeBucket(objects);
  const handler = async (url: string, init: RequestInit): Promise<Response> => {
    const parsed = new URL(url);
    if (init.method === 'DELETE') {
      await bucket.delete(parsed.pathname.slice(1));
      return new Response('{}', { status: 200 });
    }
    const listed = await bucket.list({
      prefix: parsed.searchParams.get('prefix') ?? '',
      limit: Number(parsed.searchParams.get('limit')),
      cursor: parsed.searchParams.get('cursor') || undefined,
    });
    return okJson({
      objects: listed.objects.map((object) => ({ key: object.key, uploaded: object.uploaded.getTime(), size: object.size })),
      cursor: listed.truncated ? listed.cursor : null,
    });
  };
  return { build, bucket, handler, queries };
};

const DAY = 24 * 60 * 60_000;

test('orphan sweep deletes only aged, unreferenced objects and checks references with one bounded query', async () => {
  const now = Date.now();
  const objects = [
    { key: keyOf(1), uploaded: new Date(now - 3 * DAY), size: 1 },
    { key: keyOf(2), uploaded: new Date(now - 3 * DAY), size: 1 },
    { key: keyOf(3), uploaded: new Date(now - 60_000), size: 1 },
    { key: keyOf(4, { store: 'ghost.mysapo.net' }), uploaded: new Date(now - 3 * DAY), size: 1 },
  ];
  const redis = new RedisService({ keyPrefix: 'w2-sweep-1' });
  const harness = makeSweepHarness({
    objects,
    referenced: [
      { shopId: 'shop_1', media: [{ url: urlOf(2), type: 'image' }, { url: 'https://youtu.be/abc', type: 'video' }] },
      { shopId: 'shop_other', media: [{ url: urlOf(1), type: 'image' }] },
    ],
    redis,
  });
  await withFetch(harness.handler, async () => {
    const report = await harness.build().runOnce();
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.mediaOrphans, { scanned: 4, deleted: 1, kept: 3 });
  });
  assert.deepEqual(harness.bucket.deleted, [keyOf(1)]);
  assert.deepEqual(
    harness.queries.appInstall.map((query) => query.where).filter((where) => 'storeDomain' in where),
    [{ storeDomain: { in: [STORE, 'ghost.mysapo.net'] } }],
    'only the stores of aged objects are resolved; the fresh object is never considered',
  );
  assert.equal(harness.queries.reviewProduct.length, 1);
  assert.deepEqual(harness.queries.reviewProduct[0].where, { shopId: { in: ['shop_1'] }, media: { not: Prisma.DbNull } });
});

test('orphan sweep lists at most 200 objects per run and resumes from the stored cursor', async () => {
  const now = Date.now();
  const objects = Array.from({ length: 250 }, (_, index) => ({
    key: keyOf(index + 1, { product: String(100 + (index % 5)) }),
    uploaded: new Date(now - 3 * DAY),
    size: 1,
  }));
  const redis = new RedisService({ keyPrefix: 'w2-sweep-2' });
  const harness = makeSweepHarness({ objects, referenced: [], redis });

  await withFetch(harness.handler, async (calls) => {
    const first = await harness.build().runOnce();
    assert.deepEqual(first.mediaOrphans, { scanned: 200, deleted: 200, kept: 0 });
    assert.match(calls.find((call) => call.method === 'GET')?.url ?? '', /limit=200/);
    assert.equal(harness.bucket.deleted.length, 200);

    const second = await harness.build().runOnce();
    assert.deepEqual(second.mediaOrphans, { scanned: 50, deleted: 50, kept: 0 });
    assert.equal(new Set(harness.bucket.deleted).size, 250);

    const listCallsBefore = calls.filter((call) => call.method === 'GET').length;
    const third = await harness.build().runOnce();
    assert.deepEqual(third.mediaOrphans, { scanned: 0, deleted: 0, kept: 0 });
    assert.equal(calls.filter((call) => call.method === 'GET').length, listCallsBefore, 'a finished pass rests before listing again');
  });
});

test('orphan sweep is skipped without touching R2 when media storage is not configured', async () => {
  const redis = new RedisService({ keyPrefix: 'w2-sweep-3' });
  const harness = makeSweepHarness({ objects: [], referenced: [], redis, mediaConfigured: false });
  await withFetch(harness.handler, async (calls) => {
    const sweep = harness.build();
    const report = await sweep.runOnce();
    assert.deepEqual(report.errors, []);
    assert.equal(report.mediaOrphans, undefined);
    assert.equal(calls.length, 0);
  });
});
