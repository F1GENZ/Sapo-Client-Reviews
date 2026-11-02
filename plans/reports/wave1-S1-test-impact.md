# Wave 1 S1 (Review) - test impact

## Existing tests/e2e that break or need updates (wave 2 owner)

- `e2e/http-contract.cjs` R2 (:570), R9 (:669), R13/R14 (admin create + public reads of 1001-1003 are fine, admin writes unaffected), R15 (:763, product 1004), flood check (:1008) and every public `POST /api/public/reviews/:id`: the public submit now requires a live `catalog_products` row (`deletedAt = null`) and answers `404 { code: 'product_not_found' }` otherwise. Seed catalog rows for 1001-1004 for store A (and any other product id posted) before those checks.
- `e2e/http-contract.cjs` R2 (:570-593): a clean public review is still `pending` (autoApprove off). The submit response no longer carries `verified`, `email`, `phone`, `pinned`; only `id, rating, content, author, title, media, status, created_at, updated_at`.
- `e2e/http-contract.cjs` flood check (:1008-1014): public submits first pass the product-existence gate for known stores (404 if no catalog row); the per-client/store 429 limit still fires before that. Seed the product or assert 429 only.
- `e2e/http-contract.cjs` U1 (:972): post-uninstall submit now answers 409 `store_not_serving` (already inside the accepted `[401,403,409]`).
- `e2e/http-contract.cjs` R10 (:677-689): `emailDisplay`/`phoneDisplay` are still accepted and stored by `UpdateWidgetConfigDto` (no server reader; storefront-only settings, wave 2 F decides about removing them). No change needed.
- `e2e/http-contract.cjs` `spam-config` PUT bodies (:480, :533-539) use `blockedWords` only; `minRating` is removed from the DTO (whitelist drops it), `maxContentLength` is now `@Min(1)`.
- `test/review-spam.test.ts`: still valid (`DEFAULT_SPAM_CONFIG` no longer has `minRating`; the DTO whitelist test does not mention it).
- `test/durability.test.ts` `makeReviewHarness` (:410): passes `{}` for `catalogStore` and `purchaseStore`; unaffected because only new methods use them. `status counts come from grouped counts` (:612) still passes: unreplied count keeps `OR` at the top level of its `where`, the list total uses `AND` (so the fake returns 3 for it, as before). `getPublicSummaries` for non-serving store (:607) still returns an empty summary for numeric ids.
- `test/lifecycle.test.ts` :608 (`getStatsForShop`): the fake `count` now also serves the unreplied query (returns 2); `trend` and `recentReviews` are removed from the result (no reader: dashboard/ops read only totals, counts, products, dist, avg).
- `test/lifecycle.test.ts` :615 (store upsert label): unchanged behaviour; `media` is now `undefined`/`Prisma.DbNull`/value instead of `as any`.
- `test/security.test.ts` :384-434 `toPublicReview` / `sanitizePublicResponse`: unchanged (`toPublicReview` export kept).
- Not breaking but worth adding in wave 2: a real-HTTP assertion that `POST /api/public/reviews/:id/purchase-eligibility` returns `{eligible:true, reason:'not_required'}` while the gate is off, and that `GET /api/admin/reviews?star=4` filters.

## New tests added

- `test/review-public-gates.test.ts` (node:test, no network): store_not_serving 409, product_not_found 404, identity_required 400, purchase_required 403, verified computed server-side and never echoed, 503 only when the gate is on, form-mode hidden/required, metafield sync only for approved, eligibility (uniform, free when off, identity charged before lookup), media allowlist, summaries (numeric ids, cap 100, one `groupBy`), unreplied+search+star composition, catalog title preference, media `DbNull`, identity-bucket key shape (no product id / raw identity).

## Behaviour notes for other slices / wave 2

- Public write error bodies are `{ code, message }`: `store_not_serving` (409), `product_not_found` (404), `identity_required` (400), `purchase_required` (403), `purchase_check_unavailable` (503), `email_required` / `phone_required` / `title_required` / `content_required` (400, form modes).
- A store whose token is revoked (`needs_reinstall`) still serves reads; a review submit for it now answers 409 `store_not_serving` (controller maps the `UnauthorizedException` from `SapoService.resolveAccessToken` to the unified 409), consistent with the other write routes.
- Eligibility for an unknown/non-serving store now answers a uniform 200 `{ eligible:false, reason:'not_purchased' }` (no 409 install oracle).
- Identity bucket: bucket `public-review:identity`, key `${storeDomain}|hex(HMAC-SHA256(APP_SESSION_SECRET, 'public-review-identity|<email|phone>|<normalised>'))`, 30 per hour (code constants in `public-review.controller.ts`), charged for each provided identifier on eligibility lookups and on gated submits; both routes also have the per-client/store bucket (`public-review:eligibility`, `public-review:submit`).
- `requireLogin` is not enforceable server-side; left as is.

## Not finished / decisions

- S-35: no server-side change needed (the client reads `summary.count`).
- S-33: `emailDisplay`/`phoneDisplay` DTO fields kept (server stores them, no server reader; storefront owns them). `minRating` removed (no reader).
- `allowImage` / `allowVideo` are still not enforced server-side (not in the finding list).
