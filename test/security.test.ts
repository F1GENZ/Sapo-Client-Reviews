import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { createHmac } from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { of, lastValueFrom } from 'rxjs';
import { ValidationPipe, BadRequestException, UnauthorizedException, ForbiddenException, ConflictException, HttpException, PayloadTooLargeException } from '@nestjs/common';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { loadEnv } from '../src/config/env.schema';
import type { AppEnv } from '../src/config/env.schema';
import { parseTrustProxy } from '../src/common/trust-proxy';
import { applyHttpHardening } from '../src/common/security/http-hardening';
import { IngressRateLimitService } from '../src/common/security/ingress-rate-limit.service';
import {
  PUBLIC_READ_CLIENT_LIMIT,
  PUBLIC_WRITE_CLIENT_LIMIT,
  publicRateLimitMiddleware,
} from '../src/common/security/public-rate-limit';
import { PublicResponseInterceptor, sanitizePublicResponse } from '../src/common/security/public-response';
import { ShopAuthGuard } from '../src/common/guards/shop-auth.guard';
import { SessionService } from '../src/sapo/session.service';
import { SapoService } from '../src/sapo/sapo.service';
import { SapoController } from '../src/sapo/sapo.controller';
import type { HmacVerifierService } from '../src/sapo/hmac-verifier.service';
import type { WebhookService } from '../src/sapo/webhook.service';
import { RedisService } from '../src/redis/redis.service';
import {
  MediaService,
  IMAGE_MAX_SIZE_BYTES,
  VIDEO_MAX_SIZE_BYTES,
  sniffUploadContentType,
} from '../src/media/media.service';
import { PublicMediaGuard } from '../src/media/public-media.guard';
import { PresignDto } from '../src/media/dto/presign.dto';
import { UpdateWidgetConfigDto } from '../src/review/dto/update-widget-config.dto';
import { toPublicReview } from '../src/review/review.service';
import { toPublicQuestion } from '../src/qna/qna.service';
import type { QnaQuestionRecord } from '../src/qna/qna-store.service';
import { fake } from './support/fakes';

const ADMIN_ORIGIN = 'https://admin.example.test';
const hardeningEnv = (overrides: Record<string, unknown> = {}) => fake<AppEnv>({
  FRONTEND_URL: ADMIN_ORIGIN,
  API_BASE_URL: 'https://api.example.test',
  CORS_ALLOWED_ORIGINS: [],
  TRUST_PROXY: false,
  REQUEST_BODY_LIMIT: '1mb',
  WEBHOOK_BODY_LIMIT: '256kb',
  ...overrides,
});

type Served = { base: string; close: () => Promise<void> };

const serve = async (configure: (app: Express) => void): Promise<Served> => {
  const app = express();
  configure(app);
  let server!: Server;
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
  };
};

const hardenedServer = (envOverrides: Record<string, unknown> = {}) =>
  serve((app) => {
    applyHttpHardening(app, hardeningEnv(envOverrides), new IngressRateLimitService());
    app.all('/api/*', (req: Request & { rawBody?: Buffer }, res: Response) => {
      res.json({ ip: req.ip, rawBody: req.rawBody !== undefined, bodyKeys: Object.keys(req.body || {}).length });
    });
    app.all('/storefront/*', (_req: Request, res: Response) => res.send('asset'));
    app.use((err: { status?: number; message?: unknown }, _req: Request, res: Response, _next: NextFunction) =>
      res.status(err.status || 500).json({ message: String(err.message) }));
  });

test('parseTrustProxy accepts only an explicit, bounded trust boundary', () => {
  for (const raw of ['', 'false', 'FALSE', '0']) {
    assert.deepEqual(parseTrustProxy(raw), { ok: true, value: false }, `"${raw}" disables proxy trust`);
  }
  assert.deepEqual(parseTrustProxy('1'), { ok: true, value: 1 });
  assert.deepEqual(parseTrustProxy('10'), { ok: true, value: 10 });
  assert.deepEqual(parseTrustProxy('10.0.0.0/8, 192.168.1.1 ,::1'), { ok: true, value: '10.0.0.0/8,192.168.1.1,::1' });
  assert.deepEqual(parseTrustProxy('loopback,2001:db8::/32'), { ok: true, value: 'loopback,2001:db8::/32' });

  const rejected = [
    'true', 'TRUE', 'garbage', '11', '99999999999999999999', '1.5', '-1', '0x2', '1e1',
    '10.0.0.0/33', '10.0.0.0/-1', '::1/129', '10.0.0.0/abc', '10.0.0.0/8/8', '999.1.1.1',
    '10.0.0.1,', ',10.0.0.1', '10.0.0.1,,10.0.0.2', '1,2', 'loopback;DROP',
  ];
  for (const raw of rejected) {
    const result = parseTrustProxy(raw);
    assert.equal(result.ok, false, `"${raw}" must be rejected`);
    assert.ok(result.error.includes('TRUST_PROXY'));
  }
});

test('loadEnv fails startup on a malformed TRUST_PROXY instead of trusting every hop', () => {
  assert.throws(() => loadEnv({ NODE_ENV: 'test', TRUST_PROXY: 'garbage' }), /TRUST_PROXY/);
  assert.throws(() => loadEnv({ NODE_ENV: 'test', TRUST_PROXY: 'true' }), /TRUST_PROXY/);
  assert.throws(() => loadEnv({ NODE_ENV: 'test', TRUST_PROXY: '11' }), /TRUST_PROXY/);
  assert.equal(loadEnv({ NODE_ENV: 'test', TRUST_PROXY: '2' }).TRUST_PROXY, 2);
  assert.equal(loadEnv({ NODE_ENV: 'test' }).TRUST_PROXY, false);
});

