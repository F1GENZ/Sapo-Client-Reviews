import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { createHmac } from 'crypto';

import { parseCsv, parseCsvRecords, toCsv } from '../src/common/csv';
import { assertOutboundUrlSafe, isPublicAddress } from '../src/outbound/ip-guard';
import { OutboundDispatcherService, signOutboundPayload } from '../src/outbound/outbound-dispatcher.service';
import { ReviewDataToolsService } from '../src/review/review-data-tools.service';
import { QnaDataToolsService } from '../src/qna/qna-data-tools.service';
import { AiService } from '../src/ai/ai.service';
import { buildSliderPayload, resolveSliderSettings } from '../src/review/slider-payload';
import { of } from 'rxjs';
import { PublicResponseInterceptor } from '../src/common/security/public-response';
import type { PrismaService } from '../src/database/prisma.service';
import type { ReviewProductStoreService } from '../src/review/review-product-store.service';
import type { ReviewService } from '../src/review/review.service';
import type { CatalogProductStoreService } from '../src/catalog/catalog-product-store.service';
import type { MetafieldSyncPendingService } from '../src/database/metafield-sync-pending.service';
import type { MediaService } from '../src/media/media.service';
import type { OutboundWebhookService } from '../src/outbound/outbound-webhook.service';
import type { QnaStoreService } from '../src/qna/qna-store.service';
import type { AppEnv } from '../src/config/env.schema';
import type { TokenEncryptionService } from '../src/sapo/token-encryption.service';
import type { IngressRateLimitService } from '../src/common/security/ingress-rate-limit.service';

const cast = <T>(value: unknown): T => value as T;

test('csv parses quoted fields, embedded newlines and semicolon files, and round-trips through toCsv', () => {
  const rows = parseCsv('a;b\r\n"x;y";"line1\nline2"\r\n"quote ""q""";z\r\n');
  assert.deepEqual(rows, [
    ['a', 'b'],
    ['x;y', 'line1\nline2'],
    ['quote "q"', 'z'],
  ]);
  const encoded = toCsv([['a,b', 'c"d', 'plain'], ['1', 2, null]]);
  assert.equal(encoded, '"a,b","c""d",plain\r\n1,2,\r\n');
  const records = parseCsvRecords('Product_ID,review_id,rating\n100,r1,5\n');
  assert.deepEqual(records, [{ product_id: '100', review_id: 'r1', rating: '5' }]);
});

const makeReviewTools = (options: { existing?: Set<string>; productFound?: boolean; applied?: unknown[] } = {}) => {
  const applied: unknown[] = options.applied ?? [];
  const runs: unknown[] = [];
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const prisma = {
    appInstall: { findUnique: async () => ({ shopId: 'shop_1' }) },
    importRun: {
      create: async ({ data }: { data: Record<string, unknown> }) => { runs.push(data); return { id: 'run_1' }; },
      findMany: async () => [],
    },
    reviewProduct: {
      findMany: async () => [
        {
          productId: '100', reviewId: 'r1', rating: 5, author: 'An', title: 'Hay', content: 'Tot',
          email: 'a@example.com', phone: '0912345678', status: 'approved', verified: true, pinned: false,
          reply: 'Cam on', createdAt: 1_700_000_000_000n, media: [{ url: 'https://img.test/1.jpg', type: 'image' }],
        },
      ],
    },
  };
  const reviewStore = {
    getReview: async (shopId: string, productId: string, reviewId: string) =>
      options.existing?.has(`${productId}:${reviewId}`) ? { status: 'pending', media: null, rating: 3 } : null,
    upsertReview: async (input: unknown) => { applied.push(input); return input; },
    deleteReview: async () => true,
    updateStatus: async () => ({}),
  };
  const reviewService = {
    syncPublicSummaryMetafield: async () => ({ synced: 1, queued: 0 }),
  };
  const catalogStore = {
    getProduct: async (_shopId: string, productId: string) =>
      options.productFound === false || productId !== '100' ? null : { productId: '100', deletedAt: null },
  };
  const pending = { markDirty: async () => new Date() };
  const media = { deleteByUrls: async () => undefined };
  const outbound = {
    enqueue: async (_store: string, event: string, data: Record<string, unknown>) => { events.push({ event, data }); return 1; },
  };
  const service = new ReviewDataToolsService(
    cast<PrismaService>(prisma),
    cast<ReviewProductStoreService>(reviewStore),
    cast<ReviewService>(reviewService),
    cast<CatalogProductStoreService>(catalogStore),
    cast<MetafieldSyncPendingService>(pending),
    cast<MediaService>(media),
    cast<OutboundWebhookService>(outbound),
  );
  return { service, applied, runs, events };
};

