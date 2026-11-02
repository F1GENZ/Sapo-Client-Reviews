import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'crypto';

import { RedisService } from '../src/redis/redis.service';
import {
  IngressRateLimitService,
  MEMORY_BUCKET_MAX_ENTRIES,
} from '../src/common/security/ingress-rate-limit.service';
import {
  MediaService,
  PUBLIC_UPLOAD_DAILY_CAP_PER_STORE,
  sniffUploadContentType,
} from '../src/media/media.service';
import { UPLOAD_ERROR } from '../src/media/media-errors';
import { HttpException } from '@nestjs/common';
import type { AppEnv } from '../src/config/env.schema';
import { fake } from './support/fakes';
import { worker, type WorkerEnv } from './support/worker';

const SECRET = 'test-upload-ticket-secret';
const mediaEnv = {
  R2_UPLOAD_SECRET: SECRET,
  R2_WORKER_URL: 'https://r2-worker.example.test',
  R2_PUBLIC_DOMAIN: 'cdn.example.test',
};
const makeMedia = (prefix: string) => new MediaService(fake<AppEnv>(mediaEnv), new RedisService({ keyPrefix: prefix }));
type TicketInput = Parameters<MediaService['createUploadTicket']>[0];
type VerifyExpected = Parameters<MediaService['verifyUploadTicket']>[1];
const ticketInput = (overrides: Partial<TicketInput> & { filename?: string } = {}): TicketInput & { filename?: string } => ({
  storeDomain: 'demo.mysapo.net',
  productId: '123',
  contentType: 'image/png',
  fileSize: 1024,
  ...overrides,
});
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

const ftyp = (brand: string) => {
  const box = Buffer.alloc(24);
  box.writeUInt32BE(24, 0);
  box.write('ftyp', 4, 'latin1');
  box.write(brand, 8, 'latin1');
  box.write(brand, 16, 'latin1');
  return Buffer.concat([box, Buffer.alloc(32)]);
};

const statusOf = (error: unknown): number | undefined => (error instanceof HttpException ? error.getStatus() : undefined);
const codeOf = (error: unknown): unknown => {
  if (!(error instanceof HttpException)) return undefined;
  const body = error.getResponse();
  return typeof body === 'object' && 'code' in body ? body.code : undefined;
};

test('video sniffing accepts MP4 brands and rejects QuickTime and truncated boxes', () => {
  for (const brand of ['isom', 'mp42', 'mp41', 'avc1', 'M4V ']) {
    assert.equal(sniffUploadContentType(ftyp(brand)), 'video/mp4', brand);
  }
  assert.equal(sniffUploadContentType(ftyp('qt  ')), null, 'MOV is not MP4');
  assert.equal(sniffUploadContentType(ftyp('heic')), null);
  const oversizedBox = ftyp('isom');
  oversizedBox.writeUInt32BE(0xffffff, 0);
  assert.equal(sniffUploadContentType(oversizedBox), null);
});

test('upload ticket ignores filename, is signed with a derived key, and maps failures to distinct statuses', async () => {
  const media = makeMedia('s5-ticket');
  const { ticket } = media.createUploadTicket(ticketInput({ filename: 'ảnh đẹp.png' }));
  const [encoded, signature] = ticket.split('.');
  assert.equal('filename' in JSON.parse(Buffer.from(encoded, 'base64url').toString()), false);

  const rawKeySignature = createHmac('sha256', SECRET).update(encoded).digest('base64url');
  assert.notEqual(signature, rawKeySignature, 'ticket key differs from the Worker token');
  assert.throws(() => media.inspectUploadTicket(`${encoded}.${rawKeySignature}`, 'demo.mysapo.net'), (error) => {
    assert.equal(statusOf(error), 401);
    assert.equal(codeOf(error), UPLOAD_ERROR.ticketInvalid);
    return true;
  });
  assert.throws(() => media.inspectUploadTicket('', 'demo.mysapo.net'), (error) => statusOf(error) === 401);
  assert.throws(() => media.inspectUploadTicket(ticket, 'other.mysapo.net'), (error) => statusOf(error) === 403);

  const verify = (overrides: Partial<VerifyExpected> = {}) => media.verifyUploadTicket(ticket, {
    storeDomain: 'demo.mysapo.net',
    productId: '123',
    contentType: 'image/png',
    fileSize: 1024,
    ...overrides,
  });
  await assert.rejects(verify({ fileSize: 2048 }), (error) => statusOf(error) === 403 && codeOf(error) === UPLOAD_ERROR.ticketMismatch);
  const payload = await verify();
  assert.equal(payload.productId, '123');
  await assert.rejects(verify(), (error) => statusOf(error) === 409 && codeOf(error) === UPLOAD_ERROR.ticketUsed);

  assert.throws(() => media.validateUploadInput('image/jpeg', 5 * 1024 * 1024 + 1), (error) => statusOf(error) === 413);
  assert.throws(() => media.validateUploadInput('video/mp4', 2 * 1024 * 1024 + 1), (error) => statusOf(error) === 413);
});

