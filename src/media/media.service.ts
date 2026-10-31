import { Injectable, Logger } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import * as crypto from 'crypto';
import { randomBytes } from 'crypto';
import { APP_ENV } from '../config/app-config.module';
import type { AppEnv } from '../config/env.schema';
import { NUMERIC_ID_RE } from '../common/security/public-limits';
import { RedisService } from '../redis/redis.service';
import {
  UPLOAD_ERROR,
  uploadBadGateway,
  uploadBadRequest,
  uploadConflict,
  uploadForbidden,
  uploadRateLimited,
  uploadTooLarge,
  uploadUnauthorized,
  uploadUnavailable,
} from './media-errors';

export const IMAGE_MAX_SIZE_BYTES = 5 * 1024 * 1024;
export const VIDEO_MAX_SIZE_BYTES = 2 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = IMAGE_MAX_SIZE_BYTES;
export const PUBLIC_UPLOAD_TICKET_TTL_MS = 2 * 60 * 1000;
export const PUBLIC_UPLOAD_DAILY_CAP_PER_STORE = 500;
export const ALLOWED_UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4'] as const;
export const CONTENT_TYPE_ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
};

const UPLOAD_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
};

const MP4_MAJOR_BRANDS: Record<string, true> = {
  isom: true, iso2: true, iso4: true, iso5: true, iso6: true, iso7: true, iso8: true, iso9: true,
  mp41: true, mp42: true, avc1: true, dash: true, 'M4V ': true,
};
const FTYP_MIN_BOX_BYTES = 16;

const TICKET_KEY_CONTEXT = 'f1genz-sapo:upload-ticket:v1';
const DAILY_COUNTER_TTL_SECONDS = 2 * 24 * 60 * 60;
const TICKET_NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const OBJECT_KEY_RE = /^reviews\/([A-Za-z0-9.-]{1,253})\/\d{1,20}\/[A-Za-z0-9_-]{16,64}\.(?:jpg|png|webp|mp4)$/;
const STORAGE_REQUEST_TIMEOUT_MS = 10_000;
const DELETE_CONCURRENCY = 4;
const OWN_PREFIX = 'reviews/';

export type StoredMediaObject = { key: string; url: string; uploadedAt: number };
export type StoredMediaPage = { objects: StoredMediaObject[]; cursor: string | null };

export function normalizeUploadContentType(contentType: string): string {
  const normalized = String(contentType || '').trim().toLowerCase();
  return CONTENT_TYPE_ALIASES[normalized] || normalized;
}

