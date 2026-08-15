/**
 * The asset registry.
 *
 * Everything the control plane knows about an image. Deliberately *not* on the
 * delivery path: S3 object existence is the sole authority for whether a derivative
 * can be served, so images keep flowing when this database is unavailable.
 */

import { Prisma, type PrismaClient } from './generated/client.js';
import type { DerivativeOrigin } from './generated/enums.js';
import { AssetStatus } from './generated/enums.js';
import { newAssetId } from './ids.js';
import { assertTransition, type FailureReason, type RejectionReason } from './status.js';

export interface FocalPoint {
  x: number;
  y: number;
}

export interface CreateAssetInput {
  id?: string;
  apiKeyId?: string;
  altText?: string;
  tags?: string[];
}

export interface VersionMetadata {
  width?: number;
  height?: number;
  format?: string;
  bytes?: number;
  hasAlpha?: boolean;
  colorspace?: string;
  orientation?: number;
  dominantColor?: string;
  lqip?: string;
  masterKey?: string;
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

export interface ListAssetsOptions {
  limit?: number;
  cursor?: string;
  status?: AssetStatus;
  includeDeleted?: boolean;
}

export class AssetNotFoundError extends Error {
  constructor(assetId: string) {
    super(`No asset with id "${assetId}".`);
    this.name = 'AssetNotFoundError';
  }
}

export class AssetRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** Reserves an id so the client can build URLs before bytes are stored. */
  async create(input: CreateAssetInput = {}) {
    return this.prisma.asset.create({
      data: {
        id: input.id ?? newAssetId(),
        status: AssetStatus.pending_upload,
        ...(input.apiKeyId !== undefined ? { apiKeyId: input.apiKeyId } : {}),
        ...(input.altText !== undefined ? { altText: input.altText } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
      },
    });
  }

  async findById(assetId: string, options: { includeDeleted?: boolean } = {}) {
    const asset = await this.prisma.asset.findUnique({
      where: { id: assetId },
      include: { versions: { orderBy: { version: 'desc' } } },
    });

    if (asset === null) return null;
    if (asset.deletedAt !== null && options.includeDeleted !== true) return null;
    return asset;
  }

  async requireById(assetId: string) {
    const asset = await this.findById(assetId);
    if (asset === null) throw new AssetNotFoundError(assetId);
    return asset;
  }

  /** Current version row, or null while an asset is still `pending_upload`. */
  async currentVersion(assetId: string) {
    const asset = await this.requireById(assetId);
    if (asset.currentVersion === 0) return null;

    return this.prisma.assetVersion.findUnique({
      where: { assetId_version: { assetId, version: asset.currentVersion } },
    });
  }

  async list(options: ListAssetsOptions = {}) {
    const limit = Math.min(options.limit ?? 50, 200);

    const rows = await this.prisma.asset.findMany({
      where: {
        ...(options.includeDeleted === true ? {} : { deletedAt: null }),
        ...(options.status !== undefined ? { status: options.status } : {}),
        ...(options.cursor !== undefined ? { id: { lt: options.cursor } } : {}),
      },
      // ULIDs sort by creation time, so id ordering is chronological for free.
      orderBy: { id: 'desc' },
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const assets = hasMore ? rows.slice(0, limit) : rows;

    return {
      assets,
      ...(hasMore ? { nextCursor: assets[assets.length - 1]!.id } : {}),
    };
  }

  /**
   * Promotes staged bytes into a new immutable version.
   *
   * The version number and the status move together in one transaction: a version
   * row without the matching `current_version` would make an asset that exists in
   * storage but is invisible to every reader.
   */
  async addVersion(input: {
    assetId: string;
    sourceKey: string;
    contentHash: string;
    metadata?: VersionMetadata;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const asset = await tx.asset.findUnique({ where: { id: input.assetId } });
      if (asset === null) throw new AssetNotFoundError(input.assetId);

      assertTransition(asset.status, AssetStatus.stored);

      const version = asset.currentVersion + 1;
      const meta = input.metadata ?? {};

      const created = await tx.assetVersion.create({
        data: {
          assetId: input.assetId,
          version,
          sourceKey: input.sourceKey,
          contentHash: input.contentHash,
          ...(meta.masterKey !== undefined ? { masterKey: meta.masterKey } : {}),
          ...(meta.width !== undefined ? { width: meta.width } : {}),
          ...(meta.height !== undefined ? { height: meta.height } : {}),
          ...(meta.format !== undefined ? { format: meta.format } : {}),
          ...(meta.bytes !== undefined ? { bytes: BigInt(meta.bytes) } : {}),
          ...(meta.hasAlpha !== undefined ? { hasAlpha: meta.hasAlpha } : {}),
          ...(meta.colorspace !== undefined ? { colorspace: meta.colorspace } : {}),
          ...(meta.orientation !== undefined ? { orientation: meta.orientation } : {}),
          ...(meta.dominantColor !== undefined ? { dominantColor: meta.dominantColor } : {}),
          ...(meta.lqip !== undefined ? { lqip: meta.lqip } : {}),
        },
      });

      await tx.asset.update({
        where: { id: input.assetId },
        data: { currentVersion: version, status: AssetStatus.stored, failureReason: null },
      });

      return created;
    });
  }

  /** Fills in properties discovered during processing. */
  async updateVersionMetadata(assetId: string, version: number, metadata: VersionMetadata) {
    return this.prisma.assetVersion.update({
      where: { assetId_version: { assetId, version } },
      data: {
        ...(metadata.width !== undefined ? { width: metadata.width } : {}),
        ...(metadata.height !== undefined ? { height: metadata.height } : {}),
        ...(metadata.format !== undefined ? { format: metadata.format } : {}),
        ...(metadata.bytes !== undefined ? { bytes: BigInt(metadata.bytes) } : {}),
        ...(metadata.hasAlpha !== undefined ? { hasAlpha: metadata.hasAlpha } : {}),
        ...(metadata.colorspace !== undefined ? { colorspace: metadata.colorspace } : {}),
        ...(metadata.orientation !== undefined ? { orientation: metadata.orientation } : {}),
        ...(metadata.dominantColor !== undefined ? { dominantColor: metadata.dominantColor } : {}),
        ...(metadata.lqip !== undefined ? { lqip: metadata.lqip } : {}),
        ...(metadata.masterKey !== undefined ? { masterKey: metadata.masterKey } : {}),
      },
    });
  }

  /** Editable attributes that do not change the bytes, and so do not bump a version. */
  async updateMetadata(
    assetId: string,
    input: { altText?: string | null; tags?: string[]; focalPoint?: FocalPoint | null },
  ) {
    await this.requireById(assetId);

    return this.prisma.asset.update({
      where: { id: assetId },
      data: {
        ...(input.altText !== undefined ? { altText: input.altText } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        // Clearing a nullable JSON column needs Prisma.DbNull; a plain `null` would
        // be ambiguous with storing the JSON value `null`.
        ...(input.focalPoint !== undefined
          ? { focalPoint: input.focalPoint === null ? Prisma.DbNull : { ...input.focalPoint } }
          : {}),
      },
    });
  }

  async transitionStatus(
    assetId: string,
    to: AssetStatus,
    options: { reason?: RejectionReason | FailureReason } = {},
  ) {
    return this.prisma.$transaction(async (tx) => {
      const asset = await tx.asset.findUnique({ where: { id: assetId } });
      if (asset === null) throw new AssetNotFoundError(assetId);

      assertTransition(asset.status, to);

      return tx.asset.update({
        where: { id: assetId },
        data: {
          status: to,
          failureReason: options.reason ?? null,
          ...(to === AssetStatus.deleted ? { deletedAt: new Date() } : {}),
        },
      });
    });
  }

  async markReady(assetId: string) {
    return this.transitionStatus(assetId, AssetStatus.ready);
  }

  async markRejected(assetId: string, reason: RejectionReason) {
    return this.transitionStatus(assetId, AssetStatus.rejected, { reason });
  }

  async markFailed(assetId: string, reason: FailureReason) {
    return this.transitionStatus(assetId, AssetStatus.failed, { reason });
  }

  /**
   * Soft delete. Object removal and CDN invalidation are the caller's job; the
   * registry only records intent, so a partially failed cleanup can be reconciled
   * later by the orphan collector rather than losing the delete.
   */
  async softDelete(assetId: string) {
    return this.transitionStatus(assetId, AssetStatus.deleted);
  }

  /**
   * Finds a non-deleted asset whose current version has these exact bytes.
   *
   * Storing the same image twice wastes storage and doubles processing for no gain,
   * and re-uploading is common — a CMS retry, a user double-click.
   */
  async findByContentHash(contentHash: string) {
    const version = await this.prisma.assetVersion.findFirst({
      where: {
        contentHash,
        asset: { deletedAt: null, status: { notIn: [AssetStatus.rejected, AssetStatus.deleted] } },
      },
      orderBy: { createdAt: 'asc' },
      include: { asset: true },
    });

    if (version === null) return null;
    // Only a *current* version counts as a duplicate; a superseded one is history.
    if (version.asset.currentVersion !== version.version) return null;
    return version;
  }

  /**
   * Records a materialized derivative.
   *
   * Bookkeeping only — used for cost attribution and orphan collection, never for
   * serving. Callers on the delivery path treat failures here as non-fatal.
   */
  async recordDerivative(input: RecordDerivativeInput) {
    return this.prisma.derivative.upsert({
      where: { canonicalKey: input.canonicalKey },
      create: {
        canonicalKey: input.canonicalKey,
        assetId: input.assetId,
        version: input.version,
        format: input.format,
        ...(input.width !== undefined ? { width: input.width } : {}),
        ...(input.height !== undefined ? { height: input.height } : {}),
        bytes: BigInt(input.bytes),
        generatedBy: input.generatedBy,
      },
      update: { bytes: BigInt(input.bytes), generatedAt: new Date() },
    });
  }

  async listDerivatives(assetId: string, version?: number) {
    return this.prisma.derivative.findMany({
      where: { assetId, ...(version !== undefined ? { version } : {}) },
      orderBy: { generatedAt: 'desc' },
    });
  }

  /** Per-asset storage attribution, split the way the cost model splits it. */
  async storageFootprint(assetId: string) {
    const [versions, derivatives] = await Promise.all([
      this.prisma.assetVersion.findMany({ where: { assetId }, select: { bytes: true } }),
      this.prisma.derivative.findMany({ where: { assetId }, select: { bytes: true } }),
    ]);

    const sum = (rows: Array<{ bytes: bigint | null }>): bigint =>
      rows.reduce<bigint>((total, row) => total + (row.bytes ?? 0n), 0n);

    return {
      originalBytes: sum(versions),
      derivativeBytes: sum(derivatives),
      derivativeCount: derivatives.length,
    };
  }

  /* ------------------------------------------------------------------ *
   * Lifecycle and reclamation.
   *
   * Every query here answers "what is safe to delete", so each one is written to
   * err toward keeping objects. A reclamation job that is slightly too cautious
   * costs storage; one that is slightly too eager destroys originals.
   * ------------------------------------------------------------------ */

  /**
   * Every live `{assetId}/{version}` pair, as a set for O(1) membership.
   *
   * Loaded once per reconciliation run rather than queried per object: a bucket
   * holds far more objects than the registry holds versions, so this is the small
   * side of the join. Deleted assets are excluded — their objects *are* orphans.
   */
  async liveVersionKeys(): Promise<Set<string>> {
    const rows = await this.prisma.assetVersion.findMany({
      where: { asset: { deletedAt: null } },
      select: { assetId: true, version: true },
    });

    return new Set(rows.map((row) => `${row.assetId}/${row.version}`));
  }

  /** Asset ids that exist at all, deleted or not. */
  async knownAssetIds(): Promise<Set<string>> {
    const rows = await this.prisma.asset.findMany({ select: { id: true } });
    return new Set(rows.map((row) => row.id));
  }

  /**
   * Uploads that were presigned and never completed.
   *
   * Scoped to `pending_upload`: an asset in any other status has bytes committed,
   * whatever else may have gone wrong with it.
   */
  async pendingUploadsOlderThan(cutoff: Date) {
    return this.prisma.asset.findMany({
      where: { status: AssetStatus.pending_upload, createdAt: { lt: cutoff }, deletedAt: null },
      select: { id: true, createdAt: true },
    });
  }

  /**
   * Versions the asset has moved past, old enough to reclaim.
   *
   * The age filter is on the *superseding* version's creation, not this one's: what
   * matters is how long ago this version stopped being current, since that is when
   * consumer pages started referencing the new URLs.
   */
  async supersededVersionsOlderThan(cutoff: Date) {
    const rows = await this.prisma.assetVersion.findMany({
      where: {
        asset: { deletedAt: null },
        createdAt: { lt: cutoff },
      },
      select: { assetId: true, version: true, sourceKey: true, masterKey: true, createdAt: true },
      orderBy: [{ assetId: 'asc' }, { version: 'asc' }],
    });

    const currents = new Map(
      (await this.prisma.asset.findMany({ select: { id: true, currentVersion: true } })).map(
        (asset) => [asset.id, asset.currentVersion],
      ),
    );

    return rows.filter((row) => {
      const current = currents.get(row.assetId);
      return current !== undefined && row.version < current;
    });
  }

  /** Removes one version's rows. Objects are deleted by the caller, first. */
  async deleteVersionRows(assetId: string, version: number): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.derivative.deleteMany({ where: { assetId, version } }),
      this.prisma.assetVersion.deleteMany({ where: { assetId, version } }),
    ]);
  }

