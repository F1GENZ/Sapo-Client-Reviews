# Port tests: black-box server contract + client journeys + storefront widget

## Results (final run, final tree)

| Suite | Command | Result |
|---|---|---|
| Server HTTP contract | `E2E_ALLOW_MEMORY_STATE=1 npm run test:e2e` (root) | 66/66 pass, ~13 s, state backend in-process memory |
| Admin SPA journeys | `npm --prefix client run test:e2e` (journeys.cjs) | 36/36 pass |
| Storefront widget | same command (storefront-widget.cjs) | 24/24 pass |

Both are run by `client/e2e/run.cjs`, so one red suite does not hide the other.

## Prerequisite: Redis
No Redis (and no Docker/WSL) is reachable on this machine (127.0.0.1:6379 refused). Without it the root suite **fails** with
a message naming the prerequisite (`docker run -p 6379:6379 redis:7`, or `E2E_REDIS_HOST/E2E_REDIS_PORT`).
`E2E_ALLOW_MEMORY_STATE=1` opts in to the server's in-process state fallback and prints a WARNING that Redis is NOT exercised.
The Redis path (rate-limit counters, oauth state, handoff codes in Redis) is therefore unverified locally; CI (`ci-e2e.yml`) runs a redis:7 service so it is exercised there.

## What was built
- `e2e/http-contract.cjs`, `e2e/lib/{infra,http,sapo-stub,sapo-fetch-redirect,util}.cjs`: boots `dist/main.js` on port 4301 against a throwaway
  database `sapo_agent_e2e_*` (created, `prisma migrate deploy`, dropped afterwards; credentials taken from root `.env`, redacted in output),
  a local Sapo Admin API stub (every `*.mysapo.net` fetch is rewritten to the stub by a preloaded module; no real Sapo call).
  Webhook header names are isolated in one constant.
- Checks cover: `/livez` 200, `/readyz` 401 without/with wrong token, header hygiene, malformed/oversized body, CORS; install start/callback incl. invalid and consumed state;
  launch hmac Base64 accepted, hex/tampered/expired/missing rejected; handoff exchange single-use + HttpOnly cookie; Bearer-less mutations rejected, cookie needs a trusted Origin (CSRF),
  cross-store token rejected; public review/Q&A responses never contain email/phone/raw payload; admin create honours status; metafield summary written small (<=160 B) with the store token;
  webhook bad signature rejected, good signature processed, duplicate (serial and concurrent) handled once; `app/uninstalled` revokes only that store; logout; throttling.
- `client/e2e/journeys.cjs` (36): dashboard, reviews list/moderate/reply/delete/filters, Q&A list/answer/status/delete, settings save/persist/error/dirty-guard,
  all auth flows (login, launch URL forwarded byte-for-byte to verify-hmac, handoff, 401 expiry, store isolation), keyboard + a11y names, 375px overflow. API is stubbed at HTTP level and applies the server DTO whitelists (read from `src/**/dto`) so silently dropped keys fail.
- `client/e2e/storefront-widget.cjs` (24): static fixture page loading the real `storefront/snippets/f1genz-storefront.{js,css}`: budgets, reviews/Q&A render, pagination/filter/sort, JSON-LD (Product + aggregateRating + reviews), rating badge, XSS escaping, contact masking, failure modes, submit validation, requireLogin/purchase, 390px layout, `.bwt` snippet dialect check.
- `package.json`: only `test:e2e` added. `client/package.json`: `test:e2e`. `.github/workflows/ci-e2e.yml` (build + budget + both suites, push/PR to master, Postgres+Redis services). `deploy.yml` untouched.
- Also fixed in my files: `client/scripts/check-performance-budget.js` (storefront paths, removed deleted grandservice file), `smoke-routes.cjs` and `tests/auth-storage.contract.test.mjs` aligned to `storeDomain` (4/4 pass).
- No watermark / AI highlights / curated slider assertions (removed from the product).

## Bugs found by these suites (all now fixed by owners, suites green)
1. `src/sapo/webhook.service.ts` `syncCatalogProduct`: `asString(payload.id)` rejected numeric ids (Sapo REST shape), so `products/*` webhooks never refreshed the catalog. Fixed (numeric ids accepted).
2. `src/sapo/sapo.service.ts` / controller: install callback with a code Sapo refuses returned HTTP 500 and leaked context; now 401/400/403/404 pass through, 502 otherwise.
3. `client/src/index.css` `.f1g-bulk-table__row` reserved a 42px checkbox column the markup never renders, crushing review/Q&A rows to 42px. Fixed (display:block).
4. Settings "Duyet & Spam" tab sent keys the DTO whitelist drops (UI said saved, nothing persisted). Fixed: tab only has `blockedWords` + `maxContentLength`; `autoApprove` now honoured server-side.

## Test-side corrections (not app bugs)
- V5: in list rows the saved reply lives in the "Xem chi tiết" modal by design (same in the live app); test now opens it.
- S3: UI shows the server message ("boom") for a failed save; test asserts that.

## Open risks
- Redis path not exercised locally (see above).
- Webhook signature header/secret remain unverified against a real delivery; header names are one constant in the e2e.
- Reply on row cards is only visible in the detail modal (inherited behavior, not changed).

## Hygiene
No server/preview process left running (ports 4301/4302/4311 free); a leftover-database query for `sapo_agent_%` returned none.
