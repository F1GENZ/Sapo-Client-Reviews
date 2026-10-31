import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

export const UPLOAD_ERROR = {
  ticketMissing: 'upload_ticket_missing',
  ticketInvalid: 'upload_ticket_invalid',
  ticketExpired: 'upload_ticket_expired',
  ticketMismatch: 'upload_ticket_mismatch',
  ticketUsed: 'upload_ticket_used',
  fileTooLarge: 'upload_file_too_large',
  unsupportedType: 'upload_unsupported_type',
  contentMismatch: 'upload_content_mismatch',
  invalidSize: 'upload_invalid_size',
  invalidProduct: 'upload_invalid_product',
  invalidNonce: 'upload_invalid_nonce',
  dailyCap: 'upload_daily_cap',
  notConfigured: 'upload_not_configured',
  storageRejected: 'upload_storage_rejected',
  storageFailed: 'upload_storage_failed',
} as const;

export type UploadErrorCode = (typeof UPLOAD_ERROR)[keyof typeof UPLOAD_ERROR];

const body = (code: UploadErrorCode, message: string) => ({ code, message });

export const uploadUnauthorized = (code: UploadErrorCode, message: string) =>
  new UnauthorizedException(body(code, message));

export const uploadForbidden = (code: UploadErrorCode, message: string) =>
  new ForbiddenException(body(code, message));

export const uploadConflict = (code: UploadErrorCode, message: string) =>
  new ConflictException(body(code, message));

export const uploadTooLarge = (message: string) =>
  new PayloadTooLargeException(body(UPLOAD_ERROR.fileTooLarge, message));

export const uploadBadRequest = (code: UploadErrorCode, message: string) =>
  new BadRequestException(body(code, message));

export const uploadRateLimited = (code: UploadErrorCode, message: string) =>
  new HttpException(body(code, message), HttpStatus.TOO_MANY_REQUESTS);

export const uploadUnavailable = (code: UploadErrorCode, message: string) =>
  new ServiceUnavailableException(body(code, message));

export const uploadBadGateway = (code: UploadErrorCode, message: string) =>
  new BadGatewayException(body(code, message));
