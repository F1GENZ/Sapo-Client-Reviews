import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { appEnv } from '../config/env';
import { clearStoredDomain, getStoredDomain } from '../lib/store-context';

type RetryConfig = InternalAxiosRequestConfig & {
  _transientRetryDone?: boolean;
};

const OAUTH_PATH_REGEX = /^\/?oauth\//i;
const TRANSIENT_STATUSES = new Set([502, 503, 504]);

const isOAuthPath = (url: string | undefined): boolean => OAUTH_PATH_REGEX.test(url || '');

const isIdempotentMethod = (method: string | undefined): boolean => {
  const normalized = (method || 'get').toLowerCase();
  return normalized === 'get' || normalized === 'head' || normalized === 'options';
};

export const apiClient = axios.create({
  baseURL: appEnv.apiBaseUrl,
  withCredentials: true,
  headers: {
    Accept: 'application/json',
  },
});

apiClient.interceptors.request.use((config) => {
  if (!isOAuthPath(config.url)) {
    const storeDomain = getStoredDomain();
    if (storeDomain) config.headers.set('x-store-domain', storeDomain);
  }
  return config;
});

apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const config = error.config as RetryConfig | undefined;
    const status = error.response?.status;

    if (status === 401) {
      clearStoredDomain();
      window.dispatchEvent(new CustomEvent('f1genz-sapo:unauthorized'));
    }

    if (
      config &&
      !config._transientRetryDone &&
      !isOAuthPath(config.url) &&
      isIdempotentMethod(config.method) &&
      (!status || TRANSIENT_STATUSES.has(status))
    ) {
      config._transientRetryDone = true;
      return apiClient.request(config);
    }

    return Promise.reject(error);
  },
);
