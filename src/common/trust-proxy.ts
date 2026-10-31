import { isIP } from 'net';

export const MAX_TRUST_PROXY_HOPS = 10;
const NAMED_RANGES = ['loopback', 'linklocal', 'uniquelocal'];

export type TrustProxyValue = false | number | string;
export type TrustProxyParseResult =
  | { ok: true; value: TrustProxyValue }
  | { ok: false; error: string };

const isTrustedEntry = (entry: string): boolean => {
  if (NAMED_RANGES.includes(entry.toLowerCase())) return true;
  const [address, prefix, ...rest] = entry.split('/');
  if (rest.length) return false;
  const family = isIP(address);
  if (family === 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d+$/.test(prefix)) return false;
  return Number(prefix) <= (family === 4 ? 32 : 128);
};

export const parseTrustProxy = (raw: string): TrustProxyParseResult => {
  const value = raw.trim();
  if (!value || value.toLowerCase() === 'false' || value === '0') {
    return { ok: true, value: false };
  }
  if (value.toLowerCase() === 'true') {
    return { ok: false, error: 'TRUST_PROXY must not be true; use false, a hop count 1-10, or a proxy IP/CIDR allowlist' };
  }
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (!Number.isSafeInteger(hops) || hops < 1 || hops > MAX_TRUST_PROXY_HOPS) {
      return { ok: false, error: `TRUST_PROXY hop count must be between 1 and ${MAX_TRUST_PROXY_HOPS}` };
    }
    return { ok: true, value: hops };
  }
  const entries = value.split(',').map((entry) => entry.trim());
  if (entries.some((entry) => !entry) || !entries.every(isTrustedEntry)) {
    return { ok: false, error: 'TRUST_PROXY must be false, a hop count 1-10, or a comma-separated list of proxy IPs, CIDRs, loopback, linklocal, uniquelocal' };
  }
  return { ok: true, value: entries.join(',') };
};
