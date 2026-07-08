import { apiClient } from './api-client';

export const fetchHealth = () => apiClient.get('/admin/ops/health').then(r => r.data);
export const resyncConfig = () => apiClient.post('/admin/ops/resync-config').then(r => r.data);
export const resyncWebhooks = () => apiClient.post('/admin/ops/resync-webhooks').then(r => r.data);
export const backfillCatalog = () => apiClient.post('/admin/ops/backfill-catalog').then(r => r.data);
