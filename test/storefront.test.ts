import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import vm from 'vm';

import type { Response } from 'express';

import { StorefrontAssetController } from '../src/storefront/storefront-asset.controller';
import { STOREFRONT_ASSET_CACHE_CONTROL } from '../src/storefront/storefront-asset-cache';
import { fake } from './support/fakes';

const RUNTIME_PATH = join(__dirname, '..', 'storefront', 'snippets', 'f1genz-storefront.js');
const RUNTIME_SOURCE = readFileSync(RUNTIME_PATH, 'utf8');
const API = 'https://api.example.test';
const STORE = 'demo.mysapo.net';

interface FetchResult {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}
type FetchImpl = (url: string) => Promise<FetchResult>;

interface FakeImage {
  src?: string;
  naturalWidth?: number;
  naturalHeight?: number;
  onload?: () => void;
  onerror?: () => void;
}
interface FakeCanvas {
  width: number;
  height: number;
  getContext: () => { drawImage: () => void };
  toBlob: (callback: (blob: Blob) => void, type: string, quality: number) => void;
}
interface FakeElement {
  style: Record<string, string>;
  setAttribute: () => void;
  appendChild: () => void;
  removeAttribute: () => void;
}
type CreateElement = (tag: string) => FakeElement | FakeCanvas;

interface UploadFile {
  name: string;
  type: string;
  size: number;
}
interface SchemaReview {
  author: { name: string };
  reviewBody: string;
  reviewRating: { ratingValue: number };
}
interface ProductSchema {
  [key: string]: unknown;
  image: string[];
  review: SchemaReview[];
  aggregateRating: { reviewCount: number };
}
interface PageInfo {
  href: string;
  origin: string;
  pathname: string;
  canonicalHref: string;
}
type SchemaInput = Record<string, unknown>;
type SchemaSummary = { count?: number; avg?: number };
type PublicRow = Record<string, unknown>;

interface RuntimeInternals {
  formatSafeRichText: (text: string | null | undefined) => string;
  buildProductSchema: (
    product: SchemaInput,
    reviews: PublicRow[],
    summary: SchemaSummary,
    page: PageInfo,
  ) => ProductSchema | null;
  getPublicReviews: (api: string, store: string, productId: string) => Promise<PublicRow[]>;
  getPublicQuestions: (api: string, store: string, productId: string) => Promise<PublicRow[]>;
  getWidgetConfig: (api: string, store: string) => Promise<{ titleText?: string }>;
  prepareImageForUpload: (file: UploadFile) => Promise<UploadFile>;
  normalizeVideoLink: (value: string) => string;
  limits: { IMAGE_MAX_SIZE: number; VIDEO_MAX_SIZE: number; IMAGE_SOFT_TARGET: number };
}

interface LoadOptions {
  fetchImpl?: FetchImpl;
  createElement?: CreateElement;
  imageFactory?: () => FakeImage;
}

