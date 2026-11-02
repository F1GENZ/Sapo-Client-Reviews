# Architecture and API Contracts

Current shape of the F1GENZ Review Sapo app, derived from the code. Change a contract here only together with the code and its tests.

## Workspace shape

```text
src/            NestJS server (single process, no queue consumers)
prisma/         schema.prisma and migrations
test/           node:test suites (lifecycle, durability, security, storefront, review-spam)
e2e/            Black-box HTTP contract runner (npm run test:e2e)
client/         Admin SPA (Vite + React) and client/functions/api/[[path]].js (Pages proxy)
storefront/     Storefront widget assets and .bwt theme snippets
worker/         Cloudflare Worker for R2 uploads
ecosystem.config.cjs   PM2: one app, f1genz-sapo-api
```

## Backend modules (`src/`)

| Directory | Responsibility | Must not do |
|---|---|---|
| `config/env.schema.ts`, `app-config.module.ts` | Parse and validate env once; fail closed in production. | Provide real secret defaults. |
| `sapo/oauth-state.service.ts` | Create/consume one-time OAuth state; safe-redirect check. | Read state then delete it separately. |
| `sapo/hmac-verifier.service.ts` | Launch-query HMAC (Base64, sorted A-Z) and webhook raw-body HMAC, timing-safe. | Verify parsed JSON instead of raw bytes. |
| `sapo/session.service.ts` | One-time handoff codes, session JWT, session cookie. | Put the session token in a URL. |
| `sapo/sapo.service.ts`, `sapo.controller.ts` | Install and login flows, token resolution, session probe. | Trust callback query for identity. |
| `sapo/sapo-api.service.ts` | All calls to `https://{store}/admin/...` with per-store throttling and `429` retry. | Be bypassed by direct `fetch` for store API calls. |
| `sapo/token-encryption.service.ts` | AES-256-GCM encryption of access tokens. | Return token material to clients. |
| `sapo/webhook.service.ts`, `webhook-topic-normalizer.ts`, `webhook-registration.service.ts` | Register, verify, persist, dispatch, and retry webhooks. | Mutate state before signature and identity checks. |
| `sapo/uninstall.service.ts`, `lifecycle-lock.service.ts`, `install-revocation.ts` | Uninstall cleanup, lifecycle locks, revocation marking. | Release a lock without owner compare. |
| `sapo/shop-domain.service.ts` | Domain to `storeDomain` mapping (Redis cache over `ShopDomain` rows). | Resolve tombstoned domains. |
| `common/guards/shop-auth.guard.ts` | Admin auth: origin, Bearer on unsafe methods, store match, token resolve. | Trust frontend flags. |
| `common/security/*` | Security headers, CORS, body limits, ingress rate limits, public response whitelist. | Use `KEYS`-style scans or unbounded bodies. |
| `catalog/` | Product catalog mirror and sync (`catalog_products`). | |
| `purchase/` | Order mirror for verified-buyer checks (`customer_purchases`, hashed email/phone). | Store raw buyer PII. |
| `review/`, `qna/` | Review and Q&A admin and public APIs, spam config, metafield summaries. | Expose email, phone, or raw source JSON publicly. |
| `review/review-data-tools.service.ts`, `qna/qna-data-tools.service.ts` | CSV/JSON export, import with a dry-run preview, bulk status/delete. Rows are validated by the same DTOs as the single-row routes and capped per request. | Write a row that failed validation, or import without a per-store scope. |
| `review/slider-payload.ts` | Compact public payload for `<f1genz-curated-slider>` (pinned, then rating, then recency; 220-char content; 8 kB cap). | Include contact fields or unwrapped media URLs. |
| `review.service.ts` (widget-config revisions) | Widget-config history and restore. | Return another store's revision. |
| `outbound/` | Merchant webhooks: CRUD, signed delivery, retry sweeper, dead-letter after the attempt cap, SSRF guard on the target host. | Follow a redirect, or retry a terminal delivery. |
| `ai/` | Reply suggestion behind `GEMINI_API_KEY`. Without a key the route answers 503 and the admin shows the reason as a toast. | Call the model for anonymous input, or log prompt content. |
| `storefront/` | Storefront config metafield and widget asset serving. | |
| `media/` | Upload tickets (HMAC-signed) for the R2 Worker; best-effort object deletion and listing through the Worker (`DELETE /<key>`, `GET /list`). | |
| `dashboard/`, `ops/` | Admin KPIs; health, resync, backfill, and the durability sweep. | |
| `health/` | `/livez`, `/readyz`. | Expose details publicly. |
| `redis/`, `database/` | Namespaced Redis helpers (`GETDEL`, owner locks, `SCAN`); Prisma service. | |