  /** Removes bookkeeping rows for derivatives that no longer exist in storage. */
  async deleteDerivativeRows(canonicalKeys: string[]): Promise<number> {
    if (canonicalKeys.length === 0) return 0;

    const result = await this.prisma.derivative.deleteMany({
      where: { canonicalKey: { in: canonicalKeys } },
    });
    return result.count;
  }

  /**
   * Deployment-wide storage totals, split the way the cost model splits them.
   *
   * Originals and masters come from the version rows; derivatives from their own
   * table. Masters are counted separately because the conditional-master threshold
   * is a tuning decision, and its effect is invisible if it is folded into either
   * of the other two.
   */
  async aggregateStorage(): Promise<{
    originalBytes: bigint;
    derivativeBytes: bigint;
    assetCount: number;
    versionCount: number;
    derivativeCount: number;
    masterCount: number;
  }> {
    const [versionAgg, derivativeAgg, assetCount, masterCount] = await Promise.all([
      this.prisma.assetVersion.aggregate({ _sum: { bytes: true }, _count: true }),
      this.prisma.derivative.aggregate({ _sum: { bytes: true }, _count: true }),
      this.prisma.asset.count({ where: { deletedAt: null } }),
      this.prisma.assetVersion.count({ where: { masterKey: { not: null } } }),
    ]);

    return {
      originalBytes: versionAgg._sum.bytes ?? 0n,
      derivativeBytes: derivativeAgg._sum.bytes ?? 0n,
      assetCount,
      versionCount: versionAgg._count,
      derivativeCount: derivativeAgg._count,
      masterCount,
    };
  }
}
