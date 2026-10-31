import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ReviewService } from '../src/review/review.service';
import { ReviewProductStoreService } from '../src/review/review-product-store.service';
import { PublicReviewController } from '../src/review/public-review.controller';
import { applyFormModes, sanitizePublicMedia, type PublicReviewInput } from '../src/review/public-review-input';
import { UNREPLIED_WHERE } from '../src/review/review-where';
import type { WidgetConfig } from '../src/review/interfaces/widget-config.interface';

const STORE = 'demo.mysapo.net';
const SUMMARY = { avg: 5, count: 1, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 } };

const makeHarness = (options: {
  config?: Partial<WidgetConfig>;
  status?: string;
  product?: { deletedAt?: number } | null;
  purchased?: boolean | Error;
} = {}) => {
  const upserts: Array<Record<string, unknown>> = [];
  const purchaseCalls: Array<Record<string, unknown>> = [];
  const metafieldReads: string[] = [];
  const install = {
    shopId: 'shop_1',
    tokenVersion: 1,
    status: options.status ?? 'active',
    metadata: { reviewWidgetConfig: options.config ?? {} },
  };
  const prisma = {
    appInstall: { findUnique: async ({ where }: { where: { storeDomain: string } }) => (where.storeDomain === STORE ? { ...install } : null) },
  };
  const reviewStore = {
    getReviews: async () => ({ items: [] }),
    upsertReview: async (row: Record<string, unknown>) => { upserts.push(row); },
    calculatePublicSummary: async () => SUMMARY,
  };
  const catalogStore = {
    getProduct: async () => (options.product === undefined ? { productId: '100' } : options.product),
  };
  const purchaseStore = {
    hasPurchasedProduct: async (shopId: string, productId: string, identity: Record<string, unknown>) => {
      purchaseCalls.push({ shopId, productId, ...identity });
      if (options.purchased instanceof Error) throw options.purchased;
      return options.purchased ?? false;
    },
  };
  const pending = {
    markDirty: async () => new Date(),
    clear: async () => true,
    recordFailure: async () => undefined,
    drop: async () => undefined,
  };
  const sapoApi = {
    getProductMetafields: async (_s: string, _t: string, productId: string) => { metafieldReads.push(productId); return []; },
    createProductMetafield: async () => undefined,
    updateProductMetafield: async () => undefined,
  };
  const redis = { acquireLock: async () => ({ key: 'k', owner: 'o' }), releaseLock: async () => true };
  const service = new ReviewService(
    redis as never,
    prisma as never,
    sapoApi as never,
    reviewStore as never,
    catalogStore as never,
    purchaseStore as never,
    pending as never,
    {} as never,
  );
  return { service, upserts, purchaseCalls, metafieldReads };
};

const input = (over: Partial<PublicReviewInput> = {}): PublicReviewInput => ({
  rating: 5,
  content: 'Rat tot',
  author: 'An',
  media: [],
  ...over,
});

const hooks = (log: string[] = []) => ({
  chargeIdentity: async () => { log.push('charge'); },
  resolveToken: async () => { log.push('token'); return 'tok'; },
});

const errorCode = async (run: () => Promise<unknown>): Promise<{ status: number; code: unknown }> => {
  try {
    await run();
  } catch (err) {
    assert.ok(err instanceof HttpException, `expected HttpException, got ${String(err)}`);
    const body = err.getResponse();
    const code = typeof body === 'object' && body !== null && 'code' in body ? body.code : undefined;
    return { status: err.getStatus(), code };
  }
  throw new Error('expected rejection');
};

test('public submit answers 409 store_not_serving for non-serving installs and 404 product_not_found for unknown products', async () => {
  const gone = makeHarness({ status: 'uninstalled' });
  assert.deepEqual(await errorCode(() => gone.service.submitPublicReview(STORE, '100', input(), hooks())), {
    status: 409,
    code: 'store_not_serving',
  });
  assert.deepEqual(await errorCode(() => gone.service.getServingWidgetConfig(STORE)), { status: 409, code: 'store_not_serving' });

  for (const product of [null, { deletedAt: 5 }]) {
    const h = makeHarness({ product });
    assert.deepEqual(await errorCode(() => h.service.submitPublicReview(STORE, '100', input(), hooks())), {
      status: 404,
      code: 'product_not_found',
    });
    assert.equal(h.upserts.length, 0);
  }
});

