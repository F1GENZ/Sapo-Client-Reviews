import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { DatabaseModule } from '../database/database.module';
import { OutboundModule } from '../outbound/outbound.module';
import { ReviewModule } from '../review/review.module';
import { QnaDataToolsService } from './qna-data-tools.service';
import { QnaStoreService } from './qna-store.service';
import { QnaService } from './qna.service';
import { QnaController } from './qna.controller';
import { PublicQnaController } from './public-qna.controller';

@Module({
  imports: [DatabaseModule, ReviewModule, CatalogModule, OutboundModule],
  controllers: [QnaController, PublicQnaController],
  providers: [QnaStoreService, QnaService, QnaDataToolsService],
  exports: [QnaStoreService, QnaService],
})
export class QnaModule {}
