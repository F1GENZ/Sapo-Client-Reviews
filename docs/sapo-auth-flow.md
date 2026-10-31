# Sapo OAuth2 Authentication Flow

F1GENZ Review Sapo uses Sapo's OAuth2 authorization-code flow. Source of truth: `src/sapo/sapo.controller.ts`, `src/sapo/sapo.service.ts`, `src/sapo/hmac-verifier.service.ts`, `src/sapo/oauth-state.service.ts`, `src/sapo/session.service.ts`, `src/common/guards/shop-auth.guard.ts`.

- There is no OpenID identity token and no JWKS; store identity comes from the one-time OAuth `state` plus a Sapo API call made with the new token.
- Access tokens are permanent (no refresh, no expiry). Only a `401`/`403` from Sapo means the app was revoked.
- The admin launch URL carries an HMAC signature (`store`, `timestamp`, `hmac`; params sorted A-Z, SHA-256, Base64). The OAuth callbacks are bound by the one-time `state` instead.
- The merchant identity inside the app is `storeDomain` (for example `shop.mysapo.net`).

## Routes

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/oauth/install/start?storeDomain=` | public, rate limited | Returns the Sapo authorize URL for an install flow. |
| `GET /api/oauth/install/callback` | public, rate limited | Install callback. With `code`: completes install. Without `code` but with `store`: redirects to a login flow. |
| `GET /api/oauth/install/login`, `GET /api/oauth/install/login/entry` | public, rate limited | Start a login flow for a `storeDomain`. |
| `GET /api/oauth/install/login/verify-hmac` | public, rate limited | Verify the signed admin launch query; on success returns a one-time handoff code. With no `hmac` it starts the login flow instead. |
| `GET`/`POST /api/oauth/install/login/callback` | public, rate limited | Login callback. |
| `POST /api/oauth/install/webhooks` | HMAC | See `docs/webhook-subscription-uninstall.md`. |
| `POST /api/auth/session/exchange` | handoff code + trusted origin | Consumes a handoff code, sets the session cookie, returns a session token. |
| `POST /api/auth/logout` | session + trusted origin | Clears the session cookie. |
| `GET /api/app/session` | session | Session probe: `storeDomain`, `shopDomain`, `status`, `featuresUnlocked`, `webhookStatus`. |

Rate limits use `AUTH_RATE_LIMIT_WINDOW_SECONDS` and `AUTH_RATE_LIMIT_MAX` (session exchange uses `SESSION_EXCHANGE_RATE_LIMIT_MAX`).

## Install flow

```text
1. App asks for an install URL (GET /api/oauth/install/start?storeDomain=shop.mysapo.net)
   -> server stores a one-time state and returns
      https://{store}.mysapo.net/admin/oauth/authorize
        ?client_id={SAPO_CLIENT_ID}&scope={SAPO_SCOPE}
        &redirect_uri={SAPO_INSTALL_CALLBACK_URL}&state={state}

2. Merchant approves; Sapo redirects to
   GET /api/oauth/install/callback?code=...&state=...

3. Server consumes the state (it carries storeDomain and a safe redirect path;
   the callback query is never trusted for identity), then exchanges the code:
     POST https://{store}/admin/oauth/access_token
     (form-encoded: client_id, client_secret, code)

4. Server calls GET https://{store}/admin/store.json with the new token
   to prove the store exists and collect its domains.

5. Under the lifecycle lock, server upserts Shop + AppInstall (status active,
   token encrypted with AES-256-GCM), tombstones domains previously owned by
   another store, saves the domain mappings.

6. In the background: register webhooks, write the storefront config metafield.

7. Server creates a one-time handoff code; the browser lands on
   FRONTEND_URL with ?storeDomain=...&handoff_code=...
