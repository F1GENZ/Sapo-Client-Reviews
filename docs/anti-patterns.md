# Anti-Patterns

Weak patterns this codebase deliberately avoids. Each entry names the code that holds the line; do not weaken it when extending the app.

## Identity and OAuth

### Trusting the callback query for store identity

The install and login callbacks never read the store from the query string. The store domain comes from the one-time OAuth `state` record (`OAuthStateService.consume` in `src/sapo/oauth-state.service.ts`), and the token exchange is followed by a Sapo API call (`/admin/store.json`) that must succeed.

### Non-atomic state or handoff consume

Do not read a one-time value and delete it later; concurrent callbacks replay it. OAuth state and session handoff codes use `RedisService.getDel` (`GETDEL`, Lua fallback) in `src/redis/redis.service.ts`.

### Minting a session from an unsigned launch

A launch query without `hmac` starts the OAuth login flow; one with an invalid, stale (more than 300 s), or malformed `hmac` is rejected. A session is never created from `store` alone (`GET /api/oauth/install/login/verify-hmac`).

### Wrong HMAC encoding or ordering for the launch signature

The launch HMAC is HMAC-SHA256 over the params sorted A-Z with `hmac` removed, and the digest is Base64, not lowercase hex. Compare raw digest bytes with `timingSafeEqual` (`src/sapo/hmac-verifier.service.ts`).

### Long-lived session token in a URL

Only the one-time `handoff_code` travels in the redirect URL. The session token is returned in the body of `POST /api/auth/session/exchange`, and the SPA strips the handoff params from the URL after use.

### Treating the cookie alone as write authority

State-changing admin requests need a `Bearer` session token plus a trusted `Origin`/`Referer`; a cookie by itself is refused (`src/common/guards/shop-auth.guard.ts`).

### Reusing one secret for several jobs

`APP_SESSION_SECRET` and `SAPO_CLIENT_SECRET` must differ; boot fails otherwise (`src/config/env.schema.ts`). Sapo signs webhooks with the client secret itself, so there is no separate webhook secret.

## Webhooks

### HMAC over parsed JSON

The signature covers the raw bytes. Only the webhook path keeps `req.rawBody` (`src/common/security/body-limits.ts`), and `verifyWebhookBody` hashes that buffer.

### Trusting a header or query for the store

`x-sapo-store-domain` and query `storeDomain` are compatibility input; they must equal the identity resolved from the signed payload and the domain mapping, or the delivery is rejected (`WebhookService.resolveIdentity`).

### Random idempotency fallback

When Sapo sends no delivery id, the key is `sha256(topic + identity + payload hash)`. Never add `randomBytes`/`randomUUID` there, or a redelivery stops being a duplicate.

### IP rate limiting the webhook receiver

Sapo delivers from shared addresses; a per-IP bucket merges all stores and drops real events. The route relies on the signature and idempotency instead.

### Swallowing failures

A handler error marks the event `failed`, schedules a backoff retry, and is rethrown so Sapo sees the failure. Do not catch and return `200`.

## Sapo API usage

### Calling the store API outside the throttle

Every call to `https://{store}/admin/...` goes through `SapoApiService.fetch`, which enforces per-store concurrency, honors `X-Sapo-Api-Call-Limit` headroom, and retries `429` with `Retry-After` (`src/sapo/sapo-api.service.ts`). A raw `fetch` bypasses the leaky-bucket protection.

### Revoking on the wrong signal

Tokens are permanent. Only `401`/`403` from Sapo marks an install `needs_reinstall`; `429`, `5xx`, and network errors never do, and the write is fenced by `tokenVersion` (`src/sapo/install-revocation.ts`).

### Building a Sapo shop URL from user input

Authorize URLs are built only for hosts matching `*.mysapo.net` (`src/sapo/sapo.service.ts`).

## Redis and locks

### Redis `KEYS`

Do not use `KEYS` in production paths. Use deterministic keys, database lookups, or `RedisService.scanKeys` for cleanup (used by `SessionService.clearStoreHandoffs`).

### Non-owner lock release

Locks store an owner token and release with a compare-and-delete script (`RedisService.acquireLock` / `releaseLock`). Never `del` a lock key directly.

### Shared key prefix

Apps sharing a Redis instance need their own `REDIS_KEY_PREFIX`; the key namespace is the only isolation.

## Deploy and proxy

- **Hardcoded backend fallback.** The Cloudflare Pages proxy requires `BACKEND_URL` and answers `502` without it (`client/functions/api/[[path]].js`); never default it to a production host.
- **`npm install` in deploys.** Use `npm ci` (`.github/workflows/deploy.yml`).
- **`pm2 --watch` in production.** Use an explicit build and `pm2 startOrReload`.
- **Expecting `.env` to override the process environment.** The server loads `./.env` itself at boot (`src/config/app-config.module.ts`) but only fills variables that are not already set, so a value exported by the shell, PM2 or the deploy (for example `BUILD_SHA`) wins. PM2 also starts Node with `--env-file=.env` (`ecosystem.config.cjs`), so a missing file fails the boot there.
- **Rolling back without a snapshot.** `dist` is copied to `dist.prev` before `prisma migrate deploy` and the build, the new build is made in `dist.next` and swapped with `mv`, and `pm2 save` runs only after the `/readyz` probe passes, so a failed probe restores code that actually ran.
- **Running `prisma migrate dev` against a database you care about while experimenting.** Use a throwaway database; deploys use `prisma migrate deploy`, which only applies pending migrations.
