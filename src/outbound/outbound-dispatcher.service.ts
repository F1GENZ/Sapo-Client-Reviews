import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'crypto';
import { APP_ENV } from '../config/app-config.module';
import type { AppEnv } from '../config/env.schema';
import { PrismaService } from '../database/prisma.service';
import { TokenEncryptionService } from '../sapo/token-encryption.service';
import { assertOutboundUrlSafe, type AddressResolver } from './ip-guard';

export const OUTBOUND_TIMEOUT_MS = 8_000;
export const OUTBOUND_MAX_ATTEMPTS = 5;
export const OUTBOUND_SENDING_STALE_MS = 5 * 60_000;
const RETRY_BASE_MS = 60_000;
const RETRY_CAP_MS = 6 * 60 * 60_000;
const DISPATCH_PAGE = 25;
const DISPATCH_MAX = 100;
const MAX_RESPONSE_SNIPPET = 300;

export const signOutboundPayload = (body: string, secret: string): string =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

const retryDelayMs = (attempts: number): number =>
  Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 4 ** Math.max(0, attempts - 1));

const readSnippet = async (response: Response): Promise<string> => {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
        if (total >= MAX_RESPONSE_SNIPPET) break;
      }
    }
  } finally {
    await reader.cancel().catch(() => false);
  }
  return Buffer.concat(chunks).subarray(0, MAX_RESPONSE_SNIPPET).toString('utf8');
};

@Injectable()
export class OutboundDispatcherService {
  private readonly logger = new Logger(OutboundDispatcherService.name);
  private running = false;

  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly prisma: PrismaService,
    private readonly encryption: TokenEncryptionService,
  ) {}

  async dispatchDue(options: { maxDeliveries?: number; now?: Date; resolve?: AddressResolver } = {}): Promise<{
    attempted: number;
    delivered: number;
    failed: number;
  }> {
    const totals = { attempted: 0, delivered: 0, failed: 0 };
    if (this.running) return totals;
    this.running = true;
    const now = options.now ?? new Date();
    const maxDeliveries = Math.min(DISPATCH_MAX, options.maxDeliveries ?? DISPATCH_MAX);
    try {
      for (;;) {
        if (totals.attempted >= maxDeliveries) break;
        const rows = await this.prisma.outboundWebhookDelivery.findMany({
          where: {
            status: { in: ['pending', 'failed'] },
            OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
            attempts: { lt: OUTBOUND_MAX_ATTEMPTS },
          },
          orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
          take: Math.min(DISPATCH_PAGE, maxDeliveries - totals.attempted),
        });
        if (rows.length === 0) break;
        for (const row of rows) {
          const claim = await this.prisma.outboundWebhookDelivery.updateMany({
            where: {
              id: row.id,
              status: { in: ['pending', 'failed'] },
              OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
            },
            data: { status: 'sending', attempts: { increment: 1 } },
          });
          if (claim.count === 0) continue;
          totals.attempted += 1;
          const outcome = await this.deliver(row.id, options.resolve);
          if (outcome === 'delivered') totals.delivered += 1;
          else totals.failed += 1;
        }
        if (rows.length < DISPATCH_PAGE) break;
      }
      return totals;
    } finally {
      this.running = false;
    }
  }

  private async deliver(deliveryId: string, resolve?: AddressResolver): Promise<'delivered' | 'failed'> {
    const delivery = await this.prisma.outboundWebhookDelivery.findUnique({
      where: { id: deliveryId },
      include: { endpoint: true },
    }).catch(() => null);
    if (!delivery) return 'failed';
    const endpoint = delivery.endpoint;
    if (!endpoint || !endpoint.active) {
      await this.terminal(deliveryId, 'endpoint_inactive');
      return 'failed';
    }
    const secret = this.encryption.optionalDecrypt({
      ciphertext: endpoint.secretCiphertext ?? undefined,
      iv: endpoint.secretIv ?? undefined,
      tag: endpoint.secretTag ?? undefined,
    });
    if (!secret) {
      await this.terminal(deliveryId, 'secret_unavailable');
      return 'failed';
    }
    let url: URL;
    try {
      url = await assertOutboundUrlSafe(endpoint.url, resolve);
    } catch (error) {
      await this.terminal(deliveryId, error instanceof Error ? error.message : 'unsafe_url');
      return 'failed';
    }

    const body = JSON.stringify({
      id: delivery.id,
      event: delivery.event,
      sent_at: new Date().toISOString(),
      store_domain: delivery.storeDomain,
      data: delivery.payload,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OUTBOUND_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'user-agent': 'f1genz-review-sapo/1',
          'x-f1genz-event': delivery.event,
          'x-f1genz-delivery': delivery.id,
          'x-f1genz-signature': signOutboundPayload(body, secret),
        },
        body,
      });
      const snippet = await readSnippet(response).catch(() => '');
      if (response.ok) {
        await this.prisma.outboundWebhookDelivery.update({
          where: { id: deliveryId },
          data: {
            status: 'delivered',
            responseStatus: response.status,
            lastError: null,
            deliveredAt: new Date(),
            nextAttemptAt: null,
          },
        });
        return 'delivered';
      }
      await this.scheduleRetry(deliveryId, delivery.attempts + 1, response.status, `HTTP ${response.status} ${snippet}`.trim());
      return 'failed';
    } catch (error) {
      const message = error instanceof Error ? error.message : 'request_failed';
      await this.scheduleRetry(deliveryId, delivery.attempts + 1, null, message.slice(0, MAX_RESPONSE_SNIPPET));
      return 'failed';
    } finally {
      clearTimeout(timer);
    }
  }

  private async scheduleRetry(
    deliveryId: string,
    attemptsUsed: number,
    responseStatus: number | null,
    message: string,
  ): Promise<void> {
    const exhausted = attemptsUsed >= OUTBOUND_MAX_ATTEMPTS;
    await this.prisma.outboundWebhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'failed',
        responseStatus,
        lastError: message.slice(0, 500),
        nextAttemptAt: exhausted ? null : new Date(Date.now() + retryDelayMs(attemptsUsed)),
      },
    });
    if (exhausted) {
      this.logger.warn(`Outbound delivery ${deliveryId} exhausted ${OUTBOUND_MAX_ATTEMPTS} attempts: ${message.slice(0, 120)}`);
    }
  }

  private async terminal(deliveryId: string, message: string): Promise<void> {
    await this.prisma.outboundWebhookDelivery.update({
      where: { id: deliveryId },
      data: { status: 'failed', lastError: message.slice(0, 500), nextAttemptAt: null },
    });
  }

  async reclaimStuck(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - OUTBOUND_SENDING_STALE_MS);
    const rows = await this.prisma.outboundWebhookDelivery.findMany({
      where: { status: 'sending', updatedAt: { lt: cutoff } },
      select: { id: true, attempts: true },
      take: DISPATCH_PAGE,
    });
    let reclaimed = 0;
    for (const row of rows) {
      const exhausted = row.attempts >= OUTBOUND_MAX_ATTEMPTS;
      const result = await this.prisma.outboundWebhookDelivery.updateMany({
        where: { id: row.id, status: 'sending', updatedAt: { lt: cutoff } },
        data: {
          status: 'failed',
          lastError: 'delivery worker stalled',
          nextAttemptAt: exhausted ? null : now,
        },
      });
      reclaimed += result.count;
    }
    return reclaimed;
  }
}
