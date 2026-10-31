import { BadRequestException, ConflictException, Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import type { AppInstall } from '@prisma/client';
import { APP_ENV } from '../config/app-config.module';
import type { AppEnv } from '../config/env.schema';
import { PrismaService } from '../database/prisma.service';
import { LifecycleLockService } from './lifecycle-lock.service';
import { SapoApiService } from './sapo-api.service';
import { OAuthStateService } from './oauth-state.service';
import { SessionService } from './session.service';
import { ShopDomainService, normalizeShopDomain } from './shop-domain.service';
import { TokenEncryptionService } from './token-encryption.service';
import { StorefrontService } from '../storefront/storefront.service';
import { WebhookRegistrationService } from './webhook-registration.service';

const BLOCKED_STATUSES = new Set(['canceled', 'expired', 'needs_reinstall', 'declined', 'uninstalled']);

const SAPO_SHOP_DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.mysapo\.net$/i;

const timestampOf = (value: unknown): number => {
  if (!value) return 0;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export type AuthStartResponse = { url: string; reason?: string };
export type HandoffResponse = { handoffCode: string; storeDomain: string; redirectTo: string };

@Injectable()
export class SapoService {
  private readonly logger = new Logger(SapoService.name);

  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly prisma: PrismaService,
    private readonly oauthState: OAuthStateService,
    private readonly sapoApi: SapoApiService,
    private readonly sessionService: SessionService,
    private readonly tokenEncryption: TokenEncryptionService,
    private readonly shopDomains: ShopDomainService,
    private readonly lifecycleLocks: LifecycleLockService,
    private readonly webhookRegistration: WebhookRegistrationService,
    private readonly storefrontService: StorefrontService,
  ) {}

  private buildAuthorizeUrl(input: { flow: 'login' | 'install'; state: string; storeDomain?: string }): string {
    const params = new URLSearchParams({
      client_id: this.env.SAPO_CLIENT_ID,
      scope: this.env.SAPO_SCOPE,
      redirect_uri: input.flow === 'install'
        ? this.env.SAPO_INSTALL_CALLBACK_URL
        : this.env.SAPO_LOGIN_CALLBACK_URL,
      state: input.state,
    });
    const baseDomain = input.storeDomain;
    if (!baseDomain) throw new BadRequestException('storeDomain is required to build authorize URL');
    const shopHost = normalizeShopDomain(baseDomain);
    if (!SAPO_SHOP_DOMAIN_RE.test(shopHost)) {
      throw new BadRequestException('storeDomain must be a valid Sapo shop domain (*.mysapo.net)');
    }
    return `https://${shopHost}/admin/oauth/authorize?${params.toString()}`;
  }

  async buildLoginUrl(input: { storeDomain?: string; redirectTo?: string } = {}): Promise<string> {
    if (!input.storeDomain) throw new BadRequestException('storeDomain is required');
    const { state } = await this.oauthState.create('login', input);
    return this.buildAuthorizeUrl({ flow: 'login', state, storeDomain: input.storeDomain });
  }

  async buildInstallUrl(input: { storeDomain?: string; redirectTo?: string } = {}): Promise<string> {
    if (!input.storeDomain) throw new BadRequestException('storeDomain is required');
    const { state } = await this.oauthState.create('install', input);
    return this.buildAuthorizeUrl({ flow: 'install', state, storeDomain: input.storeDomain });
  }

  async startLogin(input: { storeDomain?: string; redirectTo?: string } = {}): Promise<AuthStartResponse> {
    return { url: await this.buildLoginUrl(input), reason: 'sso_required' };
  }

  async processLoginCallback(code: string, state: string | undefined): Promise<AuthStartResponse | HandoffResponse> {
    if (!code) throw new BadRequestException('Missing code');
    const oauthState = await this.oauthState.consume(state, 'login');
    const storeDomain = oauthState.storeDomain;
    if (!storeDomain) throw new BadRequestException('Missing storeDomain in OAuth state');

    const tokenPayload = await this.sapoApi.exchangeCode(code, storeDomain);
    if (!tokenPayload.access_token) throw new BadRequestException('Invalid OAuth token payload');

    const shop = await this.sapoApi.getShop(storeDomain, tokenPayload.access_token)
      .catch((err: unknown) => {
        this.logger.error(`[login] getShop failed for ${storeDomain}: ${errorMessage(err)}`);
        return null;
      });
    if (!shop) throw new BadRequestException('Failed to verify store identity');

    const install = await this.prisma.appInstall.findUnique({ where: { storeDomain } });
    if (!install || BLOCKED_STATUSES.has(String(install.status))) {
      return { url: await this.buildInstallUrl({ storeDomain, redirectTo: oauthState.redirectTo }), reason: 'install_required' };
    }
    return this.sessionService.createHandoff(storeDomain, oauthState.redirectTo);
  }

  async processInstallCallback(code: string, state: string | undefined): Promise<HandoffResponse> {
    if (!code) throw new BadRequestException('Missing code');
    const oauthState = await this.oauthState.consume(state, 'install');
    const storeDomain = oauthState.storeDomain;
    if (!storeDomain) throw new BadRequestException('Missing storeDomain in OAuth state');

    const tokenPayload = await this.sapoApi.exchangeCode(code, storeDomain);
    if (!tokenPayload.access_token) throw new BadRequestException('Invalid OAuth token payload');

    const shop = await this.sapoApi.getShop(storeDomain, tokenPayload.access_token).catch((err: unknown) => {
      this.logger.error(`[install] getShop failed for ${storeDomain}: ${errorMessage(err)}`);
      return null;
    });
    if (!shop) throw new BadRequestException('Failed to verify store identity');
    const domains = this.shopDomains.collectDomains({ ...shop });
    this.logger.log(`[install] getShop ok domains=${JSON.stringify(domains)}`);

    const lock = await this.lifecycleLocks.acquireLifecycleLock(storeDomain);
    if (!lock) throw new ConflictException('Lifecycle operation already in progress');
    this.logger.log(`[install] lifecycle lock acquired for ${storeDomain}`);

    try {
      const existingInstall = await this.prisma.appInstall.findUnique({ where: { storeDomain } });
      this.logger.log(`[install] existing install=${existingInstall?.status ?? 'none'}`);
      const uninstalledAt = timestampOf(existingInstall?.uninstalledAt);
      if (uninstalledAt && oauthState.createdAt < uninstalledAt) {
        throw new BadRequestException('Stale install callback after uninstall');
      }

      const encryptedToken = this.tokenEncryption.encrypt(tokenPayload.access_token);

      const shopRow = await this.prisma.shop.upsert({
        where: { storeDomain },
        create: { storeDomain },
        update: {},
      });
      this.logger.log(`[install] shop upserted id=${shopRow.id}`);

      await this.prisma.appInstall.upsert({
        where: { storeDomain },
        create: {
          shopId: shopRow.id,
          storeDomain,
          status: 'active',
          featuresUnlocked: true,
          accessTokenCiphertext: encryptedToken.ciphertext,
          accessTokenIv: encryptedToken.iv,
          accessTokenTag: encryptedToken.tag,
          installedAt: new Date(),
          lifecycleGeneration: 1,
        },
        update: {
          status: 'active',
          featuresUnlocked: true,
          accessTokenCiphertext: encryptedToken.ciphertext,
          accessTokenIv: encryptedToken.iv,
          accessTokenTag: encryptedToken.tag,
          ...(existingInstall?.installedAt ? {} : { installedAt: new Date() }),
          uninstalledAt: null,
          lifecycleGeneration: { increment: 1 },
          tokenVersion: { increment: 1 },
        },
      });
      this.logger.log(`[install] appInstall upserted for ${storeDomain}`);

      for (const domain of domains) {
        await this.prisma.$transaction([
          this.prisma.shopDomain.updateMany({
            where: { domain, active: true, storeDomain: { not: storeDomain } },
            data: { active: false, tombstonedAt: new Date() },
          }),
          this.prisma.shopDomain.upsert({
            where: { id: `${storeDomain}:${domain}` },
            create: { id: `${storeDomain}:${domain}`, shopId: shopRow.id, storeDomain, domain, kind: 'custom', active: true },
            update: { active: true, tombstonedAt: null, shopId: shopRow.id, storeDomain },
          }),
        ]);
        await this.shopDomains.saveMapping(storeDomain, domain);
      }

      const accessToken = tokenPayload.access_token;
      this.webhookRegistration.registerForInstall(storeDomain, accessToken)
        .catch((err: unknown) => {
          this.logger.error(`[install] webhook registration failed for ${storeDomain}: ${errorMessage(err)}`);
        });
      this.storefrontService.writeStorefrontConfig(storeDomain, accessToken)
        .catch((err: unknown) => {
          this.logger.error(`[install] storefront config write failed for ${storeDomain}: ${errorMessage(err)}`);
        });

      this.logger.log(`[install] creating handoff for ${storeDomain}`);
      return this.sessionService.createHandoff(storeDomain, oauthState.redirectTo);
    } finally {
      await this.lifecycleLocks.release(lock);
    }
  }

  private decryptAccessToken(
    install: Pick<AppInstall, 'accessTokenCiphertext' | 'accessTokenIv' | 'accessTokenTag'>,
  ): string | null {
    return this.tokenEncryption.optionalDecrypt({
      ciphertext: install.accessTokenCiphertext ?? undefined,
      iv: install.accessTokenIv ?? undefined,
      tag: install.accessTokenTag ?? undefined,
    });
  }

  async resolveAccessToken(storeDomain: string): Promise<string> {
    const install = await this.prisma.appInstall.findUnique({ where: { storeDomain } });
    if (!install || BLOCKED_STATUSES.has(String(install.status))) {
      throw new UnauthorizedException('App needs reinstall');
    }

    const accessToken = this.decryptAccessToken(install);
    if (!accessToken) throw new UnauthorizedException('Missing Sapo access token');
    return accessToken;
  }

  async getLifecycleGeneration(storeDomain: string): Promise<number> {
    const install = await this.prisma.appInstall.findUnique({
      where: { storeDomain },
      select: { lifecycleGeneration: true },
    });
    if (!install) throw new UnauthorizedException('App needs reinstall');
    return install.lifecycleGeneration;
  }

  async getSessionProbe(storeDomain: string): Promise<Record<string, unknown>> {
    const [install, domain] = await Promise.all([
      this.prisma.appInstall.findUnique({ where: { storeDomain } }),
      this.prisma.shopDomain.findFirst({
        where: { storeDomain, active: true },
        orderBy: [{ kind: 'asc' }, { updatedAt: 'desc' }],
        select: { domain: true },
      }).catch((err: unknown) => {
        this.logger.warn(`[session] shop domain lookup failed for ${storeDomain}: ${errorMessage(err)}`);
        return null;
      }),
    ]);
    return {
      storeDomain,
      shopDomain: domain?.domain,
      status: install?.status || 'unknown',
      featuresUnlocked: install?.featuresUnlocked ?? true,
      webhookStatus: install?.webhookRegistrationStatus || 'not_configured',
    };
  }
}
