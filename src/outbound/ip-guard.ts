import { lookup } from 'dns/promises';
import { BadRequestException } from '@nestjs/common';

export type AddressResolver = (hostname: string) => Promise<string[]>;

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

const parseIpv4 = (value: string): number[] | null => {
  const match = IPV4_RE.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map((part) => Number(part));
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts;
};

const inV4 = (parts: number[], prefix: number[], bits: number): boolean => {
  let remaining = bits;
  for (let i = 0; i < 4 && remaining > 0; i += 1) {
    const width = Math.min(8, remaining);
    const mask = (0xff << (8 - width)) & 0xff;
    if ((parts[i] & mask) !== (prefix[i] & mask)) return false;
    remaining -= width;
  }
  return true;
};

const BLOCKED_V4: Array<{ prefix: number[]; bits: number; label: string }> = [
  { prefix: [0, 0, 0, 0], bits: 8, label: 'this-network' },
  { prefix: [10, 0, 0, 0], bits: 8, label: 'private' },
  { prefix: [100, 64, 0, 0], bits: 10, label: 'cgnat' },
  { prefix: [127, 0, 0, 0], bits: 8, label: 'loopback' },
  { prefix: [169, 254, 0, 0], bits: 16, label: 'link-local' },
  { prefix: [172, 16, 0, 0], bits: 12, label: 'private' },
  { prefix: [192, 0, 0, 0], bits: 24, label: 'ietf-protocol' },
  { prefix: [192, 0, 2, 0], bits: 24, label: 'documentation' },
  { prefix: [192, 88, 99, 0], bits: 24, label: 'relay-anycast' },
  { prefix: [192, 168, 0, 0], bits: 16, label: 'private' },
  { prefix: [198, 18, 0, 0], bits: 15, label: 'benchmark' },
  { prefix: [198, 51, 100, 0], bits: 24, label: 'documentation' },
  { prefix: [203, 0, 113, 0], bits: 24, label: 'documentation' },
  { prefix: [224, 0, 0, 0], bits: 4, label: 'multicast' },
  { prefix: [240, 0, 0, 0], bits: 4, label: 'reserved' },
];

const parseIpv6 = (value: string): number[] | null => {
  const trimmed = value.replace(/^\[|\]$/g, '').toLowerCase();
  if (!trimmed.includes(':')) return null;
  const [headRaw, tailRaw] = trimmed.split('%')[0].split('::');
  const head = headRaw ? headRaw.split(':').filter(Boolean) : [];
  const tail = tailRaw ? tailRaw.split(':').filter(Boolean) : [];
  const groups: string[] = [];
  const expand = (list: string[]): string[] => {
    const out: string[] = [];
    for (const group of list) {
      if (group.includes('.')) {
        const parts = parseIpv4(group);
        if (!parts) return [];
        out.push(((parts[0] << 8) | parts[1]).toString(16), ((parts[2] << 8) | parts[3]).toString(16));
      } else {
        out.push(group);
      }
    }
    return out;
  };
  const headGroups = expand(head);
  const tailGroups = expand(tail);
  if (trimmed.includes('::')) {
    const missing = 8 - headGroups.length - tailGroups.length;
    if (missing < 0) return null;
    groups.push(...headGroups, ...Array<string>(missing).fill('0'), ...tailGroups);
  } else {
    groups.push(...headGroups, ...tailGroups);
  }
  if (groups.length !== 8) return null;
  const numbers: number[] = [];
  for (const group of groups) {
    const parsed = Number.parseInt(group, 16);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 0xffff) return null;
    numbers.push(parsed);
  }
  return numbers;
};

const embeddedV4 = (groups: number[]): string =>
  `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;

const isPublicV6 = (groups: number[], depth = 0): boolean => {
  if (depth > 2) return false;
  const allZero = groups.every((group) => group === 0);
  if (allZero) return false;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return false;
  const first = groups[0];
  if ((first & 0xfe00) === 0xfc00) return false;
  if ((first & 0xff00) === 0xff00) return false;
  if ((first & 0xffc0) === 0xfe80) return false;
  if ((first & 0xffe0) === 0xfec0) return false;
  if (first === 0x0064 && groups[1] === 0xff9b) return false;
  if (first === 0x2001 && groups[1] === 0x0db8) return false;
  if (first === 0x2001 && (groups[1] & 0xfff0) === 0x0010) return false;
  if (first === 0x2001 && groups[1] === 0x0000 && depth === 0) {
    const inner = embeddedV4(groups);
    const parts = parseIpv4(inner);
    if (parts) return isPublicV4(parts);
    return false;
  }
  if (first === 0x2002 && depth === 0) {
    const inner = embeddedV4(groups);
    const parts = parseIpv4(inner);
    if (parts) return isPublicV4(parts);
    return false;
  }
  if (groups.slice(0, 4).every((group) => group === 0) && groups[4] === 0xffff && depth === 0) {
    const parts = parseIpv4(embeddedV4(groups));
    if (parts) return isPublicV4(parts);
    return false;
  }
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff && depth === 0) {
    const parts = parseIpv4(embeddedV4(groups));
    if (parts) return isPublicV4(parts);
    return false;
  }
  return true;
};

export const isPublicV4 = (parts: number[]): boolean =>
  !BLOCKED_V4.some(({ prefix, bits }) => inV4(parts, prefix, bits));

export const isPublicAddress = (address: string): boolean => {
  const v4 = parseIpv4(address);
  if (v4) return isPublicV4(v4);
  const v6 = parseIpv6(address);
  if (v6) return isPublicV6(v6);
  return false;
};

export const defaultAddressResolver: AddressResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
};

export const assertOutboundUrlSafe = async (
  rawUrl: string,
  resolve: AddressResolver = defaultAddressResolver,
): Promise<URL> => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BadRequestException('Webhook URL is invalid');
  }
  if (url.protocol !== 'https:') throw new BadRequestException('Webhook URL must use https');
  if (url.username || url.password) throw new BadRequestException('Webhook URL must not carry credentials');
  if (url.port && url.port !== '443') throw new BadRequestException('Webhook URL must use the default https port');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literal = parseIpv4(hostname) || parseIpv6(hostname);
  if (literal) {
    if (!isPublicAddress(hostname)) throw new BadRequestException('Webhook URL must target a public address');
    return url;
  }
  if (/^(localhost|.*\.localhost|.*\.internal|.*\.local)$/i.test(hostname)) {
    throw new BadRequestException('Webhook URL host is not allowed');
  }
  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch {
    throw new BadRequestException('Webhook URL host could not be resolved');
  }
  if (addresses.length === 0) throw new BadRequestException('Webhook URL host could not be resolved');
  for (const address of addresses) {
    if (!isPublicAddress(address)) {
      throw new BadRequestException('Webhook URL resolves to a non-public address');
    }
  }
  return url;
};
