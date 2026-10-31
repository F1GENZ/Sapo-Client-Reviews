# Candidate 4: fixing all 50 findings in one autonomous run

I read the scout report and checked the code behind each decision below. Nothing was run, built, or fetched.

## 1. Technique

**Simplification Cascades.** The 50 findings come from about eight root causes. I fix each root cause once and let the listed S-numbers fall out of it, instead of treating 50 independent patches. Overlap risk is highest in `review.service.ts`, `webhook.service.ts`, `ApiService.js` and `docs/`. I therefore partition by domain, not by finding.

Two facts shape the plan:
- **Repo layout.** There is no `.git` in the working directory. The repo is `.git-nested/`, with local branch `master` and remotes `server` and `client` (GitHub F1GENZ/Sapo-*-Reviews). Both workflows trigger on `master`, not `main`.
- **Gate interplay.** Fixing S-18 (a live `catalog_products` row is required) breaks `e2e/http-contract.cjs`. Its public-submit checks R2, R9 and the flood check POST to product ids 1001–1004 with no catalog rows seeded.

## 2. Root-cause groups and what retires them

| # | Root cause | Single change | Retires |
|---|---|---|---|
| G1 | No server enforcement point for public writes | `ReviewService.submitPublicReview(storeDomain, productId, input)`, plus the same gate in `PublicQnaController` | S-02, S-18, S-19, S-49, and the server half of S-17 and S-03 |
| G2 | SPA/server contract drift | The server grows to the SPA's old Haravan-style contract: dashboard fields, `star`, an array for Q&A per product. The one client-side exception is `ApiService.js` unwrapping `{product}`. | S-07, S-08, S-09, S-10, S-11, S-34, S-35, S-32 |
| G3 | `webhook_events` is a PII sink and the idempotency key is unsound | An ingest projection, `payload` nulled once processed, a TTL sweep, and lifecycle-generation in the key | S-04, S-15, S-31, S-14, and the data half of S-40 |
| G4 | Secrets fail open | One `assertSecret` / `assertEncryptionKey` helper in `src/config/secret-guard.ts`, used by `loadEnv`, `HmacVerifierService`, `SessionService` and `TokenEncryptionService` | S-05, S-06, S-48 |
| G5 | Shopify and Haravan-era residue | Delete it | S-25, S-26 (minus two methods, see D9), S-37, S-38, S-43, S-47, and half of S-41 |
| G6 | `any` casts and banner comments in the same files being changed | Each file's owner strips them, using Prisma types | S-27 |
| G7 | Infra robustness | A Lua `INCR`+`EXPIRE`, memory-limiter eviction, per-type Worker limits, a sanitized upload name | S-16, S-20, S-21, S-22 |
| G8 | Docs, CI and tests lag the code | One docs, CI and tests pass after the code settles | S-41, S-42, S-44 |

Smaller single changes that retire several findings:
- `client/src/common/storeUrl.js` with `buildProductUrl` retires S-12, from three call sites.
- A shared `UNREPLIED_WHERE` and an `AND`-composed search retire both the S-09 unreplied count and S-11. The constant moves from `review.service.ts` into a new `src/review/review-where.ts`, because the store would otherwise import from the service.
- `WebhookRegistrationService.registerForInstall` reused by ops resync fixes S-29's status and URL problems together.

## 3. Decisions

**D1 — Server-side gates (S-02).**
- **Identity.** The trusted identity is the `email`/`phone` in the POST body, matched against the purchase mirror. Sapo gives no signed customer assertion, so `verified` means "this contact matches a paid or fulfilled, non-cancelled order line for this product". The Haravan reference has the same trust level.
- **Order of checks.** `submitPublicReview` runs in this order:
  1. Resolve the serving install.
  2. Require a live `catalog_products` row. If missing, return 404 with no Sapo call, so bogus ids burn no API budget.
  3. Read the widget config.
  4. Enforce `formEmailMode`, `formPhoneMode`, `formTitleMode` and `formContentMode`: hidden fields are dropped, required fields are checked.
  5. Compute `verified` from `purchaseStore.hasPurchasedProduct`.
  6. If `requirePurchaseToReview`:
     - no identity → 400 `identity_required`;
     - no purchase match → 403 `purchase_required`.
  7. If `requireLogin`, require a non-empty identity. This is a stated limit: it is a UI gate that the server cannot authenticate.
  8. Create the review. Resolve the Sapo token only after validation passes.
