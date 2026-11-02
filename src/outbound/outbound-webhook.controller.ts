import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { ShopAuthGuard } from '../common/guards/shop-auth.guard';
import { STORE_DOMAIN_RE } from '../common/security/public-limits';
import { CreateOutboundWebhookDto, DeliveryQueryDto, UpdateOutboundWebhookDto } from './outbound-webhook.dto';
import { OutboundWebhookService } from './outbound-webhook.service';

type AuthRequest = { storeDomain?: string };

function requireStore(req: AuthRequest): string {
  if (!req.storeDomain || !STORE_DOMAIN_RE.test(req.storeDomain)) {
    throw new BadRequestException('Missing or invalid auth');
  }
  return req.storeDomain;
}

@Controller('api/admin/outbound-webhooks')
@UseGuards(ShopAuthGuard)
export class OutboundWebhookController {
  constructor(private readonly service: OutboundWebhookService) {}

  @Get('events')
  listEvents() {
    return { data: this.service.events };
  }

  @Get()
  async list(@Req() req: AuthRequest) {
    return { data: await this.service.list(requireStore(req)) };
  }

  @Post()
  async create(
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    dto: CreateOutboundWebhookDto,
    @Req() req: AuthRequest,
  ) {
    return { data: await this.service.create(requireStore(req), dto) };
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    dto: UpdateOutboundWebhookDto,
    @Req() req: AuthRequest,
  ) {
    return { data: await this.service.update(requireStore(req), id, dto) };
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: AuthRequest) {
    return { data: await this.service.remove(requireStore(req), id) };
  }

  @Post(':id/rotate-secret')
  async rotate(@Param('id') id: string, @Req() req: AuthRequest) {
    return { data: await this.service.rotateSecret(requireStore(req), id) };
  }

  @Post(':id/test')
  async test(@Param('id') id: string, @Req() req: AuthRequest) {
    return { data: await this.service.sendTest(requireStore(req), id) };
  }

  @Get(':id/deliveries')
  async deliveries(
    @Param('id') id: string,
    @Query(new ValidationPipe({ transform: true, whitelist: true })) query: DeliveryQueryDto,
    @Req() req: AuthRequest,
  ) {
    return {
      data: await this.service.listDeliveries(requireStore(req), id, { page: query.page, size: query.size }),
    };
  }
}
