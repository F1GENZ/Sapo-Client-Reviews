# Parity — F1GENZ Review Sapo vs Haravan (2026-11-02)

Built from code, not folder names. Haravan reference `E:/Work/apps/F1GENZ_Review` is read-only
(`server/src/**`, `server/storefront/snippets/**`, `client/src/**`). Sapo code lives in `src/**`,
`storefront/**`, `client/src/**`.

Decision vocabulary: `PORTED` (behaviour copied into Sapo, test proves it), `ALREADY_EQUAL`,
`BETTER_ON_SAPO`, `NOT_APPLICABLE` (platform reason + doc), `BLOCKED` (exact missing item).
"Plan:" rows are written before the code change; the Proof column is filled by the round-2 run.

## 1. Admin API surface

| Capability | Haravan route | Sapo route | Gap | Decision | Proof |
|---|---|---|---|---|---|
| Review list + paging + filters (status/star/sort/search/product) | `GET /reviews/all` | `GET /api/admin/reviews` | no | ALREADY_EQUAL | `src/review/review.controller.ts:107`, `listAllReviews` |
| Reviews per product + stats | `GET /reviews/:productId`, `/summary` | `GET /api/admin/reviews/:productId`, `/:productId/stats` | no | ALREADY_EQUAL | `review.controller.ts:131,147` |
| Create / edit / status / reply / delete review | `POST/PUT/DELETE /reviews/:productId/:reviewId` | same, `PATCH` | no | ALREADY_EQUAL | `review.controller.ts:157–267` |
| Pin review | `PUT /reviews/bulk` (partial) | `PATCH /:productId/:reviewId/pin` | no | BETTER_ON_SAPO | `review.controller.ts:229` |
| Bulk status/delete | `POST /reviews/bulk` | — | yes | PORTED | `POST /api/admin/reviews/bulk` + `test/review-bulk-import.test.ts` |
| Export CSV/JSON | `GET /reviews/export` | — | yes | PORTED (admin button `Xuất` on /reviews, /qna) | `GET /api/admin/reviews/export?format=csv|json` |
| Import CSV/JSON + dry-run + job status/history | `POST /reviews/import`, `/import/dry-run`, `/import/jobs`, `GET /import/jobs/:id`, `/import/history` | — | yes | PORTED (synchronous with row cap; no job queue — see R08; UI `Nhập CSV/JSON` with dry-run preview + errors table) | `POST /api/admin/reviews/import`, `/import/dry-run`, `GET /api/admin/reviews/import/history` |
| Widget config get/put | `GET/PUT /reviews/config/widget` | `GET/PUT /api/admin/reviews/widget-config` | no | ALREADY_EQUAL | `review.controller.ts:56–63` |
| Widget config revision history + restore | `GET /config/widget/revisions`, `POST /config/widget/revisions/:id/restore` | — | yes | PORTED | `GET /api/admin/reviews/widget-config/revisions`, `POST .../:revisionId/restore` |
| Spam config get/put | `GET/PUT /reviews/config/spam` | `GET/PUT /api/admin/reviews/spam-config` | no | ALREADY_EQUAL | `review.controller.ts:74–81` |
| Sync summary metafield | `POST /reviews/index/rebuild` | `POST /api/admin/reviews/sync-metafield` | no | ALREADY_EQUAL (Sapo persists summaries in Postgres + Sapo metafields; no Redis index to rebuild) | `review.controller.ts:92` |
| Q&A list / per product / stats | `GET /qna/all`, `/:productId`, `/:productId/summary` | `GET /api/admin/qna`, `/:productId`, `/:productId/stats` | no | ALREADY_EQUAL | `qna.controller.ts:42,64,83` |
| Q&A create / edit / status / answer / delete | `POST/PUT/DELETE /qna/:productId...` | `POST/PATCH/DELETE /api/admin/qna/:productId...` | no | ALREADY_EQUAL | `qna.controller.ts:93–162` |
| Q&A bulk status/delete | `POST /qna/bulk` | — | yes | PORTED | `POST /api/admin/qna/bulk` |
| Q&A export / import (+dry-run, jobs) | `GET /qna/export`, `POST /qna/import*` | — | yes | PORTED | `GET /api/admin/qna/export`, `POST /api/admin/qna/import`, `/import/dry-run` |
| Products list/detail | `GET /products`, `/products/:id` | `GET /api/admin/products`, `/:productId` | no | ALREADY_EQUAL | `products.controller.ts:69,85` |
| Media upload | `POST /media/upload` (multer → R2) | `POST /api/admin/media/upload-ticket` → worker | no | BETTER_ON_SAPO (sniffed content type, per-store daily cap, 5 MB image / 2 MB video, R2 worker pin) | `media.controller.ts:11`, `media.service.ts:57–87` |
| Dashboard overview | `GET /dashboard/overview` | `GET /api/admin/dashboard/overview` | no | ALREADY_EQUAL | `dashboard.controller.ts:10` |
| Dashboard rebuild-stats | `POST /dashboard/rebuild-stats` | — | yes (informational) | NOT_APPLICABLE — Sapo stats are computed per request from Postgres (`dashboard.service.ts`), there is no cached aggregate to rebuild | — |
| Shop info | `GET /dashboard/shop-info` | `GET /api/app/session` | no | ALREADY_EQUAL | `sapo.controller.ts:234` |
| Ops health | `GET /ops/health` | `GET /api/admin/ops/health` | no | ALREADY_EQUAL | `ops.controller.ts:17` |
| Ops resync config / webhooks / catalog backfill | `POST /ops/webhooks/ensure`, `/webhooks/retry-failed`, `/catalog/sync` | `POST /api/admin/ops/resync-config`, `/resync-webhooks`, `/backfill-catalog` | no | ALREADY_EQUAL | `ops.controller.ts:22–32` |
| Ops catalog audit | `GET /ops/catalog/audit` | inside `/ops/health` (`catalog`, `purchases`) | no | ALREADY_EQUAL | `ops.service.ts:73–105` |
| Ops orders resync | `POST /ops/orders/sync` | — | yes | PORTED | `POST /api/admin/ops/orders/sync` (page cap, per-store lock) |
| Ops metafields sync-all | `POST /ops/metafields/sync-all` | — | yes | PORTED | `POST /api/admin/ops/metafields/sync-all` |
| Ops diagnostics export | `GET /ops/diagnostics/export` | — | yes | PORTED | `GET /api/admin/ops/diagnostics/export` |
| Ops queues / job retry / job ignore | `GET /ops/queues`, `POST /jobs/*` | — | yes | NOT_APPLICABLE — no BullMQ/Bull board in Sapo; webhooks are processed inline with DB retry (`webhook.service.ts:retryDueFailed`) and the durability sweep reports its own counters (`durability-sweep.service.ts`) | `src/ops/durability-sweep.service.ts:43` |
| Outbound merchant webhooks CRUD + deliveries + rotate/test | `GET/POST/PUT/DELETE /outbound-webhooks` | — | yes | PORTED | `src/outbound/**` + `client/src/pages/webhooks/index.jsx` (route `/integrations`, sidebar `Tích hợp`) |
| AI reply suggestion | `POST /ai/reply-suggestion` | — | yes | PORTED, key BLOCKED (needs `GEMINI_API_KEY`); UI `Gợi ý bằng AI` in the reply editor, server returns 503 with a clear message when the key is absent | `POST /api/admin/ai/reply-suggestion` |
| AI highlights (per product, credit-metered) | `GET/POST /ai/highlights/:productId` | — | yes | BLOCKED — needs a paid model key plus a credit ledger tied to plans; Sapo has no billing API (see §4) | — |
| AI seeds (demo review seeding) | `POST /ai/seeds` | — | yes | BLOCKED — same key; writing generated reviews into merchant data is a product decision, not a parity port | — |
| Premium / pricing pages (plans, upgrade, invoices) | `/premium`, `/pricing`, `haravan/entitlement.service.ts` | — | yes | BLOCKED — Sapo has no public app-charge/recurring-billing API (docs: https://support.sapo.vn , https://developers.sapo.vn — no "charge"/"billing" entity in the app model; the Partner app form has no price field) | round-1 §7.4 |
| Plan tiers / watermark / entitlement flags | `haravan/plan-tiers.ts` (Free, Super, Super Heavy; watermark on Free) | `AppInstall.featuresUnlocked` only | yes | NOT_APPLICABLE today; entitlement point already single (`featuresUnlocked`, `src/review/review.service.ts`), everyone runs the Super-equivalent set until Sapo exposes billing | `src/sapo/sapo.service.ts` (featuresUnlocked default true) |
| OAuth install / login / session / logout / webhook registration | `haravan.controller.ts` | `sapo.controller.ts:76–239` | no | ALREADY_EQUAL (single-use OAuth state, Base64 HMAC, handoff exchange) | `oauth-state.service.ts:56–75`, `sapo.controller.ts:190` |
| Lifecycle install/uninstall/reinstall | `app/uninstalled` handler | `uninstall.service.ts` + `lifecycleGeneration` | no | BETTER_ON_SAPO (generation fence + payload scrub incl. headers) | `uninstall.service.ts:52–75` |

## 2. Public API surface

| Capability | Haravan | Sapo | Gap | Decision | Proof |
|---|---|---|---|---|---|
| Widget config | `GET /public/reviews/config/widget` | same | no | ALREADY_EQUAL | `public-review.controller.ts:112` |
| Batch summaries | `GET /public/reviews/summaries` | same | no | ALREADY_EQUAL | `:122` |
| Reviews list (paging, sort) | `GET /public/reviews/:productId` | same | no | ALREADY_EQUAL | `:154` |
| Review summary | `GET .../:productId/summary` | same | no | ALREADY_EQUAL | `:172` |
| Curated slider | `GET .../:productId/slider` (entitlement-gated) | same endpoint, compact v1 payload (`id,r,a,t,c,m,v,d`), pinned→rating→recency order, content 220 chars, 8 kB cap, image-only thumbnail | no | PORTED (no gate: Sapo runs the Super-equivalent set; ordering copied from Haravan) | `src/review/slider-payload.ts` + `test/r2-parity.test.ts` |
| Purchase eligibility | `POST .../purchase-eligibility` | same | no | ALREADY_EQUAL | `:134` |
| Submit review | `POST .../:productId` | same | no | BETTER_ON_SAPO (product existence check, media allowlist from config, fail-closed purchase check, keyed identity rate limit) | `review.service.ts:666–730` |
| Q&A list / submit | `GET/POST /public/qna/:productId` | same | no | ALREADY_EQUAL | `public-qna.controller.ts:53,74` |
| Q&A summary | `GET /public/qna/:productId/summary` | — | yes | PORTED | `GET /api/public/qna/:productId/summary` |
| Public JSON field projection (no email/phone/sourceRaw) | `review-pii.ts` | `PublicResponseInterceptor` | no | ALREADY_EQUAL | `src/common/security/public-response.ts` |
| Public JSON cache headers | none (CR68 open) | none | yes | PORTED (`Cache-Control: no-store` on public JSON) | `public-response.ts` |
| Widget JS/CSS assets | `/storefront/f1genz-storefront.{js,css}` | same | no | ALREADY_EQUAL | `storefront-asset.controller.ts:74,84` |
| Webhook ingress | `POST /webhooks/haravan` + challenge | `POST/GET /api/oauth/install/webhooks` | no | BETTER_ON_SAPO (no global throttler → a signed delivery can never get 429; raw-body HMAC; redacted headers; generation fence) | `webhook.service.ts:handle` |

## 3. Storefront widget features

| Feature | Haravan | Sapo | Gap | Decision |
|---|---|---|---|---|
| Custom elements | reviews, qna, badge, schema, curated-slider | reviews, qna, badge, schema, curated-slider (`<f1genz-curated-slider>`, honours `curatedSliderEnabled`/`curatedSliderCount`, `count` attr) | no | PORTED (e2e `B6`/`B7`) |
| Layouts list/grid/masonry | yes | yes | no | ALREADY_EQUAL |
| Media lightbox | yes | yes | no | ALREADY_EQUAL |
| Sort / filter / paging | yes | yes | no | ALREADY_EQUAL |
| Q&A tabs vs stacked | yes | yes | no | ALREADY_EQUAL |
| Rating badge SSR attrs | yes | yes | no | ALREADY_EQUAL |
| JSON-LD Product+AggregateRating | yes | yes | no | ALREADY_EQUAL |
| Escaping | `escapeHTML` + `formatSafeRichText` | `escapeHTML` (51 call sites) + JSON-LD via textContent | no | ALREADY_EQUAL |
| Accessibility names / focus restore | partial (R65/R70 fixed on Haravan) | partial | yes | PARTIAL → widget fixes in round 2 where cheap; full audit BLOCKED (needs browser measurement per state) |
| Size budget (gzip) | 30 kB cap, Haravan 30 kB widget JS | 29.9 kB JS / 5.2 kB CSS | no | ALREADY_EQUAL (measured after slider, still under cap) |
| AA text on merchant accent | white text on `#f59e0b` = 2.15:1 | `--f1genz-sapo-review-on-accent` picks dark text when white < 4.5:1 | no | BETTER_ON_SAPO (e2e `B8`; config colours unchanged) |

## 4. Billing / tiers (user decision)

Sapo publicly documents no app-charge or recurring-billing API for third-party apps, and the Partner
app form carries no price field (round-1 §7.4 read the live form). Consequence, kept honest:

- Everyone on Sapo runs the Super-equivalent entitlement (`AppInstall.featuresUnlocked = true`), so no
  capability is locked; watermarking is never applied.
- Premium/pricing pages are not ported (nothing to charge).
- Options for the owner: (a) free on Sapo, (b) external payment with manual activation, (c) wait for
  Sapo billing. The entitlement read point stays single so any of these can be wired later without a
  feature audit.

## 5. Haravan hardening findings (R01–R70) checked against Sapo

Rows that do not carry over are still listed with the Sapo mechanism that makes them inapplicable.

| ID | Haravan defect | Sapo state | Decision |
|---|---|---|---|
| R01 | Global throttler 429s signed webhooks; SkipThrottle added | No `@nestjs/throttler`; `publicRateLimitMiddleware` only on `/api/public` (`http-hardening.ts`) | NOT_APPLICABLE |
| R02 | `req.ip` behind tunnel → one bucket | `clientFingerprint` + validated `TRUST_PROXY` (`env.schema.ts`, `client-fingerprint.ts`); production value checked in round 1 | ALREADY_EQUAL; TRUST_PROXY tightened in round 2 (see §7) |
| R03 | In-memory throttler eviction cancels timers | Redis INCR+TTL with bounded memory fallback (`ingress-rate-limit.service.ts`) | NOT_APPLICABLE |
| R04 | Named throttler override ignored | No decorator overrides; limits come from env | NOT_APPLICABLE |
| R05 | 25 MB JSON buffered pre-auth | `WEBHOOK_BODY_LIMIT` + content-type guard before parse (`body-limits.ts`) | ALREADY_EQUAL |
| R06 | HMAC covers body only; topic/orgid header claims | Domain identity resolution + `assertEntityBelongsToStore` + lifecycle generation fence (`webhook.service.ts:147–210`) | BETTER_ON_SAPO |
| R07 | Weak dedupe, processing-row bumps, PII persisted | idempotency key incl. generation; CAS claims; headers redacted; payload scrubbed on uninstall; 30/90-day retention | BETTER_ON_SAPO |
| R08 | `queue.add` failure leaves row queued | Inline processing, no queue | NOT_APPLICABLE |
| R09 | Late uninstall deletes a live session | Retry path fences on generation + `receivedAt < installedAt` (`predatesCurrentInstall`); inline replay after reinstall still executes because Sapo's uninstall payload carries no provider timestamp | PORTED (receivedAt fence added to the direct path) + documented residual |
| R10 | Catalog/order ordering fence | Catalog row `updatedAt` + purchase `sourceUpdatedAt` fences (`catalog-product-store.service.ts`, `purchase-store.service.ts`) | ALREADY_EQUAL |
| R11 | Cron scan matches `app_install:oauth_state:*` | State keys are `oauth-state:*`; sweeps are DB-driven | NOT_APPLICABLE |
| R12 | Token refresh unlocked | `resolveAccessToken` + lifecycle lock + CAS-ish session write (`sapo.service.ts`, `lifecycle-lock.service.ts`) | ALREADY_EQUAL |
| R13 | Plaintext tokens | `TokenEncryptionService` (AES-GCM, `DATA_ENCRYPTION_KEY`) | BETTER_ON_SAPO |
| R14 | Static nonce, non-atomic state, unbound install URL | Random 32-byte state, Redis `getDel`, TTL, flow binding (`oauth-state.service.ts`) | BETTER_ON_SAPO |
| R15 | Launch HMAC freshness/empty-secret skip | Timestamp required with ±300 s skew, timing-safe compare (`hmac-verifier.service.ts:81–96`) | BETTER_ON_SAPO |
| R16 | Non-HttpOnly cookies | `sapo_app_session` HttpOnly/Secure/SameSite=Lax (round-1 X03) | BETTER_ON_SAPO |
| R17 | Permissive CORS with credentials | `origin-policy.ts` allowlist + guard `isTrustedUnsafeOrigin` | ALREADY_EQUAL |
| R18 | No boot env validation | `env.schema.ts` + `secret-guard.ts` fail fast | BETTER_ON_SAPO |
| R19 | Internal errors surfaced | Nest default `HttpException` mapping; no internal message pass-through in handlers read | ALREADY_EQUAL |
| R20 | Unknown `kid` refetch loop | No JWKS (HMAC launch) | NOT_APPLICABLE |
| R21 | Webhook queue concurrency | No queue | NOT_APPLICABLE |
| R22 | `ip-guard` CIDR gaps | No outbound dispatcher yet | PORTED with the outbound feature (full non-public range list) |
| R23 | `pg` pool has no `error` listener | Prisma owns the pool; `main.ts` gains `unhandledRejection` logging so a stray rejection cannot kill the API silently | PORTED (logging handler) |
| R24 | BullMQ `error` listener | No BullMQ | NOT_APPLICABLE |
| R25 | Guard turns Redis errors into 401 | Session verification is HMAC-local; Redis is not on the auth path (`session.service.ts`) | NOT_APPLICABLE |
| R26 | `void` promises without catch | `void` uses are limited to sweeps wrapped by `step()` (`durability-sweep.service.ts`) | ALREADY_EQUAL |
| R27 | No graceful shutdown | `app.enableShutdownHooks()`, PM2 `kill_timeout=10000` | ALREADY_EQUAL |
| R28 | No statement/lock timeout | Prisma URL has no statement timeout; round 2 sets `statement_timeout` on the app role on the VPS | PORTED (DB role setting) |
| R29 | Missing indexes | `WebhookEvent` has `(status,updatedAt)`, `(resolvedStoreDomain,status,receivedAt)`, `(status,nextRetryAt)` | ALREADY_EQUAL |
| R30 | No webhook retention | 30 d processed / 90 d failed + uninstall purge + media orphan sweep (`durability-sweep.service.ts`) | BETTER_ON_SAPO |
| R31 | Outbound retries never re-send | No outbound yet | PORTED with the outbound feature (retry sweeper, attempt cap) |
| R32 | Dispatcher has no deadline/content cap | — | PORTED with the outbound feature (timeout + max body + explicit terminal states) |
| R33 | Q&A write failures reported as success | Prisma transaction; failures throw | NOT_APPLICABLE |
| R34 | Q&A lock without owner token | Q&A writes are single-row upserts guarded by the DB unique key | NOT_APPLICABLE |
| R35 | Public submit has no product check | Sapo review path checks catalog + `deletedAt`; Q&A path did not | PORTED (Q&A product check) |
| R36 | Marker cleared without compare | `MetafieldSyncPending` unique key + attempt cap + `nextAttemptAt` (`metafield-sync-pending.service.ts`) | ALREADY_EQUAL |
| R37 | Shared Haravan API limiter starves shops | `SapoApiService` keeps a limiter **per store** (`sapo-api.service.ts:60–96`) | BETTER_ON_SAPO |
| R38 | Destructive scripts | `scripts/` on Sapo only contain deploy-gate/backup/remote-deploy | NOT_APPLICABLE |
| R39 | Dead retry branches, jobId churn | No queue | NOT_APPLICABLE |
| R40 | Dashboard O(P²) lists | Sapo dashboard aggregates in SQL | NOT_APPLICABLE |
| R41 | `shouldStartQueueWorkers` drift | Single process by design (round-1 §9) | NOT_APPLICABLE |
| R42 | Dead Redis blobs, dead table | No Redis review index | NOT_APPLICABLE |
| R43 | DTO rejects `email:""` | `@ValidateIf(isNonEmptyValue)` in review/qna DTOs | ALREADY_EQUAL |
| R44 | PII inside public chunk metafields | No chunk metafields; public projection whitelists fields; metafield carries avg/count/distribution only | BETTER_ON_SAPO |
| R45 | multer latin1 filename mismatch | No multer; tickets carry object keys, not filenames | NOT_APPLICABLE |
| R46 | `toStoredRow` reverts cleared fields | Edit path writes field-by-field | NOT_APPLICABLE |
| R47 | AI reservation rows never reaped | No AI ledger (reply suggestion is stateless) | NOT_APPLICABLE |
| R48 | Anonymous reviews spend AI credits | Same | NOT_APPLICABLE |
| R49 | `known:false` conflated with unreadable | Sapo reads config from its own metadata and merges explicit defaults; a missing install is refused | NOT_APPLICABLE |
| R50 | Upload buffering/ticket weaknesses | Ticket HMAC + single-use nonce + TTL + daily cap + bounded storage timeout | BETTER_ON_SAPO |
| R51 | Empty POST body 500s | `BadRequestException` guards on public bodies | ALREADY_EQUAL |
| R52 | Public write resolves vendor token (oracle) | Still resolves the token on submit; identity rate limit caps probing | ALREADY_EQUAL |
| R53 | Unkeyed SHA-256 of email/phone | `hkdfSync`-derived per-instance key with `hashVersion` (`purchase-store.service.ts:132–188`) | BETTER_ON_SAPO |
| R54 | `sanitizeText` deletes legitimate text | Sapo validates length/format then stores verbatim | NOT_APPLICABLE |
| R55 | Status edit skips approved webhook | No outbound events yet; the round-2 outbound feature emits on create/approve/edit/delete | PORTED (with outbound) |
| R56 | DTO divergences | Sapo DTOs bound length/rating/status; media URLs restricted to own R2 domain at public ingress | ALREADY_EQUAL |
| R57 | mp4 sniff accepts HEIC, no media delete | Content-type sniff + MP4 brand allowlist + delete on review delete + orphan sweep | BETTER_ON_SAPO |
| R58 | Entitlement ignores expiry | No entitlement (see §4) | NOT_APPLICABLE |
| R59 | `PUBLIC_READ_*` read before `.env` | Values injected via `AppEnv` after config load | NOT_APPLICABLE |
| R60 | PORT default mismatch | Deploy script reads `.env` PORT | ALREADY_EQUAL |
| R61 | YouTube link silently dropped | Widget does not accept external links; public media must be own R2 URL | NOT_APPLICABLE |
| R62 | Client CI resolves server path wrongly | `ci-e2e.yml` runs both suites in one checkout | ALREADY_EQUAL |
| R63 | Storefront JS budget exceeded | 27.8 kB ≤ 30 kB (round 1) | ALREADY_EQUAL |
| R64 | SPA reads `?session_token=` | Handoff code exchange (`/auth/session/exchange`) | BETTER_ON_SAPO |
| R65 | Sort select focus lost on re-render | Widget re-renders list on sort change | PORTED where the fix is a render guard; full keyboard audit BLOCKED (no state matrix run yet) |
| R66 | Storefront edge cases (schema price source, `<` in labels, double decode) | Sapo widget: JSON-LD from rendered DOM/price element, `escapeHTML` on labels | ALREADY_EQUAL (spot-checked) |
| R67 | `redirectIfChanged` no host allowlist | `authFlow.js` redirect target comes from the API install URL, not from a query param | ALREADY_EQUAL |
| R68 | Public JSON has no cache control | Same | PORTED |
| R69 | Test gaps | Round-2 adds bulk/import/export/revisions/slider/outbound/AI/ops tests | PORTED |
| R70 | Sort select missing name | Sapo widget: select has `aria-label` | ALREADY_EQUAL |

## 6. Code-review findings (CR01–CR48) checked against Sapo

| CR | Haravan defect | Sapo state | Decision |
|---|---|---|---|
| CR01 | Unthrottled 25 MB raw webhook buffer | Content-type guard + `WEBHOOK_BODY_LIMIT`; rate limiting on public reads/writes only (signed webhook stays unthrottled **by design** so Sapo can never be told to back off) | ALREADY_EQUAL |
| CR02 | Stale session tail write | No shared Redis session object; token state is a Prisma row with generation + lifecycle lock | NOT_APPLICABLE |
| CR03 | `known:false` → 503 forever | Config is Sapo metadata; absence means defaults, not unknown | NOT_APPLICABLE |
| CR04 | Client e2e needs `typescript` | Client e2e passes in CI (`ci-e2e.yml`) | ALREADY_EQUAL |
| CR05 | `markFailed` flips processed rows | `markFailed` only runs inside `runEvent` after a claim | ALREADY_EQUAL |
| CR06 | Stranded-list head-of-line | Sweeps use keyset pagination on `id` (`webhook.service.ts:reclaimStalled`) | BETTER_ON_SAPO |
| CR07 | `express.json` applies to all webhook sub-paths | Body limits are mounted on the exact webhook path | ALREADY_EQUAL |
| CR08 | Dedupe includes minute for untimed bodies | Key is topic+scope+payload hash (no time component) | BETTER_ON_SAPO |
| CR09 | FIFO webhook queue starves lifecycle | Inline | NOT_APPLICABLE |
| CR10 | Shop bucket keying | Public write bucket is `store|client` with a per-identity charge; a spoofed store cannot burn another store's bucket because the client part must match | ALREADY_EQUAL |
| CR11 | Token endpoint posts without timeout | `SapoApiService` fetch has an abort timeout | ALREADY_EQUAL |
| CR12 | Key-rotation script skips `enc:` | `TokenEncryptionService` single key, no rotation script | NOT_APPLICABLE |
| CR13 | `DB_SSL_CA` ignored | Prisma URL-driven TLS; local Postgres over loopback | NOT_APPLICABLE |
| CR14 | Refresh race without CAS | `tokenVersion` + lifecycle lock; refresh writes are conditional on version | ALREADY_EQUAL |
| CR15 | Ops retry duplicates a sweep job | No queue | NOT_APPLICABLE |
| CR16 | Bulk approve re-fires side effects | Bulk action (round 2) only emits outbound events for rows whose status actually changed | PORTED |
| CR17 | Display toggles do not re-sync chunks | No chunks; display flags applied at read time | NOT_APPLICABLE |
| CR18 | Widget accepts any https video, server drops it | Public media must resolve to the store's own R2 prefix (`sanitizePublicMedia`) | ALREADY_EQUAL |
| CR19 | Widget e2e serves unminified JS | Sapo e2e serves the same artifact the API serves | ALREADY_EQUAL |
| CR20 | Docs describe removed flags | Sapo docs match code (round 1) | ALREADY_EQUAL |
| CR21 | Client CI depends on server token | Single-repo CI | NOT_APPLICABLE |
| CR22 | Retention client without statement timeout | Retention uses Prisma with batch caps | ALREADY_EQUAL (+ role statement_timeout §7) |
| CR23 | `lock_timeout` governs CIC waits | No advisory DDL at boot (Prisma migrations) | NOT_APPLICABLE |
| CR24 | Module destroy before listener close | `enableShutdownHooks` + PM2 SIGTERM grace | ALREADY_EQUAL |
| CR25 | Redelivery of failed row never requeued | `claimExisting` re-claims failed rows when `nextRetryAt` passed | BETTER_ON_SAPO |
| CR26 | Bounded storage evicts blocked keys | Eviction only drops expired keys first, then oldest; buckets are per client+store | ALREADY_EQUAL |
| CR27 | Listener binds all interfaces | `app.listen(PORT)` binds all interfaces; UFW blocks 3021 (round 1). Round 2 binds `127.0.0.1` and moves the tunnel ingress to match | PORTED |
| CR28 | Retention flag disables unrelated cleanups | Retention is time-based, no flag | NOT_APPLICABLE |
| CR29 | Body-parser errors bypass the filter | Nest maps `PayloadTooLargeError` to 413 | ALREADY_EQUAL |
| CR30 | Any 401/403/404 counts as revocation | `sapo-api.service` only clears the token on 401/403 for authenticated calls, not 404 | ALREADY_EQUAL |
| CR31 | Malformed encryption key fails late | `assertEncryptionKey` at boot | ALREADY_EQUAL |
| CR32 | Empty `HRV_NONCE` skips check | No static nonce; random state required | NOT_APPLICABLE |
| CR33 | Dispatcher decrypt failure leaves `sending` | Round-2 outbound dispatcher writes a terminal state on every path | PORTED |
| CR34 | `.env.example` contradicts code | `.env.example` maintained with the round-2 keys | PORTED |
| CR35 | Retention DELETE re-checks only the join key | Retention deletes by status+age within the same predicate | ALREADY_EQUAL |
| CR36 | ms/s fence mismatch | All Sapo timestamps are `BigInt` ms | NOT_APPLICABLE |
| CR37 | SQL asserted by string only | Sapo SQL-level behaviour is covered by the Postgres e2e suite | ALREADY_EQUAL |
| CR38 | Q&A metafield enqueue is fire-and-forget | Q&A has no metafield sync (only review summaries) | NOT_APPLICABLE |
| CR39 | Media URL stored raw, userinfo allowed | Public media URLs are validated against the R2 prefix; admin media is validated by the ticket | ALREADY_EQUAL |
| CR40 | Escape during submit, focus restore | Widget audit BLOCKED (needs state matrix); not changed blind | BLOCKED |
| CR41 | English 503 text, `Retry-After` not exposed | Public rate-limit responses are English with `Retry-After`; widget surfaces its own Vietnamese message | ALREADY_EQUAL |
| CR42 | Config overwrite with defaults when read unknown | `readWidgetConfig` reads the same row that `updateWidgetConfig` writes, inside the same store scope | ALREADY_EQUAL |
| CR43 | MP4 brand allowlist too narrow | Sapo allowlist covers isom/mp42/mp41/avc1/M4V/MSNV/iso2/dash | ALREADY_EQUAL |
| CR44 | Docs stale on R2 secret fallback | Round-1 docs match code | ALREADY_EQUAL |
| CR45 | Public Q&A has no product check | Confirmed missing | PORTED |
| CR46 | Server checkout keeps the PAT | Deploy uses a scoped deploy key + forced command | ALREADY_EQUAL |
| CR47 | e2e loads the real `.env` | e2e builds its own env (`makeEnv`) | ALREADY_EQUAL |
| CR48 | Client missing `test` script | `client/package.json` has `test:unit`/`test:e2e` | ALREADY_EQUAL |

## 7. Round-2 changes this document commits to (Proof filled by the run)

1. Admin: bulk + import/export for reviews and Q&A; widget-config revisions; ops orders/metafields/diagnostics.
2. Public: curated slider, Q&A summary, `no-store` on public JSON, Q&A product check.
3. Outbound merchant webhooks (CRUD + deliveries + retry + SSRF guard + client page).
4. AI reply suggestion behind `GEMINI_API_KEY` (BLOCKED key documented).
5. Hardening: `127.0.0.1` bind, `statement_timeout` on the app role, `unhandledRejection` logging, stale-uninstall fence, Q&A product check.
6. UX: settings action bar + tab strip + scroll container + reset scope + one save for the whole config (D01–D28). Accent/verified defaults stay byte-identical (`#f59e0b` / `#01ab56`) because live shops that never saved the key inherit them; AA is met by choosing dark text on a low-contrast accent (`--f1genz-sapo-review-on-accent`), not by recolouring.
