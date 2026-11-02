import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import { APP_ENV } from '../config/app-config.module';
import type { AppEnv } from '../config/env.schema';
import { PrismaService } from '../database/prisma.service';
import { TokenEncryptionService } from '../sapo/token-encryption.service';
import { assertOutboundUrlSafe, type AddressResolver } from './ip-guard';
import { OutboundDispatcherService } from './outbound-dispatcher.service';

export const OUTBOUND_EVENTS = [
  'review.created',
  'review.approved',
  'review.updated',
  'review.replied',
  'review.deleted',
  'qna.created',
  'qna.answered',
] as const;

export type OutboundEvent = (typeof OUTBOUND_EVENTS)[number];

export const MAX_ENDPOINTS_PER_STORE = 10;
const MAX_DELIVERY_PAGE = 50;
const DELIVERY_LIST_DEFAULT = 20;

export type OutboundEndpointView = {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  active: boolean;
  hasSecret: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type OutboundDeliveryView = {
  id: string;
  endpointId: string;
  event: string;
  status: string;
  attempts: number;
  responseStatus: number | null;
  lastError: string | null;
  deliveredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const toEvents = (value: unknown, allowed: readonly string[]): string[] => {
  if (!Array.isArray(value)) return [];
  const events = value.filter((item): item is string => typeof item === 'string' && allowed.includes(item));
  return [...new Set(events)];
};

const toView = (row: {
  id: string;
  url: string;
  description: string | null;
  events: unknown;
  active: boolean;
  secretCiphertext: string | null;
  createdAt: Date;
  updatedAt: Date;
}): OutboundEndpointView => ({
  id: row.id,
  url: row.url,
  description: row.description,
  events: Array.isArray(row.events) ? row.events.filter((item): item is string => typeof item === 'string') : [],
  active: row.active,
  hasSecret: Boolean(row.secretCiphertext),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

@Injectable()
export class OutboundWebhookService {
  private readonly logger = new Logger(OutboundWebhookService.name);

  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly prisma: PrismaService,
    private readonly encryption: TokenEncryptionService,
    private readonly dispatcher: OutboundDispatcherService,
  ) {}

  private async requireShop(storeDomain: string): Promise<string> {
    const install = await this.prisma.appInstall.findUnique({
      where: { storeDomain },
      select: { shopId: true },
    });
    if (!install) throw new ConflictException('App not installed for this store');
    return install.shopId;
  }

  async list(storeDomain: string): Promise<OutboundEndpointView[]> {
    const rows = await this.prisma.outboundWebhookEndpoint.findMany({
      where: { storeDomain },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toView);
  }

  async create(
    storeDomain: string,
    input: { url: string; events: string[]; description?: string; active?: boolean },
    resolve?: AddressResolver,
  ): Promise<{ endpoint: OutboundEndpointView; secret: string }> {
    const shopId = await this.requireShop(storeDomain);
    const existing = await this.prisma.outboundWebhookEndpoint.count({ where: { storeDomain } });
    if (existing >= MAX_ENDPOINTS_PER_STORE) {
      throw new BadRequestException(`At most ${MAX_ENDPOINTS_PER_STORE} webhook endpoints are allowed`);
    }
    const events = toEvents(input.events, OUTBOUND_EVENTS);
    if (events.length === 0) throw new BadRequestException('At least one event is required');
    await assertOutboundUrlSafe(input.url, resolve);

    const secret = randomBytes(32).toString('hex');
    const encrypted = this.encryption.encrypt(secret);
    const row = await this.prisma.outboundWebhookEndpoint.create({
      data: {
        shopId,
        storeDomain,
        url: input.url,
        description: input.description?.trim() || null,
        events,
        active: input.active ?? true,
        secretCiphertext: encrypted.ciphertext,
        secretIv: encrypted.iv,
        secretTag: encrypted.tag,
      },
    });
    return { endpoint: toView(row), secret };
  }

  async update(
    storeDomain: string,
    id: string,
    input: { url?: string; events?: string[]; description?: string; active?: boolean },
    resolve?: AddressResolver,
  ): Promise<OutboundEndpointView> {
    const existing = await this.prisma.outboundWebhookEndpoint.findFirst({ where: { id, storeDomain } });
    if (!existing) throw new NotFoundException('Webhook endpoint not found');
    const data: Record<string, unknown> = {};
    if (input.url !== undefined) {
      await assertOutboundUrlSafe(input.url, resolve);
      data.url = input.url;
    }
    if (input.events !== undefined) {
      const events = toEvents(input.events, OUTBOUND_EVENTS);
      if (events.length === 0) throw new BadRequestException('At least one event is required');
      data.events = events;
    }
    if (input.description !== undefined) data.description = input.description.trim() || null;
    if (input.active !== undefined) data.active = input.active;
    const row = await this.prisma.outboundWebhookEndpoint.update({ where: { id }, data });
    return toView(row);
  }

  async remove(storeDomain: string, id: string): Promise<{ deleted: true }> {
    const result = await this.prisma.outboundWebhookEndpoint.deleteMany({ where: { id, storeDomain } });
    if (result.count === 0) throw new NotFoundException('Webhook endpoint not found');
    return { deleted: true };
  }

  async rotateSecret(storeDomain: string, id: string): Promise<{ secret: string }> {
    const existing = await this.prisma.outboundWebhookEndpoint.findFirst({ where: { id, storeDomain } });
    if (!existing) throw new NotFoundException('Webhook endpoint not found');
    const secret = randomBytes(32).toString('hex');
    const encrypted = this.encryption.encrypt(secret);
    await this.prisma.outboundWebhookEndpoint.update({
      where: { id },
      data: { secretCiphertext: encrypted.ciphertext, secretIv: encrypted.iv, secretTag: encrypted.tag },
    });
    return { secret };
  }

  async listDeliveries(
    storeDomain: string,
    endpointId: string,
    options: { page?: number; size?: number } = {},
  ): Promise<{ items: OutboundDeliveryView[]; total: number; page: number; pageSize: number }> {
    const endpoint = await this.prisma.outboundWebhookEndpoint.findFirst({
      where: { id: endpointId, storeDomain },
      select: { id: true },
    });
    if (!endpoint) throw new NotFoundException('Webhook endpoint not found');
    const page = Math.max(0, Math.trunc(options.page ?? 0));
    const pageSize = Math.max(1, Math.min(MAX_DELIVERY_PAGE, Math.trunc(options.size ?? DELIVERY_LIST_DEFAULT)));
    const [rows, total] = await Promise.all([
      this.prisma.outboundWebhookDelivery.findMany({
        where: { endpointId },
        orderBy: { createdAt: 'desc' },
        skip: page * pageSize,
        take: pageSize,
      }),
      this.prisma.outboundWebhookDelivery.count({ where: { endpointId } }),
    ]);
    return {
      items: rows.map((row) => ({
        id: row.id,
        endpointId: row.endpointId,
        event: row.event,
        status: row.status,
        attempts: row.attempts,
        responseStatus: row.responseStatus,
        lastError: row.lastError,
        deliveredAt: row.deliveredAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
      total,
      page,
      pageSize,
    };
  }

  // Safety: enqueue never throws into a merchant-facing write; a delivery row is the durable record, the sweeper retries it.
  async enqueue(storeDomain: string, event: OutboundEvent, data: Record<string, unknown>): Promise<number> {
    try {
      const endpoints = await this.prisma.outboundWebhookEndpoint.findMany({
        where: { storeDomain, active: true },
        select: { id: true, events: true },
      });
      const targets = endpoints.filter((endpoint) => {
        const events = Array.isArray(endpoint.events) ? endpoint.events : [];
        return events.includes(event);
      });
      if (targets.length === 0) return 0;
      const payload = JSON.parse(JSON.stringify(data)) as Prisma.InputJsonObject;
      await this.prisma.outboundWebhookDelivery.createMany({
        data: targets.map((endpoint) => ({
          endpointId: endpoint.id,
          storeDomain,
          event,
          payload,
          status: 'pending',
          nextAttemptAt: new Date(),
        })),
      });
      void this.dispatcher.dispatchDue({ maxDeliveries: targets.length }).catch((error: unknown) => {
        this.logger.warn(
          `Immediate outbound dispatch failed for ${storeDomain}: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      });
      return targets.length;
    } catch (error) {
      this.logger.warn(
        `Outbound enqueue failed for ${storeDomain}/${event}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      return 0;
    }
  }

  async sendTest(storeDomain: string, id: string): Promise<OutboundDeliveryView> {
    const endpoint = await this.prisma.outboundWebhookEndpoint.findFirst({ where: { id, storeDomain } });
    if (!endpoint) throw new NotFoundException('Webhook endpoint not found');
    const delivery = await this.prisma.outboundWebhookDelivery.create({
      data: {
        endpointId: endpoint.id,
        storeDomain,
        event: 'test',
        payload: { message: 'Ping từ F1GENZ Review', storeDomain },
        status: 'pending',
        nextAttemptAt: new Date(),
      },
    });
    await this.dispatcher.dispatchDue({ maxDeliveries: 5 });
    const fresh = await this.prisma.outboundWebhookDelivery.findUnique({ where: { id: delivery.id } });
    const row = fresh ?? delivery;
    return {
      id: row.id,
      endpointId: row.endpointId,
      event: row.event,
      status: row.status,
      attempts: row.attempts,
      responseStatus: row.responseStatus,
      lastError: row.lastError,
      deliveredAt: row.deliveredAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  get events(): readonly string[] {
    return OUTBOUND_EVENTS;
  }

  get publicApiUrl(): string {
    return this.env.API_BASE_URL.replace(/\/+$/, '');
  }
}
