export {
  createPrismaClient,
  PrismaClient,
  AssetStatus,
  DerivativeOrigin,
  type ApiKey,
  type Asset,
  type AssetVersion,
  type Derivative,
  type ExecutionContext,
  type PrismaClientOptions,
} from './client.js';

export { isAssetId, isUploadId, newApiKeyId, newAssetId, newUploadId } from './ids.js';

export {
  FAILURE_REASONS,
  IllegalStatusTransition,
  REJECTION_REASONS,
  SERVABLE_STATUSES,
  TERMINAL_STATUSES,
  assertTransition,
  canTransition,
  type FailureReason,
  type RejectionReason,
} from './status.js';

export {
  AssetNotFoundError,
  UnscopedAssetRepository,
  type CreateAssetInput,
  type FocalPoint,
  type ListAssetsOptions,
  type RecordDerivativeInput,
  type VersionMetadata,
} from './asset-repository.js';

export { TenantScopedRepository, type CreateScopedAssetInput } from './tenant-scoped-repository.js';

export { DEFAULT_TENANT_ID, scopeOf, scopeOfTenant, type TenantScope } from './tenant-scope.js';

export { TenantRepository, type CreateTenantInput } from './tenant-repository.js';

export { hydrateDatabaseCredentials, resetCredentialCache } from './secrets.js';
