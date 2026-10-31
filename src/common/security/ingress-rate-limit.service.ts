import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';

export type RateLimitResult = {
  allowed: boolean;
  count: number;
  remaining: number;
  resetInSeconds: number;
};

type MemoryBucket = { count: number; expiresAt: number };

export const MEMORY_BUCKET_MAX_ENTRIES = 50_000;
const MEMORY_EVICT_TARGET = Math.floor(MEMORY_BUCKET_MAX_ENTRIES * 0.9);
const MEMORY_SWEEP_INTERVAL_MS = 60_000;
const REDIS_FALLBACK_LOG_INTERVAL_MS = 30_000;

@Injectable()
export class IngressRateLimitService {
  private readonly logger = new Logger(IngressRateLimitService.name);
  private readonly memoryBuckets = new Map<string, MemoryBucket>();
  private nextSweepAt = 0;
  private lastFallbackLogAt = 0;

  constructor(private readonly redis?: RedisService) {}

  async check(
    bucket: string,
    fingerprint: string,
    windowSeconds: number,
    max: number,
  ): Promise<RateLimitResult> {
    const safeWindow = Math.max(1, Math.floor(windowSeconds));
    const safeMax = Math.max(1, Math.floor(max));
    const key = `rate:${bucket}:${fingerprint}`;

    if (this.redis?.isConfigured) {
      try {
        const count = await this.redis.incr(key, safeWindow);
        const ttl = await this.redis.ttl(key);
        return {
          allowed: count <= safeMax,
          count,
          remaining: Math.max(0, safeMax - count),
          resetInSeconds: ttl > 0 ? ttl : safeWindow,
        };
      } catch (error) {
        this.logRedisFallback(error);
      }
    }

    return this.checkMemory(key, safeWindow, safeMax);
  }

  async assertAllowed(
    bucket: string,
    fingerprint: string,
    windowSeconds: number,
    max: number,
  ): Promise<void> {
    const result = await this.check(bucket, fingerprint, windowSeconds, max);
    if (!result.allowed) {
      throw new HttpException(
        `Rate limit exceeded; retry in ${result.resetInSeconds}s`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private checkMemory(key: string, windowSeconds: number, max: number): RateLimitResult {
    const now = Date.now();
    this.evictMemoryBuckets(now);

    const current = this.memoryBuckets.get(key);
    if (!current || current.expiresAt <= now) {
      this.memoryBuckets.delete(key);
      this.memoryBuckets.set(key, { count: 1, expiresAt: now + windowSeconds * 1000 });
      return { allowed: true, count: 1, remaining: max - 1, resetInSeconds: windowSeconds };
    }

    current.count += 1;
    return {
      allowed: current.count <= max,
      count: current.count,
      remaining: Math.max(0, max - current.count),
      resetInSeconds: Math.ceil((current.expiresAt - now) / 1000),
    };
  }

  private evictMemoryBuckets(now: number): void {
    const full = this.memoryBuckets.size >= MEMORY_BUCKET_MAX_ENTRIES;
    if (!full && now < this.nextSweepAt) return;
    this.nextSweepAt = now + MEMORY_SWEEP_INTERVAL_MS;

    for (const [key, entry] of this.memoryBuckets) {
      if (entry.expiresAt <= now) this.memoryBuckets.delete(key);
    }
    if (this.memoryBuckets.size < MEMORY_BUCKET_MAX_ENTRIES) return;
    for (const key of this.memoryBuckets.keys()) {
      if (this.memoryBuckets.size <= MEMORY_EVICT_TARGET) break;
      this.memoryBuckets.delete(key);
    }
  }

  private logRedisFallback(error: unknown): void {
    const now = Date.now();
    if (now - this.lastFallbackLogAt < REDIS_FALLBACK_LOG_INTERVAL_MS) return;
    this.lastFallbackLogAt = now;
    this.logger.warn(
      `Redis rate limiter unavailable, using in-memory buckets: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