test('requirePurchaseToReview rejects missing identity (400) and non-buyers (403) before anything is stored or the token is resolved', async () => {
  const log: string[] = [];
  const h = makeHarness({ config: { requirePurchaseToReview: true }, purchased: false });
  assert.deepEqual(await errorCode(() => h.service.submitPublicReview(STORE, '100', input(), hooks(log))), {
    status: 400,
    code: 'identity_required',
  });
  assert.deepEqual(
    await errorCode(() => h.service.submitPublicReview(STORE, '100', input({ email: 'a@example.com' }), hooks(log))),
    { status: 403, code: 'purchase_required' },
  );
  assert.equal(h.upserts.length, 0);
  assert.deepEqual(log, ['charge'], 'identity is charged once; no token is resolved for rejected submits');
});

test('a buyer is stored as verified and the public response never echoes verified, email or phone', async () => {
  const h = makeHarness({ config: { requirePurchaseToReview: true }, purchased: true });
  const result = await h.service.submitPublicReview(
    STORE,
    '100',
    input({ email: 'buyer@example.com', phone: '0901234567' }),
    hooks(),
  );
  assert.equal(h.upserts[0].verified, true);
  assert.deepEqual(h.purchaseCalls[0], { shopId: 'shop_1', productId: '100', email: 'buyer@example.com', phone: '0901234567' });
  assert.equal('verified' in result, false);
  assert.equal('email' in result, false);
  assert.equal('phone' in result, false);
});

test('without the purchase gate a failed lookup degrades to unverified; with the gate it is a 503', async () => {
  const open = makeHarness({ purchased: new Error('db down') });
  await open.service.submitPublicReview(STORE, '100', input({ email: 'a@example.com' }), hooks());
  assert.equal(open.upserts[0].verified, false);

  const gated = makeHarness({ config: { requirePurchaseToReview: true }, purchased: new Error('db down') });
  assert.deepEqual(
    await errorCode(() => gated.service.submitPublicReview(STORE, '100', input({ email: 'a@example.com' }), hooks())),
    { status: 503, code: 'purchase_check_unavailable' },
  );
});

test('form modes: hidden fields are dropped, required fields are rejected when empty', async () => {
  const config: WidgetConfig = {
    formPhoneMode: 'hidden',
    formEmailMode: 'hidden',
    formTitleMode: 'required',
    formContentMode: 'optional',
    reviewQnaDisplayMode: 'tabs',
  };
  const fields = applyFormModes(config, input({ title: 'Tot', email: 'a@example.com', phone: '0901234567' }));
  assert.deepEqual(fields, { content: 'Rat tot', title: 'Tot', email: undefined, phone: undefined });

  const h = makeHarness({ config: { formTitleMode: 'required' } });
  assert.deepEqual(await errorCode(() => h.service.submitPublicReview(STORE, '100', input(), hooks())), {
    status: 400,
    code: 'title_required',
  });
  const hidden = makeHarness({ config: { formEmailMode: 'hidden' } });
  await hidden.service.submitPublicReview(STORE, '100', input({ email: 'a@example.com' }), hooks());
  assert.equal(hidden.upserts[0].email, null);
});

test('only approved reviews trigger a Sapo metafield sync', async () => {
  const pendingRun = makeHarness();
  await pendingRun.service.submitPublicReview(STORE, '100', input(), hooks());
  assert.equal(pendingRun.upserts[0].status, 'pending');
  assert.deepEqual(pendingRun.metafieldReads, []);

  const approvedRun = makeHarness({ config: { autoApprove: true } });
  await approvedRun.service.submitPublicReview(STORE, '100', input(), hooks());
  assert.equal(approvedRun.upserts[0].status, 'approved');
  assert.deepEqual(approvedRun.metafieldReads, ['100']);
});

