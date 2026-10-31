# Webhook, Registration, and Uninstall Lifecycle

How the server registers Sapo webhooks, authenticates and stores deliveries, retries failures, and cleans up on uninstall. Source of truth: `src/sapo/webhook.service.ts`, `src/sapo/webhook-registration.service.ts`, `src/sapo/webhook-topic-normalizer.ts`, `src/sapo/uninstall.service.ts`, `src/ops/durability-sweep.service.ts`.

## Routes

| Route | Purpose |
|---|---|
| `GET /api/oauth/install/webhooks` | Plain `200 ok` for reachability checks. Sapo has no verify-challenge handshake, so there is no token check and no state change. |
| `POST /api/oauth/install/webhooks` | Webhook delivery (`src/sapo/sapo.controller.ts`). |
| `GET /readyz` | Protected readiness: includes the count of installs per webhook registration status and `webhookDegraded` (`src/health/health.controller.ts`). |

The webhook route is not IP rate limited: Sapo delivers from shared source addresses, so a per-IP bucket would merge all stores and drop legitimate deliveries. Authentication is the HMAC signature below.

## Registration

After a successful install callback the server starts `registerForInstall` in the background (`src/sapo/sapo.service.ts`). It creates one Sapo webhook per topic in `WEBHOOK_SUBSCRIBE_TOPICS`, pointing at `{API_BASE_URL}/api/oauth/install/webhooks`:

`app/uninstalled`, `store/update`, `products/create`, `products/update`, `products/delete`, `orders/create`, `orders/updated`, `orders/paid`, `orders/cancelled`, `orders/fulfilled` (10 topics).

The result is stored on `AppInstall.webhookRegistrationStatus` (`webhookRegistrationError` keeps the joined error text):

| Status | Meaning |
|---|---|
| `not_configured` | Column default; registration has not run. |
| `registered` | All 10 topics were created. Sets `webhookRegisteredAt`. |
| `degraded` | Some topics failed. |
| `failed` | Every topic failed. |

(`pending` exists in the Prisma enum but no code path writes it.) `degraded` and `failed` are surfaced by `/readyz` and by the admin Ops page. Merchants can re-run registration from `POST /api/admin/ops/resync-webhooks`.

Registration is reconcile-style: it first lists the store's webhooks (`getWebhooks`), skips topics that already point at `{API_BASE_URL}/api/oauth/install/webhooks`, deletes webhooks on a stale address of the same endpoint path (`deleteWebhook`), and creates only the missing topics. A failing list or delete is recorded in `webhookRegistrationError` and downgrades the result to `degraded`.

Manual verification on a Sapo sandbox install:

1. Confirm `SAPO_SCOPE` and the partner-app webhook URL match `docs/deploy-sapo.md`.
2. Install the app on the sandbox store.
3. Call protected `/readyz` and confirm `webhookRegistration` shows `registered` for the test store and `webhookDegraded` is `false`.
4. Create or edit a product, place a test order, and uninstall the app.
5. Confirm one `WebhookEvent` row per delivery with the expected `normalizedTopic` and a terminal `status`.

Signature header and secret were measured on a live `products/create` delivery to a real Sapo store (`x-sapo-hmac-sha256`, Base64 HMAC-SHA256 over the raw body with the app client secret). The same delivery carried an `x-sapo-event-id` header with an empty value. Only that one delivery was measured; repeat steps 3-5 on a new sandbox before relying on topics that were not exercised.

## POST delivery contract

Order of operations in `WebhookService.handle`; nothing is written before step 3 succeeds:

1. Content type must contain `application/json` (otherwise `415`); body size is capped by `WEBHOOK_BODY_LIMIT` (`src/common/security/body-limits.ts`). The exact raw bytes are captured for the signature.
2. Signature header is `x-sapo-hmac-sha256`.
3. Base64 HMAC-SHA256 over the raw body, keyed with `SAPO_CLIENT_SECRET` (measured on a live `products/create` delivery), compared timing-safe. Hex is also accepted by the parser (`src/sapo/hmac-verifier.service.ts`). A missing body or header is rejected.
4. Topic is read from `x-sapo-topic` or `x-sapo-webhook-topic` and normalized (below).
5. Store identity is resolved (below).
6. An idempotent `WebhookEvent` row is inserted (`status=received`), then moved to `processing`.
7. The topic handler runs inline.
8. The row ends as `processed`, `ignored` (unknown topic, or a product/order/update topic for an install already `uninstalled`; ignored events are not retried), or `failed` (error is rethrown, so Sapo sees a failure and may redeliver).

