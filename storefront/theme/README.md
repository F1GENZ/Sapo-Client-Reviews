# Product review schema (Sapo `.bwt`)

`f1genz-product-schema.bwt` renders `Product` + `aggregateRating` JSON-LD on the server, so crawlers see the rating without running JavaScript.

## Install

1. Copy `f1genz-product-schema.bwt` into the theme's `snippets/` folder.
2. In `product.bwt`, inside `<head>` (or anywhere in the page), add `{% include 'f1genz-product-schema' %}`.
3. Remove any other JSON-LD block that also emits `aggregateRating` for the same product, otherwise Google sees two ratings.

## What it reads

| Metafield | Type | Written by |
|---|---|---|
| `product.metafields.f1genz_reviews.rating_count` | integer | the app, after every review write and by the pending-sync reconciler |
| `product.metafields.f1genz_reviews.rating_avg` | string, one decimal (`"4.6"`) | same |

The namespace is `f1genz_reviews`. `f1genz_reviews.public_summary` (a JSON string with `avg`, `count`, `distribution`) is written for the widget script; `.bwt` cannot parse JSON, so this snippet does not use it.

Only approved reviews are counted.

## 0-review rule

When `rating_count` or `rating_avg` is missing, blank, `0` or `'0'`, the snippet outputs nothing at all: no `aggregateRating`, and no `Product` script. A rating is never emitted for a product without reviews. The comparisons check both the integer `0` and the string `'0'`, so they do not depend on how Sapo types the metafield value.

## Duplicate Product schema

The runtime also mounts an automatic `<f1genz-product-schema>` on a page whose `og:type` contains `product`. It skips that only when the page already has a `Product` JSON-LD script that contains `aggregateRating` (the output of this snippet qualifies). A theme `Product` JSON-LD without `aggregateRating` does not stop it, so both can be present. Set `autoProductSchema: false` in `window.__F1GENZ_STOREFRONT_CONFIG` to turn the automatic mount off. Whether Sapo product pages carry `og:type` `product` is not measured.

## Fallback

The review web component is the fuller tier: if a theme does not include this snippet, the component fetches the summary from `GET /api/public/reviews/:productId/summary`. Distribution and review text are not stored in product metafields that `.bwt` can print; the widget reads them from the API.

## `.bwt` constraints followed

- `{% include %}` only; no `{% schema %}`.
- No `slice` filter; the only filter is `escape`.
- Metafield values are printed as stored (no `plus`, no `default`); the guard above replaces numeric coercion.
- `{{ product.name | escape }}` is HTML-escaped, not JSON-escaped. A name with `&`, `<`, `>`, `"` or `'` appears in the JSON-LD as an HTML entity (for example `&amp;`). There is no JSON-escape filter here and Sapo support for one is not verified.
- Not verified on a real Sapo theme render: `canonical_url`, `product.featured_image.src`, `product.vendor` and `product.metafields.<ns>.<key>` as Sapo Liquid objects, and the `!= blank` comparison. Test the snippet on a real theme before relying on it.
