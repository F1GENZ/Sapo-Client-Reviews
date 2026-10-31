import type { NextFunction, Request, Response } from 'express';
import { clientFingerprint } from './client-fingerprint';
import type { IngressRateLimitService } from './ingress-rate-limit.service';
import { STORE_DOMAIN_RE } from './public-limits';

export const PUBLIC_RATE_WINDOW_SECONDS = 60;
export const PUBLIC_READ_CLIENT_LIMIT = 900;
export const PUBLIC_WRITE_CLIENT_LIMIT = 120;

const firstString = (value: unknown): string => {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === 'string' ? candidate.trim().toLowerCase() : '';
};

// The store domain is unauthenticated: it may narrow a bucket, never replace the client bucket.
export const resolveStoreScope = (req: Request): string | null => {
  for (const candidate of [firstString(req.headers['x-store-domain']), firstString(req.query?.storeDomain)]) {
    if (candidate && STORE_DOMAIN_RE.test(candidate)) return candidate;
  }
  return null;
};

export const publicRateLimitMiddleware = (rateLimit: IngressRateLimitService) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (req.method === 'OPTIONS') {
      next();
      return;
    }
    try {
      const isRead = req.method === 'GET' || req.method === 'HEAD';
      const clientResult = await rateLimit.check(
        isRead ? 'public-read-client' : 'public-write-client',
        clientFingerprint(req),
        PUBLIC_RATE_WINDOW_SECONDS,
        isRead ? PUBLIC_READ_CLIENT_LIMIT : PUBLIC_WRITE_CLIENT_LIMIT,
      );
      const denied = clientResult.allowed ? null : clientResult;
      if (denied) {
        res.setHeader('Retry-After', String(denied.resetInSeconds));
        res.status(429).json({
          statusCode: 429,
          message: `Rate limit exceeded; retry in ${denied.resetInSeconds}s`,
        });
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
