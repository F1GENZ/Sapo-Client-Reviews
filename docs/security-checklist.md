# Security Checklist

Use before deploying or extending the Sapo review app. Each item maps to behavior in `src/`; the sections of `docs/sapo-auth-flow.md` and `docs/webhook-subscription-uninstall.md` explain the mechanisms.

## Secrets and env

- [ ] `.env` is not committed; `.env.example` contains placeholders only.
- [ ] `NODE_ENV=production` is set in production.
- [ ] `APP_SESSION_SECRET` is at least 32 bytes and differs from `SAPO_CLIENT_SECRET` (boot fails if they are equal).
- [ ] `DATA_ENCRYPTION_KEY` is your own value decoding to exactly 32 bytes. The public sample key (`MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=` and its hex form) is rejected at boot in every `NODE_ENV` (`src/config/secret-guard.ts`).
- [ ] `READINESS_TOKEN` is set and private.
- [ ] `R2_UPLOAD_SECRET` is set together with `R2_WORKER_URL` and `R2_PUBLIC_DOMAIN` (all or none), is at least 32 bytes, is not a placeholder, and is shared only with the Worker. It authorizes Worker upload, delete and list. `loadEnv` rejects a partial or weak R2 configuration in every `NODE_ENV`.
- [ ] Redis and PostgreSQL credentials exist only in server env.
- [ ] An empty `SAPO_CLIENT_SECRET`, `APP_SESSION_SECRET` or `DATA_ENCRYPTION_KEY` is rejected in production, and a placeholder (`replace-with`, `change-me`, `placeholder`, `your-`, `todo`), a short session secret or an invalid encryption key is rejected in every `NODE_ENV`. Other production secrets (`SAPO_CLIENT_ID`, `REDIS_PASSWORD`, `DATABASE_URL`, `DIRECT_URL`, `READINESS_TOKEN`) are checked for placeholders in production.
- [ ] `TRUST_PROXY` is present in the production environment (explicit value; `false` is allowed when the app is directly exposed). Boot fails without it.

## OAuth and launch

- [ ] OAuth state is random, stored hashed (`oauth-state:{sha256}`), TTL-bound, and consumed with `GETDEL`.
- [ ] State carries the store domain; the callback query is never used for identity.
- [ ] Authorize URLs are built only for `*.mysapo.net` hosts.
- [ ] A launch query with `hmac` is verified (sorted A-Z, HMAC-SHA256, Base64, timestamp within 300 s, timing-safe); an invalid one is rejected.
- [ ] A launch query without `hmac` starts OAuth, never a session.
- [ ] Redirect targets pass the safe-redirect check (same-origin, not `/install*`, `/oauth*`, `/api/oauth*`).
- [ ] The granted scopes match `read_products,write_products,read_orders`.

## Sessions

- [ ] Only the one-time handoff code appears in a redirect URL.
- [ ] `POST /api/auth/session/exchange` consumes the code atomically, requires a trusted origin, and is rate limited.
- [ ] The session cookie is `HttpOnly`, `Secure` in production, with `SameSite` matching the deployment (`None` only when the frontend and API are on different sites).
- [ ] Unsafe admin requests require both a trusted `Origin`/`Referer` and a Bearer session token.
- [ ] The session JWT carries the install's `lifecycleGeneration` as `gen`. `ShopAuthGuard` answers `401` when it differs from the install's current generation, and `SessionService` rejects tokens without a numeric `gen`. Tokens issued before this field existed are therefore invalid: every merchant signs in once more after the first deploy that contains it.
- [ ] `CORS_ALLOWED_ORIGINS` lists explicit HTTPS origins; credentialed CORS is limited to the admin origins.
- [ ] No third-party scripts are loaded in the admin SPA origin (it keeps the session token in browser storage).

## Webhooks

- [ ] The POST receiver captures the raw body and verifies the Base64 HMAC-SHA256 in `x-sapo-hmac-sha256` with `SAPO_CLIENT_SECRET`. Header name and secret were measured on one live `products/create` delivery to a real Sapo store.
- [ ] Content type must be `application/json`; body size is capped by `WEBHOOK_BODY_LIMIT`.
- [ ] The HMAC covers the body only. `x-sapo-shop-domain` (and the other store headers and query values) is an unsigned hint: it must agree with the identity resolved from the payload and the domain mapping, and for `products/delete` and `orders/*` an entity id that is already stored under a different store is rejected (`WebhookService.assertEntityBelongsToStore`).
- [ ] The entity check assumes that Sapo product and order ids are unique across stores. That assumption is unverified. It also only covers ids the app already stores; for other topics and first-seen ids the header remains a hint, and the product handler fetches the product by id with the claimed store's token rather than trusting the body.
- [ ] Events are inserted idempotently before any handler runs; processed duplicates do not rerun.
- [ ] `x-sapo-event-id` is read when it is non-empty. In the one measured delivery the header was present but empty, so in practice the key is `sha256(topic : store scope : payload hash)`. For `app/*` and `store/*` topics the scope includes the install's `lifecycleGeneration`, so an uninstall after a reinstall is not swallowed as a duplicate of the earlier one. An identical body inside the 30-day event retention window is treated as a redelivery.
- [ ] Order payloads are stored as a projection without buyer email or phone (see Data retention below).
- [ ] Registration failures are visible: `degraded`/`failed` in `webhookRegistrationStatus` and `/readyz`.

## Token storage and Sapo API

- [ ] Access tokens are AES-256-GCM encrypted at rest and never returned to the browser or storefront.
- [ ] Every store API call goes through `SapoApiService` (throttle, `X-Sapo-Api-Call-Limit`, `429` retry).
- [ ] Only `401`/`403` marks an install `needs_reinstall`, fenced by `tokenVersion`.