test('eligibility is uniform for non-serving stores, free when the gate is off, and charges the identity before the lookup when it is on', async () => {
  const charges: unknown[] = [];
  const charge = async (identity: unknown) => { charges.push(identity); };

  const off = makeHarness();
  assert.deepEqual(await off.service.checkPurchaseEligibility(STORE, '100', { email: 'a@example.com' }, charge), {
    eligible: true,
    reason: 'not_required',
  });
  assert.equal(off.purchaseCalls.length, 0);
  assert.equal(charges.length, 0);

  const gone = makeHarness({ status: 'declined', config: { requirePurchaseToReview: true } });
  assert.deepEqual(await gone.service.checkPurchaseEligibility(STORE, '100', { email: 'a@example.com' }, charge), {
    eligible: false,
    reason: 'not_purchased',
  });

  const on = makeHarness({ config: { requirePurchaseToReview: true }, purchased: true });
  assert.deepEqual(await on.service.checkPurchaseEligibility(STORE, '100', {}, charge), {
    eligible: false,
    reason: 'missing_identity',
  });
  assert.deepEqual(await on.service.checkPurchaseEligibility(STORE, '100', { phone: '0901234567' }, charge), {
    eligible: true,
    reason: 'verified',
  });
  assert.equal(charges.length, 1);
});

test('public media allowlist: own R2 uploads for this store, YouTube/Vimeo only as video', () => {
  const scope = { publicDomain: 'cdn.example.com', storeDomain: STORE, productId: '100' };
  const own = `https://cdn.example.com/reviews/${STORE}/100/abc/photo.jpg`;
  const media = [
    { url: own, type: 'image' },
    { url: own, type: 'video' },
    { url: 'https://www.youtube.com/watch?v=abc', type: 'video' },
    { url: 'https://vimeo.com/123456', type: 'video' },
    { url: 'https://www.youtube.com/watch?v=abc', type: 'image' },
    { url: 'https://evil.example.com/pixel.gif', type: 'image' },
    { url: `https://cdn.example.com/reviews/other.mysapo.net/100/x.jpg`, type: 'image' },
    { url: `https://cdn.example.com/reviews/${STORE}/101/x.jpg`, type: 'image' },
    { url: `https://cdn.example.com/reviews/${STORE}/../other/x.jpg`, type: 'image' },
    { url: `http://cdn.example.com/reviews/${STORE}/x.jpg`, type: 'image' },
    { url: `https://user:pw@cdn.example.com/reviews/${STORE}/x.jpg`, type: 'image' },
    { url: 'javascript:alert(1)', type: 'image' },
    { url: own, type: 'audio' },
    null,
  ];
  assert.deepEqual(
    sanitizePublicMedia(media, scope).map((m) => `${m.type}:${m.url}`),
    [`image:${own}`, `video:${own}`, 'video:https://www.youtube.com/watch?v=abc', 'video:https://vimeo.com/123456'],
  );
  assert.deepEqual(sanitizePublicMedia(media, { publicDomain: '', storeDomain: STORE, productId: '100' }).map((m) => m.url), [
    'https://www.youtube.com/watch?v=abc',
    'https://vimeo.com/123456',
  ]);
  assert.equal(sanitizePublicMedia(Array(10).fill({ url: own, type: 'image' }), scope).length, 5);
  assert.deepEqual(sanitizePublicMedia('nope', scope), []);
});

test('public summaries validate ids, cap the list and use one grouped query', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const prisma = {
    appInstall: { findUnique: async () => ({ shopId: 'shop_1', metadata: {}, status: 'active' }) },
    reviewProduct: {
      groupBy: async (args: Record<string, unknown>) => {
        calls.push(args);
        return [{ productId: '1', rating: 5, _count: { id: 2 } }, { productId: '1', rating: 3, _count: { id: 1 } }];
      },
    },
  };
  const store = new ReviewProductStoreService(prisma as never);
  const service = new ReviewService({} as never, prisma as never, {} as never, store, {} as never, {} as never, {} as never, {} as never);
  const ids = ['1', '2', 'abc', '1', '12x', ...Array.from({ length: 150 }, (_, i) => String(1000 + i))];
  const out = await service.getPublicSummaries(STORE, ids);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].by, ['productId', 'rating']);
  const requested = (calls[0].where as { productId: { in: string[] } }).productId.in;
  assert.equal(requested.length, 100);
  assert.ok(requested.every((id) => /^\d+$/.test(id)));
  assert.equal(out['1'].count, 3);
  assert.equal(out['1'].avg, 4.3);
  assert.equal(out['2'].count, 0);
  assert.equal('abc' in out, false);
});

