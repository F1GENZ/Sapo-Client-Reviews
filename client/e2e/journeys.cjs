const path = require("path");
const { readFileSync } = require("fs");
const { chromium } = require("playwright");
const {
  sleep,
  AUTH_INIT,
  isPortFree,
  spawnPreview,
  killTree,
  waitForUrl,
  mockApi,
  waitUntil,
  trackPageErrors,
  assertNoHorizontalOverflow,
  artifactsDir,
  shot,
  writeJson,
  closeSync,
  unlinkSync,
} = require("./lib/harness.cjs");

const SUITE = "e2e-client-journeys";
const PORT = Number(process.env.E2E_CLIENT_PORT || 4311);
const ONLY = process.env.E2E_ONLY ? process.env.E2E_ONLY.split(",") : null;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const STORE = "e2e-shop.mysapo.net";
const OTHER_STORE = "e2e-other.mysapo.net";
const CLIENT_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(CLIENT_ROOT, "..");
const ARTIFACTS_DIR = artifactsDir(__dirname, "journeys");

function readDtoFields(relativeFile, className) {
  const file = path.join(REPO_ROOT, relativeFile);
  const source = readFileSync(file, "utf8");
  const start = source.indexOf(`class ${className}`);
  if (start < 0) throw new Error(`e2e: class ${className} not found in ${relativeFile}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  let end = open;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const fields = new Set();
  for (const line of source.slice(open + 1, end).split("\n")) {
    const match = /([A-Za-z_]\w*)[?!]?:\s*[^:;]+;\s*$/.exec(line);
    if (match) fields.add(match[1]);
  }
  if (fields.size === 0) throw new Error(`e2e: no fields read from ${className}`);
  return fields;
}

const WIDGET_FIELDS = readDtoFields("src/review/dto/update-widget-config.dto.ts", "UpdateWidgetConfigDto");
const SPAM_FIELDS = readDtoFields("src/review/dto/update-spam-config.dto.ts", "UpdateSpamConfigDto");

// The tab strip scrolls under the pointer when its target sits at the overflow edge, so tabs are opened with the keyboard, which is also the accessible path.
async function openTabByKeyboard(page, name) {
  const tab = page.getByRole("tab", { name });
  await tab.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction((label) => [...document.querySelectorAll("[role=tab]")].some((n) => label.test(n.textContent || "") && n.getAttribute("aria-selected") === "true"), name, { timeout: 5000 });
}

const NOW = Date.now();
const DAY = 86400000;

function seedState() {
  return {
    reviews: [
      {
        id: "rv-pending",
        productId: "1001",
        productTitle: "Áo thun E2E",
        rating: 4,
        author: "Khách Chờ Duyệt",
        email: "cho.duyet@example.com",
        phone: "0911222333",
        title: "Tạm ổn",
        content: "Sản phẩm đang chờ duyệt nội dung.",
        status: "pending",
        verified: false,
        pinned: false,
        reply: "",
        created_at: NOW - 2 * DAY,
      },
      {
        id: "rv-approved",
        productId: "1001",
        productTitle: "Áo thun E2E",
        rating: 5,
        author: "Khách Đã Duyệt",
        email: "da.duyet@example.com",
        title: "Rất tốt",
        content: "Chất lượng tuyệt vời, giao hàng nhanh.",
        status: "approved",
        verified: true,
        pinned: false,
        reply: "",
        created_at: NOW - 3 * DAY,
      },
      {
        id: "rv-spam",
        productId: "1002",
        productTitle: "Quần short E2E",
        rating: 1,
        author: "Khách Spam",
        content: "mua ngay tại link rẻ vô địch",
        status: "spam",
        verified: false,
        pinned: false,
        reply: "",
        created_at: NOW - 4 * DAY,
      },
    ],
    questions: [
      {
        id: "q-open",
        productId: "1001",
        productTitle: "Áo thun E2E",
        question: "Áo có màu xanh không?",
        author: "Người Hỏi",
        email: "nguoi.hoi@example.com",
        answer: "",
        status: "pending",
        created_at: NOW - DAY,
      },
      {
        id: "q-answered",
        productId: "1001",
        productTitle: "Áo thun E2E",
        question: "Giặt máy được không?",
        author: "Người Hỏi Hai",
        answer: "Giặt máy ở chế độ nhẹ.",
        answered_by: "Shop",
        answered_at: NOW - DAY,
        status: "approved",
        created_at: NOW - 2 * DAY,
      },
    ],
    widgetConfig: { titleText: "Đánh giá sản phẩm", showTitle: true, showDate: true, showFilter: true, showSort: true },
    spamConfig: { blockedWords: [], maxContentLength: 5000 },
    persisted: { widgetPuts: [], spamPuts: [], imports: [], dropped: [] },
    handoffs: new Map(),
    exchanges: 0,
  };
}

function pick(object, allowed, state, bucket) {
  const out = {};
  for (const [key, value] of Object.entries(object || {})) {
    if (allowed.has(key)) out[key] = value;
    else state.persisted.dropped.push(`${bucket}.${key}`);
  }
  return out;
}

function countBy(items, key) {
  return items.reduce((acc, item) => ({ ...acc, [item[key]]: (acc[item[key]] || 0) + 1 }), {});
}

function reviewList(state, search) {
  const params = new URLSearchParams(search);
  const status = params.get("status") || "all";
  let items = state.reviews;
  if (status === "unreplied") items = items.filter((r) => !r.reply);
  else if (status !== "all") items = items.filter((r) => r.status === status);
  const star = Number(params.get("star"));
  if (star) items = items.filter((r) => r.rating === star);
  const counts = countBy(state.reviews, "status");
  return {
    items,
    total: items.length,
    page: 1,
    pageSize: 20,
    totalPages: 1,
    statusCounts: {
      all: state.reviews.length,
      approved: counts.approved || 0,
      pending: counts.pending || 0,
      hidden: counts.hidden || 0,
      spam: counts.spam || 0,
      unreplied: state.reviews.filter((r) => !r.reply).length,
    },
  };
}

function questionList(state, search, productId) {
  const params = new URLSearchParams(search);
  const status = params.get("status") || "all";
  const scoped = productId ? state.questions.filter((q) => q.productId === productId) : state.questions;
  let items = scoped;
  if (status === "unanswered") items = items.filter((q) => !q.answer);
  else if (status === "answered") items = items.filter((q) => q.answer);
  else if (status !== "all") items = items.filter((q) => q.status === status);
  const oldestFirst = params.get("sort") === "oldest";
  const sorted = [...items].sort((a, b) => (oldestFirst ? a.created_at - b.created_at : b.created_at - a.created_at));
  const pageSize = Math.min(100, Math.max(1, Number(params.get("size") || params.get("limit") || 20)));
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const page = Math.min(totalPages, Math.max(1, Number(params.get("page") || 1)));
  const counts = countBy(scoped, "status");
  return {
    items: sorted.slice((page - 1) * pageSize, page * pageSize),
    total: sorted.length,
    page,
    pageSize,
    totalPages,
    statusCounts: {
      all: scoped.length,
      pending: counts.pending || 0,
      unanswered: scoped.filter((q) => !q.answer).length,
      answered: scoped.filter((q) => q.answer).length,
      hidden: counts.hidden || 0,
    },
  };
}

function overview(state) {
  const counts = countBy(state.reviews, "status");
  const approved = state.reviews.filter((r) => r.status === "approved");
  const qnaCounts = countBy(state.questions, "status");
  const reviewTrend = Array.from({ length: 14 }, (_, index) => ({
    date: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(NOW - (13 - index) * DAY)),
    count: index === 13 ? 2 : index === 11 ? 1 : 0,
  }));
  return {
    totalReviews: state.reviews.length,
    totalQuestions: state.questions.length,
    totalUnanswered: state.questions.filter((q) => !q.answer).length,
    statusCounts: {
      approved: counts.approved || 0,
      pending: counts.pending || 0,
      hidden: counts.hidden || 0,
      spam: counts.spam || 0,
      unreplied: state.reviews.filter((r) => !r.reply).length,
    },
    qnaStatusCounts: {
      all: state.questions.length,
      pending: qnaCounts.pending || 0,
      unanswered: state.questions.filter((q) => !q.answer).length,
      answered: state.questions.filter((q) => q.answer).length,
      hidden: qnaCounts.hidden || 0,
    },
    globalAvg: approved.length ? approved.reduce((sum, r) => sum + r.rating, 0) / approved.length : 0,
    globalDist: { 1: 1, 2: 0, 3: 0, 4: 1, 5: 1 },
    productCount: 2,
    verifiedCount: 1,
    withMediaCount: 0,
    responseRate: 0,
    reviewTrend,
    rankedProducts: [],
    attentionProducts: [
      {
        productId: "1002",
        title: "Quần short E2E",
        image: "https://cdn.example.com/e2e-2.jpg",
        reviewAvg: 1,
        reviewCount: 1,
        qnaUnanswered: 0,
        reason: "low_rating",
      },
    ],
    recentReviews: state.reviews.slice(0, 3),
    recentQuestions: state.questions.slice(0, 2),
    lastUpdated: NOW,
    degraded: [],
    productStats: [
      { productId: "1001", title: "Áo thun E2E", image: "https://cdn.example.com/e2e-1.jpg", reviewCount: 2, avgRating: 4.5, qnaTotal: 2, qnaUnanswered: 1 },
      { productId: "1002", title: "Quần short E2E", image: "https://cdn.example.com/e2e-2.jpg", reviewCount: 1, avgRating: 1, qnaTotal: 0, qnaUnanswered: 0 },
    ],
  };
}

const PRODUCTS = [
  { id: 1001, title: "Áo thun E2E", handle: "ao-thun-e2e", images: [{ src: "https://cdn.example.com/e2e-1.jpg" }] },
  { id: 1002, title: "Quần short E2E", handle: "quan-short-e2e", images: [{ src: "https://cdn.example.com/e2e-2.jpg" }] },
];

const UNLISTED_PRODUCT = { id: 1003, title: "Áo khoác E2E", handle: "ao-khoac-e2e", images: [{ src: "https://cdn.example.com/e2e-3.jpg" }] };

function adminApi(state, overrides = {}) {
  return (pathname, method, payload, _state, request) => {
    const custom = overrides.resolve && overrides.resolve(pathname, method, payload, state, request);
    if (custom) return custom;
    const ok = (data) => ({ status: 200, body: { data } });

    if (pathname === "/api/app/session") {
      return ok({ storeDomain: STORE, status: "active", featuresUnlocked: true, webhookStatus: "registered" });
    }
    if (pathname === "/api/admin/dashboard/overview") return ok(overview(state));
    if (pathname === "/api/admin/products" && method === "GET") return ok({ products: PRODUCTS, total: PRODUCTS.length });
    if (pathname === "/api/admin/ops/health") {
      return ok({
        storeDomain: STORE,
        status: "active",
        webhookStatus: "registered",
        webhooks: { totals: [{ status: "processed", count: 7 }], latest: [] },
        counts: { products: PRODUCTS.length, reviews: state.reviews.length, questions: state.questions.length, answered: state.questions.filter((q) => q.answer).length },
        lastUpdated: NOW,
      });
    }
    const productOne = /^\/api\/admin\/products\/(\d+)$/.exec(pathname);
    if (productOne) {
      const product = [...PRODUCTS, UNLISTED_PRODUCT].find((p) => String(p.id) === productOne[1]);
      return product ? ok({ product }) : { status: 404, body: { message: "Product not found" } };
    }

    if (pathname === "/api/admin/reviews/widget-config") {
      if (method === "PUT") {
        const accepted = pick(payload, WIDGET_FIELDS, state, "widget");
        state.persisted.widgetPuts.push(payload);
        state.widgetConfig = { ...state.widgetConfig, ...accepted };
      }
      return ok(state.widgetConfig);
    }
    if (pathname === "/api/admin/reviews/spam-config") {
      if (method === "PUT") {
        const accepted = pick(payload, SPAM_FIELDS, state, "spam");
        state.persisted.spamPuts.push(payload);
        state.spamConfig = { ...state.spamConfig, ...accepted };
      }
      return ok(state.spamConfig);
    }
    if (pathname === "/api/admin/reviews/bulk" && method === "POST") {
      const items = Array.isArray(payload.items) ? payload.items : [];
      let updated = 0;
      let deleted = 0;
      let skipped = 0;
      for (const item of items) {
        const review = state.reviews.find((r) => r.id === item.reviewId && r.productId === String(item.productId));
        if (!review) {
          skipped += 1;
          continue;
        }
        if (payload.action === "delete") {
          state.reviews = state.reviews.filter((r) => r !== review);
          deleted += 1;
        } else {
          review.status = payload.action === "approve" ? "approved" : payload.action;
          updated += 1;
        }
      }
      return ok({ requested: items.length, updated, deleted, skipped, failed: 0, summarySync: { synced: 0, queued: 0 } });
    }
    if (pathname === "/api/admin/reviews" && method === "GET") return ok(reviewList(state, request.search));
    if (pathname === "/api/admin/reviews/import/dry-run" && method === "POST") {
      const lines = String(payload.body || "").trim().split("\n").filter(Boolean).length - 1;
      return ok({ created: lines, updated: 0, skipped: 0, failed: 0, total: lines, errors: [], runId: "dry-1" });
    }
    if (pathname === "/api/admin/reviews/import" && method === "POST") {
      state.persisted.imports.push(payload);
      const lines = String(payload.body || "").trim().split("\n").filter(Boolean).length - 1;
      return ok({ created: lines, updated: 0, skipped: 0, failed: 0, total: lines, errors: [], runId: "import-1" });
    }

    const statsOfProduct = /^\/api\/admin\/reviews\/(\d+)\/stats$/.exec(pathname);
    if (statsOfProduct) {
      const own = state.reviews.filter((r) => r.productId === statsOfProduct[1]);
      const live = own.filter((r) => r.status === "approved");
      return ok({
        total: own.length,
        avgRating: live.length ? live.reduce((sum, r) => sum + r.rating, 0) / live.length : 0,
        summary: { count: live.length, avg: live.length ? live.reduce((sum, r) => sum + r.rating, 0) / live.length : 0, distribution: {} },
      });
    }

    const reviewAction = /^\/api\/admin\/reviews\/(\d+)\/([\w-]+)(?:\/(status|reply|pin))?$/.exec(pathname);
    if (reviewAction) {
      const [, productId, id, action] = reviewAction;
      const review = state.reviews.find((r) => r.id === id && r.productId === productId);
      if (!review) return { status: 404, body: { message: "Review not found" } };
      if (method === "PATCH" && action === "status") review.status = payload.status;
      else if (method === "PATCH" && action === "reply") {
        review.reply = payload.reply;
        review.replied_at = Date.now();
      } else if (method === "DELETE") state.reviews = state.reviews.filter((r) => r !== review);
      return ok(method === "DELETE" ? { deleted: true } : review);
    }
    const reviewsOfProduct = /^\/api\/admin\/reviews\/(\d+)$/.exec(pathname);
    if (reviewsOfProduct && method === "GET") {
      return ok(state.reviews.filter((r) => r.productId === reviewsOfProduct[1]));
    }

    if (pathname === "/api/admin/qna" && method === "GET") return ok(questionList(state, request.search));
    if (pathname === "/api/admin/qna/bulk" && method === "POST") {
      const items = Array.isArray(payload.items) ? payload.items : [];
      let updated = 0;
      let deleted = 0;
      let skipped = 0;
      for (const item of items) {
        const question = state.questions.find((q) => q.id === item.questionId && q.productId === String(item.productId));
        if (!question) {
          skipped += 1;
          continue;
        }
        if (payload.action === "delete") {
          state.questions = state.questions.filter((q) => q !== question);
          deleted += 1;
        } else {
          question.status = payload.action === "approve" ? "approved" : payload.action;
          updated += 1;
        }
      }
      return ok({ requested: items.length, updated, deleted, skipped, failed: 0, summarySync: { synced: 0, queued: 0 } });
    }
    const qnaAction = /^\/api\/admin\/qna\/(\d+)\/([\w-]+)(?:\/(answer|status))?$/.exec(pathname);
    if (qnaAction) {
      const [, productId, id, action] = qnaAction;
      const question = state.questions.find((q) => q.id === id && q.productId === productId);
      if (!question) return { status: 404, body: { message: "Question not found" } };
      if (method === "PATCH" && action === "answer") {
        question.answer = payload.answer;
        question.answered_by = payload.answered_by || "Shop";
        question.answered_at = Date.now();
        if (payload.status) question.status = payload.status;
      } else if (method === "PATCH" && action === "status") question.status = payload.status;
      else if (method === "DELETE") state.questions = state.questions.filter((q) => q !== question);
      return ok(method === "DELETE" ? { deleted: true } : question);
    }
    const qnaOfProduct = /^\/api\/admin\/qna\/(\d+)$/.exec(pathname);
    if (qnaOfProduct && method === "GET") return ok(questionList(state, request.search, qnaOfProduct[1]));
    return undefined;
  };
}

const results = [];

async function main() {
  const startedAt = Date.now();
  if (!(await isPortFree(PORT))) {
    throw new Error(`port ${PORT} is already in use; stop the owner instead of moving ports.`);
  }
  const preview = spawnPreview(CLIENT_ROOT, PORT);
  let browser = null;
  try {
    await waitForUrl(`${BASE_URL}/install/login`, { proc: preview.proc });
    browser = await chromium.launch({ headless: true });

    async function scenario(id, name, options, fn) {
      if (ONLY && !ONLY.includes(id)) return;
      const opts = typeof options === "function" ? {} : options;
      const run = typeof options === "function" ? options : fn;
      const state = seedState();
      const context = await browser.newContext({ viewport: opts.viewport || { width: 1280, height: 900 } });
      const page = await context.newPage();
      const tracker = trackPageErrors(page);
      try {
        if (opts.auth !== false) await context.addInitScript(AUTH_INIT, opts.store || STORE);
        await mockApi(context, { resolve: adminApi(state, opts), state });
        await context.route(/^https:\/\/[a-z0-9-]+\.mysapo\.net\/.*/, (route) =>
          route.fulfill({ status: 200, contentType: "text/html", body: "<title>sapo authorize stub</title>" }),
        );
        await run({ page, state, context, tracker, requests: state.requests });
        if (tracker.errors.length) throw new Error(`unhandled page errors: ${tracker.errors.join(" | ")}`);
        results.push({ id, name, passed: true });
        console.log(`  [PASS] ${id} ${name}`);
      } catch (error) {
        const failure = String(error && error.message ? error.message : error);
        let screenshot = null;
        try {
          screenshot = await shot(page, ARTIFACTS_DIR, `${id}-failure`);
        } catch {
          /* page already closed */
        }
        results.push({ id, name, passed: false, failure, screenshot });
        console.error(`  [FAIL] ${id} ${name}\n         ${failure.split("\n").join("\n         ")}`);
      } finally {
        await context.close();
      }
    }

    const go = async (page, route, { settle = true } = {}) => {
      await page.goto(`${BASE_URL}${route}`, { waitUntil: "domcontentloaded" });
      if (settle) await page.waitForLoadState("networkidle").catch(() => undefined);
    };
    const expectVisible = async (locator, label, timeout = 8000) => {
      try {
        await locator.first().waitFor({ state: "visible", timeout });
      } catch {
        throw new Error(`not visible: ${label}`);
      }
    };
    const expectText = async (page, text, label = text) => expectVisible(page.getByText(text).first(), label);
    const lastRequest = (requests, method, test) =>
      [...requests].reverse().find((r) => r.method === method && test(r.pathname));
    const withStore = (route, store = STORE) => `${route}${route.includes("?") ? "&" : "?"}storeDomain=${store}`;

    console.log("--- admin routes ---");
    await scenario("N1", "dashboard loads real overview numbers and keeps storeDomain in the URL", async ({ page, requests }) => {
      await go(page, "/");
      await expectText(page, "Tổng quan", "dashboard heading");
      assert(await waitUntil(() => requests.some((r) => r.pathname === "/api/admin/dashboard/overview")), "dashboard did not request the overview");
      await expectText(page, "Tổng đánh giá", "total reviews KPI");
      await expectText(page, "Khách Chờ Duyệt", "recent review author from the seed");
      await expectText(page, "Khách Đã Duyệt", "recent review author from the seed");
      assert.equal(await page.getByText("Chưa có dữ liệu để hiển thị").count(), 0, "dashboard rendered the empty state despite seeded data");
      const total = await page.locator("body").innerText();
      assert(/Tổng đánh giá\s*\n?\s*3\b/.test(total), `total reviews KPI is not the seeded 3: ${total.slice(0, 400)}`);
      await waitUntil(() => new URL(page.url()).searchParams.get("storeDomain") === STORE);
      assert.equal(new URL(page.url()).searchParams.get("storeDomain"), STORE, `storeDomain missing from ${page.url()}`);
    });

    await scenario("N2", "every API call carries the store header and the session bearer, never the Sapo token", async ({ page, requests }) => {
      await go(page, withStore("/reviews"));
      await waitUntil(() => requests.some((r) => r.pathname === "/api/admin/reviews"));
      const adminCalls = requests.filter((r) => r.pathname.startsWith("/api/admin/") || r.pathname === "/api/app/session");
      assert(adminCalls.length > 0, "no admin calls were made");
      for (const call of adminCalls) {
        assert.equal(call.headers["x-store-domain"], STORE, `${call.pathname} lacks x-store-domain`);
        assert.equal(call.headers.authorization, "Bearer e2e-token", `${call.pathname} lacks the session bearer`);
      }
    });

    await scenario("N3", "all main routes render at 375px without horizontal overflow or page errors", { viewport: { width: 375, height: 800 } }, async ({ page, tracker }) => {
      for (const route of ["/", "/reviews", "/qna", "/settings", "/guide", "/contact", "/dev", "/health"]) {
        await go(page, withStore(route));
        await page.waitForTimeout(250);
        await assertNoHorizontalOverflow(page, route);
        const text = await page.locator("body").innerText();
        assert(text.trim().length > 40, `${route} rendered an empty page`);
        assert.ok(!/Đã xảy ra lỗi/.test(text), `${route} hit the error boundary`);
      }
      assert.deepEqual(tracker.errors, []);
      assert.deepEqual(
        tracker.consoleErrors.filter((m) => !/Failed to load resource/.test(m)),
        [],
        "console errors on happy-path routes",
      );
    });

    await scenario("N4", "unknown paths redirect to the dashboard and keep the store", async ({ page }) => {
      await go(page, withStore("/definitely-not-a-page"));
      await waitUntil(() => new URL(page.url()).pathname === "/");
      assert.equal(new URL(page.url()).pathname, "/");
      assert.equal(new URL(page.url()).searchParams.get("storeDomain"), STORE);
    });

    await scenario("N5", "ops page is a normal authenticated route with a menu entry and real webhook status names", async ({ page, requests }) => {
      await go(page, withStore("/health"));
      await expectText(page, "7 webhook đã xử lý", "processed webhook count");
      assert.equal(new URL(page.url()).pathname, "/health", `redirected away to ${page.url()}`);
      assert(requests.some((r) => r.pathname === "/api/admin/ops/health"), "ops health was not requested");
      await expectVisible(page.getByRole("menuitem", { name: "Vận hành" }), "Vận hành menu entry");
      const body = await page.locator("body").innerText();
      assert.ok(!/Dùng thử|Đã hủy/.test(body), "billing status labels are still rendered");
    });

    await scenario("N6", "dashboard renders trend, attention products and unreplied counts and shows no warning when nothing is degraded", async ({ page }) => {
      await go(page, withStore("/"));
      await expectText(page, "Sản phẩm cần chú ý");
      await expectText(page, "Điểm cần cải thiện");
      assert.equal(await page.getByText("Một số số liệu chưa tải được").count(), 0, "degraded warning shown for a healthy payload");
    });

    await scenario(
      "N7",
      "dashboard warns when the server reports degraded sections",
      {
        resolve: (pathname, method, payload, state) =>
          pathname === "/api/admin/dashboard/overview"
            ? { status: 200, body: { data: { ...overview(state), degraded: ["reviewTrend"] } } }
            : undefined,
      },
      async ({ page }) => {
        await go(page, withStore("/"));
        await expectText(page, "Một số số liệu chưa tải được", "degraded warning");
        await expectText(page, "reviewTrend", "degraded section name");
      },
    );

    console.log("\n--- reviews ---");
    await scenario("V1", "review list renders authors, ratings and per-status tab counts", async ({ page }) => {
      await go(page, withStore("/reviews"));
      await expectText(page, "Khách Chờ Duyệt");
      const rowWidth = await page.locator(".f1g-bulk-table__row").first().evaluate((row) => {
        const card = row.querySelector(".ant-card");
        return card ? card.getBoundingClientRect().width : 0;
      });
      assert(rowWidth > 300, `review card is crushed to ${Math.round(rowWidth)}px next to the selection checkbox`);
      await expectText(page, "Khách Đã Duyệt");
      await expectText(page, "Khách Spam");
      const tabs = await page.getByRole("tab").allInnerTexts();
      assert(tabs.some((t) => /Chờ duyệt/.test(t)), `no pending tab in ${tabs.join(",")}`);
      assert(tabs.some((t) => /Spam/.test(t)), `no spam tab in ${tabs.join(",")}`);
    });

    await scenario("V13", "product dropdown shows per-product rating stats and never prints undefined", async ({ page }) => {
      await go(page, withStore("/reviews"));
      await expectText(page, "Khách Chờ Duyệt");
      await page.getByLabel("Tìm kiếm sản phẩm").click();
      const list = page.getByRole("listbox", { name: "Danh sách sản phẩm" });
      await expectVisible(list, "product dropdown");
      await expectText(page, "2 đánh giá · 4.5 sao", "stats of product 1001");
      await expectText(page, "1 đánh giá · 1.0 sao", "stats of product 1002");
      const menuText = await list.innerText();
      assert(!/undefined|NaN/.test(menuText), `product dropdown printed an invalid value: ${menuText}`);
    });

    await scenario(
      "V14",
      "an expired upload ticket (401 from the public upload route) keeps the admin signed in and shows an error",
      {
        resolve: (pathname) => {
          if (pathname === "/api/admin/media/upload-ticket") return { status: 200, body: { data: { ticket: "e2e-expired-ticket" } } };
          if (pathname === "/api/public/media/upload") return { status: 401, body: { message: "Phiên upload đã hết hạn" } };
          return undefined;
        },
      },
      async ({ page, requests }) => {
        await go(page, withStore("/reviews"));
        await expectText(page, "Khách Chờ Duyệt");
        await page.getByRole("button", { name: "Chỉnh sửa", exact: true }).first().click();
        await page.locator(".ant-modal input[type=file]").first().setInputFiles({
          name: "e2e.png",
          mimeType: "image/png",
          buffer: Buffer.from("89504e470d0a1a0a", "hex"),
        });
        assert(await waitUntil(() => requests.some((r) => r.pathname === "/api/public/media/upload")), "the upload request was never sent");
        await expectText(page, "Phiên upload đã hết hạn", "upload error message");
        assert(!/\/install\/login/.test(page.url()), `admin was sent to login: ${page.url()}`);
        const token = await page.evaluate((store) => window.localStorage.getItem(`auth_session_token:${store}`) || window.sessionStorage.getItem(`auth_session_token:${store}`), STORE);
        assert.notEqual(token, null, "upload 401 cleared the admin session");
      },
    );

    await scenario("V2", "status tab asks the server for that status and shows only matching reviews", async ({ page, requests }) => {
      await go(page, withStore("/reviews"));
      await expectText(page, "Khách Chờ Duyệt");
      await page.getByRole("tab", { name: /Chờ duyệt/ }).click();
      await waitUntil(() => requests.some((r) => r.pathname === "/api/admin/reviews" && /status=pending/.test(r.search)));
      assert(requests.some((r) => r.pathname === "/api/admin/reviews" && /status=pending/.test(r.search)), "no status=pending request");
      await expectText(page, "Khách Chờ Duyệt");
      await page.waitForFunction(() => !document.body.innerText.includes("Khách Đã Duyệt"), null, { timeout: 5000 });
    });

    await scenario("V3", "approving a pending review sends PATCH status=approved and removes the approve action", async ({ page, requests, state }) => {
      await go(page, withStore("/reviews"));
      await expectText(page, "Khách Chờ Duyệt");
      await page.getByRole("button", { name: "Duyệt", exact: true }).first().click();
      await waitUntil(() => lastRequest(requests, "PATCH", (p) => p.endsWith("/status")));
      const call = lastRequest(requests, "PATCH", (p) => p.endsWith("/status"));
      assert(call, "no status PATCH");
      assert.equal(call.pathname, "/api/admin/reviews/1001/rv-pending/status");
      assert.deepEqual(call.payload, { status: "approved" });
      assert.equal(state.reviews.find((r) => r.id === "rv-pending").status, "approved");
      await waitUntil(async () => (await page.getByRole("button", { name: "Duyệt", exact: true }).count()) === 0);
      assert.equal(await page.getByRole("button", { name: "Duyệt", exact: true }).count(), 0, "approve button still offered");
    });

    await scenario("V4", "hiding a review sends PATCH status=hidden and offers restore", async ({ page, requests, state }) => {
      await go(page, withStore("/reviews"));
      await expectText(page, "Khách Đã Duyệt");
      const card = page.locator(".f1g-bulk-table__row", { hasText: "Khách Đã Duyệt" });
      await card.getByRole("button", { name: "Ẩn", exact: true }).click();
      await waitUntil(() => state.reviews.find((r) => r.id === "rv-approved").status === "hidden");
      const call = lastRequest(requests, "PATCH", (p) => p.endsWith("/rv-approved/status"));
      assert.deepEqual(call && call.payload, { status: "hidden" });
      await expectVisible(page.locator(".f1g-bulk-table__row", { hasText: "Khách Đã Duyệt" }).getByRole("button", { name: "Hiện lại" }), "restore action");
    });

    await scenario("V5", "replying sends PATCH reply with the typed text and shows it on the card", async ({ page, requests, state }) => {
      await go(page, withStore("/reviews"));
      const card = page.locator(".f1g-bulk-table__row", { hasText: "Khách Đã Duyệt" });
      await expectVisible(card, "approved review row");
      await card.getByRole("button", { name: "Phản hồi" }).click();
      await card.getByPlaceholder("Nhập phản hồi…").fill("Cảm ơn bạn đã ủng hộ shop!");
      await card.getByRole("button", { name: "Gửi phản hồi" }).click();
      await waitUntil(() => state.reviews.find((r) => r.id === "rv-approved").reply);
      const call = lastRequest(requests, "PATCH", (p) => p.endsWith("/rv-approved/reply"));
      assert.deepEqual(call && call.payload, { reply: "Cảm ơn bạn đã ủng hộ shop!" });
      await expectVisible(card.getByRole("button", { name: "Xem chi tiết" }), "detail action");
      assert.equal(await card.getByRole("button", { name: "Phản hồi", exact: true }).count(), 0, "reply action is still offered after replying");
      await card.getByRole("button", { name: "Xem chi tiết" }).click();
      await expectText(page, "Cảm ơn bạn đã ủng hộ shop!");
    });

    await scenario("V6", "reply composer refuses empty text and caps at 2000 characters", async ({ page, requests }) => {
      await go(page, withStore("/reviews"));
      const card = page.locator(".f1g-bulk-table__row", { hasText: "Khách Đã Duyệt" });
      await expectVisible(card, "approved review row");
      await card.getByRole("button", { name: "Phản hồi" }).click();
      assert.equal(await card.getByRole("button", { name: "Gửi phản hồi" }).isDisabled(), true, "empty reply is submittable");
      const area = card.getByPlaceholder("Nhập phản hồi…");
      assert.equal(await area.getAttribute("maxlength"), "2000");
      await area.fill("   ");
      assert.equal(await card.getByRole("button", { name: "Gửi phản hồi" }).isDisabled(), true, "whitespace-only reply is submittable");
      assert(!requests.some((r) => r.method === "PATCH"), "a PATCH was sent for an empty reply");
    });

    await scenario("V7", "deleting asks for confirmation, then DELETEs and removes the card", async ({ page, requests, state }) => {
      await go(page, withStore("/reviews"));
      const card = page.locator(".f1g-bulk-table__row", { hasText: "Khách Spam" });
      await expectVisible(card, "spam review row");
      await card.getByRole("button", { name: "Xóa", exact: true }).click();
      await expectText(page, "Xóa đánh giá này?");
      assert(!requests.some((r) => r.method === "DELETE"), "DELETE sent before confirmation");
      await page.locator(".ant-popconfirm .ant-btn-primary").click();
      await waitUntil(() => !state.reviews.some((r) => r.id === "rv-spam"));
      const call = lastRequest(requests, "DELETE", () => true);
      assert.equal(call && call.pathname, "/api/admin/reviews/1002/rv-spam");
      await page.waitForFunction(() => !document.body.innerText.includes("Khách Spam"), null, { timeout: 5000 });
    });

    await scenario("V8", "cancelling the delete confirmation sends nothing", async ({ page, requests }) => {
      await go(page, withStore("/reviews"));
      const card = page.locator(".f1g-bulk-table__row", { hasText: "Khách Spam" });
      await expectVisible(card, "spam review row");
      await card.getByRole("button", { name: "Xóa", exact: true }).click();
      await page.locator(".ant-popconfirm").getByRole("button", { name: "Hủy" }).click();
      await page.waitForTimeout(300);
      assert(!requests.some((r) => r.method === "DELETE"), "DELETE sent after cancel");
      await expectText(page, "Khách Spam");
    });

    await scenario("V15", "bulk delete asks first, then reports the server's real counts", async ({ page, requests, state }) => {
      await go(page, withStore("/reviews"));
      const card = page.locator(".f1g-bulk-table__row", { hasText: "Khách Spam" });
      await expectVisible(card, "spam review row");
      await card.locator("label.ant-checkbox-wrapper").first().click();
      await expectText(page, "Đã chọn 1 mục");
      await page.getByRole("button", { name: "Xoá", exact: true }).first().click();
      const confirmBox = page.locator(".ant-modal-confirm").last();
      await expectVisible(confirmBox, "bulk delete confirmation");
      assert.match(await confirmBox.innerText(), /Xoá vĩnh viễn 1 đánh giá\?/);
      assert(!requests.some((r) => r.pathname === "/api/admin/reviews/bulk"), "bulk request sent before confirmation");
      await confirmBox.locator(".ant-btn-primary").click();
      await waitUntil(() => !state.reviews.some((r) => r.id === "rv-spam"));
      const call = lastRequest(requests, "POST", (path) => path === "/api/admin/reviews/bulk");
      assert.deepEqual(call && call.payload.action, "delete");
      assert.deepEqual(call && call.payload.items, [{ productId: "1002", reviewId: "rv-spam" }]);
      await expectText(page, "đã xoá 1 mục");
    });

    await scenario("V9", "a failed moderation call leaves the card unchanged and the page alive", async ({ page, requests, state }) => {
      await go(page, withStore("/reviews"));
      await expectText(page, "Khách Chờ Duyệt");
      await page.context().route("**/api/**", async (route) => {
        const request = route.request();
        if (request.method() === "PATCH" && request.url().endsWith("/status")) {
          requests.push({ pathname: new URL(request.url()).pathname, method: "PATCH", payload: request.postDataJSON(), search: "", headers: {} });
          await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "boom" }) });
          return;
        }
        await route.fallback();
      });
      await page.getByRole("button", { name: "Duyệt", exact: true }).first().click();
      await waitUntil(() => requests.some((r) => r.method === "PATCH"));
      await page.waitForTimeout(400);
      assert.equal(state.reviews.find((r) => r.id === "rv-pending").status, "pending");
      await expectText(page, "Khách Chờ Duyệt");
      assert.ok(await page.getByRole("button", { name: "Duyệt", exact: true }).first().isVisible(), "approve action disappeared after a failed save");
    });

    await scenario("V10", "product filter from the URL scopes the list to that product's reviews", async ({ page, requests }) => {
      await go(page, withStore("/reviews?product=1002"));
      await expectText(page, "Khách Spam");
      assert(requests.some((r) => r.pathname === "/api/admin/reviews/1002"), "per-product reviews were not requested");
      assert.equal(await page.getByText("Khách Đã Duyệt").count(), 0, "another product's review is shown");
    });

    await scenario("V11", "a product outside the loaded page resolves through the single-product route and links to /{alias}", async ({ page, requests }) => {
      await go(page, withStore("/reviews?product=1003"));
      await expectText(page, "Đánh giá của sản phẩm: Áo khoác E2E");
      assert(requests.some((r) => r.pathname === "/api/admin/products/1003"), "single-product route was not requested");
      const link = page.getByRole("link", { name: /Xem trực tiếp/ });
      await expectVisible(link, "live product link");
      assert.equal(await link.getAttribute("href"), `https://${STORE}/ao-khoac-e2e`);
    });

    await scenario("V12", "the star filter is sent as an integer star param and narrows the list", async ({ page, requests }) => {
      await go(page, withStore("/reviews"));
      await expectText(page, "Khách Đã Duyệt");
      await page.locator("button").filter({ hasText: /^4$/ }).first().click();
      await waitUntil(() => requests.some((r) => r.pathname === "/api/admin/reviews" && new URLSearchParams(r.search).get("star") === "4"));
      assert(requests.some((r) => r.pathname === "/api/admin/reviews" && new URLSearchParams(r.search).get("star") === "4"), "no star=4 request");
      await page.waitForFunction(() => !document.body.innerText.includes("Khách Đã Duyệt"), null, { timeout: 5000 });
      await expectText(page, "Khách Chờ Duyệt");
    });

    console.log("\n--- Q&A ---");
    await scenario("Q1", "Q&A list renders questions, answers and status counts", async ({ page }) => {
      await go(page, withStore("/qna"));
      await expectText(page, "Áo có màu xanh không?");
      const rowWidth = await page.locator(".f1g-bulk-table__row").first().evaluate((row) => {
        const card = row.querySelector(".ant-card");
        return card ? card.getBoundingClientRect().width : 0;
      });
      assert(rowWidth > 300, `question card is crushed to ${Math.round(rowWidth)}px next to the selection checkbox`);

      await expectText(page, "Giặt máy được không?");
      await expectText(page, "Giặt máy ở chế độ nhẹ.");
      const tabs = await page.getByRole("tab").allInnerTexts();
      assert(tabs.some((t) => /Chưa trả lời/.test(t)), `no unanswered tab in ${tabs.join(",")}`);
    });

    await scenario("Q2", "answering sends PATCH answer with the typed text", async ({ page, requests, state }) => {
      await go(page, withStore("/qna"));
      const card = page.locator(".ant-card", { hasText: "Áo có màu xanh không?" }).last();
      await expectVisible(card, "open question");
      await card.getByRole("button", { name: "Trả lời" }).click();
      assert.equal(await card.getByRole("button", { name: "Gửi trả lời" }).isDisabled(), true, "empty answer is submittable");
      await card.getByPlaceholder("Nhập câu trả lời…").fill("Có, màu xanh navy còn hàng.");
      await card.getByRole("button", { name: "Gửi trả lời" }).click();
      await waitUntil(() => state.questions.find((q) => q.id === "q-open").answer);
      const call = lastRequest(requests, "PATCH", (p) => p.endsWith("/q-open/answer"));
      assert(call, "no answer PATCH");
      assert.equal(call.payload.answer, "Có, màu xanh navy còn hàng.");
      await expectText(page, "Có, màu xanh navy còn hàng.");
    });

    await scenario("Q3", "approving, hiding and deleting a question each hit the right endpoint", async ({ page, requests, state }) => {
      await go(page, withStore("/qna"));
      const card = () => page.locator(".ant-card", { hasText: "Áo có màu xanh không?" }).last();
      await expectVisible(card(), "open question");
      await card().getByRole("button", { name: "Duyệt câu hỏi" }).click();
      await waitUntil(() => state.questions.find((q) => q.id === "q-open").status === "approved");
      assert.deepEqual(lastRequest(requests, "PATCH", (p) => p.endsWith("/q-open/status")).payload, { status: "approved" });
      await card().getByRole("button", { name: "Ẩn câu hỏi" }).click();
      await waitUntil(() => state.questions.find((q) => q.id === "q-open").status === "hidden");
      await card().getByRole("button", { name: "Xóa câu hỏi" }).click();
      await page.locator(".ant-popconfirm .ant-btn-primary").click();
      await waitUntil(() => !state.questions.some((q) => q.id === "q-open"));
      assert.equal(lastRequest(requests, "DELETE", () => true).pathname, "/api/admin/qna/1001/q-open");
    });

    await scenario("Q4", "per-product Q&A reads the paged response and renders its questions", async ({ page, requests }) => {
      await go(page, withStore("/qna?product=1001"));
      await expectText(page, "Áo có màu xanh không?");
      await expectText(page, "Giặt máy được không?");
      const call = requests.find((r) => r.pathname === "/api/admin/qna/1001");
      assert(call, "per-product Q&A was not requested");
      const params = new URLSearchParams(call.search);
      assert.equal(params.get("page"), "1");
      assert.equal(params.get("size"), "20");
    });

    await scenario("Q5", "per-product Q&A pages through the server instead of loading everything", async ({ page, requests, state }) => {
      for (let index = 0; index < 45; index += 1) {
        state.questions.push({
          id: `q-bulk-${index}`,
          productId: "1001",
          productTitle: "Áo thun E2E",
          question: `Câu hỏi số ${index}`,
          author: "Người Hỏi Nhiều",
          answer: "",
          status: "approved",
          created_at: NOW - (3 + index) * DAY,
        });
      }
      await go(page, withStore("/qna?product=1001"));
      await expectText(page, "Áo có màu xanh không?");
      await expectVisible(page.locator(".ant-pagination"), "pagination");
      assert.equal(await page.getByText("Câu hỏi số 18", { exact: true }).count(), 0, "second page content is on page one");
      await page.locator(".ant-pagination-item-2").click();
      await waitUntil(() => requests.some((r) => r.pathname === "/api/admin/qna/1001" && new URLSearchParams(r.search).get("page") === "2"));
      assert(requests.some((r) => r.pathname === "/api/admin/qna/1001" && new URLSearchParams(r.search).get("page") === "2"), "page 2 was not requested from the server");
      await expectText(page, "Câu hỏi số 18");
      assert.equal(await page.getByText("Áo có màu xanh không?").count(), 0, "page one content is still shown on page two");
    });

    console.log("\n--- settings ---");
    await scenario("S1", "editing the widget title enables the tab save, PUTs only server-accepted keys, and persists", async ({ page, state }) => {
      await go(page, withStore("/settings"));
      const title = page.getByText("Tiêu đề widget", { exact: true }).locator("xpath=ancestor::div[1]//input").first();
      await expectVisible(title, "title input");
      assert.equal(await title.inputValue(), "Đánh giá sản phẩm");
      assert.equal(await page.getByRole("button", { name: "Lưu thay đổi" }).isDisabled(), true, "save is enabled with no change");
      assert.equal(await page.getByText("Chưa có thay đổi", { exact: true }).count(), 1, "clean state needs a status line");
      await title.fill("Khách hàng nói gì");
      await expectText(page, "Có thay đổi chưa lưu");
      await page.getByRole("button", { name: "Lưu thay đổi" }).click();
      await waitUntil(() => state.persisted.widgetPuts.length > 0);
      assert.equal(state.persisted.widgetPuts.length, 1, "expected exactly one PUT");
      assert.equal(state.widgetConfig.titleText, "Khách hàng nói gì");
      assert.deepEqual(
        state.persisted.dropped.filter((k) => k.startsWith("widget.")),
        [],
        "the settings page sends widget keys the server whitelist silently drops (the merchant's change is lost)",
      );
      await expectText(page, "Đã lưu cấu hình");
    });

    await scenario("S2", "reloading after a save shows the saved value, not the default", async ({ page, state }) => {
      state.widgetConfig.titleText = "Tiêu đề đã lưu";
      await go(page, withStore("/settings"));
      const title = page.getByText("Tiêu đề widget", { exact: true }).locator("xpath=ancestor::div[1]//input").first();
      await expectVisible(title, "title input");
      assert.equal(await title.inputValue(), "Tiêu đề đã lưu");
    });

    await scenario("S3", "a rejected save (500) shows an error, keeps the draft, and does not claim success", async ({ page, state }) => {
      await go(page, withStore("/settings"));
      const title = page.getByText("Tiêu đề widget", { exact: true }).locator("xpath=ancestor::div[1]//input").first();
      await expectVisible(title, "title input");
      await page.context().route("**/api/admin/reviews/widget-config", async (route) => {
        if (route.request().method() === "PUT") {
          await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "boom" }) });
          return;
        }
        await route.fallback();
      });
      await title.fill("Bản nháp");
      await page.getByRole("button", { name: "Lưu thay đổi" }).click();
      await expectText(page, "boom");
      assert.equal(await page.getByText("Đã lưu cấu hình").count(), 0, "success toast shown for a failed save");
      assert.equal(await title.inputValue(), "Bản nháp", "draft was discarded after a failed save");
      assert.equal(state.widgetConfig.titleText, "Đánh giá sản phẩm");
    });

    await scenario("S4", "adding a blocked word PUTs spam-config with that word", async ({ page, state }) => {
      await go(page, withStore("/settings"));
      await openTabByKeyboard(page, /Duyệt & Spam/);
      const input = page.getByPlaceholder("Nhập từ khoá rồi Enter");
      await expectVisible(input, "blocked word input");
      await input.fill("cá-độ");
      await input.press("Enter");
      await page.getByRole("button", { name: "Lưu thay đổi" }).click();
      await waitUntil(() => state.persisted.spamPuts.length > 0);
      assert.deepEqual(state.spamConfig.blockedWords, ["cá-độ"]);
    });

    await scenario("S5", "every spam control saves a value the server persists (no silently dropped keys)", async ({ page, state }) => {
      await go(page, withStore("/settings"));
      await openTabByKeyboard(page, /Duyệt & Spam/);
      const maxLength = page.getByText("Độ dài nội dung tối đa", { exact: true }).locator("xpath=ancestor::div[1]//input").first();
      await expectVisible(maxLength, "max content length input");
      await maxLength.fill("1200");
      await page.getByRole("switch", { name: "Tự động duyệt review mới từ storefront" }).click();
      await page.getByRole("button", { name: "Lưu thay đổi" }).click();
      await waitUntil(() => state.persisted.spamPuts.length > 0 && state.persisted.widgetPuts.length > 0);
      assert.deepEqual(
        state.persisted.dropped.filter((k) => k.startsWith("spam.") || k.startsWith("widget.")),
        [],
        "the moderation tab sends keys the server whitelist drops: the UI reports saved but the setting is never stored",
      );
      assert.equal(state.spamConfig.maxContentLength, 1200);
      assert.equal(state.widgetConfig.autoApprove, true);
    });

    await scenario("S8", "reset asks first, lists what it touches, and cancelling keeps the draft", async ({ page }) => {
      await go(page, withStore("/settings"));
      await page.getByRole("switch", { name: "Hiển thị tiêu đề đánh giá" }).click();
      await expectText(page, "Có thay đổi chưa lưu");
      await page.getByRole("button", { name: "Khôi phục toàn bộ mặc định" }).click();
      const dialog = page.locator(".ant-modal-content", { hasText: "Khôi phục toàn bộ về mặc định?" });
      await expectVisible(dialog, "reset dialog");
      await expectText(page, "Duyệt & Spam, Giao diện");
      await expectText(page, "Lưu thay đổi");
      await dialog.getByRole("button", { name: "Hủy" }).click();
      await expectText(page, "Có thay đổi chưa lưu");
      assert.equal(await page.getByRole("switch", { name: "Hiển thị tiêu đề đánh giá" }).isChecked(), false, "cancelling must keep the edited switch");
    });

    await scenario("S7", "import checks the file, shows the row summary, and only then writes", async ({ page, requests, state }) => {
      await go(page, withStore("/reviews"));
      await page.getByRole("button", { name: "Nhập CSV/JSON" }).click();
      const area = page.locator(".ant-modal-content textarea");
      await expectVisible(area, "import textarea");
      await area.fill("product_id,review_id,rating,author,content,status\n1001,imp-1,5,Khách Nhập,Một dòng nhập,approved\n1001,imp-2,4,Khách Hai,Dòng thứ hai,approved");
      await page.getByRole("button", { name: "Kiểm tra dữ liệu" }).click();
      await waitUntil(() => requests.some((r) => r.pathname === "/api/admin/reviews/import/dry-run"));
      const dry = requests.find((r) => r.pathname === "/api/admin/reviews/import/dry-run");
      assert.equal(dry.payload?.dryRun, true, "dry-run request must be flagged as a check");
      assert.equal(dry.payload?.format, "csv");
      await expectText(page, "Tạo mới: 2");
      await expectText(page, "Lỗi: 0");
      await page.getByRole("button", { name: "Nhập 2 mục" }).click();
      await waitUntil(() => state.persisted.imports.length === 1);
      assert.equal(state.persisted.imports[0].dryRun, false, "apply must not be flagged as a check");
      assert.equal(await page.locator(".ant-modal-content").count(), 1, "the dialog stays open to show what was written");
    });

    await scenario("S6", "switching tabs keeps the draft, marks the tab, and one save persists every tab", async ({ page, state }) => {
      await go(page, withStore("/settings"));
      const title = page.getByText("Tiêu đề widget", { exact: true }).locator("xpath=ancestor::div[1]//input").first();
      await expectVisible(title, "title input");
      await title.fill("Chưa lưu");
      await expectVisible(page.locator(".f1g-tab-dot").first(), "unsaved dot");
      await page.getByRole("tab", { name: /Form gửi/ }).click();
      assert.ok(await page.locator(".f1g-tab-dot").count() >= 1, "the dirty tab keeps its marker after switching");
      await page.getByRole("switch", { name: "Cho phép hình ảnh đánh giá" }).click();
      await page.getByRole("tab", { name: /Hiển thị/ }).click();
      await expectVisible(title, "title input");
      assert.equal(await title.inputValue(), "Chưa lưu", "the draft must survive a tab switch");
      await page.getByRole("button", { name: "Lưu thay đổi" }).click();
      await waitUntil(() => state.persisted.widgetPuts.length > 0);
      assert.equal(state.widgetConfig.titleText, "Chưa lưu");
      await waitUntil(() => state.widgetConfig.allowImage === false);
      await waitUntil(async () => (await page.locator(".f1g-tab-dot").count()) === 0);
      assert.equal(await page.locator(".f1g-tab-dot").count(), 0, "dots clear after a successful save");
    });

    console.log("\n--- authentication ---");
    await scenario("A1", "no session: a deep link goes to the login form and remembers the target", { auth: false }, async ({ page }) => {
      await go(page, withStore("/reviews", OTHER_STORE));
      await page.waitForURL(/\/install\/login/, { timeout: 8000 });
      await expectVisible(page.getByLabel("Tên cửa hàng"), "store input");
      assert.equal(new URL(page.url()).searchParams.get("storeDomain"), OTHER_STORE);
      assert.equal(await page.getByLabel("Tên cửa hàng").inputValue(), OTHER_STORE, "store field not prefilled from the URL");
    });

    await scenario("A2", "login form rejects a non-Sapo domain without calling the server", { auth: false }, async ({ page, requests }) => {
      await go(page, "/install/login");
      const input = page.getByLabel("Tên cửa hàng");
      await input.fill("not a store.example.com");
      await page.getByRole("button", { name: "Tiếp tục" }).click();
      await expectVisible(page.getByRole("alert"), "validation error");
      assert(!requests.some((r) => r.pathname.startsWith("/api/oauth/")), "server called for an invalid store");
    });

    await scenario("A3", "login form turns a bare handle into the .mysapo.net authorize URL and navigates top-level", { auth: false }, async ({ page, requests, state }) => {
      const authorizeUrl = `https://${STORE}/admin/oauth/authorize?client_id=e2e&state=sapo_oauth_x`;
      let navigated = null;
      const entryCalls = [];
      await page.route(/^https:\/\/e2e-shop\.mysapo\.net\/.*/, async (route) => {
        navigated = route.request().url();
        await route.fulfill({ status: 200, contentType: "text/html", body: "<title>authorize</title>" });
      });
      await page.context().route("**/api/oauth/install/login/entry**", (route) => {
        entryCalls.push({ rawUrl: route.request().url(), headers: route.request().headers() });
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ url: authorizeUrl }) });
      });
      await go(page, "/install/login");
      await page.getByLabel("Tên cửa hàng").fill("E2E-Shop");
      await page.getByRole("button", { name: "Tiếp tục" }).click();
      await waitUntil(() => navigated !== null, { timeout: 8000 });
      assert.equal(navigated, authorizeUrl);
      const entry = entryCalls[0];
      assert(entry, "entry endpoint not called");
      assert.equal(new URL(entry.rawUrl).searchParams.get("storeDomain"), STORE);
      assert.equal(entry.headers.authorization, undefined, "OAuth entry must not carry a session bearer");
    });

    await scenario("A4", "Sapo launch URL is forwarded byte-for-byte to verify-hmac, exchanged once, and lands on the dashboard", { auth: false }, async ({ page, requests, state }) => {
      const rawQuery = `hmac=Zm9v%2Bbar%2FbazAAAAAAAAAAAAAAAAAAAAAAAAAAAAA%3D&store=${STORE}&timestamp=1700000000`;
      const resolve = (pathname, method, payload) => {
        if (pathname === "/api/oauth/install/login/verify-hmac") {
          return { status: 200, body: { storeDomain: STORE, handoffCode: `sapo_handoff_${"a".repeat(64)}`, redirectTo: "/dashboard" } };
        }
        if (pathname === "/api/auth/session/exchange" && method === "POST") {
          state.exchanges += 1;
          return { status: 201, body: { ok: true, storeDomain: STORE, redirectTo: "/dashboard", sessionToken: "launch-session-token" } };
        }
        return undefined;
      };
      await mockApi(page.context(), { resolve, state });
      await go(page, `/?${rawQuery}`);
      await waitUntil(() => new URL(page.url()).pathname === "/" && new URL(page.url()).searchParams.get("storeDomain") === STORE && !page.url().includes("hmac="));
      const verify = requests.find((r) => r.pathname === "/api/oauth/install/login/verify-hmac");
      assert(verify, "verify-hmac was not called");
      assert.equal(new URL(verify.rawUrl).search.slice(1), rawQuery, "the signed query was altered before reaching the server");
      assert.equal(state.exchanges, 1, `handoff exchanged ${state.exchanges} times`);
      assert.ok(!page.url().includes("hmac="), "hmac left in the final URL");
      const stored = await page.evaluate(() => ({
        token: window.localStorage.getItem("auth_session_token:e2e-shop.mysapo.net") || window.sessionStorage.getItem("auth_session_token:e2e-shop.mysapo.net"),
        cookie: document.cookie,
      }));
      assert.equal(stored.token, "launch-session-token");
      assert.ok(!/auth_session_token/.test(stored.cookie), "the session token was written to a JS-readable cookie");
    });

    await scenario("A5", "an invalid or expired launch URL shows the launch error and the login form", { auth: false }, async ({ page, requests }) => {
      await page.context().route("**/api/oauth/install/login/verify-hmac**", (route) =>
        route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ message: "Invalid hmac" }) }),
      );
      await go(page, `/?hmac=AAAA%3D&store=${STORE}&timestamp=1`);
      await expectText(page, "Liên kết khởi chạy từ Sapo không hợp lệ", "launch_invalid notice");
      await expectVisible(page.getByLabel("Tên cửa hàng"), "login form");
      assert(!requests.some((r) => r.pathname === "/api/auth/session/exchange"), "exchange attempted after a rejected launch");
    });

    await scenario("A6", "OAuth return with a handoff code exchanges it once and strips it from the URL", { auth: false }, async ({ page, requests, state }) => {
      const resolve = (pathname, method) => {
        if (pathname === "/api/auth/session/exchange" && method === "POST") {
          state.exchanges += 1;
          return { status: 201, body: { ok: true, storeDomain: STORE, redirectTo: "/reviews", sessionToken: "handoff-session-token" } };
        }
        return undefined;
      };
      await mockApi(page.context(), { resolve, state });
      await go(page, `/?storeDomain=${STORE}&handoff_code=sapo_handoff_${"b".repeat(64)}`);
      await waitUntil(() => !page.url().includes("handoff_code"));
      assert.ok(!page.url().includes("handoff_code"), `handoff code still in the URL: ${page.url()}`);
      assert.equal(state.exchanges, 1, `handoff exchanged ${state.exchanges} times`);
      const exchange = requests.find((r) => r.pathname === "/api/auth/session/exchange");
      assert.deepEqual(exchange.payload, { handoffCode: `sapo_handoff_${"b".repeat(64)}` });
      assert.equal(exchange.headers.authorization, undefined, "handoff exchange must not carry a stale bearer");
    });

    await scenario("A7", "a rejected handoff code lands on the login form with the handoff error, not a loop", { auth: false }, async ({ page, requests }) => {
      let exchangeCalls = 0;
      await page.context().route("**/api/auth/session/exchange", (route) => {
        exchangeCalls += 1;
        return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ message: "Invalid handoff" }) });
      });
      await go(page, `/?storeDomain=${STORE}&handoff_code=sapo_handoff_${"c".repeat(64)}`);
      await expectText(page, "Không tạo được phiên đăng nhập", "handoff_failed notice");
      await sleep(800);
      assert.equal(exchangeCalls, 1, "handoff retried");
    });

    await scenario("A8", "a 401 mid-session clears that store's session and returns to login with the expiry notice", async ({ page }) => {
      await page.context().route("**/api/admin/reviews?**", (route) =>
        route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ message: "expired" }) }),
      );
      await go(page, withStore("/reviews"), { settle: false });
      await page.waitForURL(/\/install\/login/, { timeout: 10000 });
      await expectText(page, "Phiên đăng nhập đã hết hạn", "session_expired notice");
      const token = await page.evaluate((store) => window.localStorage.getItem(`auth_session_token:${store}`) || window.sessionStorage.getItem(`auth_session_token:${store}`), STORE);
      assert.equal(token, null, "expired session token was kept");
    });

    await scenario("A9", "a session for store A is not honored for store B in the URL", async ({ page, requests }) => {
      await go(page, withStore("/reviews", OTHER_STORE));
      await page.waitForURL(/\/install\/login/, { timeout: 8000 });
      assert(!requests.some((r) => r.pathname.startsWith("/api/admin/")), `admin API called with another store's session: ${requests.map((r) => r.pathname).join(",")}`);
    });

    await scenario("A10", "an invalid storeDomain in the URL is ignored (no API call, login form)", { auth: false }, async ({ page, requests }) => {
      await go(page, "/reviews?storeDomain=../../etc/passwd");
      await page.waitForURL(/\/install\/login/, { timeout: 8000 });
      assert(!requests.some((r) => r.pathname.startsWith("/api/admin/")), "admin API called for an invalid store");
      assert.ok(!decodeURIComponent(page.url()).includes("etc/passwd"), "invalid store was echoed into the login URL");
    });

    console.log("\n--- accessibility ---");
    await scenario("K1", "login form is operable by keyboard: label, Tab to the button, Enter submits", { auth: false }, async ({ page, requests }) => {
      let entryCalled = false;
      await page.context().route("**/api/oauth/install/login/entry**", (route) => {
        entryCalled = true;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ url: `https://${STORE}/admin/oauth/authorize?x=1` }) });
      });
      await go(page, "/install/login");
      const input = page.getByLabel("Tên cửa hàng");
      await input.focus();
      await page.keyboard.type(STORE);
      await page.keyboard.press("Enter");
      await waitUntil(() => entryCalled, { timeout: 6000 });
      assert(entryCalled, "Enter did not submit the form");
    });

    await scenario("K2", "icon-only moderation buttons expose accessible names", async ({ page }) => {
      await go(page, withStore("/reviews"));
      await expectText(page, "Khách Chờ Duyệt");
      for (const name of ["Chỉnh sửa", "Duyệt", "Ẩn", "Xóa"]) {
        assert((await page.getByRole("button", { name, exact: true }).count()) > 0, `no button named "${name}"`);
      }
    });

    await sleep(100);
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    killTree(preview.proc);
    try {
      closeSync(preview.log);
      await sleep(300);
      unlinkSync(preview.logPath);
    } catch {
      /* log cleanup is best effort */
    }
  }

  const failed = results.filter((r) => !r.passed);
  const report = {
    suite: SUITE,
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    verdict: failed.length === 0 ? "PASS" : "FAIL",
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    cases: results,
  };
  writeJson(path.join(ARTIFACTS_DIR, "report.json"), report);
  console.log(`\n${report.verdict} ${SUITE}: ${report.passed}/${report.total} passed (${report.durationMs}ms)`);
  if (failed.length) {
    console.error("Failures:");
    for (const f of failed) console.error(` - ${f.id} ${f.name}`);
  }
  process.exitCode = failed.length ? 1 : 0;
}

const assert = require("node:assert/strict");

main().catch((error) => {
  console.error(`FAIL ${SUITE}: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
