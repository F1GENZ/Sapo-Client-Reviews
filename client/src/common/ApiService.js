import httpClient from "../config/AxiosConfig";

export const fetchDashboardOverview = async () => {
  const res = await httpClient.get("/api/admin/dashboard/overview");
  return res.data?.data;
};

export const fetchAppSession = async () => {
  const res = await httpClient.get("/api/app/session");
  return res.data?.data;
};

export const exchangeHandoff = async (handoffCode) => {
  const res = await httpClient.post(
    "/api/auth/session/exchange",
    { handoffCode },
    { skipRetry: true, skipAuthRedirect: true },
  );
  return res.data;
};

export const fetchProducts = async (params = {}) => {
  const res = await httpClient.get("/api/admin/products", { params });
  return res.data?.data;
};

export const fetchProduct = async (productId) => {
  const res = await httpClient.get(`/api/admin/products/${productId}`);
  return res.data?.data?.product;
};

export const fetchOpsHealth = async () => {
  const res = await httpClient.get("/api/admin/ops/health");
  return res.data?.data;
};

export const resyncOpsConfig = async () => {
  const res = await httpClient.post("/api/admin/ops/resync-config");
  return res.data?.data;
};

export const resyncOpsWebhooks = async () => {
  const res = await httpClient.post("/api/admin/ops/resync-webhooks");
  return res.data?.data;
};

export const backfillOpsCatalog = async (data = {}) => {
  const res = await httpClient.post("/api/admin/ops/backfill-catalog", data);
  return res.data?.data;
};

export const fetchAllReviews = async (params = {}) => {
  const { pageSize, sortBy, star, ...rest } = params;
  const res = await httpClient.get(`/api/admin/reviews`, {
    params: {
      ...rest,
      limit: pageSize,
      sort: sortBy,
      ...(star ? { star: Number(star) } : {}),
    },
    timeout: 60000,
    skipRetry: true,
  });
  return res.data?.data;
};

export const fetchReviews = async (productId) => {
  const res = await httpClient.get(`/api/admin/reviews/${productId}`);
  return res.data?.data;
};

export const fetchReviewSummary = async (productId) => {
  const res = await httpClient.get(`/api/admin/reviews/${productId}/stats`);
  const stats = res.data?.data;
  if (!stats) return stats;
  const inner = stats.summary || {};
  return {
    count: inner.count ?? 0,
    avg: inner.avg ?? stats.avgRating ?? 0,
    distribution: inner.distribution || {},
  };
};

export const createReview = async (productId, data) => {
  const res = await httpClient.post(`/api/admin/reviews/${productId}`, data);
  return res.data?.data;
};

export const updateReview = async (productId, reviewId, data) => {
  const res = await httpClient.patch(`/api/admin/reviews/${productId}/${reviewId}`, data);
  return res.data?.data;
};

export const replyToReview = async (productId, reviewId, data) => {
  const res = await httpClient.patch(`/api/admin/reviews/${productId}/${reviewId}/reply`, data);
  return res.data?.data;
};

export const updateReviewStatus = async (productId, reviewId, status) => {
  const res = await httpClient.patch(`/api/admin/reviews/${productId}/${reviewId}/status`, { status });
  return res.data?.data;
};

export const deleteReview = async (productId, reviewId) => {
  const res = await httpClient.delete(`/api/admin/reviews/${productId}/${reviewId}`);
  return res.data?.data;
};

export const fetchSpamConfig = async () => {
  const res = await httpClient.get("/api/admin/reviews/spam-config");
  return res.data?.data;
};

export const saveSpamConfig = async (data) => {
  const res = await httpClient.put("/api/admin/reviews/spam-config", data);
  return res.data?.data;
};

export const fetchWidgetConfig = async () => {
  const res = await httpClient.get("/api/admin/reviews/widget-config");
  return res.data?.data;
};

export const saveWidgetConfig = async (data) => {
  const res = await httpClient.put("/api/admin/reviews/widget-config", data);
  return res.data?.data;
};

export const fetchAllQuestions = async (params = {}) => {
  const { pageSize, sortBy, ...rest } = params;
  const res = await httpClient.get(`/api/admin/qna`, {
    params: {
      ...rest,
      limit: pageSize,
      sort: sortBy,
    },
    timeout: 60000,
    skipRetry: true,
  });
  return res.data?.data;
};

export const fetchQuestions = async (productId, params = {}) => {
  const { pageSize, sortBy, ...rest } = params;
  const res = await httpClient.get(`/api/admin/qna/${productId}`, {
    params: {
      ...rest,
      size: pageSize,
      sort: sortBy,
    },
  });
  return res.data?.data;
};

export const createQuestion = async (productId, data) => {
  const res = await httpClient.post(`/api/admin/qna/${productId}`, data);
  return res.data?.data;
};

