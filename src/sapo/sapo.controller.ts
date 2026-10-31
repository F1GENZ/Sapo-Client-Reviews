import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { APP_ENV } from '../config/app-config.module';
import type { AppEnv } from '../config/env.schema';
import { IngressRateLimitService } from '../common/security/ingress-rate-limit.service';
import { isTrustedUnsafeOrigin } from '../common/security/origin-policy';
import { clientFingerprint } from '../common/security/client-fingerprint';
import { ShopAuthGuard } from '../common/guards/shop-auth.guard';
import { SapoService, type AuthStartResponse, type HandoffResponse } from './sapo.service';
import { HmacVerifierService } from './hmac-verifier.service';
import { SessionService } from './session.service';
import { WebhookService } from './webhook.service';

type RawRequest = Request & { rawBody?: Buffer };
type AuthFlowResponse = AuthStartResponse | HandoffResponse;

const firstQuery = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
};

const wantsBrowserRedirect = (req: Request): boolean => {
  const accept = String(req.headers.accept || '').toLowerCase();
  return accept.includes('text/html') && !accept.includes('application/json');
};

@Controller('/api')
export class SapoController {
  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly sapo: SapoService,
    private readonly hmacVerifier: HmacVerifierService,
    private readonly sessions: SessionService,
    private readonly webhooks: WebhookService,
    private readonly rateLimit: IngressRateLimitService,
  ) {}

  private async assertAuthRate(req: Request, bucket: string): Promise<void> {
    await this.rateLimit.assertAllowed(
      bucket,
      clientFingerprint(req),
      this.env.AUTH_RATE_LIMIT_WINDOW_SECONDS,
      this.env.AUTH_RATE_LIMIT_MAX,
    );
  }

  private async finishAuthFlow(req: Request, res: Response, response: AuthFlowResponse): Promise<AuthFlowResponse | undefined> {
    if (!wantsBrowserRedirect(req)) return response;
    if ('url' in response) {
      res.redirect(302, response.url);
      return undefined;
    }
    const lifecycleGeneration = await this.sapo.getLifecycleGeneration(response.storeDomain);
    this.sessions.setSessionCookie(res, this.sessions.createSessionToken(response.storeDomain, lifecycleGeneration));
    const target = new URL(response.redirectTo || '/dashboard', this.env.FRONTEND_URL);
    target.searchParams.set('storeDomain', response.storeDomain);
    target.searchParams.set('handoff_code', response.handoffCode);
    res.redirect(302, target.toString());
    return undefined;
  }

  @Get('/oauth/install/login')
  async startLogin(
    @Req() req: Request,
    @Query('storeDomain') storeDomain?: string,
    @Query('redirect') redirectTo?: string,
  ) {
    await this.assertAuthRate(req, 'oauth-login');
    const result = await this.sapo.startLogin({ storeDomain: firstQuery(storeDomain), redirectTo: firstQuery(redirectTo) });
    return wantsBrowserRedirect(req) ? result : result.url;
  }

  @Get('/oauth/install/login/entry')
  async loginEntry(
    @Req() req: Request,
    @Query('storeDomain') storeDomain?: string,
    @Query('redirect') redirectTo?: string,
  ) {
    await this.assertAuthRate(req, 'oauth-login');
    const result = await this.sapo.startLogin({ storeDomain: firstQuery(storeDomain), redirectTo: firstQuery(redirectTo) });
    return { url: result.url, reason: result.reason };
  }

  @Get('/oauth/install/login/verify-hmac')
  async verifyHmac(@Req() req: Request) {
    await this.assertAuthRate(req, 'hmac-verify');
    const queryIndex = req.originalUrl.indexOf('?');
    const rawQuery = queryIndex >= 0 ? req.originalUrl.slice(queryIndex + 1) : '';
    const launchParams = new URLSearchParams(rawQuery);
    if (!launchParams.has('hmac')) {
      return this.sapo.startLogin({ storeDomain: firstQuery(req.query.storeDomain), redirectTo: firstQuery(req.query.redirect) });
    }

    const params = this.hmacVerifier.verifyLaunchQuery(rawQuery);
    const storeDomain = params.get('store') || undefined;
    if (!storeDomain) throw new BadRequestException('Missing store in launch parameters');
    return this.sessions.createHandoff(storeDomain, '/dashboard');
  }

  @Get('/oauth/install/login/callback')
  async loginCallbackGet(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query('code') code?: string,
    @Query('state') state?: string,
  ) {
    await this.assertAuthRate(req, 'oauth-callback');
    const response = await this.sapo.processLoginCallback(firstQuery(code) || '', firstQuery(state));
    return this.finishAuthFlow(req, res, response);
  }

  @Post('/oauth/install/login/callback')
  async loginCallbackPost(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body('code') code?: string,
    @Body('state') state?: string,
  ) {
    await this.assertAuthRate(req, 'oauth-callback');
    const response = await this.sapo.processLoginCallback(firstQuery(code) || '', firstQuery(state));
    return this.finishAuthFlow(req, res, response);
  }

  @Get('/oauth/install/start')
  async installStart(@Req() req: Request, @Query('storeDomain') storeDomain?: string) {
    await this.assertAuthRate(req, 'oauth-install-start');
    const target = firstQuery(storeDomain);
    if (!target) throw new BadRequestException('storeDomain is required');
    return this.sapo.buildInstallUrl({ storeDomain: target });
  }

  @Get('/oauth/install/callback')
  async installCallbackGet(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('store') store?: string,
  ) {
    await this.assertAuthRate(req, 'oauth-install');
    const authCode = firstQuery(code);
    if (!authCode) {
      const storeDomain = firstQuery(store);
      if (storeDomain) {
        const login = await this.sapo.buildLoginUrl({ storeDomain });
        return res.redirect(302, login);
      }
      return res.redirect(302, this.env.FRONTEND_URL || '/');
    }
    const response = await this.sapo.processInstallCallback(authCode, firstQuery(state));
    return this.finishAuthFlow(req, res, response);
  }

  @Post('/oauth/install/callback')
  async installCallbackPost(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body('code') code?: string,
    @Body('state') state?: string,
  ) {
    await this.assertAuthRate(req, 'oauth-install');
    const response = await this.sapo.processInstallCallback(firstQuery(code) || '', firstQuery(state));
    return this.finishAuthFlow(req, res, response);
  }

  @Get('/oauth/install/webhooks')
  async webhookChallenge(@Res() res: Response) {
    res.status(200).send('ok');
  }

  @Post('/oauth/install/webhooks')
  async webhookPost(@Req() req: RawRequest, @Body() body: unknown, @Query() query: Record<string, unknown>, @Headers() headers: Record<string, unknown>) {
    return this.webhooks.handle({ headers, query, body, rawBody: req.rawBody });
  }

  @Post('/auth/session/exchange')
  async sessionExchange(@Req() req: Request, @Body('handoffCode') handoffCode: string, @Res() res: Response) {
    await this.rateLimit.assertAllowed(
      'session-exchange',
      clientFingerprint(req),
      this.env.AUTH_RATE_LIMIT_WINDOW_SECONDS,
      this.env.SESSION_EXCHANGE_RATE_LIMIT_MAX,
    );
    if (!isTrustedUnsafeOrigin(req, {
      frontendUrl: this.env.FRONTEND_URL,
      apiBaseUrl: this.env.API_BASE_URL,
      allowedOrigins: this.env.CORS_ALLOWED_ORIGINS,
    })) {
      throw new UnauthorizedException('Untrusted request origin');
    }
    const handoff = await this.sessions.consumeHandoff(handoffCode);
    const lifecycleGeneration = await this.sapo.getLifecycleGeneration(handoff.storeDomain);
    const sessionToken = this.sessions.createSessionToken(handoff.storeDomain, lifecycleGeneration);
    this.sessions.setSessionCookie(res, sessionToken);
    res.json({
      ok: true,
      storeDomain: handoff.storeDomain,
      redirectTo: handoff.redirectTo,
      sessionToken,
    });
  }

  @Post('/auth/logout')
  async logout(@Req() req: Request, @Res() res: Response) {
    await this.assertAuthRate(req, 'auth-logout');
    if (!isTrustedUnsafeOrigin(req, {
      frontendUrl: this.env.FRONTEND_URL,
      apiBaseUrl: this.env.API_BASE_URL,
      allowedOrigins: this.env.CORS_ALLOWED_ORIGINS,
    })) {
      throw new UnauthorizedException('Untrusted request origin');
    }
    const sessionToken = this.sessions.getSessionTokenFromRequest(req);
    if (!sessionToken) throw new UnauthorizedException('Missing auth session');
    this.sessions.verifySessionToken(sessionToken);
    this.sessions.clearSessionCookie(res);
    res.json({ ok: true });
  }

  @Get('/app/session')
  @UseGuards(ShopAuthGuard)
  async sessionProbe(@Req() req: Request & { storeDomain?: string }) {
    return { data: await this.sapo.getSessionProbe(req.storeDomain || '') };
  }
}
