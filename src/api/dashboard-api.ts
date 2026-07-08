import { apiClient } from './api-client';

export const fetchDashboardOverview = () =>
  apiClient.get('/admin/dashboard/overview').then(r => r.data);
