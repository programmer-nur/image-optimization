import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  loadConfig,
  requireDatabaseUrl,
  requireWorkerCallbackUrl,
  requireWorkerSecret,
} from './config.js';

const minimal: NodeJS.ProcessEnv = {
  AWS_REGION: 'us-east-1',
  S3_BUCKET: 'imgopt-test',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  SQS_OPTIMIZE_QUEUE_URL: 'http://localhost:9324/q/imgopt-optimize',
  CDN_HOST: 'cdn.example.com',
};

describe('loadConfig', () => {
  it('applies defaults when only required values are supplied', () => {
    const cfg = loadConfig(minimal);

    expect(cfg.nodeEnv).toBe('development');
    expect(cfg.upload.maxFileBytes).toBe(100 * 1024 * 1024);
    expect(cfg.upload.acceptedFormats).toEqual(['jpeg', 'png', 'webp', 'avif']);
    expect(cfg.processing.warmWidths).toEqual([1080]);
    expect(cfg.processing.warmFormats).toEqual(['avif']);
    expect(cfg.delivery.encoderEpoch).toBe(1);
  });

  it('rejects SVG by default', () => {
    expect(loadConfig(minimal).upload.allowSvg).toBe(false);
  });

  it('fails closed on an unavailable malware verdict by default', () => {
    expect(loadConfig(minimal).upload.failClosedOnScanUnavailable).toBe(true);
  });

  it('parses comma-separated lists into typed arrays', () => {
    const cfg = loadConfig({
      ...minimal,
      WARM_WIDTHS: '640, 1080 ,1920',
      WARM_FORMATS: 'avif,webp',
    });

    expect(cfg.processing.warmWidths).toEqual([640, 1080, 1920]);
    expect(cfg.processing.warmFormats).toEqual(['avif', 'webp']);
  });

  it('coerces numeric and boolean environment strings', () => {
    const cfg = loadConfig({ ...minimal, ENCODER_EPOCH: '7', S3_FORCE_PATH_STYLE: 'true' });

    expect(cfg.delivery.encoderEpoch).toBe(7);
    expect(cfg.storage.forcePathStyle).toBe(true);
  });

  /*
   * `"false"` must mean false.
   *
   * Zod's `coerce.boolean()` is `Boolean(value)`, and every environment variable is a
   * string — so it read `"false"` as **true**. The CDK writes these values literally,
   * which made the consequences concrete rather than theoretical: a deployment with
   * scanning switched off announced `UPLOAD_MALWARE_SCAN_ENABLED=false`, the app read
   * it as enabled, and fail-closed then held every upload forever waiting on a
   * scanner that did not exist. `MAINTENANCE_DRY_RUN=false` likewise produced a
   * reclamation job that never deleted anything.
   */
  it('reads a boolean by its spelling, not by truthiness', () => {
    for (const [value, expected] of [
      ['false', false],
      ['FALSE', false],
      ['0', false],
      ['no', false],
      ['off', false],
      ['true', true],
      ['1', true],
      ['yes', true],
      [' true ', true],
    ] as const) {
      const cfg = loadConfig({
        ...minimal,
        UPLOAD_MALWARE_SCAN_ENABLED: value,
        MAINTENANCE_DRY_RUN: value,
      });

      expect(cfg.upload.malwareScanEnabled, value).toBe(expected);
      expect(cfg.lifecycle.dryRun, value).toBe(expected);
    }
  });

  it('refuses a boolean spelling it does not recognize', () => {
    // A typo in the flag that decides whether uploads are held should stop the
    // process, not silently resolve to whichever side happens to be truthy.
    expect(() => loadConfig({ ...minimal, MAINTENANCE_DRY_RUN: 'ture' })).toThrow(ConfigError);
  });

  it('refuses to boot with SVG support requested', () => {
    // The flag does not enable SVG — it enables a 422 that blames the uploader for an
    // operator's setting. Refusing at startup puts the message where the decision was.
    expect(() => loadConfig({ ...minimal, UPLOAD_ALLOW_SVG: 'true' })).toThrow(ConfigError);
    // And an explicit `false` is still a perfectly ordinary thing to write down.
    expect(loadConfig({ ...minimal, UPLOAD_ALLOW_SVG: 'false' }).upload.allowSvg).toBe(false);
  });

  it('treats an empty string as absent so the default applies', () => {
    expect(loadConfig({ ...minimal, LOG_LEVEL: '' }).logLevel).toBe('info');
  });

  it('names every missing key at once rather than failing on the first', () => {
    const { S3_BUCKET: _b, CDN_HOST: _c, ...partial } = minimal;

    let error: unknown;
    try {
      loadConfig(partial);
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain('storage.bucket');
    expect((error as Error).message).toContain('delivery.cdnHost');
  });

  it('rejects a malformed numeric value by naming the key', () => {
    expect(() => loadConfig({ ...minimal, ENCODER_EPOCH: 'not-a-number' })).toThrow(
      /delivery\.encoderEpoch/,
    );
  });

  it('rejects an unsupported accepted-format entry', () => {
    expect(() => loadConfig({ ...minimal, UPLOAD_ACCEPTED_FORMATS: 'jpeg,bmp' })).toThrow(
      ConfigError,
    );
  });
});

/*
 * `DB_HOST`/`DB_USER`/`DB_PASSWORD`/`DB_NAME` no longer compose a URL.
 *
 * That path existed for one reason: ECS could inject a Secrets Manager value into a
 * container's environment and Lambda could not, so the functions were handed the
 * parts and the password separately. There is no ECS task definition and no Lambda
 * with a database connection any more (design.md L5), so the application reads
 * `DATABASE_URL` and nothing else — which is also the whole of the Lightsail → RDS
 * migration on the application side.
 */
describe('the database is configured by one variable', () => {
  it('requires DATABASE_URL where a database is needed', () => {
    const config = loadConfig({ ...minimal, DATABASE_URL: undefined });

    expect(config.database.url).toBeUndefined();
    expect(() => requireDatabaseUrl(config, 'The control plane')).toThrow(/DATABASE_URL/);
  });

  it('names who was asking', () => {
    // Three different processes can produce this error, and the one thing worth
    // knowing is which of them was starting.
    const config = loadConfig({ ...minimal, DATABASE_URL: undefined });

    expect(() => requireDatabaseUrl(config, 'The maintenance job')).toThrow(/The maintenance job/);
  });

  it('ignores the discrete parts entirely', () => {
    // They used to compose a URL. Leaving that behaviour in place would mean a stale
    // deployment silently connecting somewhere while looking unconfigured.
    const config = loadConfig({
      ...minimal,
      DATABASE_URL: undefined,
      DB_HOST: 'db.internal',
      DB_USER: 'imgopt',
      DB_PASSWORD: 'secret',
      DB_NAME: 'imgopt',
    });

    expect(config.database.url).toBeUndefined();
  });

  it('passes a supplied URL through untouched', () => {
    const url =
      'postgresql://imgopt:secret@ls-abc.region.rds.amazonaws.com:5432/imgopt?sslmode=require';
    expect(loadConfig({ ...minimal, DATABASE_URL: url }).database.url).toBe(url);
  });
});

describe('the worker channel', () => {
  it('refuses to hand out a missing secret', () => {
    // Serving the internal prefix unauthenticated is worse than not starting.
    const config = loadConfig(minimal);
    expect(() => requireWorkerSecret(config, 'The control plane')).toThrow(
      /WORKER_CALLBACK_SECRET/,
    );
  });

  it('strips a trailing slash from the callback URL', () => {
    // Every caller appends an absolute path; a doubled slash is a 404 that reads like
    // an authentication failure.
    const config = loadConfig({
      ...minimal,
      WORKER_CALLBACK_URL: 'https://api.example.com/',
      WORKER_CALLBACK_SECRET: 'shhh',
    });

    expect(requireWorkerCallbackUrl(config, 'The optimizer')).toBe('https://api.example.com');
  });
});
