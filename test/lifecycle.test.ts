import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'crypto';
import type { Request } from 'express';

import { loadEnv, type AppEnv } from '../src/config/env.schema';
import { RedisService } from '../src/redis/redis.service';

import { OAuthStateService, isSafeRedirect } from '../src/sapo/oauth-state.service';
import { SessionService } from '../src/sapo/session.service';
import { HmacVerifierService } from '../src/sapo/hmac-verifier.service';
import { ShopDomainService, normalizeShopDomain } from '../src/sapo/shop-domain.service';
import { fake } from './support/fakes';
import { PrismaService } from '../src/database/prisma.service';
import { UninstallService } from '../src/sapo/uninstall.service';
import { CatalogSyncService } from '../src/catalog/catalog-sync.service';
import { PurchaseStoreService } from '../src/purchase/purchase-store.service';
import { SapoApiService } from '../src/sapo/sapo-api.service';
import { WebhookRegistrationService } from '../src/sapo/webhook-registration.service';
import { normalizeWebhookTopic, isKnownWebhookTopic, WEBHOOK_SUBSCRIBE_TOPICS } from '../src/sapo/webhook-topic-normalizer';
import { WebhookService } from '../src/sapo/webhook.service';
import { LifecycleLockService } from '../src/sapo/lifecycle-lock.service';
import { TokenEncryptionService } from '../src/sapo/token-encryption.service';
import { SapoService } from '../src/sapo/sapo.service';
import { callLimitPauseMs } from '../src/sapo/sapo-api.service';

import { IngressRateLimitService } from '../src/common/security/ingress-rate-limit.service';
import { clientFingerprint } from '../src/common/security/client-fingerprint';
import { isTrustedUnsafeOrigin } from '../src/common/security/origin-policy';

import { toPublicReview } from '../src/review/review.service';
import { toPublicQuestion } from '../src/qna/qna.service';
import { QnaStoreService } from '../src/qna/qna-store.service';
import { ReviewProductStoreService } from '../src/review/review-product-store.service';
import { DashboardService } from '../src/dashboard/dashboard.service';
import { CatalogProductStoreService } from '../src/catalog/catalog-product-store.service';
import { StorefrontService } from '../src/storefront/storefront.service';

const makeEnv = (overrides: Partial<AppEnv> = {}): AppEnv => ({
  NODE_ENV: 'test',
  PORT: 3333,
  FRONTEND_URL: 'http://localhost:5173',
  API_BASE_URL: 'http://localhost:3333',
  CORS_ALLOWED_ORIGINS: ['http://localhost:5173'],
  TRUST_PROXY: false,
  REQUEST_BODY_LIMIT: '1mb',
  WEBHOOK_BODY_LIMIT: '256kb',
  SAPO_CLIENT_ID: 'sapo-client-id',
  SAPO_CLIENT_SECRET: 'sapo-client-secret-for-tests',
  SAPO_SCOPE: 'read_products,write_products,read_orders',
  SAPO_INSTALL_CALLBACK_URL: 'https://app.test/api/oauth/install/callback',
  SAPO_LOGIN_CALLBACK_URL: 'https://app.test/api/oauth/install/login/callback',
  SAPO_API_MAX_CONCURRENT: 4,
  R2_WORKER_URL: '',
  R2_UPLOAD_SECRET: '',
  R2_PUBLIC_DOMAIN: '',
  APP_SESSION_SECRET: 'test-session-secret-with-at-least-32-bytes',
  APP_SESSION_TTL_SECONDS: 3600,
  SESSION_HANDOFF_TTL_SECONDS: 60,
  SESSION_COOKIE_NAME: 'sapo_app_session',
  SESSION_COOKIE_DOMAIN: '',
  REDIS_HOST: '',
  REDIS_PORT: 6379,
  REDIS_USERNAME: '',
  REDIS_PASSWORD: '',
  REDIS_TLS: false,
  REDIS_KEY_PREFIX: 'sapo-app-base-test',
  DATABASE_URL: 'postgresql://placeholder',
  DIRECT_URL: 'postgresql://placeholder',
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  AUTH_RATE_LIMIT_WINDOW_SECONDS: 60,
  AUTH_RATE_LIMIT_MAX: 100,
  SESSION_EXCHANGE_RATE_LIMIT_MAX: 100,
  PUBLIC_WRITE_RATE_LIMIT_WINDOW_SECONDS: 60,
  PUBLIC_WRITE_RATE_LIMIT_MAX: 3,
  READINESS_TOKEN: 'readiness-token',
  BUILD_SHA: 'test',
  ...overrides,
});

