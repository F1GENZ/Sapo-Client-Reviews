import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  ValidationPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MediaService, MAX_UPLOAD_BYTES } from './media.service';
import { PresignDto } from './dto/presign.dto';
import { PublicMediaGuard, type PublicMediaRequest } from './public-media.guard';
import { ReviewService } from '../review/review.service';
import type { WidgetConfig } from '../review/interfaces/widget-config.interface';

type MediaFlags = { allowImage?: boolean; allowVideo?: boolean };
type UploadedFileLike = { buffer?: Buffer; mimetype?: string; size?: number };

const ticketPipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });

@Controller('/api/public/media')
@UseGuards(PublicMediaGuard)
export class PublicMediaController {
  constructor(
    private readonly media: MediaService,
    private readonly reviews: ReviewService,
  ) {}

  @Post('/ticket')
  @HttpCode(200)
  async createTicket(@Req() req: PublicMediaRequest, @Body(ticketPipe) body: PresignDto) {
    const storeDomain = req.publicStoreDomain as string;
    const config = (await this.reviews.getServingWidgetConfig(storeDomain)) as WidgetConfig & MediaFlags;
    const mediaType = this.media.validateUploadInput(body.contentType, body.fileSize);
    if (mediaType === 'image' && config.allowImage === false) throw new ForbiddenException('Image upload is disabled');
    if (mediaType === 'video' && config.allowVideo === false) throw new ForbiddenException('Video upload is disabled');

    const ticket = this.media.createUploadTicket({
      storeDomain,
      productId: body.productId,
      contentType: body.contentType,
      fileSize: body.fileSize,
    });
    return { data: { ticket: ticket.ticket, expiresAt: ticket.expiresAt } };
  }

  @Post('/upload')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 4 } }))
  async upload(
    @UploadedFile() file: UploadedFileLike | undefined,
    @Req() req: PublicMediaRequest,
    @Query('productId') productId?: string,
    @Query('ticket') ticket?: string,
  ) {
    const storeDomain = req.publicStoreDomain as string;
    if (!file?.buffer?.length) throw new BadRequestException('Missing file');

    const contentType = String(file.mimetype || 'application/octet-stream');
    const verified = await this.media.verifyUploadTicket(String(ticket || ''), {
      storeDomain,
      productId: String(productId || ''),
      contentType,
      fileSize: file.size || file.buffer.length,
    });

    const result = await this.media.uploadFile(storeDomain, verified.productId, verified.nonce, contentType, file.buffer);
    return { data: { url: result.cdnUrl, type: result.type } };
  }
}
