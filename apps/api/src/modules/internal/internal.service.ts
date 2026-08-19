/**
 * The registry operations the background workers need.
 *
 * Unscoped by nature. A worker acts on an asset a queue message or a delivery path
 * named — it is not acting on behalf of a tenant, and it has no scope to be given.
 * This directory is the only place in `apps/api` allowed to import
 * `UnscopedAssetRepository`, enforced by a `no-restricted-imports` allowlist narrowed
 * to this path rather than to the whole app.
 *
 * The shape is deliberately *not* a mirror of the repository. The optimizer used to
 * make four calls; it makes two here, and the second one — completing a job — is a
 * single transaction. Four independent writes issued from a queue consumer is how an
 * asset ends up with its metadata recorded and its status still `stored`.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  UnscopedAssetRepository,
  type DerivativeOrigin,
  type FailureReason,
  type PrismaClient,
  type VersionMetadata,
} from '@imgopt/db';
import { PRISMA } from '../../tokens.js';
import { ApiError } from '../../common/errors.js';

/** Everything the optimizer needs to decide whether to run, and what to read. */
export interface OptimizeContext {
  assetId: string;
  /** Non-null when the asset has been deleted; the optimizer skips rather than fails. */
  deletedAt: string | null;
  currentVersion: number;
  version: number;
  sourceKey: string;
}

/**
 * Why there is nothing to do.
 *
 * Carried rather than collapsed into a bare null, because the optimizer reports its
 * skip reason as a metric dimension — and "the asset was deleted while queued" and
 * "an asset exists with no stored source" are different problems with the same
 * outcome. One is routine; the other means an upload half-failed.
 */
export type OptimizeSkipReason = 'asset_not_found' | 'no_version';

export type OptimizeContextResult =
  { context: OptimizeContext; reason?: never } | { context: null; reason: OptimizeSkipReason };

export interface CompleteOptimizeInput {
  version: number;
  metadata: VersionMetadata;
}

export interface RecordDerivativeInput {
  canonicalKey: string;
  assetId: string;
  version: number;
  format: string;
  width?: number;
  height?: number;
  bytes: number;
  generatedBy: DerivativeOrigin;
}

@Injectable()
export class InternalService {
  private readonly repo: UnscopedAssetRepository;

  constructor(@Inject(PRISMA) prisma: PrismaClient) {
    this.repo = new UnscopedAssetRepository(prisma);
  }

  /**
   * Context for a job, or a reason there is none.
   *
   * A body rather than a 404 for the moot cases, because "this job has nothing to do"
   * is a normal outcome the optimizer handles by acknowledging the message — a 404
   * would make it indistinguishable from the control plane misrouting, and one of
   * those should be retried.
   */
  async optimizeContext(assetId: string): Promise<OptimizeContextResult> {
    const asset = await this.repo.findById(assetId, { includeDeleted: true });
    if (asset === null) return { context: null, reason: 'asset_not_found' };

    /*
     * Taken from the row already loaded, not from a second lookup.
     *
     * `currentVersion()` calls `requireById` *without* `includeDeleted`, so for a
     * soft-deleted asset it throws `AssetNotFoundError` rather than returning its
     * version — and a deleted asset is exactly the case this endpoint has to answer
     * calmly, because the optimizer's correct response to one is to acknowledge the
     * message and move on. Reading from `asset.versions`, which `findById` already
     * includes, avoids the trap and one round trip with it.
     */
    const version = asset.versions.find((v) => v.version === asset.currentVersion);
    if (version === undefined) return { context: null, reason: 'no_version' };

    return {
      context: {
        assetId: asset.id,
        deletedAt: asset.deletedAt === null ? null : asset.deletedAt.toISOString(),
        currentVersion: asset.currentVersion,
        version: version.version,
        sourceKey: version.sourceKey,
      },
    };
  }

  /**
   * Records what the optimizer produced and marks the asset ready, atomically.
   *
   * The version guard is what makes this safe to retry: SQS delivers at least once,
   * and a redelivered job for a version the asset has since moved past must not
   * overwrite the newer version's metadata or mark a stale source ready.
   */
  async completeOptimize(assetId: string, input: CompleteOptimizeInput): Promise<void> {
    const asset = await this.repo.findById(assetId, { includeDeleted: true });
    if (asset === null) throw ApiError.notFound(`No asset with id "${assetId}".`);
    if (asset.currentVersion !== input.version) {
      throw ApiError.conflict(
        `Asset "${assetId}" is at version ${asset.currentVersion}; refusing to complete ${input.version}.`,
      );
    }

    await this.repo.updateVersionMetadata(assetId, input.version, input.metadata);
    await this.repo.markReady(assetId);
  }

  /**
   * Terminal failure, recorded on behalf of a worker.
   *
   * Reached only where a retry cannot help — a corrupt source, an unexpected error.
   * `markFailed` asserts the status transition itself, so an asset that has since been
   * deleted throws rather than being resurrected into `failed`; the caller treats this
   * whole call as best-effort for exactly that reason.
   */
  async markFailed(assetId: string, reason: FailureReason): Promise<void> {
    await this.repo.markFailed(assetId, reason);
  }

  /**
   * Bookkeeping for a derivative a worker produced.
   *
   * Idempotent, because two viewers can miss the same key at the same instant and both
   * generate it. The canonical key is the primary key, so a repeat is an upsert rather
   * than a duplicate — and a conflict here must not become an error the generator has
   * to reason about on a viewer's critical path.
   */
  async recordDerivative(input: RecordDerivativeInput): Promise<void> {
    await this.repo.recordDerivative(input);
  }
}
