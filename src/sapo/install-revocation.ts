import type { PrismaService } from '../database/prisma.service';

const REVOKED_STATUSES = new Set([401, 403]);
const UPSTREAM_STATUS_IN_MESSAGE = /(?:failed|HTTP)[:\s]+(\d{3})\b/;

const asStatus = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
const readField = (value: unknown, key: string): unknown =>
  value !== null && typeof value === 'object' && key in value ? (value as Record<string, unknown>)[key] : undefined;

export const sapoErrorStatus = (error: unknown): number | null => {
  if (!error || typeof error !== 'object') return null;
  const message = typeof readField(error, 'message') === 'string' ? String(readField(error, 'message')) : '';
  const getResponse = readField(error, 'getResponse');
  if (typeof getResponse === 'function') {
    const body: unknown = getResponse.call(error);
    const upstream = asStatus(readField(body, 'status'));
    if (upstream) return upstream;
    const match = UPSTREAM_STATUS_IN_MESSAGE.exec(typeof body === 'string' ? body : message);
    return match ? Number(match[1]) : null;
  }
  const direct = asStatus(readField(error, 'status'));
  if (direct) return direct;
  const match = UPSTREAM_STATUS_IN_MESSAGE.exec(message);
  return match ? Number(match[1]) : null;
};

export const isSapoAuthRevoked = (error: unknown): boolean => {
  const status = sapoErrorStatus(error);
  return status !== null && REVOKED_STATUSES.has(status);
};

const LIVE_STATUSES = ['trial', 'active', 'free'] as const;

// Safety: tokenVersion fences the write so a reinstall that raced the failing request is never downgraded.
export const markInstallNeedsReinstall = async (
  prisma: Pick<PrismaService, 'appInstall'>,
  storeDomain: string,
  tokenVersion?: number,
): Promise<boolean> => {
  const result = await prisma.appInstall.updateMany({
    where: {
      storeDomain,
      status: { in: [...LIVE_STATUSES] },
      ...(tokenVersion === undefined ? {} : { tokenVersion }),
    },
    data: { status: 'needs_reinstall' },
  });
  return result.count > 0;
};
