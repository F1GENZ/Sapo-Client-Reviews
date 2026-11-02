# Wave 1 S2 test impact (Q&A / catalog / dashboard / ops / health)

## Existing tests that break or need an update (wave 2)

- `test/durability.test.ts:496-505` "pending intents are dropped after the attempt budget and backoff is capped": breaks by design (S-36). `recordFailure` now returns `{ exhausted }` (no `dropped`), keeps the row at `attempts === PENDING_MAX_ATTEMPTS` and reschedules it at the capped backoff. Replace with the new semantics (row kept, `exhausted: true`, `deleteMany` never called); `test/s2-qna-catalog-dashboard.test.ts` already covers it.
- `test/lifecycle.test.ts:637-658` "dashboard recent lists read the first page of the 0-based stores": still passes, but only because failing sections degrade. Its prisma stub has no `reviewProduct`, `qnaQuestion` or `$queryRaw`, so `productStats`, `reviewTrend` and `unreplied` are reported in `overview.degraded`. Extend the stub (see `makeDashboard` in `test/s2-qna-catalog-dashboard.test.ts`) if the test should assert a clean overview.
- `test/lifecycle.test.ts:577-592` qna stats: unchanged and still valid (`QnaStoreService.getStats` keeps `aggregate` + `count`).
- `e2e/http-contract.cjs:488-490` ops routes:
  - `POST /api/admin/ops/resync-webhooks` now returns `{ ok, storeDomain, status, error? }` (was `{ ok:true, results:[] }`); `ok` is `status === 'registered'`.
  - `POST /api/admin/ops/resync-config` returns `ok:false` plus `configError` when the metafield write fails.
  - `POST /api/admin/ops/backfill-catalog` returns `ok:false` when `stopReason` is `failed_page` or `max_pages`. A second call for the same store within 300 s answers 429 `backfill_rate_limited`; a concurrent call answers 409 `backfill_in_progress`. If the e2e script calls backfill twice per store it must space the calls or expect 429.
  - `GET /api/admin/ops/health` gains `degradedSections: string[]` and `metafieldSync: { total, due, failed }`; for an unknown store it now answers 404 `install_not_found` (was a 200 with `status: 'unknown'`). Same 404 for `GET /api/admin/dashboard/overview`.
- `e2e` Q&A routes:
  - `GET /api/admin/qna/:productId` accepts `page` (1-based), `size` (<=100), `status`, `sort` and returns `{ items, total, page, pageSize, totalPages, statusCounts }` (statusCounts scoped to the product).
  - Public Q&A submit returns 403 `qna_disabled` when `allowQnA === false`, and 409 `{ code: 'store_not_serving' }` for a non-serving store. Public read returns an empty page when `allowQnA === false`.
  - Any e2e that seeds Q&A against a store whose widget config has `allowQnA:false` must flip it first.
- `client/e2e/journeys.cjs` (S6): per-product Q&A stub must return `{ items, total, page, pageSize, totalPages, statusCounts }`; dashboard stub should carry `reviewTrend`, `attentionProducts`, `productStats`, `degraded`.

## Not finished / needs others

- S-36 `public_summary` size budget: the builder is `buildSummaryMetafields` in `src/review/review.service.ts` (S1's file). No guard was added. Measured shape (`test/durability.test.ts:691-700`, 6-digit count) stays under 120 bytes; a "truncate JSON" guard would only produce invalid JSON, so none is recommended.
- S-33 (blank Q&A answer `IsNotEmpty` in `src/qna/dto/answer-question.dto.ts`) was not in the assignment and was left untouched.
- S-18 style `product_not_found` check for public Q&A submit was not in the assignment and was not added.
