const STORE_DOMAIN_REGEX = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;
const STORE_CONTEXT_KEY = 'f1genz-sapo:storeDomain';

const safeSessionStorage = (): Storage | null => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

export const isValidStoreDomain = (value: unknown): value is string =>
  typeof value === 'string' && STORE_DOMAIN_REGEX.test(value);

export const rememberStoreDomain = (storeDomain: unknown): void => {
  if (!isValidStoreDomain(storeDomain)) return;
  safeSessionStorage()?.setItem(STORE_CONTEXT_KEY, storeDomain);
};

export const getStoredDomain = (): string | null => {
  const value = safeSessionStorage()?.getItem(STORE_CONTEXT_KEY) || null;
  return isValidStoreDomain(value) ? value : null;
};

export const clearStoredDomain = (): void => {
  safeSessionStorage()?.removeItem(STORE_CONTEXT_KEY);
};

export const readStoreDomainFromSearch = (search: string): string | null => {
  const value = new URLSearchParams(search).get('storeDomain');
  return isValidStoreDomain(value) ? value : null;
};