- **Q&A.** `public-qna.controller` returns 403 when `allowQnA === false`, read via `ReviewService.getPublicWidgetConfig` (signature frozen). `qna.module.ts` imports `ReviewModule`. The slice owner must check there is no cycle and use `forwardRef` if there is.
- **Metafield sync.** Sync only when the new status is `approved`.
- **Media allowlist (S-19).** URLs must be under `https://${R2_PUBLIC_DOMAIN}/reviews/${storeDomain}/`, or be YouTube or Vimeo for `type:'video'`. The widget already accepts those two hosts. Uploads get an MP4 `ftyp` brand check.

**D2 — Eligibility oracle and hashes (S-03).**
- **Oracle.** The endpoint stays, because the widget needs it. It gets `assertPublicRate`, plus a per-identity bucket keyed `store|product|hash(identity)` at 5 per hour through `IngressRateLimitService`, so no raw identity reaches Redis. Unknown and non-serving stores answer a uniform 200 `{eligible:false}`.
- **Hashing.** Hashing changes to HMAC-SHA256. The key is HKDF-derived from `DATA_ENCRYPTION_KEY` with the label `purchase-identity-v1`, so there is no new env var.
- **Existing rows.** They cannot be re-hashed because the raw identity is gone. A migration adds `customer_purchases.hash_version Int @default(1)`. `hasPurchasedProduct` reads both the v1 sha256 and the v2 HMAC (dual-read). Any `orders/*` redelivery rewrites the row as v2.
- **Residual.** Legacy hashes stay offline-brute-forceable until their orders are redelivered. Document this.

**D3 — Raw order PII in `webhook_events` (S-04): do both, plus retention.**
- **Projection at ingest.** For `orders/*`, `PurchaseStoreService.toStoredOrder()` writes a PII-free projection as `payload`. It holds `id`, `order_number`, `name`, statuses, timestamps, `line_items:[{product_id}]`, and `email_hash`/`phone_hash` (v2). `normalizeOrder` accepts the projected `email_hash`/`phone_hash`. Retries then still work, because `retryDueFailed` replays from the stored payload.
- **Nulling.** `payload` is nulled when the status becomes `processed` or `ignored`.
- **TTL sweep.** A new `DurabilitySweepService` step deletes processed or ignored rows older than 30 days and failed-exhausted rows older than 90 days. These are code constants, so no env change touches `env.schema.ts`.
- **Uninstall.** It nulls `payload` and `headers` for that store's events.
- **Retention purge.** A sweep step deletes reviews, Q&A, purchases, catalog rows and pending-metafield rows for installs that are `status='uninstalled'` and have `uninstalledAt` older than 90 days. The slice owner must first confirm that reinstall clears `uninstalledAt`.

**D4 — Secrets (S-05, S-06).**
- **`loadEnv`.** In every `NODE_ENV` it requires `SAPO_CLIENT_SECRET` and `APP_SESSION_SECRET`: non-empty, not a placeholder, and the session secret at least 32 bytes. It rejects `DATA_ENCRYPTION_KEY` if it is a placeholder, not 32 bytes, or the public sample (`0123456789abcdef…`).
- **Constructors.** The constructors of `HmacVerifierService` and `SessionService` also call the guard. This covers hand-built env objects, such as in `security.test.ts`.
- **`.env.example`.** The three values become `replace-with-…`, and the file shows the key-generation command.
- **Test impact.** Tests and e2e already use realistic secrets, so they stay green. The e2e `SECRETS.*` lengths must be confirmed.
- **Live check.** The live `.env` does not contain the sample key (grep: no match).

