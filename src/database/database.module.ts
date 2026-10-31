import { Global, Module } from '@nestjs/common';
import { MetafieldSyncPendingService } from './metafield-sync-pending.service';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService, MetafieldSyncPendingService],
  exports: [PrismaService, MetafieldSyncPendingService],
})
export class DatabaseModule {}
