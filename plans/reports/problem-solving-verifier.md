## Scores

| Cand | Fit | Depth | Actionability | Honesty/accuracy | Total | Note |
|---|---|---|---|---|---|---|
| A | 17 | 19 | 14 | 12 | **62** | Deepest and most complete (`media_objects`, JWT `gen`, retention, `store/update`). Several factual errors, listed below. |
| B | 18 | 18 | 14 | 14 | **64** | Collision-zone framing is the best fit for an overnight run. Wave 1 owners have no `test/` files, but the Wave 1 gate runs `npm run verify`. |
| C | 17 | 18 | 15 | 13 | **63** | Crisp cascades, additive-only migration, most items implemented. Wrong repo-layout facts. |
| D | 17 | 18 | 17 | 17 | **69** | Correct repo facts, the only candidate that catches the S-18 vs e2e seed conflict, honest Wave 1 gate. Fixable flaws are in Amendments. |
| E | 17 | 17 | 16 | 16 | **66** | Verified live-`.env` facts, no migration, right call on `loadEnv` vs tests. Several cuts are effort-based. |

Factual errors found:

- **A**
  - Its SQL names `subscription_snapshots` and `app_installs`. The tables are `"SubscriptionSnapshot"` and `"AppInstall"`, with no `@@map` in `prisma/schema.prisma:59,115`, so the migration would fail.
  - It says the workflow target is `main` and changes the triggers to `main`. Both workflows trigger on `master`.
  - It refuses to make `TRUST_PROXY` a production requirement without reading `.env`. The key is already set there (`TRUST_PROXY=false`).
  - Its `loadEnv` non-empty rule breaks existing tests (see Amendment 2).
- **B**
  - It says "push to `main`".
  - Its migration purges payloads and flips in-flight order events to `ignored`. That is destructive, against the additive-only constraint C and D cite.
  - It deletes `deleteWebhook`, so S-29's stale-address replacement is lost.
- **C**
  - It says the dir "may not be a git repo". It is `.git-nested/`, HEAD `refs/heads/master`.
  - It says "push to `main`".
  - It builds a purchase backfill on the unverified Sapo order shape.
- **D**
  - Its index SQL uses `webhook_events (status, processed_at)`. The table is `"WebhookEvent"` with column `processedAt`, and `@@index([status, updatedAt])` already exists.
  - Its S-16 sanitize-both-sides fix is flawed (Amendment 3).
  - It drops `compression` (S-42) without listing it as documentation-only.
- **E**
  - It says every production-only check is bypassed on the live backend because `.env` says `NODE_ENV=development`. `ecosystem.config.cjs:20` forces `NODE_ENV=production` under PM2.
  - S-50 JWT binding and `store/update` are cut because they force re-login or are "unsafe". Those are effort and risk reasons, not impossibility.
  - It never notices the S-18 vs e2e conflict.
  - The media ticket tests in `test/security.test.ts` are owned by slice A, while the media code is owned by D2.

## Winner

**D**, unchanged.

- **Repo facts:** it is the only candidate with all of them right: `.git-nested`, branch `master`, both workflows on `master`, remotes `server` and `client`.
- **S-18 conflict:** it is the only one to catch it. `e2e/http-contract.cjs` R2 (:570), R9 (:669), R15 (:764, product 1004) and the flood check (:1008) POST to products 1001–1004, and no `catalogProduct` rows are seeded for them.
- **S-14 evidence:** its Wave 0 captures live `webhook_events` key names before payloads are nulled.
- **Wave 1 gate:** lint only, with per-slice test-impact notes, instead of a gate that is red by design.

## Amendments

1. **Git, branch and deploy (VERIFIED).**
   - Drive git with `--git-dir=.git-nested --work-tree=.`.
   - The branch is `master`. `refs/remotes/server/master` is the only remote-tracking ref. `FETCH_HEAD` shows `master` of `Sapo-Client-Reviews`.
   - `deploy.yml` and `ci-e2e.yml` both trigger on `master`.
   - A push to `master` therefore runs `prisma migrate deploy` and a PM2 restart on the VPS. Push only after Wave 3 gates pass, and only if the push is intended.
   - Do not change workflow triggers to `main` (A). Do not push to `main` (A, B, C).
   - `.git-nested/subtree-cache` exists. INFERENCE: the `client` remote may be fed by `git subtree`, so check before pushing.

2. **D4 `loadEnv` rule breaks tests (VERIFIED).**
   - Existing tests call `loadEnv({})` (`test/lifecycle.test.ts:543`) and `loadEnv({NODE_ENV:'test'…})` (`test/security.test.ts:100-104`). A non-empty rule in every `NODE_ENV` would throw.
   - Keep `requireProduction` for empty secrets.
   - In every environment, reject only a set value that is a placeholder, the sample key (`MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=` and its hex form), or a wrong-length key.
   - Put the empty/placeholder guard in the `HmacVerifierService` and `SessionService` constructors. This is safe: `test/lifecycle.test.ts` `makeEnv` has real secrets, and `test/security.test.ts` builds only `SessionService`.