**D5 — Contract drift (S-07..S-11, S-35).** The principle is that the server conforms to the SPA where the SPA's shape is the long-standing one, and the client conforms in one case.
- **Dashboard.** `getOverview` adds three fields:
  - `reviewTrend: [{date:'YYYY-MM-DD', count}]` for 14 days. Use a `$queryRaw` group-by in `Asia/Ho_Chi_Minh`, which matches `buildTrend`'s local-date logic.
  - `attentionProducts: [{productId,title,image,reviewAvg,reviewCount,qnaUnanswered,reason}]`, where `reason` is `low_rating`, `unanswered_qna` or `mixed`.
  - `productStats: [{productId,title,image,reviewCount,avgRating,qnaTotal,qnaUnanswered}]`, built from review and Q&A `groupBy` plus a catalog title/image lookup.
  - The dashboard service does its own Prisma `groupBy` calls, so it does not depend on another slice's new methods.
- **Unreplied.** `unreplied` becomes real: `getStatsForShop` counts with `UNREPLIED_WHERE`, and the dead `trend`/`recentReviews` placeholders are deleted.
- **Q&A per product.** `GET admin/qna/:productId` returns a plain `Question[]`, like reviews. It uses chunked loading, so all rows come back. This fixes S-07 and S-34 with no client change.
- **Star filter.** `GET admin/reviews` accepts `star` (1–5) and applies `where.rating`.
- **Unreplied with search.** The search is composed as `AND:[{OR:unreplied},{OR:search}]`.
- **Client.** `ApiService.fetchProduct` returns `.data.data.product`. `fetchReviewSummary` uses `summary.count`.
- **Stubs.** `client/e2e/journeys.cjs` stubs get the real shapes. They add a per-product Q&A array route, `{product}` for the product route, and the new dashboard fields.
- **Contract test.** Add a server test that the dashboard payload carries every key the SPA reads. That list is derived from the client greps (`statusCounts.unreplied`, `reviewTrend`, `attentionProducts`, `productStats`, `rankedProducts`).
- **Degraded sections.** Dashboard sections that fail return a `degraded: string[]` field plus a log line (see S-28 below). The SPA shows a warning.

**D6 — URLs (S-12, S-37).**
- **Admin links.** `buildProductUrl(storeDomain, alias)` returns `https://${domain}/${alias}`. It replaces the three `/products/${handle}` sites. The DB field named `handle` keeps holding the alias.
- **Storefront.** Delete `/products/${handle}.js`, `extractProductHandle`, `window.__st` and the `/products/` regexes. Use `product-id` plus og metadata.

**D7 — Catalog and order mirror (S-13, S-14, S-31).**
- **Catalog revival.** In `upsertProducts`, when `prev.deletedAt != null` and the row is a live Sapo-sourced row (`source==='sapo'`, `deletedAt===null`), skip the monotonic guard and write `deletedAt:null`.
- **Stale-write protection.** Tombstones keep `updatedAt=now`, so a stale webhook-sourced row cannot undo a deletion.
- **Order guard.** A migration adds `customer_purchases.source_updated_at BigInt?`. The update applies only when the incoming order `updated_at` (or `updated_on`) is at least the stored value.
- **Dropped line items.** In the same `$transaction`, rows for `(shop, orderId)` whose `productId` is not in the new set are deleted.
- **Field names.** Field names are still unproven. `normalizeOrder` accepts both `*_at` and `*_on` for created, cancelled, updated, closed and refunded, and `customer.email` or `billing_address` identity. Add tests with a real-shaped payload.
- **Backfill.** There is no order backfill. Delete `getOrders`. `read_orders` stays, justified by the `orders/*` webhook subscriptions. The dossier says the mirror covers orders from install forward.

**D8 — Dead code and `any` (S-25..S-27).**
- **Delete.**
  - the `app/charge` branch, `CHARGE_TOPICS`, and all of `subscription.service.ts` (its provider is removed from `sapo.module.ts`);
  - `runBackground`, `deleteProductMetafield`, `deleteMetafield`, `getOrders`;
  - `verifyChallenge`, `handleProductWebhook`, `webhookReceiverUrl`, `myshopify_domain`;
  - the plan tag in `AdminLayout` and the trial/cancelled labels on the ops page.
