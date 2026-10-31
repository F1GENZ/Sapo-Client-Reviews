# Sapo Production Deploy

## Architecture

```text
Cloudflare Pages (client SPA)
  ├─ /api/* → proxy → NestJS server (DO + PM2); only `/api/*` is routed (client/public/_routes.json)
  └─ /storefront/* is not routed through Pages: storefront assets are served by NestJS from the API host (`API_BASE_URL`)

NestJS Server (shared VPS, PM2 process f1genz-sapo-api)
  └─ HTTP API + webhook receiver (no separate worker role: the server has no queue consumers)

PostgreSQL (Supabase) — app data
Redis — sessions, locks, rate limits
Cloudflare R2 — media uploads (f1genz-sapo-images)
```

## Prerequisites

1. **Supabase** PostgreSQL database (or any Postgres)
2. **Redis** instance (Upstash, Redis Cloud, or self-hosted)
3. **Cloudflare R2** bucket `f1genz-sapo-images` + custom domain
4. **Cloudflare Pages** project for client
5. **DigitalOcean** droplet (Ubuntu 22.04+) with Node.js 20.6+ (the workflow installs no Node on the VPS; PM2 loads `.env` through `--env-file`). CI jobs run Node 22
6. **Sapo Partner** app registered at `developers.sapo.vn`

## Sapo Partner Dashboard

Register with these URLs:
- App URL: `https://reviews-sapo.f1genz.dev`
- Install callback: `https://api-sapo-reviews.f1genz.dev/api/oauth/install/callback`
- Login callback: `https://api-sapo-reviews.f1genz.dev/api/oauth/install/login/callback`
- Webhook URL: `https://api-sapo-reviews.f1genz.dev/api/oauth/install/webhooks`
- Scopes: `read_products,write_products,read_orders` (comma-separated, per Sapo OAuth docs). Minimal set for the code paths in use: products and metafields, order reads. Confirm on the sandbox install that metafield and webhook calls return 2xx before widening.

## Server Deploy (GitHub Actions to the shared VPS)

The VPS is shared with other apps. Keep the Sapo app isolated:

- Own directory (`APP_DIR`, for example `/var/www/f1genz-sapo`), own `.env`, own PM2 name `f1genz-sapo-api`.
- Own `PORT` (for example `3021`), own Postgres database, own `REDIS_KEY_PREFIX`.
- A deploy user that can write only `APP_DIR` and run `pm2 reload` for `f1genz-sapo-api`; never `root`.

One-time bootstrap on the VPS:

```bash
mkdir -p /var/www/f1genz-sapo
# create /var/www/f1genz-sapo/.env from .env.example (PORT, DATABASE_URL, DIRECT_URL, secrets, REDIS_KEY_PREFIX)
```

Repository secrets for `.github/workflows/deploy.yml`: `SSH_PRIVATE_KEY`, `VPS_HOST`, `VPS_USER`, `APP_DIR`. The deploy reads `PORT` and `READINESS_TOKEN` from the VPS environment or `APP_DIR/.env` (no GitHub secret for them) and fails before touching anything else if `READINESS_TOKEN` is missing.

Pipeline (`.github/workflows/deploy.yml`, triggers: push to `master` and manual dispatch; the remote only has `master`):

1. Jobs `verify-server` (`npm run verify`), `verify-client` (client build) and `e2e` (the reusable `.github/workflows/ci-e2e.yml`: server HTTP contract against real Postgres and Redis, client build, performance budget, client unit tests, admin journeys and storefront widget) run first. The `deploy` job `needs` all three and only runs on `refs/heads/master` (a manual dispatch from another ref stops after the checks). `ci-e2e.yml` also runs on pull requests to `master` or `main` and on pushes to `main`; it does not run on pushes to `master` by itself, because `deploy.yml` already calls it there, where its `server-verify` job is skipped (`skip-verify`).
2. rsync of the checked-out source to `APP_DIR` (excludes `.env`, `client/`, `plans/`, `recipes/`, `node_modules/`, `dist*`).
3. On the VPS: `npm ci`, `prisma generate`, then `dist` is copied to `dist.prev` **before** `prisma migrate deploy`, so the previous build is preserved whatever happens next.
4. `npm run build -- --outDir dist.next`; on success `dist` is swapped for `dist.next` with `mv` (a failed build leaves the live `dist` untouched).
5. `pm2 startOrReload ecosystem.config.cjs --update-env`, then up to 20 probes (3 s apart) of `http://127.0.0.1:$PORT/readyz` with `Authorization: Bearer $READINESS_TOKEN`. The probe passes on HTTP 200 with `status` `ok` or `degraded` (see `src/health/health.controller.ts`; `down` fails it).
6. Probe failed: `dist` is replaced by `dist.prev`, PM2 is reloaded and the job fails. Probe passed: `pm2 save` runs only now, then `dist.prev` is removed.

Migrations are not rolled back by a failed probe: they run before the build swap, so write them additive and prefer a forward fix.

Known gaps, deliberately not implemented here:

- **Host key pinning.** The workflow trusts the VPS host with `ssh-keyscan` on every run, which accepts whatever key answers at that moment. Pinning needs the real VPS host key, which only the operator has. Recommended change: store the output of `ssh-keyscan -H <host>` taken from a trusted machine (verify the fingerprint against the provider console) as a repository secret `VPS_KNOWN_HOSTS` and write it to `~/.ssh/known_hosts` instead of running `ssh-keyscan` in the workflow.
- **Response compression.** The server has no `compression` middleware (adding one is a dependency install the operator must approve). Enable compression at the edge tier: Cloudflare for the public hostnames, or the reverse proxy in front of PM2.

First deploy after the session `gen` change: the session JWT gained a `gen` claim (the install's `lifecycleGeneration`), and tokens without it are rejected. Every merchant is signed out once and signs in again; no data migration is involved.

Manual equivalent on the VPS (keeps the same order):

```bash
cd "$APP_DIR"
npm ci && npx prisma generate
[ -d dist ] && rm -rf dist.prev && cp -a dist dist.prev
npm run db:migrate
npm run build -- --outDir dist.next && { [ -d dist ] && mv dist dist.old; mv dist.next dist; rm -rf dist.old; }
BUILD_SHA="<deployed commit sha>" pm2 startOrReload ecosystem.config.cjs --update-env
curl -fsS -H "Authorization: Bearer $READINESS_TOKEN" "http://127.0.0.1:$PORT/readyz" && pm2 save
```

`BUILD_SHA` reaches `/livez` only from the process environment (the environment wins over `.env`). The workflow writes `DEPLOY_COMMIT` and exports `BUILD_SHA` from it before each `pm2 startOrReload`; on a manual run set it to the commit being deployed.

### Baseline an existing database (one time)

If `DATABASE_URL` points at a database whose tables were created before `prisma/migrations/` existed, `npm run db:migrate` fails with P3005 or on `CREATE TYPE ... already exists` and every later deploy stays blocked. The running app is not affected: `dist.prev` is snapshotted and `set -e` stops before the build swap. On the VPS, once, after confirming the live schema matches `prisma/schema.prisma` (`npx prisma migrate diff --from-url "$DIRECT_URL" --to-schema-datamodel prisma/schema.prisma --exit-code` exits 0):

```bash
cd "$APP_DIR"
npx prisma migrate resolve --applied 202607050000_init
npx prisma migrate resolve --applied 202607051500_active_domain_unique   # only if it was never recorded in _prisma_migrations
```

Then rerun the deploy; `migrate deploy` applies the remaining migrations. Never mark a migration applied whose changes are not already in the database. A fresh empty database needs none of this.

## Client Deploy (Cloudflare Pages)

```bash
npm --prefix client ci
npm --prefix client run build
# Deploy client/dist via Cloudflare Pages dashboard or wrangler
```

Cloudflare Pages env vars:
- `BACKEND_URL=https://api-sapo-reviews.f1genz.dev`

Build settings:
- Build command: `npm run build`
- Output directory: `dist`
- Root directory: `client`

## Worker Deploy (Cloudflare R2)

```bash
cd worker
npm ci
npx wrangler secret put UPLOAD_SECRET   # same value as the server's R2_UPLOAD_SECRET
npx wrangler deploy
```

Redeploy the Worker together with the server release that first calls `DELETE /<key>` and `GET /list`: until it is redeployed those calls fail (best-effort, logged), review-media deletion and the orphan sweep delete nothing, and nothing else breaks.

Worker routes (`worker/src/index.js`), all requiring `X-Upload-Token` (constant-time compare against `UPLOAD_SECRET`):

| Route | Purpose |
|---|---|
| `PUT /<key>` | Upload. Key shape `reviews/{storeDomain}/{productId}/{random}.{jpg,png,webp,mp4}`; the extension must match `Content-Type`; `Content-Length` required; 5 MB cap for images and 2 MB for video. |
| `DELETE /<key>` | Delete one object with a valid key. Used when a review or its media is deleted. |
| `GET /list?prefix=&cursor=&limit=` | List objects (default prefix `reviews/`, `limit` 1-1000, default 200) with `key`, upload time and size. Used by the orphan sweep. |

Orphan sweep (`src/ops/durability-sweep.service.ts`): every 5 minutes the sweep lists one page of 200 objects, and deletes those uploaded more than 24 hours ago whose URL is not referenced by any `review_products.media` row of that store and product. Objects of a store without an install row are kept. After the last page it rests for 6 hours before starting again. It is skipped while `R2_WORKER_URL`, `R2_UPLOAD_SECRET` or `R2_PUBLIC_DOMAIN` is unset. Deleting a review (or removing media from one) deletes the objects immediately and best-effort; the sweep catches what that missed.

## Env Checklist

Every key, default, and production requirement is listed in `docs/env-contract.md` (source: `src/config/env.schema.ts`). The server refuses to start in production when a required key is missing. At minimum set:
- `NODE_ENV=production`, `PORT`, `API_BASE_URL`, `FRONTEND_URL`, `CORS_ALLOWED_ORIGINS`, `REQUEST_BODY_LIMIT`, `WEBHOOK_BODY_LIMIT`
- `TRUST_PROXY` (required and explicit in production; `false` is allowed when the app is directly exposed, otherwise the verified hop count or proxy CIDR list)
- `SAPO_CLIENT_ID`, `SAPO_CLIENT_SECRET`, `SAPO_SCOPE`
- `SAPO_INSTALL_CALLBACK_URL`, `SAPO_LOGIN_CALLBACK_URL`
- `APP_SESSION_SECRET` (at least 32 bytes), `APP_SESSION_TTL_SECONDS`, `SESSION_HANDOFF_TTL_SECONDS`
- `DATABASE_URL`, `DIRECT_URL`, `DATA_ENCRYPTION_KEY` (your own 32-byte key; the public sample key is rejected in every `NODE_ENV`)
- `REDIS_HOST`, `REDIS_PORT`, `REDIS_KEY_PREFIX`, and `REDIS_PASSWORD` when the Redis instance requires auth
- `SAPO_API_MAX_CONCURRENT`
- the ingress rate-limit variables and `READINESS_TOKEN`

`SAPO_API_MIN_INTERVAL_MS` was removed; delete it from the VPS `.env`. Secrets that are empty (production) or placeholder/too short (any environment) stop the boot.

Media (not required for boot): `R2_WORKER_URL`, `R2_UPLOAD_SECRET`, `R2_PUBLIC_DOMAIN`. Set all three or none: any one of them without the other two stops the boot in every `NODE_ENV`, and a set `R2_UPLOAD_SECRET` must be at least 32 bytes and not a placeholder (it also authorizes Worker list and delete). Without them uploads and media deletion do not work.

## Health Checks

```bash
# Liveness (public)
curl https://api-sapo-reviews.f1genz.dev/livez

# Readiness (protected)
curl -H "Authorization: Bearer $READINESS_TOKEN" https://api-sapo-reviews.f1genz.dev/readyz
```

## Pre-Launch Verification

```bash
npm run verify
```

Manual checks:
1. Install on Sapo sandbox via OAuth
2. Admin SPA loads embedded, reviews/Q&A CRUD works
3. Storefront widget renders on theme
4. Webhooks verified, idempotent
5. Media upload via worker succeeds; deleting that review removes the object (`DELETE` on the Worker)
6. `rg -i "jwks|oidc" src client/src` returns zero hits

## Rollback

- Client: roll back Cloudflare Pages deployment
- Server: a failed `/readyz` probe restores `dist.prev` automatically; by hand, `mv dist dist.bad && mv dist.prev dist && pm2 reload f1genz-sapo-api` (only while `dist.prev` still exists, it is removed after a healthy deploy)
- Worker: `wrangler rollback`
- If migrations ran, prefer forward fix; do not manually delete lifecycle rows
