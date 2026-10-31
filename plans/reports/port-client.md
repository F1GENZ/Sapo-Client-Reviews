# Port client to Sapo – report

Scope: `client/src/**`, `client/public/**`, `client/functions/**`, `client/index.html`, `client/vite.config.js`, `client/.env.example`.

## What was wrong
- ~280 `orgid` uses (URL key, storage key, `x-orgid`/`orgid` headers, helpers `getOrgid`, `useOrgRoute`, `OrgLink`, `withOrgid`).
- Auth bootstrap was Haravan-shaped: `verifyHmac` expected `{valid, orgid, sessionToken}` (server returns a handoff), `entry` expected `{status, orgid, sessionToken}`, `/install/grandservice` page + `GET /api/oauth/install/grandservice` (no such server route), `session_token` in URL, `redirect=1` param, legacy `/oauth/install/login` fallback on 404, id_token/session_state.
- Race in `App.jsx`: `consumeHandoffFromUrl()` was fire-and-forget, then the same effect ran on and redirected to login before the exchange finished. `getOrgid()` read the URL, so the "org mismatch" branch could never fire.
- 401 interceptor also fired on `POST /api/auth/session/exchange` (stale-token redirect hid the real error).
- Vietnamese strings without diacritics (auth pages, `getErrorMessage` fallback). `index.html` description said Haravan, `lang="en"`.
- `functions/api/[[path]].js` defaulted to a Haravan API host.
- Dev guide Liquid snippets used `shop.metafields.f1genz.config.value.orgid` (Haravan JSON metafield) and Shopify-style JSON-LD with many unverified filters.
- `prefers-reduced-motion` block in `index.css` (forbidden).

## Actual auth sequences (server contract read from `src/sapo/sapo.controller.ts`, `session.service.ts`, `hmac-verifier.service.ts`, `shop-auth.guard.ts`)

