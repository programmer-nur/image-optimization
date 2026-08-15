import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DeliveryModule } from '../delivery/delivery.module.js';
import { ValidationService } from './validation.service.js';
import { MalwareScanService } from './malware-scan.service.js';
import { UploadService } from './upload.service.js';
import { UploadController } from './upload.controller.js';

@Module({
  imports: [AuthModule, DeliveryModule],
  controllers: [UploadController],
  providers: [ValidationService, MalwareScanService, UploadService],
  exports: [UploadService],
})
export class UploadModule {}
