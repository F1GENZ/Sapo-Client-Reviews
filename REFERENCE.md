# Reference Repository

**Haravan reference app (read-only):**

```
E:/Work/apps/F1GENZ_Review
```

## Rules

- **NEVER edit** the Haravan repo for Sapo work. Read only.
- Use it to look up architecture, wiring, and exact behavior when porting.
- Every phase file cites Haravan reference paths using `file:line` (e.g.,
  `server/src/haravan/haravan.service.ts:891`) — paths are relative to the
  Haravan repo root above.
- Plan lives here: [plans/260707-1318-haravan-to-sapo-migration/plan.md](plans/260707-1318-haravan-to-sapo-migration/plan.md).

## Key Haravan reference files worth bookmarking

Backend:
- `server/src/haravan/haravan.service.ts` (2523 lines) — OAuth/OpenID, HMAC, webhooks, session, subscription, storefront config
- `server/src/haravan/haravan.api.ts` — REST client + throttle/429 retry
- `server/src/haravan/webhook-event-store.service.ts` — platform-neutral event store (port near-verbatim)
- `server/src/haravan/haravan.cron.ts` — periodic token refresh + subscription reconcile
- `server/src/review/review-metafield.service.ts` — reviews chunked metafield sync (D4 cut: `public_summary`-only)
- `server/src/review/review.service.ts` — `acquireLock`/`releaseLock` per-product write lock (F1 must port)
- `server/src/common/{public-cors.ts, guards/shop-auth.guard.ts}` — CORS reflector + session-token guard
- `server/src/main.ts` — real CORS allowlist gate (F17 must port, not just public-cors.ts)
- `server/src/database/database.service.ts` — 11-table schema DDL
- `server/.env.example` — env structure to mirror with `SAPO_*`
- `server/DATABASE.md` — Postgres/Supabase URL resolution order

Frontend:
- `client/src/common/{authFlow.js, AuthStorage.js, AuthService.js}` — auth flow (drop id_token for Sapo)
- `client/src/hooks/useOrgRoute.js` — identity routing (rename to store-domain)
- `client/src/config/AxiosConfig.js` — API client with identity/session token
- `client/functions/api/[[path]].js`, `public/_redirects`, `public/_routes.json` — Cloudflare Pages proxy

Storefront:
- `server/storefront/snippets/f1genz-storefront.{js,css}` — web-component runtime
- `docs/storefront/widget-installation.mdx` — Haravan Liquid injection reference

Docs:
- `docs/haravan/{app-setup,auth-flow}.mdx` — rewrite for Sapo in Phase 19
- `docs/deploy-digitalocean-pm2-cloudflare.md` — deployment reference
- `docs/cloudflare-r2-setup.md` — R2 media pipeline reference

## Grep-friendly quick check

From the Haravan repo root:

```bash
# Find how a Haravan pattern is done
grep -rn "acquireLock\|writeStorefrontConfig\|resolveAccessToken\|verifyHmac" server/src

# Enumerate consumers of HaravanService/HaravanAPIService (for scope check)
grep -rln "HaravanAPIService\|HaravanService" server/src
```
