const path = require("path");
const fs = require("fs");
const zlib = require("zlib");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const {
  startStatic,
  mockApi,
  waitUntil,
  trackPageErrors,
  assertNoHorizontalOverflow,
  artifactsDir,
  shot,
  writeJson,
  sleep,
  isPortFree,
} = require("./lib/harness.cjs");

const SUITE = "e2e-client-storefront-widget";
const PORT = 4302;
const STORE = "e2e-store.mysapo.net";
const PRODUCT = "1074668505";
const CLIENT_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(CLIENT_ROOT, "..");
const SNIPPETS = path.join(REPO_ROOT, "storefront", "snippets");
const RUNTIME_JS = path.join(SNIPPETS, "f1genz-storefront.js");
const RUNTIME_CSS = path.join(SNIPPETS, "f1genz-storefront.css");
const THEME_SNIPPET = path.join(SNIPPETS, "theme", "f1genz-sapo-widget.bwt");
const THEME_README = path.join(SNIPPETS, "theme", "README.md");
const THEME_SCHEMA = path.join(REPO_ROOT, "storefront", "theme", "f1genz-product-schema.bwt");
const SERVER_WIDGET_CONFIG = path.join(REPO_ROOT, "src", "review", "interfaces", "widget-config.interface.ts");
const FIXTURES = path.join(__dirname, "fixtures");
const ARTIFACTS = artifactsDir(__dirname, "storefront");
const BUDGET = { js: 30 * 1024, css: 8 * 1024 };

const NOW = Date.now();
const review = (id, over = {}) => ({
  id: String(id),
  author: `Khach ${id}`,
  rating: 5,
  title: "",
  content: `Noi dung danh gia ${id}`,
  verified: false,
  pinned: false,
  media: [],
  created_at: NOW - id * 3600_000,
  ...over,
});

const REVIEWS = [
  review(101, { author: "Pham Minh Duc", rating: 5, title: "Rat hai long", content: "Chat luong tuyet voi.", verified: true, reply: "Cam on ban da ung ho!" }),
  review(102, { author: "Hoang Lan", rating: 4, content: "Dung on dinh." }),
  review(103, { author: "Tran Binh", rating: 5, content: "Giao hang nhanh." }),
  review(104, { author: "Le Cuong", rating: 3, content: "Tam duoc." }),
  review(105, { author: "Vo Dung", rating: 2, content: "Hoi nho." }),
  review(106, { author: "Do Em", rating: 5, content: "Se mua lai." }),
  review(107, { author: "Ngo Phuc", rating: 1, content: "Khong hai long." }),
];
const QUESTIONS = [
  { id: "201", author: "Mai Anh", question: "Co giat may duoc khong?", answer: "Giat may che do nhe.", answered_by: "Shop", status: "approved", created_at: NOW - 7200_000 },
  { id: "202", author: "Bao Chau", question: "Con mau xanh khong?", answer: "", status: "approved", created_at: NOW - 3600_000 },
];

const summaryOf = (rows) => {
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  rows.forEach((r) => {
    distribution[r.rating] += 1;
  });
  const count = rows.length;
  const avg = count ? Math.round((rows.reduce((s, r) => s + r.rating, 0) / count) * 10) / 10 : 0;
  return { avg, count, distribution };
};

function pageOf(rows, search) {
  const params = new URLSearchParams(search);
  const page = Math.max(1, Number(params.get("page") || 1));
  const limit = Math.min(50, Math.max(1, Number(params.get("limit") || 20)));
  return { items: rows.slice((page - 1) * limit, page * limit), total: rows.length, page, pageSize: limit };
}

function publicApi(options = {}) {
  const calls = { configs: 0, reviewLists: [], qnaLists: [], posts: [], questionPosts: [], eligibility: [], summaries: [], tickets: [], uploads: [], sliderLists: [] };
  const reviews = options.reviews || REVIEWS;
  const questions = options.questions || QUESTIONS;
  const resolve = (pathname, method, payload, _state, record) => {
    if (pathname === "/api/public/reviews/config/widget") {
      calls.configs += 1;
      if (options.configStatus) return { status: options.configStatus, body: { message: "boom" } };
      return { status: 200, body: { data: options.config || {} } };
    }
    if (pathname === "/api/public/reviews/summaries") {
      calls.summaries.push(record.search);
      if (options.summaryStatus) return { status: options.summaryStatus, body: { message: "boom" } };
      const params = new URLSearchParams(record.search);
      const ids = String(params.get("productIds") || "").split(",").filter(Boolean);
      const body = {};
      ids.forEach((id) => {
        body[id] = options.summary || summaryOf(reviews);
      });
      return { status: 200, body: { data: body } };
    }
    let match = /^\/api\/public\/reviews\/([^/]+)\/summary$/.exec(pathname);
    if (match) {
      if (options.summaryStatus) return { status: options.summaryStatus, body: { message: "boom" } };
      return { status: 200, body: { data: options.summary || summaryOf(reviews) } };
    }
    match = /^\/api\/public\/reviews\/([^/]+)\/purchase-eligibility$/.exec(pathname);
    if (match) {
      calls.eligibility.push(payload);
      return { status: 200, body: { data: options.eligibility || { eligible: false, reason: "not_purchased" } } };
    }
    match = /^\/api\/public\/reviews\/([^/]+)\/slider$/.exec(pathname);
    if (match && method === "GET") {
      calls.sliderLists.push({ productId: match[1], search: record.search });
      if (options.sliderStatus) return { status: options.sliderStatus, body: { message: "boom" } };
      const items = (options.sliderItems || REVIEWS.slice(0, 6)).map((row) => ({
        id: row.id,
        r: row.rating,
        a: row.author,
        t: row.title || undefined,
        c: row.content,
        m: "https://cdn.example.com/review-slide.jpg",
        v: row.verified ? 1 : 0,
        d: row.created_at,
      }));
      return { status: 200, body: { data: { v: 1, updated_at: NOW, items } } };
    }
    match = /^\/api\/public\/reviews\/([^/]+)$/.exec(pathname);
    if (match && method === "GET") {
      calls.reviewLists.push({ productId: match[1], search: record.search, headers: record.headers });
      if (options.reviewsAbort) return { abort: "failed" };
      if (options.reviewsStatus) return { status: options.reviewsStatus, body: { message: "boom" } };
      return { status: 200, body: { data: pageOf(reviews, record.search) } };
    }
    if (match && method === "POST") {
      calls.posts.push({ productId: match[1], payload, headers: record.headers });
      if (options.postResult) return options.postResult;
      return { status: 201, body: { data: { id: "999", ...payload, status: "pending" } } };
    }
    match = /^\/api\/public\/qna\/([^/]+)$/.exec(pathname);
    if (match && method === "GET") {
      calls.qnaLists.push({ productId: match[1], search: record.search });
      return { status: 200, body: { data: pageOf(questions, record.search) } };
    }
    if (match && method === "POST") {
      calls.questionPosts.push({ productId: match[1], payload, headers: record.headers });
      if (options.questionResult) return options.questionResult;
      return { status: 201, body: { data: { id: "998", ...payload, status: "pending" } } };
    }
    if (pathname === "/api/public/media/ticket" && method === "POST") {
      calls.tickets.push(payload);
      return { status: 200, body: { data: { ticket: "ticket-1", expiresAt: NOW + 600_000 } } };
    }
    if (pathname === "/api/public/media/upload" && method === "POST") {
      calls.uploads.push({ search: record.search, headers: record.headers });
      return { status: 201, body: { data: { url: "https://cdn.example.com/review-1.png", type: "image" } } };
    }
    return undefined;
  };
  return { calls, resolve };
}

