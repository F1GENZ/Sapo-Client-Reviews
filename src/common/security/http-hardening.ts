import type express from 'express';
import type { AppEnv } from '../../config/env.schema';
import { applyRequestBodyLimits } from './body-limits';
import type { IngressRateLimitService } from './ingress-rate-limit.service';
import { getAllowedAdminOrigins } from './origin-policy';
import { publicRateLimitMiddleware } from './public-rate-limit';
import { applySecurityHeaders, corsMiddleware } from './security-headers';

export type HttpHardeningEnv = Pick<
  AppEnv,
  'FRONTEND_URL' | 'API_BASE_URL' | 'CORS_ALLOWED_ORIGINS' | 'TRUST_PROXY' | 'REQUEST_BODY_LIMIT' | 'WEBHOOK_BODY_LIMIT'
>;

export const applyHttpHardening = (
  instance: express.Express,
  env: HttpHardeningEnv,
  rateLimit: IngressRateLimitService,
): void => {
  instance.disable('x-powered-by');
  instance.set('trust proxy', env.TRUST_PROXY);
  instance.use(applySecurityHeaders);
  instance.use(corsMiddleware({
    adminOrigins: getAllowedAdminOrigins({
      frontendUrl: env.FRONTEND_URL,
      apiBaseUrl: env.API_BASE_URL,
      allowedOrigins: env.CORS_ALLOWED_ORIGINS,
    }),
  }));
  instance.use('/api/public', publicRateLimitMiddleware(rateLimit));
  applyRequestBodyLimits(instance, {
    requestLimit: env.REQUEST_BODY_LIMIT,
    webhookLimit: env.WEBHOOK_BODY_LIMIT,
  });
};