- **Keep.** `getWebhooks` and `deleteWebhook` stay, because D9 reconciliation needs them. S-26 and S-29 would otherwise collide.
- **Schema stays.** The `SubscriptionSnapshot` model and the `trial/canceled/expired` enum values stay in `schema.prisma`. Dropping them breaks the user's additive-only migration constraint and Postgres cannot drop enum values without a rewrite.
- **`any` cleanup.** `PrismaService extends PrismaClient`, so `this.db: any` becomes `this.prisma`. JSON columns use `Prisma.InputJsonValue` and `Prisma.DbNull`, and `Prisma.AppInstallUpdateInput` replaces `as any`. Each slice cleans only the files it owns, in the same pass as its functional edit. The controller gates at the end with `rg -n ': any\b|as any\b|<any>|any\[\]' src` and a banner-comment regex, both required empty. The S-01 fix, `media: undefined | Prisma.DbNull | value`, lives in `review-product-store.service.ts`.

**D9 — Webhooks (S-15, S-29, S-30, S-50).**
- **Event id.** Read `x-sapo-event-id` when it is non-empty (`getHeader` already ignores empty). Drop `x-request-id`.
- **Lifecycle key.** For `app/*` and `store/*` topics the idempotency key includes `install.lifecycleGeneration`. A repeat identical uninstall after a reinstall then runs. This needs no change to the install flow.
- **Identity.** Cross-check any payload product or order id against the claimed store. Fix the docs: the unsigned header is a hint, not authority.
- **Registration.** `registerForInstall` uses `this.env` and `webhookReceiverUrl()` (so no `//api`) and persists status.
- **`createWebhook`.** On 409 or 422 it confirms via `getWebhooks` that the topic and address exist, otherwise it throws.
- **Ops resync.** `ops.resyncWebhooks` calls `registerForInstall`. `getWebhookSummary` uses `groupBy status`. The ops page counts `processed`, not `delivered`.
- **Stale addresses.** A reconcile step deletes subscriptions whose address differs from the current URL.
- **Lifecycle (S-50).**
  - `store/update` maps newly seen domains.
  - Product, order and update webhooks for an `uninstalled` install are marked `ignored` with no retry. Revoked `needs_reinstall` stores still retry.
  - The `as never` cast in `sapo.controller.ts` is removed.
  - The JWT carries `lifecycleGeneration`. `ShopAuthGuard` rejects a mismatch. Old tokens without the field are rejected, which forces one re-login after deploy.

**D10 — Media, Worker, limiter (S-16, S-19..S-23).**
- **Filename (S-16).** Use a server-derived name. At ticket creation and at verify, both sides apply the same NFC-normalize and `[^a-zA-Z0-9._-]→_` function, then compare the sanitized forms.
- **Worker limits (S-20).** The Worker enforces 5 MB for images and 2 MB for video, by content type.
- **Constant-time compare.** The Worker uses one for the upload token.
- **Secrets (S-21).** The ticket HMAC key is derived from `R2_UPLOAD_SECRET` with a context label, so it differs from the Worker token. No Cloudflare secret rotation is needed.
- **Deletion.** The Worker gets `DELETE` and a secret-protected `GET list`. `MediaService.deleteByUrls(urls)` is best-effort and never throws.
- **Orphan sweep.** Delete unreferenced objects older than 24 hours, 200 per run, with a Redis cursor.
- **Rate limiter (S-22).** `RedisService.incr` becomes a Lua `INCR` that sets `EXPIRE` when the TTL is missing. On a Redis error the limiter falls back to the memory bucket, with expired-bucket eviction and a cap of 50k entries. It does not return a 500.
- **Read amplification (S-23).** Q&A gets `PUBLIC_MAX_OFFSET`. `getPublicSummaries` validates ids as numeric (reusing `NumericIdPipe` logic) and uses one `groupBy productId IN (...), rating` through `calculatePublicSummaries`.

**D11 — Client (S-17, S-38, S-45, S-46).**
- **Identity (S-17).** The widget reads identity only from the `customer-email` and `customer-phone` attributes, which the dev-page snippets already inject. Delete the `/account` HTML scrape.
- **Legacy host (S-38).** Remove `LEGACY_FALLBACK_API_URL`. A missing API URL gives one `console.error` and no requests. Fix the warning text. `DEFAULT_CONFIG` stays as the render fallback, since the repo forbids hardcoded fallbacks only for storefront data. A parity test checks its keys against the server's `DEFAULT_WIDGET_CONFIG`.
- **Dev gate (S-45).** Delete `DevGate.js` and the `dev=` menu logic. The Dev and Ops pages become normal authenticated routes with menu entries. Ops actions only touch the caller's own store.
- **Backfill (S-45).** `POST backfill-catalog` gets a rate limit and a Redis lock, in `ops.controller` and `ops.service`.
- **Cookie (S-46).** Drop the JS-readable cookie from `AuthStorage.js`. The Bearer token stays in `localStorage` (documented). Wire `client/tests/auth-storage.contract.test.mjs` into `client/package.json` and CI.