function loadRuntime({ fetchImpl, createElement, imageFactory }: LoadOptions = {}) {
  const defined: Record<string, unknown> = {};
  let activeFetch: FetchImpl = () => Promise.reject(new Error('offline'));
  const baseElement = (): FakeElement => ({ style: {}, setAttribute() {}, appendChild() {}, removeAttribute() {} });
  const sandbox: Record<string, unknown> = {
    console,
    URL: class extends URL {
      static createObjectURL() { return 'blob:test'; }
      static revokeObjectURL() {}
    },
    FormData,
    Blob,
    File: class extends Blob {
      readonly name: string;
      readonly lastModified: number | undefined;
      constructor(parts: BlobPart[], name: string, options: { type?: string; lastModified?: number } = {}) {
        super(parts, options);
        this.name = name;
        this.lastModified = options.lastModified;
      }
    },
    HTMLElement: class {},
    HTMLScriptElement: class {},
    Element: class {},
    MutationObserver: class { observe() {} },
    customElements: {
      get: (name: string) => defined[name],
      define: (name: string, cls: unknown) => { defined[name] = cls; },
    },
    fetch: (url: string) => activeFetch(url),
    Image: imageFactory,
    location: {
      href: `https://${STORE}/products/demo?utm=1`,
      origin: `https://${STORE}`,
      pathname: '/products/demo',
    },
    __F1GENZ_STOREFRONT_CONFIG: { apiUrl: API, store: STORE },
  };
  sandbox.window = sandbox;
  sandbox.document = {
    readyState: 'loading',
    body: null,
    head: baseElement(),
    documentElement: baseElement(),
    currentScript: null,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: createElement || (() => baseElement()),
  };
  vm.createContext(sandbox);
  vm.runInContext(RUNTIME_SOURCE, sandbox, { filename: 'f1genz-storefront.js' });
  activeFetch = fetchImpl || activeFetch;
  const internals: RuntimeInternals = vm.runInContext('window.F1GENZStorefront.internals', sandbox);
  const tryBuildProductSchema: RuntimeInternals['buildProductSchema'] = (...args) => {
    const schema = internals.buildProductSchema(...args);
    return schema === null ? null : JSON.parse(JSON.stringify(schema));
  };
  const buildProductSchema = (...args: Parameters<RuntimeInternals['buildProductSchema']>): ProductSchema => {
    const schema = tryBuildProductSchema(...args);
    assert.ok(schema, 'buildProductSchema returned null');
    return schema;
  };
  return { ...internals, buildProductSchema, tryBuildProductSchema };
}

function jsonResponse(body: unknown, ok = true, status = 200): FetchResult {
  return { ok, status, json: async () => body };
}

function page(rows: PublicRow[], total: number, pageNumber = 1): FetchResult {
  return jsonResponse({ data: { items: rows, total, page: pageNumber, pageSize: 50 } });
}

const rows = (from: number, count: number): PublicRow[] =>
  Array.from({ length: count }, (_, index) => ({ id: `r${from + index}`, rating: 5 }));

const PAGE: PageInfo = {
  href: `https://${STORE}/products/demo?utm=1`,
  origin: `https://${STORE}`,
  pathname: '/products/demo',
  canonicalHref: '',
};

test('rich text escapes markup and only links http(s) targets', () => {
  const { formatSafeRichText } = loadRuntime();

  const script = formatSafeRichText('<script>alert(1)</script> & "x"');
  assert.ok(!script.includes('<script'));
  assert.ok(script.includes('&lt;script&gt;'));

  const js = formatSafeRichText('[click](javascript:alert(1))');
  assert.ok(!js.includes('<a '));

  const breakout = formatSafeRichText('[x](https://a.test/"onmouseover="alert(1))');
  assert.ok(!/<a[^>]*onmouseover/.test(breakout));
  assert.ok(breakout.includes('&quot;onmouseover'));

  assert.equal(formatSafeRichText(null), '');
  assert.equal(formatSafeRichText(undefined), '');
});

test('rich text markdown links tolerate whitespace and escape the label', () => {
  const { formatSafeRichText } = loadRuntime();

  const spaced = formatSafeRichText('[Xem <b>thêm</b>] ( https://shop.test/a?x=1&y=2 )');
  assert.ok(spaced.includes('href="https://shop.test/a?x=1&amp;y=2"'));
  assert.ok(spaced.includes('>Xem &lt;b&gt;thêm&lt;/b&gt;</a>'));
  assert.ok(spaced.includes('rel="noopener noreferrer nofollow"'));
  assert.ok(spaced.includes('target="_blank"'));

  const split = formatSafeRichText('[Docs]\n(https://shop.test/docs)');
  assert.ok(split.includes('href="https://shop.test/docs"'));
  assert.ok(!split.includes('<br>'));
});

