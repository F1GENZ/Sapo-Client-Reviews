# Environment Contract

Every variable the server reads is parsed and validated once at boot by `loadEnv` in `src/config/env.schema.ts`. Invalid values throw and the process exits with the list of problems. `.env.example` holds placeholders only; the server loads `./.env` itself before validation (`src/config/app-config.module.ts`, variables already in the environment win), and PM2 also starts Node with `--env-file=.env` (see `ecosystem.config.cjs`).

## Principles

- No production secret has a real default.
- Production fails closed: missing or placeholder values stop the boot.
- Integer and boolean values that do not parse are errors, never a silent fallback.
- `APP_SESSION_SECRET` and `SAPO_CLIENT_SECRET` must be distinct in every environment. Webhooks are verified with `SAPO_CLIENT_SECRET`; there is no separate webhook secret.
- Secret rules (`src/config/secret-guard.ts`, `src/config/env.schema.ts`): an EMPTY secret is rejected in production by `loadEnv`, and the services that use `SAPO_CLIENT_SECRET`, `APP_SESSION_SECRET` and `DATA_ENCRYPTION_KEY` (`HmacVerifierService`, `SessionService`, `TokenEncryptionService`) throw on an empty or placeholder value in every `NODE_ENV` when they are constructed. A SET value that is a placeholder, shorter than its minimum, or (for the encryption key) not exactly 32 bytes or the public sample key is rejected by `loadEnv` in every `NODE_ENV`, not only in production.

"Production" below means `NODE_ENV=production`. "Explicit" means the variable must be present in the environment even though a default exists, so a deploy cannot inherit a development default by accident.

## App runtime

| Name | Default | Production | Rule |
|---|---|---|---|
| `NODE_ENV` | `development` | set to `production` | `development`, `test`, or `production`. |
| `PORT` | `3000` | explicit | Integer 1-65535. |
| `FRONTEND_URL` | `http://localhost:5173` | required, HTTPS | Absolute URL. Admin SPA origin; target of post-login redirects. |
| `API_BASE_URL` | `http://localhost:3000` | required, HTTPS | Absolute URL. Also used to build the webhook URL registered with Sapo. |
| `CORS_ALLOWED_ORIGINS` | empty | required, non-empty | Comma-separated origins, HTTPS in production. Admin origins allowed with credentials: `FRONTEND_URL`, `API_BASE_URL`, and this list. |
| `TRUST_PROXY` | `false` | required, explicit | Must be present and non-empty in the production environment; `false` is a valid explicit value (app directly exposed). Accepted values: `false`/`0`, a hop count 1-10, or a comma list of proxy IPs, CIDRs, `loopback`, `linklocal`, `uniquelocal`. `true` and malformed values fail boot. In production with `false` the server logs a warning, because behind a proxy all clients share the proxy address and one rate-limit bucket. Set a hop count only after observing the real proxy chain. |
| `REQUEST_BODY_LIMIT` | `1mb` | explicit | `<number>b`, `kb`, or `mb`. |
| `WEBHOOK_BODY_LIMIT` | `256kb` | explicit | Same format; applied to `/api/oauth/install/webhooks`. |

## Sapo OAuth and webhooks

| Name | Default | Production | Rule |
|---|---|---|---|
| `SAPO_CLIENT_ID` | empty | required | Not a placeholder. |
| `SAPO_CLIENT_SECRET` | empty | required | Verifies the admin launch HMAC and authenticates the code exchange. Not a placeholder. |
| `SAPO_SCOPE` | `read_products,write_products,read_orders` | explicit | Whitespace or commas are accepted and normalized to a comma list. |
| `SAPO_INSTALL_CALLBACK_URL` | empty | required, HTTPS | Absolute URL, `{API}/api/oauth/install/callback`. |
| `SAPO_LOGIN_CALLBACK_URL` | empty | required, HTTPS | Absolute URL, `{API}/api/oauth/install/login/callback`. |
| `SAPO_API_MAX_CONCURRENT` | `4` | explicit | Integer >= 1. Per-store concurrent foreground Sapo API calls. |

## Sessions

| Name | Default | Production | Rule |
|---|---|---|---|
| `APP_SESSION_SECRET` | empty | required | At least 32 bytes in production; not a placeholder. Signs the session JWT. |
| `APP_SESSION_TTL_SECONDS` | `43200` (12 h) | explicit | Integer >= 300. Session token and cookie lifetime. |
| `SESSION_HANDOFF_TTL_SECONDS` | `120` | explicit | Integer >= 30. One-time handoff code lifetime. |
| `SESSION_COOKIE_NAME` | `sapo_app_session` | optional | HttpOnly cookie name. |
| `SESSION_COOKIE_DOMAIN` | empty | optional | Cookie `Domain`; omit for a host-only cookie. |

Cookie flags are derived, not configured: `HttpOnly`, `Path=/`, `Secure` in production or when the frontend and API are on different sites, `SameSite=None` for cross-site and `Lax` for same-site (`src/sapo/session.service.ts`).

## Redis