**D12 — Docs, CI, repo (S-41..S-44, S-47, S-48).**
- **CI.** Deploy needs `verify-server`, `verify-client`, and the e2e jobs (extract e2e into a reusable workflow, or merge the jobs). PRs run `npm run verify`.
- **Deploy order.** Snapshot `dist.prev` before migrate. Build to `dist.next` and swap with `mv`. `pm2 save` moves after the probe. The probe hits `/readyz` (it needs `READINESS_TOKEN` handling, so check `health.controller` first).
- **Engines.** `package.json` gets `engines.node >=20.6`.
- **Scripts.** Delete the three stale `scripts/*.mjs` and the stale `client/scripts/smoke-routes.cjs`.
- **Repo hygiene (S-47).** Edit these:
  - `client/README.md`;
  - `_redirects`;
  - the vite `/admin` proxy;
  - the empty `grandservice/` directory;
  - `.gitignore` (add `.antigravity/`);
  - `REFERENCE.md`;
  - `.env.example` (`R2_PUBLIC_DOMAIN` becomes a placeholder);
  - a root `README.md`;
  - `env-contract.md` (`WEBHOOK_RATE_LIMIT_*` is required but unread, so remove it from the required list or wire it into the webhook route).
- **TRUST_PROXY (S-48).** Add it to `requireRawProduction`, and fix `deploy-sapo.md:93`.
- **Branches.** `ci-e2e.yml` adds `main`. `deploy.yml` keeps `master` only, so a push to `main` never auto-deploys to the VPS.
- **Docs.**
  - **Dossier:** 97 → the final count, `getOrders` removed, `webhook_events` in the data table.
  - **e2e checklist:** the `f1genz_reviews` namespace and de-duplicated IDs.
  - **Webhook doc:** header status.
  - **Security checklist:** webhook identity, uninstall retention, and the 30/90-day periods.
- **Tests (S-44).** Remove the four `@ts-nocheck` headers and type the fake Prisma as `as unknown as PrismaService`.

## 4. Execution plan

Recommended concurrency: **5 agents per wave, at most 6.**

**Wave 0 — controller only, before any code change:**
1. **Capture live evidence.** Run read-only SQL on the live throwaway DB, before D3 nulls payloads. For `webhook_events` with `normalized_topic like 'orders/%'`, list JSON key names only (no values) to settle S-14 field names. Check `provider_event_id` and the stored headers to settle S-15.
2. **Snapshot the DB.** Take a `pg_dump` of the live throwaway DB.
3. **Resolve the git target.** `git --git-dir=.git-nested --work-tree=. ls-remote --heads server`. Push to the remote's default branch (`main` if it exists, else `master`). Never create a new branch.
4. **Write the frozen contract.** Write `plans/reports/fix-contract.md` with the shared signatures and error codes:
   - `hasPurchasedProduct(shopId, productId, {email,phone}): Promise<boolean>`;
   - `getPublicWidgetConfig`;
   - `registerForInstall`;
   - `createSessionToken(storeDomain, lifecycleGeneration)`;
   - `MediaService.deleteByUrls(urls)`;
   - the `getStatsForShop` shape;
   - the admin response shapes from D5;
   - the gate codes 400 `identity_required` and 403 `purchase_required`.

**Wave 1 — five agents, disjoint files.** Each agent adds only NEW `test/<slice>.test.ts` files. Each writes `plans/reports/wave1-<slice>-test-impact.md`, listing existing tests and e2e assertions that its change will break.

