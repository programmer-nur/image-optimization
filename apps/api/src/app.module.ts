import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { InfraModule } from './infra/infra.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { DeliveryModule } from './modules/delivery/delivery.module.js';
import { UploadModule } from './modules/upload/upload.module.js';
import { AssetsModule } from './modules/assets/assets.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { CorrelationMiddleware } from './common/correlation.middleware.js';

@Module({
  imports: [InfraModule, AuthModule, DeliveryModule, UploadModule, AssetsModule, HealthModule],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Wrap every request in a correlation-id context.
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }
}