| Name | Default | Production | Rule |
|---|---|---|---|
| `REDIS_HOST` | empty | required | With no host the server uses in-process memory (tests only; state is lost on restart and not shared). |
| `REDIS_PORT` | `6379` | explicit | Integer 1-65535. |
| `REDIS_USERNAME` | empty | optional | ACL username. |
| `REDIS_PASSWORD` | empty | when Redis requires auth | Not a placeholder in production. A value starting with `replace-with` is ignored. |
| `REDIS_TLS` | `false` | per provider | `true/false/1/0/yes/no/on/off`. |
| `REDIS_KEY_PREFIX` | `sapo-app-base` | explicit | Lowercase letters, digits, and hyphens, starting with a letter or digit. Give each app and environment sharing a Redis its own prefix. |

## Database and encryption

| Name | Default | Production | Rule |
|---|---|---|---|
| `DATABASE_URL` | empty | required | PostgreSQL URL. Not a placeholder. |
| `DIRECT_URL` | empty | required | Required by `directUrl = env("DIRECT_URL")` in `prisma/schema.prisma`; used by migrations. Not a placeholder. |
| `DATA_ENCRYPTION_KEY` | empty | required | 32 bytes as 64 hex characters or base64. AES-256-GCM key for Sapo access tokens; also the root for the HKDF-derived key of the buyer email/phone hashes. The public sample key (base64 `MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=` and its hex form) is rejected in every `NODE_ENV`: generate your own. Not a placeholder. |

## Media upload

| Name | Default | Production | Rule |
|---|---|---|---|
| `R2_WORKER_URL` | empty | optional (all or none) | Cloudflare Worker that stores, deletes and lists media (`worker/`). |
| `R2_UPLOAD_SECRET` | empty | optional (all or none) | At least 32 bytes, not a placeholder. Signs upload tickets (the ticket HMAC key is derived from it with a context label) and authenticates the server to the Worker in the `X-Upload-Token` header. The Worker's `UPLOAD_SECRET` secret must hold the same value. |
| `R2_PUBLIC_DOMAIN` | empty | optional (all or none) | Public host serving uploaded images. |

Set all three or none. When none is set the server boots, upload tickets cannot be issued, review-media deletion and the orphan sweep are skipped, and it logs `Media upload is not configured` (`src/media/media.service.ts`, `src/ops/durability-sweep.service.ts`). When any one is set, `loadEnv` requires the other two in every `NODE_ENV`, and `R2_UPLOAD_SECRET` must be at least 32 bytes and not a placeholder (the same guard as `APP_SESSION_SECRET`): it also authorizes Worker `DELETE` and `GET /list`, so a guessable value exposes every store's media. The server calls three Worker routes, all authenticated with `X-Upload-Token`: `PUT /<key>` (upload), `DELETE /<key>` (delete one object) and `GET /list?prefix=&cursor=&limit=` (list objects under `reviews/`, used by the orphan sweep); see `worker/src/index.js`.

## Rate limits

| Name | Default | Production | Rule |
|---|---|---|---|
| `AUTH_RATE_LIMIT_WINDOW_SECONDS` | `60` | explicit | Integer >= 1. Window for OAuth, launch, logout, and session-exchange routes. |
| `AUTH_RATE_LIMIT_MAX` | `60` | explicit | Integer >= 1. Requests per client per window on those routes. |
| `SESSION_EXCHANGE_RATE_LIMIT_MAX` | `60` | explicit | Integer >= 1. Cap for `POST /api/auth/session/exchange` within the auth window. |
| `PUBLIC_WRITE_RATE_LIMIT_WINDOW_SECONDS` | `60` | explicit | Integer >= 1. Window for public review, question, and upload submissions. |
| `PUBLIC_WRITE_RATE_LIMIT_MAX` | `20` | explicit | Integer >= 1. Submissions per store and client per window. |

Anonymous `/api/public` reads and writes also have fixed per-client budgets defined in `src/common/security/public-rate-limit.ts` (not configurable by env); reads are limited per client only, with no per-store read cap.

## Readiness

| Name | Default | Production | Rule |
|---|---|---|---|
| `READINESS_TOKEN` | empty | required | Bearer token for `GET /readyz`. `/livez` is never protected. Not a placeholder. |
| `BUILD_SHA` | `local` | optional | Build label returned by `/readyz`. |

## Production fail-closed summary

Boot fails in production when:

- any variable marked required is empty, or any variable marked explicit is not present in the environment;
- a URL is not an absolute HTTPS URL, or a CORS origin is not HTTPS;
- a secret-like value (`SAPO_CLIENT_ID`, `REDIS_PASSWORD`, `DATABASE_URL`, `DIRECT_URL`, `READINESS_TOKEN`) contains `replace-with`, `change-me`, `changeme`, `placeholder`, `your-`, or `todo` (for `SAPO_CLIENT_SECRET`, `APP_SESSION_SECRET` and `DATA_ENCRYPTION_KEY` this check runs in every `NODE_ENV`);
- `APP_SESSION_SECRET` is shorter than 32 bytes, or `DATA_ENCRYPTION_KEY` does not decode to exactly 32 bytes or is the public sample key (both checks run in every `NODE_ENV`);
- `APP_SESSION_SECRET` equals `SAPO_CLIENT_SECRET` (also checked in every `NODE_ENV`).

`SAPO_API_MIN_INTERVAL_MS` no longer exists: it was removed together with the background request limiter, and the server ignores it if it is still present in an old `.env`. Delete the line.

## `.env.example` policy

It may contain variable names, `replace-with-...` placeholders, localhost URLs, and non-secret sample values. It must not contain real Sapo credentials, real Redis or database URLs, real production domains, access tokens, or values copied from a live `.env`.