test('rich text auto links keep surrounding quotes, parentheses and punctuation out of the href', () => {
  const { formatSafeRichText } = loadRuntime();

  const quoted = formatSafeRichText('Xem "https://shop.test/x", cảm ơn.');
  assert.ok(quoted.includes('href="https://shop.test/x"'));
  assert.ok(quoted.includes('</a>&quot;, cảm ơn.'));

  const trailing = formatSafeRichText('Ghé https://shop.test/x.');
  assert.ok(trailing.includes('href="https://shop.test/x"'));
  assert.ok(trailing.endsWith('</a>.'));

  const paren = formatSafeRichText('(xem https://shop.test/x) nhé');
  assert.ok(paren.includes('href="https://shop.test/x"'));
  assert.ok(paren.includes('</a>) nhé'));

  const apostrophe = formatSafeRichText("https://shop.test/it's");
  assert.ok(apostrophe.includes('href="https://shop.test/it&#039;s"'));

  const notLinked = formatSafeRichText('abchttps://shop.test/x');
  assert.ok(!notLinked.includes('<a '));
});

test('rich text keeps user supplied placeholder-looking text verbatim and breaks lines', () => {
  const { formatSafeRichText } = loadRuntime();
  assert.equal(formatSafeRichText('__F1GENZ_LINK_0__'), '__F1GENZ_LINK_0__');
  assert.equal(formatSafeRichText('a\r\nb\nc'), 'a<br>b<br>c');
});

test('product schema without reviews carries no rating, review or offer data', () => {
  const { buildProductSchema } = loadRuntime();
  const schema = buildProductSchema(
    { name: 'Áo thun', images: `//cdn.test/a.jpg`, currency: 'VND' },
    [],
    { count: 0, avg: 0 },
    PAGE,
  );

  assert.equal(schema['@type'], 'Product');
  assert.equal(schema['@id'], `https://${STORE}/products/demo#product`);
  assert.equal('aggregateRating' in schema, false);
  assert.equal('review' in schema, false);
  assert.equal('offers' in schema, false);
  assert.deepEqual(schema.image, ['https://cdn.test/a.jpg']);
});

test('product schema ignores approved reviews when the summary count is zero', () => {
  const { buildProductSchema } = loadRuntime();
  const schema = buildProductSchema(
    { name: 'Áo thun' },
    [{ author: 'A', rating: 5, content: 'ok', created_at: Date.now() }],
    { count: 0, avg: 0 },
    PAGE,
  );
  assert.equal('aggregateRating' in schema, false);
  assert.equal('review' in schema, false);
});

test('product schema with reviews is a structurally valid Product + AggregateRating + Review', () => {
  const { buildProductSchema } = loadRuntime();
  const created = Date.UTC(2026, 6, 1);
  const schema = buildProductSchema(
    {
      name: 'Áo thun',
      url: '/products/demo',
      images: '//cdn.test/a.jpg, /media/b.jpg, https://cdn.test/c.jpg',
      brand: 'Demo',
      price: '1.500.000₫',
      currency: 'VND',
      sku: 'SKU-1',
      availability: 'OutOfStock',
    },
    [
      { author: ' Lan ', rating: 4, content: 'Tốt', title: 'Ổn', created_at: created },
      { author: '', rating: 9, content: '', title: 'Chỉ tiêu đề', created_at: created },
    ],
    { count: 37, avg: 4.26 },
    { ...PAGE, canonicalHref: `https://${STORE}/products/demo?variant=1#top` },
  );

  assert.equal(schema['@context'], 'https://schema.org/');
  assert.equal(schema['@type'], 'Product');
  assert.equal(schema['@id'], `https://${STORE}/products/demo#product`);
  assert.deepEqual(schema.image, [
    'https://cdn.test/a.jpg',
    `https://${STORE}/media/b.jpg`,
    'https://cdn.test/c.jpg',
  ]);
  assert.deepEqual(schema.brand, { '@type': 'Brand', name: 'Demo' });
  assert.deepEqual(schema.offers, {
    '@type': 'Offer',
    url: `https://${STORE}/products/demo`,
    priceCurrency: 'VND',
    price: '1500000',
    availability: 'https://schema.org/OutOfStock',
  });
  assert.deepEqual(schema.aggregateRating, {
    '@type': 'AggregateRating',
    ratingValue: 4.3,
    reviewCount: 37,
    bestRating: 5,
    worstRating: 1,
  });
  assert.equal(schema.review.length, 2);
  assert.deepEqual(schema.review[0], {
    '@type': 'Review',
    author: { '@type': 'Person', name: 'Lan' },
    datePublished: '2026-07-01',
    reviewBody: 'Tốt',
    name: 'Ổn',
    reviewRating: { '@type': 'Rating', ratingValue: 4, bestRating: 5, worstRating: 1 },
  });
  assert.equal(schema.review[1].author.name, 'Customer');
  assert.equal(schema.review[1].reviewBody, 'Chỉ tiêu đề');
  assert.equal(schema.review[1].reviewRating.ratingValue, 5);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(schema)));
});

