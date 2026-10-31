import axios from "axios";
import { reportClientError } from "../common/ErrorReporter";
import {
  clearAuthSession,
  getStoreDomain,
  getSessionToken,
  setPostAuthRedirect,
  syncAuthSession,
} from "../common/AuthStorage";
import { buildLoginPath } from "../common/routes";

const httpClient = axios.create({
  baseURL: "", // Force relative URLs (/api/...) for Cloudflare proxy
  timeout: 12000,
  headers: {
    "Content-Type": "application/json",
    "Accept": "application/json",
  },
  withCredentials: true,
});

httpClient.interceptors.request.use(
  async (config) => {
    if (typeof FormData !== "undefined" && config.data instanceof FormData) {
      if (typeof config.headers?.delete === "function") {
        config.headers.delete("Content-Type");
      } else if (config.headers) {
        delete config.headers["Content-Type"];
        delete config.headers["content-type"];
      }
    }

    const isOAuthRequest =
      typeof config.url === "string" && config.url.startsWith("/api/oauth/");

    if (!isOAuthRequest) {
      syncAuthSession();
      const storeDomain = getStoreDomain();
      if (storeDomain) {
        config.headers["x-store-domain"] = storeDomain;
      }

      const sessionToken = getSessionToken();
      if (sessionToken) {
        config.headers.Authorization = `Bearer ${sessionToken}`;
      }
    }
    return config;
  },
  (err) => Promise.reject(err)
);

httpClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const config = error.config || {};
    const status = error.response?.status;

    const retryableStatus = [408, 500, 502, 503, 504];
    const isIdempotent = !config.method || ["get", "head", "options"].includes(config.method.toLowerCase());
    const shouldRetry =
      !config.skipRetry &&
      isIdempotent &&
      (!status ||
      retryableStatus.includes(status) ||
      error.code === "ECONNABORTED");

    config.__retryCount = config.__retryCount || 0;

    if (shouldRetry && config.__retryCount < 2) {
      config.__retryCount += 1;
      const retryAfterHeader =
        error.response?.headers?.["retry-after"] ??
        error.response?.headers?.["Retry-After"] ??
        (typeof error.response?.headers?.get === "function"
          ? error.response.headers.get("retry-after")
          : undefined);
      const retryAfterSeconds = Number(Array.isArray(retryAfterHeader)
        ? retryAfterHeader[0]
        : retryAfterHeader);
      const retryAfterDelay =
        Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? retryAfterSeconds * 1000
          : null;
      const delay = retryAfterDelay ?? 1500 * Math.pow(2, config.__retryCount - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return httpClient(config);
    }

    if (status === 401 && !config.skipAuthRedirect) {
      const storeDomain = getStoreDomain();

      setPostAuthRedirect(window.location.pathname + window.location.search + window.location.hash);
      clearAuthSession(storeDomain);
      window.location.href = buildLoginPath({ storeDomain, error: "session_expired" });

      return new Promise(() => {});
    }

    reportClientError("axios", error, {
      url: config.url,
      method: config.method,
      retryCount: config.__retryCount || 0,
    });

    return Promise.reject(error);
  }
);

export default httpClient;
