const STORE_DOMAIN_KEY = "storeDomain";
const AUTH_VERIFIED_KEY = "auth_verified";
const SESSION_TOKEN_KEY = "auth_session_token";
const POST_AUTH_REDIRECT_KEY = "post_auth_redirect";
const STORE_DOMAIN_PATTERN =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/;

function getStorage(type) {
  if (typeof window === "undefined") return null;
  try {
    return window[type];
  } catch {
    return null;
  }
}

export function normalizeStoreDomain(value) {
  const text = String(value || "").trim().toLowerCase();
  return STORE_DOMAIN_PATTERN.test(text) ? text : null;
}

function getUrlStoreDomain() {
  if (typeof window === "undefined") return null;
  return normalizeStoreDomain(new URLSearchParams(window.location.search).get("storeDomain"));
}

function scopedKey(key, storeDomain) {
  const normalized = normalizeStoreDomain(storeDomain);
  return normalized ? `${key}:${normalized}` : key;
}

function getValue(key) {
  const local = getStorage("localStorage");
  const session = getStorage("sessionStorage");
  return session?.getItem(key) || local?.getItem(key) || null;
}

function setValue(key, value, { persistent = true } = {}) {
  const normalized = String(value);
  if (persistent) {
    getStorage("localStorage")?.setItem(key, normalized);
  } else {
    getStorage("localStorage")?.removeItem(key);
  }
  getStorage("sessionStorage")?.setItem(key, normalized);
}

function removeValue(key) {
  getStorage("localStorage")?.removeItem(key);
  getStorage("sessionStorage")?.removeItem(key);
}

export function syncAuthSession() {
  const storedStoreDomain = normalizeStoreDomain(getValue(STORE_DOMAIN_KEY));
  const storeDomain = getUrlStoreDomain();
  const unscopedToken = getValue(SESSION_TOKEN_KEY);
  const unscopedVerified = getValue(AUTH_VERIFIED_KEY);

  if (!storeDomain) return;

  setValue(STORE_DOMAIN_KEY, storeDomain);

  const tokenKey = scopedKey(SESSION_TOKEN_KEY, storeDomain);
  const verifiedKey = scopedKey(AUTH_VERIFIED_KEY, storeDomain);
  const scopedToken = getValue(tokenKey);
  const canUseUnscopedToken = storedStoreDomain === storeDomain && !!unscopedToken;

  if (!scopedToken && canUseUnscopedToken) {
    setValue(tokenKey, unscopedToken);
    if (unscopedVerified) setValue(verifiedKey, unscopedVerified);
  }

  const sessionToken = getValue(tokenKey) || (canUseUnscopedToken ? unscopedToken : null);
  const verified = getValue(verifiedKey) || (canUseUnscopedToken ? unscopedVerified : null);

  if (sessionToken) {
    setValue(SESSION_TOKEN_KEY, sessionToken);
    if (verified) setValue(AUTH_VERIFIED_KEY, verified);
  } else {
    removeValue(SESSION_TOKEN_KEY);
    removeValue(AUTH_VERIFIED_KEY);
  }
}

export function getStoreDomain() {
  return getUrlStoreDomain();
}

export function getActiveStoreDomain() {
  return normalizeStoreDomain(getValue(STORE_DOMAIN_KEY));
}

export function getSessionToken(storeDomain = getStoreDomain()) {
  const normalizedStoreDomain = normalizeStoreDomain(storeDomain);
  if (!normalizedStoreDomain) return null;
  const scopedToken = getValue(scopedKey(SESSION_TOKEN_KEY, normalizedStoreDomain));
  if (scopedToken) return scopedToken;
  return getActiveStoreDomain() === normalizedStoreDomain ? getValue(SESSION_TOKEN_KEY) : null;
}

export function isAuthVerified(storeDomain = getStoreDomain()) {
  const normalizedStoreDomain = normalizeStoreDomain(storeDomain);
  if (!normalizedStoreDomain || !getSessionToken(normalizedStoreDomain)) return false;
  const scopedVerified = getValue(scopedKey(AUTH_VERIFIED_KEY, normalizedStoreDomain));
  if (scopedVerified === "1") return true;
  return getActiveStoreDomain() === normalizedStoreDomain && getValue(AUTH_VERIFIED_KEY) === "1";
}

export function setAuthSession(storeDomain, sessionToken) {
  const normalizedStoreDomain = normalizeStoreDomain(storeDomain);
  if (!normalizedStoreDomain) return;
  setValue(STORE_DOMAIN_KEY, normalizedStoreDomain);

  if (!sessionToken) {
    clearAuthSession(normalizedStoreDomain);
    return;
  }

  setValue(scopedKey(SESSION_TOKEN_KEY, normalizedStoreDomain), sessionToken);
  setValue(scopedKey(AUTH_VERIFIED_KEY, normalizedStoreDomain), "1");
  setValue(SESSION_TOKEN_KEY, sessionToken);
  setValue(AUTH_VERIFIED_KEY, "1");
}

export function clearAuthSession(storeDomain = getStoreDomain()) {
  const normalizedStoreDomain = normalizeStoreDomain(storeDomain);
  if (normalizedStoreDomain) {
    removeValue(scopedKey(SESSION_TOKEN_KEY, normalizedStoreDomain));
    removeValue(scopedKey(AUTH_VERIFIED_KEY, normalizedStoreDomain));
  }
  if (!normalizedStoreDomain || getActiveStoreDomain() === normalizedStoreDomain) {
    removeValue(STORE_DOMAIN_KEY);
    removeValue(AUTH_VERIFIED_KEY);
    removeValue(SESSION_TOKEN_KEY);
  }
}

export function setPostAuthRedirect(path) {
  if (!path || path.startsWith("/install") || path.startsWith("/oauth")) return;
  const storeDomain = getStoreDomain();
  if (storeDomain) {
    getStorage("localStorage")?.setItem(scopedKey(POST_AUTH_REDIRECT_KEY, storeDomain), path);
  }
  getStorage("localStorage")?.setItem(POST_AUTH_REDIRECT_KEY, path);
}

export function consumePostAuthRedirect(storeDomain = getStoreDomain()) {
  const redirectKey = storeDomain ? scopedKey(POST_AUTH_REDIRECT_KEY, storeDomain) : POST_AUTH_REDIRECT_KEY;
  const value =
    getStorage("localStorage")?.getItem(redirectKey) ||
    (!storeDomain ? getStorage("localStorage")?.getItem(POST_AUTH_REDIRECT_KEY) : null);
  getStorage("localStorage")?.removeItem(redirectKey);
  getStorage("localStorage")?.removeItem(POST_AUTH_REDIRECT_KEY);
  if (!value || value.startsWith("/install") || value.startsWith("/oauth")) {
    return null;
  }
  return value;
}
