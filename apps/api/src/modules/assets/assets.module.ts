import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DeliveryModule } from '../delivery/delivery.module.js';
import { UploadModule } from '../upload/upload.module.js';
import { AssetsService } from './assets.service.js';
import { AssetsController } from './assets.controller.js';
import { InvalidationService } from './invalidation.service.js';

@Module({
  imports: [AuthModule, DeliveryModule, UploadModule],
  controllers: [AssetsController],
  providers: [AssetsService, InvalidationService],
})
export class AssetsModule {}
