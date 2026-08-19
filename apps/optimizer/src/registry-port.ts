/**
 * What the optimizer needs from the registry, and nothing more.
 *
 * The optimizer used to hold its own database connection, which is the only reason it
 * had to run inside a VPC — and the VPC is what a NAT gateway and six interface
 * endpoints existed to serve (design.md L1). This port is the seam that let that go:
 * the production adapter posts to the control plane, and the function runs with no
 * database credential, no Secrets Manager client, and no VPC attachment.
 *
 * Two operations, not the four the repository exposed. Fetching context and completing
 * a job are the two things the optimizer actually does; splitting completion into
 * "record metadata" and "mark ready" only created a window where an asset had its
 * dimensions recorded and its status still `stored`.
 */

import type { FailureReason, VersionMetadata } from '@imgopt/db';
import type { DerivativeOrigin } from './derivative-origin.js';

/** Everything needed to decide whether a job is still worth running. */
export interface OptimizeContext {
  assetId: string;
  /** Non-null for a deleted asset. The job is skipped, not failed. */
  deletedAt: string | null;
  currentVersion: number;
  version: number;
  sourceKey: string;
}

/** Why there is nothing to do. Reported as the skip reason, so it stays distinguishable. */
export type OptimizeSkipReason = 'asset_not_found' | 'no_version';

export type OptimizeContextResult =
  { context: OptimizeContext; reason?: undefined } | { context: null; reason: OptimizeSkipReason };

/** A derivative the optimizer wrote as part of the warm set. */
export interface DerivativeRecord {
  canonicalKey: string;
  assetId: string;
  version: number;
  format: string;
  width?: number;
  height?: number;
  bytes: number;
  generatedBy: DerivativeOrigin;
}

export interface RegistryPort {
  /** The job's context, or the reason there is none. */
  optimizeContext(assetId: string): Promise<OptimizeContextResult>;

  /** Records metadata and readiness together, once the warm set exists. */
  completeOptimize(assetId: string, version: number, metadata: VersionMetadata): Promise<void>;

  /** Terminal failure. Called on the path where a retry cannot help. */
  markFailed(assetId: string, reason: FailureReason): Promise<void>;

  /** Bookkeeping for one warm derivative. Best-effort; the caller swallows failures. */
  recordDerivative(record: DerivativeRecord): Promise<void>;
}
