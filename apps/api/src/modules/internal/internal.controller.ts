/**
 * The internal worker surface.
 *
 * Not public API. Every route here is guarded by a shared secret rather than an API
 * key, carries no tenant scope, and is versioned separately from `/v1` so it can move
 * in step with the workers without being a breaking change for anyone else.
 *
 * Kept deliberately small. The temptation with an internal prefix is to let it become
 * whatever the workers find convenient; each route here corresponds to one thing a
 * worker genuinely cannot do for itself now that it has no database connection.
 */

import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import {
  DerivativeOrigin,
  FAILURE_REASONS,
  type FailureReason,
  type VersionMetadata,
} from '@imgopt/db';
import { ApiError } from '../../common/errors.js';
import { Public } from '../auth/permissions.decorator.js';
import { WorkerGuard } from './worker.guard.js';
import { InternalService, type OptimizeContextResult } from './internal.service.js';

interface CompleteBody {
  version?: number;
  metadata?: VersionMetadata;
}

interface DerivativeBody {
  canonicalKey?: string;
  assetId?: string;
  version?: number;
  format?: string;
  width?: number;
  height?: number;
  bytes?: number;
  generatedBy?: string;
}

@Controller('internal/v1')
/*
 * `@Public()` means "not API-key-authenticated", NOT "unauthenticated".
 *
 * `ApiKeyGuard` is registered globally and runs before any controller-scoped guard, so
 * without this every route here answers 401 before `WorkerGuard` is ever consulted —
 * which is precisely what happened the first time this shipped, and it presents as a
 * guard that rejects a correct secret.
 *
 * The two credentials stay non-interchangeable: `WorkerGuard` below refuses anything
 * that does not present the shared secret, so an API key gets no further here than it
 * did before.
 */
@Public()
@UseGuards(WorkerGuard)
export class InternalController {
  constructor(private readonly internal: InternalService) {}

  /**
   * `{ context: null, reason }` rather than a 404 for a moot job.
   *
   * The optimizer's correct response to a deleted asset is to acknowledge the message
   * and move on. A 404 would make "nothing to do" indistinguishable from "the control
   * plane is misrouting", and one of those should retry.
   */
  @Get('optimize/:assetId')
  async optimizeContext(@Param('assetId') assetId: string): Promise<OptimizeContextResult> {
    return this.internal.optimizeContext(assetId);
  }

  @Post('optimize/:assetId/complete')
  async completeOptimize(
    @Param('assetId') assetId: string,
    @Body() body: CompleteBody,
  ): Promise<{ status: string }> {
    if (typeof body?.version !== 'number' || !Number.isInteger(body.version)) {
      throw ApiError.validation('A numeric version is required.');
    }
    if (body.metadata === undefined || typeof body.metadata !== 'object') {
      throw ApiError.validation('Version metadata is required.');
    }

    await this.internal.completeOptimize(assetId, {
      version: body.version,
      metadata: body.metadata,
    });
    return { status: 'ready' };
  }

  @Post('optimize/:assetId/failed')
  async markFailed(
    @Param('assetId') assetId: string,
    @Body() body: { reason?: string },
  ): Promise<{ status: string }> {
    // Validated against the enum rather than passed through: this value is written to
    // a column an operator reads during an incident, and an arbitrary string there is
    // worse than no value at all.
    const reason = body?.reason;
    if (!isFailureReason(reason)) {
      throw ApiError.validation(`reason must be one of: ${FAILURE_REASONS.join(', ')}.`);
    }

    await this.internal.markFailed(assetId, reason);
    return { status: 'failed' };
  }

  @Post('derivatives')
  async recordDerivative(@Body() body: DerivativeBody): Promise<{ status: string }> {
    const { canonicalKey, assetId, version, format, bytes } = body ?? {};

    if (
      typeof canonicalKey !== 'string' ||
      typeof assetId !== 'string' ||
      typeof version !== 'number' ||
      typeof format !== 'string' ||
      typeof bytes !== 'number'
    ) {
      throw ApiError.validation('canonicalKey, assetId, version, format, and bytes are required.');
    }

    // Defaulted rather than required: the only caller is the generator, and a
    // derivative arriving here by definition came from a miss. An unrecognised value
    // would otherwise be written straight into the column the cost attribution reads.
    const origin =
      body.generatedBy === DerivativeOrigin.warm
        ? DerivativeOrigin.warm
        : DerivativeOrigin.ondemand;

    await this.internal.recordDerivative({
      canonicalKey,
      assetId,
      version,
      format,
      bytes,
      ...(typeof body.width === 'number' ? { width: body.width } : {}),
      ...(typeof body.height === 'number' ? { height: body.height } : {}),
      generatedBy: origin,
    });
    return { status: 'recorded' };
  }
}

function isFailureReason(value: unknown): value is FailureReason {
  return typeof value === 'string' && (FAILURE_REASONS as readonly string[]).includes(value);
}
