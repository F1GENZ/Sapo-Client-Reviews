import { Controller, Get, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ShopAuthGuard } from '../common/guards/shop-auth.guard';
import { OpsService } from './ops.service';

type StoreRequest = { storeDomain?: string };

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
}
