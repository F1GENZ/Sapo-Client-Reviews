import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { catalogLabels } from '../catalog/product-label';
import type { CatalogLabel } from '../catalog/product-label';
import { PUBLIC_MAX_OFFSET } from '../common/security/public-limits';
import { QnaStoreService } from './qna-store.service';
import type { QnaQuestionRecord } from './qna-store.service';
import type { Question, QnaSummary } from './interfaces/qna.interface';
import type { CreateQuestionDto } from './dto/create-question.dto';
import type { UpdateQuestionDto } from './dto/update-question.dto';
import type { AnswerQuestionDto } from './dto/answer-question.dto';

export type QuestionListItem = Question & {
  productId: string;
  productTitle?: string;
  productName?: string;
  productHandle?: string;
  productImage?: string;
};

export type QnaPageStatus = 'all' | 'pending' | 'hidden' | 'answered' | 'unanswered';
export type QnaPageSort = 'newest' | 'oldest';

export type QnaPage = {
  items: QuestionListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  statusCounts: Record<QnaPageStatus, number>;
};

export type ListAllQuestionsOptions = {
  page?: number;
  limit?: number;
  status?: string;
  sort?: string;
  productId?: string;
  search?: string;
};

export type PublicQuestionsOptions = {
  page?: number;
  limit?: number;
};

export type PublicQuestionsPage = { items: Question[]; total: number; page: number; pageSize: number };

const ADMIN_MAX_PAGE_SIZE = 100;
const PUBLIC_MAX_PAGE_SIZE = 50;
const SEARCH_MAX_LENGTH = 100;

const ANSWERED_WHERE: Prisma.QnaQuestionWhereInput = { answer: { not: null }, NOT: { answer: '' } };
const UNANSWERED_WHERE: Prisma.QnaQuestionWhereInput = { OR: [{ answer: null }, { answer: '' }] };

const isQnaPageStatus = (value: unknown): value is QnaPageStatus =>
  ['all', 'pending', 'hidden', 'answered', 'unanswered'].includes(String(value));

const toDomainQuestion = (row: QnaQuestionRecord): Question => ({
  id: row.questionId,
  question: row.question || '',
  author: row.author || '',
  email: row.email || undefined,
  phone: row.phone || undefined,
  answer: row.answer || undefined,
  answered_by: row.answeredBy || undefined,
  status: row.status as Question['status'],
  created_at: Number(row.createdAt),
  updated_at: Number(row.updatedAt),
  answered_at: row.answeredAt ? Number(row.answeredAt) : undefined,
  source_raw_json: row.sourceRawJson || undefined,
});

export const toPublicQuestion = (row: QnaQuestionRecord): Question => {
  const question = toDomainQuestion(row);
  delete question.email;
  delete question.phone;
  delete question.source_raw_json;
  return question;
};

const toQuestionListItem = (row: QnaQuestionRecord, label?: CatalogLabel): QuestionListItem => {
  const title = label?.title || row.productTitle || undefined;
  return {
    ...toDomainQuestion(row),
    productId: row.productId,
    productTitle: title,
    productName: title || row.productName || undefined,
    productHandle: label?.handle || row.productHandle || undefined,
    productImage: label?.image || row.productImage || undefined,
  };
};

const normalizePublicPaging = (options: PublicQuestionsOptions): { page: number; pageSize: number } => ({
  page: Math.max(1, options.page ?? 1),
  pageSize: Math.min(PUBLIC_MAX_PAGE_SIZE, Math.max(1, options.limit ?? 20)),
});

