import { Module } from '@nestjs/common';
import { ReviewModule } from '../review/review.module';
import { MediaController } from './media.controller';
import { PublicMediaController } from './public-media.controller';
import { PublicMediaGuard } from './public-media.guard';

@Module({
  imports: [ReviewModule],
  controllers: [MediaController, PublicMediaController],
  providers: [PublicMediaGuard],
})
export class MediaModule {}
