# E2E Validation & Launch Readiness Checklist

Manual checklist for a real Sapo sandbox install. Automated coverage is listed in `docs/sapo-listing-dossier.md` section 6. Item ids are unique across the whole file. Items marked (unmeasured) have not been observed on a live Sapo store yet.

Metafield namespaces written by the app: shop metafields in `f1genz` (`config`, `api_url`, `store_domain`); product metafields in `f1genz_reviews` (`rating_count`, `rating_avg`, `public_summary`).

## Install Lifecycle

- [x] P01 — OAuth install on Sapo sandbox: `https://{store}.mysapo.net/admin/oauth/authorize` redirects correctly
- [x] P02 — Launch HMAC verification passes (sorted A-Z, SHA256, base64, timestamp within 5 min)
- [x] P03 — Token exchange succeeds: code → access_token
- [x] P04 — Store identity verified via `GET /admin/store.json`
- [x] P05 — Install persisted in DB (shop, appInstall rows), token encrypted
- [x] P06 — Webhooks registered for all 10 topics (`webhookRegistrationStatus=registered`)
- [x] P07 — Storefront config metafield `f1genz.config` written to the shop
- [x] P08 — Session handoff → HttpOnly cookie set, redirect to admin SPA
- [x] P09 — Uninstall clears token material, tombstones domains, nulls `payload`/`headers` of the store's `WebhookEvent` rows
- [x] P10 — A session issued before the uninstall or reinstall is refused with `401` (`gen` mismatch)

## Admin SPA

- [x] A01 — Admin SPA loads after install, session probe returns storeDomain + status (2026-11-02: `/api/app/session` with an exchanged token answered `status=active`, `webhookStatus=registered`)
- [x] A02 — Dashboard: KPIs render (reviews, questions, ratings, response rate)
- [x] A03 — Reviews: list renders with pagination, status filters work (page/limit/pageSize/totalPages plus `status`, `star` and `sort` all answered on production)
- [x] A04 — Reviews: approve/hide/spam moderation works (pending → approved → hidden → spam → approved, and the public list followed each change)
- [x] A05 — Reviews: reply to review works
- [x] A06 — Q&A: list renders, approve/hide/answer works (question submitted from the storefront, listed in admin, answered, then visible in the public list)
- [x] A07 — Settings: widget config save/load works
- [x] A08 — Ops: health check shows DB/Redis/webhook status (`/api/admin/ops/health`: `health=ok`, `webhookStatus=registered`, per-store counts)
- [x] A09 — Ops: resync config, resync webhooks, backfill catalog actions succeed

## Storefront Widget

- [x] W01 — Widget JS/CSS served at `/storefront/f1genz-storefront.{js,css}` with correct CORS
- [x] W02 — Shop metafield `f1genz.config` exists in the store (`store.metafields.f1genz.store_domain` prints from `.bwt` on the Purity theme; the loader takes the values literally)
- [x] W03 — Product metafields `{{ product.metafields.f1genz_reviews.rating_count }}` and `rating_avg` render in `.bwt`
- [x] W04 — `<f1genz-reviews>` renders approved reviews on product page
- [x] W05 — Q&A renders on the product page (the widget serves it as the "Hỏi đáp" tab next to "Đánh giá"; on production the tab showed the question and the shop answer. The theme does not mount a separate `<f1genz-qna-panel>` element)
- [x] W06 — `<f1genz-rating-badge>` renders the SSR rating badge on collection page (`/collections/all` printed `avg-rating="4.5" review-count="25"` and `avg-rating="5" review-count="1"` straight from the product metafields while those test reviews existed)
- [x] W07 — JSON-LD structured data renders on product page (with the runtime running, the PDP carried a `Product` block with `aggregateRating` `ratingValue=5`, `reviewCount=1`, name, image, brand and canonical url; the automatic mount works because Sapo sets `og:type=product`. Google Rich Results Test itself has not been run — submit the URL manually before listing)
- [x] W08 — Public review submission works from storefront
- [x] W09 — Public Q&A submission works from storefront
- [x] W10 — `f1genz_reviews.public_summary` write succeeds for a product with many reviews (25 approved reviews on one product: `sync-metafield` answered `synced=1, queued=0`, the collection badge and the widget summary both read 25, so the value Sapo stores stays small: count, average and a five-bucket distribution)

## Webhooks

