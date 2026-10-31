import httpClient from "../config/AxiosConfig";

class AuthService {
  // hmac is Base64 over the sorted params: forward the raw query, never decode or re-serialize it.
  async verifyLaunchQuery(rawQuery) {
    const query = String(rawQuery || "").replace(/^\?/, "");
    const response = await fetch(`/api/oauth/install/login/verify-hmac?${query}`, {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      signal: AbortSignal.timeout(12000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(`verify-hmac failed with ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return body;
  }

  async entry(storeDomain) {
    const params = new URLSearchParams({ storeDomain });
    const response = await httpClient.get(`/api/oauth/install/login/entry?${params.toString()}`, {
      skipRetry: true,
      skipAuthRedirect: true,
    });
    return response.data || {};
  }
}

export const authService = new AuthService();