Modules are wired in `src/app.module.ts`.

## Frontend (`client/src`)

- Pages: `auth`, `dashboard`, `reviews`, `qna`, `settings`, `ops`, `guide`, `dev`, `contact`.
- API base is the `VITE_SAPO_API_URL` dev proxy locally and same-origin `/api` through the Cloudflare Pages function in production.
- The SPA exchanges the one-time `handoff_code` for a session token, stores it per store in browser storage (`client/src/common/AuthStorage.js`), and sends it as `Authorization: Bearer`. Auth query params are stripped from the URL after processing.
- No Sapo access token is ever stored or rendered.

## HTTP routes

### Auth and lifecycle (`src/sapo/sapo.controller.ts`)

| Method | Path | Auth | Contract |
|---|---|---|---|
| `GET` | `/api/oauth/install/start` | public, auth rate limit | Returns an install authorize URL for `storeDomain`. |
| `GET`/`POST` | `/api/oauth/install/callback` | public, auth rate limit | Install callback; consumes `install` state, exchanges the code, persists the install, returns a handoff (JSON or `302` to `FRONTEND_URL` for browsers). |
| `GET` | `/api/oauth/install/login`, `/api/oauth/install/login/entry` | public, auth rate limit | Start a login flow. |
| `GET` | `/api/oauth/install/login/verify-hmac` | public, auth rate limit | Verify the signed launch query and return a handoff; no `hmac` starts login; invalid `hmac` is `401`. |
| `GET`/`POST` | `/api/oauth/install/login/callback` | public, auth rate limit | Login callback; returns a handoff or an install URL. |
| `GET` | `/api/oauth/install/webhooks` | public | `200 ok` for reachability. |
| `POST` | `/api/oauth/install/webhooks` | HMAC signature | Webhook delivery, see `docs/webhook-subscription-uninstall.md`. |
| `POST` | `/api/auth/session/exchange` | handoff code, trusted origin, rate limited | Consume the code; set cookie; return `{ ok, storeDomain, redirectTo, sessionToken }`. |
| `POST` | `/api/auth/logout` | session, trusted origin | Clear the cookie. |
| `GET` | `/api/app/session` | session | `{ data: { storeDomain, shopDomain, status, featuresUnlocked, webhookStatus } }`. |
| `GET` | `/livez` | public | `{ ok: true }` only. |
| `GET` | `/readyz` | `Bearer READINESS_TOKEN` | `{ ok, degraded, status, redis, db, recentFailures, failureWindowMinutes, webhookRegistration, webhookDegraded, build }`. No secrets. |

### Admin API (`ShopAuthGuard`, prefix `/api/admin`)

| Prefix | Routes |
|---|---|
| `/dashboard` | `GET /overview` |
| `/products` | `GET /`, `GET /:productId` |
| `/reviews` | `GET/PUT widget-config`, `GET/PUT spam-config`, `POST sync-metafield`, `GET /`, `GET/POST /:productId`, `GET /:productId/stats`, `PATCH /:productId/:reviewId` plus `/status`, `/reply`, `/pin`, `DELETE /:productId/:reviewId` |
| `/qna` | `GET /`, `GET/POST /:productId`, `GET /:productId/stats`, `PATCH /:productId/:questionId` plus `/status`, `/answer`, `DELETE /:productId/:questionId` |
| `/media` | `POST /upload-ticket` |
| `/ops` | `GET /health`, `POST /resync-config`, `POST /resync-webhooks`, `POST /backfill-catalog` |

