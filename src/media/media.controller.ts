import { Controller, Post, Body, UseGuards, Req, ValidationPipe } from '@nestjs/common';
import { ShopAuthGuard } from '../common/guards/shop-auth.guard';
import { PresignDto } from './dto/presign.dto';
import { MediaService } from './media.service';

@Controller('/api/admin/media')
@UseGuards(ShopAuthGuard)
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post('/upload-ticket')
  async createTicket(
    @Req() req: { storeDomain?: string },
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) body: PresignDto,
  ) {
    const ticket = this.media.createUploadTicket({
      storeDomain: req.storeDomain || '',
      productId: body.productId,
      contentType: body.contentType,
      fileSize: body.fileSize,
    });
    return { data: ticket };
  }
}
