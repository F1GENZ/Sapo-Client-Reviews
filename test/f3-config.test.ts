import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { resolve } from 'path';

import { loadEnv } from '../src/config/env.schema';

const STRONG_SECRET = 'r2-upload-secret-0123456789abcdef0123456789';
const R2_ALL = {
  R2_WORKER_URL: 'https://r2.example.workers.dev',
  R2_PUBLIC_DOMAIN: 'cdn.example.com',
  R2_UPLOAD_SECRET: STRONG_SECRET,
};
const ENVS = ['development', 'test', 'production'] as const;

const productionBase = (): Record<string, string> => ({
  NODE_ENV: 'production',
  PORT: '3000',
  FRONTEND_URL: 'https://app.example.com',
  API_BASE_URL: 'https://api.example.com',
  CORS_ALLOWED_ORIGINS: 'https://app.example.com',
  TRUST_PROXY: '1',
  REQUEST_BODY_LIMIT: '1mb',
  WEBHOOK_BODY_LIMIT: '256kb',
  SAPO_CLIENT_ID: 'client-id-live',
  SAPO_CLIENT_SECRET: 'sapo-client-secret-live-0001',
  SAPO_SCOPE: 'read_products,write_products,read_orders',
  SAPO_INSTALL_CALLBACK_URL: 'https://api.example.com/api/oauth/install/callback',
  SAPO_LOGIN_CALLBACK_URL: 'https://api.example.com/api/oauth/install/login/callback',
  SAPO_API_MAX_CONCURRENT: '4',
  APP_SESSION_SECRET: 'session-secret-live-0123456789abcdef0123456789',
  APP_SESSION_TTL_SECONDS: '3600',
  SESSION_HANDOFF_TTL_SECONDS: '120',
  REDIS_HOST: 'redis.internal',
  REDIS_PORT: '6379',
  REDIS_KEY_PREFIX: 'live-reviews',
  DATABASE_URL: 'postgresql://app:pw@db.internal:5432/app',
  DIRECT_URL: 'postgresql://app:pw@db.internal:5432/app',
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  AUTH_RATE_LIMIT_WINDOW_SECONDS: '60',
  AUTH_RATE_LIMIT_MAX: '60',
  SESSION_EXCHANGE_RATE_LIMIT_MAX: '60',
  PUBLIC_WRITE_RATE_LIMIT_WINDOW_SECONDS: '60',
  PUBLIC_WRITE_RATE_LIMIT_MAX: '20',
  READINESS_TOKEN: 'readiness-token-live',
});

test('R2 settings: all three empty is valid in every NODE_ENV', () => {
  for (const NODE_ENV of ENVS) {
    const raw = NODE_ENV === 'production' ? productionBase() : { NODE_ENV };
    assert.doesNotThrow(() => loadEnv(raw), NODE_ENV);
  }
});

test('R2 settings: all three set with a strong secret loads in every NODE_ENV', () => {
  for (const NODE_ENV of ENVS) {
    const raw = NODE_ENV === 'production' ? productionBase() : { NODE_ENV };
    const env = loadEnv({ ...raw, ...R2_ALL });
    assert.equal(env.R2_UPLOAD_SECRET, STRONG_SECRET, NODE_ENV);
  }
});

test('R2 settings: setting any one of the three requires the other two in every NODE_ENV', () => {
  for (const NODE_ENV of ENVS) {
    const raw = NODE_ENV === 'production' ? productionBase() : { NODE_ENV };
    for (const only of Object.keys(R2_ALL) as Array<keyof typeof R2_ALL>) {
      const partial = { [only]: R2_ALL[only] };
      let message = '';
      try {
        loadEnv({ ...raw, ...partial });
      } catch (error) {
        message = (error as Error).message;
      }
      for (const other of Object.keys(R2_ALL)) {
        if (other === only) continue;
        assert.match(message, new RegExp(`${other} is required when any of R2_WORKER_URL, R2_PUBLIC_DOMAIN, R2_UPLOAD_SECRET is set`), `${NODE_ENV}/${only}`);
      }
    }
  }
});

test('R2_UPLOAD_SECRET rejects placeholders and short values in every NODE_ENV', () => {
  for (const NODE_ENV of ENVS) {
    const raw = NODE_ENV === 'production' ? productionBase() : { NODE_ENV };
    assert.throws(
      () => loadEnv({ ...raw, ...R2_ALL, R2_UPLOAD_SECRET: 'replace-with-generated-upload-secret-min-32-bytes' }),
      /R2_UPLOAD_SECRET must not be a placeholder/,
      NODE_ENV,
    );
    assert.throws(
      () => loadEnv({ ...raw, ...R2_ALL, R2_UPLOAD_SECRET: 'too-short-upload-secret' }),
      /R2_UPLOAD_SECRET must be at least 32 bytes/,
      NODE_ENV,
    );
  }
});

test('.env.example R2 block is rejected as a placeholder by loadEnv', () => {
  const example = readFileSync(resolve(__dirname, '..', '.env.example'), 'utf8');
  const value = (key: string): string => {
    const match = new RegExp(`^${key}=(.*)$`, 'm').exec(example);
    assert.ok(match, `${key} missing from .env.example`);
    return match[1].trim();
  };
  assert.throws(
    () =>
      loadEnv({
        NODE_ENV: 'development',
        R2_WORKER_URL: value('R2_WORKER_URL'),
        R2_UPLOAD_SECRET: value('R2_UPLOAD_SECRET'),
        R2_PUBLIC_DOMAIN: value('R2_PUBLIC_DOMAIN'),
      }),
    /R2_UPLOAD_SECRET must not be a placeholder/,
  );
});

test('the unused WEBHOOK_RATE_LIMIT variables are neither required nor parsed', () => {
  const env = loadEnv(productionBase());
  assert.ok(!('WEBHOOK_RATE_LIMIT_WINDOW_SECONDS' in env));
  assert.ok(!('WEBHOOK_RATE_LIMIT_MAX' in env));
  const example = readFileSync(resolve(__dirname, '..', '.env.example'), 'utf8');
  assert.ok(!example.includes('WEBHOOK_RATE_LIMIT'));
});
