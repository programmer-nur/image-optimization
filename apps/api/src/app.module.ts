import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { InfraModule } from './infra/infra.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { DeliveryModule } from './modules/delivery/delivery.module.js';
import { UploadModule } from './modules/upload/upload.module.js';
import { AssetsModule } from './modules/assets/assets.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { InternalModule } from './modules/internal/internal.module.js';
import { CorrelationMiddleware } from './common/correlation.middleware.js';
import { RateLimitMiddleware } from './common/rate-limit.middleware.js';

@Module({
  imports: [
    InfraModule,
    AuthModule,
    DeliveryModule,
    UploadModule,
    AssetsModule,
    HealthModule,
    InternalModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    /*
     * Rate limiting first, so a refused request costs as little as possible.
     *
     * It replaces the WAF rule that sat on the load balancer, which cannot follow the
     * control plane onto a Lightsail instance (design.md L4). Ordering matters: a
     * correlation id allocated for a request that is about to be refused is pure
     * waste, and at flood volume that waste is the attack.
     */
    consumer.apply(RateLimitMiddleware).forRoutes('*');
    // Wrap every surviving request in a correlation-id context.
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }
}
