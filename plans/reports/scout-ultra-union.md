## Candidate scores

The claim text from the packet was not in my context. I mapped Claims 1-10 from how the five scouts answered them. Confidence ordering only.

| Cand | Coverage | Evidence | Signal | Honesty | Note |
|---|---|---|---|---|---|
| A | 14 | 16 | 15 | 17 | Storefront-first. Unique: Q&A offset cap, summaries fan-out, UTF-8 filename, TLS keyscan. Overstated that docs say TRUST_PROXY is refused at boot. |
| B | 17 | 17 | 16 | 17 | Server core. Unique: catalog tombstone, order-replay overwrite, webhook registration, store/update, JWT binding. |
| C | 16 | 17 | 16 | 16 | Tests/docs/CI. Unique: worker 2 MB cap, order mirror untested, stale scripts, `@ts-nocheck`, stale smoke. |
| D | 19 | 18 | 18 | 17 | Broadest. Unique: Q&A crash, unreplied+search, form modes, `minRating`, blank answers. Overstated "every 2-5 MB upload fails" and said uploads return 401 (the guard returns 403). |
| E | 18 | 17 | 17 | 17 | SPA-first. Unique: star filter ignored, `/account` HTML scrape, JS-readable session cookie, build-failure dist. |

## Union findings

I checked every cited path. Line numbers are verified unless marked `~`. There is no P0. Every security item either needs a non-production host or an operator mistake, or is privacy and retention rather than an exploit.

### P1

**S-01 Clearing all media on an admin review edit is a silent no-op** — VERIFIED
- Where: `src/review/review.service.ts:708-710`; `src/review/review-product-store.service.ts:160`.
- Evidence: `editReview` sends `null` for an empty media list. `upsertReview` does `(input.media ?? undefined) as any`, so `null` becomes `undefined` and Prisma `update` skips the column.
- Impact: the admin sees success, but the media stays and keeps rendering on the storefront.
- Fix: pass `Prisma.DbNull` for `null` and `undefined` only when the field is absent. Drop the `as any`.
- Found-by: A, D, E.

**S-02 The server never enforces widget gates, and `verified` is never set by the public path** — VERIFIED
- Where: `src/review/public-review.controller.ts:169-255` (`submitReview` only does a rate check at 187-188 and a token resolve); `src/review/review.service.ts:654` (`verified: dto.verified ?? false`) and `:997-1008`; `src/review/dto/update-widget-config.dto.ts:27-30,36,45-46`; `src/qna/public-qna.controller.ts:55-200`.
- Evidence:
  - Grep shows `requirePurchaseToReview`, `requireLogin`, `formEmailMode`, `formPhoneMode`, `formTitleMode`, `formContentMode` and `allowQnA` only in the DTO and interfaces.
  - `hasPurchasedProduct` is called only from the eligibility endpoint.
  - The Haravan reference enforces them: `F1GENZ_Review/.../public-review.controller.ts:597-735` forces `verified: true` and checks the form modes, and its `public-qna.controller.ts:60` checks `allowQnA`.
- Impact:
  - A direct `POST /api/public/reviews/:id` bypasses "buyers only".
  - `verifiedCount` and the verified badge are always 0 for storefront reviews.
  - `allowQnA=false` and the form-mode settings are advisory only.
- Fix: enforce the config in the public controllers and set `verified` from `hasPurchasedProduct`.
- Found-by: A, B, C, D, E.

**S-03 Anonymous purchase-eligibility oracle, backed by unsalted hashes** — VERIFIED
- Where: `src/review/public-review.controller.ts:125-139`; `src/common/security/public-rate-limit.ts:36-46` (a POST gets only the per-client 120/min bucket; the store bucket applies to reads only); `src/purchase/purchase-store.service.ts` (`hashValue` is plain sha256).
- Evidence:
  - The endpoint has no `assertPublicRate`.
  - It accepts any `{email, phone}` and answers `verified` or `not_purchased`.
  - An unknown store returns 409, which also reveals installation.
- Impact:
  - Anyone can test whether an email or phone bought product X, at 120 per minute per IP, and IPs rotate.
  - Phone-number hashes are brute-forceable offline if the database leaks.
- Fix: apply the store+client write limit plus a per-identity limit, and return a uniform answer. Use an HMAC with a secret key instead of bare sha256 (needs a re-hash migration).
- Found-by: A, B, C, D, E.

**S-04 `webhook_events` keeps full raw order payloads (buyer PII) forever** — VERIFIED
- Where: `src/sapo/webhook.service.ts:195-206` (`payload` stored whole; only headers go through `redactHeaders`, :48); `src/sapo/uninstall.service.ts`; `prisma` `WebhookEvent.payload Json?`; `docs/sapo-listing-dossier.md:34-36`.
- Evidence:
  - No `webhookEvent.delete*` exists in `src`. The grep shows only `update`/`updateMany`.
  - `purchase-store.normalizeOrder` carefully trims PII (:221-250), but the whole `orders/*` body lands in `WebhookEvent`.
  - The dossier says PII is trimmed and lists only `customer_purchases`, so its privacy statement is false for this table.
- Impact: unbounded retention of buyer name, email, phone and address, with no purge even after uninstall.
- Fix: store a minimal projection for `orders/*`, or null the payload once `processed`. Add a TTL sweep to `DurabilitySweepService` and update the dossier.
- Found-by: A, B, C, D.

**S-05 The public sample `DATA_ENCRYPTION_KEY` boots in production** — VERIFIED
- Where: `.env.example:41`; `src/config/env.schema.ts:161-162` (`isPlaceholder` regex) and `:412-418`; `docs/env-contract.md:68`; `docs/security-checklist.md:10`.
- Evidence: the sample base64 decodes to `0123456789abcdef0123456789abcdef` (32 bytes), which passes `decodedKeyLength`. The placeholder regex only matches `replace-with|change-me|changeme|placeholder|your-|todo`. Only docs forbid the sample key; no code or test does.
- Impact: a copied `.env` encrypts every stored Sapo access token with a publicly known key.
- Fix: reject this value in `loadEnv` for production, or change the example to `replace-with-…`. Add a unit test.
- Found-by: A, B, C, D, E (E rated it P2).

