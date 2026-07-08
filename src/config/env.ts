const normalizeApiBaseUrl = (value: string | undefined): string => {
  const trimmed = value?.trim();
  if (!trimmed) return '/api';
  if (trimmed === '/') return '/api';
  return trimmed.replace(/\/$/, '');
};

export const appEnv = {
  apiBaseUrl: normalizeApiBaseUrl(import.meta.env.VITE_API_BASE_URL),
  appName: import.meta.env.VITE_APP_NAME?.trim() || 'F1GENZ Reviews Sapo',
  isDev: import.meta.env.DEV,
};
