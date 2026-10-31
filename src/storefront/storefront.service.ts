import { Inject, Injectable } from '@nestjs/common';
import { APP_ENV } from '../config/app-config.module';
import type { AppEnv } from '../config/env.schema';
import { SapoApiService } from '../sapo/sapo-api.service';

@Injectable()
export class StorefrontService {
  constructor(
    private readonly sapoApi: SapoApiService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async writeStorefrontConfig(storeDomain: string, accessToken: string): Promise<void> {
    const apiUrl = this.env.API_BASE_URL.replace(/\/+$/, '');
    const desired: Array<{ key: string; value: string }> = [
      { key: 'config', value: JSON.stringify({ apiUrl, storeDomain }) },
      { key: 'api_url', value: apiUrl },
      { key: 'store_domain', value: storeDomain },
    ];

    const existing = await this.sapoApi.getMetafields(storeDomain, accessToken, 'shop');
    for (const { key, value } of desired) {
      const current = existing.find((m) => m.namespace === 'f1genz' && m.key === key);
      if (current) {
        await this.sapoApi.updateMetafield(storeDomain, accessToken, String(current.id), { value, value_type: 'string' });
      } else {
        await this.sapoApi.createMetafield(storeDomain, accessToken, {
          namespace: 'f1genz', key, value, value_type: 'string', owner_resource: 'shop',
        });
      }
    }
  }
}
