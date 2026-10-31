import { Inject, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { APP_ENV } from '../config/app-config.module';
import type { AppEnv } from '../config/env.schema';
import { assertEncryptionKey } from '../config/secret-guard';

export type EncryptedToken = {
  ciphertext: string;
  iv: string;
  tag: string;
};

@Injectable()
export class TokenEncryptionService {
  private readonly key: Buffer;

  constructor(@Inject(APP_ENV) env: AppEnv) {
    this.key = assertEncryptionKey(env.DATA_ENCRYPTION_KEY);
  }

  encrypt(value: string): EncryptedToken {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    };
  }

  decrypt(value: EncryptedToken): string {
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(value.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(value.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  optionalDecrypt(value: Partial<EncryptedToken> | null | undefined): string | null {
    if (!value?.ciphertext || !value.iv || !value.tag) return null;
    return this.decrypt(value as EncryptedToken);
  }
}
