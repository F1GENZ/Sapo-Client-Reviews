# Storefront widget installation (Sapo `.bwt`)

Copy the blocks from `f1genz-sapo-widget.bwt` into the theme. The admin Dev guide shows the same blocks with the store's own `storeDomain` filled in.

| Block | Where | Purpose |
|---|---|---|
| 1. Global loader | layout file, before `</body>` | sets `window.__F1GENZ_STOREFRONT_CONFIG = { apiUrl, storeDomain }`, loads the storefront CSS/JS from `apiUrl` |
| 2. `<f1genz-reviews>` | product template | reviews + Q&A widget |
| 3. `<f1genz-qna-panel>` | product template | separate Q&A panel (use instead of 2 when reviews and Q&A sit apart) |
| 4. `<f1genz-rating-badge>` | product card / collection loop | rating badge; score fetched in batches from the API |
| 4b. SSR badge variant | same | optional, use instead of 4; prints the scalar metafields below |

SEO JSON-LD is `storefront/theme/f1genz-product-schema.bwt` (`{% include 'f1genz-product-schema' %}`); see its README.

## Loader values

Replace `API_HOST` (the app API URL, `https://...`) and `STORE_DOMAIN` (the store's `x.mysapo.net` domain) in the loader and in every `storeDomain` attribute. There is no fallback host: if the runtime finds no API URL (neither `window.__F1GENZ_STOREFRONT_CONFIG.apiUrl` nor a `data-api-url` / `src` origin on its own `<script>` tag), it logs one `console.error` and sends no requests.

## Metafields

The app writes, per product, in namespace `f1genz_reviews`: `rating_count` (integer), `rating_avg` (string, one decimal), `public_summary` (JSON string for scripts). `.bwt` cannot parse JSON, so only the two scalars are printed, with plain output and an `{% if %}` guard.

The app writes three shop metafields in namespace `f1genz`: `config` (`{"apiUrl": "...", "storeDomain": "x.mysapo.net"}` as a JSON string) and the plain strings `api_url` and `store_domain` with the same two values. No snippet reads any of them; paste the two values into the loader literally. Printing `shop.metafields.f1genz.api_url` in a theme is not verified on Sapo.

## Element attributes the runtime reads

`storeDomain` (required, the `x.mysapo.net` domain, not a custom domain), `product-id`, `customer-email`, `customer-phone`; badge also `avg-rating` + `review-count` (both or neither).

`customer-email` and `customer-phone` are the only source of shopper identity. The runtime does not read `window.customer`, `window.__st` or the `/account` page. Empty values mean a guest: with `requireLogin` the write button becomes a login link, and with `requirePurchaseToReview` the form stays closed. When the purchase gate is on, the widget sends the identity from these attributes with the review even if the Email or Phone form field is hidden; the server uses it to check the purchase and does not store a field the store hides.

## Constraints

`{% include %}` only, no `slice`, no filters other than `escape`. The Sapo Liquid objects used (`product.id`, `customer.email`, `customer.phone`, `product.metafields.<ns>.<key>`) are not verified against Sapo documentation, and the snippets have not been rendered on a real Sapo theme. The e2e suite checks the `.bwt` text (filters, no `slice`), not Sapo's render.