```

Only `*.mysapo.net` hosts are accepted when building authorize URLs. A callback whose state was created before the store's `uninstalledAt` is rejected as stale.

## Login flow and admin launch

- **Launch with signature.** The Sapo admin opens the app with `store`, `timestamp`, and `hmac` in the query. The SPA forwards the raw query to `GET /api/oauth/install/login/verify-hmac`, which verifies it and returns a handoff for `store` with `redirectTo=/dashboard`.
- **Launch without signature, or session lost.** The SPA starts the login flow for a `storeDomain`; Sapo redirects to `SAPO_LOGIN_CALLBACK_URL`. The server consumes the `login` state, exchanges the code, re-verifies the store with `/admin/store.json`, then:
  - if an install exists and its status is not blocked, returns a handoff;
  - otherwise (no install, or `canceled`, `expired`, `needs_reinstall`, `declined`, `uninstalled`) returns an install authorize URL (`reason: install_required`).
- A present-but-invalid or stale `hmac` is rejected (`401`); it never falls back to a session.

## HMAC verification (admin launch)

```text
1. Parse the raw query string, drop the `hmac` pair.
2. Require a numeric `timestamp` within 300 seconds of now.
3. Sort the remaining pairs by key (A-Z, localeCompare).
4. Join as key=value&key=value (tried with decoded values, then with the raw values).
5. HMAC-SHA256(message, SAPO_CLIENT_SECRET).
6. The received `hmac` must be the Base64 of the 32-byte digest; compare the raw bytes timing-safe.
```

Sapo signs with sorted parameters, and the digest is Base64, not hex.

## OAuth state

- Format `sapo_oauth_<64 hex>`; stored in Redis as `oauth-state:{sha256(state)}` for 30 minutes.
- Payload: `flow` (`login` or `install`), `createdAt`, `storeDomain`, optional safe `redirectTo`.
- Consumed atomically with `GETDEL`; a replayed or wrong-flow state is rejected.
- `redirectTo` is kept only if it is a safe redirect: starts with exactly one `/`, is not `//...`, has no control characters, stays same-origin after URL normalization, and does not target `/install*`, `/oauth*`, or `/api/oauth*` (checked before and after decoding). Anything else becomes `/dashboard`.

## Token management

- Stored encrypted server-side (`AppInstall.accessTokenCiphertext/Iv/Tag`, AES-256-GCM, key `DATA_ENCRYPTION_KEY`); never sent to the browser or storefront.
- Resolved per request by `SapoService.resolveAccessToken(storeDomain)`; a missing install, missing token, or blocked status raises `401 App needs reinstall`.
- A `401`/`403` from Sapo while syncing storefront metafields marks the install `needs_reinstall`. The write is fenced by `tokenVersion`, so a request that failed with an old token cannot downgrade a fresh reinstall (`src/sapo/install-revocation.ts`). `429`, `5xx`, and network errors never revoke.

## Session

- After install, login, or launch the server issues a handoff code `sapo_handoff_<64 hex>`, stored as `session-handoff:{sha256(code)}` for `SESSION_HANDOFF_TTL_SECONDS` (default 120) and consumed once with `GETDEL`.
- `POST /api/auth/session/exchange` (origin must be the frontend, API, or a `CORS_ALLOWED_ORIGINS` entry) consumes the code, sets an HttpOnly cookie, and returns `sessionToken` for the admin SPA.
- The session token is an HS256 JWT `{ storeDomain, gen, type: sapo_app_session, iat, exp }` signed with `APP_SESSION_SECRET`, valid for `APP_SESSION_TTL_SECONDS` (default 12 hours). `gen` is the install's `lifecycleGeneration` at issue time; `SessionService` rejects a token without a numeric `gen`, so sessions issued before this claim existed are invalid and each merchant signs in once more after the deploy that introduced it. The secret must differ from `SAPO_CLIENT_SECRET` (startup fails otherwise).
- Cookie: `HttpOnly`, `Path=/`, name `SESSION_COOKIE_NAME`. `SameSite=Lax` when the frontend and API share a site, `SameSite=None; Secure` when they do not; `Secure` is also forced in production.
- `ShopAuthGuard` protects `/api/admin/*` and `/api/app/session`: it checks the request origin on unsafe methods, requires a `Bearer` session token on unsafe methods (the cookie alone is not enough), requires any `x-store-domain` or `storeDomain` value to equal the session's store, answers `401` when the token's `gen` differs from the install's current `lifecycleGeneration` (an uninstall or reinstall invalidates earlier sessions), and resolves the Sapo token.
- The admin SPA keeps the session token in browser storage (`client/src/common/AuthStorage.js`) and sends it as `Authorization: Bearer`; the session cookie covers safe (read) requests. Because the token is readable by page scripts, keep third-party scripts out of the admin origin, and treat script injection there as session theft. The token is bound to one `storeDomain` and expires after `APP_SESSION_TTL_SECONDS`.
