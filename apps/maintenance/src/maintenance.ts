/**
 * Scheduled reclamation.
 *
 * Five jobs. Four keep storage from growing without bound — reaping abandoned
 * uploads, expiring superseded versions, collecting orphaned objects, and reporting
 * what is actually stored — and one, deliberately last, *creates* work: re-enqueueing
 * optimizations that were never queued because an enqueue failed after the bytes were
 * already durable.
 *
 * THE GOVERNING CONSTRAINT. Every deletion here is irreversible, and the objects
 * being considered include originals — the one thing in this system that cannot be
 * regenerated. So each job is written to fail *toward keeping* objects:
 *
 * - Nothing written inside the safety window is ever touched, because the registry
 *   is not the authority on what exists. The generator writes a derivative and only
 *   then records it, and that record is explicitly best-effort — it may lag, and it
 *   may never arrive at all. An object with no row is therefore not evidence of an
 *   orphan; it is evidence of an object whose row has not shown up *yet*.
 * - A key that cannot be parsed is left alone rather than deleted. An unrecognized
 *   key is more likely to mean this code is out of date than that the object is junk.
 * - A per-run deletion cap bounds the blast radius of a bug to one run.
 *
 * Kept free of Lambda types so it runs against real MinIO and Postgres in tests;
 * `handler.ts` is the only Lambda-aware layer.
 */

import type { StoragePort } from '@imgopt/storage';
import type { QueuePort } from '@imgopt/queue';
import type { AppConfig } from '@imgopt/config';
import type { AssetRepository } from '@imgopt/db';
import {
  DERIVED_PREFIX,
  MASTER_PREFIX,
  ORIGINAL_PREFIX,
  parseVersionSegment,
  toStagingKey,
} from '@imgopt/core';
import { recordMaintenanceRun, recordStorageTotals } from '@imgopt/metrics';

export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface JobResult {
  examined: number;
  reclaimed: number;
  /** Objects skipped because they fell inside the safety window. */
  skippedRecent?: number;
  /** Keys this code could not parse. Non-zero means investigate, not delete. */
  unparsed?: number;
}

/**
 * Outcome of the one job here that adds work instead of removing it.
 *
 * Deliberately not a `JobResult`: every field there counts destruction, and a report
 * line reading `reclaimed` for a re-enqueue would read as a deletion.
 */
export interface ReenqueueResult {
  examined: number;
  enqueued: number;
  /** Enqueues that threw. Left for the next run rather than failing this one. */
  failed?: number;
}

export interface MaintenanceReport {
  pendingUploads: JobResult;
  supersededVersions: JobResult;
  orphans: JobResult;
  stalledOptimizations: ReenqueueResult;
  storage: {
    originalBytes: string;
    masterBytes: string;
    derivativeBytes: string;
    assetCount: number;
    versionCount: number;
    derivativeCount: number;
    masterCount: number;
  };
  dryRun: boolean;
}

/**
 * Identifies the asset version an object belongs to.
 *
 * Returns undefined for anything unrecognized, and the caller treats that as
 * "leave it alone". The four prefixes disagree about where the version sits — the
 * delivery prefix carries the full `v{version}-{epoch}` segment because it is a URL
 * component, while the private prefixes carry a bare number — so this is the one
 * place that has to know both shapes.
 */
export function ownerOf(key: string): { assetId: string; version: number } | undefined {
  const segments = key.split('/');
  if (segments.length < 3) return undefined;

  const [prefix, assetId, versionSegment] = segments as [string, string, string];
  if (assetId === '') return undefined;

  if (prefix === DERIVED_PREFIX) {
    const parsed = parseVersionSegment(versionSegment);
    return parsed === undefined ? undefined : { assetId, version: parsed.assetVersion };
  }

  if (prefix === ORIGINAL_PREFIX || prefix === MASTER_PREFIX) {
    if (!/^\d+$/.test(versionSegment)) return undefined;
    return { assetId, version: Number(versionSegment) };
  }

  return undefined;
}

export class Maintenance {
  private deletionsThisRun = 0;

