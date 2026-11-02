# Sapo Production Deploy

Runbook for the live F1GENZ Reviews (Sapo) stack. The walk-through that proved it on production (2026-11-02, sandbox store `f1genz-purity.mysapo.net`) is recorded in `docs/e2e-validation-checklist.md`: ticked items were observed on production. This file contains no secrets. Secrets exist only in the VPS `.env`, the GitHub repository secrets, the Cloudflare Worker secret and the operator's own environment.

## Architecture

```text
Sapo admin (iframe) ─► https://api-sapo-reviews.f1genz.dev/api/oauth/install/callback ─302─► https://reviews-sapo.f1genz.dev (admin SPA)
Admin SPA  ─ /api/* ─► Pages Function ─► https://api-sapo-reviews.f1genz.dev
Storefront widget ─► https://api-sapo-reviews.f1genz.dev/storefront/* and /api/public/*
Sapo webhooks     ─► https://api-sapo-reviews.f1genz.dev/api/oauth/install/webhooks
Review media      ─► Worker f1genz-sapo-reviews-media ─► R2 f1genz-sapo-reviews-media ─► https://images-sapo.f1genz.dev

api-sapo-reviews.f1genz.dev ─ Cloudflare edge ─ tunnel (cloudflared on the VPS) ─► 127.0.0.1:3021
  PM2 f1genz-sapo-api (HTTP API, webhook receiver and in-process durability sweep; no separate worker role)
    ├─ PostgreSQL 16 on the VPS (127.0.0.1:5432)
    └─ Redis container redis-apps on the VPS (127.0.0.1:6380, AOF)
```

| Piece | Value |
|---|---|
| Cloudflare account / zone | account `dc25380a46ad0853b9b0d98ce7a74270`, zone `f1genz.dev`; names follow the F1GENZ Cloudflare naming standard |
| API host | `api-sapo-reviews.f1genz.dev`: proxied CNAME to the shared tunnel, ingress `http://localhost:3021` |
| Admin SPA | Pages project `f1genz-sapo-reviews-admin` (production branch `master`, direct uploads), custom domain `reviews-sapo.f1genz.dev`, variable `BACKEND_URL` |
| Media | R2 bucket `f1genz-sapo-reviews-media`, Worker `f1genz-sapo-reviews-media`, public custom domain `images-sapo.f1genz.dev` |
| Server | shared VPS (`VPS_HOST` secret), `APP_DIR=/var/www/haravan/Sapo-Server--Reviews`, PM2 process `f1genz-sapo-api` (one fork process, `--env-file=.env`), port `3021` (UFW allows only 22, 80 and 443, so the port is not reachable from outside) |
| PostgreSQL | database `sapo_reviews_db`, role `sapo_reviews`: login role, not superuser/createdb/createrole/replication/bypassrls, connection limit 40, owner of that database only; the database ACL grants nobody else, and the role has no privilege on any other database's tables |
| Redis | container `redis-apps`, key prefix `sapo-reviews` (`REDIS_KEY_PREFIX`); never flush or scan other prefixes |

The VPS is shared with other production apps. Everything in this runbook touches only the objects named above; never run `pm2 kill`, `pm2 update`, `pm2 restart all` or edit another app's `.env`, database, Redis prefix, nginx or tunnel entry.

## Sapo Partner Dashboard

Partner app `3833` (`F1GENZ Reviews - Đánh giá sản phẩm`, `developers.sapo.vn/services/partners/api_clients/edit/3833`) is the app used for the sandbox installs and for production.

- Application URL: `https://api-sapo-reviews.f1genz.dev/api/oauth/install/callback`. Sapo opens it for the embedded app and for the install redirect.
- Embedded: on. Preferences URL, Support URL and Proxy URL: empty.
- The form has no scope or webhook fields. Scopes come from `SAPO_SCOPE` (`read_products,write_products,read_orders`, comma-separated) in the authorize URL, whose `redirect_uri` is `SAPO_LOGIN_CALLBACK_URL` (`https://api-sapo-reviews.f1genz.dev/api/oauth/install/login/callback`). The app registers its ten webhooks itself at install, each with the address `https://api-sapo-reviews.f1genz.dev/api/oauth/install/webhooks`: `app/uninstalled`, `store/update`, `products/create`, `products/update`, `products/delete`, `orders/create`, `orders/updated`, `orders/paid`, `orders/cancelled`, `orders/fulfilled`.
- The Application URL holds one value. Testing locally through a quick tunnel means pointing it at the tunnel and back, and installs fail while it points elsewhere; a second Partner app for development avoids that.

