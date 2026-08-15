import { Module } from '@nestjs/common';
import { DeliveryService } from './delivery.service.js';
import { SignedUrlService } from './signed-url.service.js';

@Module({
  providers: [DeliveryService, SignedUrlService],
  exports: [DeliveryService, SignedUrlService],
})
export class DeliveryModule {}