| Slice | Owns exactly | Findings |
|---|---|---|
| **S1 Review** | `src/review/**` (including new `review-where.ts`, `dto/*`, `interfaces/*`, `review.module.ts`) | S-01, 02, 03 (endpoint rate limit), 10, 11, 18, 19 (URL allowlist), 23 (summaries), 24, 27, 32, 33, 35, 49 |
| **S2 Q&A, catalog, dashboard, ops, health** | `src/qna/**`, `src/catalog/**`, `src/dashboard/**`, `src/ops/ops.service.ts`, `ops.controller.ts`, `ops.module.ts`, `src/health/**`, `src/database/metafield-sync-pending.service.ts` | S-02 (Q&A half), 07, 09, 13, 23 (Q&A), 24, 26 (catalog-sync), 27, 28, 29 (ops half), 32, 34, 36, 45 (server) |
| **S3 Privacy, webhooks, purchase, schema** | `src/sapo/webhook.service.ts`, `webhook-topic-normalizer.ts`, `subscription.service.ts` (delete), `uninstall.service.ts`, `webhook-registration.service.ts`, `sapo-api.service.ts`, `sapo.types.ts`, `sapo.module.ts`, `src/purchase/**`, `src/ops/durability-sweep.service.ts`, `prisma/**` (schema plus the new migration) | S-03 (hashing), 04, 14, 15, 25, 26, 27, 29 (reg), 30, 31, 40, 50 (webhook half) |
| **S4 Config, auth, secrets** | `src/config/**` (including new `secret-guard.ts`), `.env.example`, `src/main.ts`, `src/app.module.ts`, `src/sapo/hmac-verifier.service.ts`, `session.service.ts`, `sapo.controller.ts`, `sapo.service.ts`, `token-encryption.service.ts`, `oauth-state.service.ts`, `shop-domain.service.ts`, `lifecycle-lock.service.ts`, `src/common/guards/**`, `src/common/trust-proxy.ts` | S-05, 06, 27, 28 (config-write log), 48, 50 (JWT) |
| **S5 Media, Worker, infra, SPA** | `src/media/**`, `worker/**`, `src/redis/**`, `src/common/security/**`, `src/common/pipes/**`, all of `client/src/**`, `client/e2e/journeys.cjs`, `client/e2e/lib/**`, `client/scripts/**`, `client/tests/**`, `client/package.json`, `client/README.md`, `client/public/**`, `client/vite.config.js` | S-07/08/10/35 (client), 12, 16, 19 (ftyp), 20, 21 (secrets/Worker), 22, 25 (UI), 29 (UI), 44 (client), 45, 46, 47 (client) |

S5 puts the SPA and media/infra together, so that is 5 agents. The SPA could be split from S5 as a sixth agent. If so, assign `client/**` to it and keep media, Worker, redis and security in S5.

Migration, in the single `prisma/migrations/202610310000_privacy_retention_integrity/migration.sql` owned by S3 and additive only:
- `ALTER TABLE customer_purchases ADD COLUMN hash_version INT NOT NULL DEFAULT 1`;
- `ALTER TABLE customer_purchases ADD COLUMN source_updated_at BIGINT`;
- `CREATE INDEX ... ON webhook_events (status, processed_at)` for the TTL sweep.

**Gate after wave 1 (controller):** `npx prisma generate`, then `npm run lint`. `npm test`, e2e and client e2e are expected red here, listed in the impact notes.

**Wave 2 — four agents:**

| Slice | Owns | Findings |
|---|---|---|
| **F Storefront** | `storefront/**`, `src/storefront/**`, `client/e2e/storefront-widget.cjs`, `client/e2e/fixtures/index.html` | S-17, 19 (`nofollow ugc`), 33 (dead `emailDisplay`/`phoneDisplay`), 37, 38, 39 |
| **H Server tests** | `test/**`, `e2e/**` | S-14 tests, 44; seeds `catalog_products` for 1001–1004; updates assertions for D1–D9; the e2e count may grow beyond 66 |
| **I Docs, CI, repo** | `docs/**`, `.github/**`, `package.json`, `scripts/**` (delete), `REFERENCE.md`, `.gitignore`, root `README.md` | S-41, 42, 43, 47 (root) |
| **J Media deletion** | `src/review/review.service.ts` (`deleteReview` wiring), `review.module.ts`, `src/media/media.service.ts`, `media.module.ts`, `durability-sweep.service.ts` (orphan sweep and retention-purge calls), `worker/src/index.js` (`DELETE`, `list`) | S-21 deletion and orphan sweep |

