import { z } from 'zod';

/**
 * Deployment configuration, validated at startup.
 *
 * Everything here is *deployment*-specific: bucket names, thresholds, warm-set
 * policy. Transform *grammar* — the width ladder, quality levels, per-format
 * encoder defaults — deliberately lives in @imgopt/core as constants rather than
 * environment variables. Those values are baked into cached URLs, so changing one
 * is an encoder-epoch event (design.md D8), not a redeploy knob.
 */

const bytes = z.coerce.number().int().positive();
const pixels = z.coerce.number().int().positive();

/** Comma-separated env list -> string[]; empty string yields []. */
const csv = z.string().transform((s) =>
  s
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean),
);

const csvInts = csv.pipe(z.array(z.coerce.number().int().positive()));

/**
 * Environment booleans, parsed by spelling rather than by truthiness.
 *
 * `z.coerce.boolean()` is `Boolean(value)`, and every environment variable is a
 * string — so `"false"` coerces to **true**. That is not a hypothetical here: the CDK
 * writes these values literally (`String(config.malwareScanning)`), so a deployment
 * with scanning switched off would set `UPLOAD_MALWARE_SCAN_ENABLED=false`, the app
 * would read `true`, and — fail-closed being the default — it would hold every upload
 * forever waiting on a scanner that was never provisioned. The same coercion turned
 * `MAINTENANCE_DRY_RUN=false` into a reclamation job that never deletes anything.
 *
 * Unrecognized spellings are rejected rather than resolved to whichever side happens
 * to be truthy: a typo in a flag that decides whether uploads are held should stop
 * the process, not pick an answer.
 */
