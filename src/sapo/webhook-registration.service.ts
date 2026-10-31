import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { APP_ENV } from '../config/app-config.module';
import type { AppEnv } from '../config/env.schema';
import { PrismaService } from '../database/prisma.service';
import { sapoErrorStatus } from './install-revocation';
import { SapoApiService } from './sapo-api.service';
import { WEBHOOK_SUBSCRIBE_TOPICS } from './webhook-topic-normalizer';

export type WebhookRegistrationResult = {
  status: 'not_configured' | 'registered' | 'degraded' | 'failed';
  error?: string;
};

const WEBHOOK_PATH = '/api/oauth/install/webhooks';
const SUBSCRIBED_TOPICS: ReadonlySet<string> = new Set(WEBHOOK_SUBSCRIBE_TOPICS);

const trimAddress = (address: string): string => address.trim().replace(/\/+$/, '').toLowerCase();

const describeError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : 'Webhook registration failed';
  const status = sapoErrorStatus(error);
  return status ? `${message} (${status})` : message;
};

@Injectable()
export class WebhookRegistrationService {
  constructor(
    private readonly sapoApi: SapoApiService,
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly prisma?: PrismaService,
  ) {}

  private webhookReceiverUrl(): string {
    return `${this.env.API_BASE_URL.replace(/\/+$/, '')}${WEBHOOK_PATH}`;
  }

  private isOwnEndpoint(address: string): boolean {
    try {
      return new URL(address).pathname.replace(/\/+$/, '') === WEBHOOK_PATH;
    } catch {
      return false;
    }
  }

  async registerForInstall(storeDomain: string, accessToken: string): Promise<WebhookRegistrationResult> {
    const address = this.webhookReceiverUrl();
    const errors: string[] = [];
    const subscribed = new Set<string>();

    try {
      const existing = await this.sapoApi.getWebhooks(storeDomain, accessToken);
      for (const hook of existing) {
        if (!SUBSCRIBED_TOPICS.has(hook.topic) || !this.isOwnEndpoint(hook.address)) continue;
        if (trimAddress(hook.address) === trimAddress(address)) {
          subscribed.add(hook.topic);
          continue;
        }
        try {
          await this.sapoApi.deleteWebhook(storeDomain, accessToken, String(hook.id));
        } catch (error) {
          errors.push(`reconcile ${hook.topic}: ${describeError(error)}`);
        }
      }
    } catch (error) {
      errors.push(`list: ${describeError(error)}`);
    }

    let failedTopics = 0;
    for (const topic of WEBHOOK_SUBSCRIBE_TOPICS) {
      if (subscribed.has(topic)) continue;
      try {
        await this.sapoApi.createWebhook(storeDomain, accessToken, topic, address);
      } catch (error) {
        failedTopics += 1;
        errors.push(`${topic}: ${describeError(error)}`);
      }
    }

    if (failedTopics === WEBHOOK_SUBSCRIBE_TOPICS.length) {
      await this.persist(storeDomain, { webhookRegistrationStatus: 'failed', webhookRegistrationError: errors.join('; ') });
      return { status: 'failed', error: errors.join('; ') };
    }

    if (errors.length > 0) {
      await this.persist(storeDomain, { webhookRegistrationStatus: 'degraded', webhookRegistrationError: errors.join('; ') });
      return { status: 'degraded', error: errors.join('; ') };
    }

    await this.persist(storeDomain, {
      webhookRegistrationStatus: 'registered',
      webhookRegisteredAt: new Date(),
      webhookRegistrationError: null,
    });
    return { status: 'registered' };
  }

  private async persist(storeDomain: string, data: Prisma.AppInstallUpdateManyMutationInput): Promise<void> {
    await this.prisma?.appInstall.updateMany({ where: { storeDomain }, data });
  }
}