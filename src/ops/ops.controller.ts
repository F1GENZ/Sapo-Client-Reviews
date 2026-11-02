import { Body, Controller, Get, Post, Req, UnauthorizedException, UseGuards, ValidationPipe } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { ShopAuthGuard } from '../common/guards/shop-auth.guard';
import { OpsService } from './ops.service';

type StoreRequest = { storeDomain?: string };

class OrdersSyncDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  pages?: number;
}

const callerStore = (req: StoreRequest): string => {
  if (!req.storeDomain) throw new UnauthorizedException('Missing store session');
  return req.storeDomain;
};

@Controller('/api/admin/ops')
@UseGuards(ShopAuthGuard)
export class OpsController {
  constructor(private readonly ops: OpsService) {}

  @Get('/health')
  async health(@Req() req: StoreRequest) {
    return { data: await this.ops.getHealth(callerStore(req)) };
  }

  @Post('/resync-config')
  async resyncConfig(@Req() req: StoreRequest) {
    return { data: await this.ops.resyncConfig(callerStore(req)) };
  }

  @Post('/resync-webhooks')
  async resyncWebhooks(@Req() req: StoreRequest) {
    return { data: await this.ops.resyncWebhooks(callerStore(req)) };
  }

  @Post('/backfill-catalog')
  async backfillCatalog(@Req() req: StoreRequest) {
    return { data: await this.ops.backfillCatalog(callerStore(req)) };
  }

  @Post('/orders/sync')
  async syncOrders(
    @Body(new ValidationPipe({ transform: true, whitelist: true })) body: OrdersSyncDto,
    @Req() req: StoreRequest,
  ) {
    return { data: await this.ops.syncOrders(callerStore(req), { pages: body.pages }) };
  }

  @Post('/metafields/sync-all')
  async syncMetafields(@Req() req: StoreRequest) {
    return { data: await this.ops.syncAllMetafields(callerStore(req)) };
  }

  @Get('/diagnostics/export')
  async exportDiagnostics(@Req() req: StoreRequest) {
    return { data: await this.ops.exportDiagnostics(callerStore(req)) };
  }
}
