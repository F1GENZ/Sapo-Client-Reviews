import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  Req,
  NotFoundException,
  BadRequestException,
  DefaultValuePipe,
  ParseIntPipe,
  ValidationPipe,
} from '@nestjs/common';
import { ShopAuthGuard } from '../common/guards/shop-auth.guard';
import { ReviewService } from './review.service';
import { CreateReviewDto } from './dto/create-review.dto';
import { UpdateReviewDto } from './dto/update-review.dto';
import { ReplyReviewDto } from './dto/reply-review.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { UpdateSpamConfigDto } from './dto/update-spam-config.dto';
import { UpdateWidgetConfigDto } from './dto/update-widget-config.dto';
import { SyncMetafieldDto } from './dto/sync-metafield.dto';
import { NumericIdPipe } from '../common/pipes/numeric-id.pipe';
import { STORE_DOMAIN_RE } from '../common/security/public-limits';
import { ReviewBulkDto, ReviewImportDto } from './review-data-tools.dto';
import { ReviewDataToolsService } from './review-data-tools.service';

type AuthRequest = {
  token?: string;
  storeDomain?: string;
};

function parseStar(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const star = Number(raw);
  if (!Number.isInteger(star) || star < 1 || star > 5) {
    throw new BadRequestException('star must be an integer 1-5');
  }
  return star;
}

function requireAuth(req: AuthRequest): asserts req is Required<AuthRequest> & { storeDomain: string } {
  if (!req.token || !req.storeDomain || !STORE_DOMAIN_RE.test(req.storeDomain)) {
    throw new BadRequestException('Missing or invalid auth');
  }
}

@Controller('api/admin/reviews')
@UseGuards(ShopAuthGuard)
export class ReviewController {
  constructor(
    private readonly reviewService: ReviewService,
    private readonly dataTools: ReviewDataToolsService,
  ) {}

  @Get('widget-config')
  async getWidgetConfig(@Req() req: AuthRequest) {
    requireAuth(req);
    const config = await this.reviewService.getWidgetConfig(req.token, req.storeDomain);
    return { data: config };
  }

  @Put('widget-config')
  async updateWidgetConfig(
    @Body(new ValidationPipe({ transform: true, whitelist: true }))
    dto: UpdateWidgetConfigDto,
    @Req() req: AuthRequest,
  ) {
    requireAuth(req);
    const config = await this.reviewService.updateWidgetConfig(req.token, dto, req.storeDomain);
    return { data: config };
  }

  @Get('spam-config')
  async getSpamConfig(@Req() req: AuthRequest) {
    requireAuth(req);
    const config = await this.reviewService.getSpamConfig(req.token, req.storeDomain);
    return { data: config };
  }

  @Put('spam-config')
  async updateSpamConfig(
    @Body(new ValidationPipe({ transform: true, whitelist: true }))
    dto: UpdateSpamConfigDto,
    @Req() req: AuthRequest,
  ) {
    requireAuth(req);
    const config = await this.reviewService.updateSpamConfig(req.token, dto, req.storeDomain);
    return { data: config };
  }

  @Post('sync-metafield')
  async syncMetafield(
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    body: SyncMetafieldDto,
    @Req() req: AuthRequest,
  ) {
    requireAuth(req);
    const result = await this.reviewService.syncPublicSummaryMetafield(
      req.token,
      req.storeDomain,
      body.productId,
    );
    return { data: result };
  }

  @Get('export')
  async exportReviews(
    @Query('format') format: string | undefined,
    @Req() req: AuthRequest,
  ) {
    requireAuth(req);
    const normalized = format === 'json' ? 'json' : 'csv';
    return { data: await this.dataTools.exportReviews(req.storeDomain, normalized) };
  }

  @Get('import/history')
  async importHistory(@Req() req: AuthRequest) {
    requireAuth(req);
    return { data: await this.dataTools.listImportRuns(req.storeDomain, 'reviews') };
  }

  @Post('import/dry-run')
  async importDryRun(
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    dto: ReviewImportDto,
    @Req() req: AuthRequest,
  ) {
    requireAuth(req);
    return { data: await this.dataTools.importReviews(req.token, req.storeDomain, { ...dto, dryRun: true }) };
  }

  @Post('import')
  async importReviews(
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    dto: ReviewImportDto,
    @Req() req: AuthRequest,
  ) {
    requireAuth(req);
    return {
      data: await this.dataTools.importReviews(req.token, req.storeDomain, {
        format: dto.format,
        body: dto.body,
        dryRun: dto.dryRun === true,
      }),
    };
  }

  @Post('bulk')
  async bulkReviews(
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    dto: ReviewBulkDto,
    @Req() req: AuthRequest,
  ) {
    requireAuth(req);
    return { data: await this.dataTools.bulkReviews(req.token, req.storeDomain, dto.action, dto.items) };
  }