// The declared Content-Type is client-controlled and the CDN serves the stored object with the type written at upload.
export function sniffUploadContentType(buffer: Buffer): string | null {
  if (!buffer || buffer.length < 3) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (buffer.length >= 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (isMp4(buffer)) return 'video/mp4';
  return null;
}

function isMp4(buffer: Buffer): boolean {
  if (buffer.length < FTYP_MIN_BOX_BYTES) return false;
  if (buffer.toString('latin1', 4, 8) !== 'ftyp') return false;
  const boxSize = buffer.readUInt32BE(0);
  if (boxSize < FTYP_MIN_BOX_BYTES || boxSize > buffer.length) return false;
  return MP4_MAJOR_BRANDS[buffer.toString('latin1', 8, 12)] === true;
}

const deriveTicketKey = (secret: string): Buffer =>
  crypto.createHmac('sha256', secret).update(TICKET_KEY_CONTEXT).digest();

const signTicket = (secret: string, encoded: string): string =>
  crypto.createHmac('sha256', deriveTicketKey(secret)).update(encoded).digest('base64url');

type UploadTicketPayload = {
  storeDomain: string;
  productId: string;
  contentType: string;
  fileSize: number;
  expiresAt: number;
  nonce: string;
};

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly redis: RedisService,
  ) {}

  validateProductId(productId: string): string {
    if (typeof productId !== 'string' || !NUMERIC_ID_RE.test(productId)) {
      throw uploadBadRequest(UPLOAD_ERROR.invalidProduct, 'Invalid productId');
    }
    return productId;
  }

  normalizeContentType(contentType: string): string {
    return normalizeUploadContentType(contentType);
  }

  validateUploadInput(contentType: string, fileSize: number): 'image' | 'video' {
    const normalizedContentType = this.normalizeContentType(contentType);
    if (!ALLOWED_UPLOAD_TYPES.includes(normalizedContentType as (typeof ALLOWED_UPLOAD_TYPES)[number])) {
      throw uploadBadRequest(UPLOAD_ERROR.unsupportedType, 'Unsupported file type');
    }
    const isVideo = normalizedContentType.startsWith('video/');
    const maxSize = isVideo ? VIDEO_MAX_SIZE_BYTES : IMAGE_MAX_SIZE_BYTES;
    if (!Number.isInteger(fileSize) || fileSize <= 0) {
      throw uploadBadRequest(UPLOAD_ERROR.invalidSize, 'Invalid file size');
    }
    if (fileSize > maxSize) {
      throw uploadTooLarge(`File too large. Max ${isVideo ? '2MB' : '5MB'} for ${isVideo ? 'video' : 'image'}`);
    }
    return isVideo ? 'video' : 'image';
  }

  private assertUploadContentMatches(declaredContentType: string, buffer: Buffer): string {
    const sniffed = sniffUploadContentType(buffer);
    if (!sniffed) throw uploadBadRequest(UPLOAD_ERROR.contentMismatch, 'Unsupported file content');
    if (sniffed !== declaredContentType) {
      throw uploadBadRequest(UPLOAD_ERROR.contentMismatch, 'File content does not match declared type');
    }
    return sniffed;
  }

  private ticketSecret(): string {
    const secret = this.env.R2_UPLOAD_SECRET;
    if (!secret) throw uploadUnavailable(UPLOAD_ERROR.notConfigured, 'Upload ticket secret is not configured');
    return secret;
  }

  createUploadTicket(input: {
    storeDomain: string;
    productId: string;
    contentType: string;
    fileSize: number;
    ttlMs?: number;
  }): { ticket: string; expiresAt: number } {
    if (!this.storageConfigured) throw uploadUnavailable(UPLOAD_ERROR.notConfigured, 'Media upload is not configured');
    const secret = this.ticketSecret();
    const productId = this.validateProductId(input.productId);
    this.validateUploadInput(input.contentType, input.fileSize);

    const expiresAt = Date.now() + (input.ttlMs ?? PUBLIC_UPLOAD_TICKET_TTL_MS);
    const payload: UploadTicketPayload = {
      storeDomain: input.storeDomain,
      productId,
      contentType: this.normalizeContentType(input.contentType),
      fileSize: input.fileSize,
      expiresAt,
      nonce: randomBytes(16).toString('base64url'),
    };

    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return { ticket: `${encoded}.${signTicket(secret, encoded)}`, expiresAt };
  }

  // Signature, expiry and store binding only; nothing is consumed, so it is safe before the body is read.
  inspectUploadTicket(ticket: string, storeDomain: string): UploadTicketPayload {
    const secret = this.ticketSecret();

    const [encoded, signature] = String(ticket || '').split('.');
    if (!encoded || !signature) throw uploadUnauthorized(UPLOAD_ERROR.ticketMissing, 'Missing upload ticket');

    const computed = Buffer.from(signTicket(secret, encoded));
    const provided = Buffer.from(signature);
    if (computed.length !== provided.length || !crypto.timingSafeEqual(computed, provided)) {
      throw uploadUnauthorized(UPLOAD_ERROR.ticketInvalid, 'Invalid upload ticket');
    }

    let payload: UploadTicketPayload;
    try {
      payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as UploadTicketPayload;
    } catch {
      throw uploadUnauthorized(UPLOAD_ERROR.ticketInvalid, 'Invalid upload ticket');
    }

    if (!payload || typeof payload.expiresAt !== 'number' || payload.expiresAt <= Date.now()) {
      throw uploadUnauthorized(UPLOAD_ERROR.ticketExpired, 'Upload ticket expired');
    }
    if (typeof payload.nonce !== 'string' || !TICKET_NONCE_RE.test(payload.nonce)) {
      throw uploadUnauthorized(UPLOAD_ERROR.ticketInvalid, 'Invalid upload ticket');
    }
    if (payload.storeDomain !== storeDomain) {
      throw uploadForbidden(UPLOAD_ERROR.ticketMismatch, 'Upload ticket mismatch');
    }
    return payload;
  }

  async assertDailyUploadCapacity(storeDomain: string): Promise<void> {
    let used = 0;
    try {
      used = Number(await this.redis.get<number>(this.dailyCounterKey(storeDomain))) || 0;
    } catch (error) {
      this.logger.warn(`Daily upload counter unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (used >= PUBLIC_UPLOAD_DAILY_CAP_PER_STORE) throw this.dailyCapError();
  }

  async verifyUploadTicket(ticket: string, expected: {
    storeDomain: string;
    productId: string;
    contentType: string;
    fileSize: number;
  }): Promise<UploadTicketPayload> {
    const payload = this.inspectUploadTicket(ticket, expected.storeDomain);
    if (
      payload.productId !== this.validateProductId(expected.productId) ||
      payload.contentType !== this.normalizeContentType(expected.contentType) ||
      payload.fileSize !== expected.fileSize
    ) {
      throw uploadForbidden(UPLOAD_ERROR.ticketMismatch, 'Upload ticket mismatch');
    }
    this.validateUploadInput(payload.contentType, payload.fileSize);

    // A replayed ticket would mint unlimited distinct objects under the store prefix.
    const ttlSeconds = Math.max(1, Math.ceil((payload.expiresAt - Date.now()) / 1000));
    const consumed = await this.redis.setNx(`upload-ticket:${payload.nonce}`, payload.storeDomain, ttlSeconds);
    if (!consumed) throw uploadConflict(UPLOAD_ERROR.ticketUsed, 'Upload ticket already used');

    await this.recordDailyUpload(payload.storeDomain);
    return payload;
  }

  async uploadFile(
    storeDomain: string,
    productId: string,
    nonce: string,
    contentType: string,
    buffer: Buffer,
  ): Promise<{ cdnUrl: string; type: string }> {
    const workerUrl = this.env.R2_WORKER_URL;
    const uploadSecret = this.env.R2_UPLOAD_SECRET;
    const publicDomain = this.env.R2_PUBLIC_DOMAIN;
    if (!workerUrl || !uploadSecret || !publicDomain) {
      this.logger.error('Media upload is not configured: check R2_WORKER_URL, R2_UPLOAD_SECRET, R2_PUBLIC_DOMAIN');
      throw uploadUnavailable(UPLOAD_ERROR.notConfigured, 'Media upload is not configured');
    }

    const safeContentType = this.normalizeContentType(contentType);
    const mediaType = this.validateUploadInput(safeContentType, buffer.length);
    const sniffed = this.assertUploadContentMatches(safeContentType, buffer);
    const safeProductId = this.validateProductId(productId);
    if (!TICKET_NONCE_RE.test(nonce)) throw uploadBadRequest(UPLOAD_ERROR.invalidNonce, 'Invalid upload ticket');
    const key = `reviews/${storeDomain}/${safeProductId}/${nonce}.${UPLOAD_EXTENSIONS[sniffed]}`;

    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetch(`${workerUrl}/${key}`, {
        method: 'PUT',
        headers: { 'Content-Type': sniffed, 'X-Upload-Token': uploadSecret },
        body: new Uint8Array(buffer),
      });
    } catch (error) {
      this.logger.error(`Worker upload unreachable: ${error instanceof Error ? error.message : String(error)}`);
      throw uploadBadGateway(UPLOAD_ERROR.storageFailed, 'Upload failed');
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      this.logger.error(`Worker upload failed: ${response.status} ${errorText || response.statusText}`);
      if (response.status === 413) throw uploadTooLarge('File too large');
      if (response.status === 401 || response.status === 403) {
        throw uploadBadGateway(UPLOAD_ERROR.storageRejected, 'Upload service rejected the request');
      }
      throw uploadBadGateway(UPLOAD_ERROR.storageFailed, 'Upload failed');
    }

    return { cdnUrl: `https://${publicDomain}/${key}`, type: mediaType };
  }

  get storageConfigured(): boolean {
    return Boolean(this.env.R2_WORKER_URL && this.env.R2_UPLOAD_SECRET && this.env.R2_PUBLIC_DOMAIN);
  }

  async deleteByUrls(urls: string[], storeDomain?: string): Promise<void> {
    await this.deleteOwnedObjects(urls, storeDomain);
  }

  async deleteOwnedObjects(urls: string[], storeDomain?: string): Promise<number> {
    if (!this.storageConfigured) return 0;
    const keys = [...new Set(urls.map((url) => this.ownedKey(url, storeDomain)).filter((key): key is string => key !== null))];
    let deleted = 0;
    for (let i = 0; i < keys.length; i += DELETE_CONCURRENCY) {
      const results = await Promise.all(keys.slice(i, i + DELETE_CONCURRENCY).map((key) => this.deleteKey(key)));
      deleted += results.filter(Boolean).length;
    }
    return deleted;
  }

  async listOwnedObjects(cursor: string | null, limit: number): Promise<StoredMediaPage> {
    if (!this.storageConfigured) throw new Error('Media storage is not configured');
    const query = new URLSearchParams({ prefix: OWN_PREFIX, limit: String(limit) });
    if (cursor) query.set('cursor', cursor);
    const response = await fetch(`${this.env.R2_WORKER_URL}/list?${query.toString()}`, {
      method: 'GET',
      headers: { 'X-Upload-Token': this.env.R2_UPLOAD_SECRET },
      signal: AbortSignal.timeout(STORAGE_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Media list failed: HTTP ${response.status}`);
    const body: unknown = await response.json();
    const record = typeof body === 'object' && body !== null ? body : {};
    const rawObjects: unknown[] = 'objects' in record && Array.isArray(record.objects) ? record.objects : [];
    const objects: StoredMediaObject[] = [];
    for (const item of rawObjects) {
      if (typeof item !== 'object' || item === null || !('key' in item) || !('uploaded' in item)) continue;
      const { key, uploaded } = item;
      if (typeof key !== 'string' || !OBJECT_KEY_RE.test(key)) continue;
      if (typeof uploaded !== 'number' || !Number.isFinite(uploaded)) continue;
      objects.push({ key, url: `https://${this.env.R2_PUBLIC_DOMAIN}/${key}`, uploadedAt: uploaded });
    }
    const next = 'cursor' in record ? record.cursor : null;
    return { objects, cursor: typeof next === 'string' && next ? next : null };
  }

  private ownedKey(raw: string, storeDomain?: string): string | null {
    const publicDomain = this.env.R2_PUBLIC_DOMAIN.trim().toLowerCase();
    if (!publicDomain || typeof raw !== 'string') return null;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.host.toLowerCase() !== publicDomain) return null;
    const match = OBJECT_KEY_RE.exec(url.pathname.slice(1));
    if (!match) return null;
    if (storeDomain !== undefined && match[1] !== storeDomain) return null;
    return match[0];
  }

  private async deleteKey(key: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.env.R2_WORKER_URL}/${key}`, {
        method: 'DELETE',
        headers: { 'X-Upload-Token': this.env.R2_UPLOAD_SECRET },
        signal: AbortSignal.timeout(STORAGE_REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.logger.warn(`Media delete rejected for ${key}: HTTP ${response.status}`);
        return false;
      }
      return true;
    } catch (error) {
      this.logger.warn(`Media delete failed for ${key}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private dailyCounterKey(storeDomain: string): string {
    return `upload-daily:${storeDomain}:${new Date().toISOString().slice(0, 10)}`;
  }

  private dailyCapError() {
    return uploadRateLimited(UPLOAD_ERROR.dailyCap, 'Daily upload limit reached for this store');
  }

  private async recordDailyUpload(storeDomain: string): Promise<void> {
    let count = 0;
    try {
      count = await this.redis.incr(this.dailyCounterKey(storeDomain), DAILY_COUNTER_TTL_SECONDS);
    } catch (error) {
      this.logger.warn(`Daily upload counter unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (count > PUBLIC_UPLOAD_DAILY_CAP_PER_STORE) throw this.dailyCapError();
  }
}