test('admin list composes unreplied with search and filters by star', async () => {
  const wheres: Array<Record<string, unknown>> = [];
  const prisma = {
    appInstall: { findUnique: async () => ({ shopId: 'shop_1', metadata: {} }) },
    catalogProduct: { findMany: async () => [{ productId: '100', title: 'Fresh title' }] },
    reviewProduct: {
      groupBy: async () => [],
      count: async ({ where }: { where: Record<string, unknown> }) => { wheres.push(where); return 1; },
      findMany: async () => [{
        reviewId: 'r1', rating: 4, content: 'c', author: 'a', email: null, phone: null, title: null, media: null,
        status: 'approved', verified: false, pinned: false, reply: null, repliedAt: null, sourceRawJson: null,
        productId: '100', productTitle: 'Old title', productName: null, productHandle: null, productImage: null,
        createdAt: 1n, updatedAt: 1n,
      }],
    },
  };
  const service = new ReviewService({} as never, prisma as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  const page = await service.listAllReviews('tok', STORE, { status: 'unreplied', search: 'tot', star: 4, productId: '100' });
  const listWhere = wheres[wheres.length - 1];
  assert.equal(listWhere.rating, 4);
  assert.equal(listWhere.productId, '100');
  assert.equal(listWhere.status, undefined);
  const and = listWhere.AND as Array<Record<string, unknown>>;
  assert.deepEqual(and[0], UNREPLIED_WHERE);
  assert.ok(Array.isArray(and[1].OR) && and[1].OR.length === 2);
  assert.equal(page.items[0].productTitle, 'Fresh title');
});

test('store upsert clears media with DbNull, keeps it when absent, and writes the value when given', async () => {
  const writes: Array<{ create: Record<string, unknown>; update: Record<string, unknown> }> = [];
  const prisma = {
    catalogProduct: { findUnique: async () => null },
    reviewProduct: { upsert: async (args: { create: Record<string, unknown>; update: Record<string, unknown> }) => { writes.push(args); return {}; } },
  };
  const store = new ReviewProductStoreService(prisma as never);
  const base = { shopId: 's', productId: '1', reviewId: 'r', rating: 5, content: 'c', author: 'a' };
  await store.upsertReview({ ...base, media: null });
  await store.upsertReview({ ...base });
  await store.upsertReview({ ...base, media: [{ url: 'https://x.test/a.jpg', type: 'image' }] });
  assert.equal(writes[0].update.media, Prisma.DbNull);
  assert.equal(writes[1].update.media, undefined);
  assert.deepEqual(writes[2].update.media, [{ url: 'https://x.test/a.jpg', type: 'image' }]);
});

test('eligibility and submit charge a per-identity bucket without the product id or the raw identity', async () => {
  const buckets: Array<{ bucket: string; key: string }> = [];
  const rateLimit = {
    assertAllowed: async (bucket: string, key: string) => { buckets.push({ bucket, key }); },
  };
  const service = {
    checkPurchaseEligibility: async (_s: string, _p: string, identity: Record<string, string>, charge: (i: Record<string, string>) => Promise<void>) => {
      await charge(identity);
      return { eligible: true, reason: 'verified' };
    },
  };
  const env = { PUBLIC_WRITE_RATE_LIMIT_WINDOW_SECONDS: 60, PUBLIC_WRITE_RATE_LIMIT_MAX: 20, APP_SESSION_SECRET: 'x'.repeat(48), R2_PUBLIC_DOMAIN: 'cdn.example.com' };
  const controller = new PublicReviewController(service as never, {} as never, env as never, rateLimit as never);
  const req = { ip: '203.0.113.9', headers: {} };
  await controller.checkPurchaseEligibility('4242', req as never, { email: 'Buyer@Example.com', phone: '0901 234 567' }, STORE);
  const identityBuckets = buckets.filter((b) => b.bucket === 'public-review:identity');
  assert.equal(identityBuckets.length, 2);
  for (const { key } of identityBuckets) {
    assert.match(key, new RegExp(`^${STORE.replace(/\./g, '\\.')}\\|[0-9a-f]{64}$`));
  }
  assert.notEqual(identityBuckets[0].key, identityBuckets[1].key);
  assert.ok(buckets.some((b) => b.bucket === 'public-review:eligibility' && b.key.includes('203.0.113.9')));

  await assert.rejects(
    () => controller.checkPurchaseEligibility('4242', req as never, { email: 'not-an-email' }, STORE),
    /Email is invalid/,
  );
  await assert.rejects(
    () => controller.checkPurchaseEligibility('4242', req as never, { phone: '12' }, STORE),
    /Phone is invalid/,
  );
});
