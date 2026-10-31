import { BadRequestException } from '@nestjs/common';
import type { MediaItem } from './interfaces/review.interface';
import type { FormMode, WidgetConfig } from './interfaces/widget-config.interface';

const MAX_MEDIA_ITEMS = 5;
const MAX_MEDIA_URL_LENGTH = 2000;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']);
const VIMEO_HOSTS = new Set(['vimeo.com', 'www.vimeo.com', 'player.vimeo.com']);

export type PublicReviewInput = {
  rating: number;
  content: string;
  author: string;
  title?: string;
  email?: string;
  phone?: string;
  media: MediaItem[];
};

export type PublicIdentity = { email?: string; phone?: string };

export type ReviewFormFields = {
  content: string;
  title?: string;
  email?: string;
  phone?: string;
};

export const formMode = (value: unknown): FormMode =>
  value === 'hidden' || value === 'required' ? value : 'optional';

const enforceMode = (mode: FormMode, field: string, value: string | undefined): string | undefined => {
  if (mode === 'hidden') return undefined;
  if (mode === 'required' && !value) {
    throw new BadRequestException({ code: `${field}_required`, message: `${field} is required` });
  }
  return value || undefined;
};

export const applyFormModes = (config: WidgetConfig, input: PublicReviewInput): ReviewFormFields => ({
  content: enforceMode(formMode(config.formContentMode), 'content', input.content) ?? '',
  title: enforceMode(formMode(config.formTitleMode), 'title', input.title),
  email: enforceMode(formMode(config.formEmailMode), 'email', input.email),
  phone: enforceMode(formMode(config.formPhoneMode), 'phone', input.phone),
});

const parseHttpsUrl = (value: string): URL | null => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
};

export const sanitizePublicMedia = (
  raw: unknown,
  scope: { publicDomain: string; storeDomain: string; productId: string },
): MediaItem[] => {
  if (!Array.isArray(raw)) return [];
  const publicHost = scope.publicDomain.trim().toLowerCase();
  const uploadPrefix = `/reviews/${scope.storeDomain}/${scope.productId}/`;
  const out: MediaItem[] = [];
  for (const item of raw.slice(0, MAX_MEDIA_ITEMS) as unknown[]) {
    if (typeof item !== 'object' || item === null || !('url' in item) || !('type' in item)) continue;
    const { url: rawUrl, type } = item;
    if (typeof rawUrl !== 'string' || rawUrl.length > MAX_MEDIA_URL_LENGTH) continue;
    if (type !== 'image' && type !== 'video') continue;
    const url = parseHttpsUrl(rawUrl.trim());
    if (!url) continue;
    const host = url.host.toLowerCase();
    const ownUpload = publicHost !== '' && host === publicHost && url.pathname.startsWith(uploadPrefix);
    const embed = type === 'video' && (YOUTUBE_HOSTS.has(host) || VIMEO_HOSTS.has(host));
    if (ownUpload || embed) out.push({ url: url.href, type });
  }
  return out;
};
