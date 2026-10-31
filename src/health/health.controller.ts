import { Controller, Get, Headers, Inject, Logger, UnauthorizedException } from '@nestjs/common';
import { APP_ENV } from '../config/app-config.module';
import type { AppEnv } from '../config/env.schema';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../redis/redis.service';
import { countRecentFailures, deriveHealthVerdict, FAILURE_WINDOW_MINUTES } from './health-verdict';

@Controller()
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get('/livez')
  livez(): { ok: true } {
    return { ok: true };
  }

  @Get('/readyz')
  async readyz(@Headers('authorization') authorization?: string): Promise<Record<string, unknown>> {
    const token = authorization?.replace(/^Bearer\s+/i, '') || '';
    if (!this.env.READINESS_TOKEN || token !== this.env.READINESS_TOKEN) {
      throw new UnauthorizedException('Invalid readiness token');
    }

    const failedProbes: string[] = [];
    const [redisOk, dbOk] = await Promise.all([
      this.redis.ping().catch((error: unknown) => {
        this.logger.warn(`Redis ping failed: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }),
      this.prisma.ping().catch((error: unknown) => {
        this.logger.warn(`Database ping failed: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }),
    ]);
    const webhookRegistration: Record<string, number> = {};
    try {
      const groups = await this.prisma.appInstall.groupBy({
        by: ['webhookRegistrationStatus'],
        _count: { _all: true },
      });
      for (const group of groups) webhookRegistration[group.webhookRegistrationStatus] = group._count._all;
    } catch (error) {
      failedProbes.push('webhookRegistration');
      this.logger.warn(`Webhook registration probe failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const webhookDegraded = Boolean(webhookRegistration.degraded || webhookRegistration.failed);
    let recentFailures = 0;
    if (dbOk) {
      try {
        recentFailures = await countRecentFailures(this.prisma);
      } catch (error) {
        failedProbes.push('recentFailures');
        this.logger.warn(`Recent failure probe failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const verdict = deriveHealthVerdict({
      healthy: redisOk && dbOk,
      recentFailures,
      probeFailed: failedProbes.length > 0,
    });
    return {
      ...verdict,
      redis: redisOk ? 'ok' : 'failed',
      db: dbOk ? 'ok' : 'failed',
      recentFailures,
      failureWindowMinutes: FAILURE_WINDOW_MINUTES,
      webhookRegistration,
      webhookDegraded,
      failedProbes,
      build: this.env.BUILD_SHA,
    };
  }
}