test('review export serialises every admin field as csv and as json', async () => {
  const { service } = makeReviewTools();
  const csv = await service.exportReviews('demo.mysapo.net', 'csv');
  assert.match(csv.filename, /\.csv$/);
  const lines = csv.body.trim().split('\r\n');
  assert.equal(lines[0].split(',')[0], 'product_id');
  assert.match(lines[1], /^100,r1,5,An,Hay,Tot,a@example\.com,0912345678,approved,true,false,Cam on,1700000000000/);
  const json = await service.exportReviews('demo.mysapo.net', 'json');
  const rows = JSON.parse(json.body) as Array<Record<string, unknown>>;
  assert.equal(rows[0].review_id, 'r1');
  assert.equal(rows[0].media, JSON.stringify([{ url: 'https://img.test/1.jpg', type: 'image' }]));
});

test('review import dry-run reports per-row errors and never writes', async () => {
  const { service, applied, events } = makeReviewTools();
  const body = [
    { product_id: '100', review_id: 'r1', rating: 5, author: 'An', content: 'Tot' },
    { product_id: '100', review_id: 'r2', rating: 9, author: 'Bi', content: 'Sai sao' },
    { product_id: '100', review_id: 'r3', rating: 4, author: '', content: 'Thieu ten' },
    { product_id: '100', review_id: 'r4', rating: 4, author: 'Ce', content: 'Ok', email: 'x@y' },
  ];
  const result = await service.importReviews('tok', 'demo.mysapo.net', {
    format: 'json',
    body: JSON.stringify(body),
    dryRun: true,
  });
  assert.equal(result.total, 4);
  assert.equal(result.created, 1);
  assert.equal(result.failed, 3);
  assert.equal(result.errors.length, 3);
  assert.equal(result.runId, null);
  assert.deepEqual(applied, [], 'dry-run must not write');
  assert.deepEqual(events, [], 'dry-run must not emit outbound events');
});

test('review import maps products through the catalog and applies rows with their id and media', async () => {
  const { service, applied, events, runs } = makeReviewTools();
  const body = [
    { product_id: '100', review_id: 'r1', rating: 5, author: 'An', content: 'Tot', media: '["https://img.test/1.jpg"]' },
    { product_id: '200', review_id: 'r2', rating: 3, author: 'Bi', content: 'Tam' },
  ];
  const result = await service.importReviews('tok', 'demo.mysapo.net', { format: 'json', body: JSON.stringify(body), dryRun: false });
  assert.equal(runs.length, 1);
  assert.equal(result.created, 1);
  assert.equal(result.skipped, 1, 'a product that is not in the catalog is skipped, never invented');
  assert.equal(result.errors[0].message, 'product_not_in_catalog');
  assert.equal(result.summarySync.synced, 1);
  const writes = applied.filter((row) => row !== null && typeof row === 'object' && 'reviewId' in (row as Record<string, unknown>));
  assert.equal(writes.length, 1);
  assert.deepEqual((writes[0] as Record<string, unknown>).media, [{ url: 'https://img.test/1.jpg', type: 'image' }]);
  assert.equal(result.runId, 'run_1');
  assert.deepEqual(events, []);
});

