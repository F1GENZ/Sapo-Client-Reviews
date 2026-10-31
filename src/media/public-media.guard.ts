import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { IngressRateLimitService } from '../common/security/ingress-rate-limit.service';
import { clientFingerprint } from '../common/security/client-fingerprint';
import { resolveStoreScope } from '../common/security/public-rate-limit';
import { APP_ENV } from '../config/app-config.module';
import type { AppEnv } from '../config/env.schema';
import { SapoService } from '../sapo/sapo.service';
import { MediaService } from './media.service';

export type PublicMediaRequest = Request & { publicStoreDomain?: string };

const firstString = (value: unknown): string => {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === 'string' ? candidate : '';
};

// Runs before the multipart interceptor so an unauthenticated caller cannot make the server buffer an upload body.
@Injectable()
export class PublicMediaGuard implements CanActivate {
  constructor(
    private readonly media: MediaService,
    private readonly sapo: SapoService,
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly rateLimit: IngressRateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<PublicMediaRequest>();
    const storeDomain = resolveStoreScope(req);
    if (!storeDomain) throw new BadRequestException('Missing or invalid store domain');

    await this.rateLimit.assertAllowed(
      'public-media:upload',
      `${storeDomain}|${clientFingerprint(req)}`,
      this.env.PUBLIC_WRITE_RATE_LIMIT_WINDOW_SECONDS,
      this.env.PUBLIC_WRITE_RATE_LIMIT_MAX,
    );

    try {
      await this.sapo.resolveAccessToken(storeDomain);
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw new ForbiddenException('Storefront is not enabled for this shop');
      }
      throw error;
    }

    if ((req.path || '').endsWith('/upload')) {
      this.media.inspectUploadTicket(firstString(req.query?.ticket), storeDomain);
    }
    await this.media.assertDailyUploadCapacity(storeDomain);
    req.publicStoreDomain = storeDomain;
    return true;
  }
}
