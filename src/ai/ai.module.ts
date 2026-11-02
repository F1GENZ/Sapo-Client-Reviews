import { Module } from '@nestjs/common';
import { SecurityModule } from '../common/security/security.module';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';

@Module({
  imports: [SecurityModule],
  controllers: [AiController],
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}