**S-06 No fail-closed guard for an empty or placeholder secret outside production** — VERIFIED
- Where: `src/sapo/hmac-verifier.service.ts:60-123` (`createHmac('sha256', env.SAPO_CLIENT_SECRET)` for launch and webhook); `src/config/env.schema.ts:197` (`NODE_ENV` defaults to `development`) and `:356-372` (required only inside `if (isProduction)`; the distinctness check skips empty values); `src/sapo/session.service.ts:78`; `src/sapo/sapo.controller.ts:~110-112` (`verify-hmac` → `createHandoff`); `.env.example:16,22`.
- Evidence: `createHmac` accepts an empty key. `.env.example` ships `replace-with-client-secret` and `replace-with-32-byte-random-secret`, which pass outside production. `ecosystem.config.cjs:20` sets `NODE_ENV=production`, so the live PM2 deploy is covered.
- Impact: on a dev, staging or misconfigured host, anyone can forge `app/uninstalled` webhooks and launch links. A forged launch link leads to a handoff and then a session, which is admin takeover. An empty `APP_SESSION_SECRET` also allows forged session JWTs.
- Fix: throw in the verifier and the session signer when the secret is empty or a placeholder, in every environment.
- Found-by: A, B, C, D, E.

**S-07 The per-product Q&A admin view crashes on a response-shape mismatch** — VERIFIED
- Where: `src/qna/qna.service.ts:269-276` and `src/qna/qna.controller.ts` (`GET :productId` returns `{data:{items,total,page,pageSize}}`); `client/src/common/ApiService.js:152-155`; `client/src/pages/qna/index.jsx:223-227,250`; `client/e2e/journeys.cjs:309-311`.
- Evidence: the client does `const { data: questions = [] } = useQuery(...)` and then `[...questions]`, which spreads a plain object and throws `TypeError`. The Haravan reference returned an array. The journey stubs match only the list route and the action routes, so the 36/36 run never hits this route.
- Impact: selecting a product, or opening `?product=…`, on the Q&A page breaks the page.
- Fix: read `.items` in the client, or return an array. Add a stub that matches the real shape.
- Found-by: D only.

**S-08 `fetchProduct` returns `{product}`, but the SPA uses it as the product** — VERIFIED
- Where: `src/catalog/products.controller.ts:94-96`; `client/src/common/ApiService.js:31-34`; `client/src/pages/reviews/index.jsx:227-248`; `client/src/pages/qna/index.jsx:184-205`; `client/e2e/journeys.cjs:~270` (stub returns a bare product).
- Impact: for a product not in the first 50 (deep link, or search then select), `title`, `handle` and `image` are undefined. The title falls back to "Tất cả đánh giá" and the "Xem trực tiếp" link disappears.
- Fix: unwrap `.product` in `fetchProduct` and correct the stub.
- Found-by: D, E.

**S-09 The dashboard payload omits fields the SPA renders** — VERIFIED
- Where: `src/dashboard/dashboard.service.ts:12-34,66-95` (no `reviewTrend`, `attentionProducts` or `productStats`); `src/review/review-product-store.service.ts:364-402` (`unreplied: 0` hard-coded; `trend: []` and `recentReviews: [] as any[]` are dead placeholders); client `dashboard/index.jsx:457-459,551,574,588,632`, `reviews/index.jsx:176,203`, `qna/index.jsx:136,163`; `client/e2e/journeys.cjs:240-249` (mocks all of them).
- Impact:
  - "Chưa phản hồi", the unreplied row and `pendingWork` are always 0 for reviews.
  - The 14-day trend is empty and "Sản phẩm cần chú ý" is always empty.
  - Product pickers lose the counts, sorting and Q&A answered text.
  - The Reviews page disagrees with the dashboard, because `listAllReviews` does compute `unreplied` (`review.service.ts:1043-1054`).
- Fix: compute `unreplied` with `UNREPLIED_WHERE`, and add `reviewTrend`, `attentionProducts` and `productStats`. Add a real-shape contract test.
- Found-by: B, C, D, E.

**S-10 The admin star filter is ignored by the server** — VERIFIED
- Where: `client/src/common/ApiService.js:55-67` (sends `star`); `src/review/review.controller.ts:108-125` (no `star` query); `src/review/review.service.ts:1004-1042` (no rating filter).
- Impact: in "Tất cả đánh giá", choosing a star does nothing. The client filters locally only when a product is selected (`reviews/index.jsx:419-422`).
- Fix: add a `star` query validated 1-5 and `where.rating`.
- Found-by: E only.

**S-11 `unreplied` combined with `search` drops the unreplied condition** — VERIFIED
- Where: `src/review/review.service.ts:1028-1042`.
- Evidence: `Object.assign(where, UNREPLIED_WHERE)` sets `where.OR`, and `where.OR = [content…, author…]` then overwrites it. `qna.service.ts:316-326` already does this correctly with `AND`.
- Impact: on the unreplied tab a search returns replied reviews and a wrong `total`.
- Fix: use `AND: [{OR: unreplied}, {OR: search}]`.
- Found-by: D only.

**S-12 Admin product links use `/products/{handle}`, but Sapo product URLs are `/{alias}`** — VERIFIED
- Where: `client/src/pages/reviews/index.jsx:254-257,541-545`; `client/src/pages/qna/index.jsx:341-345`; `src/catalog/catalog-product-store.service.ts:~84` (`handle = product.handle || product.alias`).
- Evidence: the URL shape comes from the recorded live-store measurement of the Sapo `/{alias}` form. It was not re-measured in this pass.
- Impact: every "Xem trực tiếp" and per-review product link 404s.
- Fix: one `buildProductUrl(storeDomain, alias)` helper returning `https://${domain}/${alias}`, used at all three sites.
- Found-by: A, B, C, D, E.

