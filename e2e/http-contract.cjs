const assert = require("node:assert/strict");
const crypto = require("crypto");
const path = require("path");
const { mkdirSync, writeFileSync } = require("fs");

const { sleep, isPortFree, randomSuffix, redact } = require("./lib/util.cjs");
const { call, findDeep, collectKeys, launchQueryString, hmacOf, mintSession, TINY_PNG, uploadForm } = require("./lib/http.cjs");
const { createSapoStub } = require("./lib/sapo-stub.cjs");
const { createR2WorkerStub } = require("./lib/r2-worker-stub.cjs");
const { seedCatalogProducts } = require("./lib/seed.cjs");
const infra = require("./lib/infra.cjs");

const SUITE = "e2e-server-http-contract";
const SERVER_PORT = Number(process.env.E2E_SERVER_PORT || 4301);
const STUB_PORT = Number(process.env.E2E_STUB_PORT || 4302);
const FRONTEND_ORIGIN = "http://127.0.0.1:4300";
const BASE = `http://127.0.0.1:${SERVER_PORT}`;
const ARTIFACTS = path.join(__dirname, "artifacts");

const WEBHOOK = {
  signatureHeader: "x-sapo-hmac-sha256",
  topicHeader: "x-sapo-topic",
  eventIdHeader: "x-sapo-event-id",
  signatureEncoding: "base64",
};

const ADMIN_REVIEWS = "/api/admin/reviews";
const ADMIN_QNA = "/api/admin/qna";
const PUBLIC_REVIEWS = "/api/public/reviews";
const PUBLIC_QNA = "/api/public/qna";

const STORE_A = "e2e-alpha.mysapo.net";
const STORE_B = "e2e-beta.mysapo.net";
const STORE_GHOST = "e2e-ghost.mysapo.net";
const STORE_C = "e2e-gamma.mysapo.net";

const PUBLIC_WRITE_LIMIT = 45;
const IDENTITY_RATE_MAX = 30;
const R2_PUBLIC_DOMAIN = "cdn.e2e.test";
const AUTH_LIMIT = 40;

const SECRETS = {
  clientId: `e2e-client-${randomSuffix(4)}`,
  clientSecret: `e2e-client-secret-${randomSuffix(12)}`,
  sessionSecret: `e2e-session-secret-${randomSuffix(24)}`,
  readiness: `e2e-readiness-${randomSuffix(12)}`,
  encryptionKey: crypto.randomBytes(32).toString("hex"),
  uploadSecret: `e2e-upload-secret-${randomSuffix(12)}`,
};

const results = [];
const evidence = [];
const bugs = [];

function brief(res) {
  return `status=${res.status} body=${String(res.raw).slice(0, 240)}`;
}

function expectStatus(res, expected, label = "") {
  const ok = Array.isArray(expected) ? expected.includes(res.status) : res.status === expected;
  assert.ok(ok, `${label}expected status ${expected}, got ${brief(res)}`);
}

async function check(id, name, fn) {
  try {
    await fn();
    results.push({ id, name, passed: true });
    console.log(`  [PASS] ${id} ${name}`);
  } catch (error) {
    const failure = String(error && error.message ? error.message : error);
    results.push({ id, name, passed: false, failure });
    console.error(`  [FAIL] ${id} ${name}\n         ${failure.split("\n").join("\n         ")}`);
  }
}

async function waitFor(predicate, { timeout = 8000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) return value;
    await sleep(interval);
  }
}