## Server on the VPS

```text
/var/www/haravan/Sapo-Server--Reviews        APP_DIR, the rsync target
  .env                                       root only (mode 600); never in git, never rsynced, never deleted by the deploy
  dist/  dist.prev/                          live build and the previous build
  DEPLOY_COMMIT                              sha of the deployed commit
  scripts/remote-deploy.sh                   run by the deploy gate
```

Non-secret production values (`docs/env-contract.md` lists every key):

| Key | Value |
|---|---|
| `NODE_ENV`, `PORT` | `production`, `3021` |
| `API_BASE_URL` | `https://api-sapo-reviews.f1genz.dev` |
| `FRONTEND_URL`, `CORS_ALLOWED_ORIGINS` | `https://reviews-sapo.f1genz.dev` |
| `TRUST_PROXY` | `loopback` plus the 22 ranges Cloudflare publishes at `https://www.cloudflare.com/ips-v4` and `/ips-v6` (15 IPv4, 7 IPv6). cloudflared connects from loopback and every Cloudflare edge, Pages Function egress included, is a trusted hop, so `req.ip` is the visitor. Compare with the published lists when Cloudflare announces a change: an unlisted edge range would put all its visitors into one rate-limit bucket |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_KEY_PREFIX` | `127.0.0.1`, `6380`, `sapo-reviews` |
| `R2_WORKER_URL`, `R2_PUBLIC_DOMAIN` | `https://f1genz-sapo-reviews-media.icy-wind-c674.workers.dev`, `images-sapo.f1genz.dev` |
| `SAPO_SCOPE`, `SAPO_INSTALL_CALLBACK_URL`, `SAPO_LOGIN_CALLBACK_URL` | as in the Partner section |
| `SAPO_API_MAX_CONCURRENT`, `REQUEST_BODY_LIMIT`, `WEBHOOK_BODY_LIMIT` | `4`, `1mb`, `256kb` |
| `SESSION_COOKIE_DOMAIN` | unset: host-only cookie on the API host |

Secret keys, set only on the VPS: `SAPO_CLIENT_ID`, `SAPO_CLIENT_SECRET`, `APP_SESSION_SECRET`, `DATA_ENCRYPTION_KEY`, `DATABASE_URL`, `DIRECT_URL`, `REDIS_PASSWORD`, `READINESS_TOKEN`, `R2_UPLOAD_SECRET`. The generated ones (`openssl rand`) were created on the VPS and never left it; the Sapo client id and secret were piped from the operator's local `.env` over ssh. Changing `DATA_ENCRYPTION_KEY` makes every stored Sapo token unreadable, so every merchant must reinstall: treat it as non-rotatable without a re-encryption plan. Changing `APP_SESSION_SECRET` signs every merchant out once.

The server refuses to boot in production when a required key is missing, a secret is a placeholder, or `TRUST_PROXY` is absent (checked against the deployed build: boot stops with the list of problems and nothing listens). After editing `.env`: `pm2 reload f1genz-sapo-api --update-env`, then check `/readyz`.

## Server Deploy (GitHub Actions to the shared VPS)

Repository `F1GENZ/Sapo-Server-Reviews`, workflow `.github/workflows/deploy.yml`, triggers: push to `master` and manual dispatch (the remote only has `master`). Repository secrets: `SSH_PRIVATE_KEY`, `VPS_HOST`, `VPS_USER`, `APP_DIR`, `VPS_KNOWN_HOSTS`. `VPS_USER` is `root` because the PM2 daemon of every app on this VPS runs as root; the deploy key below is what restricts it. `PORT` and `READINESS_TOKEN` are read on the VPS from `.env`; the deploy fails before touching anything if `READINESS_TOKEN` is missing.

**Deploy key.** A dedicated ed25519 key used by nothing else. Its `authorized_keys` entry is `restrict,command="/usr/local/sbin/sapo-reviews-deploy-gate" ssh-ed25519 <public key> gha-sapo-reviews-deploy`: no shell, pty or port forwarding. The gate (`scripts/deploy-gate.sh`, installed verbatim at that path, root-owned) accepts exactly two commands: `rsync --server …`, anchored to `APP_DIR` and write-only (`rrsync -wo`), and `deploy <APP_DIR>`, which runs `scripts/remote-deploy.sh` from that directory. Anything else exits 126.

