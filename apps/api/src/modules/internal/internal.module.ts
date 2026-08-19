/**
 * Wiring for the internal worker surface.
 *
 * The secret is resolved once, at module construction, through `requireWorkerSecret`
 * — so a control plane started without one fails at boot rather than serving these
 * routes with no authentication. That ordering is the point: the failure mode being
 * avoided is a deployment that looks healthy and is wide open.
 */

import { Module } from '@nestjs/common';
import { requireWorkerSecret, type AppConfig } from '@imgopt/config';
import { InfraModule } from '../../infra/infra.module.js';
import { APP_CONFIG, WORKER_SECRET } from '../../tokens.js';
import { InternalController } from './internal.controller.js';
import { InternalService } from './internal.service.js';
import { WorkerGuard } from './worker.guard.js';

@Module({
  imports: [InfraModule],
  controllers: [InternalController],
  providers: [
    InternalService,
    WorkerGuard,
    {
      provide: WORKER_SECRET,
      useFactory: (config: AppConfig) => requireWorkerSecret(config, 'The control plane'),
      inject: [APP_CONFIG],
    },
  ],
})
export class InternalModule {}