test('req.ip ignores spoofed forwarding headers unless the peer is a trusted proxy', async () => {
  const spoof = { 'X-Forwarded-For': '203.0.113.9', 'CF-Connecting-IP': '203.0.113.10' };
  const fetchIp = async (server: Served): Promise<string> => (await (await fetch(`${server.base}/api/ip`, { headers: spoof })).json()).ip;

  const untrusted = await hardenedServer({ TRUST_PROXY: false });
  try {
    assert.match(await fetchIp(untrusted), /127\.0\.0\.1$/, 'unset trust: socket address only');
  } finally {
    await untrusted.close();
  }

  const outsideAllowlist = await hardenedServer({ TRUST_PROXY: '10.0.0.0/8' });
  try {
    assert.match(await fetchIp(outsideAllowlist), /127\.0\.0\.1$/, 'peer outside allowlist: header ignored');
  } finally {
    await outsideAllowlist.close();
  }

  const trusted = await hardenedServer({ TRUST_PROXY: '127.0.0.1' });
  try {
    assert.equal(await fetchIp(trusted), '203.0.113.9', 'trusted peer: client hop is used');
    const chained = await (await fetch(`${trusted.base}/api/ip`, {
      headers: { 'X-Forwarded-For': '198.51.100.1, 203.0.113.9' },
    })).json();
    assert.equal(chained.ip, '203.0.113.9', 'a spoofed leftmost hop is not the client');
  } finally {
    await trusted.close();
  }
});

test('req.ip behind Cloudflare skips edge hops, so Pages-proxied and direct clients get their own bucket key', async () => {
  const server = await hardenedServer({ TRUST_PROXY: 'loopback,173.245.48.0/20,2a06:98c0::/29' });
  try {
    const ipFor = async (forwarded: string): Promise<string> =>
      (await (await fetch(`${server.base}/api/ip`, { headers: { 'X-Forwarded-For': forwarded } })).json()).ip;

    assert.equal(await ipFor('198.51.100.1, 203.0.113.9'), '203.0.113.9', 'direct visitor: the hop Cloudflare appended, not the forged prefix');
    assert.equal(await ipFor('198.51.100.1, 203.0.113.9, 173.245.48.7'), '203.0.113.9', 'Pages Function egress (IPv4 edge) is skipped');
    assert.equal(await ipFor('198.51.100.1, 203.0.113.9, 2a06:98c0:3600::103'), '203.0.113.9', 'Pages Function egress (IPv6 edge) is skipped');
  } finally {
    await server.close();
  }
});

