# Wave 1 S6 (Admin SPA) - test impact

## Owned tests changed inside the slice (no wave 2 action needed)
- `client/e2e/journeys.cjs`: stubs now real-shaped. Product route returns `{product}` (404 when unknown), per-product Q&A returns `{items,total,page,pageSize,totalPages,statusCounts}` honoring `page`, `size`, `status`, `sort`, dashboard stub carries `reviewTrend`, `attentionProducts`, `productStats`, `degraded`, `qnaStatusCounts`, `statusCounts.unreplied`, review stats stub returns approved-only `summary.count`, the star filter is honored, `/api/admin/ops/health` is stubbed. N5 rewritten (ops is a normal route), N6/N7 (dashboard payload, degraded warning), V11 (single-product route and `/{alias}` link), V12 (star filter), Q4/Q5 (per-product Q&A paging), A4 asserts no `auth_session_token` cookie, N3 also covers `/dev` and `/health`.
- `client/tests/auth-storage.contract.test.mjs`: added a no-cookie test; wired as `npm run test:unit` in `client/package.json`.
- `client/scripts/smoke-routes.cjs` deleted (it mocked Haravan-era routes `/shop/info`, `/reviews/all`, `/reviews/bulk`, `queueTotals`, and a bulk-delete flow the UI no longer renders); the `smoke` npm script is removed. Route and 375px overflow coverage lives in journeys N3.

## Needs wave 2
- `.github/workflows/ci-e2e.yml` (slice I): the `client-journeys` job should also run `npm run test:unit` in `client/` (step not present). No workflow referenced `npm run smoke`.
- `client/e2e/storefront-widget.cjs:339-341` (slice F) still passes `emailDisplay`/`phoneDisplay` in a config; the admin SPA no longer exposes those two settings (server strips contact fields from public rows). Remove or adjust when F removes the storefront reads.
- Root `e2e/**` and `test/**`: no references to `DevGate`, `dev=`, or the removed smoke script.

## Not finished / caveats
- None of the journeys were executed (no builds/tests mid-flight). Selectors added in V12 (`button` with text `4`) and Q5 (`.ant-pagination-item-2`) are unverified against a live render.
- The per-product Q&A call relies on S2's confirmed contract: `GET /api/admin/qna/:productId?page&size&status&sort` returning `{items,total,page,pageSize,totalPages,statusCounts}`.
- Ops resync result handling in `client/src/pages/ops/index.jsx` still reads `result.results` (legacy `resyncWebhooks` shape); see report body.
