import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  Headers,
  Req,
  BadRequestException,
  ConflictException,
  DefaultValuePipe,
  Inject,
  ParseIntPipe,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac } from 'crypto';
import type { Request } from 'express';
import { ReviewService } from './review.service';
import { NumericIdPipe } from '../common/pipes/numeric-id.pipe';
import { SapoService } from '../sapo/sapo.service';
import { APP_ENV } from '../config/app-config.module';
import type { AppEnv } from '../config/env.schema';
import { IngressRateLimitService } from '../common/security/ingress-rate-limit.service';
import { clientFingerprint } from '../common/security/client-fingerprint';
import { STORE_DOMAIN_RE, STRICT_EMAIL_RE, isValidPhone } from '../common/security/public-limits';
import { sanitizePublicMedia, type PublicIdentity } from './public-review-input';
import { normalizePhone } from '../purchase/purchase-store.service';
import { buildSliderPayload, resolveSliderSettings } from './slider-payload';

const IDENTITY_RATE_WINDOW_SECONDS = 3600;
const IDENTITY_RATE_MAX = 30;
const PHONE_CHARS_RE = /^[0-9+\-\s().]+$/;

type IdentityBody = { email?: unknown; phone?: unknown };

type ReviewBody = IdentityBody & {
  rating?: unknown;
  content?: unknown;
  author?: unknown;
  title?: unknown;
  media?: unknown;
};

