# Getting Started — F1GENZ Review Sapo

## Prerequisites

- Node.js 20.6+ (`engines`; CI runs Node 22; the VPS needs 20.6+ because PM2 starts Node with `--env-file`)
- PostgreSQL (local or Supabase)
- Redis (local or Upstash). Without `REDIS_HOST` the server falls back to in-process memory for state, which is only suitable for tests.
- Sapo Partner account + app registered at `developers.sapo.vn`
- Sapo dev store (sandbox) — `your-store.mysapo.net`

## Repository layout

| Path | Contents |
|---|---|
| `src/`, `prisma/`, `test/`, `e2e/` | NestJS server (repo root `package.json`) |
| `client/` | Admin SPA (Vite + React) and the Cloudflare Pages proxy function |
| `storefront/` | Storefront widget assets and `.bwt` theme snippets |
| `worker/` | Cloudflare Worker for R2 image uploads |
| `ecosystem.config.cjs` | PM2 config: one process, `f1genz-sapo-api` |

## Local Setup

```bash
git clone <repo-url>
cd f1genz-review-sapo

# Server (from the repo root)
cp .env.example .env
# Edit .env: Sapo credentials, DATABASE_URL/DIRECT_URL, Redis, secrets

npm ci
npm run db:generate
npx prisma migrate dev

# Server, port from PORT (default 3000). The server loads ./.env itself
# (src/config/app-config.module.ts); variables already in the environment win.
npm run dev

# Client (separate terminal)
npm --prefix client ci
cp client/.env.example client/.env
npm --prefix client run dev  # → http://localhost:5173, proxies /api to VITE_SAPO_API_URL
```

`prisma migrate dev` can reset the schema: run it only against a throwaway database, never one that holds real data. CI and deploy use `prisma migrate deploy`, which only applies pending migrations.

### Existing database baseline

If the database already has the tables (created before the migrations in `prisma/migrations/` existed), `migrate deploy` fails with P3005 or on `CREATE TYPE ... already exists`. Baseline once, after checking that the live schema matches `prisma/schema.prisma` (`npx prisma migrate diff --from-url "$DIRECT_URL" --to-schema-datamodel prisma/schema.prisma --exit-code` exits 0):

```bash
npx prisma migrate resolve --applied 202607050000_init
npx prisma migrate resolve --applied 202607051500_active_domain_unique   # only if it was never recorded in _prisma_migrations
npm run db:migrate                                                       # applies the remaining migrations
```

Never baseline a migration whose changes are not already in the database.

## Sapo Sandbox Configuration

1. Register the app in the Sapo Partner dashboard.
2. Set the install callback, login callback, and webhook URL to a public tunnel pointing at your local server (paths are listed in `docs/deploy-sapo.md`).
3. Copy `SAPO_CLIENT_ID` and `SAPO_CLIENT_SECRET` to `.env`, and set `SAPO_INSTALL_CALLBACK_URL` / `SAPO_LOGIN_CALLBACK_URL` to the same tunnel URLs.
4. Generate separate values for `APP_SESSION_SECRET` and `DATA_ENCRYPTION_KEY`. `.env.example` holds `replace-with-...` placeholders and the sample encryption key is rejected: the server refuses to boot until you replace them.

Required OAuth scopes:
```
read_products,write_products,read_orders
```

## Verify

```bash
npm run verify              # server typecheck, tests, build
npm --prefix client run build
```

Black-box suites: `npm run test:e2e` (server HTTP contract) and `npm --prefix client run test:e2e` (admin journeys and storefront widget).

## Architecture

- **Server**: NestJS 10 (Express) + Prisma 5 + PostgreSQL + Redis (`ioredis`), single process
- **Client**: Vite + React 19 + antd 5 + TanStack Query + React Router 7
- **Worker**: Cloudflare Worker (R2 image uploads)
- **Deploy**: PM2 + Cloudflare Pages + a VPS (see `docs/deploy-sapo.md`)

See `docs/architecture-contracts.md` for module and route detail.

## Sapo Platform Notes

| Topic | Sapo behavior used here |
|---|---|
| Auth | OAuth2 authorization code only, no OpenID identity token or JWKS |
| API auth header | `X-Sapo-Access-Token` |
| API host | Per store: `https://{store}.mysapo.net/admin` |
| Merchant identity | `storeDomain` |
| Token | Permanent, no refresh |
| Launch HMAC | HMAC-SHA256 over params sorted A-Z, Base64 digest |
| Rate limit | Leaky bucket, header `X-Sapo-Api-Call-Limit` |
