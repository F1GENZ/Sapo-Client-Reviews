import type { NextFunction, Request, Response } from 'express';
import { normalizeRequestPath } from './public-response';

export const CORS_METHODS = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';
export const CORS_ALLOWED_HEADERS =
  'Accept,Authorization,Content-Type,Origin,Referer,X-Store-Domain,Store-Domain,X-Sapo-Hmac,X-Sapo-HmacSha256,X-Sapo-Topic';
const PREFLIGHT_MAX_AGE_SECONDS = '86400';

export type CorsPolicy = {
  adminOrigins: ReadonlySet<string>;
};

export const isPublicStorefrontPath = (path: string): boolean =>
  path === '/api/public' ||
  path.startsWith('/api/public/') ||
  path === '/storefront' ||
  path.startsWith('/storefront/');

export const normalizeRequestOrigin = (value: unknown): string => {
  if (typeof value !== 'string' || !value) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    return url.origin.toLowerCase();
  } catch {
    return '';
  }
};

export const resolveCorsHeaders = (
  origin: string,
  path: string,
  policy: CorsPolicy,
): Record<string, string> | null => {
  if (!origin) return null;
  const base = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': CORS_METHODS,
    'Access-Control-Allow-Headers': CORS_ALLOWED_HEADERS,
  };
  if (policy.adminOrigins.has(origin)) {
    return { ...base, 'Access-Control-Allow-Credentials': 'true' };
  }
  return isPublicStorefrontPath(path) ? base : null;
};

export const corsMiddleware = (policy: CorsPolicy) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const rawOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    const origin = normalizeRequestOrigin(rawOrigin);
    const isPreflight = req.method === 'OPTIONS';
    if (rawOrigin) res.vary('Origin');

    const headers = resolveCorsHeaders(origin, req.path, policy);
    if (headers) {
      res.set(headers);
      if (isPreflight) res.set('Access-Control-Max-Age', PREFLIGHT_MAX_AGE_SECONDS);
    }
    if (isPreflight) {
      const rejected = Boolean(rawOrigin) && !headers && !isPublicStorefrontPath(req.path);
      res.status(rejected ? 403 : 204).end();
      return;
    }
    next();
  };

export const applySecurityHeaders = (req: Request, res: Response, next: NextFunction): void => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.removeHeader('X-Powered-By');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  const path = normalizeRequestPath(req.path || '');
  if (path === '/api' || path.startsWith('/api/')) {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
  }
  if (path.startsWith('/api/oauth/')) {
    res.setHeader('Pragma', 'no-cache');
  }

  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  if (req.secure || forwardedProto === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  }
  next();
};
