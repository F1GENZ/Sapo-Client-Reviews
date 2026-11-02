import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { OutboundDispatcherService } from './outbound-dispatcher.service';
import { OutboundWebhookController } from './outbound-webhook.controller';
import { OutboundWebhookService } from './outbound-webhook.service';

@Module({
  imports: [DatabaseModule],
  controllers: [OutboundWebhookController],
  providers: [OutboundWebhookService, OutboundDispatcherService],
  exports: [OutboundWebhookService, OutboundDispatcherService],
})
export class OutboundModule {}