test('bulk status only rewrites rows whose status changes and emits one event per change', async () => {
  const handled: string[] = [];
  const updated: string[] = [];
  const prisma = { appInstall: { findUnique: async () => ({ shopId: 'shop_1' }) } };
  const reviewStore = {
    getReview: async (_s: string, productId: string, reviewId: string) => {
      handled.push(`${productId}:${reviewId}`);
      if (reviewId === 'missing') return null;
      if (reviewId === 'same') return { status: 'approved', rating: 5, media: null };
      return { status: 'pending', rating: 4, media: [{ url: 'https://img.test/a.jpg', type: 'image' }] };
    },
    updateStatus: async (_s: string, productId: string, reviewId: string, status: string) => {
      updated.push(`${reviewId}:${status}`);
      return { status };
    },
    deleteReview: async () => true,
  };
  const events: string[] = [];
  const service = new ReviewDataToolsService(
    cast<PrismaService>(prisma),
    cast<ReviewProductStoreService>(reviewStore),
    cast<ReviewService>({ syncPublicSummaryMetafield: async () => ({ synced: 1, queued: 0 }) }),
    cast<CatalogProductStoreService>({}),
    cast<MetafieldSyncPendingService>({ markDirty: async () => new Date() }),
    cast<MediaService>({ deleteByUrls: async () => undefined }),
    cast<OutboundWebhookService>({ enqueue: async (_s: string, event: string) => { events.push(event); return 1; } }),
  );
  const result = await service.bulkReviews('tok', 'demo.mysapo.net', 'approve', [
    { productId: '100', reviewId: 'changed' },
    { productId: '100', reviewId: 'same' },
    { productId: '100', reviewId: 'missing' },
  ]);
  assert.deepEqual(updated, ['changed:approved']);
  assert.equal(result.updated, 1);
  assert.equal(result.skipped, 2);
  assert.deepEqual(events, ['review.approved']);
  assert.deepEqual(handled, ['100:changed', '100:same', '100:missing']);
});

test('qna bulk and import enforce the same catalog and status contract', async () => {
  const applied: unknown[] = [];
  const prisma = {
    appInstall: { findUnique: async () => ({ shopId: 'shop_1' }) },
    importRun: { create: async () => ({ id: 'run_q' }), findMany: async () => [] },
  };
  const qnaStore = {
    getQuestion: async (_s: string, _p: string, questionId: string) =>
      questionId === 'q1' ? { status: 'pending' } : null,
    upsertQuestion: async (input: unknown) => { applied.push(input); return input; },
    updateStatus: async () => ({}),
    deleteQuestion: async () => true,
  };
  const service = new QnaDataToolsService(
    cast<PrismaService>(prisma),
    cast<QnaStoreService>(qnaStore),
    cast<CatalogProductStoreService>({ getProduct: async () => ({ productId: '100', deletedAt: null }) }),
    cast<OutboundWebhookService>({ enqueue: async () => 1 }),
  );
  const bulk = await service.bulkQuestions('demo.mysapo.net', 'approve', [
    { productId: '100', questionId: 'q1' },
    { productId: '100', questionId: 'missing' },
  ]);
  assert.deepEqual({ updated: bulk.updated, skipped: bulk.skipped }, { updated: 1, skipped: 1 });
  const imported = await service.importQuestions('demo.mysapo.net', {
    format: 'json',
    body: JSON.stringify([
      { product_id: '100', question_id: 'q9', question: 'Co hang khong?', author: 'An', status: 'approved' },
      { product_id: '100', question_id: 'q8', question: 'Sai', author: 'Bi', status: 'deleted' },
    ]),
    dryRun: false,
  });
  assert.equal(imported.created, 1);
  assert.equal(imported.failed, 1);
  assert.equal(imported.runId, 'run_q');
  assert.equal(applied.length, 1);
});

