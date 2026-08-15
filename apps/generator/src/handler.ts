/**
 * Lambda Function URL entry point.
 *
 * `sharp-init` is imported first so libvips concurrency and caching are configured
 * during init, before any image work. Clients are constructed once at module scope
 * and reused across warm invocations — on this path that matters, because the whole
 * point of a miss is that it happens rarely and must still be fast.
 *
 * The Function URL is `AWS_IAM`-authenticated and fronted by OAC, so it is not
 * independently reachable from the internet; CloudFront is its only caller.
 */

import './sharp-init.js';
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import pino from 'pino';
import { loadConfig } from '@imgopt/config';
import { S3Storage } from '@imgopt/storage';
import {
  AssetRepository,
  DerivativeOrigin,
  createPrismaClient,
  hydrateDatabaseCredentials,
} from '@imgopt/db';
import { Generator, type RecordDerivative } from './generator.js';

// Resolves the database password from Secrets Manager before configuration is read.
// Runs during init — free time on a managed runtime — and is a no-op locally, where
// the password is already in the environment. A Lambda environment variable is
// plaintext in the console and the template, so the function is given the secret's
// ARN instead of its value.
await hydrateDatabaseCredentials();

const config = loadConfig();

const baseLogger = pino({ level: config.logLevel, base: { component: 'generator' } });

const storage = new S3Storage({
  bucket: config.storage.bucket,
  region: config.storage.region,
  ...(config.storage.endpoint !== undefined ? { endpoint: config.storage.endpoint } : {}),
  forcePathStyle: config.storage.forcePathStyle,
});

// Bookkeeping only — for cost attribution, orphan GC, and answering "what did we
// actually generate". Never read by the delivery path, and constructed lazily so a
// database that is slow or down costs nothing until the first miss.
let repo: AssetRepository | undefined;

const recordDerivative: RecordDerivative = async (record) => {
  repo ??= new AssetRepository(
    createPrismaClient({ connectionString: config.database.url, context: 'lambda' }),
  );

  return repo.recordDerivative({ ...record, generatedBy: DerivativeOrigin.ondemand });
};

const generator = new Generator(storage, config, baseLogger, recordDerivative);

export async function handler(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  // CloudFront retries the *rewritten* path against this origin, so rawPath is
  // already the canonical derivative key.
  const path = event.rawPath;
  const result = await generator.generate(path);

  if (result.body !== undefined) {
    return {
      statusCode: result.status,
      headers: result.headers,
      // Function URLs deliver binary only as base64; the runtime decodes it before
      // it reaches CloudFront.
      body: result.body.toString('base64'),
      isBase64Encoded: true,
    };
  }

  return {
    statusCode: result.status,
    headers: result.headers,
    body: JSON.stringify({ error: result.error }),
    isBase64Encoded: false,
  };
}
