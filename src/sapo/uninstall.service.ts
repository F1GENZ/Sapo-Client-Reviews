import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../redis/redis.service';
import { LifecycleLockService } from './lifecycle-lock.service';
import { ShopDomainService } from './shop-domain.service';
import { SessionService } from './session.service';

@Injectable()
export class UninstallService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly shopDomains: ShopDomainService,
    private readonly locks: LifecycleLockService,
    private readonly sessions: SessionService,
  ) {}

  async uninstall(storeDomain: string, payload: Record<string, unknown>): Promise<{
    storeDomain: string;
    uninstalled: true;
    domainsCleared: number;
  }> {
    const lock = await this.locks.acquireLifecycleLock(storeDomain);
    if (!lock) throw new ConflictException('Lifecycle operation already in progress');

    try {
      const domains = this.shopDomains.collectDomains(payload);
      const storedDomains = await this.prisma.shopDomain.findMany({
        where: { storeDomain, active: true },
        select: { domain: true },
      });
      const allDomains = Array.from(new Set([...domains, ...storedDomains.map((item) => item.domain)]));

      await this.sessions.clearStoreHandoffs(storeDomain);
      await this.redis.delMany([
        `install:${storeDomain}`,
        ...allDomains.map((domain) => this.shopDomains.domainKey(domain)),
      ]);

      await this.prisma.$transaction([
        this.prisma.appInstall.updateMany({
          where: { storeDomain },
          data: {
            status: 'uninstalled',
            accessTokenCiphertext: null,
            accessTokenIv: null,
            accessTokenTag: null,
            uninstalledAt: new Date(),
            dataPreserved: true,
            lifecycleGeneration: { increment: 1 },
            tokenVersion: { increment: 1 },
          },
        }),
        this.prisma.shopDomain.updateMany({
          where: { storeDomain, active: true },
          data: { active: false, tombstonedAt: new Date() },
        }),
        this.prisma.webhookEvent.updateMany({
          where: {
            OR: [
              { resolvedStoreDomain: storeDomain },
              ...(allDomains.length ? [{ resolvedDomain: { in: allDomains } }] : []),
            ],
          },
          data: { payload: Prisma.DbNull, headers: Prisma.DbNull },
        }),
      ]);

      return { storeDomain, uninstalled: true, domainsCleared: allDomains.length };
    } finally {
      await this.locks.release(lock);
    }
  }
}