test('product schema drops image URLs it cannot make absolute http(s)', () => {
  const { buildProductSchema } = loadRuntime();
  const schema = buildProductSchema(
    { name: 'X', images: 'javascript:alert(1), data:image/png;base64,AAAA, relative/path.jpg, ftp://h/a.jpg' },
    [],
    {},
    PAGE,
  );
  assert.equal('image' in schema, false);
});

test('product schema entity id uses a relative canonical resolved against the origin and falls back to the page path', () => {
  const { buildProductSchema } = loadRuntime();
  const relative = buildProductSchema(
    { name: 'X' },
    [],
    {},
    { ...PAGE, canonicalHref: '/products/canonical?x=1' },
  );
  assert.equal(relative['@id'], `https://${STORE}/products/canonical#product`);

  const fallback = buildProductSchema({ name: 'X' }, [], {}, PAGE);
  assert.equal(fallback['@id'], `https://${STORE}/products/demo#product`);
});

test('product schema requires a product name and caps embedded reviews', () => {
  const { buildProductSchema, tryBuildProductSchema } = loadRuntime();
  assert.equal(tryBuildProductSchema({ name: '  ' }, [], {}, PAGE), null);

  const many = Array.from({ length: 80 }, (_, index) => ({ author: `U${index}`, rating: 5, content: 'ok' }));
  const capped = buildProductSchema({ name: 'X', maxReviews: '500' }, many, { count: 80, avg: 5 }, PAGE);
  assert.equal(capped.review.length, 50);
  assert.equal(capped.aggregateRating.reviewCount, 80);
});

test('public review list follows the paged API until the reported total is reached', async () => {
  const urls: string[] = [];
  const runtime = loadRuntime({
    fetchImpl: async (url: string) => {
      urls.push(url);
      const pageNumber = Number(new URL(url).searchParams.get('page'));
      return pageNumber === 1 ? page(rows(0, 50), 70, 1) : page(rows(50, 20), 70, 2);
    },
  });

  const reviews = await runtime.getPublicReviews(API, STORE, '123');
  assert.equal(reviews.length, 70);
  assert.equal(new Set(reviews.map((review) => review.id)).size, 70);
  assert.equal(urls.length, 2);
  assert.ok(urls[0]?.startsWith(`${API}/api/public/reviews/123?page=1&limit=50`));
  assert.ok(urls[0]?.includes(`storeDomain=${encodeURIComponent(STORE)}`));
});

test('public review list stops when a page adds nothing new and survives a later page failure', async () => {
  const repeating = loadRuntime({ fetchImpl: async () => page(rows(0, 50), 500) });
  assert.equal((await repeating.getPublicReviews(API, STORE, '1')).length, 50);

  let calls = 0;
  const flaky = loadRuntime({
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return page(rows(0, 50), 200);
      throw new Error('boom');
    },
  });
  assert.equal((await flaky.getPublicReviews(API, STORE, '2')).length, 50);
});

