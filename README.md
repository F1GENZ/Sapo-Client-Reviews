# F1GENZ Review Sapo

Product reviews and Q&A app for Sapo (Bizweb) stores: a NestJS API with webhook receiver, an admin SPA embedded in the Sapo admin, a storefront widget with `.bwt` theme snippets, and a Cloudflare Worker for review media in R2.

| Path | Contents |
|---|---|
| `src/`, `prisma/`, `test/`, `e2e/` | NestJS server, Prisma schema and migrations, `node:test` suites, black-box HTTP contract runner |
| `client/` | Admin SPA (Vite + React) and the Cloudflare Pages proxy function |
| `storefront/` | Storefront widget runtime and `.bwt` snippets |
| `worker/` | Cloudflare Worker for R2 (`PUT`, `DELETE`, `GET /list`) |
| `ecosystem.config.cjs` | PM2: one process, `f1genz-sapo-api` |
| `docs/` | Contracts, security, deploy and validation docs |

## Run

Node 20.6 or newer (`engines`; CI runs Node 22), PostgreSQL, Redis.

```bash
cp .env.example .env           # fill in; see docs/env-contract.md
npm ci
npm run db:generate
npm run dev                    # tsx watch; the server loads ./.env itself (src/config/app-config.module.ts), variables already in the environment win

npm --prefix client ci
npm --prefix client run dev    # http://localhost:5173
```

`npx prisma migrate dev` creates and resets schema: run it only against a throwaway database, never one that holds real data. CI and deploy use `prisma migrate deploy` (`npm run db:migrate`), which only applies pending migrations.

## Verify

```bash
npm run verify                       # server typecheck, tests, build
npm run test:e2e                     # server HTTP contract (needs Postgres and Redis, see docs/sapo-listing-dossier.md)
npm --prefix client run test:unit
npm --prefix client run build
npm --prefix client run test:e2e     # admin journeys and storefront widget (Playwright)
```

## Environment and deploy

- Every variable, default and production rule: `docs/env-contract.md` (`src/config/env.schema.ts`). Production requires `TRUST_PROXY` to be set explicitly.
- Deploy pipeline, VPS bootstrap, Worker deploy, rollback: `docs/deploy-sapo.md`. A push to `master` runs `.github/workflows/deploy.yml` (server verify, client build and the reusable E2E workflow must pass first).
- Security checklist and known limitations: `docs/security-checklist.md`.
- Manual sandbox validation: `docs/e2e-validation-checklist.md`.

## Git

The git directory is `.git-nested/` (use `git --git-dir=.git-nested --work-tree=.`). Branch: `master`. Remotes: `server` (`F1GENZ/Sapo-Server-Reviews`) and `client` (`F1GENZ/Sapo-Client-Reviews`); the remote has no `main` branch.

`REFERENCE.md` points at the read-only Haravan app this one was ported from.
