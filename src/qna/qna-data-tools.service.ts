import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { parseCsvRecords, toCsv } from '../common/csv';
import { STRICT_EMAIL_RE, isValidPhone } from '../common/security/public-limits';
import { CatalogProductStoreService } from '../catalog/catalog-product-store.service';
import { PrismaService } from '../database/prisma.service';
import { OutboundWebhookService } from '../outbound/outbound-webhook.service';
import { QnaStoreService } from './qna-store.service';

export const MAX_QNA_IMPORT_ROWS = 2000;
export const MAX_QNA_BULK_ITEMS = 500;
const MAX_QNA_EXPORT_ROWS = 10_000;
const MAX_ERRORS_RETURNED = 50;
const STATUS_VALUES = ['pending', 'approved', 'hidden'] as const;

export type QnaImportFormat = 'csv' | 'json';
export type QnaBulkAction = 'approve' | 'pending' | 'hidden' | 'delete';

type ParsedQuestion = {
  productId: string;
  questionId: string;
  question: string;
  author: string;
  email: string | null;
  phone: string | null;
  answer: string | null;
  answeredBy: string | null;
  status: (typeof STATUS_VALUES)[number];
  createdAt: number | null;
};

const asText = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';

const parseTimestamp = (value: unknown): number | null => {
  const text = asText(value);
  if (!text) return null;
  const numeric = Number(text);
  const parsed = Number.isFinite(numeric) && numeric > 0 ? numeric : Date.parse(text);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(Date.now() + 86_400_000, Math.max(Date.parse('2020-01-01T00:00:00Z'), Math.trunc(parsed)));
};

const parseRow = (record: Record<string, unknown>): ParsedQuestion => {
  const productId = asText(record.product_id ?? record.productId);
  if (!/^[1-9]\d{0,19}$/.test(productId)) throw new BadRequestException('product_id is required');
  const questionId = asText(record.question_id ?? record.questionId ?? record.id);
  if (!questionId || questionId.length > 64) throw new BadRequestException('question_id must be 1-64 characters');
  const question = typeof record.question === 'string' ? record.question : asText(record.question);
  if (!question || question.length > 1000) throw new BadRequestException('question must be 1-1000 characters');
  const author = asText(record.author);
  if (!author || author.length > 100) throw new BadRequestException('author must be 1-100 characters');
  const email = asText(record.email);
  if (email && (!STRICT_EMAIL_RE.test(email) || email.length > 200)) throw new BadRequestException('email is invalid');
  const phone = asText(record.phone);
  if (phone && (!isValidPhone(phone) || phone.length > 20)) throw new BadRequestException('phone is invalid');
  const answer = asText(record.answer);
  if (answer.length > 2000) throw new BadRequestException('answer must be at most 2000 characters');
  const answeredBy = asText(record.answered_by ?? record.answeredBy);
  const statusText = asText(record.status).toLowerCase() || 'pending';
  if (!(STATUS_VALUES as readonly string[]).includes(statusText)) {
    throw new BadRequestException('status must be pending, approved or hidden');
  }
  return {
    productId,
    questionId,
    question,
    author,
    email: email || null,
    phone: phone || null,
    answer: answer || null,
    answeredBy: answeredBy || null,
    status: statusText as ParsedQuestion['status'],
    createdAt: parseTimestamp(record.created_at ?? record.createdAt),
  };
};

const readRecords = (format: QnaImportFormat, body: string): Array<Record<string, unknown>> => {
  if (format === 'csv') return parseCsvRecords(body) as Array<Record<string, unknown>>;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new BadRequestException('JSON body is invalid');
  }
  if (!Array.isArray(parsed)) throw new BadRequestException('JSON body must be an array of rows');
  return parsed.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object');
};

@Injectable()
export class QnaDataToolsService {
  private readonly logger = new Logger(QnaDataToolsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly qnaStore: QnaStoreService,
    private readonly catalogStore: CatalogProductStoreService,
    private readonly outbound: OutboundWebhookService,
  ) {}

  private async requireInstall(storeDomain: string): Promise<string> {
    const install = await this.prisma.appInstall.findUnique({
      where: { storeDomain },
      select: { shopId: true },
    });
    if (!install) throw new ConflictException('App not installed for this store');
    return install.shopId;
  }

  async exportQuestions(storeDomain: string, format: QnaImportFormat) {
    const shopId = await this.requireInstall(storeDomain);
    const rows = await this.prisma.qnaQuestion.findMany({
      where: { shopId },
      orderBy: { createdAt: 'desc' },
      take: MAX_QNA_EXPORT_ROWS,
    });
    const records = rows.map((row) => ({
      product_id: row.productId,
      question_id: row.questionId,
      question: row.question,
      author: row.author,
      email: row.email ?? '',
      phone: row.phone ?? '',
      answer: row.answer ?? '',
      answered_by: row.answeredBy ?? '',
      status: row.status,
      created_at: Number(row.createdAt),
      answered_at: row.answeredAt === null ? '' : Number(row.answeredAt),
    }));
    if (format === 'json') {
      return {
        filename: `f1genz-qna-${storeDomain}.json`,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(records),
      };
    }
    const header = [
      'product_id', 'question_id', 'question', 'author', 'email', 'phone',
      'answer', 'answered_by', 'status', 'created_at', 'answered_at',
    ];
    const csvRows = [header, ...records.map((record) => header.map((key) => record[key as keyof typeof record]))];
    return {
      filename: `f1genz-qna-${storeDomain}.csv`,
      contentType: 'text/csv; charset=utf-8',
      body: toCsv(csvRows),
    };
  }

