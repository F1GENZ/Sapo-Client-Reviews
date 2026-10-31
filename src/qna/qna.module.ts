import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ReviewModule } from '../review/review.module';
import { QnaStoreService } from './qna-store.service';
import { QnaService } from './qna.service';
import { QnaController } from './qna.controller';
import { PublicQnaController } from './public-qna.controller';

@Module({
  imports: [DatabaseModule, ReviewModule],
  controllers: [QnaController, PublicQnaController],
  providers: [QnaStoreService, QnaService],
  exports: [QnaStoreService, QnaService],
})
export class QnaModule {}
