export type SliderSourceReview = {
  id: string | number;
  rating: number;
  author?: string;
  title?: string;
  content?: string;
  media?: unknown;
  verified?: boolean;
  pinned?: boolean;
  created_at: number | string;
};

export type SliderItem = {
  id: string;
  r: number;
  a: string;
  t?: string;
  c: string;
  m?: string;
  v: number;
  d: number;
};

export type SliderPayload = { v: 1; updated_at: number; items: SliderItem[] };

const MAX_PAYLOAD_BYTES = 8000;

const firstImageUrl = (media: unknown): string | undefined => {
  if (!Array.isArray(media)) return undefined;
  for (const entry of media) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    if (item.type !== 'image') continue;
    if (typeof item.url !== 'string' || !/^https?:\/\//.test(item.url)) continue;
    return item.url;
  }
  return undefined;
};

const byCuratedRank = (left: SliderSourceReview, right: SliderSourceReview): number => {
  const pinned = Number(right.pinned === true) - Number(left.pinned === true);
  if (pinned !== 0) return pinned;
  const rating = (Number(right.rating) || 0) - (Number(left.rating) || 0);
  if (rating !== 0) return rating;
  return (Number(right.created_at) || 0) - (Number(left.created_at) || 0);
};

export const resolveSliderSettings = (
  config: { curatedSliderEnabled?: boolean; curatedSliderCount?: number } | null | undefined,
): { enabled: boolean; count: number } => {
  if (!config || config.curatedSliderEnabled === false) return { enabled: false, count: 0 };
  const stored = Number(config.curatedSliderCount);
  const count = Number.isFinite(stored) ? Math.max(5, Math.min(15, Math.trunc(stored))) : 15;
  return { enabled: true, count };
};

export const buildSliderPayload = (
  source: readonly SliderSourceReview[],
  requestedCount: number,
  now: number,
): SliderPayload => {
  const maxItems = Number.isFinite(requestedCount) ? Math.max(5, Math.min(15, Math.trunc(requestedCount))) : 15;
  const items: SliderItem[] = [...source]
    .sort(byCuratedRank)
    .slice(0, maxItems)
    .map((review) => {
      const image = firstImageUrl(review.media);
      const item: SliderItem = {
        id: String(review.id),
        r: Number(review.rating) || 5,
        a: String(review.author || '').slice(0, 80),
        c: review.content ? String(review.content).slice(0, 220) : '',
        v: review.verified === true ? 1 : 0,
        d: Number(review.created_at) || now,
      };
      if (review.title) item.t = String(review.title).slice(0, 60);
      if (image) item.m = image;
      return item;
    });

  const measure = (): number => Buffer.byteLength(JSON.stringify({ v: 1, updated_at: now, items }));
  if (measure() > MAX_PAYLOAD_BYTES) {
    items.forEach((item) => {
      item.c = item.c.slice(0, 160);
    });
  }
  if (measure() > MAX_PAYLOAD_BYTES) {
    items.forEach((item) => {
      item.c = item.c.slice(0, 120);
    });
  }
  if (measure() > MAX_PAYLOAD_BYTES) {
    items.forEach((item) => {
      delete item.t;
    });
  }
  while (items.length > 1 && measure() > MAX_PAYLOAD_BYTES) {
    items.pop();
  }
  return { v: 1, updated_at: now, items };
};