test('object key is server-named from the sniffed type and the ticket nonce', async () => {
  const media = makeMedia('s5-key');
  const originalFetch = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (url: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response('ok', { status: 200 });
  };
  try {
    const { ticket } = media.createUploadTicket(ticketInput());
    const payload = await media.verifyUploadTicket(ticket, {
      storeDomain: 'demo.mysapo.net', productId: '123', contentType: 'image/png', fileSize: 1024,
    });
    const stored = await media.uploadFile('demo.mysapo.net', '123', payload.nonce, 'image/png', PNG);
    assert.equal(calls[0].url, `https://r2-worker.example.test/reviews/demo.mysapo.net/123/${payload.nonce}.png`);
    assert.equal(stored.cdnUrl, `https://cdn.example.test/reviews/demo.mysapo.net/123/${payload.nonce}.png`);

    await assert.rejects(
      media.uploadFile('demo.mysapo.net', '123', payload.nonce, 'image/jpeg', PNG),
      (error) => statusOf(error) === 400 && codeOf(error) === UPLOAD_ERROR.contentMismatch,
    );
    await assert.rejects(
      media.uploadFile('demo.mysapo.net', '123', '../../etc', 'image/png', PNG),
      (error) => codeOf(error) === UPLOAD_ERROR.invalidNonce,
    );

    globalThis.fetch = async () => new Response('no', { status: 401 });
    await assert.rejects(
      media.uploadFile('demo.mysapo.net', '123', payload.nonce, 'image/png', PNG),
      (error) => statusOf(error) === 502 && codeOf(error) === UPLOAD_ERROR.storageRejected,
    );
    globalThis.fetch = async () => new Response('big', { status: 413 });
    await assert.rejects(
      media.uploadFile('demo.mysapo.net', '123', payload.nonce, 'image/png', PNG),
      (error) => statusOf(error) === 413,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('per-store daily upload counter returns 429 past the cap', async () => {
  const media = makeMedia('s5-daily');
  await media.assertDailyUploadCapacity('demo.mysapo.net');
  for (let i = 0; i < PUBLIC_UPLOAD_DAILY_CAP_PER_STORE; i += 1) {
    const { ticket } = media.createUploadTicket(ticketInput());
    await media.verifyUploadTicket(ticket, {
      storeDomain: 'demo.mysapo.net', productId: '123', contentType: 'image/png', fileSize: 1024,
    });
  }
  await assert.rejects(
    media.assertDailyUploadCapacity('demo.mysapo.net'),
    (error) => statusOf(error) === 429 && codeOf(error) === UPLOAD_ERROR.dailyCap,
  );
  await media.assertDailyUploadCapacity('other.mysapo.net');
  const { ticket } = media.createUploadTicket(ticketInput());
  await assert.rejects(
    media.verifyUploadTicket(ticket, {
      storeDomain: 'demo.mysapo.net', productId: '123', contentType: 'image/png', fileSize: 1024,
    }),
    (error) => statusOf(error) === 429,
  );
});

test('RedisService.incr keeps a counter and its TTL in memory mode', async () => {
  const redis = new RedisService({ keyPrefix: 's5-incr' });
  assert.equal(await redis.incr('k', 30), 1);
  assert.equal(await redis.incr('k', 30), 2);
  const ttl = await redis.ttl('k');
  assert.ok(ttl > 0 && ttl <= 30);
});

test('rate limiter falls back to memory buckets when Redis fails', async () => {
  const failing = {
    isConfigured: true,
    incr: async () => { throw new Error('redis down'); },
    ttl: async () => { throw new Error('redis down'); },
  };
  const limiter = new IngressRateLimitService(fake<RedisService>(failing));
  const first = await limiter.check('b', 'client', 60, 2);
  assert.equal(first.allowed, true);
  assert.equal((await limiter.check('b', 'client', 60, 2)).allowed, true);
  assert.equal((await limiter.check('b', 'client', 60, 2)).allowed, false);
  await assert.rejects(limiter.assertAllowed('b', 'client', 60, 2), (error) => statusOf(error) === 429);
});

test('memory buckets are capped', async () => {
  const limiter = new IngressRateLimitService();
  for (let i = 0; i < MEMORY_BUCKET_MAX_ENTRIES + 10; i += 1) {
    await limiter.check('flood', `client-${i}`, 3600, 5);
  }
  assert.ok(fake<{ memoryBuckets: Map<string, unknown> }>(limiter).memoryBuckets.size <= MEMORY_BUCKET_MAX_ENTRIES);
});

const workerKey = 'reviews/demo.mysapo.net/123/abcdefghijklmnop';
const workerEnv = () => {
  const stored: { key: string; size: number; options: unknown }[] = [];
  return {
    stored,
    env: {
      UPLOAD_SECRET: 'worker-secret',
      CDN_DOMAIN: 'cdn.example.test',
      MEDIA: { put: async (key: string, body: Uint8Array, options: unknown) => { stored.push({ key, size: body.byteLength, options }); } },
    },
  };
};
const workerPut = (env: WorkerEnv, { key = `${workerKey}.png`, type = 'image/png', size = 100, token = 'worker-secret' } = {}) =>
  worker.fetch(new Request(`https://worker.example.test/${key}`, {
    method: 'PUT',
    headers: { 'Content-Type': type, 'Content-Length': String(size), ...(token ? { 'X-Upload-Token': token } : {}) },
    body: new Uint8Array(size),
  }), env);

test('worker enforces token, per-type limits and server-shaped keys', async () => {
  const { env, stored } = workerEnv();
  assert.equal((await workerPut(env, { token: 'wrong' })).status, 401);
  assert.equal((await workerPut(env, { token: '' })).status, 401);
  assert.equal((await workerPut(env)).status, 200);
  assert.equal(stored.length, 1);

  assert.equal((await workerPut(env, { size: 3 * 1024 * 1024 })).status, 200, 'images may be up to 5 MB');
  assert.equal((await workerPut(env, { size: 5 * 1024 * 1024 + 1 })).status, 413);
  assert.equal((await workerPut(env, { key: `${workerKey}.mp4`, type: 'video/mp4', size: 3 * 1024 * 1024 })).status, 413, 'videos stop at 2 MB');
  assert.equal((await workerPut(env, { key: `${workerKey}.mp4`, type: 'video/mp4', size: 2 * 1024 * 1024 })).status, 200);
  assert.equal((await workerPut(env, { key: `${workerKey}.mp4` })).status, 400, 'extension must match content type');
  assert.equal((await workerPut(env, { key: 'reviews/demo.mysapo.net/123/x/photo.png' })).status, 400);
  assert.equal((await workerPut(env, { type: 'image/svg+xml' })).status, 400);
});

test('worker stores media with a short cache lifetime so deleted media leaves the edge within minutes', async () => {
  const { env, stored } = workerEnv();
  assert.equal((await workerPut(env)).status, 200);
  const { httpMetadata } = fake<{ httpMetadata: { contentType: string; cacheControl: string } }>(stored[0].options);
  assert.equal(httpMetadata.contentType, 'image/png');
  const maxAge = Number(/max-age=(\d+)/.exec(httpMetadata.cacheControl)?.[1]);
  assert.ok(maxAge > 0 && maxAge <= 300, `unexpected cache lifetime: ${httpMetadata.cacheControl}`);
});
