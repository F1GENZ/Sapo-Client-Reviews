import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { map, type Observable } from 'rxjs';

const REVIEW_FIELDS = [
  'id', 'rating', 'content', 'author', 'title', 'status', 'verified', 'pinned',
  'reply', 'replied_at', 'created_at', 'updated_at',
] as const;

const QUESTION_FIELDS = [
  'id', 'question', 'author', 'answer', 'answered_by', 'status',
  'created_at', 'updated_at', 'answered_at',
] as const;

const PUBLIC_REVIEW_ROW_PATH = /^\/api\/public\/reviews\/\d+\/?$/;
const PUBLIC_QUESTION_ROW_PATH = /^\/api\/public\/qna\/\d+\/?$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const pick = (source: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (source[field] !== undefined) out[field] = source[field];
  }
  return out;
};

export const pickPublicReview = (review: unknown): unknown => {
  if (!isRecord(review)) return review;
  const out = pick(review, REVIEW_FIELDS);
  if (Array.isArray(review.media)) {
    out.media = review.media
      .filter(isRecord)
      .map((item) => ({ url: item.url, type: item.type }));
  }
  return out;
};

export const pickPublicQuestion = (question: unknown): unknown => {
  if (!isRecord(question)) return question;
  return pick(question, QUESTION_FIELDS);
};

const mapPayload = (payload: unknown, pickOne: (row: unknown) => unknown): unknown => {
  if (Array.isArray(payload)) return payload.map(pickOne);
  if (!isRecord(payload)) return payload;
  if (Array.isArray(payload.items)) {
    return { ...pick(payload, ['total', 'page', 'pageSize']), items: payload.items.map(pickOne) };
  }
  return pickOne(payload);
};

export const normalizeRequestPath = (path: string): string => {
  try {
    return decodeURIComponent(path).toLowerCase();
  } catch {
    return path.toLowerCase();
  }
};

export const sanitizePublicResponse = (path: string, body: unknown): unknown => {
  const normalized = normalizeRequestPath(path);
  const pickOne = PUBLIC_REVIEW_ROW_PATH.test(normalized)
    ? pickPublicReview
    : PUBLIC_QUESTION_ROW_PATH.test(normalized)
      ? pickPublicQuestion
      : null;
  if (!pickOne || !isRecord(body) || body.data === undefined) return body;
  return { ...body, data: mapPayload(body.data, pickOne) };
};

@Injectable()
export class PublicResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const path = req.path || '';
    if (normalizeRequestPath(path).startsWith('/api/public') && typeof http.getResponse === 'function') {
      const res = http.getResponse<Response>();
      if (res && typeof res.setHeader === 'function') res.setHeader('Cache-Control', 'no-store');
    }
    return next.handle().pipe(map((body) => sanitizePublicResponse(path, body)));
  }
}