Admin responses wrap payloads as `{ data: ... }`. Every unsafe method needs the Bearer session token and a trusted `Origin`/`Referer`.

### Public API (anonymous, prefix `/api/public`)

| Prefix | Routes |
|---|---|
| `/reviews` | `GET config/widget`, `GET summaries`, `POST /:productId/purchase-eligibility`, `GET /:productId`, `GET /:productId/summary`, `POST /:productId` |
| `/qna` | `GET /:productId`, `POST /:productId` |
| `/media` | `POST /ticket`, `POST /upload` |

The store comes from the `x-store-domain` header or the `storeDomain` query. Public requests get a per-client budget (reads 900/min, writes 120/min); reads have no per-store cap. Submissions also get the per-store-and-client `PUBLIC_WRITE_RATE_LIMIT_*` cap. Body limit is 256 kB. Responses pass `PublicResponseInterceptor`, which whitelists fields.

### Storefront assets

`GET /storefront/f1genz-storefront.js` and `GET /storefront/f1genz-storefront.css` (`src/storefront/storefront-asset.controller.ts`).

## Data model (`prisma/schema.prisma`)

| Model | Purpose |
|---|---|
| `Shop`, `AppInstall` | One row per store: status, encrypted token columns, `tokenVersion`, `lifecycleGeneration`, webhook registration status, `dataPreserved`. |
| `ShopDomain` | Active/tombstoned domains per store; one active owner per domain. |
| `WebhookEvent` | Idempotent webhook log with status, attempts, retry schedule. `orders/*` payloads are stored as a PII-free projection; payload and headers are nulled on uninstall; rows are purged by the retention pass. |
| `CatalogProduct`, `CustomerPurchase` | Product and order mirrors. |
| `ReviewProduct`, `QnaQuestion` | Reviews and questions (author-entered email/phone kept only in these tables). |
| `MetafieldSyncPending` | Queue of product metafield writes still to be reconciled. |
| `SubscriptionSnapshot` | Present in the schema; no current route writes it (the app has no billing). |

## Redis keys

All keys are prefixed by `REDIS_KEY_PREFIX`.

| Key pattern | TTL | Purpose |
|---|---|---|
| `oauth-state:{sha256(state)}` | 30 min | OAuth state (flow, store, safe redirect). |
| `session-handoff:{sha256(code)}` | `SESSION_HANDOFF_TTL_SECONDS` | One-time handoff payload. |
| `session-handoff-store:{storeDomain}:{sha256(code)}` | same | Index so uninstall can delete a store's pending handoffs. |
| `domain:{domain}` | none | Domain to `storeDomain` cache; rebuilt from `ShopDomain` on miss. |
| `lock:lifecycle:{storeDomain}` | 30 s | Install and uninstall serialization. |
| `lock:review:{shopId}:{productId}` | 30 s | Serializes read-modify-write on one product's reviews and its summary metafield; if Redis is unreachable the write continues unlocked because PostgreSQL is the source of truth. |
| `lock:durability-sweep` | 120 s | One sweep at a time across processes. |
| `rate:{bucket}:{fingerprint}` | window | Ingress rate limiting. |

## Data boundary

PostgreSQL is the durable source for installs, tokens, domains, webhook events, and review data. Redis holds one-time secrets, locks, rate counters, and the domain cache. After a Redis flush the domain cache refills from the database, but in-flight OAuth states and handoff codes are lost and the merchant simply restarts the flow; an uninstalled install is never revived from Redis.

## Security invariants

- OAuth state and handoff codes are one-time and atomically consumed.
- Launch HMAC and webhook HMAC use timing-safe comparison; webhook HMAC covers the raw body.
- Webhook mutation needs a verified signature and a resolved store identity.
- Sapo access tokens stay server-side and are encrypted at rest.
- Unsafe admin requests need a Bearer session token and a trusted origin.
- Uninstall nulls token columns, clears Redis state, and tombstones domains.
- Public endpoints have body limits, rate limits, and response whitelists.
- `/livez` is public and minimal; `/readyz` is protected.