## Uninstall

- [ ] The uninstall handler clears pending handoffs and Redis install/domain keys.
- [ ] It nulls the token ciphertext, IV, and tag columns.
- [ ] It increments `lifecycleGeneration` and `tokenVersion` and tombstones active domains.
- [ ] It nulls `payload` and `headers` of every `WebhookEvent` row resolved to that store.

## Data retention

Constants live in `src/ops/durability-sweep.service.ts`; there is no env switch. The retention pass runs inside the durability sweep at most once an hour.

- [ ] `WebhookEvent` rows with status `processed` or `ignored` are deleted 30 days after their last update; `failed` rows with no retry scheduled (exhausted) after 90 days.
- [ ] `orders/*` events keep only `id`, `order_number`, `name`, financial and fulfillment status, order timestamps, `line_items: [{ product_id }]`, `email_hash`, `phone_hash` and `hash_version`. Other topics keep their payload (no buyer data).
- [ ] An install that stays `uninstalled` for 90 days after `uninstalledAt` has its `customer_purchases` rows and its `WebhookEvent` rows deleted. The condition is rechecked inside the deleting transaction, so a reinstall in between wins.
- [ ] Reviews, Q&A and catalog rows are merchant content and are never deleted automatically. Deleting them for a departed merchant is a manual operation on the database.
- [ ] Buyer email and phone in `customer_purchases` are stored only as hashes: HMAC-SHA256 (`hash_version = 2`, key derived from `DATA_ENCRYPTION_KEY` with HKDF) for new rows. Legacy plain SHA-256 rows (`hash_version = 1`) are still matched by the buyer gate.
- [ ] Review media (R2 objects) is deleted through the Worker `DELETE /<key>` when a review or its media is deleted, best-effort and only for keys owned by that store. The orphan sweep (every 5 minutes, one page of 200 objects through the Worker `GET /list`) deletes objects older than 24 hours that no `review_products.media` row of the store references, and keeps objects of stores without an install row. Both need `R2_WORKER_URL`, `R2_UPLOAD_SECRET` and `R2_PUBLIC_DOMAIN`; the Worker authenticates every route with `X-Upload-Token`.

## Public ingress

- [ ] `/api/public` accepts only small JSON (256 kB), is rate limited per client (and submissions also per store and client), and returns whitelisted fields (no email, phone, or raw source JSON).
- [ ] OAuth, launch, logout, and session-exchange routes have rate limits.
- [ ] `TRUST_PROXY` is set to the real proxy chain so rate limits see client addresses. With `false` behind a proxy every client shares one bucket (the server logs a warning in production).
- [ ] `/livez` returns only `{ ok: true }`; `/readyz` requires `Authorization: Bearer $READINESS_TOKEN`.
- [ ] Body limits are finite (`REQUEST_BODY_LIMIT`, `WEBHOOK_BODY_LIMIT`).
- [ ] Upload tickets no longer contain the client file name; the object key is named by the server from the sniffed content type.
- [ ] Response compression is expected at the edge or proxy tier (Cloudflare or the reverse proxy in front of PM2). The server has no `compression` middleware and this repo does not add one.

## Known limitations and unmeasured behavior

These are accepted or open items. Do not read them as verified behavior.

- **Session token in `localStorage`.** The admin SPA keeps the Bearer session token in browser storage, so any script injection in the admin origin can read it. Moving to an HttpOnly cookie plus CSRF protection is a redesign and is out of scope here. Mitigations in place: no third-party scripts in the admin origin, token bound to one `storeDomain` and install generation, 12-hour default lifetime.
- **Leftover metafields after uninstall.** The token is nulled when `app/uninstalled` arrives, so the app can no longer delete what it wrote. The merchant removes the leftovers:
  1. Remove the F1GENZ snippets from the theme (the widget loader and `{% include 'f1genz-product-schema' %}`). Without this the product schema snippet keeps printing `aggregateRating` from the product metafields.
  2. Delete the shop metafields in namespace `f1genz` (`config`, `api_url`, `store_domain`) and the product metafields in namespace `f1genz_reviews` (`rating_count`, `rating_avg`, `public_summary`), with any tool that can delete metafields in the store. The exact Sapo admin path for this was not verified.
  3. Whether Sapo itself removes app metafields at uninstall is unmeasured.
- **`public_summary` size.** The metafield is a JSON string with `avg`, `count` and `distribution`. Sapo's value size limit for metafields is unmeasured; the code does not enforce a budget.
- **`.bwt` rendering.** Whether `product.metafields.f1genz_reviews.*` and `shop.metafields.f1genz.*` render in a real Sapo theme, and how `.bwt` handles the filters used in the snippets, is unmeasured. Test on a real theme before relying on it (`docs/e2e-validation-checklist.md`, W02, W03, W07).
- **Order mirror coverage.** `customer_purchases` is filled only from `orders/*` webhooks received after install. There is no order backfill, so earlier orders never count for the verified-buyer check. Order timestamps are read under both the `*_at` and `*_on` field names, and ids under `id`, `order_id` and `orderId`, because the Sapo field names were not measured on a live order.
- **Pinned host key for deploys.** The deploy workflow trusts the VPS host key with `ssh-keyscan` on every run, so a host-key swap on the network path would go unnoticed. It is not changed here because pinning needs the real VPS host key. See `docs/deploy-sapo.md` for the recommended `VPS_KNOWN_HOSTS` secret.
- **No response compression in the app.** The server has no `compression` middleware (adding it needs an operator-approved npm install); compression belongs to the edge tier.

## Before handoff

```bash
npm run verify
npm run test:e2e
npm --prefix client run test:unit
npm --prefix client run build
```

`npm run verify` runs the server typecheck, the `test/*.test.ts` suites, and the build.
