export type CanonicalWebhookTopic =
  | 'app/uninstalled'
  | 'store/update'
  | 'products/create'
  | 'products/update'
  | 'products/delete'
  | 'orders/create'
  | 'orders/updated'
  | 'orders/paid'
  | 'orders/cancelled'
  | 'orders/fulfilled'
  | 'unknown';

const UNINSTALL_TOPICS = new Set([
  'app_uninstall_webhook',
  'app_uninstall',
  'app/uninstall',
  'app/uninstalled',
  'apps/uninstall',
  'apps/uninstalled',
  'app_uninstalled',
]);

const STORE_UPDATE_TOPICS = new Set([
  'store/update',
  'stores/update',
  'store_update',
  'stores_update',
  'store_update_webhook',
]);

const PRODUCT_CREATE_TOPICS = new Set([
  'products/create',
  'product/create',
  'products_create',
]);

const PRODUCT_UPDATE_TOPICS = new Set([
  'products/update',
  'product/update',
  'products_update',
]);

const PRODUCT_DELETE_TOPICS = new Set([
  'products/delete',
  'product/delete',
  'products_delete',
]);

const ORDER_CREATE_TOPICS = new Set([
  'orders/create',
  'order/create',
  'orders_create',
]);

const ORDER_UPDATED_TOPICS = new Set([
  'orders/updated',
  'order/updated',
  'orders_updated',
]);

const ORDER_PAID_TOPICS = new Set([
  'orders/paid',
  'order/paid',
  'orders_paid',
]);

const ORDER_CANCELLED_TOPICS = new Set([
  'orders/cancelled',
  'orders/canceled',
  'order/cancelled',
  'orders_cancelled',
]);

const ORDER_FULFILLED_TOPICS = new Set([
  'orders/fulfilled',
  'order/fulfilled',
  'orders_fulfilled',
]);

export const normalizeWebhookTopic = (topic: unknown): CanonicalWebhookTopic => {
  const value = typeof topic === 'string' ? topic.trim().toLowerCase() : '';
  if (UNINSTALL_TOPICS.has(value)) return 'app/uninstalled';
  if (STORE_UPDATE_TOPICS.has(value)) return 'store/update';
  if (PRODUCT_CREATE_TOPICS.has(value)) return 'products/create';
  if (PRODUCT_UPDATE_TOPICS.has(value)) return 'products/update';
  if (PRODUCT_DELETE_TOPICS.has(value)) return 'products/delete';
  if (ORDER_CREATE_TOPICS.has(value)) return 'orders/create';
  if (ORDER_UPDATED_TOPICS.has(value)) return 'orders/updated';
  if (ORDER_PAID_TOPICS.has(value)) return 'orders/paid';
  if (ORDER_CANCELLED_TOPICS.has(value)) return 'orders/cancelled';
  if (ORDER_FULFILLED_TOPICS.has(value)) return 'orders/fulfilled';
  return 'unknown';
};

export const isKnownWebhookTopic = (topic: unknown): boolean =>
  normalizeWebhookTopic(topic) !== 'unknown';

export const WEBHOOK_SUBSCRIBE_TOPICS = [
  'app/uninstalled',
  'store/update',
  'products/create',
  'products/update',
  'products/delete',
  'orders/create',
  'orders/updated',
  'orders/paid',
  'orders/cancelled',
  'orders/fulfilled',
] as const;
