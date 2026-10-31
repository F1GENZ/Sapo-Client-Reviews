import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { serialize } from 'cookie';
import { APP_ENV } from '../config/app-config.module';
import type { AppEnv } from '../config/env.schema';
import { assertUsableSecret } from '../config/secret-guard';
import { RedisService } from '../redis/redis.service';
import { isSafeRedirect } from './oauth-state.service';

export type AppSessionPayload = {
  storeDomain: string;
  gen: number;
  type: 'sapo_app_session';
  iat: number;
  exp: number;
};

export type SessionHandoffPayload = {
  storeDomain: string;
  redirectTo: string;
  createdAt: number;
};

const base64UrlJson = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const IPV4_REGEX = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const MULTI_PART_PUBLIC_SUFFIXES = new Set([
  'co.uk',
  'com.au',
  'com.br',
  'com.cn',
  'com.hk',
  'com.sg',
  'com.tw',
  'co.jp',
  'co.kr',
  'co.nz',
  'co.th',
  'co.za',
  'net.au',
  'org.au',
]);

const siteHost = (url: string): string => {
  const hostname = new URL(url).hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || IPV4_REGEX.test(hostname) || hostname.includes(':')) {
    return hostname;
  }
  const parts = hostname.split('.').filter(Boolean);
  if (parts.length < 2) return hostname;
  const lastTwo = parts.slice(-2).join('.');
  if (parts.length >= 3 && MULTI_PART_PUBLIC_SUFFIXES.has(lastTwo)) return parts.slice(-3).join('.');
  return lastTwo;
};

const isSameSiteDeployment = (frontendUrl: string, apiBaseUrl: string): boolean =>
  siteHost(frontendUrl) === siteHost(apiBaseUrl);

@Injectable()
export class SessionService {
  private readonly sessionSecret: string;

  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly redis: RedisService,
  ) {
    this.sessionSecret = assertUsableSecret('APP_SESSION_SECRET', env.APP_SESSION_SECRET, { minBytes: 32 });
  }

  private handoffKey(code: string): string {
    return `session-handoff:${hash(code)}`;
  }

  private handoffKeyFromDigest(digest: string): string {
    return `session-handoff:${digest}`;
  }

  private handoffIndexKey(storeDomain: string, handoffCode: string): string {
    return `session-handoff-store:${storeDomain}:${hash(handoffCode)}`;
  }

  private sign(input: string): string {
    return createHmac('sha256', this.sessionSecret).update(input).digest('base64url');
  }

  createSessionToken(storeDomain: string, lifecycleGeneration: number): string {
    const now = Math.floor(Date.now() / 1000);
    const header = base64UrlJson({ alg: 'HS256', typ: 'JWT' });
    const body = base64UrlJson({
      storeDomain,
      type: 'sapo_app_session',
      gen: lifecycleGeneration,
      iat: now,
      exp: now + this.env.APP_SESSION_TTL_SECONDS,
    } satisfies AppSessionPayload);
    return `${header}.${body}.${this.sign(`${header}.${body}`)}`;
  }

  verifySessionToken(sessionToken: string): AppSessionPayload {
    const parts = String(sessionToken || '').split('.');
    if (parts.length !== 3) throw new UnauthorizedException('Invalid auth session');
    const expected = Buffer.from(this.sign(`${parts[0]}.${parts[1]}`));
    const actual = Buffer.from(parts[2]);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new UnauthorizedException('Invalid auth session');
    }
    let payload: AppSessionPayload;
    try {
      payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as AppSessionPayload;
    } catch {
      throw new UnauthorizedException('Invalid auth session');
    }
    const now = Math.floor(Date.now() / 1000);
    if (payload.type !== 'sapo_app_session' || !payload.storeDomain || payload.exp <= now) {
      throw new UnauthorizedException('Expired auth session');
    }
    if (!Number.isInteger(payload.gen)) throw new UnauthorizedException('Invalid auth session');
    return payload;
  }

  async createHandoff(storeDomain: string, redirectTo?: string): Promise<{
    handoffCode: string;
    storeDomain: string;
    redirectTo: string;
  }> {
    const handoffCode = `sapo_handoff_${randomBytes(32).toString('hex')}`;
    const safeRedirect = isSafeRedirect(redirectTo) ? redirectTo : '/dashboard';
    await this.redis.set(
      this.handoffKey(handoffCode),
      { storeDomain, redirectTo: safeRedirect, createdAt: Date.now() } satisfies SessionHandoffPayload,
      this.env.SESSION_HANDOFF_TTL_SECONDS,
    );
    await this.redis.set(this.handoffIndexKey(storeDomain, handoffCode), '1', this.env.SESSION_HANDOFF_TTL_SECONDS);
    return { handoffCode, storeDomain, redirectTo: safeRedirect };
  }

  async consumeHandoff(handoffCode: unknown): Promise<SessionHandoffPayload> {
    if (typeof handoffCode !== 'string' || !/^sapo_handoff_[a-f0-9]{64}$/.test(handoffCode)) {
      throw new UnauthorizedException('Invalid session handoff');
    }
    const payload = await this.redis.getDel<SessionHandoffPayload>(this.handoffKey(handoffCode));
    if (!payload?.storeDomain) throw new UnauthorizedException('Invalid or expired session handoff');
    await this.redis.del(this.handoffIndexKey(payload.storeDomain, handoffCode));
    return payload;
  }

  async clearStoreHandoffs(storeDomain: string): Promise<number> {
    const indexPrefix = `session-handoff-store:${storeDomain}:`;
    const indexKeys = await this.redis.scanKeys(`${indexPrefix}*`);
    const handoffKeys = indexKeys
      .map((key) => key.slice(indexPrefix.length))
      .filter((digest) => /^[a-f0-9]{64}$/.test(digest))
      .map((digest) => this.handoffKeyFromDigest(digest));
    return this.redis.delMany([...indexKeys, ...handoffKeys]);
  }

  private cookieOptions(maxAgeSeconds: number): Parameters<typeof serialize>[2] {
    const crossSite = !isSameSiteDeployment(this.env.FRONTEND_URL, this.env.API_BASE_URL);
    return {
      httpOnly: true,
      secure: this.env.NODE_ENV === 'production' || crossSite,
      sameSite: crossSite ? 'none' : 'lax',
      path: '/',
      maxAge: maxAgeSeconds,
      ...(this.env.SESSION_COOKIE_DOMAIN ? { domain: this.env.SESSION_COOKIE_DOMAIN } : {}),
    };
  }

  setSessionCookie(res: Response, sessionToken: string): void {
    res.setHeader('Set-Cookie', serialize(
      this.env.SESSION_COOKIE_NAME,
      sessionToken,
      this.cookieOptions(this.env.APP_SESSION_TTL_SECONDS),
    ));
  }

  clearSessionCookie(res: Response): void {
    res.setHeader('Set-Cookie', serialize(this.env.SESSION_COOKIE_NAME, '', this.cookieOptions(0)));
  }

  getSessionTokenFromRequest(req: Request): string | null {
    const rawCookie = typeof req.headers.cookie === 'string' ? req.headers.cookie : '';
    const encodedName = `${encodeURIComponent(this.env.SESSION_COOKIE_NAME)}=`;
    for (const part of rawCookie.split(/;\s*/)) {
      if (!part.startsWith(encodedName)) continue;
      try {
        return decodeURIComponent(part.slice(encodedName.length));
      } catch {
        return part.slice(encodedName.length);
      }
    }
    return null;
  }
}
