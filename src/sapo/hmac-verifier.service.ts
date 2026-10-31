import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { APP_ENV } from '../config/app-config.module';
import type { AppEnv } from '../config/env.schema';
import { assertUsableSecret } from '../config/secret-guard';

const safeDecodeURIComponent = (value: string): string => {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
};

const buildQueryMessageCandidates = (rawQueryString: string): string[] => {
  const pairs = rawQueryString
    .split('&')
    .filter(Boolean)
    .map((part) => {
      const eqIndex = part.indexOf('=');
      const rawKey = eqIndex >= 0 ? part.slice(0, eqIndex) : part;
      const rawValue = eqIndex >= 0 ? part.slice(eqIndex + 1) : '';
      return {
        key: safeDecodeURIComponent(rawKey),
        value: safeDecodeURIComponent(rawValue),
        rawKey,
        rawValue,
      };
    })
    .filter((pair) => pair.key !== 'hmac' && pair.rawKey !== 'hmac');

  const sorted = [...pairs].sort((a, b) => a.key.localeCompare(b.key));

  return [
    sorted.map((pair) => `${pair.key}=${pair.value}`).join('&'),
    sorted.map((pair) => `${pair.rawKey}=${pair.rawValue}`).join('&'),
  ].filter((value, index, list) => value && list.indexOf(value) === index);
};

const SHA256_DIGEST_BYTES = 32;

const decodeLaunchSignature = (rawQueryString: string): Buffer | null => {
  const part = rawQueryString.split('&').find((entry) => entry.split('=')[0] === 'hmac');
  if (!part) return null;
  const rawValue = part.slice(part.indexOf('=') + 1).trim();
  let value = rawValue;
  try {
    value = decodeURIComponent(rawValue);
  } catch {
    return null;
  }
  if (!/^[A-Za-z0-9+/]{43}=?$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === SHA256_DIGEST_BYTES ? decoded : null;
};

const parseWebhookSignature = (signature: string): Buffer | null => {
  try {
    return /^[a-f0-9]{64}$/i.test(signature)
      ? Buffer.from(signature, 'hex')
      : Buffer.from(signature, 'base64');
  } catch {
    return null;
  }
};

@Injectable()
export class HmacVerifierService {
  private readonly clientSecret: string;

  constructor(@Inject(APP_ENV) env: AppEnv) {
    this.clientSecret = assertUsableSecret('SAPO_CLIENT_SECRET', env.SAPO_CLIENT_SECRET);
  }

  verifyLaunchQuery(rawQueryString: string): URLSearchParams {
    const params = new URLSearchParams(rawQueryString);
    if (!rawQueryString.split('&').some((entry) => entry.split('=')[0] === 'hmac')) {
      throw new UnauthorizedException('Missing hmac');
    }

    const rawTimestamp = params.get('timestamp');
    const timestamp = Number(rawTimestamp);
    const now = Math.floor(Date.now() / 1000);
    if (!rawTimestamp || !Number.isFinite(timestamp)) {
      throw new UnauthorizedException('Missing HMAC timestamp');
    }
    if (Math.abs(now - timestamp) > 300) {
      throw new UnauthorizedException('HMAC timestamp expired');
    }

    const received = decodeLaunchSignature(rawQueryString);
    const valid = received !== null && buildQueryMessageCandidates(rawQueryString).some((message) => {
      const computed = createHmac('sha256', this.clientSecret).update(message).digest();
      return timingSafeEqual(computed, received);
    });
    if (!valid) throw new UnauthorizedException('Invalid hmac');
    return params;
  }

  verifyWebhookBody(rawBody: Buffer, signature: string | undefined): void {
    if (!rawBody?.length) throw new UnauthorizedException('Missing raw webhook body');
    if (!signature) throw new UnauthorizedException('Missing webhook HMAC');

    const received = parseWebhookSignature(signature.trim());
    if (!received) throw new UnauthorizedException('Invalid webhook HMAC');

    const computed = createHmac('sha256', this.clientSecret).update(rawBody).digest();
    const valid = received.length === computed.length && timingSafeEqual(received, computed);
    if (!valid) throw new UnauthorizedException('Invalid webhook HMAC');
  }
}