3. **S-16 fix (INFERENCE).**
   - D's NFC-plus-`[^a-zA-Z0-9._-]→_` on both sides can mismatch. The scout evidence (S-16) says busboy hands over a latin1-parsed name. One non-ASCII character becomes several `_` on verify but one `_` at ticket creation.
   - Use the A/B/C/E approach instead: remove `filename` from the ticket and from the match, and have the server name the object from the sniffed type.
   - Change the ticket pipe to `whitelist` only, so old cached widgets still work.

4. **Migration SQL (VERIFIED).**
   - Drop D's `webhook_events(status, processed_at)` index. Table `"WebhookEvent"`, column `processedAt`, and `[status, updatedAt]` already serves the sweep.
   - Generate SQL with `prisma migrate diff` or `--create-only` against a throwaway DB. Never run `migrate dev` on the `.env` DB.
   - Keep it additive-only: `customer_purchases.hash_version` and `source_updated_at` are fine.

5. **JWT binding seam (VERIFIED callers).**
   - `resolveAccessToken(storeDomain): Promise<string>` is called from `shop-auth.guard.ts:86`, `public-media.guard.ts:54`, `durability-sweep.service.ts:65`, `ops.service.ts:93,107,122`, `public-review.controller.ts:188` and `webhook.service.ts:451`.
   - Do not change its return type. The guard should read the generation or `tokenVersion` through a new method.
   - Put the `createSessionToken(storeDomain, generation)` signature in the frozen contract.

6. **Test ownership gaps (VERIFIED).**
   - `test/security.test.ts:441-498` signs tickets with the raw `R2_UPLOAD_SECRET` and asserts `filename`. Amendments 3 and 5 change both, so the wave 2 test agent H must own that rewrite.
   - Deleting DevGate breaks journey N5 (`client/e2e/journeys.cjs:439-444`, "ops hidden … without the dev gate"). S5 must rewrite it, or use B's `VITE_OPS_PAGE` flag.
   - D's S5 slice is overloaded (media, redis, security and the whole SPA). Split the SPA into its own agent, which makes six.

7. **Shared constants in Wave 0 (INFERENCE).** The controller creates `src/common/security/public-limits.ts` (`PUBLIC_MAX_OFFSET`, numeric-id and email/phone regexes) before Wave 1. S1 (review) and S2 (qna) both need it, and `PUBLIC_MAX_OFFSET` currently lives in `review.service.ts:41`.

8. **S-07/S-34 contract (INFERENCE).** D returns a plain array and loads every row, which is unbounded per request. Keep the server's `{items,total,page,pageSize}` with paging and fix the SPA (`fetchQuestions`, `.items`). A, B and E choose this; D's chunked all-rows is the weaker option.

9. **Serving check before config (VERIFIED).**
   - `getPublicWidgetConfig` returns `DEFAULT_WIDGET_CONFIG` for a non-serving store (`review.service.ts:968-971`).
   - Both review submit and Q&A submit must assert a serving install first (B's `getServingWidgetConfig` idea). Otherwise gates default to off, for example `allowQnA` true.

10. **S-03 hardening (INFERENCE).**
    - Key the identity bucket as `store|hmac(identity)` with no `productId`. Keying by product multiplies the budget per product.
    - Return `{eligible:true,reason:'not_required'}` when `requirePurchaseToReview` is off. The widget only calls the endpoint when the gate is on (`storefront.js:1693,1756`).
    - Strip `verified` from the public submit response, or share the identity bucket with it. Otherwise submit is a second oracle.

11. **Retention scope (INFERENCE).**
    - Limit automatic post-uninstall purge to PII-bearing derived data: `customer_purchases`, `webhook_events` payloads, R2 objects.
    - Do not auto-delete reviews, Q&A or catalog rows. They are merchant content under `dataPreserved`. Document erasure on request instead, which also fits "no data loss".
    - Keep D's guard unit test that an `installed` shop is never touched. Reinstall resets `uninstalledAt` (`sapo.service.ts:178`), so the guard is sound.

12. **Live preflight (VERIFIED).**
    - `.env` has `NODE_ENV=development` and an explicit `TRUST_PROXY=false`, and no sample key or placeholder. PM2 overrides `NODE_ENV` to `production`.
    - So dry-run `loadEnv` against the live `.env` with `NODE_ENV=production`, not the file's value.
    - Adding `TRUST_PROXY` to `requireRawProduction` will not break boot. The value `false` still needs an operator decision on hop count.
    - List `compression` (S-42) as documentation-only (edge tier, needs `npm install`).

Status: DONE_WITH_CONCERNS
Summary: D wins on repo-fact accuracy and the S-18/e2e catch, but needs Amendments 1-6 (git/deploy, `loadEnv` vs tests, S-16, migration SQL, `resolveAccessToken` seam, test ownership) applied before dispatch. I ran no builds, tests or network calls; all checks were reads and greps.