import type { Logger } from '@nestjs/common';

export async function runSection<T>(
  logger: Logger,
  name: string,
  degraded: string[],
  load: () => Promise<T>,
): Promise<T | null> {
  try {
    return await load();
  } catch (error) {
    degraded.push(name);
    logger.warn(`Section ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
