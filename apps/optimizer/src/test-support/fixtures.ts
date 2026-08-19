/**
 * Registry fixtures for the optimizer's integration suite. **Test support only.**
 *
 * The tests need to plant assets and read back what the optimizer recorded, and the
 * optimizer itself no longer has a database connection to do either with (design.md
 * L2). Rather than reaching for `UnscopedAssetRepository` in the test files — which
 * lint denies outside this directory, and rightly — the setup and the assertions go
 * through these, which is also what the tests read like they wanted all along.
 *
 * Excluded from the build and never bundled.
 */

import { UnscopedAssetRepository, type PrismaClient, type VersionMetadata } from '@imgopt/db';
import { DEFAULT_TENANT_ID } from '@imgopt/db';

export class RegistryFixtures {
  private readonly repo: UnscopedAssetRepository;

  constructor(prisma: PrismaClient) {
    this.repo = new UnscopedAssetRepository(prisma);
  }

  /**
   * A bare asset, with no version yet.
   *
   * Deliberately separate from `addVersion`: the caller uploads the real bytes to
   * storage between the two, and folding them together silently produced a *second*
   * version, which made every job look stale and every test report `skipped`.
   */
  async createAsset(id: string) {
    return this.repo.create({ tenantId: DEFAULT_TENANT_ID, id });
  }

  /** An additional version, for the stale-job cases. */
  async addVersion(input: {
    assetId: string;
    sourceKey: string;
    contentHash: string;
    metadata?: VersionMetadata;
  }) {
    return this.repo.addVersion(input);
  }

  async readAsset(id: string) {
    return this.repo.requireById(id);
  }

  async readCurrentVersion(id: string) {
    return this.repo.currentVersion(id);
  }

  async readDerivatives(id: string) {
    return this.repo.listDerivatives(id);
  }

  async softDelete(id: string) {
    return this.repo.softDelete(id);
  }
}
