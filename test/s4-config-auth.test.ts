import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Reflector } from '@nestjs/core';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';

import { loadEnv } from '../src/config/env.schema';
import type { AppEnv } from '../src/config/env.schema';
import { SapoService } from '../src/sapo/sapo.service';
import { fake } from './support/fakes';
import {
  SAMPLE_ENCRYPTION_KEYS,
  assertEncryptionKey,
  assertUsableSecret,
} from '../src/config/secret-guard';
import { RedisService } from '../src/redis/redis.service';
import { HmacVerifierService } from '../src/sapo/hmac-verifier.service';
import { SessionService } from '../src/sapo/session.service';
import { TokenEncryptionService } from '../src/sapo/token-encryption.service';
import { ShopAuthGuard } from '../src/common/guards/shop-auth.guard';

const GOOD_KEY = Buffer.alloc(32, 9).toString('base64');
const GOOD_SESSION_SECRET = 'a-long-random-session-secret-of-at-least-32-bytes';
const GOOD_CLIENT_SECRET = 'a-real-sapo-client-secret';
const ADMIN_ORIGIN = 'https://admin.example.test';

const sessionEnv = fake<AppEnv>({
  FRONTEND_URL: ADMIN_ORIGIN,
  API_BASE_URL: 'https://api.example.test',
  CORS_ALLOWED_ORIGINS: [],
  APP_SESSION_SECRET: GOOD_SESSION_SECRET,
  APP_SESSION_TTL_SECONDS: 3600,
  SESSION_COOKIE_NAME: 'sapo_app_session',
  SESSION_HANDOFF_TTL_SECONDS: 60,
  SESSION_COOKIE_DOMAIN: '',
  NODE_ENV: 'test',
});

const makeSessions = () => new SessionService(sessionEnv, new RedisService({ keyPrefix: 's4-session' }));

test('secret guard rejects empty, placeholder and short secrets', () => {
  assert.throws(() => assertUsableSecret('X', undefined), /X is required/);
  assert.throws(() => assertUsableSecret('X', '   '), /X is required/);
  assert.throws(() => assertUsableSecret('X', 'replace-with-client-secret'), /placeholder/);
  assert.throws(() => assertUsableSecret('X', 'short', { minBytes: 32 }), /at least 32 bytes/);
  assert.equal(assertUsableSecret('X', GOOD_CLIENT_SECRET), GOOD_CLIENT_SECRET);
  assert.equal(assertUsableSecret('X', GOOD_SESSION_SECRET, { minBytes: 32 }), GOOD_SESSION_SECRET);
});

