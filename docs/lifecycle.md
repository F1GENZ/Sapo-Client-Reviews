# App Lifecycle Contract

Source of truth for install, session, status, reinstall, and uninstall behavior. Details of each flow live in `docs/sapo-auth-flow.md` (OAuth, launch, session) and `docs/webhook-subscription-uninstall.md` (webhooks, uninstall). Code: `src/sapo/*`, `prisma/schema.prisma`.

## Scope

- Sapo OAuth login/install and admin app launch.
- One-time handoff to an app session.
- Webhook registration, delivery, idempotency, retry, and uninstall cleanup.
- Durable install state in PostgreSQL; runtime state (one-time codes, locks, domain cache) in Redis.

The app is Free-first: every install is stored as `active` with `featuresUnlocked=true`. There is no billing, charge, or plan code.

## Install status

`AppInstall.status` uses the `AppStatus` enum. The paths that write it today:

| Status | Written by | Meaning | Admin API access |
|---|---|---|---|
| `active` | Install callback | Installed, token present. | Allowed. |
| `needs_reinstall` | `markInstallNeedsReinstall` after a `401`/`403` from Sapo | Token revoked or invalid. | Blocked until reinstall. |
| `uninstalled` | `app/uninstalled` webhook | Tokens cleared, domains tombstoned. | Blocked. |

`trial`, `free`, `canceled`, `expired`, and `declined` exist in the enum but no current flow sets them. Their handling is fixed in code: `canceled`, `expired`, `needs_reinstall`, `declined`, and `uninstalled` are blocked statuses (`BLOCKED_STATUSES` in `src/sapo/sapo.service.ts`); `trial`, `active`, and `free` are live (`LIVE_STATUSES` in `src/sapo/install-revocation.ts`). Prisma's column default is `trial`, but the install path always writes `active` explicitly.

A blocked install makes `resolveAccessToken` throw `401 App needs reinstall`, which `ShopAuthGuard` turns into a refused request, and makes the login flow return an install URL instead of a handoff.

## Counters

Each `AppInstall` carries two integers:

- `lifecycleGeneration` starts at `1` on first install and is incremented on every reinstall and every uninstall. It orders lifecycle changes.
- `tokenVersion` starts at `0`, increments on every reinstall and every uninstall. Revocation writes include it in their `WHERE` clause, so a request that failed with an old token cannot mark a freshly reinstalled shop `needs_reinstall`.

## Install

1. Consume the `install` OAuth state; it carries `storeDomain` and a safe redirect path.
2. Exchange the code and verify the store with `/admin/store.json`.
3. Take `lock:lifecycle:{storeDomain}` (`409` if another lifecycle operation holds it).
4. Reject the callback if its state was created before the store's `uninstalledAt`.
5. Upsert `Shop` and `AppInstall` (`status=active`, encrypted token, `uninstalledAt=null`, counters updated) and move domain ownership: any other store's active mapping for the same domain is tombstoned, the new one is activated, and the Redis `domain:` mapping is saved.
6. Start (without awaiting) webhook registration and the storefront config metafield write, create the handoff, and release the lock. Failures of those background tasks never fail the install; registration failures are recorded in `webhookRegistrationStatus`.
7. Return a handoff code.

## Session

- Handoff codes are one-time, short-lived, and consumed atomically; the exchange endpoint sets the session cookie and returns the session JWT.
- Admin requests are authenticated by `ShopAuthGuard`: valid session for the same `storeDomain`, trusted origin on unsafe methods, Bearer token required for unsafe methods, and a resolvable Sapo token.
- Sapo access tokens are never returned to the browser.

## Webhooks

- Ten topics are registered after install; the outcome is `AppInstall.webhookRegistrationStatus` (`registered`, `degraded`, `failed`).
- Deliveries are authenticated by signature, resolved to a store, stored idempotently, processed inline, and retried with backoff by the in-process sweep when they fail.

## Uninstall

The `app/uninstalled` webhook takes the lifecycle lock, clears pending handoffs and Redis install/domain keys, then in one transaction sets `status=uninstalled`, nulls the encrypted token columns, sets `uninstalledAt` and `dataPreserved=true`, increments both counters, tombstones active domains, and nulls `payload` and `headers` of the store's `WebhookEvent` rows. Reviews, Q&A and catalog rows are kept. `customer_purchases` and the store's `WebhookEvent` rows are purged by the retention pass once the install has stayed `uninstalled` for 90 days (see `docs/webhook-subscription-uninstall.md`, Retention).

## Reinstall

A new install flow after uninstall or `needs_reinstall` repeats the install steps: the existing `AppInstall` row is updated back to `active`, `uninstalledAt` is cleared, both counters are incremented, a fresh token replaces the old one, and the domains are re-activated. Existing reviews, questions, catalog, and purchase rows are reused.

## Durable background work

`DurabilitySweepService` (`src/ops/durability-sweep.service.ts`) runs once a minute in the API process under a Redis lock. It reclaims stalled webhook events, replays due failed events, re-pushes pending product metafield writes (`MetafieldSyncPending`), runs the hourly retention pass, and, when R2 is configured, sweeps orphaned review media (one page of 200 objects every 5 minutes, objects older than 24 hours that no review references). `GET /readyz` reports `degraded` while any webhook event or metafield sync has failed within the last 60 minutes.

## Core invariants

- No session without a valid launch signature or a completed OAuth flow.
- No Redis `KEYS` in production paths; owner-token lock release only.
- No random webhook idempotency fallback.
- No webhook state mutation before signature and store-identity checks.
- No public readiness details.
- Tokens are encrypted at rest and cleared on uninstall.