const text = (page, selector) =>
  page.evaluate((sel) => Array.from(document.querySelectorAll(sel)).map((n) => (n.textContent || "").trim()), selector);

async function main() {
  if (!(await isPortFree(PORT))) {
    throw new Error(`Port ${PORT} is already in use; stop the process that owns it, the suite never picks another port.`);
  }
  for (const file of [RUNTIME_JS, RUNTIME_CSS, THEME_SNIPPET]) {
    if (!fs.existsSync(file)) throw new Error(`Missing storefront asset ${file}`);
  }

  const server = await startStatic({
    root: FIXTURES,
    port: PORT,
    aliases: { "/f1genz-storefront.js": RUNTIME_JS, "/f1genz-storefront.css": RUNTIME_CSS },
  });
  const browser = await chromium.launch({ headless: true });
  const results = [];

  async function check(id, title, fn) {
    const started = Date.now();
    try {
      await fn();
      results.push({ id, title, status: "pass", ms: Date.now() - started });
      console.log(`  [PASS] ${id} ${title}`);
    } catch (error) {
      results.push({ id, title, status: "fail", ms: Date.now() - started, error: String(error && error.message ? error.message : error) });
      console.log(`  [FAIL] ${id} ${title}\n         ${String(error && error.message ? error.message : error).split("\n").join("\n         ")}`);
    }
  }

  async function open(api, { viewport, init, ready = ".f1genz-sapo-review-summary", query = "", requests, file = "index.html" } = {}) {
    const context = await browser.newContext({ viewport: viewport || { width: 1280, height: 900 } });
    if (requests) context.on("request", (request) => requests.push(new URL(request.url()).pathname));
    if (init) await context.addInitScript(init);
    await mockApi(context, { resolve: api.resolve });
    const page = await context.newPage();
    const tracked = trackPageErrors(page);
    await page.goto(`${server.baseUrl}/${file}${query}`, { waitUntil: "load" });
    if (ready) {
      try {
        await page.waitForSelector(ready, { timeout: 8000 });
      } catch (error) {
        await context.close();
        throw new Error(`fixture never rendered "${ready}": ${error.message}`);
      }
    }
    await sleep(150);
    return { context, page, tracked };
  }

  try {
    console.log("--- runtime budget ---");
    await check("B1", "runtime JS and CSS stay inside the gzip budget", async () => {
      const js = zlib.gzipSync(fs.readFileSync(RUNTIME_JS)).length;
      const css = zlib.gzipSync(fs.readFileSync(RUNTIME_CSS)).length;
      assert.ok(js <= BUDGET.js, `runtime JS gzip ${js}B > ${BUDGET.js}B`);
      assert.ok(css <= BUDGET.css, `runtime CSS gzip ${css}B > ${BUDGET.css}B`);
    });
    await check("B2", "runtime carries no watermark or AI remnants, and registers the curated slider element", async () => {
      const source = fs.readFileSync(RUNTIME_JS, "utf8");
      for (const needle of ["Powered by", "data-f1genzapp-highlights", "AI Highlights"]) {
        assert.ok(!source.includes(needle), `runtime still contains "${needle}"`);
      }
      assert.ok(source.includes("customElements.define('f1genz-curated-slider'"), "curated slider element is registered");
    });
    await check("B8", "primary buttons switch to dark text when the accent colour fails AA with white", async () => {
      const api = publicApi();
      const first = await open(api);
      try {
        const color = await first.page.$eval(".f1genz-sapo-review-btn--write", (node) => getComputedStyle(node).color);
        assert.equal(color, "rgb(26, 26, 26)", "default amber accent must render dark text, not white");
      } finally {
        await first.context.close();
      }
      const dark = publicApi({ config: { accentColor: "#0b5ed7" } });
      const second = await open(dark);
      try {
        const color = await second.page.$eval(".f1genz-sapo-review-btn--write", (node) => getComputedStyle(node).color);
        assert.equal(color, "rgb(255, 255, 255)", "a dark accent keeps white text");
      } finally {
        await second.context.close();
      }
    });

    await check("B6", "curated slider renders approved reviews as a scroll-snap rail with arrows and verified badges", async () => {
      const api = publicApi();
      const { context, page, tracked } = await open(api, {
        file: "slider.html",
        ready: ".f1genz-sapo-review-slider__item",
      });
      try {
        assert.equal(api.calls.sliderLists.length, 1);
        assert.match(api.calls.sliderLists[0].search, /limit=6|limit=15/);
        const cards = await page.$$eval(".f1genz-sapo-review-slider__item", (nodes) => nodes.length);
        assert.ok(cards >= 5 && cards <= 15, `rendered ${cards} cards`);
        const verified = await text(page, ".f1genz-sapo-review-slider__verified");
        assert.deepEqual(verified, ["Đã mua hàng"]);
        const hasMedia = await page.$$eval(".f1genz-sapo-review-slider__media", (nodes) => nodes.length);
        assert.equal(hasMedia, cards);
        const before = await page.$eval(".f1genz-sapo-review-slider__track", (node) => node.scrollLeft);
        await page.click('[data-slider-step="1"]');
        await sleep(400);
        const after = await page.$eval(".f1genz-sapo-review-slider__track", (node) => node.scrollLeft);
        assert.ok(after > before, `arrow scrolled the track (${before} -> ${after})`);
        await assertNoHorizontalOverflow(page, "slider");
        assert.deepEqual(tracked.errors, []);
      } finally {
        await context.close();
      }
    });

    await check("B7", "curated slider stays empty when the merchant turns it off or the API fails", async () => {
      const disabled = publicApi({ config: { curatedSliderEnabled: false } });
      const first = await open(disabled, { file: "slider.html", ready: null });
      try {
        await sleep(400);
        assert.equal(await first.page.$$eval(".f1genz-sapo-review-slider__item", (nodes) => nodes.length), 0);
        assert.equal(disabled.calls.sliderLists.length, 0, "no request when the merchant disabled the slider");
      } finally {
        await first.context.close();
      }
      const failing = publicApi({ sliderStatus: 500 });
      const second = await open(failing, { file: "slider.html", ready: null });
      try {
        await sleep(400);
        assert.equal(await second.page.$$eval(".f1genz-sapo-review-slider__item", (nodes) => nodes.length), 0);
        assert.deepEqual(second.tracked.errors, [], "a failing slider never throws into the page");
      } finally {
        await second.context.close();
      }
    });

    await check("B3", "theme snippets follow the .bwt dialect (include, only the escape filter, guarded scalar metafields)", async () => {
      const stripComments = (source) => source.replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, "");
      for (const file of [THEME_SNIPPET, THEME_SCHEMA]) {
        const name = path.basename(file);
        const source = fs.readFileSync(file, "utf8");
        const code = stripComments(source);
        assert.ok(!/\|\s*slice/.test(source), `${name}: slice filter is not supported by Sapo .bwt`);
        assert.ok(!/\{%\s*schema/.test(source), `${name}: {% schema %} does not exist on Sapo`);
        assert.ok(!/prefers-reduced-motion/.test(source), `${name}: no reduced-motion override`);
        assert.ok(!/json_parse/.test(source), `${name}: json_parse is not a Sapo filter`);
        for (const tag of code.match(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g) || []) {
          for (const filter of tag.matchAll(/\|\s*([A-Za-z_]+)/g)) {
            assert.equal(filter[1], "escape", `${name}: filter "${filter[1]}" in ${tag.replace(/\s+/g, " ")}`);
          }
        }
        const outputs = Array.from(code.matchAll(/\{\{[^}]*(?:metafields|f1g_)[^}]*\}\}/g));
        for (const output of outputs) {
          const before = code.slice(0, output.index);
          const opened = (before.match(/\{%-?\s*if\s/g) || []).length;
          const closed = (before.match(/\{%-?\s*endif\s*-?%\}/g) || []).length;
          assert.ok(opened > closed, `${name}: ${output[0]} is printed outside an if guard`);
        }
      }
      const widget = fs.readFileSync(THEME_SNIPPET, "utf8");
      assert.ok(widget.includes("f1genz-reviews"), "snippet must mount <f1genz-reviews>");
      assert.ok(/apiUrl:\s*"https:\/\/API_HOST"/.test(widget) && /storeDomain:\s*"STORE_DOMAIN"/.test(widget), "loader sets apiUrl and storeDomain placeholders");
      assert.ok(widget.includes("https://API_HOST/storefront/f1genz-storefront.css") && widget.includes("https://API_HOST/storefront/f1genz-storefront.js"), "loader loads CSS and JS from the API host");
      assert.ok(/f1genz_reviews\.rating_count/.test(widget) && /f1genz_reviews\.rating_avg/.test(widget), "SSR badge reads the scalar rating metafields");
      const readme = fs.readFileSync(THEME_README, "utf8");
      for (const needle of ["API_HOST", "STORE_DOMAIN", "customer-email", "customer-phone", "f1genz_reviews", "rating_count", "rating_avg", "api_url", "store_domain"]) {
        assert.ok(readme.includes(needle), `theme README does not mention ${needle}`);
      }
    });
    await check("B4", "runtime DEFAULT_CONFIG equals the server DEFAULT_WIDGET_CONFIG", async () => {
      const source = fs.readFileSync(SERVER_WIDGET_CONFIG, "utf8");
      const block = /DEFAULT_WIDGET_CONFIG\s*:\s*WidgetConfig\s*=\s*\{([\s\S]*?)\}\s*;/.exec(source);
      assert.ok(block, "DEFAULT_WIDGET_CONFIG not found in the server interface file");
      const server = {};
      const lines = block[1].split("\n").map((line) => line.trim()).filter(Boolean);
      for (const line of lines) {
        const match = /^(\w+)\s*:\s*(?:'([^']*)'|"([^"]*)"|(true|false|-?\d+(?:\.\d+)?))\s*,?$/.exec(line);
        assert.ok(match, `unparseable server default line: ${line}`);
        server[match[1]] = match[2] !== undefined ? match[2] : match[3] !== undefined ? match[3] : JSON.parse(match[4]);
      }
      const api = publicApi();
      const { context, page } = await open(api);
      try {
        const runtime = await page.evaluate(() => window.F1GENZStorefront.internals.defaultConfig);
        assert.deepEqual(Object.keys(runtime).sort(), Object.keys(server).sort(), "key sets differ");
        assert.deepEqual(runtime, server, "values differ");
      } finally {
        await context.close();
      }
    });
    await check("B5", "runtime carries no hardcoded API host, Shopify-isms or dead display settings", async () => {
      const source = fs.readFileSync(RUNTIME_JS, "utf8");
      for (const needle of ["LEGACY_FALLBACK_API_URL", "api-sapo-reviews", "f1genz.dev", "window.__st", "extractProductHandle", "/products/", "emailDisplay", "phoneDisplay", "window.customer"]) {
        assert.ok(!source.includes(needle), `runtime still contains "${needle}"`);
      }
      assert.ok(!/fetch\([^)]*account/i.test(source), "runtime must not fetch the account page");
    });

    console.log("\n--- reviews list ---");
    await check("R1", "summary, title, cards, verified badge and shop reply render from the API", async () => {
      const api = publicApi();
      const { context, page, tracked } = await open(api);
      try {
        await shot(page, ARTIFACTS, "r1-reviews");
        const state = await page.evaluate(() => ({
          title: document.querySelector(".f1genz-sapo-review-title")?.textContent || "",
          avg: document.querySelector(".f1genz-sapo-review-summary__avg")?.textContent || "",
          count: document.querySelector(".f1genz-sapo-review-summary__count")?.textContent || "",
          cards: document.querySelectorAll(".f1genz-sapo-review-card").length,
          authors: Array.from(document.querySelectorAll(".f1genz-sapo-review-card__author")).map((n) => n.textContent),
          verified: document.querySelectorAll(".f1genz-sapo-review-card__verified").length,
          reply: document.querySelector(".f1genz-sapo-review-card__reply-content")?.textContent || "",
          replyBadge: document.querySelector(".f1genz-sapo-review-card__reply-badge")?.textContent || "",
          bodyText: document.body.innerText,
        }));
        assert.match(state.title, /\(7\)/, "title shows the review count");
        assert.equal(state.avg, "3.6");
        assert.equal(state.count, "7 đánh giá");
        assert.equal(state.cards, 5, "first page holds reviewItemsPerPage cards");
        assert.equal(state.authors[0], "Pham Minh Duc");
        assert.equal(state.verified, 1, "only the verified review carries the badge");
        assert.equal(state.reply, "Cam on ban da ung ho!");
        assert.ok(state.replyBadge.length > 0);
        assert.ok(!state.bodyText.includes("Powered by"), "no watermark on any store");
        assert.deepEqual(tracked.errors, [], "no uncaught page errors");
      } finally {
        await context.close();
      }
    });
    await check("R2", "every GET names the store and page size stays <= 50", async () => {
      const api = publicApi();
      const { context } = await open(api);
      try {
        assert.ok(api.calls.reviewLists.length >= 1, "review list was requested");
        for (const call of api.calls.reviewLists) {
          const params = new URLSearchParams(call.search);
          assert.equal(params.get("storeDomain"), STORE);
          assert.ok(Number(params.get("limit")) <= 50, `limit ${params.get("limit")} exceeds the server cap`);
          assert.equal(call.productId, PRODUCT);
        }
        assert.equal(api.calls.configs, 1, "widget config is fetched once and shared by every element");
      } finally {
        await context.close();
      }
    });
    await check("R3", "a 120-review catalogue is fetched across pages and reported with the server summary", async () => {
      const many = Array.from({ length: 120 }, (_, i) => review(1000 + i, { rating: (i % 5) + 1 }));
      const api = publicApi({ reviews: many });
      const { context, page } = await open(api);
      try {
        const pages = api.calls.reviewLists.map((c) => Number(new URLSearchParams(c.search).get("page")));
        assert.deepEqual(pages.slice(0, 3), [1, 2, 3], `pages requested: ${pages.join(",")}`);
        assert.equal((await text(page, ".f1genz-sapo-review-summary__count"))[0], "120 đánh giá");
        assert.equal((await text(page, ".f1genz-sapo-review-card")).length, 5);
      } finally {
        await context.close();
      }
    });
    await check("R4", "pagination, star filter and sort change what is shown", async () => {
      const api = publicApi();
      const { context, page } = await open(api);
      try {
        await page.click('[data-action="page-next"]');
        assert.equal((await text(page, ".f1genz-sapo-review-card")).length, 2, "second page holds the remaining reviews");
        await page.click('[data-action="page-prev"]');
        await page.click('.f1genz-sapo-review-pill[data-filter-star="5"]');
        const fives = await page.evaluate(() => Array.from(document.querySelectorAll(".f1genz-sapo-review-card__author")).map((n) => n.textContent));
        assert.deepEqual(fives.sort(), ["Do Em", "Pham Minh Duc", "Tran Binh"].sort(), "only 5-star reviews remain");
        await page.click('.f1genz-sapo-review-pill[data-filter-star="0"]');
        await page.selectOption('[data-action="sort"]', "oldest");
        const first = await page.evaluate(() => document.querySelector(".f1genz-sapo-review-card__author")?.textContent);
        assert.equal(first, "Ngo Phuc", "oldest first");
      } finally {
        await context.close();
      }
    });
    await check("R5", "empty catalogue shows the empty state and no rating schema", async () => {
      const api = publicApi({ reviews: [] });
      const { context, page, tracked } = await open(api);
      try {
        const placeholders = await text(page, ".f1genz-sapo-review-placeholder");
        assert.ok(placeholders.some((t) => t.includes("Không có đánh giá")), `placeholders: ${placeholders.join("|")}`);
        const ld = await page.evaluate(() => Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map((n) => n.textContent));
        assert.ok(ld.every((raw) => !raw.includes("aggregateRating")), "no aggregateRating without approved reviews");
        assert.deepEqual(tracked.errors, []);
      } finally {
        await context.close();
      }
    });

    console.log("\n--- safety ---");
    await check("X1", "review text is escaped and shop links are the only anchors (https, noopener)", async () => {
      const hostile = [
        review(301, {
          author: "<b id=\"pwn-author\">x</b>",
          content: "<img src=x onerror=\"window.__xss=1\"> </script><script>window.__xss=2</script>",
          reply: "Xem [huong dan](https://example.com/guide) va [bad](javascript:alert(1)) va <i id=\"pwn-reply\">z</i>",
        }),
      ];
      const api = publicApi({ reviews: hostile });
      const { context, page } = await open(api);
      try {
        const state = await page.evaluate(() => ({
          xss: window.__xss,
          injected: !!document.querySelector("#pwn-author, #pwn-reply, .f1genz-sapo-review-card img[src='x']"),
          content: document.querySelector(".f1genz-sapo-review-card__content")?.textContent || "",
          anchors: Array.from(document.querySelectorAll(".f1genz-sapo-review-card__reply-content a")).map((a) => ({
            href: a.getAttribute("href"),
            rel: a.getAttribute("rel"),
            target: a.getAttribute("target"),
          })),
          jsAnchors: document.querySelectorAll('a[href^="javascript"]').length,
        }));
        assert.equal(state.xss, undefined, "no script from review text ever ran");
        assert.equal(state.injected, false, "no markup from review text was injected");
        assert.ok(state.content.includes("<img src=x"), "hostile content is shown as literal text");
        assert.equal(state.anchors.length, 1, "only the https link becomes an anchor");
        assert.equal(state.anchors[0].href, "https://example.com/guide");
        assert.match(state.anchors[0].rel, /noopener/);
        assert.match(state.anchors[0].rel, /nofollow/);
        assert.equal(state.jsAnchors, 0);
      } finally {
        await context.close();
      }
    });
    await check("X2", "contact data is never rendered, whatever the legacy display keys say", async () => {
      const withContact = [review(401, { author: "An Binh", email: "private.buyer@example.com", phone: "0987654321" })];
      const variants = [
        publicApi({ reviews: withContact, config: {} }),
        publicApi({ reviews: withContact, config: { emailDisplay: "show", phoneDisplay: "show" } }),
        publicApi({ reviews: withContact, config: { emailDisplay: "mask", phoneDisplay: "mask" } }),
      ];
      for (const api of variants) {
        const { context, page } = await open(api);
        try {
          const body = await page.evaluate(() => document.body.innerText);
          assert.ok(!body.includes("private.buyer@example.com"), "raw email visible");
          assert.ok(!body.includes("0987654321"), "raw phone visible");
          assert.ok(!body.includes("***@example.com"), "masked email visible");
          assert.ok(!/098\*\*\*21/.test(body), "masked phone visible");
        } finally {
          await context.close();
        }
      }
    });
    await check("X3", "review media links are nofollow ugc noopener and embeds only point at YouTube or Vimeo", async () => {
      const media = [
        review(411, { author: "Link Video", media: [{ url: "https://example.com/clip.mov", type: "video" }] }),
        review(412, { author: "Embed Video", media: [{ url: "https://youtu.be/abc123", type: "video" }] }),
      ];
      const api = publicApi({ reviews: media });
      const { context, page } = await open(api);
      try {
        await context.route("https://www.youtube.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "" }));
        const items = '.f1genz-sapo-review-card__media-item[data-action="open-media"]';
        await page.waitForSelector(items);
        await page.locator(items).nth(0).click();
        await page.waitForSelector(".f1genz-sapo-review-lightbox");
        const link = await page.evaluate(() => {
          const node = document.querySelector(".f1genz-sapo-review-lightbox a.f1genz-sapo-review-btn");
          return node ? { href: node.getAttribute("href"), rel: node.getAttribute("rel"), target: node.getAttribute("target") } : null;
        });
        assert.ok(link, "non-embeddable video renders as a link");
        assert.equal(link.href, "https://example.com/clip.mov");
        assert.equal(link.target, "_blank");
        for (const token of ["nofollow", "ugc", "noopener"]) assert.ok(link.rel.split(/\s+/).includes(token), `rel lacks ${token}: ${link.rel}`);
        await page.keyboard.press("Escape");
        await page.locator(items).nth(1).click();
        await page.waitForSelector(".f1genz-sapo-review-lightbox iframe");
        const src = await page.evaluate(() => document.querySelector(".f1genz-sapo-review-lightbox iframe").getAttribute("src"));
        assert.equal(src, "https://www.youtube.com/embed/abc123");
      } finally {
        await context.close();
      }
    });
    await check("N1", "without an API URL the runtime logs one console.error and sends no requests", async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const seen = [];
      context.on("request", (request) => seen.push(new URL(request.url()).pathname));
      const page = await context.newPage();
      const tracked = trackPageErrors(page);
      try {
        await page.goto(`${server.baseUrl}/no-api.html`, { waitUntil: "load" });
        await page.addScriptTag({ content: fs.readFileSync(RUNTIME_JS, "utf8") });
        await sleep(600);
        const own = tracked.consoleErrors.filter((message) => message.includes("[f1genz-storefront]"));
        assert.equal(own.length, 1, `console.error calls: ${own.length}`);
        assert.match(own[0], /No API URL/);
        assert.doesNotMatch(own[0], /metafields\.f1genz\.config\.value\.apiUrl/, "the warning must not point at a metafield path .bwt cannot read");
        assert.deepEqual(seen.filter((p) => p !== "/no-api.html"), [], "no request of any kind leaves the page");
        assert.deepEqual(tracked.errors, []);
      } finally {
        await context.close();
      }
    });
    await check("N2", "the runtime never requests /account or /products/ and never reads the account page", async () => {
      const requests = [];
      const api = publicApi();
      const { context } = await open(api, { requests, query: "?email=member%40example.com" });
      try {
        await sleep(400);
        assert.ok(requests.length > 0, "requests were recorded");
        const offenders = requests.filter((p) => p.startsWith("/account") || p.startsWith("/products/"));
        assert.deepEqual(offenders, []);
      } finally {
        await context.close();
      }
    });

    console.log("\n--- structured data and badge ---");
    await check("L1", "JSON-LD Product carries offer, aggregateRating and reviews, and stays valid with hostile text", async () => {
      const rows = [
        review(501, { author: "Ha", rating: 5, content: "</script><b>boom</b> tot" }),
        review(502, { author: "Hai", rating: 4, content: "On", email: "leak@example.com", phone: "0911222333" }),
      ];
      const api = publicApi({ reviews: rows });
      const { context, page } = await open(api, { ready: null });
      try {
        await page.waitForSelector("#schema script[type='application/ld+json']", { state: "attached", timeout: 8000 });
        const raw = await page.evaluate(() => document.querySelector("#schema script[type='application/ld+json']")?.textContent || "");
        assert.ok(raw, "schema script was rendered");
        const ld = JSON.parse(raw);
        assert.equal(ld["@type"], "Product");
        assert.equal(ld.name, "Ao thun E2E");
        assert.equal(ld.sku, "E2E-001");
        assert.equal(ld.brand.name, "E2E Brand");
        assert.equal(ld.offers.price, "199000");
        assert.equal(ld.offers.priceCurrency, "VND");
        assert.equal(ld.aggregateRating.reviewCount, 2);
        assert.equal(ld.aggregateRating.ratingValue, 4.5);
        assert.equal(ld.review.length, 2);
        assert.ok(!raw.includes("leak@example.com") && !raw.includes("0911222333"), "schema never carries contact data");
        const injected = await page.evaluate(() => !!document.querySelector("#schema b"));
        assert.equal(injected, false, "review text cannot break out of the script element");
        assert.match(ld.offers.url, /^https?:\/\//, "offer url is absolute");
      } finally {
        await context.close();
      }
    });
    await check("L2", "rating badge shows the server summary and its accessible name", async () => {
      const api = publicApi();
      const { context, page } = await open(api);
      try {
        const state = await page.evaluate(() => {
          const badge = document.querySelector("f1genz-rating-badge");
          const img = badge?.querySelector('[role="img"]');
          return { label: img?.getAttribute("aria-label") || "", text: badge?.textContent || "" };
        });
        assert.match(state.label, /3\.6/, `aria-label: ${state.label}`);
        assert.match(state.text, /7/, "review count visible");
      } finally {
        await context.close();
      }
    });

    console.log("\n--- failure modes ---");
    await check("F1", "reviews 500, aborted request and config 500 never throw on the storefront", async () => {
      for (const options of [{ reviewsStatus: 500 }, { reviewsAbort: true }, { configStatus: 500 }, { summaryStatus: 500 }]) {
        const api = publicApi(options);
        const { context, page, tracked } = await open(api, { ready: null });
        try {
          await sleep(900);
          assert.deepEqual(tracked.errors, [], `${JSON.stringify(options)} threw: ${tracked.errors.join("; ")}`);
          const alive = await page.evaluate(() => document.getElementById("page-end")?.textContent);
          assert.equal(alive, "end", "page content intact");
          if (options.configStatus || options.summaryStatus) {
            const cards = (await text(page, ".f1genz-sapo-review-card")).length;
            assert.ok(cards > 0, `${JSON.stringify(options)} must still render the reviews`);
          }
        } finally {
          await context.close();
        }
      }
    });

    console.log("\n--- write review ---");
    await check("W1", "form validates rating, name and email before any request", async () => {
      const api = publicApi();
      const { context, page } = await open(api);
      try {
        await page.click('[data-action="open-form"].f1genz-sapo-review-btn--write');
        await page.waitForSelector('[data-action="submit-form"]');
        const submit = async () => {
          await page.click('[data-action="submit-form"]');
          return (await text(page, '.f1genz-sapo-review-alert[role="alert"]'))[0] || "";
        };
        assert.match(await submit(), /số sao/);
        await page.click('[data-action="set-rating"][data-rating="5"]');
        assert.match(await submit(), /Họ Tên/);
        await page.fill("#f1genz-sapo-review-input-author", "A");
        assert.match(await submit(), /ít nhất 2/);
        await page.fill("#f1genz-sapo-review-input-author", "Tran Thi B");
        await page.fill("#f1genz-sapo-review-input-email", "not-an-email");
        assert.match(await submit(), /Email/);
        await page.fill("#f1genz-sapo-review-input-email", "");
        await page.fill("#f1genz-sapo-review-input-video-url", "http://insecure.example.com/v");
        assert.match(await submit(), /HTTPS/);
        assert.equal(api.calls.posts.length, 0, "an invalid form sends nothing");
      } finally {
        await context.close();
      }
    });
    await check("W1b", "a non-YouTube/Vimeo https video link is rejected before any request, a YouTube link is sent as media", async () => {
      const api = publicApi();
      const { context, page } = await open(api);
      try {
        await page.click('[data-action="open-form"].f1genz-sapo-review-btn--write');
        await page.waitForSelector('[data-action="submit-form"]');
        await page.click('[data-action="set-rating"][data-rating="5"]');
        await page.fill("#f1genz-sapo-review-input-author", "Tran Thi B");
        await page.fill("#f1genz-sapo-review-input-video-url", "https://example.com/clip.mp4");
        await page.click('[data-action="submit-form"]');
        await page.waitForSelector('.f1genz-sapo-review-alert[role="alert"]');
        assert.match((await text(page, '.f1genz-sapo-review-alert[role="alert"]'))[0], /YouTube hoặc Vimeo/);
        await sleep(300);
        assert.equal(api.calls.posts.length, 0, "a rejected video link must not POST");
        assert.equal(api.calls.tickets.length + api.calls.uploads.length, 0, "a rejected video link must not upload");
        await page.fill("#f1genz-sapo-review-input-video-url", "https://youtu.be/dQw4w9WgXcQ");
        await page.click('[data-action="submit-form"]');
        await waitUntil(() => api.calls.posts.length >= 1);
        assert.deepEqual(api.calls.posts[0].payload.media, [{ url: "https://youtu.be/dQw4w9WgXcQ", type: "video" }]);
      } finally {
        await context.close();
      }
    });
    await check("W2", "a valid review is POSTed once with exactly the typed fields and the store header", async () => {
      const api = publicApi();
      const { context, page, tracked } = await open(api);
      try {
        await page.click('[data-action="open-form"].f1genz-sapo-review-btn--write');
        await page.waitForSelector('[data-action="submit-form"]');
        await page.click('[data-action="set-rating"][data-rating="4"]');
        await page.fill("#f1genz-sapo-review-input-author", "Tran Thi B");
        await page.fill("#f1genz-sapo-review-input-content", "San pham dung nhu mo ta.");
        await page.fill("#f1genz-sapo-review-input-email", "b@example.com");
        await page.evaluate(() => {
          const button = document.querySelector('[data-action="submit-form"]');
          button.click();
          button.click();
        });
        await waitUntil(() => api.calls.posts.length >= 1);
        await sleep(300);
        assert.equal(api.calls.posts.length, 1, "double submit sent more than one request");
        const post = api.calls.posts[0];
        assert.deepEqual(post.payload, { rating: 4, author: "Tran Thi B", content: "San pham dung nhu mo ta.", email: "b@example.com" });
        assert.equal(post.headers["x-store-domain"], STORE);
        assert.ok(!post.headers.authorization, "storefront never sends a bearer token");
        const status = (await text(page, '[role="status"]')).join(" ");
        assert.match(status, /chờ duyệt/, `success notice: ${status}`);
        assert.deepEqual(tracked.errors, []);
      } finally {
        await context.close();
      }
    });
    await check("W3", "a rate-limited submission shows the throttle notice and keeps the draft", async () => {
      const api = publicApi({ postResult: { status: 429, body: { message: "Rate limit exceeded" } } });
      const { context, page } = await open(api);
      try {
        await page.click('[data-action="open-form"].f1genz-sapo-review-btn--write');
        await page.waitForSelector('[data-action="submit-form"]');
        await page.click('[data-action="set-rating"][data-rating="5"]');
        await page.fill("#f1genz-sapo-review-input-author", "Le Van C");
        await page.fill("#f1genz-sapo-review-input-content", "Noi dung giu lai");
        await page.click('[data-action="submit-form"]');
        await page.waitForSelector('.f1genz-sapo-review-alert[role="alert"]');
        assert.match((await text(page, '.f1genz-sapo-review-alert[role="alert"]'))[0], /quá nhanh/);
        assert.equal(await page.inputValue("#f1genz-sapo-review-input-content"), "Noi dung giu lai", "draft survived the failure");
        assert.equal(await page.isEnabled('[data-action="submit-form"]'), true, "form can be retried");
      } finally {
        await context.close();
      }
    });
    await check("W4", "requireLogin swaps the write button for the account login link until a customer exists", async () => {
      const api = publicApi({ config: { requireLogin: true } });
      const anonymous = await open(api);
      try {
        const link = await anonymous.page.evaluate(() => {
          const node = document.querySelector("a.f1genz-sapo-review-btn--login");
          return node ? { href: node.getAttribute("href"), writeButtons: document.querySelectorAll('button[data-action="open-form"].f1genz-sapo-review-btn--write').length } : null;
        });
        assert.ok(link, "login link rendered");
        assert.equal(link.href, "/account");
        assert.equal(link.writeButtons, 0);
      } finally {
        await anonymous.context.close();
      }
      const signedIn = await open(publicApi({ config: { requireLogin: true } }), { query: "?email=member%40example.com" });
      try {
        assert.equal(await signedIn.page.locator('button[data-action="open-form"].f1genz-sapo-review-btn--write').count(), 1);
      } finally {
        await signedIn.context.close();
      }
    });
    await check("W5", "requirePurchaseToReview verifies the buyer from the customer attributes and blocks everyone else", async () => {
      const blocked = publicApi({ config: { requirePurchaseToReview: true }, eligibility: { eligible: false, reason: "not_purchased" } });
      const stranger = await open(blocked, { query: "?email=stranger%40example.com" });
      try {
        await waitUntil(() => blocked.calls.eligibility.length > 0);
        await sleep(200);
        assert.deepEqual(blocked.calls.eligibility[0], { email: "stranger@example.com", phone: "" });
        assert.equal(await stranger.page.locator('button[data-action="open-form"].f1genz-sapo-review-btn--write').count(), 0);
        assert.match((await text(stranger.page, ".f1genz-sapo-review-purchase-note")).join(" "), /đã mua/);
      } finally {
        await stranger.context.close();
      }
      const allowedApi = publicApi({ config: { requirePurchaseToReview: true }, eligibility: { eligible: true, reason: "verified" } });
      const buyer = await open(allowedApi, { query: "?email=buyer%40example.com" });
      try {
        await waitUntil(() => buyer.page.locator('button[data-action="open-form"].f1genz-sapo-review-btn--write').count().then((n) => n === 1));
        assert.equal(await buyer.page.locator('button[data-action="open-form"].f1genz-sapo-review-btn--write').count(), 1);
      } finally {
        await buyer.context.close();
      }
      const globalOnly = publicApi({ config: { requirePurchaseToReview: true } });
      const ignored = await open(globalOnly, {
        init: () => {
          window.customer = { email: "global@example.com" };
          window.__st = { customer: { email: "st@example.com" } };
        },
      });
      try {
        await sleep(300);
        assert.equal(globalOnly.calls.eligibility.length, 0, "window.customer and window.__st are never read as identity");
      } finally {
        await ignored.context.close();
      }
    });
    await check("W6", "server gate codes and HTTP 429 map to clear messages, never the raw server text", async () => {
      const reviewCases = [
        ["identity_required", 400, /Email hoặc Số điện thoại/],
        ["purchase_required", 403, /đã mua sản phẩm/],
        ["store_not_serving", 409, /chưa nhận nội dung/],
        ["product_not_found", 404, /Không tìm thấy sản phẩm/],
        ["media_type_not_allowed", 400, /loại tệp/],
      ];
      for (const [code, status, expected] of reviewCases) {
        const api = publicApi({ postResult: { status, body: { code, message: "raw server text" } } });
        const { context, page } = await open(api);
        try {
          await page.click('[data-action="open-form"].f1genz-sapo-review-btn--write');
          await page.waitForSelector('[data-action="submit-form"]');
          await page.click('[data-action="set-rating"][data-rating="5"]');
          await page.fill("#f1genz-sapo-review-input-author", "Le Van C");
          await page.click('[data-action="submit-form"]');
          await page.waitForSelector('.f1genz-sapo-review-alert[role="alert"]');
          const alert = (await text(page, '.f1genz-sapo-review-alert[role="alert"]'))[0];
          assert.match(alert, expected, `${code}: ${alert}`);
          assert.ok(!alert.includes("raw server text"), `${code} must not show the raw server text`);
        } finally {
          await context.close();
        }
      }
      const qna = publicApi({ config: { reviewQnaDisplayMode: "stacked" }, questionResult: { status: 403, body: { code: "qna_disabled", message: "raw server text" } } });
      const { context, page } = await open(qna, { ready: ".f1genz-sapo-review-qna-card" });
      try {
        await page.click(".f1genz-sapo-review-btn--ask");
        await page.waitForSelector("#f1genz-sapo-review-input-question");
        await page.fill("#f1genz-sapo-review-input-author", "Khanh");
        await page.fill("#f1genz-sapo-review-input-question", "San pham co bao hanh khong?");
        await page.click('[data-action="submit-form"]');
        await page.waitForSelector('.f1genz-sapo-review-alert[role="alert"]');
        const alert = (await text(page, '.f1genz-sapo-review-alert[role="alert"]'))[0];
        assert.match(alert, /tắt chức năng hỏi đáp/);
        assert.ok(!alert.includes("raw server text"));
      } finally {
        await context.close();
      }
    });
    await check("W7", "the purchase identity from the element attributes is sent even when Email and Phone fields are hidden", async () => {
      const api = publicApi({
        config: { requirePurchaseToReview: true, formEmailMode: "hidden", formPhoneMode: "hidden" },
        eligibility: { eligible: true, reason: "verified" },
      });
      const { context, page } = await open(api, { query: "?email=buyer%40example.com&phone=0987654321" });
      try {
        await waitUntil(() => page.locator('button[data-action="open-form"].f1genz-sapo-review-btn--write').count().then((n) => n === 1));
        await page.click('[data-action="open-form"].f1genz-sapo-review-btn--write');
        await page.waitForSelector('[data-action="submit-form"]');
        assert.equal(await page.locator("#f1genz-sapo-review-input-email").count(), 0, "hidden Email field is not rendered");
        assert.equal(await page.locator("#f1genz-sapo-review-input-phone").count(), 0, "hidden Phone field is not rendered");
        await page.click('[data-action="set-rating"][data-rating="5"]');
        await page.fill("#f1genz-sapo-review-input-author", "Tran Thi B");
        await page.click('[data-action="submit-form"]');
        await waitUntil(() => api.calls.posts.length >= 1);
        const payload = api.calls.posts[0].payload;
        assert.equal(payload.email, "buyer@example.com");
        assert.equal(payload.phone, "0987654321");
        assert.ok(!("verified" in payload), "the widget never sends a verified flag");
      } finally {
        await context.close();
      }
    });
    await check("W8", "the upload ticket request carries no filename and the review gets the uploaded media", async () => {
      const api = publicApi();
      const { context, page } = await open(api);
      try {
        await page.click('[data-action="open-form"].f1genz-sapo-review-btn--write');
        await page.waitForSelector('[data-action="submit-form"]');
        await page.click('[data-action="set-rating"][data-rating="4"]');
        await page.fill("#f1genz-sapo-review-input-author", "Tran Thi B");
        const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
        await page.setInputFiles("#f1genz-sapo-review-input-media", { name: "anh dep.png", mimeType: "image/png", buffer: png });
        await page.waitForSelector(".f1genz-sapo-review-file-thumb");
        await page.click('[data-action="submit-form"]');
        await waitUntil(() => api.calls.posts.length >= 1);
        assert.equal(api.calls.tickets.length, 1);
        assert.deepEqual(Object.keys(api.calls.tickets[0]).sort(), ["contentType", "fileSize", "productId"]);
        assert.equal(api.calls.tickets[0].contentType, "image/png");
        assert.equal(api.calls.tickets[0].productId, PRODUCT);
        assert.equal(api.calls.uploads.length, 1);
        assert.match(api.calls.uploads[0].search, /ticket=ticket-1/);
        assert.deepEqual(api.calls.posts[0].payload.media, [{ url: "https://cdn.example.com/review-1.png", type: "image" }]);
      } finally {
        await context.close();
      }
    });

    console.log("\n--- Q&A ---");
    await check("Q1", "stacked mode renders questions, the shop answer and the pending state", async () => {
      const api = publicApi({ config: { reviewQnaDisplayMode: "stacked" } });
      const { context, page } = await open(api, { ready: ".f1genz-sapo-review-qna-card" });
      try {
        const state = await page.evaluate(() => ({
          header: document.querySelector(".f1genz-sapo-review-qna-header h3")?.textContent || "",
          questions: Array.from(document.querySelectorAll(".f1genz-sapo-review-qna-card__question")).map((n) => n.textContent),
          answers: Array.from(document.querySelectorAll(".f1genz-sapo-review-qna-card__answer-text")).map((n) => n.textContent),
          pending: document.querySelectorAll(".f1genz-sapo-review-qna-card__pending").length,
        }));
        assert.match(state.header, /\(2\)/);
        assert.deepEqual(state.questions, ["Co giat may duoc khong?", "Con mau xanh khong?"]);
        assert.deepEqual(state.answers, ["Giat may che do nhe."]);
        assert.equal(state.pending, 1);
        assert.equal(api.calls.qnaLists.length >= 1, true);
        for (const call of api.calls.qnaLists) {
          const params = new URLSearchParams(call.search);
          assert.equal(params.get("storeDomain"), STORE);
          assert.ok(Number(params.get("limit")) <= 50);
        }
      } finally {
        await context.close();
      }
    });
    await check("Q2", "asking a question validates, then POSTs author and question once", async () => {
      const api = publicApi({ config: { reviewQnaDisplayMode: "stacked" } });
      const { context, page } = await open(api, { ready: ".f1genz-sapo-review-qna-card" });
      try {
        await page.click(".f1genz-sapo-review-btn--ask");
        await page.waitForSelector("#f1genz-sapo-review-input-question");
        await page.click('[data-action="submit-form"]');
        assert.match((await text(page, '.f1genz-sapo-review-alert[role="alert"]'))[0], /Họ Tên/);
        await page.fill("#f1genz-sapo-review-input-author", "Khanh");
        await page.fill("#f1genz-sapo-review-input-question", "abc");
        await page.click('[data-action="submit-form"]');
        assert.match((await text(page, '.f1genz-sapo-review-alert[role="alert"]'))[0], /ít nhất 5/);
        await page.fill("#f1genz-sapo-review-input-question", "San pham co bao hanh khong?");
        await page.click('[data-action="submit-form"]');
        await waitUntil(() => api.calls.questionPosts.length >= 1);
        await sleep(200);
        assert.equal(api.calls.questionPosts.length, 1);
        assert.deepEqual(api.calls.questionPosts[0].payload, { author: "Khanh", question: "San pham co bao hanh khong?" });
        assert.equal(api.calls.questionPosts[0].headers["x-store-domain"], STORE);
        assert.match((await text(page, '[role="status"]')).join(" "), /Câu hỏi đã được gửi/);
      } finally {
        await context.close();
      }
    });
    await check("Q3", "tabs mode loads Q&A lazily and keeps one panel visible", async () => {
      const api = publicApi({ config: { reviewQnaDisplayMode: "tabs" } });
      const { context, page } = await open(api);
      try {
        assert.equal(api.calls.qnaLists.length, 0, "Q&A is not requested before its tab opens");
        assert.equal(await page.locator('[role="tab"]').count(), 2);
        await page.click('[data-f1genzapp-section-tab="qna"]');
        await page.waitForSelector(".f1genz-sapo-review-qna-card");
        const state = await page.evaluate(() => ({
          reviewsHidden: document.querySelector('[data-f1genzapp-section-panel="reviews"]').hidden,
          qnaHidden: document.querySelector('[data-f1genzapp-section-panel="qna"]').hidden,
          selected: Array.from(document.querySelectorAll('[role="tab"]')).map((tab) => tab.getAttribute("aria-selected")),
        }));
        assert.deepEqual(state, { reviewsHidden: true, qnaHidden: false, selected: ["false", "true"] });
        assert.ok(api.calls.qnaLists.length >= 1);
      } finally {
        await context.close();
      }
    });

    console.log("\n--- layout ---");
    await check("M1", "390px viewport has no horizontal overflow, even with long unbroken text", async () => {
      const long = "A".repeat(180);
      const api = publicApi({ reviews: [review(601, { author: long.slice(0, 60), content: long, reply: `https://example.com/${"p".repeat(140)}` }), ...REVIEWS] });
      const { context, page, tracked } = await open(api, { viewport: { width: 390, height: 844 } });
      try {
        await assertNoHorizontalOverflow(page, "storefront widget 390px");
        await shot(page, ARTIFACTS, "m1-mobile");
        assert.deepEqual(tracked.errors, []);
      } finally {
        await context.close();
      }
    });
    await check("M2", "re-attaching an element does not duplicate its content or refetch the list", async () => {
      const api = publicApi();
      const { context, page } = await open(api);
      try {
        const before = api.calls.reviewLists.length;
        await page.evaluate(() => {
          const widget = document.getElementById("widget");
          const parent = widget.parentNode;
          parent.removeChild(widget);
          parent.insertBefore(widget, parent.firstChild);
        });
        await sleep(400);
        assert.equal(await page.locator(".f1genz-sapo-review-summary").count(), 1, "summary rendered once");
        assert.equal(await page.locator(".f1genz-sapo-review-card").count(), 5);
        assert.equal(api.calls.reviewLists.length, before, "no extra list request");
      } finally {
        await context.close();
      }
    });
    await check("M3", "an element added after load (quick view, AJAX theme) boots and renders", async () => {
      const api = publicApi();
      const { context, page } = await open(api);
      try {
        await page.evaluate(() => {
          const host = document.createElement("section");
          host.id = "late";
          host.innerHTML = '<f1genz-reviews product-id="2002" storeDomain="e2e-store.mysapo.net"></f1genz-reviews>';
          document.body.appendChild(host);
        });
        const ok = await waitUntil(() => page.locator("#late .f1genz-sapo-review-card").count().then((n) => n > 0));
        assert.ok(ok, "late element rendered cards");
        assert.ok(api.calls.reviewLists.some((c) => c.productId === "2002"));
      } finally {
        await context.close();
      }
    });
  } finally {
    await browser.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }

  const failed = results.filter((r) => r.status === "fail");
  const reportFile = writeJson(path.join(ARTIFACTS, "report.json"), { suite: SUITE, results });
  if (failed.length) {
    console.error(`FAIL ${SUITE}: ${results.length - failed.length}/${results.length} passed`);
    console.error(`Failures:\n${failed.map((r) => ` - ${r.id} ${r.title}`).join("\n")}\nReport: ${reportFile}`);
    process.exit(1);
  }
  console.log(`OK ${SUITE}: ${results.length}/${results.length} passed`);
}

main().catch((error) => {
  console.error(`FAIL ${SUITE}: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
