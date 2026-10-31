# Port storefront runtime: Haravan to Sapo

Scope owned: `storefront/snippets/f1genz-storefront.{js,css}`, `src/storefront/**`, `test/storefront.test.ts`.

## Method
The Sapo JS/CSS were exactly the Haravan fork-base (`0eda13b^`) after a mechanical rename (`f1genzapp-review` to `f1genz-sapo-review`, `orgId`/`orgid` to `storeDomain`, `x-orgid` to `x-store-domain`, `window.Haravan` to `window.Sapo`) plus two Sapo-only deltas (a `aria-label` on the sort select, `observedAttributes`). I applied the same rename to Haravan base and HEAD and 3-way merged `base` -> `HEAD` onto Sapo (1 trivial conflict), then stripped non-ported features and fixed Haravan-isms by hand.

## What Sapo lacked (storefront commit map) and result
| Commit(s) | Item | Result |
|---|---|---|
| 0eda13b | 5MB image limit + client auto-compress | Ported (`prepareImageForUpload`: soft target 1.5MB, JPEG re-encode, max edge 1920, hard limit 5MB, 5 files, video 2MB). Client only. |
| a5852ee, 93250e4 | native file input fully hidden (JS inline style, CSS `!important`) | Ported (JS + CSS) |
| 2bb2840 | critical CSS injection / un-break `rel="stylesheet preload"` link | Ported (`ensureCriticalStyles`, `ensureStorefrontStylesheet`) |
| aacf8f4 | ajax rating badge hydration (`connectedCallback`/`attributeChangedCallback`, reload versioning) | Ported. Also fixed a Sapo bug: `observedAttributes` listed `'storeDomain'` (never fires, HTML lowercases attribute names) -> `'storedomain'` |
| 6336de5 | quickview badge hydration with empty `product-id`, `scan`/`mountQuickview`, MutationObserver | Ported. Dropped Haravan-theme-only hooks (`#pro-qv-wanda`, `#pro-quickview-mobile`, `product_quick_js(_desk)`); native badge selector is now `.sapo-product-reviews-badge` ([INFERENCE]: Sapo's reviews-badge class, not measured) |
| 87f055b, 5ca9b89 | markdown/auto links in replies and Q&A, whitespace tolerant | Ported and rewritten (see below) |
| 8050212, abc50a0, 32b7cd6, 2e651e7, 9e48146 | mobile summary card / rating bars CSS | Ported (CSS merge) |
| 632e5a6, 09b12dc, 57d0aaf | auto-mounted `<f1genz-product-schema>`, `@id` = `${canonical}#product`, image URL normalization, no config fetch for the schema element | Ported; builder extracted to pure `buildProductSchema` |
| e7c972d (client part) | login detection no longer inferred from regex-matched identity, summary batch rejects instead of caching empty, config failure not memoized, `encodeURIComponent` on every product-id path segment | Ported |
| 5c435ac | full review list beyond one page + true totals from `/summary` | Ported, adapted to Sapo's paging contract (below) |
| e7c972d (server part), 795bd16, 363872c | fail-closed config for non-serving shops (server side) | Not mine (server). Client side already fails closed: list/summary errors render nothing and are never cached as empty |
| 363872c | asset `stale-while-revalidate` 86400 -> 300 | Ported: `src/storefront/storefront-asset-cache.ts`, controller uses it |
| 1e7eebc, bef9f30, ec550b5 | watermark / tiers / AI highlights / curated slider | NOT ported; Sapo runtime has none (below) |

## Sapo-specific bugs found and fixed (not in the Haravan diff)
1. Sapo server returns `{ data: { items, total, page, pageSize } }` for reviews and Q&A (`review.service.ts:709`, `qna.service.ts:409`). The runtime only accepted a bare array, so reviews and questions always rendered empty. `fetchAllPublicPages` now reads both shapes, requests `?page=N&limit=50` (server cap 50) up to 20 pages, stops at `total`, dedupes by id, throws on a first-page failure, keeps partial data on a later-page failure.
2. Server `getPublicSummaries` silently truncates to 100 ids; client batch limit was 250 (products 101-250 would show an empty rating). `REVIEW_SUMMARY_BATCH_LIMIT` is now 100.
3. Rich text: Haravan's escape-then-regex approach produced broken hrefs for a URL followed by a quote (`&quot;`, `;` stripped) and let user text spoof the `__F1GENZ_LINK_n__` placeholder. Rewritten as a single tokenizing pass that escapes each segment, links only `http(s)`, allows quote/paren-prefixed bare URLs, strips trailing `.,;:!?`, tolerates whitespace/newline in `[label] ( url )`.
4. Schema `offers` is emitted only when a price exists (an Offer without price is invalid). Price comes only from the DOM (`[itemprop=price]`, `product:price:amount`/`og:price:amount`, `.product-price`); Haravan's `/products/{handle}.js` price `/100` guess was removed because Sapo's unit is unverified. Relative canonical/product/image URLs are resolved against the origin.

## Watermark and tiers
Removed entirely: `DEFAULT_CONFIG.watermark`, the shell mark markup, all `.f1genz-sapo-review-watermark` CSS. Also not ported: AI highlights (JS + CSS), `config.features.*`, curated slider element/CSS/config keys (Sapo server has no `/slider` endpoint or `features`). Removed `@media (prefers-reduced-motion)` (Haravan HEAD had already dropped it).

## Files changed
- `storefront/snippets/f1genz-storefront.js` (merged and edited; internals test hook on `window.F1GENZStorefront.internals`)
- `storefront/snippets/f1genz-storefront.css` (Haravan HEAD renamed, minus watermark/highlights/slider/reduced-motion)
- `src/storefront/storefront-asset-cache.ts` (new), `src/storefront/storefront-asset.controller.ts:5`
- `test/storefront.test.ts` (new, 21 tests)

## Proof
- `node --check storefront/snippets/f1genz-storefront.js`: ok.
- `node --import tsx --test test/storefront.test.ts`: 21 pass, 0 fail (rich text escaping/links, JSON-LD with 0 reviews / with reviews / entity `@id` / image normalization / offers, paged list contract, error non-caching, percent-encoding, config not memoized, image compression, asset headers).
- `npm test`: 44 pass, 0 fail (includes lifecycle tests).
- `npm run lint` and `npm run build`: a single error, NOT mine: `src/review/review.service.ts(364,26): Cannot find name 'buildSummaryMetafields'` (another agent's in-flight edit). No errors in my files.
- Gzip (computed directly, see budget note): storefront JS 140 445 B raw / 29 745 B gzip = 29.05 kB vs budget 30 kB (headroom ~0.95 kB); CSS 30 543 B / 4 816 B = 4.70 kB vs 8 kB. Haravan HEAD JS is 30 931 B gzip (over its own 30 kB budget).
- Final grep for `haravan|hrv|orgid|lorid|watermark|prefers-reduced` over the owned files: no hits.

## Needs from others
1. `src/media/media.service.ts`: `IMAGE_MAX_SIZE_BYTES` is 500 KB and `MAX_UPLOAD_BYTES` (multer `fileSize`) is 2 MB. The client now sends images up to **5 MB** (`5 * 1024 * 1024`, error text "Max 5MB for image"). Set `IMAGE_MAX_SIZE_BYTES = 5MB` and `MAX_UPLOAD_BYTES = IMAGE_MAX_SIZE_BYTES` (as Haravan 0eda13b), video stays 2 MB. Until then uploads between 0.5 and 5 MB fail.
2. `client/scripts/check-performance-budget.js:84-85` points at `server/storefront/snippets/...` (Haravan layout); in this repo the files are `storefront/snippets/...`, so `npm --prefix client run budget` throws ENOENT. Fix the path (`resolve(repoRoot, "storefront", "snippets", ...)`). Not run by me.
3. Theme `.bwt` snippet (`storefront/snippets/theme/f1genz-sapo-widget.bwt`): it publishes `window.__F1GENZ_STOREFRONT_CONFIG = { apiUrl, store }`; runtime reads `storeDomain` or `store`, so it works as is. For entity linking, the SSR JSON-LD Product should add `"@id": "{{ canonical_url }}#product"`; the runtime skips auto-mount when an SSR Product with `aggregateRating` exists. Elements keep the `storeDomain` attribute.
4. Public API contract the runtime relies on: `GET /api/public/reviews/:id` and `/api/public/qna/:id` honour `page`, `limit<=50`, return `{items,total}` or a bare array; `/summaries` accepts up to 100 ids; `/:id/summary` returns `{avg,count,distribution}`. Tell the owner before changing any of these.
5. `src/main.ts`: Haravan also dropped the framework fingerprint header (bef9f30, `x-powered-by`); not mine.

## Open risks
- Unverified on a real Sapo storefront: `/products/{handle}.js` (failure falls back to `window.product`/og meta/DOM), `.sapo-product-reviews-badge`, quickview container ids (generic selectors only), `window.product`. All paths are failure-tolerant; schema simply is not auto-mounted if no numeric product id is found.
- Scratch files from my diffing remain at `E:/Work/tmp-*` (outside the repo); my delete was blocked by the destructive-command rule, please remove them.