test('encryption key guard rejects the public sample key in base64 and hex, and wrong lengths', () => {
  assert.equal(SAMPLE_ENCRYPTION_KEYS.length, 2);
  assert.equal(SAMPLE_ENCRYPTION_KEYS[0], 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=');
  for (const sample of SAMPLE_ENCRYPTION_KEYS) {
    assert.throws(() => assertEncryptionKey(sample), /public sample key/);
  }
  assert.throws(() => assertEncryptionKey(Buffer.alloc(16, 1).toString('base64')), /32 bytes/);
  assert.throws(() => assertEncryptionKey(''), /required/);
  assert.throws(() => assertEncryptionKey('replace-with-generated-key'), /placeholder/);
  assert.equal(assertEncryptionKey(GOOD_KEY).length, 32);
  assert.equal(assertEncryptionKey(Buffer.alloc(32, 9).toString('hex')).length, 32);
});

test('loadEnv rejects SET weak secrets in every NODE_ENV but still accepts empty ones outside production', () => {
  assert.doesNotThrow(() => loadEnv({}));
  assert.doesNotThrow(() => loadEnv({ NODE_ENV: 'test' }));
  for (const NODE_ENV of ['development', 'test']) {
    assert.throws(() => loadEnv({ NODE_ENV, SAPO_CLIENT_SECRET: 'replace-with-client-secret' }), /SAPO_CLIENT_SECRET must not be a placeholder/);
    assert.throws(() => loadEnv({ NODE_ENV, APP_SESSION_SECRET: 'too-short' }), /APP_SESSION_SECRET must be at least 32 bytes/);
    assert.throws(() => loadEnv({ NODE_ENV, APP_SESSION_SECRET: 'replace-with-32-byte-random-secret-padding' }), /APP_SESSION_SECRET must not be a placeholder/);
    assert.throws(() => loadEnv({ NODE_ENV, DATA_ENCRYPTION_KEY: SAMPLE_ENCRYPTION_KEYS[0] }), /public sample key/);
    assert.throws(() => loadEnv({ NODE_ENV, DATA_ENCRYPTION_KEY: SAMPLE_ENCRYPTION_KEYS[1] }), /public sample key/);
    assert.throws(() => loadEnv({ NODE_ENV, DATA_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64') }), /32 bytes/);
  }
  const ok = loadEnv({
    NODE_ENV: 'test',
    SAPO_CLIENT_SECRET: GOOD_CLIENT_SECRET,
    APP_SESSION_SECRET: GOOD_SESSION_SECRET,
    DATA_ENCRYPTION_KEY: GOOD_KEY,
  });
  assert.equal(ok.DATA_ENCRYPTION_KEY, GOOD_KEY);
});

test('TRUST_PROXY must be explicit in production, and false stays valid when set', () => {
  assert.throws(() => loadEnv({ NODE_ENV: 'production' }), /TRUST_PROXY must be explicitly set in production/);
  assert.equal(loadEnv({ NODE_ENV: 'test', TRUST_PROXY: 'false' }).TRUST_PROXY, false);
});

test('constructors fail closed on empty or placeholder secrets', () => {
  const redis = new RedisService({ keyPrefix: 's4-ctor' });
  assert.throws(() => new HmacVerifierService(fake<AppEnv>({ SAPO_CLIENT_SECRET: '' })), /SAPO_CLIENT_SECRET is required/);
  assert.throws(() => new HmacVerifierService(fake<AppEnv>({ SAPO_CLIENT_SECRET: 'replace-with-client-secret' })), /placeholder/);
  assert.doesNotThrow(() => new HmacVerifierService(fake<AppEnv>({ SAPO_CLIENT_SECRET: GOOD_CLIENT_SECRET })));

  assert.throws(() => new SessionService({ ...sessionEnv, APP_SESSION_SECRET: '' }, redis), /APP_SESSION_SECRET is required/);
  assert.throws(() => new SessionService({ ...sessionEnv, APP_SESSION_SECRET: 'short-secret' }, redis), /at least 32 bytes/);

  assert.throws(() => new TokenEncryptionService(fake<AppEnv>({ DATA_ENCRYPTION_KEY: '' })), /DATA_ENCRYPTION_KEY is required/);
  assert.throws(() => new TokenEncryptionService(fake<AppEnv>({ DATA_ENCRYPTION_KEY: SAMPLE_ENCRYPTION_KEYS[0] })), /public sample key/);
  const service = new TokenEncryptionService(fake<AppEnv>({ DATA_ENCRYPTION_KEY: GOOD_KEY }));
  assert.equal(service.decrypt(service.encrypt('secret-token')), 'secret-token');
});

test('session tokens carry the lifecycle generation and tokens without a numeric gen are rejected', () => {
  const sessions = makeSessions();
  const token = sessions.createSessionToken('demo.mysapo.net', 3);
  const payload = sessions.verifySessionToken(token);
  assert.equal(payload.gen, 3);
  assert.equal(payload.storeDomain, 'demo.mysapo.net');

  const forge = (body: Record<string, unknown>) => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const encoded = Buffer.from(JSON.stringify(body)).toString('base64url');
    return `${header}.${encoded}.${sessions['sign'](`${header}.${encoded}`)}`;
  };
  const now = Math.floor(Date.now() / 1000);
  const legacy = { storeDomain: 'demo.mysapo.net', type: 'sapo_app_session', iat: now, exp: now + 600 };
  assert.throws(() => sessions.verifySessionToken(forge(legacy)), /Invalid auth session/);
  assert.throws(() => sessions.verifySessionToken(forge({ ...legacy, gen: '3' })), /Invalid auth session/);
  assert.equal(sessions.verifySessionToken(forge({ ...legacy, gen: 0 })).gen, 0);
});

test('the session cookie is HttpOnly and carries the supplied token', () => {
  const sessions = makeSessions();
  const headers: Record<string, string> = {};
  const res = fake<Response>({ setHeader: (name: string, value: string) => { headers[name] = value; } });
  const token = sessions.createSessionToken('demo.mysapo.net', 1);
  sessions.setSessionCookie(res, token);
  const cookie = headers['Set-Cookie'] ?? '';
  assert.match(cookie, /HttpOnly/);
  assert.ok(cookie.includes(encodeURIComponent(token)));
});

interface GuardRequest {
  method: string;
  headers: { origin: string; authorization: string };
  query: Record<string, never>;
  body: Record<string, never>;
  storeDomain?: string;
}

test('ShopAuthGuard rejects a session whose lifecycle generation no longer matches the install', async () => {
  const sessions = makeSessions();
  let generation = 2;
  const sapo = fake<SapoService>({
    getLifecycleGeneration: async () => generation,
    resolveAccessToken: async () => 'upstream-token',
  });
  const guard = new ShopAuthGuard(sessionEnv, sessions, sapo, new Reflector());
  const context = (req: GuardRequest) => fake<ExecutionContext>({
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  });
  const token = sessions.createSessionToken('demo.mysapo.net', 2);
  const request = (): GuardRequest => ({
    method: 'GET',
    headers: { origin: ADMIN_ORIGIN, authorization: `Bearer ${token}` },
    query: {},
    body: {},
  });

  const req = request();
  assert.equal(await guard.canActivate(context(req)), true);
  assert.equal(req.storeDomain, 'demo.mysapo.net');

  generation = 3;
  await assert.rejects(guard.canActivate(context(request())), UnauthorizedException);
});