test('outbound SSRF guard rejects private, loopback, mapped and localhost targets', async () => {
  const resolveTo = (addresses: string[]) => async () => addresses;
  await assert.rejects(() => assertOutboundUrlSafe('http://example.com/hook', resolveTo(['93.184.216.34'])), BadRequestException);
  await assert.rejects(() => assertOutboundUrlSafe('https://user:pass@example.com/hook', resolveTo(['93.184.216.34'])), BadRequestException);
  await assert.rejects(() => assertOutboundUrlSafe('https://127.0.0.1/hook', resolveTo(['93.184.216.34'])), BadRequestException);
  await assert.rejects(() => assertOutboundUrlSafe('https://example.com/hook', resolveTo(['10.0.0.5'])), BadRequestException);
  await assert.rejects(() => assertOutboundUrlSafe('https://example.com/hook', resolveTo(['::ffff:127.0.0.1'])), BadRequestException);
  await assert.rejects(() => assertOutboundUrlSafe('https://localhost/hook', resolveTo(['93.184.216.34'])), BadRequestException);
  const ok = await assertOutboundUrlSafe('https://hooks.example.com/hook', resolveTo(['93.184.216.34']));
  assert.equal(ok.hostname, 'hooks.example.com');
  assert.equal(isPublicAddress('93.184.216.34'), true);
  assert.equal(isPublicAddress('198.18.0.1'), false);
  assert.equal(isPublicAddress('2002:7f00:1::'), false, '6to4 wrapping loopback is refused');
  assert.equal(isPublicAddress('2001:db8::1'), false);
});

test('outbound signature is an HMAC over the exact body with the sha256= prefix', () => {
  const body = JSON.stringify({ id: 'd1', event: 'review.created' });
  const signature = signOutboundPayload(body, 'secret');
  assert.equal(signature, `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`);
});

const makeDispatcher = (options: { fetchImpl: typeof fetch; deliveries: Array<Record<string, unknown>> }) => {
  const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const rows = options.deliveries;
  const prisma = {
    outboundWebhookDelivery: {
      findMany: async () => rows.filter((row) => row.status === 'pending' || row.status === 'failed'),
      updateMany: async (input: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updates.push(input);
        return { count: 1 };
      },
      findUnique: async ({ where }: { where: { id: string } }) => rows.find((row) => row.id === where.id) ?? null,
      update: async (input: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updates.push(input);
        return { ...(rows[0] ?? {}), ...input.data };
      },
    },
  };
  const encryption = { optionalDecrypt: () => 'secret' };
  const env = cast<AppEnv>({ NODE_ENV: 'test' });
  return {
    updates,
    dispatcher: new OutboundDispatcherService(env, cast<PrismaService>(prisma), cast<TokenEncryptionService>(encryption)),
  };
};

const endpoint = {
  id: 'e1', url: 'https://hooks.example.com/hook', active: true, events: ['review.created'],
  secretCiphertext: 'c', secretIv: 'i', secretTag: 't',
};

