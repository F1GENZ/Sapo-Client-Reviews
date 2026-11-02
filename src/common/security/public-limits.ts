export const PUBLIC_MAX_OFFSET = 10_000;

export const NUMERIC_ID_RE = /^\d{1,20}$/;

export const STORE_DOMAIN_RE =
  /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;

export const STRICT_EMAIL_RE =
  /^[A-Za-z0-9_%+-]+(?:\.[A-Za-z0-9_%+-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

export const isNonEmptyValue = (_object: unknown, value: unknown): boolean =>
  value !== undefined && value !== null && value !== '';

export const PHONE_DIGITS_MIN = 8;
export const PHONE_DIGITS_MAX = 15;

export const isValidPhone = (value: string): boolean => {
  const digits = value.replace(/\D/g, '');
  return digits.length >= PHONE_DIGITS_MIN && digits.length <= PHONE_DIGITS_MAX;
};