- [x] H01 — `products/create`, `products/update`, `products/delete` received and idempotent
- [ ] H02 — `orders/create`, `orders/paid`, `orders/cancelled`, `orders/fulfilled` received
- [x] H03 — `app/uninstalled` triggers cleanup (token nulled, domains tombstoned)
- [ ] H04 — `store/update` re-saves the store's domain mappings
- [x] H05 — Webhook signature verified (Base64 HMAC-SHA256 in `x-sapo-hmac-sha256`, timing-safe compare) (a delivery signed with another secret answered 401)
- [x] H06 — Deterministic event key: `x-sapo-event-id` when non-empty, otherwise content hash; `app/*` and `store/*` keyed with `lifecycleGeneration`; no random fallback (the same signed body delivered twice produced one `WebhookEvent` row and `{"duplicate":true}`; a delivery carrying a non-empty `x-sapo-event-id` got its own row)
- [ ] H07 — Replayed or out-of-order `orders/*` deliveries do not overwrite newer purchase rows (`source_updated_at` guard)
- [x] H08 — A replayed signed body delivered with another store's `x-sapo-shop-domain` is rejected when the payload names a different store or the product/order id is stored under the first store (`products/delete`, `orders/*`) (a signed `products/update` carrying `x-sapo-shop-domain: other-shop.mysapo.net` answered 400 `Missing webhook storeDomain` and wrote no row)
- [ ] H09 — A webhook for an `uninstalled` store is marked `ignored`, not retried (an unknown topic is stored as `ignored` and never processed; the uninstalled-store path is covered by `test/lifecycle.test.ts` but was not re-run by hand after the last reinstall)

## Security

- [x] X01 — `rg -i "jwks|oidc" src client/src` → zero hits
- [x] X02 — Tokens encrypted at rest (AES-GCM), never exposed to frontend JS
- [x] X03 — Session cookie HttpOnly; `Secure` in production; `SameSite=Lax` same-site, `SameSite=None` cross-site (the production exchange answered `Set-Cookie: sapo_app_session=…; Max-Age=43200; Path=/; HttpOnly; Secure; SameSite=Lax`; both hosts are on `f1genz.dev`, so the same-site branch is the one production uses)
- [x] X04 — `APP_SESSION_SECRET` ≠ `SAPO_CLIENT_SECRET` (distinct); the sample `DATA_ENCRYPTION_KEY` is refused at boot
- [x] X05 — CORS allowlist fail-closed (not permissive reflector)
- [x] X06 — Rate limit: auth endpoints throttled, 429 handled
- [ ] X07 — Per-product Redis write lock (`acquireLock`/`releaseLock`) guards `public_summary` writes
- [x] X08 — Production boot fails without `TRUST_PROXY` in the environment

## Data Integrity

- [x] D01 — Catalog backfill syncs products from Sapo API to Postgres
- [ ] D02 — Order mirror fills `customer_purchases` from `orders/*` webhooks received after install (no backfill of earlier orders)
- [x] D03 — `public_summary` metafield matches the Postgres summary (no drift)
- [ ] D04 — Concurrent review status changes don't lose data (per-product Redis lock)
- [x] D05 — A product with no live `catalog_products` row is refused by the public submit routes (`product_not_found`)

## Media

- [x] M01 — Upload ticket created (HMAC-signed, no client file name in it)
- [x] M02 — Worker accepts PUT with valid `X-Upload-Token`; rejects a wrong token, a key/type mismatch and oversize files
- [x] M03 — CDN URL returns uploaded image
- [x] M04 — Media attached to reviews renders correctly
- [x] M05 — Deleting a review (or removing its media) deletes the objects through the Worker `DELETE`
- [ ] M06 — Orphan sweep: an object uploaded more than 24 h ago and referenced by no review is deleted on a later sweep pass (`GET /list` on the Worker)

## Build & Verify

- [x] B01 — `npm run verify` green (server typecheck/test/build), `npm run test:e2e` green, `npm --prefix client run test:unit` and `npm --prefix client run build` green (2026-11-02: verify 215/215, server HTTP contract 95/95 with a throwaway database, client unit 5/5, client build green, client journeys 44/44 and storefront widget 33/33; `npm run budget` fails on the operator machine — initial JS gzip 164.5 kB against a 120.0 kB budget, and the built asset hashes differ from the deployed build — while the same step is green in CI, which builds after `npm ci`; the local install was not made to reproduce the CI build, so the difference is unexplained rather than a budget the app exceeds)
- [x] B02 — `prisma generate` succeeds
- [x] B03 — `prisma migrate deploy` applies all migrations cleanly
- [x] B04 — PM2 `ecosystem.config.cjs` starts the single `f1genz-sapo-api` process with `--env-file=.env`

## Launch Readiness

- [x] L01 — Sapo Partner dashboard: app registered with correct URLs and scopes
- [x] L02 — Production env vars set on the VPS and Cloudflare Pages
- [x] L03 — Worker deployed with `wrangler deploy`, `UPLOAD_SECRET` set; `DELETE` and `GET /list` answer with a valid token
- [x] L04 — Health endpoints: `/livez` 200, `/readyz` 200 with the readiness token
- [x] L05 — Sapo app listing requirements reviewed (privacy, screenshots, scopes) (`docs/sapo-listing-dossier.md` carries the scope justification, stored data, privacy evidence and the app-owner checklist; the screenshots and the public privacy-policy URL are still on that checklist for the owner)
- [ ] L06 — Storefront install guide published for merchants (the text exists in `storefront/theme/README.md` and in the dossier's section 5; it is not published anywhere a merchant can read before installing)