@Injectable()
export class QnaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly qnaStore: QnaStoreService,
  ) {}

  private async resolveInstall(storeDomain: string): Promise<{ shopId: string }> {
    const install = await this.prisma.appInstall.findUnique({
      where: { storeDomain },
      select: { shopId: true },
    });
    if (!install) {
      throw new ConflictException('App not installed for this store');
    }
    return install;
  }

  private async resolveServingInstall(storeDomain: string): Promise<{ shopId: string } | null> {
    const install = await this.prisma.appInstall.findUnique({
      where: { storeDomain },
      select: { shopId: true, status: true },
    });
    if (!install || install.status === 'uninstalled' || install.status === 'declined') return null;
    return { shopId: install.shopId };
  }

  async submitQuestion(
    storeDomain: string,
    productId: string,
    dto: CreateQuestionDto,
  ): Promise<Question> {
    const install = await this.resolveInstall(storeDomain);
    const shopId = install.shopId;

    const now = Date.now();
    const questionId = randomUUID();

    await this.qnaStore.upsertQuestion({
      shopId,
      productId,
      questionId,
      question: dto.question,
      author: dto.author,
      email: dto.email ?? null,
      phone: dto.phone ?? null,
      status: 'pending',
      createdAt: now,
    });

    return {
      id: questionId,
      question: dto.question,
      author: dto.author,
      email: dto.email,
      phone: dto.phone,
      status: 'pending',
      created_at: now,
      updated_at: now,
    };
  }

  async answerQuestion(
    storeDomain: string,
    productId: string,
    questionId: string,
    dto: AnswerQuestionDto,
  ): Promise<Question | null> {
    const answer = dto.answer.trim();
    if (!answer) throw new BadRequestException({ code: 'answer_required', message: 'Answer is required' });

    const install = await this.resolveInstall(storeDomain);
    const shopId = install.shopId;

    const existing = await this.qnaStore.getQuestion(shopId, productId, questionId);
    if (!existing) return null;

    const record = await this.qnaStore.updateAnswer(
      shopId,
      productId,
      questionId,
      answer,
      dto.answered_by || 'Shop',
    );

    return toDomainQuestion(record);
  }

  async updateStatus(
    storeDomain: string,
    productId: string,
    questionId: string,
    status: 'pending' | 'approved' | 'hidden',
  ): Promise<Question | null> {
    const install = await this.resolveInstall(storeDomain);
    const shopId = install.shopId;

    const existing = await this.qnaStore.getQuestion(shopId, productId, questionId);
    if (!existing) return null;

    const record = await this.qnaStore.updateStatus(shopId, productId, questionId, status);
    return toDomainQuestion(record);
  }

  async updateQuestion(
    storeDomain: string,
    productId: string,
    questionId: string,
    dto: UpdateQuestionDto,
  ): Promise<Question | null> {
    const install = await this.resolveInstall(storeDomain);
    const shopId = install.shopId;

    const existing = await this.qnaStore.getQuestion(shopId, productId, questionId);
    if (!existing) return null;

    const record = await this.qnaStore.upsertQuestion({
      shopId,
      productId,
      questionId,
      question: dto.question !== undefined ? dto.question : existing.question,
      author: dto.author !== undefined ? dto.author : existing.author,
      email: existing.email,
      phone: existing.phone,
      answer: dto.answer !== undefined ? dto.answer : existing.answer,
      answeredBy: existing.answeredBy,
      status: existing.status,
      answeredAt: existing.answeredAt ? Number(existing.answeredAt) : null,
      sourceRawJson: existing.sourceRawJson,
    });

    return toDomainQuestion(record);
  }

  async deleteQuestion(
    storeDomain: string,
    productId: string,
    questionId: string,
  ): Promise<boolean> {
    const install = await this.resolveInstall(storeDomain);
    const shopId = install.shopId;
    const existing = await this.qnaStore.getQuestion(shopId, productId, questionId);
    if (!existing) return false;
    return this.qnaStore.deleteQuestion(shopId, productId, questionId);
  }

  async getQuestions(
    storeDomain: string,
    productId: string,
    options: Omit<ListAllQuestionsOptions, 'productId' | 'search'> = {},
  ): Promise<QnaPage> {
    const install = await this.resolveInstall(storeDomain);
    return this.listQuestions(install.shopId, { ...options, productId }, true);
  }

  async getAllQuestions(
    storeDomain: string,
    options: ListAllQuestionsOptions = {},
  ): Promise<QnaPage> {
    const install = await this.resolveInstall(storeDomain);
    return this.listQuestions(install.shopId, options, false);
  }

  private async listQuestions(
    shopId: string,
    options: ListAllQuestionsOptions,
    scopeCountsToProduct: boolean,
  ): Promise<QnaPage> {
    const page = Math.max(1, options.page ?? 1);
    const pageSize = Math.min(ADMIN_MAX_PAGE_SIZE, Math.max(1, options.limit ?? 20));
    const status: QnaPageStatus = isQnaPageStatus(options.status) ? options.status : 'all';
    const sortBy: QnaPageSort = options.sort === 'oldest' ? 'oldest' : 'newest';

    const conditions: Prisma.QnaQuestionWhereInput[] = [{ shopId }];
    if (options.productId) conditions.push({ productId: options.productId });
    if (status === 'answered') conditions.push(ANSWERED_WHERE);
    else if (status === 'unanswered') conditions.push(UNANSWERED_WHERE);
    else if (status !== 'all') conditions.push({ status });

    const search = options.search?.trim().slice(0, SEARCH_MAX_LENGTH);
    if (search) {
      conditions.push({
        OR: [
          { question: { contains: search, mode: Prisma.QueryMode.insensitive } },
          { author: { contains: search, mode: Prisma.QueryMode.insensitive } },
        ],
      });
    }
    const where: Prisma.QnaQuestionWhereInput = { AND: conditions };

    const countScope: Prisma.QnaQuestionWhereInput =
      scopeCountsToProduct && options.productId ? { shopId, productId: options.productId } : { shopId };
    const [statusGroups, answeredCount, total] = await Promise.all([
      this.prisma.qnaQuestion.groupBy({ by: ['status'], where: countScope, _count: { _all: true } }),
      this.prisma.qnaQuestion.count({ where: { AND: [countScope, ANSWERED_WHERE] } }),
      this.prisma.qnaQuestion.count({ where }),
    ]);

    const statusCounts: Record<QnaPageStatus, number> = {
      all: 0,
      pending: 0,
      hidden: 0,
      answered: answeredCount,
      unanswered: 0,
    };
    for (const group of statusGroups) {
      statusCounts.all += group._count._all;
      if (group.status === 'pending') statusCounts.pending = group._count._all;
      else if (group.status === 'hidden') statusCounts.hidden = group._count._all;
    }
    statusCounts.unanswered = Math.max(0, statusCounts.all - answeredCount);

    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const currentPage = Math.min(page, totalPages);

    const rows = await this.prisma.qnaQuestion.findMany({
      where,
      orderBy: [{ createdAt: sortBy === 'oldest' ? 'asc' : 'desc' }, { id: 'asc' }],
      skip: (currentPage - 1) * pageSize,
      take: pageSize,
    });
    const labels = await catalogLabels(this.prisma, shopId, rows.map((row) => row.productId));

    return {
      items: rows.map((row) => toQuestionListItem(row, labels.get(row.productId))),
      total,
      page: currentPage,
      pageSize,
      totalPages,
      statusCounts,
    };
  }

  async getStats(
    storeDomain: string,
    productId: string,
  ): Promise<QnaSummary> {
    const install = await this.resolveInstall(storeDomain);
    return this.qnaStore.getStats(install.shopId, productId);
  }

  emptyPublicPage(options: PublicQuestionsOptions = {}): PublicQuestionsPage {
    return { items: [], total: 0, ...normalizePublicPaging(options) };
  }

  async getPublicQuestions(
    storeDomain: string,
    productId: string,
    options: PublicQuestionsOptions = {},
  ): Promise<PublicQuestionsPage> {
    const { page, pageSize } = normalizePublicPaging(options);
    const install = await this.resolveServingInstall(storeDomain);
    if (!install) return { items: [], total: 0, page, pageSize };

    const skip = (page - 1) * pageSize;
    const where: Prisma.QnaQuestionWhereInput = {
      shopId: install.shopId,
      productId,
      status: 'approved',
      ...ANSWERED_WHERE,
    };

    const [items, total] = await Promise.all([
      skip > PUBLIC_MAX_OFFSET
        ? Promise.resolve([])
        : this.prisma.qnaQuestion.findMany({
            where,
            orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
            skip,
            take: pageSize,
          }),
      this.prisma.qnaQuestion.count({ where }),
    ]);

    return {
      items: items.map((row) => toPublicQuestion(row)),
      total,
      page,
      pageSize,
    };
  }

  async submitPublicQuestion(
    storeDomain: string,
    productId: string,
    dto: CreateQuestionDto,
  ): Promise<Question> {
    if (!(await this.resolveServingInstall(storeDomain))) {
      throw new ConflictException({ code: 'store_not_serving', message: 'App not installed for this store' });
    }
    return this.submitQuestion(storeDomain, productId, dto);
  }
}