- Rotate: generate a new key pair, add the new public line with the same options, `gh secret set SSH_PRIVATE_KEY --repo F1GENZ/Sapo-Server-Reviews < <private key file>`, run the workflow, remove the old line, delete the local private key file.
- The gate is not part of the deploy on purpose (a deploy cannot rewrite its own restrictions): after editing `scripts/deploy-gate.sh`, copy it to `/usr/local/sbin/sapo-reviews-deploy-gate` as root and compare the sha256 of both files.
- `VPS_KNOWN_HOSTS` is the output of `ssh-keyscan -H <host>` taken from a trusted machine, with the fingerprints checked against the provider console. The workflow appends it to `~/.ssh/known_hosts` and fails when it is empty; it never runs `ssh-keyscan` itself.

Pipeline:

1. Jobs `verify-server` (`npm run verify`), `verify-client` (client build) and `e2e` (the reusable `.github/workflows/ci-e2e.yml`: server HTTP contract against real PostgreSQL 16 and Redis 7, client build, performance budget, client unit tests, admin journeys and storefront widget in Chromium) run first. The `deploy` job `needs` all three and only runs on `refs/heads/master`. `ci-e2e.yml` also runs on pull requests to `master` or `main`; on pushes to `master` only `deploy.yml` calls it, with its `server-verify` job skipped (`skip-verify`).
2. `deploy` writes `DEPLOY_COMMIT`, loads the key, pins the host key and rsyncs the checkout with `--delete` (excludes `.git*`, `.github/`, `.env`, `client/`, `plans/`, `recipes/`, `node_modules/`, `dist/`, `dist.next/`, `dist.prev/`), then runs `ssh "$VPS_USER@$VPS_HOST" "deploy $APP_DIR"`.
3. `scripts/remote-deploy.sh` on the VPS: `npm ci`, `prisma generate`, snapshot `dist` to `dist.prev` (only when a `dist` exists), `prisma migrate deploy`, build into `dist.next`, swap it in with `mv` (a failed build leaves the live `dist` untouched), `BUILD_SHA=<commit> pm2 startOrReload ecosystem.config.cjs --update-env`, then up to 20 probes (3 s apart) of `http://127.0.0.1:$PORT/readyz` with the bearer token. A probe passes on HTTP 200 with `status` `ok` or `degraded` (`down` means Redis or the database is unreachable) **and** a `build` equal to the deployed commit. A `build` that names another commit is the one exception to the rollback: the job exits with `the PM2 environment still holds another commit` and leaves the running `dist` in place, because the deployed tree is already the right code and only the reported id is stale. Probe failed: `dist` is replaced by `dist.prev`, PM2 reloads it and the job fails. Probe passed: `pm2 save`. `dist.prev` stays after a healthy deploy as the manual rollback target until the next deploy replaces it. The very first deploy had no `dist` to snapshot, so `dist.prev` exists from the second deploy on.

Migrations are not rolled back by a failed probe: they run before the build swap, so write them additive (the previous build must keep working against the new schema) and prefer a forward fix.

Manual equivalent on the VPS, as root, in the same order:

```bash
cd /var/www/haravan/Sapo-Server--Reviews
bash scripts/remote-deploy.sh      # needs DEPLOY_COMMIT in the directory; rsync the sources first
```

`BUILD_SHA` is not stored in `.env`: `ecosystem.config.cjs` forwards the value from the environment the deploy runs in, and the script reads it from `DEPLOY_COMMIT`. It has to be declared in the ecosystem file, because PM2 keeps any variable it started an app with and a `BUILD_SHA` exported only by a later shell survives nothing: the first deploy's commit stayed in `/readyz` for the next three runs until the ecosystem forwarded it, and the probe loop (which now compares `build` with `DEPLOY_COMMIT`) is what catches that class of staleness. In that failure the script leaves the new code running and exits non-zero instead of rolling back a healthy build.

### Baseline an existing database (one time)

Only for a database whose tables were created before `prisma/migrations/` existed: `npm run db:migrate` fails with P3005 or on `CREATE TYPE ... already exists` and every later deploy stays blocked, while the running app is unaffected (`dist.prev` is snapshotted and `set -e` stops before the swap). Once, after confirming the live schema matches `prisma/schema.prisma` (`npx prisma migrate diff --from-url "$DIRECT_URL" --to-schema-datamodel prisma/schema.prisma --exit-code` exits 0):