**S-13 A soft-deleted catalog product can never come back** — VERIFIED
- Where: `src/catalog/catalog-product-store.service.ts:~183` (monotonic guard `prev.updatedAt >= row.updatedAt → continue`), `:204-207` (`deletedAt` kept as `prev.deletedAt` when the incoming row has none), `:240-257` (`softDeleteProduct` sets `updatedAt = now`), `:364-391` (`markMissingSapoProductsDeleted`), `:279` (`listProducts` filters `deletedAt: null`); `src/catalog/catalog-sync.service.ts:137-141`.
- Evidence: after any tombstone, `updatedAt` is "now". A later Sapo upsert with an older `updatedAt` is skipped entirely. A newer one still keeps the tombstone.
- Impact: a product tombstoned by a 404 race or a paginated-backfill gap vanishes from the admin picker permanently.
- Fix: write `deletedAt: null` explicitly on a live upsert from Sapo, and bypass the monotonic guard when `prev.deletedAt` is set.
- Found-by: B, D.

**S-14 The order mirror is untested, has no backfill, and reads Shopify field names** — VERIFIED (field-name impact SUSPECTED)
- Where: `src/purchase/purchase-store.service.ts:138-330` (`normalizeOrder` reads `created_at`, `cancelled_at`, `refunded_at`); `src/sapo/sapo-api.service.ts:373` (`getOrders`, no caller); `docs/sapo-listing-dossier.md:24` (cites `getOrders` to justify `read_orders`); `e2e/http-contract.cjs:876-892` (order payloads carry only `{id}`); `e2e/lib/sapo-stub.cjs:173` (`orders: []`).
- Evidence:
  - `rg -l 'PurchaseStoreService|isEligiblePurchaseStatus|customerPurchase|hasPurchasedProduct|normalizeOrder' test e2e client/e2e` returns nothing.
  - `test/durability.test.ts:279-290` stubs the purchase service.
- Impact:
  - No test proves the verified-buyer path.
  - Pre-install buyers can never match.
  - If Sapo uses `*_on` fields (unverified), cancelled orders still count as purchases.
- Fix: add tests with a real order payload, capture one live `orders/*` delivery to map the fields, add a `getOrders` backfill or correct the dossier.
- Found-by: C, D.

**S-15 The webhook idempotency key depends on unobserved headers, and a repeat uninstall may be skipped as a duplicate** — SUSPECTED
- Where: `src/sapo/webhook.service.ts:183-191,195-230` (`x-sapo-webhook-id|x-sapo-id|x-request-id`, else a sha256 of topic, store and payload hash); `docs/webhook-subscription-uninstall.md:84`; `docs/sapo-listing-dossier.md:45`; `e2e/http-contract.cjs:31`.
- Evidence:
  - Sapo's `x-sapo-event-id` arrives empty (recorded measurement) and is never read.
  - `x-request-id` is typically proxy-injected per request, so retries get different keys.
  - With the hash fallback the key is permanent. `claimExisting` answers `duplicate` for `processed` rows, and nothing purges them on reinstall.
- Impact: a byte-identical `app/uninstalled` after a reinstall would not clear the token or domains. Whether Sapo varies the payload is unproven.
- Fix: drop `x-request-id`. Add a time or `lifecycleGeneration` component to the key for lifecycle topics, or purge events on install. Capture a live delivery to settle it.
- Found-by: A, B, C, D, E.

**S-16 A non-ASCII upload filename may fail the ticket match** — SUSPECTED
- Where: `src/media/public-media.controller.ts:~66-70` (uses `file.originalname`); `src/media/media.service.ts:~150-160` (`payload.filename !== expected.filename`); `node_modules/busboy/lib/types/multipart.js:217-239`; `storefront/snippets/f1genz-storefront.js:919-930`.
- Evidence:
  - Multer 2.0.2 passes no `defParamCharset`, so busboy uses `nullDecoder` on the latin1-parsed header.
  - The widget sends the raw UTF-8 `file.name` in the ticket JSON.
  - Files under 1.5 MB are not renamed, so only recompressed images become `name.jpg`.
  - The check is static only; I did not run it.
- Impact: a Vietnamese-named image would fail with "Upload ticket mismatch".
- Fix: bind the ticket to a server-derived sanitized name or hash, not the client string.
- Found-by: A only.

**S-17 The widget scrapes the customer identity from the `/account` page HTML** — SUSPECTED
- Where: `storefront/snippets/f1genz-storefront.js:112-124,137-165`; `window.__st.customer` at `:100`.
- Evidence: it takes the first email and phone regex match anywhere in the account HTML (verified in code).
- Impact: a header or footer shop email or hotline could be taken as the customer. That wrong identity then drives eligibility, which is the only place the gate is enforced (see S-02). Whether the Sapo account HTML contains such strings was not tested.
- Fix: read identity only from a theme-injected value (`customer-email` and `customer-phone` attributes).
- Found-by: E only.

### P2

**S-18 Every anonymous review POST costs Sapo API calls and never checks the product exists** — VERIFIED
- Where: `src/review/review.service.ts:659` (`syncPublicSummary` unconditional after create); `src/review/public-review.controller.ts:187-188` (token resolved before validation); the Q&A and review submits take only `NumericIdPipe`.
- Impact: pending and spam reviews still burn the merchant's leaky bucket (40 calls). Bogus product ids create rows, which are auto-approved when `autoApprove` is on.
- Fix: sync only when `status === 'approved'` and require a live `catalog_products` row.
- Found-by: A, B, D, E.

**S-19 Review media validation is lax** — VERIFIED
- Where: `public-review.controller.ts:223-233` (only `^https://`, ≤2000 chars, type image|video); `review.service.ts` `toMedia`; `src/media/media.service.ts:~35-46` (`ftyp` at offset 4 accepted as any `video/mp4`).
- Impact: spam can plant tracking images and outbound links, auto-approved when `autoApprove` is on. The widget's `<a>` has no `nofollow ugc`. Any ISO-BMFF file such as a MOV passes as MP4.
- Fix: allow only the store's R2 prefix plus YouTube and Vimeo hosts. Check the `ftyp` brand.
- Found-by: A, B, D, E (ftyp part: B, E).

