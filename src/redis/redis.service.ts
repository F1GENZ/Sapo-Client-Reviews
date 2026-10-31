import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';

export type RedisConnectionOptions = {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  tls?: boolean;
  keyPrefix?: string;
};

export type RedisLock = {
  key: string;
  owner: string;
};

type MemoryEntry = {
  value: string;
  expiresAt?: number;
};

const MEMORY_MAX_ENTRIES = 50_000;

const INCR_WITH_TTL_SCRIPT = [
  "local value = redis.call('INCR', KEYS[1])",
  "local ttl = tonumber(ARGV[1])",
  "if ttl > 0 and redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ttl) end",
  'return value',
].join('\n');

const parseRedisValue = <T>(value: string | null): T | null => {
  if (value === null) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return value as T;
  }
};

const serializeRedisValue = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value);

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly client?: Redis;
  private readonly memory = new Map<string, MemoryEntry>();
  readonly keyPrefix: string;

  constructor(options: RedisConnectionOptions = {}) {
    this.keyPrefix = options.keyPrefix || 'f1genz-sapo';
    if (options.host) {
      this.client = new Redis({
        host: options.host,
        port: options.port || 6379,
        username: options.username || undefined,
        password: options.password || undefined,
        tls: options.tls ? {} : undefined,
        maxRetriesPerRequest: 2,
      });
    }
  }

  get isConfigured(): boolean {
    return Boolean(this.client);
  }

  namespaced(key: string): string {
    const normalized = key.replace(/^:+/, '');
    return `${this.keyPrefix}:${normalized}`;
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit();
  }

  private getMemoryEntry(key: string): MemoryEntry | null {
    const entry = this.memory.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.memory.delete(key);
      return null;
    }
    return entry;
  }

  private setMemoryEntry(key: string, entry: MemoryEntry): void {
    if (this.memory.size >= MEMORY_MAX_ENTRIES && !this.memory.has(key)) this.evictMemory();
    this.memory.set(key, entry);
  }

  private evictMemory(): void {
    const now = Date.now();
    for (const [key, entry] of this.memory) {
      if (entry.expiresAt && entry.expiresAt <= now) this.memory.delete(key);
    }
    for (const key of this.memory.keys()) {
      if (this.memory.size < MEMORY_MAX_ENTRIES) break;
      this.memory.delete(key);
    }
  }

  async get<T>(key: string): Promise<T | null> {
    const namespacedKey = this.namespaced(key);
    if (!this.client) return parseRedisValue<T>(this.getMemoryEntry(namespacedKey)?.value ?? null);
    return parseRedisValue<T>(await this.client.get(namespacedKey));
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const namespacedKey = this.namespaced(key);
    const payload = serializeRedisValue(value);
    if (!this.client) {
      this.setMemoryEntry(namespacedKey, {
        value: payload,
        expiresAt: ttlSeconds && ttlSeconds > 0 ? Date.now() + Math.floor(ttlSeconds) * 1000 : undefined,
      });
      return;
    }
    if (ttlSeconds && ttlSeconds > 0) {
      await this.client.set(namespacedKey, payload, 'EX', Math.floor(ttlSeconds));
      return;
    }
    await this.client.set(namespacedKey, payload);
  }

  async del(key: string): Promise<number> {
    const namespacedKey = this.namespaced(key);
    if (!this.client) return this.memory.delete(namespacedKey) ? 1 : 0;
    return this.client.del(namespacedKey);
  }

  async delMany(keys: string[]): Promise<number> {
    if (!keys.length) return 0;
    if (!this.client) {
      return keys.reduce((count, key) => count + (this.memory.delete(this.namespaced(key)) ? 1 : 0), 0);
    }
    return this.client.del(...keys.map((key) => this.namespaced(key)));
  }

  async getDel<T>(key: string): Promise<T | null> {
    const namespacedKey = this.namespaced(key);
    if (!this.client) {
      const value = this.getMemoryEntry(namespacedKey)?.value ?? null;
      this.memory.delete(namespacedKey);
      return parseRedisValue<T>(value);
    }
    const value = typeof this.client.getdel === 'function'
      ? await this.client.getdel(namespacedKey)
      : await this.client.eval(
          "local value = redis.call('get', KEYS[1]); if value then redis.call('del', KEYS[1]); end; return value",
          1,
          namespacedKey,
        ) as string | null;
    return parseRedisValue<T>(value);
  }

  async setNx(key: string, value: unknown, ttlSeconds: number): Promise<boolean> {
    const namespacedKey = this.namespaced(key);
    const payload = serializeRedisValue(value);
    if (!this.client) {
      if (this.getMemoryEntry(namespacedKey)) return false;
      this.setMemoryEntry(namespacedKey, {
        value: payload,
        expiresAt: Date.now() + Math.max(1, Math.floor(ttlSeconds)) * 1000,
      });
      return true;
    }
    const result = await this.client.set(
      namespacedKey,
      payload,
      'EX',
      Math.max(1, Math.floor(ttlSeconds)),
      'NX',
    );
    return result === 'OK';
  }

  async acquireLock(key: string, ttlSeconds: number): Promise<RedisLock | null> {
    const owner = randomUUID();
    const acquired = await this.setNx(key, owner, ttlSeconds);
    return acquired ? { key, owner } : null;
  }

  async releaseLock(lock: RedisLock): Promise<boolean> {
    const namespacedKey = this.namespaced(lock.key);
    if (!this.client) {
      const entry = this.getMemoryEntry(namespacedKey);
      if (entry?.value !== lock.owner) return false;
      this.memory.delete(namespacedKey);
      return true;
    }
    const result = await this.client.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      namespacedKey,
      lock.owner,
    );
    return result === 1;
  }

  async incr(key: string, ttlSeconds?: number): Promise<number> {
    const namespacedKey = this.namespaced(key);
    if (!this.client) {
      const entry = this.getMemoryEntry(namespacedKey);
      const next = entry ? Number(entry.value || 0) + 1 : 1;
      this.setMemoryEntry(namespacedKey, {
        value: String(next),
        expiresAt: entry?.expiresAt ?? (ttlSeconds && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : undefined),
      });
      return next;
    }
    const ttl = ttlSeconds && ttlSeconds > 0 ? Math.floor(ttlSeconds) : 0;
    return Number(await this.client.eval(INCR_WITH_TTL_SCRIPT, 1, namespacedKey, ttl));
  }

  async ttl(key: string): Promise<number> {
    const namespacedKey = this.namespaced(key);
    if (!this.client) {
      const entry = this.getMemoryEntry(namespacedKey);
      if (!entry) return -2;
      if (!entry.expiresAt) return -1;
      return Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000));
    }
    return this.client.ttl(namespacedKey);
  }

  async scanKeys(pattern: string): Promise<string[]> {
    const fullPattern = this.namespaced(pattern);
    const prefix = `${this.keyPrefix}:`;
    if (!this.client) {
      const escaped = fullPattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      const regex = new RegExp(`^${escaped}$`);
      return Array.from(this.memory.keys())
        .filter((key) => this.getMemoryEntry(key) && regex.test(key))
        .map((key) => key.replace(prefix, ''));
    }

    const keys: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, batch] = await this.client.scan(cursor, 'MATCH', fullPattern, 'COUNT', 100);
      cursor = nextCursor;
      keys.push(...batch.map((key) => key.replace(prefix, '')));
    } while (cursor !== '0');
    return keys;
  }

  async ping(): Promise<boolean> {
    if (!this.client) return true;
    return (await this.client.ping()) === 'PONG';
  }
}
