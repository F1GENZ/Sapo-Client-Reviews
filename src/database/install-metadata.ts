import type { PrismaService } from './prisma.service';

/**
 * Merges `patch` into `AppInstall.metadata[key]` inside one UPDATE statement.
 * A read-modify-write of the whole metadata document would lose a concurrent
 * write to a sibling key (widget config vs spam config) or to the same key.
 * Returns the merged value, or null when the store has no install row.
 */
export const mergeInstallMetadataKey = async (
  prisma: Pick<PrismaService, '$queryRaw'>,
  storeDomain: string,
  key: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown> | null> => {
  const rows = await prisma.$queryRaw<Array<{ value: Record<string, unknown> }>>`
    UPDATE "AppInstall"
    SET "metadata" = jsonb_set(
          COALESCE("metadata", '{}'::jsonb),
          ARRAY[${key}::text],
          COALESCE("metadata" -> ${key}::text, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb,
          true
        ),
        "updatedAt" = (NOW() AT TIME ZONE 'UTC')
    WHERE "storeDomain" = ${storeDomain}
    RETURNING "metadata" -> ${key}::text AS value
  `;
  return rows[0]?.value ?? null;
};