## Topics

`normalizeWebhookTopic` lowercases the header and maps aliases to one canonical topic; anything else becomes `unknown`, is stored, and is marked `ignored`.

| Canonical | Accepted aliases | Handler |
|---|---|---|
| `app/uninstalled` | `app_uninstall_webhook`, `app_uninstall`, `app/uninstall`, `apps/uninstall`, `apps/uninstalled`, `app_uninstalled` | `UninstallService.uninstall` |
| `store/update` | `stores/update`, `store_update`, `stores_update`, `store_update_webhook` | Re-saves domain mappings that already belong to the resolved store |
| `products/create`, `products/update`, `products/delete` | `product/<verb>`, `products_<verb>` | Fetches the product with the store token and syncs `catalog_products` (`CatalogSyncService`) |
| `orders/create`, `orders/updated`, `orders/paid`, `orders/cancelled`, `orders/fulfilled` | `order/<verb>`, `orders_<verb>`, plus `orders/canceled` | Mirrors purchases into `customer_purchases` for the verified-buyer check (`PurchaseStoreService`). Only deliveries received after install are mirrored; there is no order backfill. |

The app has no billing: no charge topic is subscribed and no plan or subscription state is stored by this app.

Product and order handlers throw on upstream failures (for example a Sapo API error), which marks the event `failed` and schedules a retry. A payload without a product or order id is logged and skipped.

## Identity binding

The HMAC covers the body only. Every header and query value that names a store is therefore an unsigned hint, including `x-sapo-shop-domain`:

- `storeDomain` or `store_domain` in the payload is the primary identity. Domains collected from the payload, the query (`shop`, `shop_domain`, `mysapo_domain`, `primary_domain`, ...) and the store headers (`x-sapo-shop-domain`, `x-shop-domain`, `x-sapo-shop`, `x-shop`, `x-sapo-domain`) are mapped to a store through `ShopDomain` rows and Redis `domain:*` keys (`src/sapo/shop-domain.service.ts`).
- A payload `storeDomain` that disagrees with the domain mapping is rejected. For a topic other than `app/uninstalled`, a payload domain that maps to no active install is rejected.
- `x-sapo-store-domain`, `x-sapo-store`, `storeDomain` and `store_domain` query values are compatibility input only; if present they must equal the resolved store or the request is rejected.
- Cross-check against payload ids (`WebhookService.assertEntityBelongsToStore`): for `products/delete` and `orders/*`, an id that exists only under a different store is rejected (`Webhook product belongs to another store`, `Webhook order belongs to another store`). This relies on the **unverified assumption that Sapo product and order ids are unique across stores**. It covers only ids the app already stores. `products/create` and `products/update` fetch the product by id from Sapo with the claimed store's token instead of trusting the delivered body.
- Tombstoned domains are never resolved, so an uninstalled store cannot be revived by a late delivery.
- Any topic except `app/uninstalled` with no resolvable store is rejected (`Missing webhook storeDomain`).

## Idempotency and retries

Idempotency key:

1. If `x-sapo-event-id` is non-empty: `provider:{topic}:{scope}:{id}`. Only `x-sapo-event-id` is read; `x-sapo-webhook-id`, `x-sapo-id` and `x-request-id` are not. The one measured delivery carried this header with an empty value, so `providerEventId` is null in that case and the next rule is the one in effect.
2. Otherwise `sha256(topic : scope : sha256(payload))`.

`scope` is `store:{storeDomain}` (or `domain:{domain}` when no store resolved). For `app/*` and `store/*` topics it becomes `store:{storeDomain}:gen:{lifecycleGeneration}` using the install's current `lifecycleGeneration` (0 when there is no install row), so an uninstall after a reinstall runs again instead of being swallowed as a duplicate. There is no random fallback. Because the key comes from the content, two deliveries with a byte-identical body are one event for as long as the earlier row exists (processed and ignored rows are purged after 30 days, see Retention).