  constructor(
    private readonly storage: StoragePort,
    private readonly repo: AssetRepository,
    private readonly queue: QueuePort,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  async run(now: Date = new Date()): Promise<MaintenanceReport> {
    this.deletionsThisRun = 0;

    // Ordered so each job shrinks the work of the next: reaping abandoned uploads
    // and expiring superseded versions both remove rows, and reconciliation reads
    // those rows to decide what is an orphan.
    const pendingUploads = await this.reapPendingUploads(now);
    const supersededVersions = await this.expireSupersededVersions(now);
    const orphans = await this.collectOrphans(now);
    // Last of the mutating jobs, and the only one that creates work: an asset the
    // reclaimers just removed must not then have optimization queued for it.
    const stalledOptimizations = await this.reenqueueStalledOptimizations(now);
    const storage = await this.reportStorage();

    const report: MaintenanceReport = {
      pendingUploads,
      supersededVersions,
      orphans,
      stalledOptimizations,
      storage,
      dryRun: this.config.lifecycle.dryRun,
    };

    /*
     * The heartbeat, emitted only on a completed run.
     *
     * Reclamation stopping is otherwise silent — no errors, no 5xx, nothing failing —
     * and the first evidence is a storage bill months later. The alarm on this metric
     * fires on *absence*, so it has to be emitted here, at the end, rather than
     * derived from Lambda invocations: an invocation that dies mid-walk is still an
     * invocation, and would keep the alarm quiet while nothing was being reclaimed.
     */
    recordMaintenanceRun({
      reclaimed: pendingUploads.reclaimed + supersededVersions.reclaimed + orphans.reclaimed,
      dryRun: this.config.lifecycle.dryRun,
    });

    this.logger.info({ report }, 'maintenance run complete');
    return report;
  }

  /**
   * Abandoned presigned uploads.
   *
   * A client asked for a target and never called complete. The staged bytes are
   * already covered by the bucket's own expiry rule; what this reclaims is the
   * `pending_upload` row, which would otherwise accumulate forever and make the
   * asset count meaningless.
   */
  private async reapPendingUploads(now: Date): Promise<JobResult> {
    const cutoff = new Date(
      now.getTime() - this.config.lifecycle.pendingUploadTtlHours * 3_600_000,
    );
    const abandoned = await this.repo.pendingUploadsOlderThan(cutoff);

    let reclaimed = 0;
    for (const asset of abandoned) {
      if (!this.canDelete()) break;

      if (!this.config.lifecycle.dryRun) {
        // Belt and braces: the lifecycle rule should already have expired these,
        // but a rule that was misconfigured or added late leaves bytes behind.
        await this.storage.delete(toStagingKey(asset.id)).catch(() => undefined);
        await this.repo.softDelete(asset.id).catch((error: unknown) => {
          this.logger.warn({ err: error, assetId: asset.id }, 'failed to reap pending upload');
        });
      }
      this.deletionsThisRun += 1;
      reclaimed += 1;
    }

    return { examined: abandoned.length, reclaimed };
  }

  /**
   * Versions the asset has moved past.
   *
   * The retention window is what keeps consumer pages working: HTML cached in a
   * browser or a CDN still references the previous version's URLs, and reclaiming
   * immediately turns every one of those into a broken image. See design.md D8.
   *
   * The window is measured from when a version was *superseded*, which is a stored
   * timestamp rather than something inferrable from the row. Measuring from the
   * version's own creation makes the promise meaningless for exactly the assets it
   * matters most for: a source that had been live longer than the window became
   * deletable the first time this job ran after it was replaced.
   */
  private async expireSupersededVersions(now: Date): Promise<JobResult> {
    const cutoff = new Date(
      now.getTime() - this.config.lifecycle.supersededRetentionDays * 86_400_000,
    );
    const superseded = await this.repo.supersededVersionsOlderThan(cutoff);

    let reclaimed = 0;
    for (const version of superseded) {
      if (!this.canDelete()) break;

      if (!this.config.lifecycle.dryRun) {
        // Objects first, rows second. The reverse order would leave objects with no
        // row — which the orphan collector would eventually clean up, but only after
        // they had spent a full safety window looking like live data.
        await this.storage.delete(version.sourceKey).catch(() => undefined);
        if (version.masterKey !== null) {
          await this.storage.delete(version.masterKey).catch(() => undefined);
        }
        await this.storage
          .deletePrefix(`${DERIVED_PREFIX}/${version.assetId}/v${version.version}-`)
          .catch(() => undefined);

        await this.repo.deleteVersionRows(version.assetId, version.version);
      }

      this.deletionsThisRun += 1;
      reclaimed += 1;
      this.logger.info(
        { assetId: version.assetId, version: version.version },
        'superseded version reclaimed',
      );
    }

    return { examined: superseded.length, reclaimed };
  }

  /**
   * Objects belonging to no live asset version.
   *
   * These accumulate from partially failed deletions, from a version whose rows were
   * removed before its objects, and from an encoder epoch bump that stranded a
   * previous epoch's derivatives.
   */
  private async collectOrphans(now: Date): Promise<JobResult> {
    const safetyCutoff = new Date(
      now.getTime() - this.config.lifecycle.orphanSafetyWindowHours * 3_600_000,
    );

    const live = await this.repo.liveVersionKeys();

    let examined = 0;
    let reclaimed = 0;
    let skippedRecent = 0;
    let unparsed = 0;
    const orphanedDerivativeKeys: string[] = [];

    for (const prefix of [ORIGINAL_PREFIX, MASTER_PREFIX, DERIVED_PREFIX]) {
      let continuationToken: string | undefined;

      do {
        const page = await this.storage.list(`${prefix}/`, {
          maxKeys: 1000,
          ...(continuationToken !== undefined ? { continuationToken } : {}),
        });
        continuationToken = page.continuationToken;

        for (const object of page.objects) {
          examined += 1;

          /*
           * The safety window, and why it is checked before anything else.
           *
           * A derivative is written to S3 *before* its bookkeeping row exists, and
           * that row is best-effort — it may lag, and it may never arrive. So a
           * recently written object with no row is the expected state during normal
           * operation, not an orphan. Deleting it would remove a derivative a viewer
           * is about to be served, and the generator would regenerate it, forever.
           */
          if (object.lastModified > safetyCutoff) {
            skippedRecent += 1;
            continue;
          }

          const owner = ownerOf(object.key);
          if (owner === undefined) {
            // Not recognized. Far more likely to mean this code is out of date than
            // that the object is junk, so it is reported rather than deleted.
            unparsed += 1;
            continue;
          }

          if (live.has(`${owner.assetId}/${owner.version}`)) continue;
          if (!this.canDelete()) break;

          if (!this.config.lifecycle.dryRun) {
            await this.storage.delete(object.key).catch((error: unknown) => {
              this.logger.warn({ err: error, key: object.key }, 'failed to delete orphan');
            });
          }
          if (object.key.startsWith(`${DERIVED_PREFIX}/`)) {
            orphanedDerivativeKeys.push(object.key);
          }

          this.deletionsThisRun += 1;
          reclaimed += 1;
        }
      } while (continuationToken !== undefined && this.canDelete());
    }

    if (!this.config.lifecycle.dryRun && orphanedDerivativeKeys.length > 0) {
      await this.repo.deleteDerivativeRows(orphanedDerivativeKeys).catch(() => undefined);
    }

    if (unparsed > 0) {
      this.logger.warn(
        { unparsed },
        'objects with unrecognized keys were left in place; check whether the key scheme changed',
      );
    }

    return { examined, reclaimed, skippedRecent, unparsed };
  }

  /**
   * Optimizations that were never queued.
   *
   * The only job here that adds work, and the only one whose failure mode is an asset
   * that is *incomplete* rather than storage that is oversized. A failed enqueue must
   * never fail an upload — the bytes are already durable — so the job is dropped and
   * the asset is left `stored`: servable, but with no LQIP, no metadata, no warm set,
   * and no route to `ready`. The upload path has always said a reconciliation job
   * would pick these up. This is that job.
   *
   * Safe to be wrong in the enqueue direction: the optimizer skips derivatives that
   * already exist, writes conditionally, upserts its rows, and treats `ready → ready`
   * as a legal transition, so a duplicate job costs one invocation and changes
   * nothing. It is not safe to be wrong the other way — nothing else recovers a lost
   * job.
   *
   * Deliberately not extended to `failed` assets. That state means processing was
   * tried and could not succeed; retrying it on a schedule would re-run a source that
   * cannot be processed, every day, forever. Recovery there is the operator's
   * `reprocess` call.
   */
  private async reenqueueStalledOptimizations(now: Date): Promise<ReenqueueResult> {
    const cutoff = new Date(now.getTime() - this.config.lifecycle.stalledOptimizeHours * 3_600_000);
    const stalled = await this.repo.awaitingOptimizationOlderThan(
      cutoff,
      this.config.lifecycle.maxReenqueuesPerRun,
    );

    let enqueued = 0;
    let failed = 0;

    for (const asset of stalled) {
      if (this.config.lifecycle.dryRun) {
        this.logger.info({ assetId: asset.id }, 'would re-enqueue stalled optimization');
        continue;
      }

      try {
        await this.queue.enqueue({
          assetId: asset.id,
          assetVersion: asset.currentVersion,
          // Names the origin in every downstream log line: a burst of these is an
          // enqueue path that is failing, not a burst of uploads.
          correlationId: `reconcile-${asset.id}`,
        });
        enqueued += 1;
        this.logger.info(
          { assetId: asset.id, version: asset.currentVersion },
          'stalled optimization re-enqueued',
        );
      } catch (error) {
        // One bad enqueue must not abandon the rest, and must not fail the run: the
        // next run reconsiders the same asset.
        failed += 1;
        this.logger.warn({ err: error, assetId: asset.id }, 'failed to re-enqueue optimization');
      }
    }

    if (stalled.length === this.config.lifecycle.maxReenqueuesPerRun) {
      // Silence here would read as "everything was handled" while a backlog grows.
      this.logger.warn(
        { cap: this.config.lifecycle.maxReenqueuesPerRun },
        're-enqueue cap reached; more assets are awaiting optimization than this run queued',
      );
    }

    return { examined: stalled.length, enqueued, failed };
  }

  /**
   * Storage totals, split by what they cost and what controls them.
   *
   * Split three ways rather than reported as one number because each is controlled
   * by a different decision: originals by ingest volume, masters by the conditional
   * threshold, derivatives by the warm-set configuration. A single total makes the
   * effect of widening the warm set invisible.
   */
  private async reportStorage(): Promise<MaintenanceReport['storage']> {
    const totals = await this.repo.aggregateStorage();

    // Emitted as well as logged. A log line is not a trend, and storage is the
    // largest slow-moving number in the cost model — the one variable a dashboard
    // was blind to while the report existed only in an invocation's output.
    recordStorageTotals({
      originalBytes: totals.originalBytes,
      masterBytes: totals.masterBytes,
      derivativeBytes: totals.derivativeBytes,
      assetCount: totals.assetCount,
      derivativeCount: totals.derivativeCount,
    });

    return {
      // Strings, because JSON has no BigInt and a byte total above 2^53 is a
      // perfectly ordinary size for this system.
      originalBytes: totals.originalBytes.toString(),
      masterBytes: totals.masterBytes.toString(),
      derivativeBytes: totals.derivativeBytes.toString(),
      assetCount: totals.assetCount,
      versionCount: totals.versionCount,
      derivativeCount: totals.derivativeCount,
      masterCount: totals.masterCount,
    };
  }

  /** Bounds one run's blast radius, so a bug costs one run rather than a bucket. */
  private canDelete(): boolean {
    if (this.deletionsThisRun < this.config.lifecycle.maxDeletionsPerRun) return true;

    this.logger.warn(
      { cap: this.config.lifecycle.maxDeletionsPerRun },
      'per-run deletion cap reached; remaining work deferred to the next run',
    );
    return false;
  }
}
