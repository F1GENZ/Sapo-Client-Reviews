import type { PrismaService } from '../database/prisma.service';

export const FAILURE_WINDOW_MINUTES = 60;

export type HealthStatus = 'ok' | 'degraded' | 'down';

export type HealthVerdict = { ok: boolean; degraded: boolean; status: HealthStatus };

// `down` outranks `degraded`, which outranks `ok`; an unanswerable probe counts as degraded, never as healthy.
export const deriveHealthVerdict = (input: {
  healthy: boolean;
  recentFailures: number;
  probeFailed?: boolean;
}): HealthVerdict => {
  const degraded = input.healthy && (input.recentFailures > 0 || input.probeFailed === true);
  return {
    ok: input.healthy && !degraded,
    degraded,
    status: !input.healthy ? 'down' : degraded ? 'degraded' : 'ok',
  };
};

export const failureWindowStart = (now: Date = new Date()): Date =>
  new Date(now.getTime() - FAILURE_WINDOW_MINUTES * 60_000);

export const countRecentFailures = async (
  prisma: Pick<PrismaService, 'webhookEvent' | 'metafieldSyncPending'>,
  options: { storeDomain?: string; now?: Date } = {},
): Promise<number> => {
  const since = failureWindowStart(options.now);
  const { storeDomain } = options;
  const [webhooks, metafields] = await Promise.all([
    prisma.webhookEvent.count({
      where: {
        status: 'failed',
        updatedAt: { gte: since },
        ...(storeDomain ? { resolvedStoreDomain: storeDomain } : {}),
      },
    }),
    prisma.metafieldSyncPending.count({
      where: {
        lastError: { not: null },
        updatedAt: { gte: since },
        ...(storeDomain ? { storeDomain } : {}),
      },
    }),
  ]);
  return webhooks + metafields;
};
