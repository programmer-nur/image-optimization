/**
 * Health endpoints.
 *
 * `/healthz` is liveness: the process is up. `/readyz` is readiness: dependencies
 * are reachable, so the load balancer withholds traffic from an instance that cannot
 * serve — while liveness still reports alive, so the orchestrator does not kill it.
 */

import { Controller, Get, Inject } from '@nestjs/common';
import type { PrismaClient } from '@imgopt/db';
import type { StoragePort } from '@imgopt/storage';
import { PRISMA, STORAGE } from '../../tokens.js';
import { Public } from '../auth/permissions.decorator.js';
import { ApiError } from '../../common/errors.js';

@Controller()
export class HealthController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(STORAGE) private readonly storage: StoragePort,
  ) {}

  @Get('healthz')
  @Public()
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('readyz')
  @Public()
  async readiness(): Promise<{ status: 'ready'; checks: Record<string, 'ok'> }> {
    const [db, storage] = await Promise.allSettled([
      this.prisma.$queryRaw`SELECT 1`,
      // A cheap list against a prefix that need not exist; proves credentials and
      // connectivity without depending on any object.
      this.storage.list('healthz/', { maxKeys: 1 }),
    ]);

    if (db.status === 'rejected') {
      throw new ApiError('internal_error', 503, 'Database is not reachable.');
    }
    if (storage.status === 'rejected') {
      throw new ApiError('internal_error', 503, 'Object storage is not reachable.');
    }

    return { status: 'ready', checks: { database: 'ok', storage: 'ok' } };
  }
}