const optionalText = (value: unknown, label: string, max: number): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new BadRequestException(`${label} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new BadRequestException(`${label} must be at most ${max} characters`);
  }
  return trimmed || undefined;
};

const parseIdentity = (body: IdentityBody | undefined): PublicIdentity => {
  const email = optionalText(body?.email, 'Email', 200);
  const phone = optionalText(body?.phone, 'Phone', 20);
  if (email && !STRICT_EMAIL_RE.test(email)) throw new BadRequestException('Email is invalid');
  if (phone && (!PHONE_CHARS_RE.test(phone) || !isValidPhone(phone))) {
    throw new BadRequestException('Phone is invalid');
  }
  return { email, phone };
};

@Controller('api/public/reviews')
export class PublicReviewController {
  constructor(
    private readonly reviewService: ReviewService,
    private readonly sapoService: SapoService,
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly rateLimit: IngressRateLimitService,
  ) {}

  private async assertPublicRate(
    req: Request,
    storeDomain: string,
    bucket: 'public-review:submit' | 'public-review:eligibility',
  ): Promise<void> {
    await this.rateLimit.assertAllowed(
      bucket,
      `${storeDomain}|${clientFingerprint(req)}`,
      this.env.PUBLIC_WRITE_RATE_LIMIT_WINDOW_SECONDS,
      this.env.PUBLIC_WRITE_RATE_LIMIT_MAX,
    );
  }

  private async chargeIdentity(storeDomain: string, identity: PublicIdentity): Promise<void> {
    const values: Array<[string, string]> = [];
    if (identity.email) values.push(['email', identity.email.toLowerCase()]);
    if (identity.phone) values.push(['phone', normalizePhone(identity.phone)]);
    for (const [kind, value] of values) {
      const digest = createHmac('sha256', this.env.APP_SESSION_SECRET)
        .update(`public-review-identity|${kind}|${value}`)
        .digest('hex');
      await this.rateLimit.assertAllowed(
        'public-review:identity',
        `${storeDomain}|${digest}`,
        IDENTITY_RATE_WINDOW_SECONDS,
        IDENTITY_RATE_MAX,
      );
    }
  }

  private extractStoreDomain(header?: string, query?: string): string {
    const domain = (header || query || '').trim().toLowerCase();
    if (!domain) throw new BadRequestException('Missing store domain');
    if (!STORE_DOMAIN_RE.test(domain)) {
      throw new BadRequestException('Invalid store domain');
    }
    return domain;
  }

  @Get('config/widget')
  async getWidgetConfig(
    @Headers('x-store-domain') storeDomainHeader?: string,
    @Query('storeDomain') storeDomainQuery?: string,
  ) {
    const storeDomain = this.extractStoreDomain(storeDomainHeader, storeDomainQuery);
    const config = await this.reviewService.getPublicWidgetConfig(storeDomain);
    return { data: config };
  }

  @Get('summaries')
  async getSummaries(
    @Query('productIds') productIds?: string,
    @Headers('x-store-domain') storeDomainHeader?: string,
    @Query('storeDomain') storeDomainQuery?: string,
  ) {
    const storeDomain = this.extractStoreDomain(storeDomainHeader, storeDomainQuery);
    const ids = String(productIds || '').split(',').map((s) => s.trim()).filter(Boolean);
    const summaries = await this.reviewService.getPublicSummaries(storeDomain, ids);
    return { data: summaries };
  }

  @Post(':productId/purchase-eligibility')
  async checkPurchaseEligibility(
    @Param('productId', NumericIdPipe) productId: string,
    @Req() req: Request,
    @Body() body: IdentityBody | undefined,
    @Headers('x-store-domain') storeDomainHeader?: string,
    @Query('storeDomain') storeDomainQuery?: string,
  ) {
    const storeDomain = this.extractStoreDomain(storeDomainHeader, storeDomainQuery);
    await this.assertPublicRate(req, storeDomain, 'public-review:eligibility');
    const identity = parseIdentity(body);
    const result = await this.reviewService.checkPurchaseEligibility(
      storeDomain,
      productId,
      identity,
      (charged) => this.chargeIdentity(storeDomain, charged),
    );
    return { data: result };
  }

  @Get(':productId')
  async getReviews(
    @Param('productId', NumericIdPipe) productId: string,
    @Headers('x-store-domain') storeDomainHeader?: string,
    @Query('storeDomain') storeDomainQuery?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page?: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit?: number,
    @Query('sort') sort?: string,
  ) {
    const storeDomain = this.extractStoreDomain(storeDomainHeader, storeDomainQuery);
    const reviews = await this.reviewService.getPublicReviews(
      storeDomain,
      productId,
      { page, limit, sort },
    );
    return { data: reviews };
  }

  @Get(':productId/slider')
  async getSlider(
    @Param('productId', NumericIdPipe) productId: string,
    @Headers('x-store-domain') storeDomainHeader?: string,
    @Query('storeDomain') storeDomainQuery?: string,
  ) {
    const storeDomain = this.extractStoreDomain(storeDomainHeader, storeDomainQuery);
    const empty = { v: 1 as const, updated_at: Date.now(), items: [] };
    if (!(await this.reviewService.isStoreServing(storeDomain))) {
      return { data: empty };
    }
    const config = await this.reviewService.getPublicWidgetConfig(storeDomain).catch(() => null);
    const settings = resolveSliderSettings(config);
    if (!settings.enabled) {
      return { data: empty };
    }
    const page = await this.reviewService.getPublicReviews(storeDomain, productId, {
      page: 1,
      limit: Math.max(30, settings.count),
      sort: 'newest',
    });
    return { data: buildSliderPayload(page.items, settings.count, Date.now()) };
  }

  @Get(':productId/summary')
  async getSummary(
    @Param('productId', NumericIdPipe) productId: string,
    @Headers('x-store-domain') storeDomainHeader?: string,
    @Query('storeDomain') storeDomainQuery?: string,
  ) {
    const storeDomain = this.extractStoreDomain(storeDomainHeader, storeDomainQuery);
    const summary = await this.reviewService.getPublicSummary(storeDomain, productId);
    return { data: summary };
  }

  @Post(':productId')
  async submitReview(
    @Param('productId', NumericIdPipe) productId: string,
    @Req() req: Request,
    @Body() body: ReviewBody | undefined,
    @Headers('x-store-domain') storeDomainHeader?: string,
    @Query('storeDomain') storeDomainQuery?: string,
  ) {
    const storeDomain = this.extractStoreDomain(storeDomainHeader, storeDomainQuery);
    await this.assertPublicRate(req, storeDomain, 'public-review:submit');
    if (!body || typeof body !== 'object') {
      throw new BadRequestException('Request body is required');
    }

    const rating = body.rating;
    if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new BadRequestException('Rating must be an integer 1-5');
    }
    const author = optionalText(body.author, 'Author', 100);
    if (!author) throw new BadRequestException('Author is required');
    const content = optionalText(body.content, 'Content', 2000);
    const title = optionalText(body.title, 'Title', 100);
    const identity = parseIdentity(body);
    const media = sanitizePublicMedia(body.media, {
      publicDomain: this.env.R2_PUBLIC_DOMAIN,
      storeDomain,
      productId,
    });

    const review = await this.reviewService.submitPublicReview(
      storeDomain,
      productId,
      { rating, content: content ?? '', author, title, email: identity.email, phone: identity.phone, media },
      {
        chargeIdentity: (charged) => this.chargeIdentity(storeDomain, charged),
        resolveToken: () =>
          this.sapoService.resolveAccessToken(storeDomain).catch((err: unknown) => {
            if (err instanceof UnauthorizedException) {
              throw new ConflictException({ code: 'store_not_serving', message: 'Store is not serving' });
            }
            throw err;
          }),
      },
    );

    return { data: review };
  }
}