A redelivery of an existing key (`claimExisting`):

| Existing row | Outcome |
|---|---|
| `processed` / `ignored` | Returns `{ ok: true, duplicate: true }`; reducer does not rerun. |
| `failed`, retry not yet due | `deferred`: the sweep owns it at `nextRetryAt`. |
| `failed`, due or never scheduled | Claimed with a compare-and-set and rerun. |
| `received` / `processing`, updated within 10 minutes | `inProgress`. |
| `received` / `processing`, stalled over 10 minutes | Claimed and rerun. |

Failures back off exponentially: 2 minutes doubling per attempt, capped at 1 hour, up to `maxAttempts` (8) tries, after which `nextRetryAt` is cleared.

`DurabilitySweepService` runs every 60 seconds inside the API process (skipped when `NODE_ENV=test`), guarded by the Redis lock `lock:durability-sweep`. Each pass reclaims stalled events into `failed`, replays due `failed` events from the stored payload (the stored `orders/*` projection for order events), reconciles pending storefront metafield writes, and, at most once an hour, runs the retention pass below. A failing step never blocks the others. There is no separate worker process.

## Uninstall cleanup

`app/uninstalled` runs `UninstallService.uninstall(storeDomain, payload)` under the lifecycle lock `lock:lifecycle:{storeDomain}` (a concurrent lifecycle operation returns `409`):

1. Delete pending session handoff codes for the store.
2. Delete Redis `install:{storeDomain}` and `domain:{domain}` keys for every known domain.
3. In one database transaction: set `AppInstall.status=uninstalled`, null `accessTokenCiphertext`/`accessTokenIv`/`accessTokenTag`, set `uninstalledAt`, `dataPreserved=true`, increment `lifecycleGeneration` and `tokenVersion`, tombstone every active `ShopDomain` (`active=false`, `tombstonedAt`), and set `payload` and `headers` to null on every `WebhookEvent` whose `resolvedStoreDomain` is the store or whose `resolvedDomain` is one of its known domains.
4. Reviews, Q&A and catalog rows are kept. `customer_purchases` and the store's `WebhookEvent` rows are purged after the retention window below.

After uninstall `SapoService.resolveAccessToken` rejects the store (`uninstalled` is a blocked status), so the admin guard refuses API calls, and a session JWT issued before the uninstall no longer matches the install's `lifecycleGeneration`. An install callback whose OAuth state was created before `uninstalledAt` is rejected as stale; a fresh install flips the status back to `active`, clears `uninstalledAt`, and increments `lifecycleGeneration` and `tokenVersion`.

The token is nulled at webhook time, so the app cannot delete the metafields it wrote (`f1genz.*` on the shop, `f1genz_reviews.*` on products). The merchant removal steps are in `docs/security-checklist.md`, "Known limitations".

## Retention

`DurabilitySweepService` runs a retention pass at most once an hour (constants in `src/ops/durability-sweep.service.ts`, no env variables):

| Data | Rule |
|---|---|
| `WebhookEvent`, status `processed` or `ignored` | Deleted when `updatedAt` is older than 30 days. |
| `WebhookEvent`, status `failed` with `nextRetryAt` null | Deleted when `updatedAt` is older than 90 days. |
| `customer_purchases` and `WebhookEvent` of a store | Deleted for installs with `status=uninstalled` and `uninstalledAt` older than 90 days. The condition is checked again inside the deleting transaction, so a reinstall in the meantime keeps the data. |
| Reviews, Q&A, catalog rows | Not deleted automatically. |

`orders/*` events are stored as a projection: `id`, `order_number`, `name`, financial and fulfillment status, the order timestamps (both `*_at` and `*_on` names), `line_items: [{ product_id }]`, `email_hash`, `phone_hash` and `hash_version`. Buyer email, phone, names and addresses are not stored in the event row. Events of other topics keep the delivered payload, which carries no buyer data.

## Tests

`test/lifecycle.test.ts`, `test/durability.test.ts`, and `test/security.test.ts` cover webhook signature checks, topic normalization, idempotent redelivery, retry and stalled-event handling, and uninstall token clearing. `npm run verify` runs them.