test('security header matrix: API, OAuth and storefront assets', async () => {
  const server = await hardenedServer();
  try {
    const api = await fetch(`${server.base}/api/admin/ping`);
    assert.equal(api.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(api.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(api.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
    assert.equal(api.headers.get('x-frame-options'), 'DENY');
    assert.equal(api.headers.get('cache-control'), 'no-store');
    assert.equal(api.headers.get('x-powered-by'), null);
    assert.equal(api.headers.get('strict-transport-security'), null, 'no HSTS over plain http');
    assert.equal(api.headers.get('pragma'), null);

    const oauth = await fetch(`${server.base}/api/oauth/install/login`);
    assert.equal(oauth.headers.get('cache-control'), 'no-store');
    assert.equal(oauth.headers.get('pragma'), 'no-cache');

    const https = await fetch(`${server.base}/api/admin/ping`, { headers: { 'X-Forwarded-Proto': 'https' } });
    assert.equal(https.headers.get('strict-transport-security'), 'max-age=15552000');

    const asset = await fetch(`${server.base}/storefront/widget.js`);
    assert.equal(asset.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(asset.headers.get('x-frame-options'), null, 'static assets stay embeddable');
    assert.equal(asset.headers.get('x-powered-by'), null);
  } finally {
    await server.close();
  }
});

test('credentialed CORS is never echoed to unknown origins', async () => {
  const server = await hardenedServer();
  try {
    const admin = await fetch(`${server.base}/api/admin/ping`, { headers: { Origin: ADMIN_ORIGIN } });
    assert.equal(admin.headers.get('access-control-allow-origin'), ADMIN_ORIGIN);
    assert.equal(admin.headers.get('access-control-allow-credentials'), 'true');
    assert.equal(admin.headers.get('vary'), 'Origin');

    const evil = 'https://evil.example';
    const evilAdmin = await fetch(`${server.base}/api/admin/ping`, { headers: { Origin: evil } });
    assert.equal(evilAdmin.headers.get('access-control-allow-origin'), null);
    assert.equal(evilAdmin.headers.get('access-control-allow-credentials'), null);

    const evilPreflight = await fetch(`${server.base}/api/admin/ping`, {
      method: 'OPTIONS',
      headers: { Origin: evil, 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(evilPreflight.status, 403);
    assert.equal(evilPreflight.headers.get('access-control-allow-origin'), null);

    for (const path of ['/api/public/reviews/1', '/storefront/widget.js']) {
      const custom = await fetch(`${server.base}${path}`, { headers: { Origin: 'https://shop.custom-domain.test' } });
      assert.equal(custom.headers.get('access-control-allow-origin'), 'https://shop.custom-domain.test');
      assert.equal(custom.headers.get('access-control-allow-credentials'), null, `${path}: no credentials for storefront origins`);
    }

    const preflight = await fetch(`${server.base}/api/public/reviews/1`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://shop.custom-domain.test', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
    const allowed = preflight.headers.get('access-control-allow-headers');
    for (const header of ['X-Store-Domain', 'X-Sapo-Hmac', 'X-Sapo-HmacSha256', 'X-Sapo-Topic', 'Authorization']) {
      assert.ok(allowed?.includes(header), `${header} stays allowed`);
    }

    const malformed = await fetch(`${server.base}/api/public/reviews/1`, { headers: { Origin: 'javascript:alert(1)' } });
    assert.equal(malformed.headers.get('access-control-allow-origin'), null);
  } finally {
    await server.close();
  }
});

test('body limits: public routes are small, webhooks keep raw bytes, other routes never do', async () => {
  const server = await hardenedServer();
  try {
    const json = (size: number) => JSON.stringify({ content: 'x'.repeat(size) });
    const post = (path: string, body: string, type = 'application/json') =>
      fetch(`${server.base}${path}`, { method: 'POST', headers: { 'Content-Type': type, Origin: ADMIN_ORIGIN }, body });

    assert.equal((await post('/api/public/reviews/1', json(300 * 1024))).status, 413);
    assert.equal((await post('/api/public/reviews/1', json(10 * 1024))).status, 200);
    assert.equal((await post('/api/admin/reviews/1', json(300 * 1024))).status, 200, 'authenticated routes keep the configured limit');
    assert.equal((await post('/api/admin/reviews/1', json(2 * 1024 * 1024))).status, 413);

    const webhook = await (await post('/api/oauth/install/webhooks', json(10))).json();
    assert.equal(webhook.rawBody, true, 'the signature covers the raw webhook bytes');
    const other = await (await post('/api/admin/reviews/1', json(10))).json();
    assert.equal(other.rawBody, false, 'no other route retains a raw body copy');

    assert.equal((await post('/api/oauth/install/webhooks', 'a=1', 'application/x-www-form-urlencoded')).status, 415);
    assert.equal((await post('/api/oauth/install/webhooks', json(300 * 1024))).status, 413);
  } finally {
    await server.close();
  }
});

type LimiterResponse = {
  statusCode: number;
  headers: Record<string, string>;
  setHeader(name: string, value: string): void;
  status(code: number): LimiterResponse;
  json(payload: unknown): LimiterResponse;
};

const runLimiter = async (
  middleware: (req: Request, res: Response, next: NextFunction) => Promise<void>,
  { method = 'GET', ip, store }: { method?: string; ip: string; store?: string },
) => {
  const req = {
    method,
    ip,
    headers: store ? { 'x-store-domain': store } : {},
    query: {},
    socket: { remoteAddress: ip },
  };
  const res: LimiterResponse = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json() { return this; },
  };
  let passed = false;
  await middleware(fake<Request>(req), fake<Response>(res), (error?: unknown) => {
    if (error) throw error;
    passed = true;
  });
  return { passed, res };
};

test('public read budget: rotating the store domain cannot mint a fresh per-client budget', async () => {
  const middleware = publicRateLimitMiddleware(new IngressRateLimitService());
  for (let i = 0; i < PUBLIC_READ_CLIENT_LIMIT; i += 1) {
    const { passed } = await runLimiter(middleware, { ip: '198.51.100.7', store: `shop${i}.mysapo.net` });
    assert.equal(passed, true, `request ${i + 1} within the client budget`);
  }
  const denied = await runLimiter(middleware, { ip: '198.51.100.7', store: 'fresh-shop.mysapo.net' });
  assert.equal(denied.passed, false);
  assert.equal(denied.res.statusCode, 429);
  assert.ok(Number(denied.res.headers['Retry-After']) >= 1);

  const otherClient = await runLimiter(middleware, { ip: '198.51.100.8', store: 'fresh-shop.mysapo.net' });
  assert.equal(otherClient.passed, true, 'another client keeps its own budget');
});

test('public read budget: a client is limited only by its own cap, never by other clients of the same store', async () => {
  const middleware = publicRateLimitMiddleware(new IngressRateLimitService());
  for (let i = 0; i < PUBLIC_READ_CLIENT_LIMIT; i += 1) {
    const { passed } = await runLimiter(middleware, { ip: '10.1.0.1', store: 'busy.mysapo.net' });
    assert.equal(passed, true, `request ${i + 1} stays within the client cap`);
  }
  const capped = await runLimiter(middleware, { ip: '10.1.0.1', store: 'busy.mysapo.net' });
  assert.equal(capped.res.statusCode, 429, 'the noisy client hits its own cap');

  const otherClient = await runLimiter(middleware, { ip: '10.9.9.9', store: 'busy.mysapo.net' });
  assert.equal(otherClient.passed, true, 'another client of the same store is not throttled by the noisy one');

  const malformed = await runLimiter(middleware, { ip: '10.9.9.10', store: 'not a domain' });
  assert.equal(malformed.passed, true, 'a malformed store value is not an error here');
});

test('public writes share a hard per-client ceiling and preflights are free', async () => {
  const middleware = publicRateLimitMiddleware(new IngressRateLimitService());
  for (let i = 0; i < PUBLIC_WRITE_CLIENT_LIMIT; i += 1) {
    assert.equal((await runLimiter(middleware, { method: 'POST', ip: '192.0.2.5', store: `s${i}.mysapo.net` })).passed, true);
  }
  assert.equal((await runLimiter(middleware, { method: 'POST', ip: '192.0.2.5', store: 'x.mysapo.net' })).res.statusCode, 429);
  assert.equal((await runLimiter(middleware, { method: 'OPTIONS', ip: '192.0.2.5' })).passed, true);
  assert.equal((await runLimiter(middleware, { method: 'GET', ip: '192.0.2.5', store: 'x.mysapo.net' })).passed, true, 'reads use a separate bucket');
});

const guardEnv = fake<AppEnv>({
  FRONTEND_URL: ADMIN_ORIGIN,
  API_BASE_URL: 'https://api.example.test',
  CORS_ALLOWED_ORIGINS: [],
  APP_SESSION_SECRET: 'test-session-secret-with-at-least-32-bytes',
  APP_SESSION_TTL_SECONDS: 3600,
  SESSION_COOKIE_NAME: 'sapo_app_session',
  SESSION_HANDOFF_TTL_SECONDS: 60,
  SESSION_COOKIE_DOMAIN: '',
  NODE_ENV: 'test',
});

const LIFECYCLE_GENERATION = 3;

const makeGuard = () => {
  const sessions = new SessionService(guardEnv, new RedisService({ keyPrefix: 'test-sec-guard' }));
  const sapo = fake<SapoService>({
    resolveAccessToken: async () => 'upstream-token',
    getLifecycleGeneration: async () => LIFECYCLE_GENERATION,
  });
  return { guard: new ShopAuthGuard(guardEnv, sessions, sapo, new Reflector()), sessions };
};

type GuardRequest = {
  method: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body: Record<string, unknown>;
  storeDomain?: string;
};

const guardContext = (req: GuardRequest) => fake<ExecutionContext>({
  switchToHttp: () => ({ getRequest: () => req }),
  getHandler: () => () => undefined,
  getClass: () => class {},
});

test('ShopAuthGuard: cookie-only mutations are rejected, Bearer mutations accepted', async () => {
  const { guard, sessions } = makeGuard();
  const token = sessions.createSessionToken('demo.mysapo.net', LIFECYCLE_GENERATION);
  const cookie = `sapo_app_session=${encodeURIComponent(token)}`;
  const request = (method: string, headers: Record<string, string>): GuardRequest => ({
    method,
    headers: { origin: ADMIN_ORIGIN, ...headers },
    query: {},
    body: {},
  });

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    await assert.rejects(
      guard.canActivate(guardContext(request(method, { cookie }))),
      (error: Error) => error instanceof UnauthorizedException && /bearer token required/i.test(error.message),
      `${method} with only a cookie`,
    );
    const req = request(method, { authorization: `Bearer ${token}`, cookie });
    assert.equal(await guard.canActivate(guardContext(req)), true, `${method} with Bearer`);
    assert.equal(req.storeDomain, 'demo.mysapo.net');
  }

  const getWithCookie = request('GET', { cookie });
  assert.equal(await guard.canActivate(guardContext(getWithCookie)), true, 'reads may still use the session cookie');

  await assert.rejects(
    guard.canActivate(guardContext(request('POST', { authorization: 'Bearer not-a-token' }))),
    UnauthorizedException,
  );
  await assert.rejects(
    guard.canActivate(guardContext(request('POST', { authorization: 'Basic abc', cookie }))),
    UnauthorizedException,
    'a non-Bearer scheme does not count',
  );
  await assert.rejects(
    guard.canActivate(guardContext({ ...request('POST', { authorization: `Bearer ${token}` }), headers: { authorization: `Bearer ${token}`, origin: 'https://evil.example' } })),
    /Untrusted request origin/,
  );
});

type PublicRow = Record<string, unknown>;
type PublicList = { items: PublicRow[]; total: number; page: number; pageSize: number };
const sanitized = <T>(path: string, body: unknown): { data: T } => fake<{ data: T }>(sanitizePublicResponse(path, body));

const reviewRow = {
  reviewId: 'r1', rating: 5, content: 'Great', author: 'An', email: 'an@example.com', phone: '0900000000',
  title: 'T', media: [{ url: 'https://cdn.test/a.jpg', type: 'image', internal: 'x' }], status: 'approved',
  verified: true, pinned: false, reply: 'Thanks', repliedAt: 5n, sourceRawJson: '{"customer":{"email":"an@example.com"}}',
  createdAt: 10n, updatedAt: 11n, internalNote: 'staff only',
};

test('public review routes expose a whitelist: no contact data, raw payload or unknown columns', () => {
  const serviceOutput = toPublicReview(reviewRow);
  assert.equal('source_raw_json' in serviceOutput, false, 'the service mapper already drops the raw payload');

  const list = sanitized<PublicList>('/api/public/reviews/123', {
    data: { items: [{ ...serviceOutput, participantId: 'p', internalNote: 'staff only', source_raw_json: '{}' }], total: 1, page: 1, pageSize: 20, secret: 1 },
  });
  const [item] = list.data.items;
  assert.deepEqual(Object.keys(list.data).sort(), ['items', 'page', 'pageSize', 'total']);
  for (const leaked of ['email', 'phone', 'source_raw_json', 'participantId', 'internalNote']) {
    assert.equal(leaked in item, false, `${leaked} must not be public`);
  }
  assert.deepEqual(item.media, [{ url: 'https://cdn.test/a.jpg', type: 'image' }]);
  assert.equal(item.rating, 5);
  assert.equal(item.reply, 'Thanks');

  const submitted = sanitized<PublicRow>('/api/public/reviews/123', { data: { ...serviceOutput, email: 'an@example.com' } });
  assert.equal('email' in submitted.data, false, 'the POST response is whitelisted too');
  assert.equal(submitted.data.id, 'r1');
});

test('public Q&A routes drop asker contact data and raw payloads', () => {
  const row = fake<QnaQuestionRecord>({
    questionId: 'q1', question: 'Size?', author: 'Bo', email: 'bo@example.com', phone: '0911111111',
    answer: 'M', answeredBy: 'Shop', status: 'approved', createdAt: 1n, updatedAt: 2n, answeredAt: 3n,
    sourceRawJson: '{"asker":"bo@example.com"}',
  });
  const output = sanitized<PublicList>('/api/public/qna/55', {
    data: { items: [toPublicQuestion(row)], total: 1, page: 1, pageSize: 20 },
  });
  const [item] = output.data.items;
  assert.deepEqual(Object.keys(item).sort(), ['answer', 'answered_at', 'answered_by', 'author', 'created_at', 'id', 'question', 'status', 'updated_at']);

  const single = sanitized<PublicRow>('/api/public/qna/55', { data: { ...toPublicQuestion(row), email: 'bo@example.com' } });
  assert.equal('email' in single.data, false);
});

test('whitelist interceptor only touches review and Q&A row routes', async () => {
  const interceptor = new PublicResponseInterceptor();
  const run = (path: string, body: unknown) =>
    lastValueFrom(interceptor.intercept(
      fake<ExecutionContext>({ switchToHttp: () => ({ getRequest: () => ({ path }) }) }),
      fake<CallHandler>({ handle: () => of(body) }),
    ));

  const leaky = { data: { id: 'x', email: 'a@b.c', source_raw_json: '{}' } };
  const dataOf = async (path: string) => fake<{ data: PublicRow }>(await run(path, leaky)).data;
  assert.equal('email' in (await dataOf('/api/public/reviews/9')), false);
  assert.equal('source_raw_json' in (await dataOf('/api/public/qna/9')), false);

  const summary = { data: { avg: 4.5, count: 2, distribution: { 5: 2 } } };
  assert.deepEqual(await run('/api/public/reviews/9/summary', summary), summary, 'summary route is aggregate-only and unchanged');
  assert.deepEqual(await run('/api/public/reviews/config/widget', { data: { radius: 4 } }), { data: { radius: 4 } });
  assert.deepEqual(await run('/api/admin/reviews/9', leaky), leaky, 'admin routes are not rewritten');
  assert.equal(await run('/api/public/reviews/9', undefined), undefined);
});

const UPLOAD_SECRET = 'test-upload-ticket-secret';
const mediaEnv = fake<AppEnv>({
  R2_UPLOAD_SECRET: UPLOAD_SECRET,
  R2_WORKER_URL: 'https://r2-worker.example.test',
  R2_PUBLIC_DOMAIN: 'cdn.example.test',
});
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;

const derivedTicketKey = createHmac('sha256', UPLOAD_SECRET).update('f1genz-sapo:upload-ticket:v1').digest();
const signWith = (key: string | Buffer, encoded: string) => createHmac('sha256', key).update(encoded).digest('base64url');
const encodePayload = (payload: Record<string, unknown>) => Buffer.from(JSON.stringify(payload)).toString('base64url');

const makeMedia = (prefix: string) => new MediaService(mediaEnv, new RedisService({ keyPrefix: prefix }));

type TicketInput = { storeDomain: string; productId: string; contentType: string; fileSize: number; ttlMs?: number };
const ticketInput = (overrides: Partial<TicketInput> = {}): TicketInput => ({
  storeDomain: 'demo.mysapo.net',
  productId: '123',
  contentType: 'image/png',
  fileSize: 1024,
  ...overrides,
});
const verifyInput = (overrides: Partial<TicketInput> = {}) => {
  const { storeDomain, productId, contentType, fileSize } = ticketInput(overrides);
  return { storeDomain, productId, contentType, fileSize };
};
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);

const rejectsAs = (type: new (...args: never[]) => Error, pattern: RegExp) =>
  (error: unknown) => error instanceof type && pattern.test(error.message);

test('upload ticket is consumed exactly once and bound to its metadata', async () => {
  const media = makeMedia('test-sec-ticket');
  const { ticket } = media.createUploadTicket(ticketInput());

  const peek = media.inspectUploadTicket(ticket, 'demo.mysapo.net');
  assert.equal(peek.productId, '123');
  assert.match(peek.nonce, NONCE_RE);
  media.inspectUploadTicket(ticket, 'demo.mysapo.net');

  await assert.rejects(media.verifyUploadTicket(ticket, verifyInput({ fileSize: 2048 })), rejectsAs(ForbiddenException, /mismatch/));
  await assert.rejects(media.verifyUploadTicket(ticket, verifyInput({ storeDomain: 'other.mysapo.net' })), rejectsAs(ForbiddenException, /mismatch/));
  await assert.rejects(media.verifyUploadTicket(ticket, verifyInput({ productId: '124' })), rejectsAs(ForbiddenException, /mismatch/));

  const consumed = await media.verifyUploadTicket(ticket, verifyInput());
  assert.equal(consumed.productId, '123', 'mismatches did not burn the ticket');
  assert.equal(consumed.nonce, peek.nonce);
  assert.equal('filename' in consumed, false, 'the ticket carries no client-chosen filename');
  await assert.rejects(media.verifyUploadTicket(ticket, verifyInput()), rejectsAs(ConflictException, /already used/));

  const second = media.createUploadTicket(ticketInput());
  assert.notEqual(second.ticket, ticket, 'every ticket carries a fresh nonce');
  assert.equal((await media.verifyUploadTicket(second.ticket, verifyInput())).productId, '123');
});

test('upload tickets reject forgery, expiry and missing nonce', async () => {
  const media = makeMedia('test-sec-ticket-bad');
  const { ticket } = media.createUploadTicket(ticketInput());
  const [encoded, signature] = ticket.split('.');
  const unauthorized = rejectsAs(UnauthorizedException, /Invalid upload ticket/);

  await assert.rejects(media.verifyUploadTicket(`${encoded}.${signature.slice(0, -2)}AA`, verifyInput()), unauthorized);
  const forged = encodePayload({ ...JSON.parse(Buffer.from(encoded, 'base64url').toString()), productId: '999' });
  await assert.rejects(media.verifyUploadTicket(`${forged}.${signature}`, verifyInput({ productId: '999' })), unauthorized);
  await assert.rejects(media.verifyUploadTicket('', verifyInput()), rejectsAs(UnauthorizedException, /Missing upload ticket/));

  const expired = media.createUploadTicket(ticketInput({ ttlMs: -1000 }));
  await assert.rejects(media.verifyUploadTicket(expired.ticket, verifyInput()), rejectsAs(UnauthorizedException, /expired/));

  const rawSecretSigned = encodePayload({
    storeDomain: 'demo.mysapo.net', productId: '123', contentType: 'image/png', fileSize: 1024,
    expiresAt: Date.now() + 60000, nonce: 'AbCdEfGhIjKlMnOpQrSt',
  });
  await assert.rejects(
    media.verifyUploadTicket(`${rawSecretSigned}.${signWith(UPLOAD_SECRET, rawSecretSigned)}`, verifyInput()),
    unauthorized,
    'a signature made with the raw upload secret (the one the Worker holds) is not a ticket',
  );

  const noNonce = encodePayload({
    storeDomain: 'demo.mysapo.net', productId: '123', contentType: 'image/png', fileSize: 1024, expiresAt: Date.now() + 60000,
  });
  await assert.rejects(
    media.verifyUploadTicket(`${noNonce}.${signWith(derivedTicketKey, noNonce)}`, verifyInput()),
    unauthorized,
    'a correctly signed ticket without a nonce cannot be made single-use',
  );

  const shortNonce = encodePayload({
    storeDomain: 'demo.mysapo.net', productId: '123', contentType: 'image/png', fileSize: 1024, expiresAt: Date.now() + 60000, nonce: 'short',
  });
  await assert.rejects(
    media.verifyUploadTicket(`${shortNonce}.${signWith(derivedTicketKey, shortNonce)}`, verifyInput()),
    unauthorized,
    'a nonce outside the object-key alphabet and length is refused',
  );
});

test('upload size limits: 5 MB images, 2 MB videos, integer sizes only', () => {
  const media = makeMedia('test-sec-size');
  assert.equal(media.validateUploadInput('image/jpeg', IMAGE_MAX_SIZE_BYTES), 'image');
  assert.equal(IMAGE_MAX_SIZE_BYTES, 5 * 1024 * 1024);
  assert.throws(() => media.validateUploadInput('image/jpeg', IMAGE_MAX_SIZE_BYTES + 1), rejectsAs(PayloadTooLargeException, /Max 5MB/));
  assert.equal(media.validateUploadInput('video/mp4', VIDEO_MAX_SIZE_BYTES), 'video');
  assert.throws(() => media.validateUploadInput('video/mp4', VIDEO_MAX_SIZE_BYTES + 1), rejectsAs(PayloadTooLargeException, /Max 2MB/));
  const badSizes: unknown[] = ['1024', 'abc', NaN, Infinity, 1.5, 0, -5, null, undefined];
  for (const bad of badSizes) {
    assert.throws(() => media.validateUploadInput('image/png', fake<number>(bad)), BadRequestException, `fileSize ${String(bad)}`);
  }
  assert.throws(() => media.validateUploadInput('image/svg+xml', 10), /Unsupported file type/);
  assert.throws(() => media.createUploadTicket(ticketInput({ productId: undefined })), /Invalid productId/);
  assert.throws(
    () => media.createUploadTicket(ticketInput({ fileSize: IMAGE_MAX_SIZE_BYTES + 1 })),
    PayloadTooLargeException,
    'an oversized ticket request is refused at mint time',
  );
});

test('a client-chosen filename never reaches the ticket', () => {
  const media = makeMedia('test-sec-filename');
  for (const filename of [undefined, '../etc/passwd', 'photo.png', 'a'.repeat(2000)]) {
    const { ticket } = media.createUploadTicket(fake<TicketInput>({ ...ticketInput(), filename }));
    const payload = JSON.parse(Buffer.from(ticket.split('.')[0], 'base64url').toString('utf8')) as Record<string, unknown>;
    assert.equal('filename' in payload, false, `filename ${String(filename).slice(0, 20)} is not signed into the ticket`);
  }
});

test('uploaded bytes must match the declared type before anything is sent to storage', async () => {
  assert.equal(sniffUploadContentType(PNG), 'image/png');
  assert.equal(sniffUploadContentType(JPEG), 'image/jpeg');
  assert.equal(sniffUploadContentType(Buffer.from('<svg onload=alert(1)>')), null);

  const media = makeMedia('test-sec-sniff');
  const nonce = 'AbCdEfGhIjKlMnOpQrSt';
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response('ok', { status: 200 });
  };
  try {
    await assert.rejects(media.uploadFile('demo.mysapo.net', '123', nonce, 'image/jpeg', PNG), /does not match/);
    await assert.rejects(media.uploadFile('demo.mysapo.net', '123', nonce, 'image/png', Buffer.from('<script>alert(1)</script>')), /Unsupported file content/);
    await assert.rejects(media.uploadFile('demo.mysapo.net', '123', '../escape', 'image/png', PNG), rejectsAs(BadRequestException, /Invalid upload ticket/));
    await assert.rejects(media.uploadFile('demo.mysapo.net', '123', nonce, 'image/png', Buffer.alloc(IMAGE_MAX_SIZE_BYTES + 1)), PayloadTooLargeException);
    assert.equal(calls.length, 0, 'rejected content never reaches the worker');

    const stored = await media.uploadFile('demo.mysapo.net', '123', nonce, 'image/png', PNG);
    assert.equal(stored.type, 'image');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://r2-worker.example.test/reviews/demo.mysapo.net/123/${nonce}.png`);
    assert.equal(fake<Record<string, string>>(calls[0].init?.headers)['Content-Type'], 'image/png');
    assert.equal(stored.cdnUrl, `https://cdn.example.test/reviews/demo.mysapo.net/123/${nonce}.png`);

    await media.uploadFile('demo.mysapo.net', '123', nonce, 'image/jpeg', JPEG);
    assert.match(calls[1].url, /\/reviews\/demo\.mysapo\.net\/123\/AbCdEfGhIjKlMnOpQrSt\.jpg$/, 'the extension comes from the sniffed type');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

type GateRequest = {
  path: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  ip: string;
  socket: Record<string, never>;
  publicStoreDomain?: string;
};
const gateRequest = (overrides: Partial<GateRequest> = {}): GateRequest => ({
  path: '/api/public/media/upload',
  headers: { 'x-store-domain': 'demo.mysapo.net' },
  query: {},
  ip: '198.51.100.20',
  socket: {},
  ...overrides,
});
const gateEnv = fake<AppEnv>({ PUBLIC_WRITE_RATE_LIMIT_WINDOW_SECONDS: 60, PUBLIC_WRITE_RATE_LIMIT_MAX: 3 });
const gateContext = (req: GateRequest) => fake<ExecutionContext>({ switchToHttp: () => ({ getRequest: () => req }) });

test('public media gate rejects before the upload body is buffered', async () => {
  const media = makeMedia('test-sec-gate');
  let installed = true;
  const sapo = fake<SapoService>({
    resolveAccessToken: async () => {
      if (!installed) throw new UnauthorizedException('App needs reinstall');
      return 'token';
    },
  });
  const makeGate = () => new PublicMediaGuard(media, sapo, gateEnv, new IngressRateLimitService());
  const { ticket } = media.createUploadTicket(ticketInput());

  await assert.rejects(makeGate().canActivate(gateContext(gateRequest({ headers: {} }))), BadRequestException);
  await assert.rejects(makeGate().canActivate(gateContext(gateRequest({ headers: { 'x-store-domain': 'not a domain' } }))), BadRequestException);

  await assert.rejects(
    makeGate().canActivate(gateContext(gateRequest({ ip: '198.51.100.21' }))),
    rejectsAs(UnauthorizedException, /Missing upload ticket/),
    'no ticket, no body read',
  );
  await assert.rejects(
    makeGate().canActivate(gateContext(gateRequest({ ip: '198.51.100.22', query: { ticket: 'garbage.garbage' } }))),
    rejectsAs(UnauthorizedException, /Invalid upload ticket/),
  );
  await assert.rejects(
    makeGate().canActivate(gateContext(gateRequest({ ip: '198.51.100.23', headers: { 'x-store-domain': 'other.mysapo.net' }, query: { ticket } }))),
    rejectsAs(ForbiddenException, /mismatch/),
    'a ticket minted for another store is useless',
  );

  const ok = gateRequest({ ip: '198.51.100.24', query: { ticket } });
  assert.equal(await makeGate().canActivate(gateContext(ok)), true);
  assert.equal(ok.publicStoreDomain, 'demo.mysapo.net');
  const consumed = await media.verifyUploadTicket(ticket, verifyInput());
  assert.equal(consumed.productId, '123', 'the gate left the ticket unconsumed, so it verifies once');
  await assert.rejects(media.verifyUploadTicket(ticket, verifyInput()), rejectsAs(ConflictException, /already used/));

  installed = false;
  await assert.rejects(
    makeGate().canActivate(gateContext(gateRequest({ ip: '198.51.100.25', query: { ticket } }))),
    ForbiddenException,
    'uninstalled store: uploads are closed',
  );
  await assert.rejects(
    makeGate().canActivate(gateContext(gateRequest({ path: '/api/public/media/ticket', ip: '198.51.100.26' }))),
    ForbiddenException,
    'ticket minting needs a live install too',
  );

  const limitedGate = makeGate();
  installed = true;
  for (let i = 0; i < 3; i += 1) {
    assert.equal(await limitedGate.canActivate(gateContext(gateRequest({ path: '/api/public/media/ticket', ip: '198.51.100.30' }))), true);
  }
  await assert.rejects(
    limitedGate.canActivate(gateContext(gateRequest({ path: '/api/public/media/ticket', ip: '198.51.100.30' }))),
    (error: unknown) => error instanceof HttpException && error.getStatus() === 429,
  );
});

const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
const body = <T>(metatype: new () => T, value: unknown): Promise<T> => pipe.transform(value, { type: 'body', metatype });

test('ticket DTO bounds every field and rejects unknown properties', async () => {
  const valid = await body(PresignDto, { productId: 123, filename: 'a.png', contentType: 'image/png', fileSize: 1000 });
  assert.equal(valid.productId, '123', 'numeric product ids are normalized to strings');

  for (const filename of [undefined, '', 'a'.repeat(256), 'a'.repeat(1024)]) {
    const parsed = await body(PresignDto, { productId: '1', filename, contentType: 'image/png', fileSize: 1000 });
    assert.equal(parsed.filename, filename, 'filename is advisory and optional');
  }

  const invalid = [
    { productId: '12a', filename: 'a.png', contentType: 'image/png', fileSize: 1000 },
    { productId: '1', filename: 'a'.repeat(1025), contentType: 'image/png', fileSize: 1000 },
    { productId: '1', filename: 42, contentType: 'image/png', fileSize: 1000 },
    { productId: '1', filename: 'a.png', contentType: 'x'.repeat(101), fileSize: 1000 },
    { productId: '1', filename: 'a.png', contentType: 'image/png', fileSize: '1000' },
    { productId: '1', filename: 'a.png', contentType: 'image/png', fileSize: 1.5 },
    { productId: '1', filename: 'a.png', contentType: 'image/png', fileSize: 0 },
    { productId: '1', filename: 'a.png', contentType: 'image/png', fileSize: 1000, extra: 'x' },
    { productId: { $gt: '' }, filename: 'a.png', contentType: 'image/png', fileSize: 1000 },
    {},
  ];
  for (const value of invalid) {
    await assert.rejects(body(PresignDto, value), BadRequestException, JSON.stringify(value).slice(0, 80));
  }
});

test('oversized upload sizes pass the DTO but are refused by the service with 413', async () => {
  const dto = await body(PresignDto, { productId: '1', filename: 'a.png', contentType: 'image/png', fileSize: IMAGE_MAX_SIZE_BYTES + 1 });
  assert.equal(dto.fileSize, IMAGE_MAX_SIZE_BYTES + 1);
  const media = makeMedia('test-sec-dto-size');
  assert.throws(() => media.validateUploadInput(dto.contentType, dto.fileSize), PayloadTooLargeException);
});

test('widget config DTO bounds text, numbers and the star icon URL', async () => {
  assert.ok(await body(UpdateWidgetConfigDto, { titleText: 'Reviews', radius: 12, reviewItemsPerPage: 5, starIconUrl: '', accentColor: 'rgba(1,2,3,0.5)' }));
  assert.ok(await body(UpdateWidgetConfigDto, { starIconUrl: 'https://cdn.example.test/star.svg' }));

  const invalid = [
    { titleText: 'x'.repeat(201) },
    { accentColor: 'x'.repeat(65) },
    { replyBadgeText: 'x'.repeat(101) },
    { radius: -1 },
    { radius: 1e9 },
    { reviewItemsPerPage: 0 },
    { reviewItemsPerPage: 5000 },
    { qnaItemsPerPage: 2.5 },
    { starIconUrl: 'javascript:alert(1)' },
    { starIconUrl: 'data:image/svg+xml;base64,AAAA' },
    { starIconUrl: 'https://x.test/a"onerror="1' },
    { starIconUrl: `https://x.test/${'a'.repeat(2001)}` },
  ];
  for (const value of invalid) {
    await assert.rejects(body(UpdateWidgetConfigDto, value), BadRequestException, JSON.stringify(value).slice(0, 60));
  }
});

const isTooManyRequests = (error: unknown) => error instanceof HttpException && error.getStatus() === 429;

test('login entry takes only storeDomain and tolerates repeated query keys', async () => {
  const startCalls: Array<Parameters<SapoService['startLogin']>[0]> = [];
  const sapo = fake<SapoService>({
    startLogin: async (input: Parameters<SapoService['startLogin']>[0]) => {
      startCalls.push(input);
      return { url: 'https://x.mysapo.net/admin/oauth/authorize', reason: 'sso_required' };
    },
  });
  const rateLimit = new IngressRateLimitService();
  const env = fake<AppEnv>({ AUTH_RATE_LIMIT_WINDOW_SECONDS: 60, AUTH_RATE_LIMIT_MAX: 2 });
  const hmac = fake<HmacVerifierService>({});
  const sessions = fake<SessionService>({});
  const webhooks = fake<WebhookService>({});
  const controller = new SapoController(env, sapo, hmac, sessions, webhooks, rateLimit);
  const req = fake<Request>({ ip: '203.0.113.50', headers: {}, socket: {} });

  await controller.loginEntry(req, fake<string>(['a.mysapo.net', 'b.mysapo.net']), '/dashboard');
  assert.deepEqual(startCalls[0], { storeDomain: 'a.mysapo.net', redirectTo: '/dashboard' });
  assert.equal(controller.loginEntry.length, 3, 'no legacy alias parameters remain');

  await controller.loginEntry(req, 'a.mysapo.net', undefined);
  await assert.rejects(controller.loginEntry(req, 'a.mysapo.net', undefined), isTooManyRequests);

  const installSapo = fake<SapoService>({ buildInstallUrl: async () => 'https://x' });
  const installBucket = new SapoController(fake<AppEnv>({ ...env, AUTH_RATE_LIMIT_MAX: 1 }), installSapo, hmac, sessions, webhooks, rateLimit);
  const installReq = fake<Request>({ ip: '203.0.113.51', headers: {}, socket: {} });
  await installBucket.installStart(installReq, 'a.mysapo.net');
  await assert.rejects(installBucket.installStart(installReq, 'a.mysapo.net'), isTooManyRequests, 'install start is throttled');
  await assert.rejects(new SapoController(env, fake<SapoService>({}), hmac, sessions, webhooks, new IngressRateLimitService()).installStart(installReq, undefined), BadRequestException);
});
