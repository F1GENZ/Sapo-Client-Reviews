import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type express from 'express';
import { AppModule } from './app.module';
import { APP_ENV } from './config/app-config.module';
import type { AppEnv } from './config/env.schema';
import { applyHttpHardening } from './common/security/http-hardening';
import { IngressRateLimitService } from './common/security/ingress-rate-limit.service';
import { PublicResponseInterceptor } from './common/security/public-response';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const env = app.get<AppEnv>(APP_ENV);
  const instance = app.getHttpAdapter().getInstance() as express.Express;

  applyHttpHardening(instance, env, app.get(IngressRateLimitService));
  app.useGlobalInterceptors(new PublicResponseInterceptor());
  app.enableShutdownHooks();

  if (env.NODE_ENV === 'production' && env.TRUST_PROXY === false) {
    Logger.warn(
      'TRUST_PROXY=false in production: behind a proxy every client shares the proxy address and one rate-limit bucket. Set it to the verified ingress hop count or the proxy CIDR allowlist unless the app is directly exposed.',
      'Bootstrap',
    );
  }

  await app.listen(env.PORT);
}

void bootstrap();
