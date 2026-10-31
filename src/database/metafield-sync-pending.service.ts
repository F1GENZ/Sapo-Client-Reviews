import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 6 * 60 * 60_000;
export const PENDING_MAX_ATTEMPTS = 20;

export type PendingMetafieldSync = {
  id: string;
  storeDomain: string;
  productId: string;
  attempts: number;
  updatedAt: Date;
};

export type PendingMetafieldCounts = { total: number; due: number; failed: number };

export const pendingBackoffMs = (attempts: number): number =>
  Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts));

let lastStamp = 0;
// Strictly increasing within the process, so a clear stamped earlier can never match a later intent.
const nextStamp = (): Date => {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return new Date(lastStamp);
};

@Injectable()
export class MetafieldSyncPendingService {
  private readonly logger = new Logger(MetafieldSyncPendingService.name);

  constructor(private readonly prisma: PrismaService) {}

  async markDirty(storeDomain: string, productId: string): Promise<Date> {
    const stamp = nextStamp();
    const dueNow = new Date();
    const row = await this.prisma.metafieldSyncPending.upsert({
      where: { storeDomain_productId: { storeDomain, productId } },
      create: { storeDomain, productId, nextAttemptAt: dueNow, updatedAt: stamp },
      update: { attempts: 0, lastError: null, nextAttemptAt: dueNow, updatedAt: stamp },
      select: { updatedAt: true },
    });
    return row.updatedAt;
  }

  async clear(storeDomain: string, productId: string, stamp: Date): Promise<boolean> {
    const result = await this.prisma.metafieldSyncPending.deleteMany({
      where: { storeDomain, productId, updatedAt: { lte: stamp } },
    });
    return result.count > 0;
  }

  async recordFailure(
    storeDomain: string,
    productId: string,
    error: string,
    options: { countAttempt?: boolean; retryInMs?: number } = {},
  ): Promise<{ exhausted: boolean }> {
    const row = await this.prisma.metafieldSyncPending.findUnique({
      where: { storeDomain_productId: { storeDomain, productId } },
      select: { attempts: true },
    });
    if (!row) return { exhausted: false };
    const attempts = Math.min(PENDING_MAX_ATTEMPTS, row.attempts + (options.countAttempt === false ? 0 : 1));
    const exhausted = attempts >= PENDING_MAX_ATTEMPTS;
    if (exhausted && row.attempts < PENDING_MAX_ATTEMPTS) {
      this.logger.error(
        `Metafield sync for product ${productId} at ${storeDomain} failed ${PENDING_MAX_ATTEMPTS} times; intent kept as failed and retried every ${BACKOFF_CAP_MS / 60_000} minutes: ${error.slice(0, 200)}`,
      );
    }
    const retryInMs = options.retryInMs ?? pendingBackoffMs(attempts);
    await this.prisma.metafieldSyncPending.updateMany({
      where: { storeDomain, productId },
      data: {
        attempts,
        lastError: error.slice(0, 500),
        nextAttemptAt: new Date(Date.now() + retryInMs),
      },
    });
    return { exhausted };
  }

  async listDue(after: string, limit: number, now = new Date()): Promise<PendingMetafieldSync[]> {
    return this.prisma.metafieldSyncPending.findMany({
      where: { nextAttemptAt: { lte: now }, ...(after ? { id: { gt: after } } : {}) },
      orderBy: { id: 'asc' },
      take: limit,
      select: { id: true, storeDomain: true, productId: true, attempts: true, updatedAt: true },
    });
  }

  async countFailed(storeDomain?: string): Promise<number> {
    return this.prisma.metafieldSyncPending.count({
      where: { attempts: { gte: PENDING_MAX_ATTEMPTS }, ...(storeDomain ? { storeDomain } : {}) },
    });
  }

  async countsFor(storeDomain: string, now = new Date()): Promise<PendingMetafieldCounts> {
    const [total, due, failed] = await Promise.all([
      this.prisma.metafieldSyncPending.count({ where: { storeDomain } }),
      this.prisma.metafieldSyncPending.count({ where: { storeDomain, nextAttemptAt: { lte: now } } }),
      this.countFailed(storeDomain),
    ]);
    return { total, due, failed };
  }

  async drop(storeDomain: string, productId: string): Promise<void> {
    await this.prisma.metafieldSyncPending.deleteMany({ where: { storeDomain, productId } });
  }
}
