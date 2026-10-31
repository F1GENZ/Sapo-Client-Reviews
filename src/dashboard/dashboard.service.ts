import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { catalogLabels } from '../catalog/product-label';
import type { CatalogLabel } from '../catalog/product-label';
import { runSection } from '../health/degraded-section';
import { ReviewProductStoreService } from '../review/review-product-store.service';
import { UNREPLIED_WHERE } from '../review/review-where';
import { QnaStoreService } from '../qna/qna-store.service';

type ProductStat = {
  productId: string;
  title: string;
  image: string | null;
  reviewCount: number;
  avgRating: number;
  qnaTotal: number;
  qnaUnanswered: number;
};

type AttentionProduct = {
  productId: string;
  title: string;
  image: string | null;
  reviewAvg: number;
  reviewCount: number;
  qnaUnanswered: number;
  reason: 'low_rating' | 'unanswered_qna' | 'mixed';
};

type DashboardOverview = {
  productCount: number;
  totalReviews: number;
  totalQuestions: number;
  totalAnswered: number;
  totalUnanswered: number;
  responseRate: number;
  globalAvg: number;
  globalDist: Record<number, number>;
  statusCounts: { approved: number; pending: number; hidden: number; spam: number; unreplied: number };
  qnaStatusCounts: { all: number; pending: number; hidden: number; answered: number; unanswered: number };
  verifiedCount: number;
  withMediaCount: number;
  recentReviews: Array<{
    id: string; rating: number; author: string; content: string;
    created_at: number; productId: string; productTitle?: string; productImage?: string;
    status?: string; verified?: boolean; hasReply?: boolean;
  }>;
  recentQuestions: Array<{
    id: string; question: string; author: string; status?: string;
    answered: boolean; created_at: number; productId: string; productTitle?: string;
  }>;
  rankedProducts: Array<{
    id: string; title: string; count: number; avg: number;
  }>;
  reviewTrend: Array<{ date: string; count: number }>;
  attentionProducts: AttentionProduct[];
  productStats: ProductStat[];
  degraded: string[];
};

const DAY_MS = 86_400_000;
const VN_OFFSET_MS = 7 * 3_600_000;
const TREND_DAYS = 14;
const RECENT_LIMIT = 8;
const RANKED_LIMIT = 5;
const ATTENTION_LIMIT = 5;
const PRODUCT_STATS_LIMIT = 500;
const LOW_RATING_THRESHOLD = 4;
const LOW_RATING_MIN_APPROVED = 3;
const ANSWERED_WHERE: Prisma.QnaQuestionWhereInput = { answer: { not: null }, NOT: { answer: '' } };

