import { Injectable } from '@nestjs/common';
import { RedisLock, RedisService } from '../redis/redis.service';

@Injectable()
export class LifecycleLockService {
  constructor(private readonly redis: RedisService) {}

  async acquireLifecycleLock(storeDomain: string, ttlSeconds = 30): Promise<RedisLock | null> {
    return this.redis.acquireLock(`lock:lifecycle:${storeDomain}`, ttlSeconds);
  }

  async release(lock: RedisLock | null): Promise<void> {
    if (!lock) return;
    await this.redis.releaseLock(lock);
  }
}
