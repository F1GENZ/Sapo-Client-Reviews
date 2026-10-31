import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { labelUpdateFields, resolveProductLabel } from '../catalog/product-label';
import type { QnaSummary } from './interfaces/qna.interface';

export interface QnaQuestionUpsertInput {
  shopId: string;
  productId: string;
  questionId: string;
  question: string;
  author: string;
  email?: string | null;
  phone?: string | null;
  answer?: string | null;
  answeredBy?: string | null;
  status?: string;
  answeredAt?: number | null;
  sourceRawJson?: string | null;
  createdAt?: number;
  productTitle?: string | null;
  productName?: string | null;
  productHandle?: string | null;
  productImage?: string | null;
}

export interface QnaQuestionRecord {
  id: string;
  shopId: string;
  productId: string;
  productTitle: string | null;
  productName: string | null;
  productHandle: string | null;
  productImage: string | null;
  questionId: string;
  question: string;
  author: string;
  email: string | null;
  phone: string | null;
  answer: string | null;
  answeredBy: string | null;
  status: string;
  answeredAt: bigint | null;
  sourceRawJson: string | null;
  createdAt: bigint;
  updatedAt: bigint;
}

export interface QnaPageOptions {
  status?: string;
  page?: number;
  size?: number;
  sort?: string;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

const DEFAULT_PAGE = 0;
const DEFAULT_SIZE = 20;
const MAX_SIZE = 100;

const normalizeInt = (value: unknown, fallback: number): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
};

const clampSize = (raw: unknown): number => {
  const n = normalizeInt(raw, DEFAULT_SIZE);
  return Math.max(1, Math.min(MAX_SIZE, n));
};

const clampPage = (raw: unknown): number => {
  return Math.max(0, normalizeInt(raw, DEFAULT_PAGE));
};

const buildOrderBy = (
  sort?: string,
): Prisma.QnaQuestionOrderByWithRelationInput => {
  if (!sort) return { createdAt: 'desc' };

  const [rawField, rawDir] = sort.split(',');
  const field = (rawField ?? '').trim();
  const direction =
    (rawDir ?? '').trim().toLowerCase() === 'asc' ? 'asc' : 'desc';

  switch (field) {
    case 'updated_at':
      return { updatedAt: direction };
    default:
      return { createdAt: direction };
  }
};

@Injectable()
export class QnaStoreService {
  constructor(private readonly prisma: PrismaService) {}

  async upsertQuestion(
    input: QnaQuestionUpsertInput,
  ): Promise<QnaQuestionRecord> {
    const now = BigInt(Date.now());
    const label = await resolveProductLabel(this.prisma, input.shopId, input.productId, input);

    const data = {
      shopId: input.shopId,
      productId: input.productId,
      questionId: input.questionId,
      question: input.question,
      author: input.author,
      email: input.email ?? null,
      phone: input.phone ?? null,
      answer: input.answer ?? null,
      answeredBy: input.answeredBy ?? null,
      status: input.status || 'pending',
      answeredAt: input.answeredAt != null ? BigInt(input.answeredAt) : null,
      sourceRawJson: input.sourceRawJson ?? null,
      updatedAt: now,
    };

    return this.prisma.qnaQuestion.upsert({
      where: {
        shopId_productId_questionId: {
          shopId: input.shopId,
          productId: input.productId,
          questionId: input.questionId,
        },
      },
      create: {
        ...data,
        ...label,
        createdAt: input.createdAt ? BigInt(input.createdAt) : now,
      },
      update: { ...data, ...labelUpdateFields(label) },
    });
  }

  async getQuestion(
    shopId: string,
    productId: string,
    questionId: string,
  ): Promise<QnaQuestionRecord | null> {
    return this.prisma.qnaQuestion.findUnique({
      where: {
        shopId_productId_questionId: { shopId, productId, questionId },
      },
    });
  }

  async deleteQuestion(shopId: string, productId: string, questionId: string): Promise<boolean> {
    const result = await this.prisma.qnaQuestion.deleteMany({
      where: { shopId, productId, questionId },
    });
    return result.count > 0;
  }

  async getAllQuestions(
    shopId: string,
    options: QnaPageOptions = {},
  ): Promise<PaginatedResult<QnaQuestionRecord>> {
    const page = clampPage(options.page);
    const pageSize = clampSize(options.size);
    const skip = page * pageSize;

    const where: Prisma.QnaQuestionWhereInput = { shopId };
    if (options.status) {
      where.status = options.status;
    }

    const orderBy = buildOrderBy(options.sort);

    const [items, total] = await Promise.all([
      this.prisma.qnaQuestion.findMany({ where, orderBy, skip, take: pageSize }),
      this.prisma.qnaQuestion.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  async updateStatus(
    shopId: string,
    productId: string,
    questionId: string,
    status: string,
  ): Promise<QnaQuestionRecord> {
    return this.prisma.qnaQuestion.update({
      where: {
        shopId_productId_questionId: { shopId, productId, questionId },
      },
      data: {
        status,
        updatedAt: BigInt(Date.now()),
      },
    });
  }

  async updateAnswer(
    shopId: string,
    productId: string,
    questionId: string,
    answer: string,
    answeredBy?: string,
  ): Promise<QnaQuestionRecord> {
    return this.prisma.qnaQuestion.update({
      where: {
        shopId_productId_questionId: { shopId, productId, questionId },
      },
      data: {
        answer,
        answeredBy: answeredBy ?? null,
        status: 'approved',
        answeredAt: BigInt(Date.now()),
        updatedAt: BigInt(Date.now()),
      },
    });
  }

  async getStats(
    shopId: string,
    productId?: string,
  ): Promise<QnaSummary> {
    const scope: Prisma.QnaQuestionWhereInput = productId ? { shopId, productId } : { shopId };
    const aggregation = await this.prisma.qnaQuestion.aggregate({
      where: scope,
      _count: { id: true },
    });
    const answered = await this.prisma.qnaQuestion.count({
      where: {
        ...scope,
        answer: { not: null },
        NOT: { answer: '' },
      },
    });
    const total = aggregation._count.id;

    return {
      total,
      answered,
      unanswered: Math.max(0, total - answered),
    };
  }

  async getStatusCounts(shopId: string): Promise<{ pending: number; hidden: number }> {
    const groups = await this.prisma.qnaQuestion.groupBy({
      by: ['status'],
      where: { shopId },
      _count: true,
    });
    const counts = { pending: 0, hidden: 0 };
    for (const g of groups) {
      if (g.status === 'pending') counts.pending = g._count;
      else if (g.status === 'hidden') counts.hidden = g._count;
    }
    return counts;
  }
}