test('public review list rejects when the first page fails and does not cache the failure', async () => {
  let calls = 0;
  const runtime = loadRuntime({
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ message: 'down' }, false, 503);
      return page(rows(0, 3), 3);
    },
  });

  await assert.rejects(() => runtime.getPublicReviews(API, STORE, '9'), /down/);
  assert.equal((await runtime.getPublicReviews(API, STORE, '9')).length, 3);
});

test('public lists accept a bare array payload', async () => {
  const runtime = loadRuntime({ fetchImpl: async () => jsonResponse({ data: rows(0, 4) }) });
  assert.equal((await runtime.getPublicQuestions(API, STORE, '5')).length, 4);
});

test('product id is percent-encoded in every public list path segment', async () => {
  const urls: string[] = [];
  const runtime = loadRuntime({
    fetchImpl: async (url: string) => {
      urls.push(url);
      return page([], 0);
    },
  });
  await runtime.getPublicReviews(API, STORE, 'a/b?c');
  await runtime.getPublicQuestions(API, STORE, 'a/b?c');
  assert.equal(urls.length, 2);
  urls.forEach((url) => assert.ok(url.includes('/a%2Fb%3Fc?page=1'), url));
});

test('widget config failures are not memoized', async () => {
  let calls = 0;
  const runtime = loadRuntime({
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error('offline');
      return jsonResponse({ data: { titleText: 'Nhận xét' } });
    },
  });

  const fallback = await runtime.getWidgetConfig(API, STORE);
  assert.notEqual(fallback.titleText, 'Nhận xét');
  const recovered = await runtime.getWidgetConfig(API, STORE);
  assert.equal(recovered.titleText, 'Nhận xét');
  assert.equal(calls, 2);
  await runtime.getWidgetConfig(API, STORE);
  assert.equal(calls, 2);
});

const MB = 1024 * 1024;
const fakeFile = (type: string, size: number): UploadFile => ({ name: 'IMG_0001.png', type, size });

test('images already under the compression target and non-images pass through without being decoded', async () => {
  const decodes = { count: 0 };
  const runtime = loadRuntime({
    imageFactory: function Image() {
      decodes.count += 1;
      return {};
    },
  });
  const small = fakeFile('image/png', runtime.limits.IMAGE_SOFT_TARGET);
  assert.equal(await runtime.prepareImageForUpload(small), small);
  const video = fakeFile('video/mp4', 2 * MB);
  assert.equal(await runtime.prepareImageForUpload(video), video);
  assert.equal(decodes.count, 0, 'the early-return paths must not decode');
});

test('oversized unreadable images are rejected only above the hard limit', async () => {
  const brokenImage = () => {
    const image: FakeImage = {};
    Object.defineProperty(image, 'src', { set() { queueMicrotask(() => image.onerror?.()); } });
    return image;
  };
  const runtime = loadRuntime({ imageFactory: function Image() { return brokenImage(); } });

  const withinLimit = fakeFile('image/jpeg', 4 * MB);
  assert.equal(await runtime.prepareImageForUpload(withinLimit), withinLimit);
  await assert.rejects(
    () => runtime.prepareImageForUpload(fakeFile('image/jpeg', runtime.limits.IMAGE_MAX_SIZE + 1)),
    /Không đọc được ảnh/,
  );
});