  @Get('widget-config/revisions')
  async widgetConfigRevisions(@Req() req: AuthRequest) {
    requireAuth(req);
    return { data: await this.reviewService.listWidgetConfigRevisions(req.storeDomain) };
  }

  @Post('widget-config/revisions/:revisionId/restore')
  async restoreWidgetConfigRevision(
    @Param('revisionId') revisionId: string,
    @Req() req: AuthRequest,
  ) {
    requireAuth(req);
    return {
      data: await this.reviewService.restoreWidgetConfigRevision(req.token, req.storeDomain, revisionId),
    };
  }

  @Get()
  async listAllReviews(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('status') status: string | undefined,
    @Query('sort') sort: string | undefined,
    @Query('productId') productId: string | undefined,
    @Query('search') search: string | undefined,
    @Query('star') star: string | undefined,
    @Req() req: AuthRequest,
  ) {
    requireAuth(req);
    const reviews = await this.reviewService.listAllReviews(req.token, req.storeDomain, {
      page,
      limit,
      status,
      sort,
      productId,
      search,
      star: parseStar(star),
    });
    return { data: reviews };
  }

  @Get(':productId')
  async getReviews(
    @Param('productId', NumericIdPipe) productId: string,
    @Query('star') star: string | undefined,
    @Req() req: AuthRequest,
  ) {
    requireAuth(req);
    const reviews = await this.reviewService.getReviews(
      req.token,
      req.storeDomain,
      productId,
      parseStar(star),
    );
    return { data: reviews };
  }

  @Get(':productId/stats')
  async getStats(
    @Param('productId', NumericIdPipe) productId: string,
    @Req() req: AuthRequest,
  ) {
    requireAuth(req);
    const stats = await this.reviewService.getProductStats(req.token, req.storeDomain, productId);
    return { data: stats };
  }

  @Post(':productId')
  async createReview(
    @Param('productId', NumericIdPipe) productId: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true }))
    dto: CreateReviewDto,
    @Req() req: AuthRequest,
  ) {
    requireAuth(req);
    const review = await this.reviewService.addReview(req.token, req.storeDomain, productId, dto);
    return { data: review };
  }

  @Patch(':productId/:reviewId')
  async updateReview(
    @Param('productId', NumericIdPipe) productId: string,
    @Param('reviewId') reviewId: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true }))
    dto: UpdateReviewDto,
    @Req() req: AuthRequest,
  ) {
    requireAuth(req);
    const review = await this.reviewService.editReview(
      req.token,
      req.storeDomain,
      productId,
      reviewId,
      dto,
    );
    if (!review) throw new NotFoundException('Review not found');
    return { data: review };
  }

  @Patch(':productId/:reviewId/status')
  async updateStatus(
    @Param('productId', NumericIdPipe) productId: string,
    @Param('reviewId') reviewId: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true }))
    dto: UpdateStatusDto,
    @Req() req: AuthRequest,
  ) {
    requireAuth(req);
    const review = await this.reviewService.updateReviewStatus(
      req.token,
      req.storeDomain,
      productId,
      reviewId,
      dto.status,
    );
    if (!review) throw new NotFoundException('Review not found');
    return { data: review };
  }

  @Patch(':productId/:reviewId/reply')
  async replyToReview(
    @Param('productId', NumericIdPipe) productId: string,
    @Param('reviewId') reviewId: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true }))
    dto: ReplyReviewDto,
    @Req() req: AuthRequest,
  ) {
    requireAuth(req);
    const review = await this.reviewService.replyToReview(
      req.token,
      req.storeDomain,
      productId,
      reviewId,
      dto.reply,
    );
    if (!review) throw new NotFoundException('Review not found');
    return { data: review };
  }

  @Patch(':productId/:reviewId/pin')
  async pinReview(
    @Param('productId', NumericIdPipe) productId: string,
    @Param('reviewId') reviewId: string,
    @Req() req: AuthRequest,
  ) {
    requireAuth(req);
    const review = await this.reviewService.pinReview(
      req.token,
      req.storeDomain,
      productId,
      reviewId,
    );
    if (!review) throw new NotFoundException('Review not found');
    return { data: review };
  }

  @Delete(':productId/:reviewId')
  async deleteReview(
    @Param('productId', NumericIdPipe) productId: string,
    @Param('reviewId') reviewId: string,
    @Req() req: AuthRequest,
  ) {
    requireAuth(req);
    const result = await this.reviewService.deleteReview(
      req.token,
      req.storeDomain,
      productId,
      reviewId,
    );
    if (!result.deleted) throw new NotFoundException('Review not found');
    return {
      data: {
        deleted: true,
        ...(result.summarySyncFailed ? { summarySyncFailed: true } : {}),
      },
    };
  }
}