J touches files that wave 1 already finished. H must not edit J's files, and I must not edit `package.json` outside `engines` and scripts.

**Gate after wave 2:** full `npm run verify`, then `E2E_ALLOW_MEMORY_STATE=1 npm run test:e2e` on a throwaway DB, then `npm --prefix client run build` and `npm --prefix client run test:e2e`.

**Wave 3 — fixes only.** Route each failing gate to the owning slice agent with the exact error, at most 2 at a time. Then run the `rg` banner and `any` gates.

**Controller alone, never delegated:**
- Wave 0 DB reads, the `pg_dump`, and the git-target resolution.
- Every gate command.
- The migration apply on the live DB, the live `.env` preflight, and the live PM2 restart.
- Any edit to the live `.env`.
- The commit and push.
- Resolving conflicts in shared files.

## 5. Risks and residual unknowns

- **Live `.env` preflight.** After wave 1, dry-run `loadEnv` on the live `.env` before restarting. Check these keys:
  - `SAPO_CLIENT_SECRET` is non-empty and not a placeholder.
  - `APP_SESSION_SECRET` is at least 32 bytes.
  - `TRUST_PROXY` is present. If it is absent, S-48 stops the boot. Add it only after confirming the proxy hop count. With a Cloudflare tunnel that is probably `1`, but I could not confirm it.
- **Forced re-login.** JWT binding to `lifecycleGeneration` invalidates the merchant's current session once.
- **Review submits could break.** The catalog-existence rule (S-18) rejects submits for products not yet in `catalog_products`. Check that install triggers `backfillStore`. If a store has never backfilled, run backfill before testing live.
- **Retention purge is destructive.** It acts only on `status='uninstalled'` and `uninstalledAt` older than 90 days, so it cannot touch the live active install.
- **Payload nulling is irreversible.** That is why Wave 0 captures the key names first.
- **Deploy risk.** If the push target is `master`, `deploy.yml` fires and runs `prisma migrate deploy` on the production DB. After the S-42 fixes the gate requires e2e. The new migration is additive.
- **Rollback.**
  - DB: new columns are ignored by old code, and the `pg_dump` is the restore point.
  - Code: `git revert`, then the PM2 `dist.prev` swap.
  - Env: restore the previous `.env`.
- **Not provable overnight (SUSPECTED):**
  - Real Sapo order field names (`*_on`). The code accepts both until the live DB evidence settles it.
  - Whether Sapo keeps app metafields after uninstall.
  - `.bwt` filter and JSON-escape behaviour.
  - `public_summary` metafield size limit.
  - Whether `x-sapo-event-id` is ever non-empty.

## 6. Out of scope or documentation-only

| Item | Reason |
|---|---|
| S-14 backfill of pre-install orders | Not needed with `orders/*` webhooks. The mirror is documented as install-forward. Field names settle via Wave 0 or dual-name acceptance. |
| S-36 `public_summary` size budget | Needs a live Sapo measurement. Document the unmeasured limit. |
| S-39 `.bwt` render and JSON-safe escape | Needs a real theme render. Remove unsupported filters, document the scalar metafields, and require a real-theme test. |
| S-40 metafield cleanup after uninstall | The token is revoked at webhook time, so the app cannot delete its own metafields. Document the merchant removal step. |
| S-42 `ssh-keyscan` host-key pinning | Needs the VPS host key, which only the operator has. Document a `VPS_KNOWN_HOSTS` secret. |
| Dropping `SubscriptionSnapshot` and enum values | Breaks the user's additive-only constraint. The code is removed and the schema is documented as unused. |
| JWT in `localStorage` | Needs a session redesign, with HttpOnly cookie and CSRF handling, beyond these findings. Document the exposure. |
| S-48 live `TRUST_PROXY` value | Needs the live hop count. Enforce explicit setting in production and verify in Wave 0 or the preflight. |

Status: DONE_WITH_CONCERNS

Summary: A cascade of eight root-cause fixes retires all 50 findings. Wave 0 handles evidence and git, wave 1 runs five domain slices, wave 2 runs four slices, and wave 3 handles fixes. Open concerns are the missing `.git` (the repo is `.git-nested` with branch `master`), a live-`.env` preflight, and the SUSPECTED items that only live Sapo data can settle.