const round1 = (value: number): number => Math.round(value * 10) / 10;

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    private readonly reviewStore: ReviewProductStoreService,
    private readonly qnaStore: QnaStoreService,
    private readonly prisma: PrismaService,
  ) {}

  async getOverview(storeDomain: string): Promise<DashboardOverview> {
    const install = await this.prisma.appInstall.findUnique({
      where: { storeDomain },
      select: { shopId: true },
    });
    if (!install) {
      throw new NotFoundException({ code: 'install_not_found', message: 'App not installed for this store' });
    }
    const shopId = install.shopId;
    const degraded: string[] = [];

    const [reviewStats, qnaStats, qnaStatus, recentReviews, recentQuestions, unrepliedCount, reviewTrend, products] =
      await Promise.all([
        runSection(this.logger, 'reviewStats', degraded, () => this.reviewStore.getStatsForShop(shopId)),
        runSection(this.logger, 'qnaStats', degraded, () => this.qnaStore.getStats(shopId)),
        runSection(this.logger, 'qnaStatusCounts', degraded, () => this.qnaStore.getStatusCounts(shopId)),
        runSection(this.logger, 'recentReviews', degraded, () =>
          this.reviewStore.getAllReviews(shopId, { page: 0, size: RECENT_LIMIT, sort: 'newest' }),
        ),
        runSection(this.logger, 'recentQuestions', degraded, () =>
          this.qnaStore.getAllQuestions(shopId, { page: 0, size: RECENT_LIMIT, sort: 'newest' }),
        ),
        runSection(this.logger, 'unreplied', degraded, () =>
          this.prisma.reviewProduct.count({ where: { AND: [{ shopId }, UNREPLIED_WHERE] } }),
        ),
        runSection(this.logger, 'reviewTrend', degraded, () => this.loadReviewTrend(shopId)),
        runSection(this.logger, 'productStats', degraded, () => this.loadProductStats(shopId)),
      ]);

    const recentReviewItems = recentReviews?.items ?? [];
    const recentQuestionItems = recentQuestions?.items ?? [];
    const labels = await runSection(this.logger, 'catalogLabels', degraded, () =>
      catalogLabels(
        this.prisma,
        shopId,
        [...recentReviewItems, ...recentQuestionItems].map((row) => row.productId),
      ),
    );
    const labelOf = (productId: string): CatalogLabel | undefined => labels?.get(productId);

    const totalReviews = reviewStats?.totalReviews ?? 0;
    const totalQuestions = qnaStats?.total ?? 0;
    const totalAnswered = qnaStats?.answered ?? 0;
    const totalUnanswered = Math.max(0, totalQuestions - totalAnswered);
    const storedCounts: Partial<Record<string, number>> = reviewStats?.statusCounts ?? {};
    const productStats = products?.productStats ?? [];

    return {
      productCount: reviewStats?.productCount ?? 0,
      totalReviews,
      totalQuestions,
      totalAnswered,
      totalUnanswered,
      responseRate: totalQuestions ? Math.round((totalAnswered / totalQuestions) * 100) : 0,
      globalAvg: reviewStats?.globalAvg ?? 0,
      globalDist: reviewStats?.globalDist ?? { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      statusCounts: {
        approved: storedCounts.approved ?? 0,
        pending: storedCounts.pending ?? 0,
        hidden: storedCounts.hidden ?? 0,
        spam: storedCounts.spam ?? 0,
        unreplied: unrepliedCount ?? storedCounts.unreplied ?? 0,
      },
      qnaStatusCounts: {
        all: totalQuestions,
        pending: qnaStatus?.pending ?? 0,
        hidden: qnaStatus?.hidden ?? 0,
        answered: totalAnswered,
        unanswered: totalUnanswered,
      },
      verifiedCount: reviewStats?.verifiedCount ?? 0,
      withMediaCount: reviewStats?.withMediaCount ?? 0,
      rankedProducts: productStats
        .filter((p) => p.reviewCount > 0)
        .sort((a, b) => b.reviewCount - a.reviewCount)
        .slice(0, RANKED_LIMIT)
        .map((p) => ({ id: p.productId, title: p.title, count: p.reviewCount, avg: p.avgRating })),
      recentReviews: recentReviewItems.map((r) => {
        const label = labelOf(r.productId);
        return {
          id: r.reviewId,
          rating: r.rating,
          author: r.author,
          content: r.content?.slice(0, 200) || '',
          created_at: Number(r.createdAt),
          productId: r.productId,
          productTitle: label?.title || r.productTitle || undefined,
          productImage: label?.image || r.productImage || undefined,
          status: r.status,
          verified: r.verified,
          hasReply: !!r.reply,
        };
      }),
      recentQuestions: recentQuestionItems.map((q) => ({
        id: q.questionId,
        question: q.question?.slice(0, 200) || '',
        author: q.author,
        status: q.status,
        answered: !!q.answer,
        created_at: Number(q.createdAt),
        productId: q.productId,
        productTitle: labelOf(q.productId)?.title || q.productTitle || undefined,
      })),
      reviewTrend: reviewTrend ?? this.emptyTrend(),
      attentionProducts: products?.attentionProducts ?? [],
      productStats,
      degraded: [...degraded].sort(),
    };
  }

  private trendWindow(): { startMs: number; dates: string[] } {
    const localToday = Math.floor((Date.now() + VN_OFFSET_MS) / DAY_MS) * DAY_MS;
    const startLocal = localToday - (TREND_DAYS - 1) * DAY_MS;
    const dates = Array.from({ length: TREND_DAYS }, (_, index) =>
      new Date(startLocal + index * DAY_MS).toISOString().slice(0, 10),
    );
    return { startMs: startLocal - VN_OFFSET_MS, dates };
  }

  private emptyTrend(): Array<{ date: string; count: number }> {
    return this.trendWindow().dates.map((date) => ({ date, count: 0 }));
  }

  private async loadReviewTrend(shopId: string): Promise<Array<{ date: string; count: number }>> {
    const { startMs, dates } = this.trendWindow();
    const rows = await this.prisma.$queryRaw<Array<{ day: string; count: number }>>(Prisma.sql`
      SELECT to_char(to_timestamp("created_at" / 1000.0) AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS day,
             COUNT(*)::int AS count
      FROM "review_products"
      WHERE "shop_id" = ${shopId} AND "created_at" >= ${BigInt(startMs)}
      GROUP BY 1
    `);
    const byDay = new Map(rows.map((row) => [row.day, Number(row.count)]));
    return dates.map((date) => ({ date, count: byDay.get(date) ?? 0 }));
  }

  private async loadProductStats(
    shopId: string,
  ): Promise<{ productStats: ProductStat[]; attentionProducts: AttentionProduct[] }> {
    const [reviewGroups, approvedGroups, qnaGroups, answeredGroups] = await Promise.all([
      this.prisma.reviewProduct.groupBy({
        by: ['productId'],
        where: { shopId },
        _count: { _all: true },
        _max: { productTitle: true, productImage: true },
      }),
      this.prisma.reviewProduct.groupBy({
        by: ['productId'],
        where: { shopId, status: 'approved' },
        _count: { _all: true },
        _avg: { rating: true },
      }),
      this.prisma.qnaQuestion.groupBy({
        by: ['productId'],
        where: { shopId },
        _count: { _all: true },
        _max: { productTitle: true, productImage: true },
      }),
      this.prisma.qnaQuestion.groupBy({
        by: ['productId'],
        where: { AND: [{ shopId }, ANSWERED_WHERE] },
        _count: { _all: true },
      }),
    ]);

    const approved = new Map(approvedGroups.map((g) => [g.productId, { count: g._count._all, avg: g._avg.rating ?? 0 }]));
    const answered = new Map(answeredGroups.map((g) => [g.productId, g._count._all]));
    const reviews = new Map(reviewGroups.map((g) => [g.productId, g]));
    const questions = new Map(qnaGroups.map((g) => [g.productId, g]));

    const ids = Array.from(new Set([...reviews.keys(), ...questions.keys()]));
    const rows = ids.map((productId) => {
      const review = reviews.get(productId);
      const question = questions.get(productId);
      const qnaTotal = question?._count._all ?? 0;
      return {
        productId,
        storedTitle: review?._max.productTitle || question?._max.productTitle || '',
        storedImage: review?._max.productImage || question?._max.productImage || null,
        reviewCount: review?._count._all ?? 0,
        approvedCount: approved.get(productId)?.count ?? 0,
        avgRating: round1(approved.get(productId)?.avg ?? 0),
        qnaTotal,
        qnaUnanswered: Math.max(0, qnaTotal - (answered.get(productId) ?? 0)),
      };
    });

    const attention = rows
      .map((row) => {
        const lowRating = row.approvedCount >= LOW_RATING_MIN_APPROVED && row.avgRating < LOW_RATING_THRESHOLD;
        const unanswered = row.qnaUnanswered > 0;
        if (!lowRating && !unanswered) return null;
        const reason: AttentionProduct['reason'] = lowRating && unanswered ? 'mixed' : lowRating ? 'low_rating' : 'unanswered_qna';
        return { row, reason };
      })
      .filter((entry): entry is { row: (typeof rows)[number]; reason: AttentionProduct['reason'] } => entry !== null)
      .sort((a, b) =>
        Number(b.reason === 'mixed') - Number(a.reason === 'mixed') ||
        b.row.qnaUnanswered - a.row.qnaUnanswered ||
        a.row.avgRating - b.row.avgRating,
      )
      .slice(0, ATTENTION_LIMIT);

    const ranked = [...rows]
      .sort((a, b) => b.reviewCount + b.qnaTotal - (a.reviewCount + a.qnaTotal) || a.productId.localeCompare(b.productId))
      .slice(0, PRODUCT_STATS_LIMIT);

    const labels = await catalogLabels(
      this.prisma,
      shopId,
      [...ranked.map((row) => row.productId), ...attention.map((entry) => entry.row.productId)],
    );
    const titleOf = (row: (typeof rows)[number]): string => labels.get(row.productId)?.title || row.storedTitle;
    const imageOf = (row: (typeof rows)[number]): string | null => labels.get(row.productId)?.image || row.storedImage;

    return {
      productStats: ranked.map((row) => ({
        productId: row.productId,
        title: titleOf(row),
        image: imageOf(row),
        reviewCount: row.reviewCount,
        avgRating: row.avgRating,
        qnaTotal: row.qnaTotal,
        qnaUnanswered: row.qnaUnanswered,
      })),
      attentionProducts: attention.map(({ row, reason }) => ({
        productId: row.productId,
        title: titleOf(row),
        image: imageOf(row),
        reviewAvg: row.avgRating,
        reviewCount: row.reviewCount,
        qnaUnanswered: row.qnaUnanswered,
        reason,
      })),
    };
  }
}