const rawFrom = (env: AppEnv): Record<string, string> => {
  const raw: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === null) continue;
    raw[key] = Array.isArray(value) ? value.join(',') : String(value);
  }
  return raw;
};

test('loadEnv parses the new public-write rate-limit vars', () => {
  const env = loadEnv(rawFrom(makeEnv()));
  assert.equal(env.NODE_ENV, 'test');
  assert.equal(env.PUBLIC_WRITE_RATE_LIMIT_WINDOW_SECONDS, 60);
  assert.equal(env.PUBLIC_WRITE_RATE_LIMIT_MAX, 3);
});

test('loadEnv rejects identical secrets', () => {
  const raw = rawFrom(makeEnv());
  assert.throws(
    () => loadEnv({ ...raw, APP_SESSION_SECRET: raw.SAPO_CLIENT_SECRET }),
    /must be distinct/,
  );
});

test('OAuth state and session handoff are atomic one-time credentials', async () => {
  const env = makeEnv();
  const redis = new RedisService({ keyPrefix: 'test-atomic' });
  const oauthState = new OAuthStateService(redis);
  const sessions = new SessionService(env, redis);

  const created = await oauthState.create('login', { storeDomain: 'demo.mysapo.net', redirectTo: '/dashboard?tab=home' });
  const consumed = await oauthState.consume(created.state, 'login');
  assert.equal(consumed.storeDomain, 'demo.mysapo.net');
  assert.equal(consumed.redirectTo, '/dashboard?tab=home');
  await assert.rejects(() => oauthState.consume(created.state, 'login'), /Invalid or expired OAuth state/);

  const installState = await oauthState.create('install', { storeDomain: 'demo.mysapo.net' });
  await assert.rejects(() => oauthState.consume(installState.state, 'login'), /Invalid or expired OAuth state/);

  const raceState = await oauthState.create('login', { storeDomain: 'demo.mysapo.net' });
  const settled = await Promise.allSettled([
    oauthState.consume(raceState.state, 'login'),
    oauthState.consume(raceState.state, 'login'),
  ]);
  assert.equal(settled.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(settled.filter((r) => r.status === 'rejected').length, 1);

  const handoff = await sessions.createHandoff('demo.mysapo.net', '/dashboard');
  const used = await sessions.consumeHandoff(handoff.handoffCode);
  assert.equal(used.storeDomain, 'demo.mysapo.net');
  await assert.rejects(() => sessions.consumeHandoff(handoff.handoffCode), /Invalid or expired session handoff/);
});

test('isSafeRedirect rejects absolute, external, and blocked-prefix paths', () => {
  assert.equal(isSafeRedirect('/dashboard'), true);
  assert.equal(isSafeRedirect('/dashboard?tab=home'), true);
  assert.equal(isSafeRedirect('https://evil.example'), false);
  assert.equal(isSafeRedirect('//evil.example'), false);
  assert.equal(isSafeRedirect('/api/oauth/install/callback'), false);
  assert.equal(isSafeRedirect('/install'), false);
  assert.equal(isSafeRedirect('javascript:alert(1)'), false);
  assert.equal(isSafeRedirect(''), false);
  assert.equal(isSafeRedirect(undefined), false);
});

test('session token signs, verifies, and rejects tampering and expiry', () => {
  const env = makeEnv();
  const sessions = new SessionService(env, new RedisService({ keyPrefix: 'test-session' }));

  const token = sessions.createSessionToken('demo.mysapo.net', 4);
  const payload = sessions.verifySessionToken(token);
  assert.equal(payload.storeDomain, 'demo.mysapo.net');
  assert.equal(payload.type, 'sapo_app_session');
  assert.equal(payload.gen, 4);

  const [h, b, s] = token.split('.');
  assert.throws(() => sessions.verifySessionToken(`${h}.${b}.${'a'.repeat(s.length)}`), /Invalid auth session/);
  assert.throws(() => sessions.verifySessionToken('not-a-jwt'), /Invalid auth session/);

  const [eh, eb] = token.split('.');
  const decoded: Record<string, unknown> = JSON.parse(Buffer.from(eb, 'base64url').toString('utf8'));
  decoded.exp = Math.floor(Date.now() / 1000) - 10;
  const newBody = Buffer.from(JSON.stringify(decoded)).toString('base64url');
  const newSig = sessions['sign'](`${eh}.${newBody}`);
  assert.throws(() => sessions.verifySessionToken(`${eh}.${newBody}.${newSig}`), /Expired auth session/);
});

test('launch HMAC verifier accepts Base64 signature over sorted store/timestamp and rejects bad/missing/expired', () => {
  const env = makeEnv();
  const verifier = new HmacVerifierService(env);
  const sign = (message: string) => createHmac('sha256', env.SAPO_CLIENT_SECRET).update(message).digest('base64');
  const timestamp = Math.floor(Date.now() / 1000);
  const message = `store=demo.mysapo.net&timestamp=${timestamp}`;
  const hmac = sign(message);
  assert.equal(hmac.length, 44);
  assert.ok(hmac.endsWith('='));

  const parsed = verifier.verifyLaunchQuery(`${message}&hmac=${encodeURIComponent(hmac)}`);
  assert.equal(parsed.get('store'), 'demo.mysapo.net');
  assert.doesNotThrow(() => verifier.verifyLaunchQuery(`hmac=${encodeURIComponent(hmac)}&timestamp=${timestamp}&store=demo.mysapo.net`));

  const hex = createHmac('sha256', env.SAPO_CLIENT_SECRET).update(message).digest('hex');
  assert.throws(() => verifier.verifyLaunchQuery(`${message}&hmac=${hex}`), /Invalid hmac/);
  assert.throws(() => verifier.verifyLaunchQuery(`${message}&hmac=${encodeURIComponent(hmac.toLowerCase())}`), /Invalid hmac/);
  assert.throws(() => verifier.verifyLaunchQuery(`${message}&hmac=deadbeef`), /Invalid hmac/);
  assert.throws(() => verifier.verifyLaunchQuery(`${message}&hmac=`), /Invalid hmac/);
  assert.throws(() => verifier.verifyLaunchQuery(message), /Missing hmac/);

  const stale = Math.floor(Date.now() / 1000) - 600;
  const staleMessage = `store=demo.mysapo.net&timestamp=${stale}`;
  assert.throws(() => verifier.verifyLaunchQuery(`${staleMessage}&hmac=${encodeURIComponent(sign(staleMessage))}`), /HMAC timestamp expired/);
});

test('launch HMAC keeps Base64 plus and slash characters intact', () => {
  const env = makeEnv();
  const verifier = new HmacVerifierService(env);
  const base = Math.floor(Date.now() / 1000);
  let tested = 0;
  for (let offset = 0; offset < 400 && tested < 3; offset += 1) {
    const message = `store=demo.mysapo.net&timestamp=${base - (offset % 200)}`;
    const hmac = createHmac('sha256', env.SAPO_CLIENT_SECRET).update(message).digest('base64');
    if (!/[+/]/.test(hmac)) continue;
    tested += 1;
    assert.doesNotThrow(() => verifier.verifyLaunchQuery(`${message}&hmac=${encodeURIComponent(hmac)}`));
    assert.doesNotThrow(() => verifier.verifyLaunchQuery(`${message}&hmac=${hmac}`));
  }
  assert.ok(tested > 0, 'expected at least one signature containing + or /');
});

test('webhook body HMAC verifies with Sapo signature and rejects tampering', () => {
  const env = makeEnv();
  const verifier = new HmacVerifierService(env);
  const body = Buffer.from(JSON.stringify({ id: 1, title: 'x' }));
  const signature = createHmac('sha256', env.SAPO_CLIENT_SECRET).update(body).digest('base64');

  verifier.verifyWebhookBody(body, signature);
  assert.throws(() => verifier.verifyWebhookBody(body, 'deadbeef'), /Invalid webhook HMAC/);
  assert.throws(() => verifier.verifyWebhookBody(Buffer.from(''), signature), /Missing raw webhook body/);
  assert.throws(() => verifier.verifyWebhookBody(body, undefined), /Missing webhook HMAC/);
});

test('shop domain normalization and store-domain mapping', async () => {
  const redis = new RedisService({ keyPrefix: 'test-domain' });
  const service = new ShopDomainService(redis);

  assert.equal(normalizeShopDomain('Demo.MySapo.net'), 'demo.mysapo.net');
  assert.equal(normalizeShopDomain('https://demo.mysapo.net/'), 'demo.mysapo.net');
  assert.equal(normalizeShopDomain('www.demo.com'), 'demo.com');

  await service.saveMapping('shop_1', 'demo.mysapo.net');
  assert.equal(await service.resolveStoreDomain('https://demo.mysapo.net/'), 'shop_1');
  await service.removeMapping('demo.mysapo.net');
  assert.equal(await service.resolveStoreDomain('demo.mysapo.net'), null);
});

type WebhookHooks = {
  uninstall?: (storeDomain: string) => Promise<unknown>;
  onProduct?: (storeDomain: string, productId: string) => void;
};

const buildWebhookService = (env: AppEnv, redis: RedisService, prisma: unknown, hooks: WebhookHooks = {}): WebhookService => {
  const db = fake<PrismaService>(prisma);
  return new WebhookService(
    db,
    new HmacVerifierService(env),
    new ShopDomainService(redis, db),
    fake<UninstallService>({
      uninstall: hooks.uninstall ?? (async (storeDomain: string) => ({ storeDomain, uninstalled: true, domainsCleared: 0 })),
    }),
    fake<SapoService>({ resolveAccessToken: async () => 'access-token' }),
    fake<CatalogSyncService>({
      handleProductWebhookWithToken: async (storeDomain: string, productId: string) => {
        hooks.onProduct?.(storeDomain, productId);
      },
    }),
    fake<PurchaseStoreService>({ toStoredOrder: (payload: unknown) => payload, syncOrder: async () => true }),
  );
};

const signedWebhook = (env: AppEnv, payload: Record<string, unknown>, headers: Record<string, string>) => {
  const rawBody = Buffer.from(JSON.stringify(payload));
  const signature = createHmac('sha256', env.SAPO_CLIENT_SECRET).update(rawBody).digest('base64');
  return {
    headers: { 'x-sapo-hmac-sha256': signature, ...headers },
    query: {},
    body: payload,
    rawBody,
  };
};

test('app/uninstalled re-delivery after domain tombstone resolves via payload storeDomain', async () => {
  const env = makeEnv();
  const redis = new RedisService({ keyPrefix: 'test-ws-uninstall' });
  const prisma = {
    appInstall: { findUnique: async () => null },
    shopDomain: { findFirst: async () => null },
    webhookEvent: {
      create: async () => ({ id: 'evt_1', status: 'received' }),
      findUnique: async () => null,
      update: async () => ({}),
    },
  };
  const service = buildWebhookService(env, redis, prisma);

  const result = await service.handle(
    signedWebhook(env, { store_domain: 'demo.mysapo.net', id: 'shop_1' }, { 'x-sapo-topic': 'app_uninstall_webhook' }),
  );
  assert.equal(result.storeDomain, 'demo.mysapo.net');
  assert.equal(result.uninstalled, true);
});

test('concurrent duplicate webhook with same idempotency key returns inProgress instead of running twice', async () => {
  const env = makeEnv();
  const redis = new RedisService({ keyPrefix: 'test-ws-race' });
  let createCalls = 0;
  const prisma = {
    appInstall: { findUnique: async () => null },
    shopDomain: { findFirst: async () => null },
    webhookEvent: {
      create: async () => { createCalls += 1; if (createCalls > 1) throw new Error('P2002 unique constraint'); return { id: 'evt_1', status: 'received' }; },
      findUnique: async () => ({ id: 'evt_1', status: 'processing' }),
      update: async () => ({}),
    },
  };
  const service = buildWebhookService(env, redis, prisma);

  const makeInput = () =>
    signedWebhook(env, { id: 100, title: 'x', store_domain: 'demo.mysapo.net' }, { 'x-sapo-topic': 'products/create' });

  const first = await service.handle(makeInput());
  assert.equal(first.ok, true);
  const second = await service.handle(makeInput());
  assert.equal(second.inProgress, true);
  assert.equal(createCalls, 2);
});

test('product webhook whose payload carries no store domain resolves the store from the x-sapo-shop-domain header', async () => {
  const env = makeEnv();
  const redis = new RedisService({ keyPrefix: 'test-ws-header-identity' });
  const handled: Array<{ storeDomain: string; productId: unknown }> = [];
  const prisma = {
    appInstall: { findUnique: async () => null },
    shopDomain: {
      findFirst: async ({ where }: { where: { domain?: string } }) =>
        where.domain === 'demo.mysapo.net' ? { storeDomain: 'demo.mysapo.net' } : null,
    },
    webhookEvent: {
      create: async () => ({ id: 'evt_1', status: 'received' }),
      findUnique: async () => null,
      update: async () => ({}),
    },
  };
  const service = buildWebhookService(env, redis, prisma, {
    onProduct: (storeDomain, productId) => { handled.push({ storeDomain, productId }); },
  });

  const result = await service.handle(
    signedWebhook(
      env,
      { id: 95741457, name: 'Real Sapo product payload', vendor: 'F1GENZ' },
      { 'x-sapo-topic': 'products/create', 'x-sapo-shop-domain': 'demo.mysapo.net' },
    ),
  );
  assert.equal(result.ok, true);
  assert.equal(result.storeDomain, 'demo.mysapo.net');
  assert.deepEqual(handled, [{ storeDomain: 'demo.mysapo.net', productId: '95741457' }]);
});

test('idempotency key: a non-empty x-sapo-event-id decides it, an empty one falls back to topic, store and payload', async () => {
  const env = makeEnv();
  const redis = new RedisService({ keyPrefix: 'test-ws-key-stability' });
  const keys: string[] = [];
  const prisma = {
    appInstall: { findUnique: async () => ({ shopId: 'shop_1', status: 'active', lifecycleGeneration: 1 }) },
    shopDomain: { findFirst: async () => null },
    webhookEvent: {
      create: async ({ data }: { data: { idempotencyKey: string } }) => { keys.push(data.idempotencyKey); return { id: 'evt_1', status: 'received' }; },
      findUnique: async () => null,
      update: async () => ({}),
    },
  };
  const service = buildWebhookService(env, redis, prisma);
  const deliver = (payload: Record<string, unknown>, eventId: string): Promise<Record<string, unknown>> =>
    service.handle(signedWebhook(env, { store_domain: 'demo.mysapo.net', ...payload }, { 'x-sapo-topic': 'products/update', 'x-sapo-event-id': eventId }));

  await deliver({ id: 100, name: 'a' }, 'evt-1');
  await deliver({ id: 100, name: 'b' }, 'evt-1');
  assert.equal(keys[0], keys[1], 'the provider event id alone identifies a delivery');

  await deliver({ id: 100, name: 'a' }, '');
  await deliver({ id: 100, name: 'a' }, '');
  await deliver({ id: 100, name: 'b' }, '');
  assert.equal(keys[2], keys[3], 'an empty event id keeps the key stable for byte-identical deliveries');
  assert.notEqual(keys[3], keys[4], 'an empty event id still separates different payloads');
  assert.notEqual(keys[0], keys[2]);
});

test('webhook topic normalization covers uninstall/store/product/order and unknown', () => {
  assert.equal(normalizeWebhookTopic('app_charge_update'), 'unknown');
  assert.equal(normalizeWebhookTopic('app_uninstall_webhook'), 'app/uninstalled');
  assert.equal(normalizeWebhookTopic('store/update'), 'store/update');
  assert.equal(normalizeWebhookTopic('shop/update'), 'unknown');
  assert.equal(normalizeWebhookTopic('products/create'), 'products/create');
  assert.equal(normalizeWebhookTopic('orders/updated'), 'orders/updated');
  assert.equal(normalizeWebhookTopic('orders/cancelled'), 'orders/cancelled');
  assert.equal(normalizeWebhookTopic('mystery/topic'), 'unknown');
  assert.equal(isKnownWebhookTopic('app/charge'), false);
  assert.equal(isKnownWebhookTopic('app/uninstalled'), true);
  assert.equal(isKnownWebhookTopic('nope/nope'), false);
  assert.ok(WEBHOOK_SUBSCRIBE_TOPICS.includes('store/update'));
  assert.ok(!(WEBHOOK_SUBSCRIBE_TOPICS as readonly string[]).includes('shop/update'));
  assert.ok(!(WEBHOOK_SUBSCRIBE_TOPICS as readonly string[]).includes('app/charge'));
  assert.equal(WEBHOOK_SUBSCRIBE_TOPICS.length, 10);
});

test('public-write rate limit throttles per store + client fingerprint', async () => {
  const env = makeEnv();
  const rateLimit = new IngressRateLimitService();
  const bucket = 'public-review:submit';
  const fingerprint = 'demo.mysapo.net|1.2.3.4';

  for (let i = 0; i < env.PUBLIC_WRITE_RATE_LIMIT_MAX; i += 1) {
    await rateLimit.assertAllowed(bucket, fingerprint, env.PUBLIC_WRITE_RATE_LIMIT_WINDOW_SECONDS, env.PUBLIC_WRITE_RATE_LIMIT_MAX);
  }
  await assert.rejects(
    () => rateLimit.assertAllowed(bucket, fingerprint, env.PUBLIC_WRITE_RATE_LIMIT_WINDOW_SECONDS, env.PUBLIC_WRITE_RATE_LIMIT_MAX),
    /Rate limit exceeded/,
  );
  await rateLimit.assertAllowed(bucket, 'demo.mysapo.net|9.9.9.9', env.PUBLIC_WRITE_RATE_LIMIT_WINDOW_SECONDS, env.PUBLIC_WRITE_RATE_LIMIT_MAX);
});

test('clientFingerprint extracts the first IP from the request', () => {
  assert.equal(clientFingerprint(fake<Request>({ ip: '203.0.113.5, 10.0.0.1', socket: { remoteAddress: '10.0.0.1' } })), '203.0.113.5');
  assert.equal(clientFingerprint(fake<Request>({ socket: { remoteAddress: '10.0.0.1' } })), '10.0.0.1');
  assert.equal(clientFingerprint(fake<Request>({})), 'unknown');
});

test('origin policy trusts safe methods and allowed origins for unsafe ones', () => {
  const env = makeEnv();
  const options = { frontendUrl: env.FRONTEND_URL, apiBaseUrl: env.API_BASE_URL, allowedOrigins: env.CORS_ALLOWED_ORIGINS };
  assert.equal(isTrustedUnsafeOrigin(fake<Request>({ method: 'GET', headers: { origin: 'http://evil.example' } }), options), true);
  assert.equal(isTrustedUnsafeOrigin(fake<Request>({ method: 'POST', headers: { origin: 'http://evil.example' } }), options), false);
  assert.equal(isTrustedUnsafeOrigin(fake<Request>({ method: 'POST', headers: { origin: 'http://localhost:5173' } }), options), true);
});

test('SapoService startLogin validates mysapo.net shop domain and builds authorize URL', async () => {
  const env = makeEnv();
  const redis = new RedisService({ keyPrefix: 'test-sapo-svc' });
  const service = new SapoService(
    env,
    fake<PrismaService>({}),
    new OAuthStateService(redis),
    fake<SapoApiService>({}),
    new SessionService(env, redis),
    new TokenEncryptionService(env),
    new ShopDomainService(redis),
    new LifecycleLockService(redis),
    fake<WebhookRegistrationService>({}),
    fake<StorefrontService>({}),
  );

  const result = await service.startLogin({ storeDomain: 'demo.mysapo.net', redirectTo: '/dashboard' });
  assert.match(result.url, /^https:\/\/demo\.mysapo\.net\/admin\/oauth\/authorize\?/);
  assert.match(result.url, /client_id=sapo-client-id/);

  await assert.rejects(() => service.startLogin({ storeDomain: 'evil.example' }), /valid Sapo shop domain/);
  await assert.rejects(() => service.startLogin({}), /storeDomain is required/);
});

test('public review mapper strips contact PII (email/phone)', () => {
  const review = toPublicReview({
    reviewId: 'rev_1', rating: 5, content: 'Great', author: 'Nguyen A',
    email: 'a@example.com', phone: '0901234567', title: 'T', media: [],
    status: 'approved', verified: true, pinned: false, reply: null, repliedAt: null,
    sourceRawJson: null, createdAt: 1, updatedAt: 2,
  });
  assert.equal(review.email, undefined);
  assert.equal(review.phone, undefined);
  assert.equal(review.rating, 5);
  assert.equal(review.author, 'Nguyen A');
});

test('public question mapper strips contact PII (email/phone)', () => {
  const question = toPublicQuestion({
    id: 'row_1', shopId: 'shop_1', productHandle: 'p-1', productImage: null,
    questionId: 'q_1', question: 'Hỏi?', author: 'Nguyen B',
    email: 'b@example.com', phone: '0987654321', answer: null, answeredBy: null,
    status: 'answered', createdAt: 0n, updatedAt: 0n, answeredAt: 0n,
    sourceRawJson: null, productId: 'p_1', productTitle: 'T', productName: 'T',
  });
  assert.equal(question.email, undefined);
  assert.equal(question.phone, undefined);
  assert.equal(question.question, 'Hỏi?');
});

test('call-limit header pauses only when the leaky bucket is nearly full', () => {
  const pause = (value?: string) => callLimitPauseMs(new Headers(value ? { 'X-Sapo-Api-Call-Limit': value } : {}));
  assert.equal(pause(), 0);
  assert.equal(pause('garbage'), 0);
  assert.equal(pause('10/40'), 0);
  assert.equal(pause('36/40'), 0);
  assert.equal(pause('37/40'), 1000);
  assert.equal(pause('40/40'), 2000);
});

test('SAPO_SCOPE is normalized to the comma-separated form Sapo documents', () => {
  assert.equal(loadEnv({ SAPO_SCOPE: 'read_products write_products,  read_orders' }).SAPO_SCOPE, 'read_products,write_products,read_orders');
  assert.ok(!/\s/.test(loadEnv({}).SAPO_SCOPE));
});

test('storefront config is written as config JSON plus scalar api_url and store_domain metafields, updating existing ones', async () => {
  const calls: Array<{ op: string; key?: string; id?: string; value: string }> = [];
  const sapoApi = {
    getMetafields: async () => [{ id: 7, namespace: 'f1genz', key: 'config', value: '{}' }],
    updateMetafield: async (_domain: string, _token: string, id: string, patch: { value: string }) => { calls.push({ op: 'update', id, value: patch.value }); },
    createMetafield: async (_domain: string, _token: string, mf: { key: string; value: string }) => { calls.push({ op: 'create', key: mf.key, value: mf.value }); },
  };
  const service = new StorefrontService(fake<SapoApiService>(sapoApi), makeEnv({ API_BASE_URL: 'https://api.test/' }));
  await service.writeStorefrontConfig('demo.mysapo.net', 'token');
  assert.deepEqual(calls, [
    { op: 'update', id: '7', value: JSON.stringify({ apiUrl: 'https://api.test', storeDomain: 'demo.mysapo.net' }) },
    { op: 'create', key: 'api_url', value: 'https://api.test' },
    { op: 'create', key: 'store_domain', value: 'demo.mysapo.net' },
  ]);
});

test('catalog normalizer maps the Sapo product shape (name, alias, published_on)', () => {
  const store = new CatalogProductStoreService({} as never);
  const row = store.normalizeSapoProduct('shop_1', {
    id: 95252031,
    name: 'Nuoc tay trang',
    alias: 'nuoc-tay-trang',
    vendor: 'Bioderma',
    product_type: 'Lam sach',
    published_on: '2026-10-27T03:56:36Z',
  });
  assert.equal(row?.title, 'Nuoc tay trang');
  assert.equal(row?.handle, 'nuoc-tay-trang');
  assert.equal(row?.published, true);
});

test('qna stats are shop-wide without a productId and product-scoped with one', async () => {
  const wheres: Array<Record<string, unknown>> = [];
  const prisma = {
    qnaQuestion: {
      aggregate: async ({ where }: { where: Record<string, unknown> }) => { wheres.push(where); return { _count: { id: 3 } }; },
      count: async ({ where }: { where: Record<string, unknown> }) => { wheres.push(where); return 2; },
    },
  };
  const store = new QnaStoreService(prisma as never);
  const shop = await store.getStats('shop_1');
  assert.deepEqual(shop, { total: 3, answered: 2, unanswered: 1 });
  assert.ok(wheres.every((w) => !('productId' in w)), 'shop-wide stats must not filter on productId');
  wheres.length = 0;
  await store.getStats('shop_1', 'p1');
  assert.ok(wheres.every((w) => w.productId === 'p1'));
});

test('dashboard rating distribution counts approved reviews per star', async () => {
  const prisma = {
    catalogProduct: { findMany: async () => [{ productId: 'p1', title: 'Catalog title' }] },
    reviewProduct: {
      count: async () => 2,
      groupBy: async ({ by }: { by: string[] }) => {
        if (by[0] === 'rating') return [{ rating: 4, _count: 1 }, { rating: 5, _count: 1 }];
        if (by[0] === 'status') return [{ status: 'approved', _count: 2 }];
        assert.deepEqual(by, ['productId'], 'per-product stats must group by productId only, or mixed titles split one product');
        return [{ productId: 'p1', _max: { productTitle: null }, _count: 2, _avg: { rating: 4.5 } }];
      },
      aggregate: async () => ({ _avg: { rating: 4.5 } }),
    },
  };
  const stats = await new ReviewProductStoreService(prisma as never).getStatsForShop('shop_1');
  assert.equal(stats.products.length, 1);
  assert.equal(stats.products[0].title, 'Catalog title');
  assert.deepEqual(stats.globalDist, { 1: 0, 2: 0, 3: 0, 4: 1, 5: 1 });
  assert.equal(stats.globalAvg, 4.5);
});

test('review upsert fills the product label from the catalog and never wipes it on update', async () => {
  const calls: Array<{ create: Record<string, unknown>; update: Record<string, unknown> }> = [];
  const prisma = {
    catalogProduct: { findUnique: async () => ({ title: 'Nuoc tay trang', handle: 'nuoc-tay-trang', image: 'https://cdn.test/i.jpg' }) },
    reviewProduct: { upsert: async (args: { create: Record<string, unknown>; update: Record<string, unknown> }) => { calls.push(args); return {}; } },
  };
  const store = new ReviewProductStoreService(prisma as never);
  await store.upsertReview({ shopId: 's', productId: 'p', reviewId: 'r', rating: 5, content: 'x', author: 'a' });
  assert.deepEqual(
    { shopId: calls[0].create.shopId, productId: calls[0].create.productId, reviewId: calls[0].create.reviewId, rating: calls[0].create.rating, author: calls[0].create.author },
    { shopId: 's', productId: 'p', reviewId: 'r', rating: 5, author: 'a' },
  );
  assert.equal(calls[0].create.productTitle, 'Nuoc tay trang');
  assert.equal(calls[0].create.productHandle, 'nuoc-tay-trang');
  assert.equal(calls[0].create.productImage, 'https://cdn.test/i.jpg');

  const missing = { catalogProduct: { findUnique: async () => null }, reviewProduct: prisma.reviewProduct };
  await new ReviewProductStoreService(missing as never).upsertReview({ shopId: 's', productId: 'p', reviewId: 'r2', rating: 5, content: 'x', author: 'a' });
  assert.ok(!('productTitle' in calls[1].update), 'update must not overwrite a stored label with null');
  assert.equal(calls[1].create.productTitle, null);
});

test('dashboard recent lists read the first page of the 0-based stores', async () => {
  const pageOnly = (rows: unknown[]) => async (_shop: string, opts: { page?: number }) =>
    ({ items: opts.page === 0 ? rows : [], total: rows.length });
  const reviewStore = {
    getStatsForShop: async () => ({ totalReviews: 1, productCount: 1, products: [], statusCounts: {}, globalDist: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 } }),
    getAllReviews: pageOnly([{ reviewId: 'r1', rating: 5, author: 'a', content: 'c', createdAt: 1n, productId: 'p' }]),
  };
  const qnaStore = {
    getStats: async () => ({ total: 3, answered: 1, unanswered: 2 }),
    getStatusCounts: async () => ({ pending: 2, hidden: 1 }),
    getAllQuestions: pageOnly([{ questionId: 'q1', question: 'q', author: 'a', createdAt: 1n, productId: 'p' }]),
  };
  const prisma = {
    appInstall: { findUnique: async () => ({ shopId: 'shop_1' }) },
    catalogProduct: { findMany: async () => [{ productId: 'p', title: 'Catalog title' }] },
    reviewProduct: { count: async () => 0, groupBy: async () => [] },
    qnaQuestion: { groupBy: async () => [] },
    $queryRaw: async () => [],
  };
  const overview = await new DashboardService(
    fake<ReviewProductStoreService>(reviewStore),
    fake<QnaStoreService>(qnaStore),
    fake<PrismaService>(prisma),
  ).getOverview('demo.mysapo.net');
  assert.deepEqual(overview.degraded, []);
  assert.equal(overview.recentReviews.length, 1);
  assert.equal(overview.recentReviews[0].productTitle, 'Catalog title');
  assert.equal(overview.recentQuestions[0].productTitle, 'Catalog title');
  assert.deepEqual(overview.qnaStatusCounts, { all: 3, pending: 2, hidden: 1, answered: 1, unanswered: 2 });
});
