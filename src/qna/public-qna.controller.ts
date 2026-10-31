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
  DefaultValuePipe,
  ForbiddenException,
  Inject,
  ParseIntPipe,
} from '@nestjs/common';
import type { Request } from 'express';
import { QnaService } from './qna.service';
import { ReviewService } from '../review/review.service';
import { NumericIdPipe } from '../common/pipes/numeric-id.pipe';
import { APP_ENV } from '../config/app-config.module';
import type { AppEnv } from '../config/env.schema';
import { IngressRateLimitService } from '../common/security/ingress-rate-limit.service';
import { clientFingerprint } from '../common/security/client-fingerprint';
import { STORE_DOMAIN_RE, STRICT_EMAIL_RE } from '../common/security/public-limits';

@Controller('api/public/qna')
export class PublicQnaController {
  constructor(
    private readonly qnaService: QnaService,
    private readonly reviewService: ReviewService,
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly rateLimit: IngressRateLimitService,
  ) {}

  private async assertPublicRate(req: Request, storeDomain: string): Promise<void> {
    await this.rateLimit.assertAllowed(
      'public-qna:submit',
      `${storeDomain}|${clientFingerprint(req)}`,
      this.env.PUBLIC_WRITE_RATE_LIMIT_WINDOW_SECONDS,
      this.env.PUBLIC_WRITE_RATE_LIMIT_MAX,
    );
  }

  private extractStoreDomain(header?: string, query?: string): string {
    const domain = (header || query || '').trim().toLowerCase();
    if (!domain) throw new BadRequestException('Missing store domain');
    if (!STORE_DOMAIN_RE.test(domain)) {
      throw new BadRequestException('Invalid store domain');
    }
    return domain;
  }

  @Get(':productId')
  async getQuestions(
    @Param('productId', NumericIdPipe) productId: string,
    @Headers('x-store-domain') storeDomainHeader?: string,
    @Query('storeDomain') storeDomainQuery?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page?: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit?: number,
  ) {
    const storeDomain = this.extractStoreDomain(storeDomainHeader, storeDomainQuery);
    const config = await this.reviewService.getPublicWidgetConfig(storeDomain);
    if (config.allowQnA === false) {
      return { data: this.qnaService.emptyPublicPage({ page, limit }) };
    }
    const result = await this.qnaService.getPublicQuestions(
      storeDomain,
      productId,
      { page, limit },
    );
    return { data: result };
  }

  @Post(':productId')
  async submitQuestion(
    @Param('productId', NumericIdPipe) productId: string,
    @Req() req: Request,
    @Body()
    body: {
      author: string;
      question: string;
      email?: string;
    },
    @Headers('x-store-domain') storeDomainHeader?: string,
    @Query('storeDomain') storeDomainQuery?: string,
  ) {
    const storeDomain = this.extractStoreDomain(storeDomainHeader, storeDomainQuery);
    await this.assertPublicRate(req, storeDomain);

    const config = await this.reviewService.getServingWidgetConfig(storeDomain);
    if (config.allowQnA === false) {
      throw new ForbiddenException({ code: 'qna_disabled', message: 'Q&A is disabled for this store' });
    }

    if (
      !body.author ||
      typeof body.author !== 'string' ||
      !body.author.trim()
    ) {
      throw new BadRequestException('Author is required');
    }
    if (body.author.trim().length < 2) {
      throw new BadRequestException('Author must be at least 2 characters');
    }
    if (body.author.trim().length > 100) {
      throw new BadRequestException('Author must be at most 100 characters');
    }

    if (
      !body.question ||
      typeof body.question !== 'string' ||
      !body.question.trim()
    ) {
      throw new BadRequestException('Question is required');
    }
    if (body.question.trim().length < 5) {
      throw new BadRequestException('Question must be at least 5 characters');
    }
    if (body.question.trim().length > 1000) {
      throw new BadRequestException('Question must be at most 1000 characters');
    }

    const email = typeof body.email === 'string' ? body.email.trim() : undefined;
    if (email && !STRICT_EMAIL_RE.test(email)) {
      throw new BadRequestException('Email is invalid');
    }
    if (email && email.length > 200) {
      throw new BadRequestException('Email must be at most 200 characters');
    }

    const result = await this.qnaService.submitPublicQuestion(storeDomain, productId, {
      author: body.author.trim().slice(0, 100),
      question: body.question.trim().slice(0, 1000),
      email: email?.slice(0, 200),
    });

    return { data: result };
  }
}
