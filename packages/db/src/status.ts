/**
 * Asset status lifecycle.
 *
 * Transitions are validated rather than assigned freely. The states drive real
 * behaviour — a `failed` asset is retryable, a `rejected` one never is — and an
 * illegal transition is almost always a bug that would otherwise surface much later
 * as an asset stuck invisible to clients.
 */

import { AssetStatus } from './generated/enums.js';

export { AssetStatus };

/**
 * Legal transitions.
 *
 * - `pending_upload` -> bytes are not stored yet; the record exists only to reserve
 *   an id and let the client build URLs before the upload finishes.
 * - `stored` -> original is durable and validated. The upload response returns here,
 *   without waiting for processing.
 * - `ready` -> intrinsic metadata extracted and the warm set generated.
 * - `rejected` -> validation refused the bytes. Terminal; retrying cannot help.
 * - `failed` -> processing failed. Recoverable via reprocess, so it may return to
 *   `stored`.
 * - `deleted` -> soft-deleted. Terminal.
 */
const TRANSITIONS: Record<AssetStatus, readonly AssetStatus[]> = {
  [AssetStatus.pending_upload]: [AssetStatus.stored, AssetStatus.rejected, AssetStatus.deleted],
  // `stored -> stored` is a self-transition meaning "a new version arrived": the
  // source can be replaced again before the previous one finished processing.
  [AssetStatus.stored]: [
    AssetStatus.stored,
    AssetStatus.ready,
    AssetStatus.failed,
    AssetStatus.deleted,
  ],
  // Back to `stored` on reprocess or a replaced source, and `ready -> ready` when
  // a later version finishes processing.
  [AssetStatus.ready]: [
    AssetStatus.stored,
    AssetStatus.ready,
    AssetStatus.failed,
    AssetStatus.deleted,
  ],
  [AssetStatus.failed]: [AssetStatus.stored, AssetStatus.ready, AssetStatus.deleted],
  [AssetStatus.rejected]: [AssetStatus.deleted],
  [AssetStatus.deleted]: [],
};

/** States a client may see as servable. */
export const SERVABLE_STATUSES: readonly AssetStatus[] = [AssetStatus.stored, AssetStatus.ready];

/** States from which no further work will happen without operator action. */
export const TERMINAL_STATUSES: readonly AssetStatus[] = [
  AssetStatus.rejected,
  AssetStatus.deleted,
];

export function canTransition(from: AssetStatus, to: AssetStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class IllegalStatusTransition extends Error {
  readonly from: AssetStatus;
  readonly to: AssetStatus;

  constructor(from: AssetStatus, to: AssetStatus) {
    super(`Cannot move an asset from "${from}" to "${to}".`);
    this.name = 'IllegalStatusTransition';
    this.from = from;
    this.to = to;
  }
}

export function assertTransition(from: AssetStatus, to: AssetStatus): void {
  if (!canTransition(from, to)) throw new IllegalStatusTransition(from, to);
}

/**
 * Machine-readable failure reasons.
 *
 * Strings rather than free text so they can be a metric dimension: the difference
 * between "a client is sending the wrong content type" and "our processing is
 * broken" should be visible on a dashboard without reading logs.
 */
export const REJECTION_REASONS = [
  'content_type_mismatch',
  'unsupported_format',
  'pixel_limit_exceeded',
  'file_too_large',
  'malware_detected',
  'scan_unavailable',
  'quota_exceeded',
  'empty_file',
  /**
   * A rejection the API surface produced a code for that this vocabulary does not
   * name. Present so an unmapped code cannot quietly borrow a reason that means
   * something else — a spike here is a bug in the mapping, and reads as one.
   */
  'unknown',
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export const FAILURE_REASONS = [
  'corrupt_source',
  'timeout',
  'storage_error',
  'unexpected',
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];