test('large photos are re-encoded to JPEG under the target size', async () => {
  const source = { width: 4000, height: 3000 };
  const encoded: Array<{ type: string; quality: number; size: number; width: number }> = [];
  const decodes = { count: 0 };
  const runtime = loadRuntime({
    imageFactory: function Image() {
      decodes.count += 1;
      const image: FakeImage = { naturalWidth: source.width, naturalHeight: source.height };
      Object.defineProperty(image, 'src', { set() { queueMicrotask(() => image.onload?.()); } });
      return image;
    },
    createElement: (tag: string) => {
      if (tag !== 'canvas') return { style: {}, setAttribute() {}, appendChild() {}, removeAttribute() {} };
      const canvas: FakeCanvas = {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage() {} }),
        toBlob(callback: (blob: Blob) => void, type: string, quality: number) {
          const size = Math.round(8 * MB * quality * ((canvas.width * canvas.height) / (source.width * source.height)));
          encoded.push({ type, quality, size, width: canvas.width });
          callback(new Blob([new Uint8Array(size)], { type }));
        },
      };
      return canvas;
    },
  });
  const original = fakeFile('image/png', 8 * MB);
  const prepared = await runtime.prepareImageForUpload(original);
  assert.equal(decodes.count, 1, 'a large image is decoded exactly once');
  assert.notEqual(prepared, original);
  assert.equal(prepared.type, 'image/jpeg');
  assert.equal(prepared.name, 'IMG_0001.jpg');
  assert.ok(encoded.length >= 2);
  assert.ok(prepared.size <= runtime.limits.IMAGE_SOFT_TARGET);
  assert.ok(encoded.every((attempt) => attempt.type === 'image/jpeg'));
  assert.ok(encoded.every((attempt) => attempt.width <= 1920));
});

test('video links are accepted only for the hosts the server keeps, with an embeddable id', () => {
  const { normalizeVideoLink } = loadRuntime();
  for (const url of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://m.youtube.com/shorts/abc123',
    'https://vimeo.com/76979871',
    'https://player.vimeo.com/video/76979871',
  ]) {
    assert.equal(normalizeVideoLink(url), url);
  }
  for (const url of [
    'https://example.com/clip.mp4',
    'https://evil.example.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/',
    'http://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://vimeo.com/channels/staffpicks',
    'javascript:alert(1)',
    '',
  ]) {
    assert.equal(normalizeVideoLink(url), '', url);
  }
});

test('asset cache policy keeps the stale window no longer than the freshness window', () => {
  const capturedNumber = (pattern: RegExp): number => {
    const match = pattern.exec(STOREFRONT_ASSET_CACHE_CONTROL);
    assert.ok(match);
    return Number(match[1]);
  };
  const maxAge = capturedNumber(/max-age=(\d+)/);
  const stale = capturedNumber(/stale-while-revalidate=(\d+)/);
  assert.ok(stale <= maxAge);
});

test('asset controller serves the runtime files with the shared cache policy and nosniff', () => {
  const controller = new StorefrontAssetController();
  interface CapturedResponse {
    state: { headers: Record<string, string>; body: unknown; status: number };
    set: (key: string | Record<string, string>, value?: string) => CapturedResponse;
    status: (code: number) => CapturedResponse;
    send: (body: unknown) => CapturedResponse;
  }
  const capture = (): CapturedResponse => {
    const state: CapturedResponse['state'] = { headers: {}, body: null, status: 200 };
    const response: CapturedResponse = {
      state,
      set(key, value) {
        if (typeof key === 'string') state.headers[key] = value ?? '';
        else Object.assign(state.headers, key);
        return response;
      },
      status(code) { state.status = code; return response; },
      send(body) { state.body = body; return response; },
    };
    return response;
  };

  const js = capture();
  controller.serveJs(fake<Response>(js));
  assert.equal(js.state.status, 200);
  assert.equal(js.state.body, RUNTIME_SOURCE);
  assert.equal(js.state.headers['Cache-Control'], STOREFRONT_ASSET_CACHE_CONTROL);
  assert.equal(js.state.headers['X-Content-Type-Options'], 'nosniff');
  assert.match(js.state.headers['Content-Type'] ?? '', /^application\/javascript/);

  const css = capture();
  controller.serveCss(fake<Response>(css));
  assert.equal(css.state.status, 200);
  assert.equal(css.state.headers['Cache-Control'], STOREFRONT_ASSET_CACHE_CONTROL);
  assert.match(css.state.headers['Content-Type'] ?? '', /^text\/css/);
});
