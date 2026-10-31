const scopedKey = (storeDomain, ...parts) => ["shop", storeDomain || "unknown", ...parts];

export const shopQueryKeys = {
  dashboardOverview: (storeDomain) => scopedKey(storeDomain, "dashboard-overview"),
  shopInfo: (storeDomain) => scopedKey(storeDomain, "shop-info"),
  product: (storeDomain, productId) => scopedKey(storeDomain, "product", productId || "none"),
  products: (storeDomain, params = {}) => scopedKey(storeDomain, "products", params),
  reviews: (storeDomain, productId) => scopedKey(storeDomain, "reviews", productId || "all"),
  allReviews: (storeDomain, params = {}) => scopedKey(storeDomain, "reviews", "all-list", params),
  allReviewsRoot: (storeDomain) => scopedKey(storeDomain, "reviews", "all-list"),
  reviewSummary: (storeDomain, productId) =>
    scopedKey(storeDomain, "reviews", productId || "all", "summary"),
  qnaRoot: (storeDomain) => scopedKey(storeDomain, "qna"),
  productQna: (storeDomain, productId, params = {}) =>
    scopedKey(storeDomain, "qna", productId, params),
  allQna: (storeDomain, params = {}) => scopedKey(storeDomain, "qna", "all-list", params),
  widgetConfig: (storeDomain) => scopedKey(storeDomain, "widgetConfig"),
  spamConfig: (storeDomain) => scopedKey(storeDomain, "spamConfig"),
  opsHealth: (storeDomain) => scopedKey(storeDomain, "ops", "health"),
};