test('dispatcher marks a 2xx delivery delivered and a 500 for retry with backoff', async () => {
  const okDelivery = {
    id: 'd1', endpointId: 'e1', storeDomain: 'demo.mysapo.net', event: 'review.created',
    payload: { reviewId: 'r1' }, status: 'pending', attempts: 0, maxAttempts: 5, nextAttemptAt: null,
    endpoint,
  };
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push(`${String(url)} ${headers['x-f1genz-signature']}`);
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
  try {
    const { dispatcher, updates } = makeDispatcher({ fetchImpl: globalThis.fetch, deliveries: [okDelivery] });
    const result = await dispatcher.dispatchDue({ now: new Date(), resolve: async () => ['93.184.216.34'] });
    assert.deepEqual(result, { attempted: 1, delivered: 1, failed: 0 });
    assert.equal(calls.length, 1);
    assert.match(calls[0], /sha256=[a-f0-9]{64}$/);
    const finalWrite = updates[updates.length - 1];
    assert.equal(finalWrite.data.status, 'delivered');
    assert.equal(finalWrite.data.nextAttemptAt, null);
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = (async () => new Response('boom', { status: 500 })) as typeof fetch;
  try {
    const retryDelivery = { ...okDelivery, id: 'd2' };
    const { dispatcher, updates } = makeDispatcher({ fetchImpl: globalThis.fetch, deliveries: [retryDelivery] });
    const result = await dispatcher.dispatchDue({ now: new Date(), resolve: async () => ['93.184.216.34'] });
    assert.deepEqual(result, { attempted: 1, delivered: 0, failed: 1 });
    const finalWrite = updates[updates.length - 1];
    assert.equal(finalWrite.data.status, 'failed');
    assert.equal(finalWrite.data.responseStatus, 500);
    assert.ok(finalWrite.data.nextAttemptAt instanceof Date, 'a transient failure schedules a retry');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('dispatcher refuses an endpoint that resolves to a private address without calling fetch', async () => {
  const delivery = {
    id: 'd3', endpointId: 'e1', storeDomain: 'demo.mysapo.net', event: 'review.created',
    payload: {}, status: 'pending', attempts: 0, maxAttempts: 5, nextAttemptAt: null, endpoint,
  };
  const originalFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = (async () => { called += 1; return new Response('ok'); }) as typeof fetch;
  try {
    const { dispatcher, updates } = makeDispatcher({ fetchImpl: globalThis.fetch, deliveries: [delivery] });
    const result = await dispatcher.dispatchDue({ now: new Date(), resolve: async () => ['192.168.0.10'] });
    assert.equal(called, 0);
    assert.deepEqual(result, { attempted: 1, delivered: 0, failed: 1 });
    assert.match(String(updates[updates.length - 1].data.lastError), /non-public/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AI reply suggestion is refused with 503 when no key is configured', async () => {
  const env = cast<AppEnv>({ GEMINI_API_KEY: '', AI_MODEL: 'gemini-2.5-flash', NODE_ENV: 'test' });
  const rateLimit = { assertAllowed: async () => undefined };
  const service = new AiService(env, cast<IngressRateLimitService>(rateLimit));
  assert.equal(service.configured, false);
  await assert.rejects(
    () => service.suggestReply('demo.mysapo.net', { content: 'Tot', rating: 5 }),
    (error) => error instanceof ServiceUnavailableException,
  );
});

test('AI reply suggestion sanitises markup and caps the length', async () => {
  const env = cast<AppEnv>({ GEMINI_API_KEY: 'key', AI_MODEL: 'gemini-2.5-flash', NODE_ENV: 'test' });
  const charged: string[] = [];
  const rateLimit = { assertAllowed: async (bucket: string) => { charged.push(bucket); } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: '<b>Cảm ơn</b> bạn   đã ủng hộ shop!' }] } }],
  }), { status: 200 })) as typeof fetch;
  try {
    const service = new AiService(env, cast<IngressRateLimitService>(rateLimit));
    const result = await service.suggestReply('demo.mysapo.net', { content: 'Tot', rating: 5, author: 'An' });
    assert.equal(result.suggestion, 'Cảm ơn bạn đã ủng hộ shop!');
    assert.deepEqual(charged, ['ai:reply-suggestion']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('slider payload serves the compact contract: pinned then rating, image-only thumbnail, capped content', () => {
  const base = { author: 'An', content: 'Tot', media: [], created_at: 1_700_000_000_000 };
  const items = [
    { ...base, id: 'r1', rating: 3, pinned: false, created_at: 1_700_000_003_000 },
    { ...base, id: 'r2', rating: 5, pinned: false, created_at: 1_700_000_001_000 },
    { ...base, id: 'r3', rating: 4, pinned: true, created_at: 1_700_000_002_000 },
    {
      ...base, id: 'r4', rating: 2, verified: true,
      media: [{ url: 'https://cdn.test/clip.mp4', type: 'video' }],
    },
    {
      ...base, id: 'r5', rating: 2,
      media: [{ url: 'https://cdn.test/clip.mp4', type: 'video' }, { url: 'https://cdn.test/photo.jpg', type: 'image' }],
    },
    { ...base, id: 'r6', rating: 5, content: 'x'.repeat(400), title: 'T'.repeat(90) },
  ];
  const payload = buildSliderPayload(items, 15, 1_700_000_010_000);
  assert.deepEqual(payload.items.map((item) => item.id), ['r3', 'r2', 'r6', 'r1', 'r4', 'r5']);
  const byId = Object.fromEntries(payload.items.map((item) => [item.id, item]));
  assert.equal(byId.r4.m, undefined, 'a video url is never used as the thumbnail');
  assert.equal(byId.r5.m, 'https://cdn.test/photo.jpg');
  assert.equal(byId.r6.c.length, 220);
  assert.equal(byId.r6.t?.length, 60);
  assert.equal(byId.r4.v, 1);
  assert.deepEqual(Object.keys(byId.r5).sort(), ['a', 'c', 'd', 'id', 'm', 'r', 'v']);
  const clamped = buildSliderPayload(items, 100, 1_700_000_010_000);
  assert.equal(clamped.items.length, 6);
  assert.equal(buildSliderPayload(items, 2, 1).items.length, 5, 'a slider never shows fewer than five items');
  const odd = buildSliderPayload(items, Number.NaN, 1);
  assert.equal(odd.items.length, 6);
  assert.deepEqual(Object.keys(buildSliderPayload([], 15, 1)), ['v', 'updated_at', 'items']);
});

test('slider settings are fail-closed: unknown config or a disabled switch serves nothing', () => {
  assert.deepEqual(resolveSliderSettings(null), { enabled: false, count: 0 });
  assert.deepEqual(resolveSliderSettings(undefined), { enabled: false, count: 0 });
  assert.deepEqual(resolveSliderSettings({ curatedSliderEnabled: false, curatedSliderCount: 9 }), { enabled: false, count: 0 });
  assert.deepEqual(resolveSliderSettings({ curatedSliderEnabled: true }), { enabled: true, count: 15 });
  assert.deepEqual(resolveSliderSettings({ curatedSliderEnabled: true, curatedSliderCount: 2 }), { enabled: true, count: 5 });
  assert.deepEqual(resolveSliderSettings({ curatedSliderEnabled: true, curatedSliderCount: 99 }), { enabled: true, count: 15 });
  assert.deepEqual(resolveSliderSettings({ curatedSliderEnabled: true, curatedSliderCount: 7 }), { enabled: true, count: 7 });
});

test('slider payload stays under 8 kB by trimming content then titles, and caps the author', () => {
  const many = Array.from({ length: 15 }, (_, index) => ({
    id: `r${index}`,
    rating: 5,
    author: 'A'.repeat(400),
    title: 'T'.repeat(60),
    content: 'x'.repeat(220),
    media: [{ url: `https://cdn.test/${'p'.repeat(300)}-${index}.jpg`, type: 'image' }],
    created_at: 1_700_000_000_000 + index,
  }));
  const payload = buildSliderPayload(many, 15, 1_700_000_000_000);
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= 8000);
  assert.ok(payload.items.length >= 1, 'a pathological media url never blanks the rail entirely');
  assert.ok(payload.items.every((item) => item.a.length <= 80));
  assert.ok(payload.items.every((item) => item.c.length <= 160), 'content was trimmed to reach the byte cap');
});

test('public responses are marked no-store so a stale review list is never cached', () => {
  const headers: Record<string, string> = {};
  const interceptor = new PublicResponseInterceptor();
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ path: '/api/public/reviews/100' }),
      getResponse: () => ({ setHeader: (name: string, value: string) => { headers[name] = value; } }),
    }),
  };
  interceptor.intercept(cast(context), { handle: () => of({ data: [] }) });
  assert.equal(headers['Cache-Control'], 'no-store');
});