async function main() {
  const startedAt = Date.now();
  mkdirSync(ARTIFACTS, { recursive: true });

  for (const [label, port] of [["server", SERVER_PORT], ["Sapo stub", STUB_PORT]]) {
    if (!(await isPortFree(port))) {
      throw new Error(`${label} port ${port} is already in use; stop the owner instead of moving ports.`);
    }
  }

  const state = await infra.resolveStateBackend();
  const db = await infra.createThrowawayDatabase();
  let prisma = null;
  let server = null;
  let stub = null;
  const cleanupErrors = [];
  const allResponses = [];

  try {
    const migrationTail = infra.migrateDeploy(db.url);
    console.log(`Throwaway database ${db.dbName} migrated.`);
    console.log(`State backend: ${state.kind}${state.kind === "redis" ? ` ${state.host}:${state.port}` : ""}`);

    const r2 = createR2WorkerStub({ uploadSecret: SECRETS.uploadSecret });
    stub = createSapoStub({ clientId: SECRETS.clientId, clientSecret: SECRETS.clientSecret, fallback: r2.handle });
    await stub.listen(STUB_PORT);
    prisma = infra.connectPrisma(db.url);

    const serverEnv = {
      NODE_ENV: "development",
      PORT: String(SERVER_PORT),
      FRONTEND_URL: FRONTEND_ORIGIN,
      API_BASE_URL: BASE,
      CORS_ALLOWED_ORIGINS: FRONTEND_ORIGIN,
      TRUST_PROXY: "1",
      REQUEST_BODY_LIMIT: "1mb",
      WEBHOOK_BODY_LIMIT: "256kb",
      SAPO_CLIENT_ID: SECRETS.clientId,
      SAPO_CLIENT_SECRET: SECRETS.clientSecret,
      SAPO_SCOPE: "read_products,write_products,read_orders",
      SAPO_INSTALL_CALLBACK_URL: `${BASE}/api/oauth/install/callback`,
      SAPO_LOGIN_CALLBACK_URL: `${BASE}/api/oauth/install/login/callback`,
      SAPO_API_MAX_CONCURRENT: "4",
      APP_SESSION_SECRET: SECRETS.sessionSecret,
      APP_SESSION_TTL_SECONDS: "3600",
      SESSION_HANDOFF_TTL_SECONDS: "120",
      SESSION_COOKIE_NAME: "sapo_app_session",
      SESSION_COOKIE_DOMAIN: "",
      REDIS_HOST: state.kind === "redis" ? state.host : "",
      REDIS_PORT: String(state.kind === "redis" ? state.port : 6379),
      REDIS_USERNAME: "",
      REDIS_PASSWORD: "",
      REDIS_TLS: "false",
      REDIS_KEY_PREFIX: state.prefix,
      DATABASE_URL: db.url,
      DIRECT_URL: db.url,
      DATA_ENCRYPTION_KEY: SECRETS.encryptionKey,
      AUTH_RATE_LIMIT_WINDOW_SECONDS: "60",
      AUTH_RATE_LIMIT_MAX: String(AUTH_LIMIT),
      SESSION_EXCHANGE_RATE_LIMIT_MAX: "200",
      PUBLIC_WRITE_RATE_LIMIT_WINDOW_SECONDS: "60",
      PUBLIC_WRITE_RATE_LIMIT_MAX: String(PUBLIC_WRITE_LIMIT),
      READINESS_TOKEN: SECRETS.readiness,
      BUILD_SHA: "e2e",
      R2_WORKER_URL: `http://127.0.0.1:${STUB_PORT}`,
      R2_UPLOAD_SECRET: SECRETS.uploadSecret,
      R2_PUBLIC_DOMAIN,
    };

    server = await infra.startServer({ port: SERVER_PORT, stubPort: STUB_PORT, env: serverEnv });
    console.log(`Server up on ${BASE}\n`);

    const api = async (route, options) => {
      const res = await call(BASE, route, options);
      allResponses.push({ route, raw: res.raw });
      return res;
    };
    const bearer = (token) => ({ authorization: `Bearer ${token}` });
    const trusted = { origin: FRONTEND_ORIGIN };
    const fromClient = (n) => ({ "x-forwarded-for": `203.0.113.${n}` });
    const shopOf = async (domain) => {
      const shop = await prisma.shop.findUnique({ where: { storeDomain: domain } });
      assert.ok(shop, `no shop row for ${domain}`);
      return shop.id;
    };

    const admin = (session, method, route, { json, headers = {}, origin = true } = {}) =>
      api(route, {
        method,
        json,
        headers: { ...bearer(session.sessionToken), ...(origin ? trusted : {}), ...headers },
      });

    async function startInstall(store) {
      const res = await api(`/api/oauth/install/start?storeDomain=${encodeURIComponent(store)}`);
      expectStatus(res, 200, "install start: ");
      const url = new URL(String(res.raw).replace(/^"|"$/g, "").trim());
      return { res, url, state: url.searchParams.get("state") };
    }

    async function exchange(handoffCode, headers = trusted) {
      return api("/api/auth/session/exchange", { method: "POST", headers, json: { handoffCode } });
    }

    async function install(store, code) {
      const { state: oauthState } = await startInstall(store);
      const cb = await api(
        `/api/oauth/install/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(oauthState)}`,
        { headers: { accept: "application/json" } },
      );
      expectStatus(cb, 200, `install callback ${store}: `);
      const ex = await exchange(cb.body.handoffCode);
      expectStatus(ex, [200, 201], `session exchange ${store}: `);
      return { store, callback: cb, exchange: ex, sessionToken: ex.body.sessionToken, cookie: ex.setCookie[0] };
    }

    console.log("--- health and edge ---");
    await check("H1", "/livez answers 200 {ok:true} without auth", async () => {
      const res = await api("/livez");
      expectStatus(res, 200);
      assert.equal(res.body && res.body.ok, true, brief(res));
    });

    await check("H2", "/readyz is 401 without a token and with a wrong token", async () => {
      const none = await api("/readyz");
      expectStatus(none, 401, "no token: ");
      assert.equal(none.body.statusCode, 401, brief(none));
      const wrong = await api("/readyz", { headers: bearer("not-the-token") });
      expectStatus(wrong, 401, "wrong token: ");
    });

    await check("H3", "/readyz with the token reports db/redis ok and exposes no secret", async () => {
      const res = await api("/readyz", { headers: bearer(SECRETS.readiness) });
      expectStatus(res, 200);
      assert.equal(res.body.ok, true, brief(res));
      assert.equal(res.body.db, "ok", brief(res));
      assert.equal(res.body.redis, "ok", brief(res));
      for (const secret of Object.values(SECRETS)) assert.ok(!res.raw.includes(secret), "readyz leaked a configured secret");
    });

    await check("H4", "header hygiene: no x-powered-by, API responses are no-store", async () => {
      const live = await api("/livez");
      assert.equal(live.headers["x-powered-by"], undefined, "x-powered-by present on /livez");
      const apiRes = await api(`${PUBLIC_REVIEWS}/1001/summary`, { headers: { "x-store-domain": STORE_GHOST } });
      assert.equal(apiRes.headers["x-powered-by"], undefined, "x-powered-by present on /api");
      assert.match(String(apiRes.headers["cache-control"] || ""), /no-store/, "API response is cacheable");
    });

    await check("H5", "unknown route returns a Nest 404 with no stack trace", async () => {
      const res = await api("/api/definitely-not-a-route");
      expectStatus(res, 404);
      assert.equal(res.body.statusCode, 404, brief(res));
      assert.ok(!/\n\s+at /.test(res.raw) && !res.raw.includes("node_modules"), `stack trace leaked: ${res.raw.slice(0, 200)}`);
    });

    await check("H6", "malformed JSON body is a 4xx without a stack trace", async () => {
      const res = await api(`${PUBLIC_REVIEWS}/1001`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-store-domain": STORE_A },
        body: '{"invalid": json',
      });
      assert.ok(res.status >= 400 && res.status < 500, brief(res));
      assert.ok(!/\n\s+at /.test(res.raw) && !res.raw.includes("node_modules"), `stack trace leaked: ${res.raw.slice(0, 200)}`);
    });

    await check("H7", "2 MB body is rejected 4xx and the server survives", async () => {
      const res = await api(`${PUBLIC_REVIEWS}/1001`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-store-domain": STORE_A },
        body: JSON.stringify({ author: "x", content: "x".repeat(2 * 1024 * 1024) }),
      });
      assert.ok(res.status === 413 || (res.status >= 400 && res.status < 500), brief(res));
      expectStatus(await api("/livez"), 200, "after oversized body: ");
    });

    await check("H8", "CORS: public routes echo the origin without wildcard; admin routes refuse unknown origins", async () => {
      const pub = await api(`${PUBLIC_REVIEWS}/1001/summary`, {
        method: "OPTIONS",
        headers: { origin: "https://shop.example.com", "access-control-request-method": "GET" },
      });
      expectStatus(pub, [200, 204], "public preflight: ");
      assert.equal(pub.headers["access-control-allow-origin"], "https://shop.example.com");
      assert.notEqual(pub.headers["access-control-allow-origin"], "*");
      const evil = await api(`${ADMIN_REVIEWS}`, {
        method: "OPTIONS",
        headers: { origin: "https://evil.example.com", "access-control-request-method": "PATCH" },
      });
      expectStatus(evil, 403, "admin preflight from unknown origin: ");
      assert.equal(evil.headers["access-control-allow-origin"], undefined);
      const good = await api(`${ADMIN_REVIEWS}`, {
        method: "OPTIONS",
        headers: { origin: FRONTEND_ORIGIN, "access-control-request-method": "PATCH" },
      });
      expectStatus(good, [200, 204], "admin preflight from frontend: ");
      assert.equal(good.headers["access-control-allow-origin"], FRONTEND_ORIGIN);
    });

    console.log("\n--- OAuth install ---");
    await check("O1", "install start rejects missing and non-Sapo store domains", async () => {
      expectStatus(await api("/api/oauth/install/start"), 400, "missing: ");
      for (const bad of ["other.example.com", "evil.mysapo.net.attacker.com", "-bad.mysapo.net", "a b.mysapo.net"]) {
        const res = await api(`/api/oauth/install/start?storeDomain=${encodeURIComponent(bad)}`);
        expectStatus(res, 400, `${bad}: `);
      }
    });

    await check("O2", "authorize URL targets the store, uses comma-separated scopes and our callback", async () => {
      const { url, state: oauthState } = await startInstall(STORE_A);
      assert.equal(url.origin, `https://${STORE_A}`);
      assert.equal(url.pathname, "/admin/oauth/authorize");
      assert.equal(url.searchParams.get("client_id"), SECRETS.clientId);
      assert.equal(url.searchParams.get("scope"), "read_products,write_products,read_orders");
      assert.equal(url.searchParams.get("redirect_uri"), `${BASE}/api/oauth/install/callback`);
      assert.match(oauthState, /^sapo_oauth_[a-f0-9]{64}$/);
      assert.ok(!url.search.includes(SECRETS.clientSecret), "client secret in authorize URL");
    });

    await check("O3", "login start builds an authorize URL pointing at the login callback", async () => {
      const res = await api(`/api/oauth/install/login?storeDomain=${STORE_A}`, { headers: { accept: "application/json" } });
      expectStatus(res, 200);
      const url = new URL(String(res.raw).replace(/^"|"$/g, "").trim());
      assert.equal(url.searchParams.get("redirect_uri"), `${BASE}/api/oauth/install/login/callback`);
      expectStatus(await api("/api/oauth/install/login"), 400, "no store: ");
    });

    const sessions = {};
    await check("O4", "install callback with a valid state creates the install and returns a single-use handoff", async () => {
      sessions.A = await install(STORE_A, "e2e-code-alpha");
      const body = sessions.A.callback.body;
      assert.equal(body.storeDomain, STORE_A);
      assert.match(body.handoffCode, /^sapo_handoff_[a-f0-9]{64}$/);
      assert.ok(!sessions.A.callback.raw.includes("e2e-token-"), "Sapo access token leaked in install response");
      const installRow = await prisma.appInstall.findUnique({ where: { storeDomain: STORE_A } });
      assert.equal(installRow.status, "active");
      assert.ok(installRow.accessTokenCiphertext, "token was not persisted");
      assert.ok(!JSON.stringify(installRow).includes("e2e-token-"), "access token stored in plaintext");
    });

    await check("O5", "replayed, malformed, missing and wrong-flow states are rejected", async () => {
      const first = await startInstall(STORE_A);
      const ok = await api(`/api/oauth/install/callback?code=e2e-code-alpha&state=${first.state}`, { headers: { accept: "application/json" } });
      expectStatus(ok, [200, 201]);
      const replay = await api(`/api/oauth/install/callback?code=e2e-code-alpha&state=${first.state}`, { headers: { accept: "application/json" } });
      expectStatus(replay, 401, "replayed state: ");
      expectStatus(await api("/api/oauth/install/callback?code=e2e-code-alpha&state=garbage", { headers: { accept: "application/json" } }), 401, "malformed: ");
      expectStatus(await api("/api/oauth/install/callback?code=e2e-code-alpha", { headers: { accept: "application/json" } }), 401, "missing state: ");
      const unknown = `sapo_oauth_${"a".repeat(64)}`;
      expectStatus(await api(`/api/oauth/install/callback?code=e2e-code-alpha&state=${unknown}`, { headers: { accept: "application/json" } }), 401, "unknown state: ");
      const loginUrl = await api(`/api/oauth/install/login?storeDomain=${STORE_A}`, { headers: { accept: "application/json" } });
      const loginState = new URL(String(loginUrl.raw).replace(/^"|"$/g, "").trim()).searchParams.get("state");
      const crossFlow = await api(`/api/oauth/install/callback?code=e2e-code-alpha&state=${loginState}`, { headers: { accept: "application/json" } });
      expectStatus(crossFlow, 401, "login state at install callback: ");
    });

    await check("O6", "install callback POST requires a code; a code Sapo refuses never yields a handoff", async () => {
      const { state: oauthState } = await startInstall(STORE_A);
      const noCode = await api("/api/oauth/install/callback", { method: "POST", json: { state: oauthState } });
      expectStatus(noCode, 400, "missing code: ");
      const bad = await api("/api/oauth/install/callback", { method: "POST", json: { code: "bad-code", state: oauthState } });
      assert.ok(bad.status >= 400 && bad.status < 500, `Sapo rejecting the code must surface as a client error, got ${brief(bad)}`);
      assert.ok(!String(bad.raw).includes("handoffCode"), "handoff issued for a refused code");
    });

    await check("O7", "browser install callback redirects with a handoff code and never puts the session JWT in the URL", async () => {
      const { state: oauthState } = await startInstall(STORE_A);
      const res = await api(`/api/oauth/install/callback?code=e2e-code-alpha&state=${oauthState}`, { headers: { accept: "text/html" } });
      expectStatus(res, 302);
      const location = new URL(res.headers.location);
      assert.equal(location.origin, FRONTEND_ORIGIN);
      assert.match(location.searchParams.get("handoff_code") || "", /^sapo_handoff_[a-f0-9]{64}$/);
      assert.ok(!/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(res.headers.location), "JWT leaked into redirect URL");
      assert.ok(res.setCookie.length === 1 && /HttpOnly/i.test(res.setCookie[0]), "session cookie must be HttpOnly");
    });

    await check("O8", "handoff exchange: needs a trusted origin, is single-use, sets an HttpOnly SameSite cookie", async () => {
      const { state: oauthState } = await startInstall(STORE_A);
      const cb = await api(`/api/oauth/install/callback?code=e2e-code-alpha&state=${oauthState}`, { headers: { accept: "application/json" } });
      const code = cb.body.handoffCode;
      expectStatus(await exchange(code, {}), 401, "no origin: ");
      expectStatus(await exchange(code, { origin: "https://evil.example.com" }), 401, "untrusted origin: ");
      expectStatus(await exchange("sapo_handoff_deadbeef"), 401, "malformed code: ");
      const ok = await exchange(code);
      expectStatus(ok, [200, 201]);
      assert.equal(ok.body.storeDomain, STORE_A);
      const cookie = ok.setCookie[0] || "";
      assert.match(cookie, /^sapo_app_session=/);
      assert.match(cookie, /HttpOnly/i);
      assert.match(cookie, /SameSite=Lax/i);
      assert.match(cookie, /Path=\//);
      expectStatus(await exchange(code), 401, "replayed handoff: ");
    });

    await check("O9", "install registers webhooks for the documented topics against our receiver", async () => {
      const registered = await waitFor(async () => {
        const row = await prisma.appInstall.findUnique({ where: { storeDomain: STORE_A } });
        return row.webhookRegistrationStatus === "registered" ? row : null;
      });
      assert.ok(registered, "webhookRegistrationStatus never became registered");
      const posts = stub.callsFor(STORE_A, (c) => c.method === "POST" && c.path === "/admin/webhooks.json");
      const topics = posts.map((c) => c.body.webhook.topic);
      for (const required of ["app/uninstalled", "products/update", "orders/create"]) {
        assert.ok(topics.includes(required), `no subscription for ${required}; got ${topics.join(",")}`);
      }
      assert.ok(!topics.includes("app/charge"), "app/charge must not be subscribed");
      assert.ok(!topics.includes("shop/update"), "legacy shop/update must not be subscribed");
      for (const call of posts) {
        assert.equal(call.body.webhook.address, `${BASE}/api/oauth/install/webhooks`);
        assert.ok(call.token && call.token.startsWith("e2e-token-"), "webhook registration did not use the store token");
      }
    });

    console.log("\n--- launch URL (hmac) ---");
    const nowSec = () => Math.floor(Date.now() / 1000);
    const launch = (params, encoding) => `/api/oauth/install/login/verify-hmac?${launchQueryString(params, SECRETS.clientSecret, encoding)}`;

    await check("L1", "signed launch (Base64 hmac, store+timestamp) yields a handoff for that store", async () => {
      const res = await api(launch({ store: STORE_A, timestamp: String(nowSec()) }));
      expectStatus(res, 200);
      assert.equal(res.body.storeDomain, STORE_A);
      assert.match(res.body.handoffCode, /^sapo_handoff_[a-f0-9]{64}$/);
      const ex = await exchange(res.body.handoffCode);
      expectStatus(ex, [200, 201], "exchange: ");
      sessions.launchA = { sessionToken: ex.body.sessionToken };
    });

    await check("L2", "launch with a hex-encoded hmac is rejected", async () => {
      expectStatus(await api(launch({ store: STORE_A, timestamp: String(nowSec()) }, "hex")), 401);
    });

    await check("L3", "launch with a tampered store, an extra parameter, or the wrong secret is rejected", async () => {
      const params = { store: STORE_A, timestamp: String(nowSec()) };
      const qs = launchQueryString(params, SECRETS.clientSecret);
      expectStatus(await api(`/api/oauth/install/login/verify-hmac?${qs.replace(STORE_A, STORE_B)}`), 401, "tampered store: ");
      expectStatus(await api(`/api/oauth/install/login/verify-hmac?${qs}&extra=1`), 401, "appended parameter: ");
      expectStatus(
        await api(`/api/oauth/install/login/verify-hmac?${launchQueryString(params, SECRETS.sessionSecret)}`),
        401,
        "signed with the session secret: ",
      );
      expectStatus(await api(`/api/oauth/install/login/verify-hmac?hmac=${"A".repeat(43)}=&store=${STORE_A}&timestamp=${nowSec()}`), 401, "forged: ");
    });

    await check("L4", "launch with an expired or far-future timestamp is rejected", async () => {
      expectStatus(await api(launch({ store: STORE_A, timestamp: String(nowSec() - 400) })), 401, "expired: ");
      expectStatus(await api(launch({ store: STORE_A, timestamp: String(nowSec() + 400) })), 401, "future: ");
      expectStatus(await api(launch({ store: STORE_A, timestamp: "abc" })), 401, "non-numeric: ");
    });

    await check("L5", "launch without an hmac does not authenticate (falls back to the OAuth login redirect)", async () => {
      const res = await api(`/api/oauth/install/login/verify-hmac?store=${STORE_A}&timestamp=${nowSec()}`);
      assert.ok(!String(res.raw).includes("handoffCode"), `handoff issued without hmac: ${brief(res)}`);
      assert.ok(res.status === 400 || (res.status === 200 && /\/admin\/oauth\/authorize/.test(res.raw)), brief(res));
    });

    await check("L6", "a launch for a store with no install cannot read any admin data", async () => {
      const res = await api(launch({ store: "e2e-never-installed.mysapo.net", timestamp: String(nowSec()) }));
      expectStatus(res, 200);
      const ex = await exchange(res.body.handoffCode);
      expectStatus(ex, 401, "session exchange for an un-installed store: ");
      assert.ok(!String(ex.raw).includes("sessionToken"), "a session token was issued for an un-installed store");
      assert.equal(ex.setCookie.length, 0, "a session cookie was issued for an un-installed store");
      const forged = mintSession(
        { storeDomain: "e2e-never-installed.mysapo.net", type: "sapo_app_session", gen: 0, iat: nowSec(), exp: nowSec() + 600 },
        SECRETS.sessionSecret,
      );
      const probe = await admin({ sessionToken: forged }, "GET", "/api/app/session");
      expectStatus(probe, 401, "session probe for un-installed store: ");
      const list = await admin({ sessionToken: forged }, "GET", `${ADMIN_REVIEWS}?limit=5`);
      expectStatus(list, 401, "review list for un-installed store: ");
    });

    console.log("\n--- admin authentication ---");
    await check("A0", "re-running the install callback retires sessions minted before it", async () => {
      const before = sessions.A;
      sessions.A = await install(STORE_A, "e2e-code-alpha");
      expectStatus(await admin(before, "GET", "/api/app/session"), 401, "session minted before the reinstall: ");
      expectStatus(await admin(sessions.A, "GET", "/api/app/session"), 200, "session minted by the reinstall: ");
    });

    await check("A1", "session probe works with Bearer and with the cookie", async () => {
      const viaBearer = await admin(sessions.A, "GET", "/api/app/session");
      expectStatus(viaBearer, 200);
      assert.equal(viaBearer.body.data.storeDomain, STORE_A);
      const cookieOnly = await api("/api/app/session", { headers: { cookie: sessions.A.cookie.split(";")[0] } });
      expectStatus(cookieOnly, 200, "cookie: ");
      assert.equal(cookieOnly.body.data.storeDomain, STORE_A);
      for (const text of [viaBearer.raw, cookieOnly.raw]) assert.ok(!/accessToken|e2e-token-/i.test(text), "probe leaked the Sapo token");
    });

    const unauthenticated = [
      ["GET", `${ADMIN_REVIEWS}?limit=5`],
      ["GET", `${ADMIN_REVIEWS}/1001`],
      ["POST", `${ADMIN_REVIEWS}/1001`, { rating: 5, author: "x", content: "y" }],
      ["PATCH", `${ADMIN_REVIEWS}/1001/some-review/status`, { status: "approved" }],
      ["PATCH", `${ADMIN_REVIEWS}/1001/some-review/reply`, { reply: "hi" }],
      ["PATCH", `${ADMIN_REVIEWS}/1001/some-review/pin`, {}],
      ["DELETE", `${ADMIN_REVIEWS}/1001/some-review`],
      ["PUT", `${ADMIN_REVIEWS}/widget-config`, { titleText: "x" }],
      ["PUT", `${ADMIN_REVIEWS}/spam-config`, { blockedWords: [] }],
      ["POST", `${ADMIN_REVIEWS}/sync-metafield`, {}],
      ["GET", `${ADMIN_QNA}?limit=5`],
      ["PATCH", `${ADMIN_QNA}/1001/some-question/answer`, { answer: "x" }],
      ["PATCH", `${ADMIN_QNA}/1001/some-question/status`, { status: "approved" }],
      ["DELETE", `${ADMIN_QNA}/1001/some-question`],
      ["GET", "/api/admin/dashboard/overview"],
      ["GET", "/api/admin/products"],
      ["GET", "/api/admin/ops/health"],
      ["POST", "/api/admin/ops/resync-webhooks", {}],
      ["POST", "/api/admin/ops/backfill-catalog", {}],
      ["POST", "/api/admin/media/upload-ticket", {}],
      ["GET", "/api/app/session"],
    ];

    await check("A2", "every admin read and mutation without credentials is 401 (even from a trusted origin)", async () => {
      const failures = [];
      for (const [method, route, json] of unauthenticated) {
        const res = await api(route, { method, json, headers: trusted });
        if (res.status !== 401) failures.push(`${method} ${route} -> ${res.status} ${String(res.raw).slice(0, 80)}`);
      }
      assert.deepEqual(failures, [], `unauthenticated requests not rejected:\n${failures.join("\n")}`);
    });

    await check("A3", "forged, expired, wrong-type and unsigned tokens are 401", async () => {
      const exp = nowSec() + 600;
      const { lifecycleGeneration: gen } = await prisma.appInstall.findUnique({ where: { storeDomain: STORE_A } });
      const payload = { storeDomain: STORE_A, type: "sapo_app_session", gen, iat: nowSec(), exp };
      const tokens = {
        wrongSecret: mintSession(payload, "not-the-session-secret"),
        expired: mintSession({ ...payload, exp: nowSec() - 10 }, SECRETS.sessionSecret),
        wrongType: mintSession({ ...payload, type: "handoff" }, SECRETS.sessionSecret),
        noStore: mintSession({ type: "sapo_app_session", gen, iat: nowSec(), exp }, SECRETS.sessionSecret),
        noGeneration: mintSession({ storeDomain: STORE_A, type: "sapo_app_session", iat: nowSec(), exp }, SECRETS.sessionSecret),
        staleGeneration: mintSession({ ...payload, gen: gen - 1 }, SECRETS.sessionSecret),
        futureGeneration: mintSession({ ...payload, gen: gen + 1 }, SECRETS.sessionSecret),
        unsigned: `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.`,
        garbage: "not.a.token",
      };
      for (const [label, token] of Object.entries(tokens)) {
        expectStatus(await admin({ sessionToken: token }, "GET", "/api/app/session"), 401, `${label}: `);
      }
      const valid = mintSession(payload, SECRETS.sessionSecret);
      expectStatus(await admin({ sessionToken: valid }, "GET", "/api/app/session"), 200, "control token carrying the install's current generation: ");
    });

    await check("A4", "a session cannot be pointed at another store", async () => {
      const res = await admin(sessions.A, "GET", "/api/app/session", { headers: { "x-store-domain": STORE_B } });
      expectStatus(res, 401);
      const viaQuery = await admin(sessions.A, "GET", `${ADMIN_REVIEWS}?storeDomain=${STORE_B}&limit=5`);
      expectStatus(viaQuery, 401, "query override: ");
      expectStatus(await admin(sessions.A, "GET", "/api/app/session", { headers: { "x-store-domain": "not a domain" } }), 400, "invalid domain: ");
    });

    await check("A5", "cookie alone never authorizes a mutation; Bearer needs a trusted Origin", async () => {
      const cookie = sessions.A.cookie.split(";")[0];
      const body = { blockedWords: ["e2e-blocked"] };
      const trustedCookie = await api(`${ADMIN_REVIEWS}/spam-config`, { method: "PUT", headers: { cookie, origin: FRONTEND_ORIGIN }, json: body });
      expectStatus(trustedCookie, 401, "cookie + trusted origin: ");
      const evilCookie = await api(`${ADMIN_REVIEWS}/spam-config`, { method: "PUT", headers: { cookie, origin: "https://evil.example.com" }, json: body });
      expectStatus(evilCookie, 401, "cookie + evil origin: ");
      const evilBearer = await api(`${ADMIN_REVIEWS}/spam-config`, { method: "PUT", headers: { ...bearer(sessions.A.sessionToken), origin: "https://evil.example.com" }, json: body });
      expectStatus(evilBearer, 401, "bearer + evil origin: ");
      const ok = await admin(sessions.A, "PUT", `${ADMIN_REVIEWS}/spam-config`, { json: body });
      expectStatus(ok, 200, "bearer + trusted origin: ");
    });

    console.log("\n--- reviews ---");
    sessions.B = await install(STORE_B, "e2e-code-beta");
    sessions.C = await install(STORE_C, "e2e-code-gamma");
    await seedCatalogProducts(prisma, STORE_A, ["1001", "1002", "1003", "1004", "1005", "1006"]);
    await seedCatalogProducts(prisma, STORE_C, ["2001", "2002", "2003"]);

    const PII = { email: "buyer.private@example.com", phone: "0987654321" };
    const submitHeaders = { "x-store-domain": STORE_A };
    let submittedReview = null;

    await check("R1", "public review submission validates rating, author and lengths", async () => {
      const bad = [
        [{ rating: 0, author: "A" }, "rating 0"],
        [{ rating: 6, author: "A" }, "rating 6"],
        [{ rating: 4.5, author: "A" }, "fractional rating"],
        [{ rating: 5 }, "missing author"],
        [{ rating: 5, author: "A", content: "x".repeat(2001) }, "content too long"],
        [{ rating: 5, author: "A".repeat(101) }, "author too long"],
      ];
      for (const [json, label] of bad) {
        const res = await api(`${PUBLIC_REVIEWS}/1001`, { method: "POST", headers: submitHeaders, json });
        expectStatus(res, 400, `${label}: `);
      }
      expectStatus(await api(`${PUBLIC_REVIEWS}/abc`, { method: "POST", headers: submitHeaders, json: { rating: 5, author: "A" } }), 400, "non-numeric product: ");
      expectStatus(await api(`${PUBLIC_REVIEWS}/1001`, { method: "POST", json: { rating: 5, author: "A" } }), 400, "missing store: ");
      expectStatus(await api(`${PUBLIC_REVIEWS}/1001`, { method: "POST", headers: { "x-store-domain": "no-tld" }, json: { rating: 5, author: "A" } }), 400, "invalid store: ");
    });

    const ownMediaUrl = `https://${R2_PUBLIC_DOMAIN}/reviews/${STORE_A}/1001/${"a".repeat(22)}.jpg`;
    const embedUrl = "https://www.youtube.com/watch?v=e2eEmbed01";
    await check("R2", "a valid public review is stored as pending; only own-store uploads and video embeds survive media sanitising", async () => {
      const res = await api(`${PUBLIC_REVIEWS}/1001`, {
        method: "POST",
        headers: submitHeaders,
        json: {
          rating: 5,
          author: "Nguyen Van A",
          title: "Great",
          content: "Excellent quality, fast delivery.",
          ...PII,
          media: [
            { url: "https://cdn.example.com/a.jpg", type: "image" },
            { url: "http://insecure.example.com/b.jpg", type: "image" },
            { url: `https://${R2_PUBLIC_DOMAIN}/reviews/${STORE_B}/1001/${"b".repeat(22)}.jpg`, type: "image" },
            { url: ownMediaUrl, type: "image" },
            { url: embedUrl, type: "video" },
          ],
        },
      });
      expectStatus(res, [200, 201]);
      submittedReview = res.body.data;
      assert.ok(submittedReview && submittedReview.id, brief(res));
      assert.equal(submittedReview.status, "pending");
      const listed = await api(`${PUBLIC_REVIEWS}/1001`, { headers: submitHeaders });
      expectStatus(listed, 200);
      assert.equal(findDeep(listed.body, (o) => o.id === submittedReview.id).length, 0, "pending review is publicly visible");
      const row = await prisma.reviewProduct.findFirst({ where: { reviewId: submittedReview.id } });
      const media = row.media || [];
      assert.deepEqual(media.map((m) => m.url), [ownMediaUrl, embedUrl], `foreign, insecure, other-store and mistyped media must be dropped; ${brief(res)}`);
    });

    await check("R3", "the submit response does not echo the reviewer's email or phone, and never exposes verified or pinned", async () => {
      assert.ok(submittedReview, "R2 did not produce a review");
      const serialized = JSON.stringify(submittedReview);
      assert.ok(!serialized.includes(PII.email) && !serialized.includes(PII.phone), `submit response echoed contact data: ${serialized.slice(0, 300)}`);
      for (const key of ["email", "phone", "verified", "pinned"]) assert.ok(!(key in submittedReview), `submit response exposes ${key}`);
    });

    await check("R2b", "media sanitising ignores off-path and mistyped URLs and only the first five submitted items are considered", async () => {
      const own = (letter) => `https://${R2_PUBLIC_DOMAIN}/reviews/${STORE_A}/1002/${letter.repeat(22)}.jpg`;
      const res = await api(`${PUBLIC_REVIEWS}/1002`, {
        method: "POST",
        headers: submitHeaders,
        json: {
          rating: 4,
          author: "Media Mix",
          media: [
            { url: `https://${R2_PUBLIC_DOMAIN}/elsewhere/c.jpg`, type: "image" },
            { url: "https://www.youtube.com/watch?v=notAnImage", type: "image" },
            { url: own("c"), type: "image" },
            { url: own("d"), type: "image" },
            { url: own("e"), type: "image" },
            { url: own("f"), type: "image" },
            { url: own("g"), type: "image" },
          ],
        },
      });
      expectStatus(res, [200, 201]);
      const row = await prisma.reviewProduct.findFirst({ where: { reviewId: res.body.data.id } });
      assert.deepEqual((row.media || []).map((m) => m.url), [own("c"), own("d"), own("e")], brief(res));
    });

    await check("R16", "public submissions need a live catalog product: unknown and deleted products are 404 product_not_found", async () => {
      await seedCatalogProducts(prisma, STORE_A, ["1099"], { deleted: true });
      for (const productId of ["9999", "1099"]) {
        const res = await api(`${PUBLIC_REVIEWS}/${productId}`, { method: "POST", headers: submitHeaders, json: { rating: 5, author: "Ghost product" } });
        expectStatus(res, 404, `${productId}: `);
        assert.equal(res.body.code, "product_not_found", brief(res));
      }
      assert.equal(await prisma.reviewProduct.count({ where: { productId: { in: ["9999", "1099"] } } }), 0, "a review was stored for a product that does not exist");
    });

    await check("R4", "admin sees the pending review with its contact data; filters and stats agree", async () => {
      const list = await admin(sessions.A, "GET", `${ADMIN_REVIEWS}?status=pending&limit=50`);
      expectStatus(list, 200);
      const match = findDeep(list.body, (o) => o.id === submittedReview.id)[0];
      assert.ok(match, `review missing from admin pending list: ${list.raw.slice(0, 300)}`);
      assert.equal(match.email, PII.email);
      const stats = await admin(sessions.A, "GET", `${ADMIN_REVIEWS}/1001/stats`);
      expectStatus(stats, 200);
      assert.equal(stats.body.data.pending, 1, brief(stats));
      const bySearch = await admin(sessions.A, "GET", `${ADMIN_REVIEWS}?search=Excellent&limit=50`);
      expectStatus(bySearch, 200);
      assert.ok(findDeep(bySearch.body, (o) => o.id === submittedReview.id).length >= 1, "search did not find the review");
    });

    await check("R5", "admin moderation validates input (status enum, reply length, unknown review)", async () => {
      const base = `${ADMIN_REVIEWS}/1001/${submittedReview.id}`;
      expectStatus(await admin(sessions.A, "PATCH", `${base}/status`, { json: { status: "published" } }), 400, "bad status: ");
      expectStatus(await admin(sessions.A, "PATCH", `${base}/reply`, { json: { reply: "x".repeat(2001) } }), 400, "long reply: ");
      expectStatus(await admin(sessions.A, "PATCH", `${ADMIN_REVIEWS}/1001/does-not-exist/status`, { json: { status: "approved" } }), 404, "unknown review: ");
      expectStatus(await admin(sessions.A, "PATCH", `${ADMIN_REVIEWS}/abc/${submittedReview.id}/status`, { json: { status: "approved" } }), 400, "non-numeric product: ");
    });

    await check("R6", "approving a review publishes it without any contact data, raw payload or internal ids", async () => {
      const res = await admin(sessions.A, "PATCH", `${ADMIN_REVIEWS}/1001/${submittedReview.id}/status`, { json: { status: "approved" } });
      expectStatus(res, 200);
      const pub = await api(`${PUBLIC_REVIEWS}/1001`, { headers: submitHeaders });
      expectStatus(pub, 200);
      const item = findDeep(pub.body, (o) => o.id === submittedReview.id)[0];
      assert.ok(item, `approved review not public: ${pub.raw.slice(0, 300)}`);
      assert.equal(item.author, "Nguyen Van A");
      const keys = collectKeys(pub.body);
      for (const forbidden of ["email", "phone", "source_raw_json", "sourceRawJson", "shopId", "rawPayload", "emailHash", "phoneHash"]) {
        assert.ok(!keys.has(forbidden), `public review payload exposes key ${forbidden}`);
      }
      assert.ok(!pub.raw.includes(PII.email) && !pub.raw.includes(PII.phone), "public review payload contains contact data");
    });

    await check("R7", "public summary and batch summaries reflect approved reviews only", async () => {
      const one = await api(`${PUBLIC_REVIEWS}/1001/summary`, { headers: submitHeaders });
      expectStatus(one, 200);
      assert.equal(one.body.data.count, 1, brief(one));
      assert.equal(one.body.data.avg, 5, brief(one));
      const batch = await api(`${PUBLIC_REVIEWS}/summaries?productIds=1001,9999`, { headers: submitHeaders });
      expectStatus(batch, 200);
      assert.equal(batch.body.data["1001"].count, 1);
      assert.equal(batch.body.data["9999"].count, 0);
    });

    await check("R8", "review writes sync tiny summary metafields to the store with the store token", async () => {
      const ok = await waitFor(() => stub.productMetafields(STORE_A, "1001").length > 0, { timeout: 15000 });
      const writes = stub.callsFor(STORE_A, (c) => /\/metafields/.test(c.path) && c.method !== "GET");
      assert.ok(ok, `no product metafield was written; metafield calls: ${JSON.stringify(writes.map((c) => `${c.method} ${c.path}`))}`);
      const fields = stub.productMetafields(STORE_A, "1001");
      const byKey = new Map(fields.map((f) => [f.key, f]));
      const hasSummary = byKey.has("public_summary");
      const hasScalars = byKey.has("rating_count") && byKey.has("rating_avg");
      assert.ok(hasSummary || hasScalars, `expected public_summary or rating_count+rating_avg, got ${JSON.stringify(fields)}`);
      for (const field of fields) {
        assert.equal(field.namespace, "f1genz_reviews");
        const value = typeof field.value === "string" ? field.value : JSON.stringify(field.value);
        assert.ok(Buffer.byteLength(value) <= 200, `metafield ${field.key} is ${Buffer.byteLength(value)} bytes; Sapo metafield values must stay tiny`);
        assert.ok(!/@|buyer\.private|0987654321/.test(value), `metafield ${field.key} carries contact data`);
      }
      if (byKey.has("rating_count")) assert.equal(String(byKey.get("rating_count").value), "1");
      if (hasSummary) assert.equal(JSON.parse(String(byKey.get("public_summary").value)).count, 1);
      for (const callRecord of writes) assert.ok(callRecord.token && callRecord.token.startsWith("e2e-token-"), "metafield write without store token");
    });

    await check("R9", "replying publishes the reply on the public review", async () => {
      const res = await admin(sessions.A, "PATCH", `${ADMIN_REVIEWS}/1001/${submittedReview.id}/reply`, { json: { reply: "Thanks for the kind words." } });
      expectStatus(res, 200);
      const pub = await api(`${PUBLIC_REVIEWS}/1001`, { headers: submitHeaders });
      const item = findDeep(pub.body, (o) => o.id === submittedReview.id)[0];
      assert.equal(item.reply, "Thanks for the kind words.");
    });

    await check("R10", "widget config: whitelist drops unknown keys, enums validate, email config never unmasks the public list", async () => {
      const put = await admin(sessions.A, "PUT", `${ADMIN_REVIEWS}/widget-config`, { json: { titleText: "Customer reviews", bogusField: "x", emailDisplay: "full", phoneDisplay: "full" } });
      expectStatus(put, 200);
      const get = await admin(sessions.A, "GET", `${ADMIN_REVIEWS}/widget-config`);
      assert.equal(get.body.data.titleText, "Customer reviews");
      assert.equal(get.body.data.bogusField, undefined, "unknown key was persisted");
      assert.equal(get.body.data.emailDisplay, undefined, "emailDisplay is no longer a config field");
      assert.equal(get.body.data.phoneDisplay, undefined, "phoneDisplay is no longer a config field");
      expectStatus(await admin(sessions.A, "PUT", `${ADMIN_REVIEWS}/widget-config`, { json: { reviewLayout: "carousel" } }), 400, "bad enum: ");
      expectStatus(await admin(sessions.A, "PUT", `${ADMIN_REVIEWS}/widget-config`, { json: { radius: "big" } }), 400, "bad number: ");
      const pubCfg = await api(`${PUBLIC_REVIEWS}/config/widget`, { headers: submitHeaders });
      expectStatus(pubCfg, 200);
      assert.equal(pubCfg.body.data.titleText, "Customer reviews");
      const pub = await api(`${PUBLIC_REVIEWS}/1001`, { headers: submitHeaders });
      assert.ok(!pub.raw.includes(PII.email) && !pub.raw.includes(PII.phone), "emailDisplay=full exposed contact data publicly");
    });

    await check("R11", "imported reviews never leak email, phone or the raw source payload publicly", async () => {
      const shop = await prisma.shop.findUnique({ where: { storeDomain: STORE_A } });
      const now = BigInt(Date.now());
      await prisma.reviewProduct.create({
        data: {
          shopId: shop.id,
          productId: "1002",
          reviewId: "seed-imported-1",
          rating: 4,
          content: "Imported from another platform",
          author: "Imported Buyer",
          email: "imported.buyer@example.com",
          phone: "0912345678",
          status: "approved",
          verified: true,
          sourceRawJson: JSON.stringify({ buyer_email: "imported.buyer@example.com", internal: "RAW-PAYLOAD-SENTINEL" }),
          createdAt: now,
          updatedAt: now,
        },
      });
      const pub = await api(`${PUBLIC_REVIEWS}/1002`, { headers: submitHeaders });
      expectStatus(pub, 200);
      assert.ok(findDeep(pub.body, (o) => o.id === "seed-imported-1").length === 1, "seeded review is not listed");
      for (const needle of ["imported.buyer", "0912345678", "RAW-PAYLOAD-SENTINEL"]) {
        assert.ok(!pub.raw.includes(needle), `public review payload leaked ${needle}`);
      }
      const keys = collectKeys(pub.body);
      for (const forbidden of ["email", "phone", "source_raw_json", "sourceRawJson"]) {
        assert.ok(!keys.has(forbidden), `public review payload exposes key ${forbidden}`);
      }
      const sum = await api(`${PUBLIC_REVIEWS}/summaries?productIds=1002`, { headers: submitHeaders });
      assert.ok(!sum.raw.includes("imported.buyer"), "summaries leaked contact data");
    });

    await check("R12", "tenants are isolated: store B sees nothing of store A and cannot act on its reviews", async () => {
      const pubB = await api(`${PUBLIC_REVIEWS}/1001`, { headers: { "x-store-domain": STORE_B } });
      expectStatus(pubB, 200);
      assert.equal(findDeep(pubB.body, (o) => o.id === submittedReview.id).length, 0, "store B can read store A's review");
      const adminB = await admin(sessions.B, "GET", `${ADMIN_REVIEWS}?limit=50`);
      expectStatus(adminB, 200);
      assert.equal(findDeep(adminB.body, (o) => o.id === submittedReview.id).length, 0, "store B admin list contains store A's review");
      expectStatus(await admin(sessions.B, "PATCH", `${ADMIN_REVIEWS}/1001/${submittedReview.id}/status`, { json: { status: "hidden" } }), 404, "cross-tenant status change: ");
      expectStatus(await admin(sessions.B, "DELETE", `${ADMIN_REVIEWS}/1001/${submittedReview.id}`), 404, "cross-tenant delete: ");
      const still = await api(`${PUBLIC_REVIEWS}/1001`, { headers: submitHeaders });
      assert.equal(findDeep(still.body, (o) => o.id === submittedReview.id).length, 1, "store A's review changed by store B");
    });

    await check("R13", "admin create-review honours the supplied status; hidden and spam reviews stay private", async () => {
      const spam = await admin(sessions.A, "POST", `${ADMIN_REVIEWS}/1003`, {
        json: { rating: 1, author: "Spammer", content: "e2e-blocked buy now", ...PII },
      });
      expectStatus(spam, [200, 201]);
      assert.equal(spam.body.data.status, "spam", "blocked word did not classify the review as spam");
      const pub = await api(`${PUBLIC_REVIEWS}/1003`, { headers: submitHeaders });
      assert.equal(findDeep(pub.body, (o) => o.id === spam.body.data.id).length, 0, "spam review is public");
      const hide = await admin(sessions.A, "PATCH", `${ADMIN_REVIEWS}/1001/${submittedReview.id}/status`, { json: { status: "hidden" } });
      expectStatus(hide, 200);
      const afterHide = await api(`${PUBLIC_REVIEWS}/1001`, { headers: submitHeaders });
      assert.equal(findDeep(afterHide.body, (o) => o.id === submittedReview.id).length, 0, "hidden review is public");
      const sum = await api(`${PUBLIC_REVIEWS}/1001/summary`, { headers: submitHeaders });
      assert.equal(sum.body.data.count, 0, "hidden review still counted in public summary");
    });

    await check("R14", "deleting a review removes it; a second delete is 404", async () => {
      const del = await admin(sessions.A, "DELETE", `${ADMIN_REVIEWS}/1001/${submittedReview.id}`);
      expectStatus(del, 200);
      assert.equal(del.body.data.deleted, true);
      expectStatus(await admin(sessions.A, "DELETE", `${ADMIN_REVIEWS}/1001/${submittedReview.id}`), 404, "second delete: ");
      assert.equal(await prisma.reviewProduct.count({ where: { reviewId: submittedReview.id } }), 0);
    });

    await check("R15", "concurrent public submissions all persist (no lost write under the review lock)", async () => {
      const before = await prisma.reviewProduct.count({ where: { productId: "1004" } });
      const sends = await Promise.all(
        Array.from({ length: 3 }, (_, i) =>
          api(`${PUBLIC_REVIEWS}/1004`, { method: "POST", headers: submitHeaders, json: { rating: 3, author: `Parallel ${i}`, content: `parallel content ${i}` } }),
        ),
      );
      for (const res of sends) expectStatus(res, [200, 201]);
      const after = await prisma.reviewProduct.count({ where: { productId: "1004" } });
      assert.equal(after - before, 3);
    });

    await check("R17", "legacy emailDisplay/phoneDisplay keys already stored in widget metadata are stripped on every read", async () => {
      const install = await prisma.appInstall.findUnique({ where: { storeDomain: STORE_A } });
      const metadata = install.metadata && typeof install.metadata === "object" ? install.metadata : {};
      const saved = metadata.reviewWidgetConfig || {};
      await prisma.appInstall.update({
        where: { storeDomain: STORE_A },
        data: { metadata: { ...metadata, reviewWidgetConfig: { ...saved, emailDisplay: "full", phoneDisplay: "full" } } },
      });
      try {
        const adminCfg = await admin(sessions.A, "GET", `${ADMIN_REVIEWS}/widget-config`);
        const publicCfg = await api(`${PUBLIC_REVIEWS}/config/widget`, { headers: submitHeaders });
        for (const [label, res] of [["admin", adminCfg], ["public", publicCfg]]) {
          expectStatus(res, 200, `${label}: `);
          const keys = collectKeys(res.body);
          assert.ok(!keys.has("emailDisplay") && !keys.has("phoneDisplay"), `${label} config still carries a legacy key: ${res.raw.slice(0, 300)}`);
          assert.equal(res.body.data.titleText, "Customer reviews", `${label} config lost its real settings`);
        }
      } finally {
        await prisma.appInstall.update({ where: { storeDomain: STORE_A }, data: { metadata } });
      }
    });

    const listed = {};
    await check("R18", "admin list filters by star, validated to an integer 1-5, per product and store-wide", async () => {
      const seeds = [
        ["a", 5, "Zeta alpha-unique"],
        ["b", 2, "Zeta beta-unique"],
        ["c", 2, "Zeta gamma-unique"],
      ];
      for (const [key, rating, content] of seeds) {
        const res = await admin(sessions.A, "POST", `${ADMIN_REVIEWS}/1005`, { json: { rating, author: `Lister ${key}`, content, status: "approved" } });
        expectStatus(res, [200, 201], `create ${key}: `);
        listed[key] = res.body.data;
      }
      const two = await admin(sessions.A, "GET", `${ADMIN_REVIEWS}?star=2&productId=1005&limit=50`);
      expectStatus(two, 200);
      assert.equal(two.body.data.total, 2, brief(two));
      assert.ok(two.body.data.items.every((item) => item.rating === 2), "star=2 returned another rating");
      const five = await admin(sessions.A, "GET", `${ADMIN_REVIEWS}?star=5&productId=1005&limit=50`);
      expectStatus(five, 200);
      assert.equal(five.body.data.total, 1, brief(five));
      assert.equal(five.body.data.items[0].id, listed.a.id);
      const perProduct = await admin(sessions.A, "GET", `${ADMIN_REVIEWS}/1005?star=2`);
      expectStatus(perProduct, 200);
      assert.ok(Array.isArray(perProduct.body.data) && perProduct.body.data.length === 2 && perProduct.body.data.every((r) => r.rating === 2), brief(perProduct));
      for (const bad of ["0", "6", "abc", "2.5"]) {
        expectStatus(await admin(sessions.A, "GET", `${ADMIN_REVIEWS}?star=${bad}`), 400, `star=${bad}: `);
        expectStatus(await admin(sessions.A, "GET", `${ADMIN_REVIEWS}/1005?star=${bad}`), 400, `product star=${bad}: `);
      }
    });

    await check("R19", "unreplied filter, search and statusCounts.unreplied agree with the database", async () => {
      expectStatus(await admin(sessions.A, "PATCH", `${ADMIN_REVIEWS}/1005/${listed.a.id}/reply`, { json: { reply: "Thank you." } }), 200);
      const shopId = await shopOf(STORE_A);
      const unrepliedDb = await prisma.reviewProduct.count({ where: { shopId, OR: [{ reply: null }, { reply: "" }] } });
      const allDb = await prisma.reviewProduct.count({ where: { shopId } });
      const res = await admin(sessions.A, "GET", `${ADMIN_REVIEWS}?status=unreplied&productId=1005&limit=50`);
      expectStatus(res, 200);
      assert.equal(res.body.data.total, 2, brief(res));
      assert.ok(!res.body.data.items.some((item) => item.id === listed.a.id), "unreplied filter returned a replied review");
      assert.equal(res.body.data.statusCounts.unreplied, unrepliedDb);
      assert.equal(res.body.data.statusCounts.all, allDb);
      const both = await admin(sessions.A, "GET", `${ADMIN_REVIEWS}?status=unreplied&search=beta-unique&limit=50`);
      expectStatus(both, 200);
      assert.equal(both.body.data.total, 1, brief(both));
      assert.equal(both.body.data.items[0].id, listed.b.id);
      assert.equal(both.body.data.statusCounts.unreplied, unrepliedDb, "statusCounts must stay store-wide while filtering");
      const repliedOnly = await admin(sessions.A, "GET", `${ADMIN_REVIEWS}?status=unreplied&search=alpha-unique&limit=50`);
      expectStatus(repliedOnly, 200);
      assert.equal(repliedOnly.body.data.total, 0, "a replied review matched the unreplied filter");
      const searchOnly = await admin(sessions.A, "GET", `${ADMIN_REVIEWS}?search=zeta&limit=50`);
      expectStatus(searchOnly, 200);
      assert.equal(searchOnly.body.data.total, 3, brief(searchOnly));
    });

    console.log("\n--- media uploads ---");
    const PUBLIC_MEDIA = "/api/public/media";
    const publicTicket = (storeDomain, body, headers = {}) =>
      api(`${PUBLIC_MEDIA}/ticket`, { method: "POST", headers: { "x-store-domain": storeDomain, ...headers }, json: body });
    const pngTicketBody = (productId = "1001") => ({ productId, contentType: "image/png", fileSize: TINY_PNG.length });
    const publicUpload = (storeDomain, ticket, productId, bytes = TINY_PNG, type = "image/png", headers = {}) =>
      api(`${PUBLIC_MEDIA}/upload?productId=${productId}&ticket=${encodeURIComponent(ticket)}`, {
        method: "POST",
        headers: { "x-store-domain": storeDomain, ...headers },
        body: uploadForm(bytes, { type }),
      });
    const ticketOf = async (storeDomain, body, headers) => {
      const res = await publicTicket(storeDomain, body, headers);
      expectStatus(res, 200, "ticket: ");
      return res.body.data.ticket;
    };

    await check("M1", "admin upload ticket: size and type are validated with stable codes and a client filename never reaches the ticket", async () => {
      const route = "/api/admin/media/upload-ticket";
      const ok = await admin(sessions.A, "POST", route, { json: pngTicketBody() });
      expectStatus(ok, [200, 201]);
      assert.ok(ok.body.data.ticket && typeof ok.body.data.expiresAt === "number", brief(ok));
      const named = await admin(sessions.A, "POST", route, { json: { ...pngTicketBody(), filename: "../../evil.php" } });
      expectStatus(named, [200, 201], "filename supplied: ");
      const payload = JSON.parse(Buffer.from(named.body.data.ticket.split(".")[0], "base64url").toString("utf8"));
      assert.deepEqual(Object.keys(payload).sort(), ["contentType", "expiresAt", "fileSize", "nonce", "productId", "storeDomain"], "ticket payload carries unexpected fields");
      const gif = await admin(sessions.A, "POST", route, { json: { ...pngTicketBody(), contentType: "image/gif" } });
      expectStatus(gif, 400, "gif: ");
      assert.equal(gif.body.code, "upload_unsupported_type", brief(gif));
      const big = await admin(sessions.A, "POST", route, { json: { ...pngTicketBody(), fileSize: 6 * 1024 * 1024 } });
      expectStatus(big, 413, "6 MB image: ");
      assert.equal(big.body.code, "upload_file_too_large", brief(big));
      const bigVideo = await admin(sessions.A, "POST", route, { json: { productId: "1001", contentType: "video/mp4", fileSize: 3 * 1024 * 1024 } });
      expectStatus(bigVideo, 413, "3 MB video: ");
      expectStatus(await admin(sessions.A, "POST", route, { json: { ...pngTicketBody(), fileSize: 0 } }), 400, "zero size: ");
      expectStatus(await admin(sessions.A, "POST", route, { json: { ...pngTicketBody("abc") } }), 400, "non-numeric product: ");
    });

    let uploaded = null;
    await check("M2", "public ticket then upload stores the object under a server-chosen key and returns its CDN URL", async () => {
      const ticket = await ticketOf(STORE_A, pngTicketBody());
      const res = await publicUpload(STORE_A, ticket, "1001");
      expectStatus(res, 200, "upload: ");
      const { url, type } = res.body.data;
      assert.equal(type, "image");
      const origin = `https://${R2_PUBLIC_DOMAIN}/`;
      assert.ok(url.startsWith(origin), `unexpected CDN url ${url}`);
      const key = url.slice(origin.length);
      assert.match(key, new RegExp(`^reviews/${STORE_A.replace(/\./g, "\\.")}/1001/[A-Za-z0-9_-]{16,64}\\.png$`), `key not server-named: ${key}`);
      const stored = r2.objects.get(key);
      assert.ok(stored, "object was not written to the storage worker");
      assert.equal(stored.contentType, "image/png");
      assert.equal(Buffer.compare(stored.body, TINY_PNG), 0, "stored bytes differ from the upload");
      const put = r2.calls.find((c) => c.method === "PUT" && c.key === key);
      assert.ok(put && put.token === SECRETS.uploadSecret, "storage worker was not called with the upload secret");
      uploaded = { url, key };
    });

    await check("M3", "an uploaded URL is accepted as review media and the object is deleted with the review", async () => {
      assert.ok(uploaded, "M2 did not upload");
      const res = await api(`${PUBLIC_REVIEWS}/1001`, {
        method: "POST",
        headers: submitHeaders,
        json: { rating: 4, author: "Media Reviewer", content: "With a photo", media: [{ url: uploaded.url, type: "image" }] },
      });
      expectStatus(res, [200, 201]);
      assert.deepEqual(res.body.data.media.map((m) => m.url), [uploaded.url]);
      assert.ok(r2.objects.has(uploaded.key), "object vanished before the review was deleted");
      expectStatus(await admin(sessions.A, "DELETE", `${ADMIN_REVIEWS}/1001/${res.body.data.id}`), 200);
      assert.ok(await waitFor(() => !r2.objects.has(uploaded.key)), "deleting the review left its uploaded object behind");
      assert.ok(r2.calls.some((c) => c.method === "DELETE" && c.key === uploaded.key), "storage worker never received a DELETE");
    });

    await check("M4", "upload rejects missing, forged, replayed and mismatched tickets and bodies with distinct codes", async () => {
      const noTicket = await api(`${PUBLIC_MEDIA}/upload?productId=1001`, { method: "POST", headers: { "x-store-domain": STORE_A }, body: uploadForm(TINY_PNG) });
      expectStatus(noTicket, 401, "no ticket: ");
      assert.equal(noTicket.body.code, "upload_ticket_missing", brief(noTicket));
      const fresh = await ticketOf(STORE_A, pngTicketBody());
      const [encoded, signature] = fresh.split(".");
      const forged = `${encoded}.${signature.slice(0, -2)}${signature.endsWith("AA") ? "BB" : "AA"}`;
      const forgedRes = await publicUpload(STORE_A, forged, "1001");
      expectStatus(forgedRes, 401, "forged signature: ");
      assert.equal(forgedRes.body.code, "upload_ticket_invalid", brief(forgedRes));
      const crossStore = await publicUpload(STORE_B, fresh, "1001");
      expectStatus(crossStore, 403, "ticket of another store: ");
      assert.equal(crossStore.body.code, "upload_ticket_mismatch", brief(crossStore));
      const wrongProduct = await publicUpload(STORE_A, fresh, "1002");
      expectStatus(wrongProduct, 403, "ticket for another product: ");
      assert.equal(wrongProduct.body.code, "upload_ticket_mismatch", brief(wrongProduct));
      const wrongSize = await publicUpload(STORE_A, fresh, "1001", Buffer.concat([TINY_PNG, Buffer.from([0])]));
      expectStatus(wrongSize, 403, "body of another size: ");
      assert.equal(wrongSize.body.code, "upload_ticket_mismatch", brief(wrongSize));
      expectStatus(await publicUpload(STORE_A, fresh, "1001"), 200, "the ticket was not consumed by the rejected attempts: ");
      const replay = await publicUpload(STORE_A, fresh, "1001");
      expectStatus(replay, 409, "replayed ticket: ");
      assert.equal(replay.body.code, "upload_ticket_used", brief(replay));
      const bogus = Buffer.from("this is plainly not an image");
      const bogusTicket = await ticketOf(STORE_A, { productId: "1001", contentType: "image/png", fileSize: bogus.length });
      const mismatch = await publicUpload(STORE_A, bogusTicket, "1001", bogus);
      expectStatus(mismatch, 400, "text declared as png: ");
      assert.equal(mismatch.body.code, "upload_content_mismatch", brief(mismatch));
    });

    await check("M5", "oversized and unsupported uploads are refused at ticket time and a client filename cannot name the stored object", async () => {
      const big = await publicTicket(STORE_A, { ...pngTicketBody(), fileSize: 6 * 1024 * 1024 });
      expectStatus(big, 413, "6 MB image: ");
      assert.equal(big.body.code, "upload_file_too_large", brief(big));
      const video = await publicTicket(STORE_A, { productId: "1001", contentType: "video/mp4", fileSize: 3 * 1024 * 1024 });
      expectStatus(video, 413, "3 MB video: ");
      const gif = await publicTicket(STORE_A, { ...pngTicketBody(), contentType: "image/gif" });
      expectStatus(gif, 400, "gif: ");
      assert.equal(gif.body.code, "upload_unsupported_type", brief(gif));
      const named = await publicTicket(STORE_A, { ...pngTicketBody(), filename: "../../evil.php" });
      expectStatus(named, 200, "filename supplied: ");
      const namedUpload = await publicUpload(STORE_A, named.body.data.ticket, "1001");
      expectStatus(namedUpload, 200, "upload with a filename-bearing ticket: ");
      assert.ok(!/evil|php/i.test(namedUpload.body.data.url), `the client filename leaked into the object key: ${namedUpload.body.data.url}`);
      assert.match(namedUpload.body.data.url, /\/reviews\/e2e-alpha\.mysapo\.net\/1001\/[A-Za-z0-9_-]{16,64}\.png$/);
      expectStatus(await api(`${PUBLIC_MEDIA}/ticket`, { method: "POST", json: pngTicketBody() }), 400, "no store: ");
    });

    await check("M6", "storage worker failures map to 502/413 with stable codes and never leak the worker body", async () => {
      try {
        for (const [mode, status, code] of [
          ["reject", 502, "upload_storage_rejected"],
          ["too_large", 413, "upload_file_too_large"],
          ["fail", 502, "upload_storage_failed"],
        ]) {
          r2.setMode(mode);
          const ticket = await ticketOf(STORE_A, pngTicketBody());
          const res = await publicUpload(STORE_A, ticket, "1001");
          expectStatus(res, status, `${mode}: `);
          assert.equal(res.body.code, code, `${mode}: ${brief(res)}`);
          assert.ok(!res.raw.includes("storage failure"), `${mode}: worker response leaked`);
        }
      } finally {
        r2.setMode("ok");
      }
    });

    await check("M7", "upload endpoints are rate limited per store and client", async () => {
      const headers = fromClient(15);
      let firstThrottled = null;
      for (let attempt = 1; attempt <= PUBLIC_WRITE_LIMIT + 3; attempt += 1) {
        const res = await publicTicket(STORE_A, pngTicketBody(), headers);
        if (res.status === 429) {
          firstThrottled = attempt;
          break;
        }
        expectStatus(res, 200, `attempt ${attempt}: `);
      }
      assert.equal(firstThrottled, PUBLIC_WRITE_LIMIT + 1, `first 429 at attempt ${firstThrottled}`);
      expectStatus(await publicTicket(STORE_A, pngTicketBody(), fromClient(16)), 200, "another client: ");
    });

    console.log("\n--- Q&A ---");
    let question = null;
    await check("Q1", "public question validates author/question/email and stores as pending", async () => {
      const bad = [
        [{ author: "A", question: "A valid question?" }, "author too short"],
        [{ author: "Alice", question: "hi" }, "question too short"],
        [{ author: "Alice", question: "A valid question?", email: "not-an-email" }, "invalid email"],
        [{ question: "A valid question?" }, "missing author"],
      ];
      for (const [json, label] of bad) {
        expectStatus(await api(`${PUBLIC_QNA}/1001`, { method: "POST", headers: submitHeaders, json }), 400, `${label}: `);
      }
      const ok = await api(`${PUBLIC_QNA}/1001`, { method: "POST", headers: submitHeaders, json: { author: "Alice", question: "Does it come in blue?", email: "alice.private@example.com" } });
      expectStatus(ok, [200, 201]);
      question = ok.body.data;
      assert.ok(question && question.id, brief(ok));
      assert.equal(question.status, "pending");
      assert.ok(!JSON.stringify(question).includes("alice.private"), `submit response echoed the asker's email: ${JSON.stringify(question).slice(0, 200)}`);
    });

    await check("Q2", "unanswered or unapproved questions are not public", async () => {
      const pub = await api(`${PUBLIC_QNA}/1001`, { headers: submitHeaders });
      expectStatus(pub, 200);
      assert.equal(findDeep(pub.body, (o) => o.id === question.id).length, 0);
    });

    await check("Q3", "admin sees the question with contact data and answers it; the answer is public without PII", async () => {
      const list = await admin(sessions.A, "GET", `${ADMIN_QNA}?status=pending&limit=50`);
      expectStatus(list, 200);
      const mine = findDeep(list.body, (o) => o.id === question.id)[0];
      assert.ok(mine, `question missing from admin list: ${list.raw.slice(0, 200)}`);
      assert.equal(mine.email, "alice.private@example.com");
      expectStatus(await admin(sessions.A, "PATCH", `${ADMIN_QNA}/1001/${question.id}/answer`, { json: { answer: "" , status: "published" } }), 400, "bad status: ");
      const ans = await admin(sessions.A, "PATCH", `${ADMIN_QNA}/1001/${question.id}/answer`, { json: { answer: "Yes, blue is available.", answered_by: "Shop", status: "approved" } });
      expectStatus(ans, 200);
      const pub = await api(`${PUBLIC_QNA}/1001`, { headers: submitHeaders });
      const item = findDeep(pub.body, (o) => o.id === question.id)[0];
      assert.ok(item, `answered question not public: ${pub.raw.slice(0, 300)}`);
      assert.equal(item.answer, "Yes, blue is available.");
      assert.ok(!pub.raw.includes("alice.private"), "public Q&A leaked the asker's email");
      const keys = collectKeys(pub.body);
      for (const forbidden of ["email", "phone", "source_raw_json", "sourceRawJson", "shopId"]) {
        assert.ok(!keys.has(forbidden), `public Q&A payload exposes key ${forbidden}`);
      }
    });

    await check("Q4", "imported questions never leak email, phone or raw payload publicly", async () => {
      const shop = await prisma.shop.findUnique({ where: { storeDomain: STORE_A } });
      const now = BigInt(Date.now());
      await prisma.qnaQuestion.create({
        data: {
          shopId: shop.id,
          productId: "1002",
          questionId: "seed-question-1",
          question: "Imported question?",
          author: "Imported Asker",
          email: "imported.asker@example.com",
          phone: "0911111111",
          answer: "Imported answer",
          status: "approved",
          sourceRawJson: JSON.stringify({ internal: "QNA-RAW-SENTINEL" }),
          createdAt: now,
          updatedAt: now,
          answeredAt: now,
        },
      });
      const pub = await api(`${PUBLIC_QNA}/1002`, { headers: submitHeaders });
      expectStatus(pub, 200);
      assert.equal(findDeep(pub.body, (o) => o.id === "seed-question-1").length, 1, "seeded question is not listed");
      for (const needle of ["imported.asker", "0911111111", "QNA-RAW-SENTINEL"]) {
        assert.ok(!pub.raw.includes(needle), `public Q&A payload leaked ${needle}`);
      }
    });

    await check("Q5", "Q&A is tenant-isolated and admin mutations on foreign questions are 404", async () => {
      const pubB = await api(`${PUBLIC_QNA}/1001`, { headers: { "x-store-domain": STORE_B } });
      assert.equal(findDeep(pubB.body, (o) => o.id === question.id).length, 0);
      expectStatus(await admin(sessions.B, "DELETE", `${ADMIN_QNA}/1001/${question.id}`), 404, "cross-tenant delete: ");
      expectStatus(await admin(sessions.A, "DELETE", `${ADMIN_QNA}/1001/${question.id}`), 200, "owner delete: ");
      expectStatus(await admin(sessions.A, "DELETE", `${ADMIN_QNA}/1001/${question.id}`), 404, "second delete: ");
    });

    await check("Q6", "admin Q&A per product is paged {items,total,page,pageSize} with product-scoped counts and catalog titles", async () => {
      for (let i = 1; i <= 3; i += 1) {
        const res = await api(`${PUBLIC_QNA}/1001`, { method: "POST", headers: submitHeaders, json: { author: `Pager ${i}`, question: `Sizing question number ${i}?` } });
        expectStatus(res, [200, 201], `seed ${i}: `);
      }
      const first = await admin(sessions.A, "GET", `${ADMIN_QNA}/1001?page=1&size=2`);
      expectStatus(first, 200);
      const page1 = first.body.data;
      for (const key of ["items", "total", "page", "pageSize", "totalPages", "statusCounts"]) assert.ok(key in page1, `missing ${key}: ${first.raw.slice(0, 200)}`);
      assert.equal(page1.items.length, 2, brief(first));
      assert.equal(page1.total, 3);
      assert.equal(page1.page, 1);
      assert.equal(page1.pageSize, 2);
      assert.equal(page1.totalPages, 2);
      assert.equal(page1.statusCounts.all, 3, "counts must be scoped to the product");
      assert.ok(page1.items.every((q) => q.productId === "1001" && q.productTitle === "E2E product 1001"), "items lack the catalog title");
      const second = await admin(sessions.A, "GET", `${ADMIN_QNA}/1001?page=2&size=2`);
      expectStatus(second, 200);
      assert.equal(second.body.data.items.length, 1, brief(second));
      assert.equal(second.body.data.page, 2);
      const ids = new Set([...page1.items, ...second.body.data.items].map((q) => q.id));
      assert.equal(ids.size, 3, "pages overlap or skip rows");
      const unanswered = await admin(sessions.A, "GET", `${ADMIN_QNA}/1001?status=unanswered`);
      assert.equal(unanswered.body.data.total, 3, brief(unanswered));
      const all = await admin(sessions.A, "GET", `${ADMIN_QNA}?limit=50`);
      expectStatus(all, 200);
      assert.equal(all.body.data.total, 4, brief(all));
      assert.equal(all.body.data.statusCounts.all, 4);
      assert.equal(all.body.data.statusCounts.answered, 1);
      const searched = await admin(sessions.A, "GET", `${ADMIN_QNA}?search=sizing&limit=50`);
      assert.equal(searched.body.data.total, 3, brief(searched));
    });

    await check("Q7", "public Q&A is paged and clamped and lists answered approved questions only", async () => {
      const pub = await api(`${PUBLIC_QNA}/1002?limit=500`, { headers: submitHeaders });
      expectStatus(pub, 200);
      const data = pub.body.data;
      assert.equal(data.pageSize, 50, `page size not clamped: ${pub.raw.slice(0, 200)}`);
      assert.equal(data.page, 1);
      assert.equal(data.total, 1);
      assert.equal(data.items.length, 1);
      const pending = await api(`${PUBLIC_QNA}/1001`, { headers: submitHeaders });
      expectStatus(pending, 200);
      assert.equal(pending.body.data.total, 0, "unanswered questions are public");
    });

    await check("Q8", "an empty or whitespace-only answer is refused and leaves the question unanswered", async () => {
      const list = await admin(sessions.A, "GET", `${ADMIN_QNA}/1001?status=unanswered`);
      expectStatus(list, 200);
      const target = list.body.data.items[0];
      assert.ok(target, brief(list));
      for (const answer of ["", "   "]) {
        expectStatus(await admin(sessions.A, "PATCH", `${ADMIN_QNA}/1001/${target.id}/answer`, { json: { answer } }), 400, `answer ${JSON.stringify(answer)}: `);
      }
      const after = await admin(sessions.A, "GET", `${ADMIN_QNA}/1001?status=unanswered`);
      assert.equal(after.body.data.total, 3, "a refused answer changed the question");
    });

    await check("D1", "dashboard overview carries reviewTrend, attentionProducts, productStats, degraded and statusCounts.unreplied", async () => {
      const res = await admin(sessions.A, "GET", "/api/admin/dashboard/overview");
      expectStatus(res, 200);
      const data = res.body.data;
      for (const key of ["reviewTrend", "attentionProducts", "productStats", "degraded", "statusCounts"]) assert.ok(key in data, `overview lacks ${key}: ${res.raw.slice(0, 300)}`);
      assert.deepEqual(data.degraded, [], `a dashboard section degraded: ${data.degraded.join(",")}`);
      assert.equal(data.reviewTrend.length, 14);
      for (const point of data.reviewTrend) {
        assert.match(point.date, /^\d{4}-\d{2}-\d{2}$/);
        assert.equal(typeof point.count, "number");
      }
      assert.ok(data.reviewTrend.reduce((sum, point) => sum + point.count, 0) >= 3, "trend counted none of today's reviews");
      const shopId = await shopOf(STORE_A);
      const unrepliedDb = await prisma.reviewProduct.count({ where: { shopId, OR: [{ reply: null }, { reply: "" }] } });
      assert.equal(data.statusCounts.unreplied, unrepliedDb);
      const lowRated = data.attentionProducts.find((p) => p.productId === "1005");
      assert.ok(lowRated && lowRated.reason === "low_rating", `1005 not flagged low_rating: ${JSON.stringify(data.attentionProducts)}`);
      assert.equal(lowRated.reviewCount, 3);
      assert.equal(lowRated.reviewAvg, 3);
      const unanswered = data.attentionProducts.find((p) => p.productId === "1001");
      assert.ok(unanswered && unanswered.reason === "unanswered_qna" && unanswered.qnaUnanswered === 3, `1001 not flagged unanswered_qna: ${JSON.stringify(data.attentionProducts)}`);
      const stat = data.productStats.find((p) => p.productId === "1005");
      assert.ok(stat, "1005 missing from productStats");
      assert.equal(stat.title, "E2E product 1005");
      assert.equal(stat.reviewCount, 3);
      assert.equal(stat.qnaTotal, 0);
      const qnaStat = data.productStats.find((p) => p.productId === "1001");
      assert.ok(qnaStat && qnaStat.qnaTotal === 3 && qnaStat.qnaUnanswered === 3, `1001 productStats wrong: ${JSON.stringify(qnaStat)}`);
      const other = await admin(sessions.B, "GET", "/api/admin/dashboard/overview");
      expectStatus(other, 200, "other store: ");
      assert.ok(!other.body.data.productStats.some((p) => p.productId === "1005"), "store B dashboard shows store A products");
    });

    console.log("\n--- webhooks ---");
    const webhookUrl = "/api/oauth/install/webhooks";
    const deliver = async ({ topic, payload, eventId, secret = SECRETS.clientSecret, signature, contentType = "application/json", rawBody }) => {
      const body = rawBody !== undefined ? rawBody : JSON.stringify(payload);
      const headers = { "content-type": contentType, [WEBHOOK.topicHeader]: topic };
      const sig = signature !== undefined ? signature : hmacOf(body, secret, WEBHOOK.signatureEncoding);
      if (sig !== null) headers[WEBHOOK.signatureHeader] = sig;
      if (eventId) headers[WEBHOOK.eventIdHeader] = eventId;
      return { res: await api(webhookUrl, { method: "POST", headers, body }), body };
    };
    const eventCount = (where) => prisma.webhookEvent.count({ where });

    await check("W1", "webhook with a missing, wrong, or wrong-secret signature is rejected and records nothing", async () => {
      const payload = { id: 5001, domain: STORE_A };
      const before = await eventCount({});
      const missing = await deliver({ topic: "orders/create", payload, signature: null });
      expectStatus(missing.res, 401, "missing signature: ");
      const wrong = await deliver({ topic: "orders/create", payload, signature: Buffer.alloc(32, 7).toString("base64") });
      expectStatus(wrong.res, 401, "wrong signature: ");
      const wrongSecret = await deliver({ topic: "orders/create", payload, secret: SECRETS.sessionSecret });
      expectStatus(wrongSecret.res, 401, "signed with the session secret: ");
      const garbage = await deliver({ topic: "orders/create", payload, signature: "%%%not-base64%%%" });
      expectStatus(garbage.res, 401, "garbage signature: ");
      assert.equal(await eventCount({}), before, "an unauthenticated delivery was persisted");
    });

    await check("W2", "a body altered after signing is rejected", async () => {
      const signed = JSON.stringify({ id: 5002, domain: STORE_A });
      const signature = hmacOf(signed, SECRETS.clientSecret, WEBHOOK.signatureEncoding);
      const res = await api(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json", [WEBHOOK.topicHeader]: "orders/create", [WEBHOOK.signatureHeader]: signature },
        body: JSON.stringify({ id: 5002, domain: STORE_B }),
      });
      expectStatus(res, 401);
    });

    await check("W3", "non-JSON content-type and an oversized body are refused", async () => {
      const text = await deliver({ topic: "orders/create", payload: { id: 1 }, contentType: "text/plain" });
      expectStatus(text.res, 415);
      const big = await deliver({ topic: "orders/create", rawBody: JSON.stringify({ id: 1, domain: STORE_A, pad: "x".repeat(300 * 1024) }) });
      expectStatus(big.res, 413, "300 KB body: ");
    });

    await check("W4", "a correctly signed delivery is processed and persisted", async () => {
      const { res } = await deliver({ topic: "orders/create", payload: { id: 5003, domain: STORE_A }, eventId: "evt-orders-1" });
      expectStatus(res, [200, 201]);
      assert.equal(res.body.ok, true, brief(res));
      assert.equal(res.body.storeDomain, STORE_A);
      const row = await prisma.webhookEvent.findFirst({ where: { providerEventId: "evt-orders-1" } });
      assert.equal(row && row.status, "processed");
      assert.equal(row.resolvedStoreDomain, STORE_A);
      assert.ok(!JSON.stringify(row.headers || {}).toLowerCase().includes(SECRETS.clientSecret), "secret stored in event headers");
    });

    await check("W5", "duplicate deliveries (serial) are acknowledged but processed exactly once", async () => {
      const payload = { id: "7001", domain: STORE_A };
      const first = await deliver({ topic: "products/update", payload, eventId: "evt-prod-serial" });
      expectStatus(first.res, [200, 201], "first: ");
      const second = await deliver({ topic: "products/update", payload, eventId: "evt-prod-serial" });
      expectStatus(second.res, [200, 201], "duplicate: ");
      assert.equal(second.res.body.duplicate, true, `duplicate not flagged: ${brief(second.res)}`);
      assert.equal(await eventCount({ providerEventId: "evt-prod-serial" }), 1);
      const fetches = stub.callsFor(STORE_A, (c) => c.method === "GET" && c.path === "/admin/products/7001.json");
      assert.equal(fetches.length, 1, `product 7001 was fetched ${fetches.length} times`);
      const shop = await prisma.shop.findUnique({ where: { storeDomain: STORE_A } });
      assert.equal(await prisma.catalogProduct.count({ where: { shopId: shop.id, productId: "7001" } }), 1);
    });

    await check("W6", "simultaneous duplicate deliveries run the handler once", async () => {
      const payload = { id: "7002", domain: STORE_A };
      const deliveries = await Promise.all(
        Array.from({ length: 6 }, () => deliver({ topic: "products/update", payload, eventId: "evt-prod-parallel" })),
      );
      for (const { res } of deliveries) expectStatus(res, [200, 201]);
      assert.equal(await eventCount({ providerEventId: "evt-prod-parallel" }), 1);
      await waitFor(async () => (await prisma.webhookEvent.findFirst({ where: { providerEventId: "evt-prod-parallel" } })).status === "processed");
      const fetches = stub.callsFor(STORE_A, (c) => c.method === "GET" && c.path === "/admin/products/7002.json");
      assert.equal(fetches.length, 1, `product 7002 was fetched ${fetches.length} times for one event`);
    });

    await check("W8", "a products webhook with a numeric id (the shape Sapo's REST resources use) triggers the catalog fetch", async () => {
      const { res } = await deliver({ topic: "products/update", payload: { id: 7003, domain: STORE_A }, eventId: "evt-prod-numeric" });
      expectStatus(res, [200, 201]);
      const fetched = await waitFor(() => stub.callsFor(STORE_A, (c) => c.method === "GET" && c.path === "/admin/products/7003.json").length > 0);
      assert.ok(fetched, "numeric product id in the webhook payload was ignored: the catalog row is never refreshed (Catalog sync skipped)");
      const shop = await prisma.shop.findUnique({ where: { storeDomain: STORE_A } });
      assert.equal(await prisma.catalogProduct.count({ where: { shopId: shop.id, productId: "7003" } }), 1);
    });

    await check("W7", "an unmapped domain in the payload cannot act on another tenant", async () => {
      const { res } = await deliver({ topic: "orders/create", payload: { id: 5004, storeDomain: STORE_A, domain: "unmapped-shop.mysapo.net" }, eventId: "evt-unmapped" });
      expectStatus(res, 400);
      const mismatch = await deliver({ topic: "orders/create", payload: { id: 5005, storeDomain: STORE_A, domain: STORE_B }, eventId: "evt-mismatch" });
      expectStatus(mismatch.res, 400, "payload/domain mismatch: ");
    });

    console.log("\n--- purchase gate, form modes and widget switches ---");
    const putConfig = async (patch) => {
      const res = await admin(sessions.A, "PUT", `${ADMIN_REVIEWS}/widget-config`, { json: patch });
      expectStatus(res, 200, "widget-config: ");
      return res.body.data;
    };
    const CONFIG_BASELINE = {
      requirePurchaseToReview: false,
      allowQnA: true,
      allowImage: true,
      allowVideo: true,
      formEmailMode: "optional",
      formPhoneMode: "optional",
      formTitleMode: "optional",
      formContentMode: "optional",
    };
    const gateClient = (n) => ({ "x-store-domain": STORE_A, ...fromClient(n) });
    const submitAs = (productId, json, n) => api(`${PUBLIC_REVIEWS}/${productId}`, { method: "POST", headers: gateClient(n), json });
    const eligibility = (productId, json, n) => api(`${PUBLIC_REVIEWS}/${productId}/purchase-eligibility`, { method: "POST", headers: gateClient(n), json });
    const rowOf = (review) => prisma.reviewProduct.findFirst({ where: { reviewId: review.id } });
    const BUYER = { email: "buyer.gate@example.com", phone: "0901234567" };
    const STRANGER = { email: "stranger.gate@example.com" };

    await check("G1", "an order webhook plants purchase hashes and stores no buyer email, phone or address", async () => {
      const order = {
        id: 6001,
        domain: STORE_A,
        email: BUYER.email,
        phone: BUYER.phone,
        financial_status: "paid",
        fulfillment_status: "fulfilled",
        created_at: new Date().toISOString(),
        customer: { email: BUYER.email, phone: BUYER.phone, first_name: "Gatefirst", last_name: "Gatelast" },
        billing_address: { name: "Gate Buyer", address1: "1 Private Street", phone: BUYER.phone },
        shipping_address: { name: "Gate Buyer", address1: "1 Private Street", phone: BUYER.phone },
        line_items: [{ product_id: 1006, title: "x" }, { product_id: 1004 }],
      };
      const { res } = await deliver({ topic: "orders/create", payload: order, eventId: "evt-order-gate" });
      expectStatus(res, [200, 201]);
      const event = await prisma.webhookEvent.findFirst({ where: { providerEventId: "evt-order-gate" } });
      assert.ok(event && event.status === "processed", `order event not processed: ${JSON.stringify(event && event.status)}`);
      const stored = JSON.stringify(event.payload);
      for (const needle of [BUYER.email, BUYER.phone, "Private Street", "Gate Buyer", "Gatefirst", "Gatelast"]) {
        assert.ok(!stored.includes(needle), `webhook_events.payload holds buyer data (${needle}): ${stored.slice(0, 300)}`);
      }
      const keys = collectKeys(event.payload);
      for (const forbidden of ["email", "phone", "customer", "billing_address", "shipping_address", "first_name", "address1"]) {
        assert.ok(!keys.has(forbidden), `webhook_events.payload exposes key ${forbidden}`);
      }
      assert.match(event.payload.email_hash, /^[a-f0-9]{64}$/);
      assert.match(event.payload.phone_hash, /^[a-f0-9]{64}$/);
      assert.equal(event.payload.hash_version, 2);
      assert.notEqual(event.payload.email_hash, crypto.createHash("sha256").update(BUYER.email).digest("hex"), "email hash is an unkeyed digest of the address");
      const shopId = await shopOf(STORE_A);
      const rows = await prisma.customerPurchase.findMany({ where: { shopId, orderId: "6001" } });
      assert.deepEqual(rows.map((r) => r.productId).sort(), ["1004", "1006"]);
      const rowJson = JSON.stringify(rows, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
      for (const needle of [BUYER.email, BUYER.phone, "Private Street", "Gate Buyer"]) {
        assert.ok(!rowJson.includes(needle), `customer_purchases holds buyer data (${needle})`);
      }
      assert.ok(rows.every((r) => r.emailHash && r.phoneHash), "purchase rows lack identity hashes");
    });

    await check("G2", "eligibility answers not_required without the gate and never spends the identity budget", async () => {
      await putConfig(CONFIG_BASELINE);
      const open = await eligibility("1006", {}, 51);
      expectStatus(open, [200, 201]);
      assert.deepEqual(open.body.data, { eligible: true, reason: "not_required" });
      for (let i = 1; i <= IDENTITY_RATE_MAX + 5; i += 1) {
        const res = await eligibility("1006", { email: "shortcut.probe@example.com" }, 130 + (i % 100));
        expectStatus(res, [200, 201], `lookup ${i}: `);
        assert.deepEqual(res.body.data, { eligible: true, reason: "not_required" }, `lookup ${i}`);
      }
    });

    await check("G3", "with the gate on, eligibility reports missing_identity, verified or not_purchased", async () => {
      await putConfig({ requirePurchaseToReview: true });
      try {
        const none = await eligibility("1006", {}, 52);
        expectStatus(none, [200, 201]);
        assert.deepEqual(none.body.data, { eligible: false, reason: "missing_identity" });
        const byEmail = await eligibility("1006", { email: "Buyer.Gate@Example.com" }, 52);
        expectStatus(byEmail, [200, 201]);
        assert.deepEqual(byEmail.body.data, { eligible: true, reason: "verified" });
        const byPhone = await eligibility("1006", { phone: "+84 901 234 567" }, 52);
        expectStatus(byPhone, [200, 201]);
        assert.deepEqual(byPhone.body.data, { eligible: true, reason: "verified" });
        const stranger = await eligibility("1006", STRANGER, 52);
        assert.deepEqual(stranger.body.data, { eligible: false, reason: "not_purchased" });
        const otherProduct = await eligibility("1002", { email: BUYER.email }, 52);
        assert.deepEqual(otherProduct.body.data, { eligible: false, reason: "not_purchased" });
        expectStatus(await eligibility("1006", { email: "not-an-email" }, 52), 400, "invalid email: ");
      } finally {
        await putConfig(CONFIG_BASELINE);
      }
    });

    await check("G4", "gated eligibility lookups are limited per identity, whatever client sends them", async () => {
      await putConfig({ requirePurchaseToReview: true });
      try {
        const identity = { email: "enumerate.target@example.com" };
        let throttledAt = null;
        for (let attempt = 1; attempt <= IDENTITY_RATE_MAX + 3; attempt += 1) {
          const res = await eligibility("1006", identity, 100 + attempt);
          if (res.status === 429) {
            throttledAt = attempt;
            break;
          }
          expectStatus(res, [200, 201], `attempt ${attempt}: `);
          assert.equal(res.body.data.eligible, false, `attempt ${attempt}`);
        }
        assert.equal(throttledAt, IDENTITY_RATE_MAX + 1, `first identity 429 at attempt ${throttledAt}`);
        const submit = await submitAs("1006", { rating: 5, author: "Enumerator", ...identity }, 200);
        expectStatus(submit, 429, "submit with the throttled identity from a fresh client: ");
        expectStatus(await eligibility("1006", { email: "someone.else@example.com" }, 201), [200, 201], "another identity: ");
      } finally {
        await putConfig(CONFIG_BASELINE);
      }
    });

    await check("G5", "requirePurchaseToReview gates submissions: identity_required, purchase_required, then a verified review", async () => {
      await putConfig({ requirePurchaseToReview: true });
      try {
        const before = await prisma.reviewProduct.count({ where: { productId: "1006" } });
        const noId = await submitAs("1006", { rating: 5, author: "No Identity" }, 61);
        expectStatus(noId, 400, "no identity: ");
        assert.equal(noId.body.code, "identity_required", brief(noId));
        const stranger = await submitAs("1006", { rating: 5, author: "Stranger", ...STRANGER }, 62);
        expectStatus(stranger, 403, "unknown purchaser: ");
        assert.equal(stranger.body.code, "purchase_required", brief(stranger));
        const forged = await submitAs("1006", { rating: 5, author: "Forger", verified: true, ...STRANGER }, 63);
        expectStatus(forged, 403, "client-sent verified:true: ");
        assert.equal(forged.body.code, "purchase_required", brief(forged));
        const wrongProduct = await submitAs("1002", { rating: 5, author: "Buyer", email: BUYER.email }, 64);
        expectStatus(wrongProduct, 403, "purchase of another product: ");
        assert.equal(wrongProduct.body.code, "purchase_required", brief(wrongProduct));
        const ok = await submitAs("1006", { rating: 5, author: "Gate Buyer", content: "Bought and loved it", email: BUYER.email }, 65);
        expectStatus(ok, [200, 201], "purchaser: ");
        assert.equal((await rowOf(ok.body.data)).verified, true, "purchaser's review is not stored verified");
        const byPhone = await submitAs("1006", { rating: 4, author: "Phone Buyer", phone: "090 123 4567" }, 66);
        expectStatus(byPhone, [200, 201], "purchaser by phone: ");
        assert.equal((await rowOf(byPhone.body.data)).verified, true, "phone purchaser's review is not stored verified");
        assert.equal(await prisma.reviewProduct.count({ where: { productId: "1006" } }) - before, 2, "a refused submission was stored");
        const listing = await admin(sessions.A, "GET", `${ADMIN_REVIEWS}/1006`);
        const mine = findDeep(listing.body, (o) => o.id === ok.body.data.id)[0];
        assert.ok(mine && mine.verified === true, `admin list does not show the verified flag: ${listing.raw.slice(0, 200)}`);
      } finally {
        await putConfig(CONFIG_BASELINE);
      }
    });

    await check("G6", "without the gate a client cannot set verified, status or pinned; a real purchaser is still marked verified", async () => {
      const forged = await submitAs("1004", { rating: 5, author: "Self Verified", verified: true, status: "approved", pinned: true, ...STRANGER }, 71);
      expectStatus(forged, [200, 201]);
      assert.equal(forged.body.data.status, "pending", "client-sent status was honoured");
      const forgedRow = await rowOf(forged.body.data);
      assert.equal(forgedRow.verified, false, "client-sent verified:true was stored");
      assert.equal(forgedRow.pinned, false, "client-sent pinned:true was stored");
      const buyer = await submitAs("1004", { rating: 5, author: "Real Buyer", email: BUYER.email }, 72);
      expectStatus(buyer, [200, 201]);
      assert.equal((await rowOf(buyer.body.data)).verified, true, "a matching purchase did not verify the review");
      const anonymous = await submitAs("1004", { rating: 5, author: "Anonymous" }, 73);
      expectStatus(anonymous, [200, 201]);
      assert.equal((await rowOf(anonymous.body.data)).verified, false);
    });

    await check("G7", "form modes: hidden fields are dropped, required fields are enforced with their own code", async () => {
      await putConfig({ formEmailMode: "hidden", formPhoneMode: "required", formTitleMode: "hidden", formContentMode: "required" });
      try {
        const noPhone = await submitAs("1003", { rating: 4, author: "Form", content: "Long enough" }, 81);
        expectStatus(noPhone, 400, "missing required phone: ");
        assert.equal(noPhone.body.code, "phone_required", brief(noPhone));
        const noContent = await submitAs("1003", { rating: 4, author: "Form", phone: "0912 000 111" }, 82);
        expectStatus(noContent, 400, "missing required content: ");
        assert.equal(noContent.body.code, "content_required", brief(noContent));
        const ok = await submitAs("1003", { rating: 4, author: "Form", content: "Filled in", phone: "0912000111", email: "hidden.email@example.com", title: "Hidden title" }, 83);
        expectStatus(ok, [200, 201]);
        const row = await rowOf(ok.body.data);
        assert.equal(row.email, null, "hidden email field was stored");
        assert.equal(row.title, null, "hidden title field was stored");
        assert.equal(row.phone, "0912000111");
        assert.equal(row.content, "Filled in");
      } finally {
        await putConfig(CONFIG_BASELINE);
      }
    });

    await check("G8", "allowImage/allowVideo are enforced on submit and on upload tickets", async () => {
      try {
        await putConfig({ allowImage: false });
        const media1003 = ownMediaUrl.replace("/1001/", "/1003/");
        const img = await submitAs("1003", { rating: 5, author: "Pic", media: [{ url: media1003, type: "image" }] }, 91);
        expectStatus(img, 400, "image while images are off: ");
        assert.equal(img.body.code, "media_type_not_allowed", brief(img));
        expectStatus(await publicTicket(STORE_A, pngTicketBody(), fromClient(92)), 403, "image ticket while images are off: ");
        const embed = await submitAs("1003", { rating: 5, author: "Clip", media: [{ url: embedUrl, type: "video" }] }, 93);
        expectStatus(embed, [200, 201], "video while only images are off: ");
        await putConfig({ allowImage: true, allowVideo: false });
        const vid = await submitAs("1003", { rating: 5, author: "Clip", media: [{ url: embedUrl, type: "video" }] }, 94);
        expectStatus(vid, 400, "video while videos are off: ");
        assert.equal(vid.body.code, "media_type_not_allowed", brief(vid));
        expectStatus(await publicTicket(STORE_A, { productId: "1003", contentType: "video/mp4", fileSize: 1000 }, fromClient(95)), 403, "video ticket while videos are off: ");
        const pic = await submitAs("1003", { rating: 5, author: "Pic", media: [{ url: media1003, type: "image" }] }, 96);
        expectStatus(pic, [200, 201], "image while only videos are off: ");
        assert.deepEqual((await rowOf(pic.body.data)).media.map((m) => m.url), [media1003]);
        expectStatus(await publicTicket(STORE_A, pngTicketBody(), fromClient(97)), 200, "image ticket while images are on: ");
      } finally {
        await putConfig(CONFIG_BASELINE);
      }
    });

    await check("G9", "allowQnA=false: submitting is 403 qna_disabled and the public list is empty; turning it back on restores both", async () => {
      await putConfig({ allowQnA: false });
      try {
        const asked = await api(`${PUBLIC_QNA}/1002`, { method: "POST", headers: gateClient(98), json: { author: "Asker", question: "Is Q&A really disabled?" } });
        expectStatus(asked, 403, "question while Q&A is off: ");
        assert.equal(asked.body.code, "qna_disabled", brief(asked));
        const list = await api(`${PUBLIC_QNA}/1002`, { headers: submitHeaders });
        expectStatus(list, 200);
        assert.equal(list.body.data.total, 0, brief(list));
        assert.equal(list.body.data.items.length, 0);
        assert.equal(await prisma.qnaQuestion.count({ where: { question: "Is Q&A really disabled?" } }), 0, "a refused question was stored");
      } finally {
        await putConfig(CONFIG_BASELINE);
      }
      const back = await api(`${PUBLIC_QNA}/1002`, { headers: submitHeaders });
      assert.equal(back.body.data.total, 1, brief(back));
    });

    console.log("\n--- uninstall and reinstall ---");
    await check("U1", "app/uninstalled revokes admin access for that store only and wipes its token", async () => {
      const preUninstallState = (await startInstall(STORE_B)).state;
      sessions.preUninstallState = preUninstallState;
      const { res } = await deliver({ topic: "app/uninstalled", payload: { domain: STORE_B }, eventId: "evt-uninstall-b" });
      expectStatus(res, [200, 201]);
      expectStatus(await admin(sessions.B, "GET", "/api/app/session"), 401, "uninstalled store session: ");
      expectStatus(await admin(sessions.B, "GET", `${ADMIN_REVIEWS}?limit=5`), 401, "uninstalled store list: ");
      expectStatus(await admin(sessions.A, "GET", "/api/app/session"), 200, "other store unaffected: ");
      const row = await prisma.appInstall.findUnique({ where: { storeDomain: STORE_B } });
      assert.equal(row.status, "uninstalled");
      assert.equal(row.accessTokenCiphertext, null, "token not wiped on uninstall");
      const submit = await api(`${PUBLIC_REVIEWS}/1001`, { method: "POST", headers: { "x-store-domain": STORE_B }, json: { rating: 5, author: "After uninstall" } });
      expectStatus(submit, [401, 403, 409], "public submission after uninstall: ");
    });

    await check("U2", "an install callback whose state predates the uninstall is refused", async () => {
      const res = await api(`/api/oauth/install/callback?code=e2e-code-beta&state=${sessions.preUninstallState}`, { headers: { accept: "application/json" } });
      expectStatus(res, 400);
      assert.match(String(res.raw), /[Ss]tale/);
      const row = await prisma.appInstall.findUnique({ where: { storeDomain: STORE_B } });
      assert.equal(row.status, "uninstalled", "a stale callback reinstalled the app");
    });

    await check("U3", "a fresh install after uninstall restores access with a new token", async () => {
      await sleep(15);
      const fresh = await install(STORE_B, "e2e-code-beta");
      expectStatus(await admin(fresh, "GET", "/api/app/session"), 200, "new session: ");
      expectStatus(await admin(sessions.B, "GET", "/api/app/session"), 401, "a session issued before the uninstall predates the new installation: ");
      sessions.B2 = fresh;
    });

    await check("U4", "a repeated app/uninstalled after a reinstall runs again instead of being swallowed as a duplicate", async () => {
      const live = await prisma.appInstall.findUnique({ where: { storeDomain: STORE_B } });
      assert.equal(live.status, "active", "store B is not reinstalled");
      const again = await deliver({ topic: "app/uninstalled", payload: { domain: STORE_B }, eventId: "evt-uninstall-b" });
      expectStatus(again.res, [200, 201]);
      assert.ok(!again.res.body.duplicate, `the repeated uninstall was dropped as a duplicate: ${brief(again.res)}`);
      const row = await prisma.appInstall.findUnique({ where: { storeDomain: STORE_B } });
      assert.equal(row.status, "uninstalled", "the repeated uninstall did not run");
      assert.equal(row.accessTokenCiphertext, null, "token survived the repeated uninstall");
      expectStatus(await admin(sessions.B2, "GET", "/api/app/session"), 401, "session after the repeated uninstall: ");
      assert.equal(await eventCount({ providerEventId: "evt-uninstall-b" }), 2, "each delivery must be recorded under its own lifecycle generation");
      await sleep(15);
      sessions.B = await install(STORE_B, "e2e-code-beta");
      expectStatus(await admin(sessions.B, "GET", "/api/app/session"), 200, "store B after the final reinstall: ");
    });

    console.log("\n--- logout, throttling, invariants ---");
    await check("S1", "logout clears the cookie, and needs a session and a trusted origin", async () => {
      const cookie = sessions.A.cookie.split(";")[0];
      expectStatus(await api("/api/auth/logout", { method: "POST", headers: trusted }), 401, "no session: ");
      expectStatus(await api("/api/auth/logout", { method: "POST", headers: { cookie, origin: "https://evil.example.com" } }), 401, "evil origin: ");
      const ok = await api("/api/auth/logout", { method: "POST", headers: { cookie, ...trusted } });
      expectStatus(ok, [200, 201]);
      assert.match(ok.setCookie[0] || "", /sapo_app_session=;|Max-Age=0|Expires=Thu, 01 Jan 1970/i);
    });

    await check("S2", "public writes are rate limited per store and client, before any work is done", async () => {
      const headers = { "x-store-domain": STORE_GHOST, ...fromClient(90) };
      let firstThrottled = null;
      const statuses = [];
      for (let attempt = 1; attempt <= PUBLIC_WRITE_LIMIT + 3; attempt += 1) {
        const res = await api(`${PUBLIC_REVIEWS}/1001`, { method: "POST", headers, json: { rating: 5, author: "Flood" } });
        statuses.push(res.status);
        if (res.status === 429 && firstThrottled === null) firstThrottled = attempt;
      }
      assert.equal(firstThrottled, PUBLIC_WRITE_LIMIT + 1, `first 429 at attempt ${firstThrottled}; statuses=${statuses.join(",")}`);
      assert.ok(statuses.slice(firstThrottled - 1).every((s) => s === 429), `throttle did not hold: ${statuses.join(",")}`);
      const other = await api(`${PUBLIC_REVIEWS}/1001`, { method: "POST", headers: { "x-store-domain": "e2e-other-ghost.mysapo.net", ...fromClient(90) }, json: { rating: 5, author: "Flood" } });
      assert.notEqual(other.status, 429, "one store's flood throttled a different store");
    });

    await check("S3", "launch verification is rate limited per client", async () => {
      let firstThrottled = null;
      for (let attempt = 1; attempt <= AUTH_LIMIT + 5; attempt += 1) {
        const res = await api(`/api/oauth/install/login/verify-hmac?hmac=${"A".repeat(43)}=&store=${STORE_A}&timestamp=${nowSec()}`);
        if (res.status === 429 && firstThrottled === null) firstThrottled = attempt;
        if (res.status === 429) break;
      }
      assert.ok(firstThrottled !== null && firstThrottled <= AUTH_LIMIT + 1, `no 429 within ${AUTH_LIMIT + 1} attempts (first at ${firstThrottled})`);
    });

    await check("S4", "no response body contained a configured secret or a Sapo access token", async () => {
      const leaks = [];
      for (const { route, raw } of allResponses) {
        for (const [label, secret] of Object.entries(SECRETS)) {
          if (label !== "clientId" && raw.includes(secret)) leaks.push(`${label} in ${route}`);
        }
        if (/e2e-token-[a-z]+-\d+/.test(raw)) leaks.push(`Sapo token in ${route}`);
      }
      assert.deepEqual(leaks, [], `secrets leaked:\n${leaks.join("\n")}`);
    });

    await check("S5", "the Sapo stub saw only expected API calls, each with the right store token", async () => {
      assert.deepEqual(stub.unexpected.map((c) => `${c.method} ${c.host}${c.path} (${c.reason})`), []);
      const nonOauth = stub.calls.filter((c) => c.path !== "/admin/oauth/access_token");
      const unauthorized = nonOauth.filter((c) => !c.token || !c.token.startsWith("e2e-token-"));
      assert.equal(unauthorized.length, 0, `${unauthorized.length} Sapo API calls had no store access token`);
    });

    await check("S6", "server log shows no unhandled rejection or uncaught exception, and the process is alive", async () => {
      const { stdout, stderr } = server.logs();
      assert.equal(server.proc.exitCode, null, "server process died during the run");
      assert.ok(!/UnhandledPromiseRejection|uncaughtException|Unhandled rejection/i.test(stdout + stderr), `unhandled error in server log:\n${redact((stdout + stderr).slice(-600), [db.url])}`);
      expectStatus(await api("/livez"), 200);
    });

    await server.stop();
    server = null;
    await check("S7", "the server stops and releases its port", async () => {
      await sleep(200);
      assert.ok(await isPortFree(SERVER_PORT), `port ${SERVER_PORT} still bound after stop`);
    });

    await check("S8", "boot refuses the public sample or a malformed DATA_ENCRYPTION_KEY and names the variable", async () => {
      const sample = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
      for (const [label, value] of [
        ["sample key as hex", sample.toString("hex")],
        ["sample key as base64", sample.toString("base64")],
        ["three-byte key", "abcd"],
      ]) {
        const outcome = await infra.bootExpectingRefusal({ stubPort: STUB_PORT, env: { ...serverEnv, DATA_ENCRYPTION_KEY: value } });
        assert.equal(outcome.timedOut, false, `${label}: the server kept running`);
        assert.notEqual(outcome.exitCode, 0, `${label}: the server exited cleanly`);
        assert.match(outcome.output, /DATA_ENCRYPTION_KEY/, `${label}: refusal does not name the variable: ${outcome.output.slice(-300)}`);
        assert.ok(!outcome.output.includes(value), `${label}: the key value was printed`);
      }
    });

    await check("S9", "boot refuses a short or placeholder R2_UPLOAD_SECRET and a partial R2 configuration", async () => {
      for (const [label, patch, pattern] of [
        ["short secret", { R2_UPLOAD_SECRET: "too-short-upload-secret" }, /R2_UPLOAD_SECRET must be at least 32 bytes/],
        ["placeholder secret", { R2_UPLOAD_SECRET: "replace-with-generated-upload-secret-min-32-bytes" }, /R2_UPLOAD_SECRET must not be a placeholder/],
        ["missing public domain", { R2_PUBLIC_DOMAIN: "" }, /R2_PUBLIC_DOMAIN is required when any of/],
      ]) {
        const outcome = await infra.bootExpectingRefusal({ stubPort: STUB_PORT, env: { ...serverEnv, ...patch } });
        assert.equal(outcome.timedOut, false, `${label}: the server kept running`);
        assert.notEqual(outcome.exitCode, 0, `${label}: the server exited cleanly`);
        assert.match(outcome.output, pattern, `${label}: ${outcome.output.slice(-300)}`);
        assert.ok(!outcome.output.includes(SECRETS.uploadSecret), `${label}: the configured secret was printed`);
      }
    });

    const failed = results.filter((r) => !r.passed);
    const report = {
      suite: SUITE,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      stateBackend: state.kind,
      database: db.dbName,
      migrations: migrationTail,
      verdict: failed.length === 0 ? "PASS" : "FAIL",
      total: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
      cases: results,
      bugs,
    };
    writeFileSync(path.join(ARTIFACTS, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\n${report.verdict} ${SUITE}: ${report.passed}/${report.total} passed (${report.durationMs}ms), state backend: ${state.kind}`);
    if (failed.length) {
      console.error("Failures:");
      for (const f of failed) console.error(` - ${f.id} ${f.name}`);
    }
    process.exitCode = failed.length ? 1 : 0;
  } finally {
    if (server) await server.stop().catch((e) => cleanupErrors.push(`server: ${e.message}`));
    if (stub) await stub.close().catch((e) => cleanupErrors.push(`stub: ${e.message}`));
    if (prisma) await prisma.$disconnect().catch((e) => cleanupErrors.push(`prisma: ${e.message}`));
    await state.cleanup().catch((e) => cleanupErrors.push(`redis cleanup: ${e.message}`));
    await db.drop().catch((e) => cleanupErrors.push(`DROP ${db.dbName}: ${redact(e.message, [db.url])}`));
    if (cleanupErrors.length) {
      console.error(`CLEANUP FAILED:\n${cleanupErrors.join("\n")}`);
      process.exitCode = 1;
    } else {
      console.log(`Throwaway database ${db.dbName} dropped.`);
    }
  }
}

main().catch((error) => {
  console.error(`FAIL ${SUITE}: ${redact(error && error.stack ? error.stack : error)}`);
  process.exit(1);
});