```bash
npx prisma migrate resolve --applied 202607050000_init
npx prisma migrate resolve --applied 202607051500_active_domain_unique   # only if it was never recorded in _prisma_migrations
```

Then rerun the deploy. Never mark a migration applied whose changes are not already in the database. The production database was created empty and needed none of this.

## Network

- **Tunnel.** `cloudflared` runs as the systemd unit `cloudflared` with `--config /etc/cloudflared/config.yml tunnel run` and serves every `*.f1genz.dev` API of this VPS. This app owns one `ingress` entry above the final `http_status:404` rule:

  ```yaml
  - hostname: api-sapo-reviews.f1genz.dev
    service: http://localhost:3021
  ```

  To change it: copy `config.yml` to a timestamped `.bak`, edit, `cloudflared --config /etc/cloudflared/config.yml tunnel ingress validate`, curl every hostname in the file and note the status codes, `systemctl restart cloudflared` (every hostname on the tunnel drops for a few seconds), curl them all again and compare. Touch only this app's entry.
- **DNS.** `api-sapo-reviews.f1genz.dev` is a proxied CNAME to the tunnel; `reviews-sapo.f1genz.dev` a proxied CNAME to `f1genz-sapo-reviews-admin.pages.dev` (Pages custom domain, active); `images-sapo.f1genz.dev` the R2 custom domain of the media bucket (active).
- **Compression.** The server has no compression middleware; Cloudflare compresses at the edge (Brotli observed on the storefront assets of the API host and on the SPA assets).
- **CORS.** Public routes (`/api/public/*`, `/storefront/*`) answer any origin without credentials because storefronts run on arbitrary shop domains. Admin and auth routes echo CORS headers only for `FRONTEND_URL`, `API_BASE_URL` and `CORS_ALLOWED_ORIGINS`, and those are the only ones that send `Access-Control-Allow-Credentials`; a preflight from any other origin gets 403 and a cross-origin `GET` gets no CORS headers at all, so the browser cannot read the body. Unsafe admin methods (POST/PATCH/PUT/DELETE) additionally require an allowed `Origin` or `Referer`, which is why a scripted admin call without one answers 401.

## Client Deploy (Cloudflare Pages)

No CI deploys the client: Pages takes direct uploads built on the operator's machine, so release it from a commit whose `verify-client` and `e2e` jobs are green.

```bash
npm --prefix client ci
npm --prefix client run build
cd client
CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN_F1GENZ CLOUDFLARE_ACCOUNT_ID=$CLOUDFLARE_ACCOUNT_ID_F1GENZ \
  wrangler pages deploy dist --project-name f1genz-sapo-reviews-admin --branch master
```

wrangler on the operator's machine is logged in to a different Cloudflare account through OAuth and ignores the `_F1GENZ` suffixed variables, so map them as above and check `wrangler whoami` shows account `dc25380a46ad0853b9b0d98ce7a74270` first. `client/wrangler.toml` carries the project name, `pages_build_output_dir = "dist"` and `BACKEND_URL = "https://api-sapo-reviews.f1genz.dev"`.

What ships with the build: `public/_headers` (`Content-Security-Policy: frame-ancestors https://*.mysapo.net` so only Sapo admin can embed the SPA, `X-Content-Type-Options: nosniff`, a restrictive `Permissions-Policy`, immutable caching for `/assets/*`), `public/_routes.json` (only `/api/*` runs the Function) and `functions/api/[[path]].js` (proxies `/api/*` to `BACKEND_URL` and sets `X-Forwarded-Host`).

## Worker Deploy (Cloudflare R2)

```bash
cd worker
npm ci
export CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN_F1GENZ CLOUDFLARE_ACCOUNT_ID=$CLOUDFLARE_ACCOUNT_ID_F1GENZ
npx wrangler whoami                      # must show account dc25380a46ad0853b9b0d98ce7a74270
npx wrangler secret put UPLOAD_SECRET    # interactive prompt; same value as R2_UPLOAD_SECRET on the VPS; never pass it as an argument
npx wrangler deploy
```

`worker/wrangler.toml` pins `account_id`, binds `MEDIA` to the bucket `f1genz-sapo-reviews-media` and sets `CDN_DOMAIN=images-sapo.f1genz.dev`. Redeploy the Worker together with any server release that changes how it is called.

