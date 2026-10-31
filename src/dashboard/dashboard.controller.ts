import { Controller, Get, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ShopAuthGuard } from '../common/guards/shop-auth.guard';
import { DashboardService } from './dashboard.service';

@Controller('/api/admin/dashboard')
@UseGuards(ShopAuthGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('/overview')
  async overview(@Req() req: { storeDomain?: string }) {
    if (!req.storeDomain) throw new UnauthorizedException('Missing store session');
    return { data: await this.dashboard.getOverview(req.storeDomain) };
  }
}
