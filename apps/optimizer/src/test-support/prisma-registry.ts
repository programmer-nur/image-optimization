/**
 * A `RegistryPort` backed directly by the database. **Test support only.**
 *
 * Production reaches the registry over HTTP through `HttpRegistry`; the optimizer
 * holds no database connection and no credential for one (design.md L2). This adapter
 * exists so the integration suite can exercise the optimizer's real logic against a
 * real Postgres without standing up the whole control plane, and it stands in for what
 * `apps/api/src/modules/internal` does in production.
 *
 * It lives under `test-support/` and is excluded from the build for that reason. The
 * property that matters — that the deployed worker carries no database driver — is
 * asserted against the *bundle* rather than trusted to this file's name.
 */

import {
  UnscopedAssetRepository,
  type FailureReason,
  type PrismaClient,
  type VersionMetadata,
} from '@imgopt/db';
import type { DerivativeRecord, OptimizeContextResult, RegistryPort } from '../registry-port.js';

export class PrismaRegistry implements RegistryPort {
  private readonly repo: UnscopedAssetRepository;

  constructor(prisma: PrismaClient) {
    this.repo = new UnscopedAssetRepository(prisma);
  }

  async optimizeContext(assetId: string): Promise<OptimizeContextResult> {
    const asset = await this.repo.findById(assetId, { includeDeleted: true });
    if (asset === null) return { context: null, reason: 'asset_not_found' };

    // Same trap as the control plane's copy: `currentVersion()` throws for a
    // soft-deleted asset, which is the case this has to answer calmly.
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

  async completeOptimize(
    assetId: string,
    version: number,
    metadata: VersionMetadata,
  ): Promise<void> {
    await this.repo.updateVersionMetadata(assetId, version, metadata);
    await this.repo.markReady(assetId);
  }

  async markFailed(assetId: string, reason: FailureReason): Promise<void> {
    await this.repo.markFailed(assetId, reason);
  }

  async recordDerivative(record: DerivativeRecord): Promise<void> {
    await this.repo.recordDerivative(record);
  }
}
