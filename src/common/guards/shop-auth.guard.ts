import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { APP_ENV } from '../../config/app-config.module';
import type { AppEnv } from '../../config/env.schema';
import { isTrustedUnsafeOrigin, isUnsafeMethod } from '../security/origin-policy';
import { STORE_DOMAIN_RE } from '../security/public-limits';
import { ALLOW_EXPIRED_SAPO_TOKEN } from '../decorators/shop-auth.decorator';
import { SapoService } from '../../sapo/sapo.service';
import { SessionService } from '../../sapo/session.service';
import { Inject } from '@nestjs/common';

type ShopRequest = Request & {
  storeDomain?: string;
  token?: string;
  sapoTokenExpired?: boolean;
};

const toStringValue = (value: unknown): string | null => {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0].trim()) return value[0].trim();
  return null;
};

@Injectable()
export class ShopAuthGuard implements CanActivate {
  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly sessionService: SessionService,
    private readonly sapoService: SapoService,
    private readonly reflector: Reflector,
  ) {}

  private extractBearerToken(authorization: unknown): string | null {
    const raw = toStringValue(authorization);
    if (!raw || !raw.startsWith('Bearer ')) return null;
    const token = raw.slice(7).trim();
    return token || null;
  }

  private getRequestedStoreDomain(req: ShopRequest): string | null {
    return (
      toStringValue(req.headers['x-store-domain']) ||
      toStringValue(req.headers.storeDomain) ||
      toStringValue(req.query?.storeDomain) ||
      toStringValue(req.body?.storeDomain)
    );
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ShopRequest>();
    if (!isTrustedUnsafeOrigin(req, {
      frontendUrl: this.env.FRONTEND_URL,
      apiBaseUrl: this.env.API_BASE_URL,
      allowedOrigins: this.env.CORS_ALLOWED_ORIGINS,
    })) {
      throw new UnauthorizedException('Untrusted request origin');
    }

    const requestedStoreDomain = this.getRequestedStoreDomain(req);
    if (requestedStoreDomain && !STORE_DOMAIN_RE.test(requestedStoreDomain)) {
      throw new BadRequestException('Invalid storeDomain');
    }

    const bearerToken = this.extractBearerToken(req.headers.authorization);
    if (isUnsafeMethod(req.method) && !bearerToken) {
      throw new UnauthorizedException('Missing auth session: bearer token required for state-changing requests');
    }
    const sessionToken = bearerToken || this.sessionService.getSessionTokenFromRequest(req);
    if (!sessionToken) throw new UnauthorizedException('Missing auth session');

    const session = this.sessionService.verifySessionToken(sessionToken);
    if (!STORE_DOMAIN_RE.test(session.storeDomain)) throw new BadRequestException('Invalid storeDomain');
    if (requestedStoreDomain && requestedStoreDomain !== session.storeDomain) {
      throw new UnauthorizedException('StoreDomain does not match auth session');
    }

    const lifecycleGeneration = await this.sapoService.getLifecycleGeneration(session.storeDomain);
    if (lifecycleGeneration !== session.gen) {
      throw new UnauthorizedException('Auth session predates the current installation');
    }

    try {
      req.token = await this.sapoService.resolveAccessToken(session.storeDomain);
    } catch (error) {
      const allowExpired = this.reflector.getAllAndOverride<boolean>(ALLOW_EXPIRED_SAPO_TOKEN, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (!allowExpired) throw error;
      req.sapoTokenExpired = true;
    }

    req.storeDomain = session.storeDomain;
    return true;
  }
}