Worker routes (`worker/src/index.js`), all requiring `X-Upload-Token` (constant-time compare against `UPLOAD_SECRET`):

| Route | Purpose |
|---|---|
| `PUT /<key>` | Upload. Key shape `reviews/{storeDomain}/{productId}/{random}.{jpg,png,webp,mp4}`; the extension must match `Content-Type`; `Content-Length` required; 5 MB cap for images and 2 MB for video. Objects are stored with `Cache-Control: public, max-age=300`. |
| `DELETE /<key>` | Delete one object with a valid key. Used when a review or its media is deleted. |
| `GET /list?prefix=&cursor=&limit=` | List objects (default prefix `reviews/`, `limit` 1-1000, default 200) with `key`, upload time and size. Used by the orphan sweep. |

Deleted media leaves the Cloudflare edge within about five minutes (measured on production: a public `GET` still answered 200 right after `DELETE` and 404 after 320 s). A browser that already downloaded an image can keep showing it: the public response carries `Cache-Control: public, max-age=14400`, the zone's browser TTL.

Orphan sweep (`src/ops/durability-sweep.service.ts`): every 5 minutes the sweep lists one page of 200 objects and deletes those uploaded more than 24 hours ago whose URL is not referenced by any `review_products.media` row of that store and product. Objects of a store without an install row are kept. After the last page it rests for 6 hours. It is skipped while `R2_WORKER_URL`, `R2_UPLOAD_SECRET` or `R2_PUBLIC_DOMAIN` is unset. Deleting a review (or removing media from one) deletes the objects immediately and best-effort; the sweep catches what that missed.

## Env Checklist

Every key, default and production requirement is in `docs/env-contract.md` (source: `src/config/env.schema.ts`). Minimum for production:

- `NODE_ENV=production`, `PORT`, `API_BASE_URL`, `FRONTEND_URL`, `CORS_ALLOWED_ORIGINS`, `REQUEST_BODY_LIMIT`, `WEBHOOK_BODY_LIMIT`
- `TRUST_PROXY` (required and explicit; `false` is allowed only when the app is directly exposed, otherwise the verified hop count or proxy CIDR list)
- `SAPO_CLIENT_ID`, `SAPO_CLIENT_SECRET`, `SAPO_SCOPE`, `SAPO_INSTALL_CALLBACK_URL`, `SAPO_LOGIN_CALLBACK_URL`
- `APP_SESSION_SECRET` (at least 32 bytes), `APP_SESSION_TTL_SECONDS`, `SESSION_HANDOFF_TTL_SECONDS`
- `DATABASE_URL`, `DIRECT_URL`, `DATA_ENCRYPTION_KEY` (your own 32-byte key; the public sample key is rejected in every `NODE_ENV`)
- `REDIS_HOST`, `REDIS_PORT`, `REDIS_KEY_PREFIX`, `REDIS_PASSWORD`
- `SAPO_API_MAX_CONCURRENT`, the ingress rate-limit variables and `READINESS_TOKEN`

`SAPO_API_MIN_INTERVAL_MS` was removed; delete it from a `.env` that still has it. Media (not required for boot): `R2_WORKER_URL`, `R2_UPLOAD_SECRET`, `R2_PUBLIC_DOMAIN`: set all three or none; one without the other two stops the boot in every `NODE_ENV`, and a set `R2_UPLOAD_SECRET` must be at least 32 bytes and not a placeholder (it also authorizes Worker list and delete). Without them uploads and media deletion do not work.

## Backups

Nightly logical backup of this database only, on the VPS:

```text
/etc/cron.d/sapo-reviews-db-backup           17 20 * * *  root  (20:17 UTC = 03:17 Asia/Ho_Chi_Minh)
/usr/local/sbin/sapo-reviews-db-backup       copy of scripts/db-backup.sh, root-owned
/var/backups/sapo-reviews/                   mode 700: sapo_reviews_db-<UTC stamp>.dump (mode 600), last-run.status, cron.log
```

`backup` runs `pg_dump --format=custom` into a `.partial` file, validates it with `pg_restore --list`, renames it, writes `OK` or `FAIL` plus the time to `last-run.status` and to syslog (`logger -t sapo-reviews-db-backup`), and only after a verified dump deletes dumps older than 14 days (`SAPO_BACKUP_RETENTION_DAYS`). The script touches only files named `sapo_reviews_db-*` in its own folder. After editing `scripts/db-backup.sh`, copy it to `/usr/local/sbin/sapo-reviews-db-backup` and compare sha256.