  async importQuestions(
    storeDomain: string,
    input: { format: QnaImportFormat; body: string; dryRun: boolean },
  ) {
    const shopId = await this.requireInstall(storeDomain);
    const records = readRecords(input.format, input.body);
    if (records.length === 0) throw new BadRequestException('No rows to import');
    if (records.length > MAX_QNA_IMPORT_ROWS) {
      throw new BadRequestException(`At most ${MAX_QNA_IMPORT_ROWS} rows per import`);
    }
    const result = {
      mode: input.dryRun ? 'dry_run' : 'apply',
      format: input.format,
      total: records.length,
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      errors: [] as Array<{ row: number; questionId?: string; message: string }>,
      runId: null as string | null,
    };

    for (let index = 0; index < records.length; index += 1) {
      const rowNumber = index + 1;
      let parsed: ParsedQuestion;
      try {
        parsed = parseRow(records[index]);
      } catch (error) {
        result.failed += 1;
        if (result.errors.length < MAX_ERRORS_RETURNED) {
          result.errors.push({ row: rowNumber, message: error instanceof Error ? error.message : 'invalid row' });
        }
        continue;
      }
      const product = await this.catalogStore.getProduct(shopId, parsed.productId);
      if (!product || product.deletedAt) {
        result.skipped += 1;
        if (result.errors.length < MAX_ERRORS_RETURNED) {
          result.errors.push({ row: rowNumber, questionId: parsed.questionId, message: 'product_not_in_catalog' });
        }
        continue;
      }
      const existing = await this.qnaStore.getQuestion(shopId, parsed.productId, parsed.questionId);
      if (!input.dryRun) {
        await this.qnaStore.upsertQuestion({
          shopId,
          productId: parsed.productId,
          questionId: parsed.questionId,
          question: parsed.question,
          author: parsed.author,
          email: parsed.email,
          phone: parsed.phone,
          answer: parsed.answer,
          answeredBy: parsed.answeredBy,
          status: parsed.status,
          answeredAt: parsed.answer ? Date.now() : null,
          createdAt: parsed.createdAt ?? Date.now(),
        });
      }
      if (existing) result.updated += 1;
      else result.created += 1;
    }

    if (!input.dryRun) {
      const run = await this.prisma.importRun.create({
        data: {
          shopId,
          storeDomain,
          kind: 'qna',
          mode: result.mode,
          format: result.format,
          total: result.total,
          created: result.created,
          updated: result.updated,
          skipped: result.skipped,
          failed: result.failed,
          errors: result.errors.length
            ? (result.errors.slice(0, MAX_ERRORS_RETURNED) as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
        },
        select: { id: true },
      });
      result.runId = run.id;
    }
    return result;
  }

  async bulkQuestions(
    storeDomain: string,
    action: QnaBulkAction,
    items: Array<{ productId: string; questionId: string }>,
  ) {
    const shopId = await this.requireInstall(storeDomain);
    if (items.length === 0) throw new BadRequestException('At least one question is required');
    if (items.length > MAX_QNA_BULK_ITEMS) throw new BadRequestException(`At most ${MAX_QNA_BULK_ITEMS} questions per bulk action`);
    const result = { requested: items.length, updated: 0, deleted: 0, skipped: 0, failed: 0 };
    for (const item of items) {
      try {
        const existing = await this.qnaStore.getQuestion(shopId, item.productId, item.questionId);
        if (!existing) {
          result.skipped += 1;
          continue;
        }
        if (action === 'delete') {
          const deleted = await this.qnaStore.deleteQuestion(shopId, item.productId, item.questionId);
          if (deleted) result.deleted += 1;
          else result.skipped += 1;
          continue;
        }
        const targetStatus = action === 'approve' ? 'approved' : action;
        if (existing.status === targetStatus) {
          result.skipped += 1;
          continue;
        }
        await this.qnaStore.updateStatus(shopId, item.productId, item.questionId, targetStatus);
        result.updated += 1;
      } catch (error) {
        result.failed += 1;
        this.logger.warn(
          `Q&A bulk ${action} failed for ${item.productId}/${item.questionId}: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }
    return result;
  }

  async listImportRuns(storeDomain: string) {
    return this.prisma.importRun.findMany({
      where: { storeDomain, kind: 'qna' },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true, mode: true, format: true, total: true, created: true,
        updated: true, skipped: true, failed: true, createdAt: true,
      },
    });
  }
}
