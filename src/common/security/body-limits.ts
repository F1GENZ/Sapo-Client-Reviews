import express from 'express';
import type { NextFunction, Request, Response } from 'express';

export const PUBLIC_JSON_BODY_LIMIT = '256kb';
export const WEBHOOK_PATH = '/api/oauth/install/webhooks';

type RawBodyRequest = Request & { rawBody?: Buffer };

const captureRawBody = (req: RawBodyRequest, _res: Response, buf: Buffer): void => {
  if (buf?.length) req.rawBody = Buffer.from(buf);
};

const webhookContentTypeGuard = (req: Request, res: Response, next: NextFunction): void => {
  if (req.method === 'GET') {
    next();
    return;
  }
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    res.status(415).json({ error: 'Webhook content-type must be application/json' });
    return;
  }
  next();
};

export const applyRequestBodyLimits = (
  app: express.Express,
  limits: { requestLimit: string; webhookLimit: string; publicLimit?: string },
): void => {
  app.use(WEBHOOK_PATH, webhookContentTypeGuard);
  app.use(WEBHOOK_PATH, express.json({ limit: limits.webhookLimit, verify: captureRawBody }));
  app.use('/api/public', express.json({ limit: limits.publicLimit ?? PUBLIC_JSON_BODY_LIMIT }));
  app.use('/api/public', express.urlencoded({ limit: limits.publicLimit ?? PUBLIC_JSON_BODY_LIMIT, extended: true }));
  app.use(express.json({ limit: limits.requestLimit }));
  app.use(express.urlencoded({ limit: limits.requestLimit, extended: true }));
};
