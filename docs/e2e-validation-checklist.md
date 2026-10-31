# E2E Validation & Launch Readiness Checklist

Manual checklist for a real Sapo sandbox install. Automated coverage is listed in `docs/sapo-listing-dossier.md` section 6. Item ids are unique across the whole file. Items marked (unmeasured) have not been observed on a live Sapo store yet.

Metafield namespaces written by the app: shop metafields in `f1genz` (`config`, `api_url`, `store_domain`); product metafields in `f1genz_reviews` (`rating_count`, `rating_avg`, `public_summary`).

## Install Lifecycle

- [ ] P01 — OAuth install on Sapo sandbox: `https://{store}.mysapo.net/admin/oauth/authorize` redirects correctly
- [ ] P02 — Launch HMAC verification passes (sorted A-Z, SHA256, base64, timestamp within 5 min)
- [ ] P03 — Token exchange succeeds: code → access_token
- [ ] P04 — Store identity verified via `GET /admin/store.json`
- [ ] P05 — Install persisted in DB (shop, appInstall rows), token encrypted
- [ ] P06 — Webhooks registered for all 10 topics (`webhookRegistrationStatus=registered`)
- [ ] P07 — Storefront config metafield `f1genz.config` written to the shop
- [ ] P08 — Session handoff → HttpOnly cookie set, redirect to admin SPA
- [ ] P09 — Uninstall clears token material, tombstones domains, nulls `payload`/`headers` of the store's `WebhookEvent` rows
- [ ] P10 — A session issued before the uninstall or reinstall is refused with `401` (`gen` mismatch)

## Admin SPA

- [ ] A01 — Admin SPA loads after install, session probe returns storeDomain + status
- [ ] A02 — Dashboard: KPIs render (reviews, questions, ratings, response rate)
- [ ] A03 — Reviews: list renders with pagination, status filters work
- [ ] A04 — Reviews: approve/hide/spam moderation works
- [ ] A05 — Reviews: reply to review works
- [ ] A06 — Q&A: list renders, approve/hide/answer works
- [ ] A07 — Settings: widget config save/load works
- [ ] A08 — Ops: health check shows DB/Redis/webhook status
- [ ] A09 — Ops: resync config, resync webhooks, backfill catalog actions succeed

## Storefront Widget

- [ ] W01 — Widget JS/CSS served at `/storefront/f1genz-storefront.{js,css}` with correct CORS
- [ ] W02 — Shop metafield `f1genz.config` exists in the store (printing it from `.bwt` is unmeasured; the loader takes the values literally)
- [ ] W03 — Product metafields `{{ product.metafields.f1genz_reviews.rating_count }}` and `rating_avg` render in `.bwt` (unmeasured)
- [ ] W04 — `<f1genz-reviews>` renders approved reviews on product page
- [ ] W05 — `<f1genz-qna-panel>` renders answered questions on product page
- [ ] W06 — `<f1genz-rating-badge>` renders the SSR rating badge on collection page
- [ ] W07 — JSON-LD structured data renders on product page and passes Google Rich Results Test (unmeasured)
- [ ] W08 — Public review submission works from storefront
- [ ] W09 — Public Q&A submission works from storefront
- [ ] W10 — `f1genz_reviews.public_summary` write succeeds for a product with many reviews (Sapo's metafield value size limit is unmeasured)

## Webhooks

- [ ] H01 — `products/create`, `products/update`, `products/delete` received and idempotent
- [ ] H02 — `orders/create`, `orders/paid`, `orders/cancelled`, `orders/fulfilled` received
- [ ] H03 — `app/uninstalled` triggers cleanup (token nulled, domains tombstoned)
- [ ] H04 — `store/update` re-saves the store's domain mappings
- [ ] H05 — Webhook signature verified (Base64 HMAC-SHA256 in `x-sapo-hmac-sha256`, timing-safe compare)
- [ ] H06 — Deterministic event key: `x-sapo-event-id` when non-empty, otherwise content hash; `app/*` and `store/*` keyed with `lifecycleGeneration`; no random fallback
- [ ] H07 — Replayed or out-of-order `orders/*` deliveries do not overwrite newer purchase rows (`source_updated_at` guard)
- [ ] H08 — A replayed signed body delivered with another store's `x-sapo-shop-domain` is rejected when the payload names a different store or the product/order id is stored under the first store (`products/delete`, `orders/*`)
- [ ] H09 — A webhook for an `uninstalled` store is marked `ignored`, not retried

## Security

- [ ] X01 — `rg -i "jwks|oidc" src client/src` → zero hits
- [ ] X02 — Tokens encrypted at rest (AES-GCM), never exposed to frontend JS
- [ ] X03 — Session cookie HttpOnly; `Secure` in production; `SameSite=Lax` same-site, `SameSite=None` cross-site
- [ ] X04 — `APP_SESSION_SECRET` ≠ `SAPO_CLIENT_SECRET` (distinct); the sample `DATA_ENCRYPTION_KEY` is refused at boot
- [ ] X05 — CORS allowlist fail-closed (not permissive reflector)
- [ ] X06 — Rate limit: auth endpoints throttled, 429 handled
- [ ] X07 — Per-product Redis write lock (`acquireLock`/`releaseLock`) guards `public_summary` writes
- [ ] X08 — Production boot fails without `TRUST_PROXY` in the environment

## Data Integrity

- [ ] D01 — Catalog backfill syncs products from Sapo API to Postgres
- [ ] D02 — Order mirror fills `customer_purchases` from `orders/*` webhooks received after install (no backfill of earlier orders)
- [ ] D03 — `public_summary` metafield matches the Postgres summary (no drift)
- [ ] D04 — Concurrent review status changes don't lose data (per-product Redis lock)
- [ ] D05 — A product with no live `catalog_products` row is refused by the public submit routes (`product_not_found`)

## Media

- [ ] M01 — Upload ticket created (HMAC-signed, no client file name in it)
- [ ] M02 — Worker accepts PUT with valid `X-Upload-Token`; rejects a wrong token, a key/type mismatch and oversize files
- [ ] M03 — CDN URL returns uploaded image
- [ ] M04 — Media attached to reviews renders correctly
- [ ] M05 — Deleting a review (or removing its media) deletes the objects through the Worker `DELETE`
- [ ] M06 — Orphan sweep: an object uploaded more than 24 h ago and referenced by no review is deleted on a later sweep pass (`GET /list` on the Worker)

## Build & Verify

- [ ] B01 — `npm run verify` green (server typecheck/test/build), `npm run test:e2e` green, `npm --prefix client run test:unit` and `npm --prefix client run build` green
- [ ] B02 — `prisma generate` succeeds
- [ ] B03 — `prisma migrate deploy` applies all migrations cleanly
- [ ] B04 — PM2 `ecosystem.config.cjs` starts the single `f1genz-sapo-api` process with `--env-file=.env`

## Launch Readiness

- [ ] L01 — Sapo Partner dashboard: app registered with correct URLs and scopes
- [ ] L02 — Production env vars set on the VPS and Cloudflare Pages
- [ ] L03 — Worker deployed with `wrangler deploy`, `UPLOAD_SECRET` set; `DELETE` and `GET /list` answer with a valid token
- [ ] L04 — Health endpoints: `/livez` 200, `/readyz` 200 with the readiness token
- [ ] L05 — Sapo app listing requirements reviewed (privacy, screenshots, scopes)
- [ ] L06 — Storefront install guide published for merchants