Server facts: `GET /api/oauth/install/login/verify-hmac?<raw query>` → 200 `{handoffCode, storeDomain, redirectTo}`; 401 on missing/invalid hmac, missing/expired (>300 s) timestamp; 400 if `store` missing; 429 rate limit. `GET /api/oauth/install/login/entry?storeDomain=` → `{url, reason}` (400 for non-`*.mysapo.net`). OAuth callbacks hit the API; browser requests (`Accept: text/html`) get a 302 to `FRONTEND_URL/dashboard?storeDomain=<d>&handoff_code=<c>` (per ServerSecurityPort; the server file still showed `orgid` when I read it). `POST /api/auth/session/exchange {handoffCode}` → `{ok, storeDomain, redirectTo, sessionToken}` + session cookie. Guard accepts `Authorization: Bearer` / cookie and optional `x-store-domain` (must equal the session's store).

**(a) Open from Sapo admin with launch query** (`?hmac=…&store=x.mysapo.net&timestamp=…`)
1. Any non-login path: `authBootstrap.run()` sees `hmac` → `location.replace('/install/login' + window.location.search)` (string forwarded unchanged).
2. `Login` shows "Đang xác thực…", calls `authService.verifyLaunchQuery(window.location.search)` with raw `fetch` to `/api/oauth/install/login/verify-hmac?<same raw query>` (12 s abort). No decode/lowercase/re-serialize anywhere; the Pages function proxies `url.pathname + url.search` verbatim.
3. 200 → `completeHandoff` → `POST /api/auth/session/exchange` → `setAuthSession(storeDomain, token)` → `location.replace(getAuthenticatedRedirect(...))` = `/?storeDomain=x.mysapo.net` (launch params are gone, so a reload never reuses a stale hmac).
4. 401 (invalid/expired) or any other failure → form screen with a diacritic message, store input prefilled from `store`.

**(b) Open without query, no session**: bootstrap has no `storeDomain` and no verified active store → `/install/login` (previous path saved as post-auth redirect) → form "Nhập tên cửa hàng". Submit parses `ten`, `ten.mysapo.net` or a pasted URL (`parseStoreDomainInput`), calls `GET /api/oauth/install/login/entry?storeDomain=…`, then `navigateTopLevel(url)` (top frame when inside the Sapo iframe, own frame otherwise). 12 s safety timer returns to the form with a message if the navigation was blocked.

**(c) OAuth return**: server 302 → `/dashboard?storeDomain=…&handoff_code=…` (top level). `resolveAuthBootstrap` (memoized, so a double effect cannot spend the one-time code twice) exchanges the code *before* the router mounts, rewrites the URL to the saved post-auth path or `/` (`/dashboard` has no client route), strips `handoff_code`/launch params, renders the dashboard. Exchange failure → `/install/login?storeDomain=…&error=handoff_failed` (form + message).

**(d) Expired/invalid session**: any API 401 (except calls flagged `skipAuthRedirect`: exchange, entry) → save current path, `clearAuthSession(storeDomain)`, `location.href = /install/login?storeDomain=…&error=session_expired` → form + message. No automatic loop: `Login` auto-skips to the app only when there is a verified session **and no `error` param**; the only automatic hop out of the login page is that one, and nothing automatic starts OAuth (starting OAuth needs a click, which also satisfies the cross-origin top-navigation user-gesture requirement).

## Changes
- `src/common/AuthStorage.js` – rewritten with `storeDomain` (key, URL param, scoped keys `auth_session_token:<domain>`); validates with the server guard's domain regex (lowercased); `migrateAuthStorage`/`getSessionValue` removed; exports `normalizeStoreDomain`.
- `src/common/authBootstrap.js` (new) – the (a)/(b)/(c) decision logic; `src/App.jsx` now only renders `AuthScreen` until it resolves (race removed); `StoreDomainUrlKeeper` replaces `OrgidUrlKeeper`; `/install/grandservice` route removed.
- `src/common/authFlow.js` – `completeHandoff`, `activateStoreSession`, `parseStoreDomainInput`, `navigateTopLevel`, `sanitizeInternalRedirect` (maps `/dashboard`→`/`, strips launch/callback params). Removed `extractAuthFromRedirect`, `stripCallbackParams`, `isInternalLoginRedirect`, `redirectIfChanged`.
- `src/common/AuthService.js` – only `verifyLaunchQuery` (raw fetch, `AuthService.js:10`) and `entry` (`storeDomain` only, `:31`); `login`/`install`/`verifyLogin` deleted (no server route / no SPA callback; callbacks land on the API).
- `src/pages/auth/login/index.jsx` – new flow above; `AuthScreen.jsx` accepts `children`; `index.css` gets `.f1g-auth-form*` and loses the `prefers-reduced-motion` block.
- `src/pages/auth/grandservice/index.jsx` – deleted (empty directory `client/src/pages/auth/grandservice/` is left behind; I do not run `rm`/`rmdir`).
- `src/config/AxiosConfig.js:94-101` – 401 handler honors `skipAuthRedirect`, clears stale session, goes to `buildLoginPath({storeDomain,error:'session_expired'})`; request interceptor sends only `x-store-domain` + bearer. `src/common/ApiService.js:20` exchange uses `skipRetry`/`skipAuthRedirect`.
- `src/common/routes.js` – `withStoreDomain`, `buildLoginPath`; `hooks/useOrgRoute.js` → `hooks/useStoreRoute.js` (`useStoreRoute`, `useStoreNavigate`); `components/OrgLink.jsx` → `StoreLink.jsx`; `queryKeys.js`, dashboard/reviews/qna/ops/settings/guide/contact/dev pages, `AdminLayout`, `ReviewForm`, `useCreateReview`, `useMediaUpload` renamed `orgid`→`storeDomain`.
- `src/pages/dev/index.jsx` (`buildSnippets` :34) – snippets rebuilt for Sapo (see below). `contact/index.jsx:117` text.
- `functions/api/[[path]].js:10-17` – no hard-coded default backend; 502 JSON if `BACKEND_URL` unset. `index.html` – `lang="vi"`, description says Sapo. `getErrorMessage.js` fallback "Đã xảy ra lỗi". `.env.example` – added `VITE_STOREFRONT_API_URL`.

## Storefront install guide (dev page)
Server writes `shop` metafield `f1genz.config` (`src/storefront/storefront.service.ts:14-26`) as `value_type: 'string'` containing JSON `{"apiUrl":"<API_BASE_URL>","storeDomain":"<x.mysapo.net>"}`. The storefront runtime (`f1genz-storefront.js`) reads `window.__F1GENZ_STOREFRONT_CONFIG.apiUrl` (else script `data-api-url`/src origin) and, on each element, the attribute `storeDomain` (`getAttribute('storeDomain')`, HTML-case-insensitive) plus `product-id`, `customer-email`, `customer-phone`; `f1genz-product-schema` reads `product-name`, `brand`, `price`, `currency`, `sku`, `mpn`, `gtin`, `description`, `product-image`, `product-url`, `availability`, `max-reviews`. Elements verified to be defined: `f1genz-reviews`, `-reviews-panel`, `-qna-panel`, `-rating-badge`, `-product-schema` (file was being edited by another agent while I read it).

Because the metafield value is a JSON *string* and I could not verify any Sapo `.bwt` syntax to parse it, the guide does **not** read the metafield. The loader sets `window.__F1GENZ_STOREFRONT_CONFIG = { apiUrl, storeDomain }` with literal values (`storeDomain` = the logged-in store; `apiUrl` from `VITE_STOREFRONT_API_URL`, else the visible placeholder `https://API_HOST`) and loads CSS/JS from `apiUrl`. The big Shopify-style JSON-LD Liquid was replaced by `<f1genz-product-schema>`. Only `{{ product.id }}`, `{{ product.title | escape }}`, `{{ product.vendor | escape }}`, `{{ customer.email | escape }}`, `{{ customer.phone | escape }}` remain as Liquid; no `{% render %}`, no `| slice`, no `{% include %}` needed.

## Unverified / concerns
1. Sapo forwarding the launch query to the iframe Application URL – unverified; both paths are handled (query → verify-hmac; no query → store form + OAuth).
2. Whether OAuth `authorize` can be framed / whether cross-origin `window.top.location` assignment is permitted from the Sapo iframe – unverified; the form-click gives a user gesture, fallback is the current frame, 12 s timer returns to the form. Session storage inside the iframe (third-party storage partitioning) is also unverified; the hmac launch path creates a fresh handoff each open and does not depend on prior storage.
3. Sapo Liquid objects used in snippets (`product.id/title/vendor`, `customer.email/phone`, `escape`) follow the old guide / sibling `.bwt` and are not verified against Sapo docs. SSR rating attributes (`avg-rating`, `review-count`) were dropped because metafield access syntax is unverified (the badge falls back to the batch API).
4. Server redirect after OAuth: server file I read still wrote `orgid` into the redirect; ServerSecurityPort confirmed it becomes `storeDomain` + `handoff_code`. Client reads only `storeDomain`.
5. `storeDomain` validation is the guard's dotted-domain regex (lowercased); the old single-label `orgid` values (e.g. `shop-a`) are now invalid by design.
6. `NODE_ENV=development` is set in this shell: a plain `vite build` bundles dev React (initial JS 165 kB). Real numbers need `NODE_ENV=production`.

## Needs from others
- Server: `finishAuthFlow` must redirect with `storeDomain` (not `orgid`) – confirmed in progress by ServerSecurityPort.
- `client/scripts/*`, `client/tests/*`: owned by TestParityPort; they dropped the grandservice entry and adapted the contract test (4 tests pass).

## Proof
- `rg -i "haravan|hrv|orgid|grandservice" client/src client/public client/functions client/index.html client/vite.config.js client/.env.example` → no output (rc=1).
- `NODE_ENV=production npm run build` → built, `AdminLayout` 534.26 kB (170.44 kB gz), `vendor-react` 194.34 kB (60.78 kB gz), css 16.56 kB (4.24 kB gz).
- `NODE_ENV=production npm run budget` → OK antd-free root/auth; initial JS gzip 107.0 kB ≤ 120 kB; largest JS 166.4 kB ≤ 190 kB (AdminLayout); storefront JS 29.0 kB ≤ 30 kB; storefront CSS 4.7 kB ≤ 8 kB.
- `node --test tests/auth-storage.contract.test.mjs` → 4/4 pass (test file adapted by its owner).
- No dev server left running; no git/hrv/sapo CLI calls; no Sapo store contacted.

## Follow-up: theme snippets aligned with the real metafields
- `storefront/snippets/theme/f1genz-sapo-widget.bwt` rewritten: `{% comment %}`/`{% if %}` syntax (the old file used `{{ ... }}` for statements); removed `shop.metafields.f1genz.config` parsing, the `json_parse` filter, the wrong `reviews.public_summary` namespace and the inline JSON-LD (use `storefront/theme/f1genz-product-schema.bwt`, not rewritten). Loader sets `window.__F1GENZ_STOREFRONT_CONFIG` with literal `API_HOST`/`STORE_DOMAIN`; the optional SSR badge prints only `product.metafields.f1genz_reviews.rating_avg` / `rating_count` behind `{% if %}`. No `slice`, no filter besides `escape`.
- `storefront/snippets/theme/README.md` rewritten to match.
- `client/src/pages/dev/index.jsx`: section 3 gains the optional metafield-based badge; section 4 now leads with `{% include 'f1genz-product-schema' %}` (SSR, reads `rating_count`/`rating_avg`) and keeps the `f1genz-product-schema` web component as an either/or fallback (never both: duplicate `aggregateRating`).
- Still unverified: `product.metafields.<ns>.<key>` access and `customer.*` objects in Sapo `.bwt`.
- Re-run: `NODE_ENV=production npm run build` ok; `npm run budget` ok (initial JS 107.0 kB gz).

## Follow-up: e2e bugs (bulk rows, spam settings)
- **Crushed cards:** `.f1g-bulk-table__row` was a 42px+1fr grid for a checkbox cell that the Sapo pages never render (the Haravan pages do: `.f1g-bulk-table__check` + `is-selected`). The Sapo client has no bulk selection, so the row is now `display: block` (`client/src/index.css`); the unused `__check`, `.is-selected` and 36px mobile grid rules were removed.
- **Spam settings that dropped silently:** Haravan persists and evaluates `enabled`, `autoApprove`, `minContentLength`, `maxUrls`, `maxReviewsPerAuthor`, `blockDuplicate`, `blockRepeatedChars` (`detectSpamStatus`). The Sapo server never did: its `UpdateSpamConfigDto` keeps only `minRating`, `blockedWords`, `maxContentLength`, and `detectSpam` checks blocked words, max length and same-author duplicate. I did not port the Haravan rule set, because it would silently change what gets published. The seven dead controls are removed from `client/src/pages/settings/index.jsx`; a real "Độ dài nội dung tối đa" (`maxContentLength`) control replaces them. Blocked words stay. `minRating` is accepted by the DTO but evaluated nowhere and has no UI.
- **Widget `autoApprove` was dead too:** it was persisted in the widget config but `addReview` never read it, so every storefront review went to `pending`. Now `detectSpam(..., autoApproveClean)` returns `approved` for a review that passes the spam rules when the switch is on (default off, so existing behaviour is unchanged); the public submit controller passes `getPublicWidgetConfig(...).autoApprove`, admin-created reviews are unaffected. Files: `src/review/review.service.ts`, `src/review/public-review.controller.ts`, `src/review/interfaces/widget-config.interface.ts` (`autoApprove?`).
- **Test:** `test/review-spam.test.ts` (3 tests: pending vs approved, spam beats autoApprove, DTO whitelist keeps only evaluated keys).
- **Proof:** `npm test` at root 90/90 pass, `tsc --noEmit` clean; client `NODE_ENV=production npm run build` ok, `npm run budget` ok (initial JS 107.0 kB gz, largest 166.4 kB, storefront JS 29.0 kB, CSS 4.7 kB); contract test 4/4; the forbidden-word grep is still empty.
- Not checked in a browser: the new row layout is verified by CSS reading only.
