export interface SapoProductImage {
  id: number;
  src: string;
}

export interface SapoProduct {
  id: number;
  name: string;
  alias: string;
  published_on: string | null;
  vendor?: string;
  product_type?: string;
  tags?: string;
  images?: SapoProductImage[];
}

export interface GetProductsParams {
  page?: number;
  limit?: number;
  title?: string;
  vendor?: string;
  handle?: string;
  product_type?: string;
  collection_id?: number;
  created_at_min?: string;
  created_at_max?: string;
  updated_at_min?: string;
  updated_at_max?: string;
  published_at_min?: string;
  published_at_max?: string;
  published_status?: 'published' | 'unpublished' | 'any';
  fields?: string;
  ids?: string;
  since_id?: number;
}

export interface GetProductsCountParams {
  vendor?: string;
  product_type?: string;
  collection_id?: number;
  created_at_min?: string;
  created_at_max?: string;
  updated_at_min?: string;
  updated_at_max?: string;
  published_at_min?: string;
  published_at_max?: string;
  published_status?: 'published' | 'unpublished' | 'any';
}

export type SapoMetafieldValueType = 'string' | 'integer';

export interface SapoMetafield {
  id: number;
  namespace: string;
  key: string;
  value: string | number;
  value_type: SapoMetafieldValueType;
  owner_id: number;
  owner_resource: string;
  created_at: string;
  updated_at: string;
  description?: string;
}

export type SapoMetafieldOwnerResource = 'shop' | 'product' | 'collection' | 'order' | 'customer';

export interface SapoMetafieldCreatePayload {
  namespace: string;
  key: string;
  value: string | number;
  value_type: SapoMetafieldValueType;
  owner_id?: number;
  owner_resource?: SapoMetafieldOwnerResource;
  description?: string;
}

export interface SapoMetafieldUpdatePayload {
  namespace?: string;
  value?: string | number;
  value_type?: SapoMetafieldValueType;
  description?: string;
}

export function normalizeMetafieldPayload(
  payload: SapoMetafieldCreatePayload | SapoMetafieldUpdatePayload,
): SapoMetafieldCreatePayload | SapoMetafieldUpdatePayload {
  const value = payload.value;
  if (
    value !== null &&
    value !== undefined &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    return {
      ...payload,
      value: JSON.stringify(value),
      value_type: 'string',
    };
  }
  return payload;
}

export interface SapoWebhook {
  id: number;
  topic: string;
  address: string;
  format: string;
  created_at: string;
  updated_at: string;
}

export interface SapoShop {
  id: number;
  name: string;
  domain: string;
  email: string;
  address1: string;
  city: string;
  province: string;
  country: string;
  phone: string | null;
  created_at: string;
  updated_at: string;
  currency: string;
  timezone: string;
}

export interface OAuthTokenPayload {
  access_token: string;
}

export interface SapoListResponse<T> {
  [key: string]: T[];
}