**S-20 The R2 Worker caps every upload at 2 MB, but the server and widget allow 5 MB images** — VERIFIED (edge-case impact)
- Where: `worker/src/index.js` (`> 2*1024*1024` returns 413 for every type); `src/media/media.service.ts:9-11`; `src/media/dto/presign.dto.ts:20`; `storefront/snippets/f1genz-storefront.js:229-231,1652`.
- Impact: the widget recompresses images over 1.5 MB first, so the failure appears only when compression cannot reach the target or the image cannot be decoded. The ticket is already spent by then.
- Fix: give the Worker per-type limits (image 5 MB, video 2 MB) and add a parity test.
- Found-by: C, D.

**S-21 R2 objects are never deleted, anonymous uploads are unmetered, and one secret has two roles** — VERIFIED
- Where: `worker/src/index.js` (PUT and OPTIONS only; `authHeader !== env.UPLOAD_SECRET` is not timing-safe); `src/media/media.service.ts:~105,~185` (`R2_UPLOAD_SECRET` is both the ticket HMAC key and the Worker token); `src/media/public-media.guard.ts:25-27` (the "cost the merchant storage" comment is wrong, since the bucket is the owner's).
- Impact: review delete and uninstall leave PII-bearing photos behind. There is no per-store quota, and unsubmitted uploads are orphaned.
- Fix: store object keys and delete them on review delete and uninstall, add an orphan sweep, use separate secrets and a constant-time compare.
- Found-by: A, B, D, E.

**S-22 Rate-limiter robustness** — VERIFIED
- Where: `src/redis/redis.service.ts:187-191` (`incr` then `expire` only when `value === 1`); `src/common/security/ingress-rate-limit.service.ts` (the memory fallback never evicts); `src/common/security/public-rate-limit.ts:62-64` (a Redis error becomes `next(error)`, a 500 on all public traffic).
- Impact: a crash between `incr` and `expire` leaves a key with no TTL and blocks that bucket permanently. Memory buckets leak under IP rotation.
- Fix: use a Lua script, or `SET NX EX` then `INCR`. Decide fail-open or fail-closed explicitly, and evict expired buckets.
- Found-by: A, B, D.

**S-23 Public read amplification** — VERIFIED
- Where: `src/qna/qna.service.ts:389-410` (no offset cap, unlike reviews' `PUBLIC_MAX_OFFSET` at `review.service.ts:41`); `review.service.ts:974-995` (up to 100 parallel `calculatePublicSummary` per request, ids not validated as numeric).
- Impact: deep-page scans, and up to 100 `groupBy` queries per request at 900 requests per minute per client.
- Fix: reuse the offset cap, validate ids, and use one `groupBy productId IN (…)`.
- Found-by: A only.

**S-24 Dead public CORS helpers with a credentialed-reflector shape** — VERIFIED
- Where: `src/review/public-review.controller.ts:40-52,~79-99`; `src/qna/public-qna.controller.ts:33-45,83-85`; `src/common/security/security-headers.ts:54-70`; `src/common/security/http-hardening.ts:27`.
- Evidence: the global `corsMiddleware` ends every `OPTIONS` request before routing, so the `@Options` handlers never run. If they did, they reflect any origin with `Allow-Credentials: true`.
- Fix: delete the helpers and handlers.
- Found-by: A, B, C, D, E.

**S-25 Billing remnants contradict the docs** — VERIFIED
- Where: `src/sapo/webhook-topic-normalizer.ts` (`CHARGE_TOPICS`); `src/sapo/webhook.service.ts:283-296` (`app/charge`); `src/sapo/subscription.service.ts` (`applySnapshotToInstall` rewrites the whole `metadata` JSON non-atomically); `prisma` `SubscriptionSnapshot`; `client/src/components/layout/AdminLayout.jsx:46-47,123-129` (plan tag); `client/src/pages/ops/index.jsx:225-231` (trial/cancelled labels); `docs/lifecycle.md:12`; `docs/architecture-contracts.md:108`.
- Impact: a signed `app/charge` event could change install status or race the widget config. The app is Free-only.
- Fix: delete the path, model and enum values, or document them.
- Found-by: A, B, C, D, E.

**S-26 Dead and unused code** — VERIFIED
- Where (definitions only, no callers): `sapo-api.service.ts` `runBackground` (151), `deleteProductMetafield` (312), `deleteMetafield` (348), `getOrders` (373), `getWebhooks` (384), `deleteWebhook` (415); `webhook.service.ts:77` `verifyChallenge`; `catalog-sync.service.ts:170` `handleProductWebhook`; `webhook-registration.service.ts:21` `webhookReceiverUrl`; `sapo.types.ts:253` `myshopify_domain`; `sapo.types.ts:54-61` Shopify-shaped `SapoProduct`; `review-product-store.service.ts:400-401` `trend` and `recentReviews`.
- Fix: delete them, and correct the types to `name`, `alias`, `published_on`.
- Found-by: B, C, D, E.

**S-27 `any` casts and banner comments violate the repo contract** — VERIFIED
- Where: `dashboard.service.ts:78,82,85,90`; `health.controller.ts:31`; `purchase-store.service.ts:297,310`; `review-product-store.service.ts:160,401`; `review.service.ts:1069`; `catalog-product-store.service.ts:169,210,223`; `sapo.service.ts:32,47,131,220`; `uninstall.service.ts:11,21`; `webhook.service.ts:61,74`; `subscription.service.ts:160-174,251-253`. Banner comments sit in `review.service.ts` (for example :995, :1017), `review-product-store.service.ts`, `qna*.service.ts` and `sapo*.service.ts`.
- Fix: type the Prisma client and strip the banner comments.
- Found-by: A, B, C, D, E.

**S-28 Errors are masked as healthy zeros or `ok:true`** — VERIFIED
- Where: `src/dashboard/dashboard.service.ts:45-52` (per-call `.catch`, and `install?.shopId || ''` for an unknown store returns zeros with HTTP 200); `src/ops/ops.service.ts` (`getHealth` swallows to `null`; `resyncConfig` returns `ok:true` with `configError`); `src/sapo/sapo.service.ts:207-211` (`.catch(() => { /* non-critical */ })` on the config write); `review.service.ts` `getPublicSummaries` returns `EMPTY_SUMMARY`; `catalog/product-label.ts` `.catch(() => [])`.
- Fix: surface a `degraded` flag or 5xx, log the install-time config failure, and return `ok: !configError`.
- Found-by: B, C, D, E.

**S-29 Webhook registration and ops resync are inconsistent** — VERIFIED
- Where: `src/sapo/webhook-registration.service.ts:~29` (`${process.env.API_BASE_URL}/api/...` instead of `this.env` and the unused URL builder; `API_BASE_URL` is only trimmed, `env.schema.ts:204`); `src/ops/ops.service.ts:~108-117` (`resyncWebhooks` returns `ok:true` and never updates `AppInstall.webhookRegistrationStatus`); `ops.service.ts:~75-84` (`getWebhookSummary` totals cover the last 8 events only); `client/src/pages/ops/index.jsx:193,215-220` (counts `delivered`/`delivered_success`, but the enum is `received|processing|processed|failed|ignored`); `sapo-api.service.ts` `createWebhook` (409 and 422 become `null`, counted as registered).
- Impact: "N webhook đã xử lý" is always 0. A fixed registration stays `degraded` in `/readyz`. A trailing slash gives `//api`. The page is dev-gated, so I rated it P2.
- Fix: reuse `registerForInstall` and persist status. Use grouped counts and the real status names. List and replace stale webhook addresses.
- Found-by: B, C, D.

**S-30 Webhook store identity includes an unsigned header, but the docs say "signed body, not headers"** — VERIFIED
- Where: `src/sapo/webhook.service.ts:105-121` (the `x-sapo-shop-domain` header feeds `collectDomains`) and `:136-156`; `docs/webhook-subscription-uninstall.md:72`; `docs/security-checklist.md:39`.
- Impact: the HMAC covers the body only. For payloads with no domain field, the unsigned header decides the tenant. Exploiting it needs a captured signed body.
- Fix: fix the docs, and cross-check payload ids against the claimed store.
- Found-by: B, C, E.

**S-31 Replayed or out-of-order `orders/*` events overwrite newer purchase state** — VERIFIED
- Where: `src/purchase/purchase-store.service.ts:~293-312` (the update block is unconditional); `src/sapo/webhook.service.ts` `retryDueFailed`; `docs/e2e-validation-checklist.md:47` (W07 "monotonic upsert guard").
- Impact: a stale replay can clear `cancelledAt` and make a cancelled order eligible. Line items removed by `orders/updated` keep their rows.
- Fix: guard on the order's `updated_at` and delete rows for dropped products.
- Found-by: B only.

**S-32 Stored product labels go stale after a rename** — VERIFIED
- Where: `src/dashboard/dashboard.service.ts:87,92` (`r.productTitle || titles.get(...)`); `toReviewListItem` and `toQuestionListItem` use the stored label only.
- Impact: renamed or late-synced products keep old or empty titles in the admin lists.
- Fix: prefer the catalog title at read time, or propagate on `products/update`.
- Found-by: B, D.

**S-33 Dead or unenforced settings and DTO gaps** — VERIFIED
- Where: `update-spam-config.dto.ts:16-19` and `spam-config.interface.ts` (`minRating` is never read; `detectSpam` at `review.service.ts:262-296` ignores it); `update-spam-config.dto.ts:30-34` (`maxContentLength` `@Min(0)` flags every non-empty review as spam, and the public cap is 2000); `src/common/security/public-response.ts:6-9` with `storefront.js:~190-193,~1943-1953` and `client/.../settings/index.jsx:~1425-1439` (`emailDisplay` and `phoneDisplay` are dead because the API strips those fields); `src/qna/dto/answer-question.dto.ts` (`answer` has no `IsNotEmpty`, so a blank answer sets `approved` but still counts as unanswered).
- Fix: remove the dead settings and add `MinLength` or `IsNotEmpty` plus `@Min(1)`.
- Found-by: A, D.

**S-34 Q&A admin paging and scans** — VERIFIED
- Where: `src/qna/qna.service.ts:~336-339` (`getAllQuestions` loads every shop row just to count statuses); `src/qna/qna.controller.ts` (`GET :productId` passes no options, so only the first 20 rows come back and the client paginates those).
- Fix: use `groupBy` and `count`, and pass paging to the per-product view.
- Found-by: D only.

**S-35 `fetchReviewSummary` mixes totals** — VERIFIED (impact SUSPECTED)
- Where: `client/src/common/ApiService.js:78-90` (`count = stats.total`, which counts all statuses); `src/review/review.service.ts:894-912` and `review-product-store.service.ts:292-330` (`total` covers all statuses, while `summary` and `avg` are approved-only).
- Fix: use `summary.count` for the count.
- Found-by: D only.

**S-36 Pending metafield intent is dropped after 20 attempts, and the `public_summary` size budget is a guess** — VERIFIED / SUSPECTED
- Where: `src/database/metafield-sync-pending.service.ts:6,68-71` (`deleteMany` at `PENDING_MAX_ATTEMPTS = 20`); `src/review/review.service.ts:~137-150` (a comment near a ~100-byte budget; the Sapo limit is unmeasured).
- Impact: the product's rating metafields stay stale until the next review write or a manual sync.
- Fix: keep the row but cap the backoff, or surface it in ops.
- Found-by: B, D.

**S-37 Shopify-isms in the storefront runtime** — VERIFIED
- Where: `storefront/snippets/f1genz-storefront.js:2913-2916` (`extractProductHandle` regex `/products/…`), `:2928` (`fetch('/products/${handle}.js')`), `:2999-3003` (`isProductPage`), `:100` (`window.__st.customer`), `:5` (`ACCOUNT_LOGIN_URL='/account'`); `client/e2e/fixtures/index.html:34`.
- Impact: on Sapo the handle lookup never matches, and the auto JSON-LD falls back to DOM or `product-id`. `/products/{h}.js` support on Sapo is unverified.
- Fix: drop the `.js` fetch and regexes and use `product-id` plus og metadata.
- Found-by: A, B, C, D, E.

**S-38 Hardcoded legacy API host fallback, and duplicated defaults** — VERIFIED
- Where: `storefront/snippets/f1genz-storefront.js:4,80-87` (`LEGACY_FALLBACK_API_URL = 'https://api-sapo-reviews.f1genz.dev'`; the warning tells merchants to read `shop.metafields.f1genz.config.value.apiUrl`, which `.bwt` cannot read); `:187-228` (`DEFAULT_CONFIG` duplicates the server defaults).
- Impact: a mis-installed theme silently sends shopper data (emails) to one fixed host.
- Fix: fail closed with a single console error, and fix the warning text.
- Found-by: A, E (A rated it P1).

**S-39 `.bwt` snippets are inconsistent and unverified on a real Sapo theme** — VERIFIED (render behaviour SUSPECTED)
- Where: `storefront/theme/f1genz-product-schema.bwt` (`default` and `plus` filters and `{{ product.name | escape }}` inside a JSON string, with `canonical_url` and `featured_image.src` unescaped); `storefront/snippets/theme/README.md` ("no filters other than `escape`"); `storefront/snippets/theme/f1genz-sapo-widget.bwt:3` ("Nothing here parses metafields", but block 4b prints them); `storefront/theme/README.md` (the object availability is admitted unverified); `storefront/snippets/f1genz-storefront.js:3018-3027` (adds a second Product JSON-LD when a theme schema lacks `aggregateRating`).
- Also: `StorefrontService` writes the printable scalars `f1genz.api_url` and `f1genz.store_domain`, and no snippet or README mentions them.
- Impact: HTML-escape in JSON-LD yields `&amp;` or broken JSON for names with `&`, a quote or a backslash. A duplicate Product schema is possible.
- Fix: test once on a real Sapo theme, use a JSON-safe escape, document the scalar metafields, and reconcile the README and the snippet.
- Found-by: A, B, C, D, E.

**S-40 Uninstall leaves rating metafields and JSON-LD, with no purge or retention** — VERIFIED
- Where: `src/sapo/uninstall.service.ts:32-75` (nulls the token, tombstones domains, `dataPreserved=true`); `docs/security-checklist.md:55`; `docs/webhook-subscription-uninstall.md:109`; `docs/lifecycle.md:58`.
- Evidence: the token is nulled, so the app cannot delete `f1genz_reviews.*` or `f1genz.*` afterwards. The docs honestly say retention is "not implemented". Whether Sapo keeps app metafields after uninstall is unverified.
- Impact: the SSR snippet keeps emitting `aggregateRating`, and reviews, Q&A and purchases are retained indefinitely.
- Fix: document the merchant removal step, define a retention window, and clean metafields before revoking if the token is honoured at webhook time.
- Found-by: A, B, C, D, E.

**S-41 Docs drift** — VERIFIED
- `docs/e2e-validation-checklist.md`: S02 and S03 use `shop.metafields.f1genz.config` and `product.metafields.reviews.public_summary` (the real namespace is `f1genz_reviews`). IDs S01-S07 are duplicated under "Storefront Widget" and "Security". Every box is unchecked. W06 claims a provider delivery id.
- `docs/webhook-subscription-uninstall.md:40` says the signature header and secret are "not yet confirmed", while `:48` says "measured on a live products/create delivery". `docs/security-checklist.md:42` repeats "still open".
- `docs/sapo-listing-dossier.md`: line 58 says 90/90, but the test count is 97 (23+29+3+21+21); line 24 cites the dead `getOrders`; line 45 says "idempotent theo delivery id"; the data table omits `webhook_events`. Line 16 hedges the billing claim, so that one is weak.
- `docs/deploy-sapo.md:6-9` shows `/storefront/*` proxied by Pages, but `client/public/_routes.json` includes only `/api/*` and `client/functions` has only `api/[[path]].js`.
- `docs/deploy-sapo.md:93` lists `TRUST_PROXY` among keys the server "refuses to start" without, but `main.ts:20-24` only warns. `env-contract.md:23` is accurate.
- Found-by: A, B, C, D, E.

**S-42 Deploy and CI gaps** — VERIFIED (build-failure effect SUSPECTED)
- Where: `.github/workflows/deploy.yml`; `.github/workflows/ci-e2e.yml`; `package.json`.
- Evidence:
  - `deploy` needs only `verify-server` and `verify-client`. `ci-e2e.yml` runs in parallel and does not gate it.
  - Pull requests run build and e2e but not `npm run verify` (lint and unit tests).
  - `db:migrate` runs before the `dist.prev` snapshot, so rollback restores `dist` only.
  - With `set -euo pipefail`, a failed `npm run build` exits mid-way, leaving a partly written `dist` for the next restart.
  - `pm2 save` runs before the health probe, and the probe hits `/livez`, which checks neither the database nor Redis.
  - `ssh-keyscan` trusts the VPS host on every run.
  - `package.json` has no `engines` field, but `--env-file` needs Node ≥ 20.6.
  - The `rsync --delete` excludes do not cover `.antigravity/`, `plans/`, `recipes/` or `REFERENCE.md`. Whether they are tracked is unknown, because this directory is not a git repo.
  - No `compression` middleware is present.
- Fix: gate deploy on e2e, run `verify` on pull requests, snapshot before migrate, build to a temp directory and swap, pin the host key, add `engines`, probe `/readyz`.
- Found-by: A, B, C, D, E.

**S-43 Stale Haravan-era scripts that pass vacuously or fail** — VERIFIED
- Where: `scripts/verify-env.mjs:5-6,12-37` (reads `server/.env.example`, requires `HRV_*`); `scripts/scan-anti-patterns.mjs:6-7` (scans `server/src`, so it scans only `client/src` and `client/functions` and prints a green "passed"); `scripts/verify-build-output.mjs:6-7` (`server/dist/*`). None is referenced in `package.json`, `.github` or docs.
- Fix: delete them, or port them to the root layout and wire them into `verify`.
- Found-by: B, C, E.

**S-44 Test hygiene** — VERIFIED
- Where: `test/durability.test.ts`, `lifecycle.test.ts`, `security.test.ts` and `storefront.test.ts` start with `// @ts-nocheck`, while `tsconfig.json` includes `test/**`, so `npm run lint` never type-checks them. `client/scripts/smoke-routes.cjs` mocks routes that do not exist (`/shop/info`, `/api/reviews/all`, `/api/reviews/bulk`, `queueTotals` and others). `client/tests/auth-storage.contract.test.mjs` is not wired into any script or CI. `e2e/lib/sapo-stub.cjs:163-173` serves Shopify-shaped products and empty orders. `client/e2e/journeys.cjs` stubs differ from the real server shape (see S-07, S-08, S-09).
- Fix: remove the ignores, update or delete the stale smoke script, wire the client test, and align the stubs with the real responses.
- Found-by: C, D, E.

**S-45 Hardcoded dev gate, and ops routes open to any merchant session** — VERIFIED
- Where: `client/src/common/DevGate.js` (`dev=hangquoctai` plus a password derived from today's DDMMYYYY); `client/src/App.jsx:122-123`; `src/ops/ops.controller.ts` (guarded only by `ShopAuthGuard`; resync and backfill act on the caller's own store); no rate limit or concurrency lock on `backfill-catalog`.
- Impact: the gate is client-side obscurity with the secret in the shipped bundle.
- Fix: drop the gate, or enforce an operator capability server-side. Add a lock and rate limit on backfill.
- Found-by: C, E.

**S-46 The session JWT is also written to a JS-readable cross-subdomain cookie** — VERIFIED
- Where: `client/src/common/AuthStorage.js:5,25-47,75` (`auth_session_token`, `Domain=.host; SameSite=None; Secure`).
- Impact: a third copy of a bearer token, readable by any script. The backend already has an HttpOnly cookie.
- Fix: drop the JS cookie.
- Found-by: E only.

**S-47 Repo hygiene** — VERIFIED
- `client/README.md:1` is titled "Haravan-Client--Multipage".
- `client/public/_redirects` has `/api/* /api/:splat 200`, a no-op self-rewrite.
- `client/vite.config.js:38-42` proxies `/admin`, which has no route.
- `client/src/pages/auth/grandservice/` is an empty directory.
- `.gitignore` ignores `.claude/` but not `.antigravity/`, and there is no root `README.md`.
- `REFERENCE.md` points at `C:\Users\Admin\Desktop\F1GENZ Review`, not `E:/Work/apps/F1GENZ_Review`.
- `.env.example:50` ships `R2_PUBLIC_DOMAIN=images-sapo.f1genz.dev`, which contradicts `docs/env-contract.md`'s own rule against real production domains.
- `WEBHOOK_RATE_LIMIT_*` are required in production but read by no route (documented in `env-contract.md`).
- Found-by: B, C, E.

**S-48 `TRUST_PROXY` defaults to `false`, so rate limits may share one bucket behind a proxy** — SUSPECTED
- Where: `src/main.ts:20-24` (warns only); `src/config/env.schema.ts:206`; `.env.example:9`; `ecosystem.config.cjs` and `deploy.yml` set neither.
- Impact: if the live `.env` keeps `false`, every shopper behind nginx or the Pages proxy shares one bucket. The 900 per minute read cap and the per-client write caps then apply across all shoppers. The live value is unknown.
- Fix: make `TRUST_PROXY` explicit in production, and fix `deploy-sapo.md:93`.
- Found-by: A, E.

**S-49 Public review input and status-code inconsistencies** — VERIFIED
- Where: `src/review/public-review.controller.ts:~185-250` (email and phone only sliced, not validated; Q&A validates email); `public-review.controller.ts:188` (a blocked install, including `needs_reinstall` and `uninstalled`, returns 401 via `SapoService.BLOCKED_STATUSES`, `sapo.service.ts:14`); `public-qna.controller.ts` (409 via `resolveServingInstall`, which treats only `uninstalled` and `declined` as non-serving, `review.service.ts:48`); `src/media/public-media.guard.ts:51-56` (403).
- Impact: a `needs_reinstall` store still serves reads but rejects review submits, with different codes per route.
- Fix: validate email and phone, and unify the status codes.
- Found-by: B, D.

**S-50 Lifecycle edge cases** — SUSPECTED
- Where:
  - `src/sapo/session.service.ts:~80-95`: the JWT payload has no `tokenVersion` or `lifecycleGeneration`, so a pre-reinstall token stays valid for its TTL.
  - `src/sapo/webhook.service.ts:~283-299`: `store/update` re-saves only domains that already map to the store, so a newly added domain is never mapped.
  - `src/sapo/webhook.service.ts:~300-318` and `src/health/health-verdict.ts:5,26-47`: late product webhooks after uninstall fail with 401, retry up to 8 times, and degrade `/readyz` for up to 60 minutes.
  - `src/sapo/sapo.controller.ts:111`: `startLogin({ reason: 'missing_store' } as never)` passes an argument the function ignores.
- Fix: bind sessions to `tokenVersion`, map new domains, skip retries for uninstalled stores, and drop the cast.
- Found-by: B only.

## Claims 1-10

1. CONFIRMED: no fail-closed guard for an empty or placeholder secret; the weakness applies outside production only, because PM2 sets `NODE_ENV=production` (S-06).
2. REFUTED: `labelUpdateFields` (`product-label.ts:42-48`) only writes non-empty fields, so edit, reply and moderation never null a stored label. The real bug on that path is S-01, and stale labels are S-32.
3. CONFIRMED: three admin link builders use `/products/{handle}` (S-12), plus the storefront `.js` fetch and regex, `__st`, and `myshopify_domain` (S-37, S-26).
4. PARTIAL: code and `webhook-subscription-uninstall.md:84` agree on `x-sapo-webhook-id|x-sapo-id|x-request-id`, but the measured `x-sapo-event-id` is unread and `x-request-id` is risky (S-15). The docs contradict themselves (S-41, S-30).
5. CONFIRMED: stale S02/S03 keys, duplicate IDs, unchecked boxes and other drift (S-41).
6. PARTIAL: the READMEs match the keys the app writes (`f1genz_reviews.*`, `f1genz.config`, scalar `f1genz.api_url` and `f1genz.store_domain`), but the scalars are undocumented, the filter and escaping inconsistencies remain, and `.bwt` object availability is unverified (S-39).
7. PARTIAL: uninstall nulls the token, tombstones domains and clears handoffs and Redis keys. It keeps reviews, Q&A, purchases and raw webhook payloads, and cannot clean store metafields because the token is revoked (S-40, S-04). The docs are coherent but incomplete.
8. CONFIRMED with gaps: server-side gates missing (S-02), eligibility oracle (S-03), loose media URLs (S-19), product existence unchecked (S-18), upload and R2 issues (S-20, S-21, S-16), dead CORS (S-24). XSS is REFUTED: the whitelist in `public-response.ts` strips email, phone and `source_raw_json`, and tickets are HMAC-signed, store-bound and single-use. Global CORS gives credentials to admin origins only.
9. CONFIRMED: hard-coded `unreplied: 0` and `trend: []` placeholders (S-09), `any` casts (S-27), swallowed errors (S-28), and dead code (S-26).
10. PARTIAL: `.env.example` keys match the schema and `ecosystem.config.cjs` is sound (S-05 and S-47 are the exceptions), but deploy and CI gaps stand (S-42, S-43).

## Receipt

`ultra: union=50/121 single_candidate_only=11`

Single-candidate-only: S-07, S-10, S-11, S-16, S-17, S-23, S-31, S-34, S-35, S-46, S-50.

I corrected or dropped these scout claims:
- A's claim that the docs say the server refuses to start without `TRUST_PROXY`, which is only true of `deploy-sapo.md:93`.
- D's claim that uploads return 401 (the guard returns 403).
- D's claim that every upload between 2 and 5 MB fails (the client recompresses first, so it is an edge case).
- The dossier "Free + Super billing" contradiction, which is hedged in the same line.

## Files map

- `src/review/review.service.ts` - review CRUD, spam, metafield sync, admin list, eligibility (S-01, 02, 11, 18, 33, 35, 36)
- `src/review/review-product-store.service.ts` - Prisma store, `getStatsForShop` (S-01, 09, 35)
- `src/review/public-review.controller.ts` - public read and write, dead CORS (S-02, 03, 19, 24, 49)
- `src/review/review.controller.ts`, `src/review/dto/*` - admin list params, widget and spam DTOs (S-02, 10, 33)
- `src/qna/qna.service.ts`, `qna.controller.ts`, `qna-store.service.ts`, `public-qna.controller.ts`, `dto/answer-question.dto.ts` - Q&A paths (S-02, 07, 23, 33, 34)
- `src/catalog/catalog-product-store.service.ts`, `catalog-sync.service.ts`, `product-label.ts`, `products.controller.ts` - catalog (S-08, 13, 26, 32)
- `src/purchase/purchase-store.service.ts` - order mirror (S-03, 14, 31)
- `src/dashboard/dashboard.service.ts`, `src/ops/*`, `src/health/*` - dashboard, ops, health (S-09, 28, 29, 45)
- `src/media/*`, `worker/src/index.js` - upload tickets and the R2 Worker (S-16, 19, 20, 21)
- `src/sapo/hmac-verifier.service.ts`, `webhook.service.ts`, `uninstall.service.ts`, `webhook-registration.service.ts`, `sapo-api.service.ts`, `sapo.service.ts`, `sapo.controller.ts`, `session.service.ts`, `subscription.service.ts`, `sapo.types.ts` - auth and webhooks (S-04, 06, 15, 25, 26, 29, 30, 40, 50)
- `src/common/security/*`, `src/redis/redis.service.ts`, `src/config/env.schema.ts`, `src/main.ts`, `.env.example`, `ecosystem.config.cjs` - hardening, env and config (S-05, 06, 22, 24, 47, 48)
- `storefront/snippets/f1genz-storefront.js`, `storefront/snippets/theme/*`, `storefront/theme/*` - widget and `.bwt` (S-17, 37, 38, 39)
- `client/src/common/ApiService.js`, `AuthStorage.js`, `DevGate.js`, `client/src/pages/{dashboard,reviews,qna,ops,settings}/index.jsx`, `client/src/components/layout/AdminLayout.jsx` - admin SPA (S-07 to S-12, 25, 29, 45, 46)
- `client/e2e/journeys.cjs`, `client/scripts/smoke-routes.cjs`, `client/tests/*`, `client/README.md`, `client/public/*`, `client/vite.config.js` - client tests and config (S-44, 47)
- `test/*.test.ts`, `e2e/http-contract.cjs`, `e2e/lib/sapo-stub.cjs` - server tests (S-14, 44)
- `.github/workflows/deploy.yml`, `ci-e2e.yml`, `package.json`, `scripts/*.mjs` - CI, deploy, stale scripts (S-42, 43)
- `docs/*`, `REFERENCE.md`, `prisma/schema.prisma` - docs and schema (S-04, 25, 41, 47)

Status: DONE_WITH_CONCERNS
Summary: 50 findings (17 P1, 33 P2) validated against the repo; no P0. The main defects are the SPA/server contract bugs (S-07 to S-11), the client-only purchase gate and eligibility oracle (S-02, S-03), raw order PII in `webhook_events` (S-04), the sample encryption key and missing secret guards (S-05, S-06), and the permanent catalog tombstone (S-13). S-15, S-16, S-17, S-48 and S-50 stay SUSPECTED until a live Sapo delivery, upload or theme render settles them. The `/{alias}` URL shape and Sapo `.bwt` behaviour come from earlier session measurements or are unverified; nothing was run.