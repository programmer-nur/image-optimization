/**
 * The registry, as the control plane sees it.
 *
 * Every method takes a `TenantScope` and applies it. That is the whole design: a
 * scope can only be produced from an authenticated key (`scopeOf`), and a method
 * cannot be called without one — so a route that forgets to scope its query fails to
 * compile rather than reading across tenants.
 *
 * THE 404 RULE. A read for an id owned by another tenant behaves exactly like a read
 * for an id that does not exist: `findById` returns null, `requireById` throws
 * `AssetNotFoundError`, and the API turns that into a 404. A 403 would be worse than
 * useless — it confirms the id is real, which is the single bit an enumeration attempt
 * is trying to learn.
 *
 * Deployment-wide work — reclamation walking the whole bucket, a worker acting on a
 * job it was handed — uses `UnscopedAssetRepository` instead, which is named that way
 * so its use is visible in review.
 */

import { Prisma, type PrismaClient } from './generated/client.js';
import { AssetStatus } from './generated/enums.js';
import { newAssetId } from './ids.js';
import {
  AssetNotFoundError,
  addVersionInTransaction,
  type AddVersionInput,
  type FocalPoint,
  type ListAssetsOptions,
} from './asset-repository.js';
import type { TenantScope } from './tenant-scope.js';

export interface CreateScopedAssetInput {
  id?: string;
  apiKeyId?: string;
  altText?: string;
  tags?: string[];
}

export class TenantScopedRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** Reserves an id so the client can build URLs before bytes are stored. */
  async create(scope: TenantScope, input: CreateScopedAssetInput = {}) {
    return this.prisma.asset.create({
      data: {
        id: input.id ?? newAssetId(),
        tenantId: scope,
        status: AssetStatus.pending_upload,
        ...(input.apiKeyId !== undefined ? { apiKeyId: input.apiKeyId } : {}),
        ...(input.altText !== undefined ? { altText: input.altText } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
      },
    });
  }

  /**
   * `findFirst`, not `findUnique`.
   *
   * `findUnique` takes only the primary key, so the tenant filter cannot be part of
   * the lookup — it would have to be checked afterwards, and "fetch then compare" is
   * exactly the shape that gets refactored into a leak.
   */
  async findById(scope: TenantScope, assetId: string, options: { includeDeleted?: boolean } = {}) {
    const asset = await this.prisma.asset.findFirst({
      where: { id: assetId, tenantId: scope },
      include: { versions: { orderBy: { version: 'desc' } } },
    });

    if (asset === null) return null;
    if (asset.deletedAt !== null && options.includeDeleted !== true) return null;
    return asset;
  }

  async requireById(scope: TenantScope, assetId: string) {
    const asset = await this.findById(scope, assetId);
    if (asset === null) throw new AssetNotFoundError(assetId);
    return asset;
  }

  /** Current version row, or null while an asset is still `pending_upload`. */
  async currentVersion(scope: TenantScope, assetId: string) {
    const asset = await this.requireById(scope, assetId);
    if (asset.currentVersion === 0) return null;

    return this.prisma.assetVersion.findUnique({
      where: { assetId_version: { assetId, version: asset.currentVersion } },
    });
  }

  async list(scope: TenantScope, options: ListAssetsOptions = {}) {
    const limit = Math.min(options.limit ?? 50, 200);

    const rows = await this.prisma.asset.findMany({
      where: {
        tenantId: scope,
        ...(options.includeDeleted === true ? {} : { deletedAt: null }),
        ...(options.status !== undefined ? { status: options.status } : {}),
        // The cursor is an asset id, and it is filtered inside the tenant — so a
        // cursor lifted from another tenant's response cannot step outside this one.
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

  async updateMetadata(
    scope: TenantScope,
    assetId: string,
    input: { altText?: string | null; tags?: string[]; focalPoint?: FocalPoint | null },
  ) {
    await this.requireById(scope, assetId);

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

  async softDelete(scope: TenantScope, assetId: string) {
    await this.requireById(scope, assetId);
    return this.prisma.asset.update({
      where: { id: assetId },
      data: { status: AssetStatus.deleted, deletedAt: new Date() },
    });
  }

  async listDerivatives(scope: TenantScope, assetId: string, version?: number) {
    // Ownership first: the derivative table has no tenant column of its own, and it
    // does not need one — an asset that is not yours has no derivatives you may see.
    await this.requireById(scope, assetId);

    return this.prisma.derivative.findMany({
      where: { assetId, ...(version !== undefined ? { version } : {}) },
      orderBy: { generatedAt: 'desc' },
    });
  }

  /**
   * Deduplication, within one tenant only.
   *
   * Matching across tenants would do two wrong things at once: hand this tenant a
   * reference to an asset it does not own, and disclose that some other tenant holds
   * those exact bytes. A shared stock photo uploaded by two customers is two assets,
   * and that is the correct answer even though it stores the bytes twice.
   */
  async findByContentHash(scope: TenantScope, contentHash: string) {
    const version = await this.prisma.assetVersion.findFirst({
      where: {
        contentHash,
        asset: {
          tenantId: scope,
          deletedAt: null,
          status: { notIn: [AssetStatus.rejected, AssetStatus.deleted] },
        },
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
   * Promotes staged bytes into a new version, within the tenant.
   *
   * The scope goes *into* the transaction's opening lookup rather than being checked
   * before it: a separate ownership read would leave a window in which the asset
   * could be reassigned between the check and the write.
   */
  async addVersion(scope: TenantScope, input: AddVersionInput) {
    return addVersionInTransaction(this.prisma, input, scope);
  }

  /** Rejection is a terminal state, so ownership is checked before recording it. */
  async markRejected(scope: TenantScope, assetId: string, reason: string) {
    await this.requireById(scope, assetId);
    return this.prisma.asset.update({
      where: { id: assetId },
      data: { status: AssetStatus.rejected, failureReason: reason, deletedAt: new Date() },
    });
  }
}