export const answerQuestion = async (productId, questionId, data) => {
  const res = await httpClient.patch(`/api/admin/qna/${productId}/${questionId}/answer`, data);
  return res.data?.data;
};

export const updateQuestionStatus = async (productId, questionId, data) => {
  const res = await httpClient.patch(`/api/admin/qna/${productId}/${questionId}/status`, data);
  return res.data?.data;
};

export const updateQuestion = async (productId, questionId, data) => {
  const res = await httpClient.patch(`/api/admin/qna/${productId}/${questionId}`, data);
  return res.data?.data;
};

export const deleteQuestion = async (productId, questionId) => {
  const res = await httpClient.delete(`/api/admin/qna/${productId}/${questionId}`);
  return res.data?.data;
};

export const exportReviews = async (format = "csv") => {
  const res = await httpClient.get("/api/admin/reviews/export", { params: { format }, timeout: 120000 });
  return res.data?.data;
};

export const importReviews = async ({ format, body, dryRun }) => {
  const path = dryRun ? "/api/admin/reviews/import/dry-run" : "/api/admin/reviews/import";
  const res = await httpClient.post(path, { format, body, dryRun: dryRun === true }, { timeout: 120000, skipRetry: true });
  return res.data?.data;
};

export const fetchReviewImportHistory = async () => {
  const res = await httpClient.get("/api/admin/reviews/import/history");
  return res.data?.data;
};

export const bulkReviews = async (action, items) => {
  const res = await httpClient.post("/api/admin/reviews/bulk", { action, items }, { timeout: 120000 });
  return res.data?.data;
};

export const fetchWidgetConfigRevisions = async () => {
  const res = await httpClient.get("/api/admin/reviews/widget-config/revisions");
  return res.data?.data;
};

export const restoreWidgetConfigRevision = async (revisionId) => {
  const res = await httpClient.post(`/api/admin/reviews/widget-config/revisions/${revisionId}/restore`);
  return res.data?.data;
};

export const exportQuestions = async (format = "csv") => {
  const res = await httpClient.get("/api/admin/qna/export", { params: { format }, timeout: 120000 });
  return res.data?.data;
};

export const importQuestions = async ({ format, body, dryRun }) => {
  const path = dryRun ? "/api/admin/qna/import/dry-run" : "/api/admin/qna/import";
  const res = await httpClient.post(path, { format, body, dryRun: dryRun === true }, { timeout: 120000, skipRetry: true });
  return res.data?.data;
};

export const bulkQuestions = async (action, items) => {
  const res = await httpClient.post("/api/admin/qna/bulk", { action, items }, { timeout: 120000 });
  return res.data?.data;
};

export const fetchOutboundEndpoints = async () => {
  const res = await httpClient.get("/api/admin/outbound-webhooks");
  return res.data?.data;
};

export const fetchOutboundEvents = async () => {
  const res = await httpClient.get("/api/admin/outbound-webhooks/events");
  return res.data?.data;
};

export const createOutboundEndpoint = async (data) => {
  const res = await httpClient.post("/api/admin/outbound-webhooks", data);
  return res.data?.data;
};

export const updateOutboundEndpoint = async (id, data) => {
  const res = await httpClient.put(`/api/admin/outbound-webhooks/${id}`, data);
  return res.data?.data;
};

export const deleteOutboundEndpoint = async (id) => {
  const res = await httpClient.delete(`/api/admin/outbound-webhooks/${id}`);
  return res.data?.data;
};

export const rotateOutboundSecret = async (id) => {
  const res = await httpClient.post(`/api/admin/outbound-webhooks/${id}/rotate-secret`);
  return res.data?.data;
};

export const testOutboundEndpoint = async (id) => {
  const res = await httpClient.post(`/api/admin/outbound-webhooks/${id}/test`);
  return res.data?.data;
};

export const fetchOutboundDeliveries = async (id, params = {}) => {
  const res = await httpClient.get(`/api/admin/outbound-webhooks/${id}/deliveries`, { params });
  return res.data?.data;
};

export const fetchAiStatus = async () => {
  const res = await httpClient.get("/api/admin/ai/status");
  return res.data?.data;
};

export const suggestReviewReply = async (payload) => {
  const res = await httpClient.post("/api/admin/ai/reply-suggestion", payload, { timeout: 30000, skipRetry: true });
  return res.data?.data;
};

export const syncOpsOrders = async (data = {}) => {
  const res = await httpClient.post("/api/admin/ops/orders/sync", data, { timeout: 120000, skipRetry: true });
  return res.data?.data;
};

export const syncOpsMetafields = async () => {
  const res = await httpClient.post("/api/admin/ops/metafields/sync-all", {}, { timeout: 120000, skipRetry: true });
  return res.data?.data;
};

export const exportOpsDiagnostics = async () => {
  const res = await httpClient.get("/api/admin/ops/diagnostics/export", { timeout: 60000 });
  return res.data?.data;
};