const bool = z
  .preprocess(
    (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
    z.union([z.boolean(), z.enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'])]),
  )
  .transform((value) =>
    typeof value === 'boolean' ? value : ['true', '1', 'yes', 'on'].includes(value),
  );

export const appConfigSchema = z.object({
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  storage: z.object({
    region: z.string().min(1),
    bucket: z.string().min(1),
    /** Set for MinIO locally; unset in AWS so the SDK resolves the real endpoint. */
    endpoint: z.string().url().optional(),
    forcePathStyle: bool.default(false),
  }),

  database: z.object({
    url: z.string().min(1),
    maxConnections: z.coerce.number().int().positive().default(10),
  }),

  queue: z.object({
    optimizeQueueUrl: z.string().min(1),
    endpoint: z.string().url().optional(),
  }),

  upload: z.object({
    /** Above this, the proxied endpoint returns 413 and directs to the presigned flow. */
    proxyThresholdBytes: bytes.default(10 * 1024 * 1024),
    maxFileBytes: bytes.default(100 * 1024 * 1024),
    /** Decompression-bomb ceiling. Also enforced inside Sharp. */
    maxPixels: pixels.default(100_000_000),
    presignTtlSeconds: z.coerce.number().int().positive().max(3600).default(300),
    acceptedFormats: csv
      .pipe(z.array(z.enum(['jpeg', 'png', 'webp', 'avif', 'gif', 'tiff'])))
      .default('jpeg,png,webp,avif'),
    /**
     * SVG is an XML attack surface; off unless explicitly enabled. See design.md D12.
     *
     * Enabling it currently fails the process at startup, on purpose. The sanitize
     * -and-rasterize path the spec describes does not exist yet, and the validator's
     * "enabled" branch is a stub that rejects every SVG with a 422 — so the flag as
     * shipped does not enable SVG, it enables a confusing error. A deployment that
     * sets it has made a decision it cannot get: better to refuse to boot, where the
     * message is read by the operator who set it, than to accept the setting and
     * surface it later as an upload failure nobody connects back to a config flag.
     */
    allowSvg: bool.default(false).refine((enabled) => !enabled, {
      message:
        'UPLOAD_ALLOW_SVG is not supported yet: SVG sanitization and rasterization ' +
        'are unimplemented, so enabling it would reject every SVG upload with a 422. ' +
        'Leave it unset until the sanitizer ships.',
    }),
    /**
     * Whether malware scanning is configured for this deployment.
     *
     * Off by default, and separate from the fail-closed policy below on purpose.
     * "No verdict because the scan has not finished" and "no verdict because nothing
     * is scanning" are the same observation from the promotion path, but they demand
     * opposite responses: the first should hold, the second must not, or a deployment
     * without GuardDuty holds every upload forever and looks like a broken uploader.
     * Turned on by the infrastructure that provisions the scanner.
     */
    malwareScanEnabled: bool.default(false),
    /** When scanning is enabled but a verdict is unavailable, hold rather than promote. */
    failClosedOnScanUnavailable: bool.default(true),
  }),

  processing: z.object({
    /**
     * Above either threshold a master rendition is materialized, so cache misses
     * decode a bounded intermediate instead of the full original. See design.md D7.
     */
    masterThresholdBytes: bytes.default(20 * 1024 * 1024),
    masterThresholdLongestEdge: pixels.default(4000),
    masterLongestEdge: pixels.default(4000),
    /** Warm set generated eagerly at upload. Small by default; widen per workload. */
    warmWidths: csvInts.default('1080'),
    warmFormats: csv.pipe(z.array(z.enum(['avif', 'webp', 'jpeg', 'png']))).default('avif'),
    lqipWidth: pixels.max(64).default(24),
    generationTimeoutMs: z.coerce.number().int().positive().default(30_000),
  }),

  /**
   * Lifecycle windows for the scheduled maintenance jobs.
   *
   * Every one of these is a *safety* margin rather than a tuning knob: they exist so
   * a reclamation job cannot delete something that is legitimately in flight. Shorten
   * them and the job starts racing the system it is cleaning up after.
   */
  lifecycle: z.object({
    /**
     * Objects written more recently than this are never treated as orphans.
     *
     * The generator writes a derivative *before* its bookkeeping row exists — the row
     * is best-effort and may lag or never arrive. Without this window, reconciliation
     * running mid-generation would delete a derivative a viewer is about to be served.
     */
    orphanSafetyWindowHours: z.coerce.number().int().positive().default(24),
    /**
     * How long a superseded version's objects survive after the source is replaced.
     *
     * Consumer pages cache HTML referencing the old version's URLs. Reclaiming
     * immediately breaks those pages; this is how long they keep working.
     */
    supersededRetentionDays: z.coerce.number().int().positive().default(30),
    /** Abandoned presigned uploads older than this are reaped. */
    pendingUploadTtlHours: z.coerce.number().int().positive().default(24),
    /** Objects deleted per maintenance run, so one run cannot become unbounded. */
    maxDeletionsPerRun: z.coerce.number().int().positive().default(10_000),
    /**
     * How long an asset may sit in `stored` before its optimization is re-enqueued.
     *
     * A failed enqueue must never fail an upload — the bytes are already durable — so
     * the job is simply lost, and the asset stays servable with no LQIP, no metadata,
     * no warm set, and no path back to `ready`. Nothing else notices.
     *
     * The window has to clear SQS's own retry ceiling (visibility timeout times
     * `maxReceiveCount`), so reconciliation never races a redelivery still in flight.
     * Past that the cost of being wrong is one idempotent invocation.
     */
    stalledOptimizeHours: z.coerce.number().int().positive().default(6),
    /** Re-enqueues per run, so a stalled optimizer cannot become a queue flood. */
    maxReenqueuesPerRun: z.coerce.number().int().positive().default(500),
    /** Set to true to log what would be deleted without deleting it. */
    dryRun: bool.default(false),
  }),

  delivery: z.object({
    /** Custom CDN hostname. Generated URLs never expose the distribution hostname. */
    cdnHost: z.string().min(1),
    /**
     * Bumping this mints a fresh URL space for every asset at once, with no
     * per-asset write and no CDN invalidation. See design.md D8.
     */
    encoderEpoch: z.coerce.number().int().nonnegative().default(1),
    distributionId: z.string().optional(),
    /**
     * Signed-URL delivery for private assets. All three are required together, and
     * their absence disables the feature rather than half-enabling it.
     */
    signedUrlKeyPairId: z.string().optional(),
    /** PEM private key, from the secret store. Never a plain deployment parameter. */
    signedUrlPrivateKey: z.string().optional(),
    signedUrlTtlSeconds: z.coerce.number().int().positive().max(86_400).default(300),
  }),
});

export type AppConfig = z.infer<typeof appConfigSchema>;
export type StorageConfig = AppConfig['storage'];
export type UploadConfig = AppConfig['upload'];
export type ProcessingConfig = AppConfig['processing'];
export type DeliveryConfig = AppConfig['delivery'];
export type LifecycleConfig = AppConfig['lifecycle'];

export class ConfigError extends Error {
  constructor(issues: z.ZodIssue[]) {
    const lines = issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    super(`Invalid configuration:\n${lines.join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** Maps flat environment variables onto the nested schema shape. */
function shape(env: NodeJS.ProcessEnv): unknown {
  return {
    nodeEnv: env['NODE_ENV'],
    logLevel: env['LOG_LEVEL'],
    storage: {
      region: env['AWS_REGION'],
      bucket: env['S3_BUCKET'],
      endpoint: env['S3_ENDPOINT'],
      forcePathStyle: env['S3_FORCE_PATH_STYLE'],
    },
    database: {
      url: env['DATABASE_URL'] ?? composeDatabaseUrl(env),
      maxConnections: env['DATABASE_MAX_CONNECTIONS'],
    },
    queue: {
      optimizeQueueUrl: env['SQS_OPTIMIZE_QUEUE_URL'],
      endpoint: env['SQS_ENDPOINT'],
    },
    upload: {
      proxyThresholdBytes: env['UPLOAD_PROXY_THRESHOLD_BYTES'],
      maxFileBytes: env['UPLOAD_MAX_FILE_BYTES'],
      maxPixels: env['UPLOAD_MAX_PIXELS'],
      presignTtlSeconds: env['UPLOAD_PRESIGN_TTL_SECONDS'],
      acceptedFormats: env['UPLOAD_ACCEPTED_FORMATS'],
      allowSvg: env['UPLOAD_ALLOW_SVG'],
      malwareScanEnabled: env['UPLOAD_MALWARE_SCAN_ENABLED'],
      failClosedOnScanUnavailable: env['UPLOAD_FAIL_CLOSED_ON_SCAN_UNAVAILABLE'],
    },
    lifecycle: {
      orphanSafetyWindowHours: env['ORPHAN_SAFETY_WINDOW_HOURS'],
      supersededRetentionDays: env['SUPERSEDED_RETENTION_DAYS'],
      pendingUploadTtlHours: env['PENDING_UPLOAD_TTL_HOURS'],
      maxDeletionsPerRun: env['MAX_DELETIONS_PER_RUN'],
      stalledOptimizeHours: env['STALLED_OPTIMIZE_HOURS'],
      maxReenqueuesPerRun: env['MAX_REENQUEUES_PER_RUN'],
      dryRun: env['MAINTENANCE_DRY_RUN'],
    },
    processing: {
      masterThresholdBytes: env['MASTER_THRESHOLD_BYTES'],
      masterThresholdLongestEdge: env['MASTER_THRESHOLD_LONGEST_EDGE'],
      masterLongestEdge: env['MASTER_LONGEST_EDGE'],
      warmWidths: env['WARM_WIDTHS'],
      warmFormats: env['WARM_FORMATS'],
      lqipWidth: env['LQIP_WIDTH'],
      generationTimeoutMs: env['GENERATION_TIMEOUT_MS'],
    },
    delivery: {
      cdnHost: env['CDN_HOST'],
      encoderEpoch: env['ENCODER_EPOCH'],
      distributionId: env['CLOUDFRONT_DISTRIBUTION_ID'],
      signedUrlKeyPairId: env['SIGNED_URL_KEY_PAIR_ID'],
      signedUrlPrivateKey: env['SIGNED_URL_PRIVATE_KEY'],
      signedUrlTtlSeconds: env['SIGNED_URL_TTL_SECONDS'],
    },
  };
}

/**
 * Composes a connection URL from discrete parts.
 *
 * Deployed environments cannot supply `DATABASE_URL` directly without putting a
 * password in a task definition or a template. The host, port, user, and database
 * name are not secret and arrive as plain environment variables; only `DB_PASSWORD`
 * comes from the secret store, resolved when the container starts. Locally,
 * `DATABASE_URL` is still the simplest thing and takes precedence.
 *
 * Returns undefined when the set is incomplete, so zod reports the missing key
 * rather than this silently building a URL that cannot connect.
 */
function composeDatabaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  const host = env['DB_HOST'];
  const user = env['DB_USER'];
  const password = env['DB_PASSWORD'];
  const name = env['DB_NAME'];

  if (!host || !user || !password || !name) return undefined;

  const port = env['DB_PORT'] ?? '5432';
  // Encoded: generated passwords routinely contain characters that would otherwise
  // terminate the URL early and produce a baffling connection error.
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${name}`;
}

/** Strips keys whose value is undefined so zod applies defaults rather than failing. */
function prune(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined || v === '') continue;
    out[k] = prune(v);
  }
  return out;
}

/**
 * Validates configuration and fails fast with every problem at once, naming each
 * missing or malformed key. A misconfigured deployment should die at startup, not
 * on the first request that happens to touch the bad value.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = appConfigSchema.safeParse(prune(shape(env)));
  if (!result.success) throw new ConfigError(result.error.issues);
  return result.data;
}