Check: `cat /var/backups/sapo-reviews/last-run.status` (starts with `OK`) and `ls -la /var/backups/sapo-reviews`.

Restore test, after every schema change and about monthly: `/usr/local/sbin/sapo-reviews-db-backup restore-test [dump-file]` restores the newest (or the given) dump into a scratch database, compares the table list and the per-table row counts with the live database, and drops the scratch database, also on failure.

Restore after data loss: never overwrite the live database in place. Restore into a new database, check it, then point `DATABASE_URL` and `DIRECT_URL` at it and reload:

```bash
runuser -u postgres -- createdb -O sapo_reviews sapo_reviews_db_restored
runuser -u postgres -- pg_restore --exit-on-error --no-owner --role=sapo_reviews --dbname=sapo_reviews_db_restored < /var/backups/sapo-reviews/<dump>
# check the data, edit DATABASE_URL and DIRECT_URL in .env, then:
pm2 reload f1genz-sapo-api --update-env
```

The restore of a dump into a scratch database with these exact flags was run on production: the 11 tables come back owned by `sapo_reviews` with the same row counts. Measured on the 2026-11-02T05:02:40Z dump: all 11 tables matched the live database and the scratch database was dropped. A dump older than the live rows shows the expected drift (`review_products live=26 restored=0` when the dump predates 26 reviews created after it), which is the point of comparing per-table counts instead of assuming they match. The nightly cron has not fired yet at the time of that run: the dumps in the folder come from manual runs, and the first scheduled one is 20:17 UTC.

## Health Checks

```bash
curl https://api-sapo-reviews.f1genz.dev/livez                                    # {"ok":true}
curl -H "Authorization: Bearer $READINESS_TOKEN" https://api-sapo-reviews.f1genz.dev/readyz
```

`/readyz` answers `status` (`ok`, `degraded`, `down`), `redis`, `db`, `recentFailures`, `webhookRegistration` and `build` (the deployed commit). `READINESS_TOKEN` exists only in the VPS `.env`: read it there, do not paste it elsewhere. The admin SPA's Health page shows the same per store.

## Rollback

- Server, automatic: a failed `/readyz` probe restores `dist.prev` and reloads PM2.
- Server, by hand (only while `dist.prev` exists; it is replaced by the next deploy):

  ```bash
  cd /var/www/haravan/Sapo-Server--Reviews
  rm -rf dist.bad && mv dist dist.bad && mv dist.prev dist
  BUILD_SHA="rolled-back-from-$(cat DEPLOY_COMMIT)" pm2 startOrReload ecosystem.config.cjs --update-env
  pm2 save
  ```

  Then revert the bad commit in git so the next push deploys good code. Migrations are not reversed; if one ran, prefer a forward fix and do not delete lifecycle rows by hand.
- Client: Cloudflare dashboard → Workers & Pages → `f1genz-sapo-reviews-admin` → Deployments → roll back to the previous deployment (or redeploy the previous commit).
- Worker: `wrangler rollback` with the pinned account variables.
- Data: restore from a nightly dump (Backups) only for data loss, never as a code rollback.

## Operations

- Logs: `pm2 logs f1genz-sapo-api --lines 100`; they carry ids and statuses, no review text, email or phone. Restart only this app: `pm2 reload f1genz-sapo-api --update-env`.
- Reboot: the PM2 boot unit, `cloudflared` and PostgreSQL are enabled at boot, the `redis-apps` container restarts unless stopped, and the saved PM2 dump contains `f1genz-sapo-api` (each healthy deploy runs `pm2 save`).
- Uninstall, reinstall and data retention: `docs/lifecycle.md` and `docs/webhook-subscription-uninstall.md`. Reviews, Q&A and catalog rows are kept after uninstall; deleting them for a departed merchant is a manual database operation.
- After the first scheduled backup (20:17 UTC) confirm `last-run.status` shows a new `OK` line.

## Pre-Launch Verification

```bash
npm run verify
npm run test:e2e
npm --prefix client run test:unit
npm --prefix client run build
rg -i "jwks|oidc" src client/src       # zero hits
```

Manual sandbox validation, item by item: `docs/e2e-validation-checklist.md`.
