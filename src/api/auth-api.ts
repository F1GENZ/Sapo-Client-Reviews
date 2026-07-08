import { apiClient } from './api-client';

export type AuthStartResponse = {
  url: string;
  reason?: string;
};

export type HandoffResponse = {
  handoffCode: string;
  storeDomain: string;
  redirectTo: string;
};

export type AuthFlowResponse = AuthStartResponse | HandoffResponse;

export type SessionExchangeResponse = {
  ok: true;
  storeDomain: string;
  redirectTo: string;
};

export type SessionProbeResponse = {
  storeDomain: string;
  shopDomain?: string;
  status: string;
  featuresUnlocked: boolean;
  webhookStatus: string;
};

export const isAuthStartResponse = (value: AuthFlowResponse): value is AuthStartResponse =>
  'url' in value;

export const isHandoffResponse = (value: AuthFlowResponse): value is HandoffResponse =>
  'handoffCode' in value;

export const verifyLaunchHmac = async (rawSearch: string): Promise<AuthFlowResponse> => {
  const suffix = rawSearch.startsWith('?') ? rawSearch : `?${rawSearch}`;
  const { data } = await apiClient.get<AuthFlowResponse>(`/oauth/install/login/verify-hmac${suffix}`);
  return data;
};

export const startLogin = async (input: { storeDomain?: string | null; redirectTo?: string } = {}): Promise<AuthStartResponse> => {
  const { data } = await apiClient.get<AuthStartResponse>('/oauth/install/login', {
    params: {
      ...(input.storeDomain ? { storeDomain: input.storeDomain } : {}),
      ...(input.redirectTo ? { redirect: input.redirectTo } : {}),
    },
  });
  return data;
};

export const processGrandserviceCallback = async (code: string, state: string | null): Promise<HandoffResponse> => {
  const { data } = await apiClient.post<HandoffResponse>('/oauth/install/callback', { code, ...(state ? { state } : {}) });
  return data;
};

export const exchangeSession = async (handoffCode: string): Promise<SessionExchangeResponse> => {
  const { data } = await apiClient.post<SessionExchangeResponse>('/auth/session/exchange', { handoffCode });
  return data;
};

export const logout = async (): Promise<void> => {
  await apiClient.post('/auth/logout');
};

export const getSessionProbe = async (): Promise<SessionProbeResponse> => {
  const { data } = await apiClient.get<SessionProbeResponse>('/app/session');
  return data;
};
