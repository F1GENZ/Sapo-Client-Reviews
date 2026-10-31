const ENCRYPTION_KEY_BYTES = 32;
const SAMPLE_KEY_BYTES = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');

const PLACEHOLDER_PATTERN = /(replace-with|change-me|changeme|placeholder|your-|todo)/i;

export const SAMPLE_ENCRYPTION_KEYS: readonly string[] = [
  SAMPLE_KEY_BYTES.toString('base64'),
  SAMPLE_KEY_BYTES.toString('hex'),
];

export const isPlaceholderSecret = (value: string): boolean => PLACEHOLDER_PATTERN.test(value);

const decodeEncryptionKey = (value: string): Buffer =>
  /^[a-f0-9]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');

export const assertUsableSecret = (
  name: string,
  value: string | undefined,
  opts: { minBytes?: number } = {},
): string => {
  const secret = typeof value === 'string' ? value.trim() : '';
  if (!secret) throw new Error(`${name} is required`);
  if (isPlaceholderSecret(secret)) throw new Error(`${name} must not be a placeholder`);
  if (opts.minBytes && Buffer.byteLength(secret, 'utf8') < opts.minBytes) {
    throw new Error(`${name} must be at least ${opts.minBytes} bytes`);
  }
  return value as string;
};

export const assertEncryptionKey = (value: string | undefined): Buffer => {
  const raw = assertUsableSecret('DATA_ENCRYPTION_KEY', value);
  const key = decodeEncryptionKey(raw.trim());
  if (key.length !== ENCRYPTION_KEY_BYTES) {
    throw new Error('DATA_ENCRYPTION_KEY must decode to exactly 32 bytes from base64 or hex');
  }
  if (SAMPLE_ENCRYPTION_KEYS.includes(raw.trim()) || key.equals(SAMPLE_KEY_BYTES)) {
    throw new Error('DATA_ENCRYPTION_KEY must not be the public sample key');
  }
  return key;
};
