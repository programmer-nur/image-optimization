import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

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

describe('database credentials from discrete parts', () => {
  const parts: NodeJS.ProcessEnv = {
    AWS_REGION: 'us-east-1',
    S3_BUCKET: 'imgopt-test',
    SQS_OPTIMIZE_QUEUE_URL: 'http://localhost:9324/q/imgopt-optimize',
    CDN_HOST: 'cdn.example.com',
    DB_HOST: 'db.internal',
    DB_USER: 'imgopt',
    DB_PASSWORD: 'secret',
    DB_NAME: 'imgopt',
  };

  it('composes a URL when no DATABASE_URL is supplied', () => {
    // How a deployed container gets its credentials: the parts are plain
    // environment, and only the password comes from the secret store at runtime.
    expect(loadConfig(parts).database.url).toBe(
      'postgresql://imgopt:secret@db.internal:5432/imgopt',
    );
  });

  it('honours an explicit port', () => {
    expect(loadConfig({ ...parts, DB_PORT: '6543' }).database.url).toBe(
      'postgresql://imgopt:secret@db.internal:6543/imgopt',
    );
  });

  it('encodes credentials that would otherwise break the URL', () => {
    // Generated passwords routinely contain these. Unencoded, the URL terminates
    // early and produces a connection error that points nowhere useful.
    const cfg = loadConfig({ ...parts, DB_PASSWORD: 'p@ss:w/rd?' });
    expect(cfg.database.url).toBe('postgresql://imgopt:p%40ss%3Aw%2Frd%3F@db.internal:5432/imgopt');
  });

  it('prefers an explicit DATABASE_URL', () => {
    const cfg = loadConfig({ ...parts, DATABASE_URL: 'postgres://u:p@localhost:5432/db' });
    expect(cfg.database.url).toBe('postgres://u:p@localhost:5432/db');
  });

  it('fails naming the key when the set is incomplete', () => {
    const { DB_PASSWORD: _omitted, ...incomplete } = parts;
    // Better than composing a URL that cannot connect and failing on first query.
    expect(() => loadConfig(incomplete)).toThrow(ConfigError);
  });
});
