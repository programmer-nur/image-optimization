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
import { loadConfig, requireWorkerCallbackUrl, requireWorkerSecret } from '@imgopt/config';
import { S3Storage } from '@imgopt/storage';
/*
 * Not imported from `@imgopt/db`.
 *
 * A value import from that package pulls `PrismaClient` into this bundle, and this
 * function holds no database connection (design.md L2). The literal is what the
 * control plane validates against its own enum on arrival.
 */
const ONDEMAND = 'ondemand';
import { Generator, type RecordDerivative } from './generator.js';

/*
 * No database connection, and none to resolve.
 *
 * This function is on the viewer's critical path and its bookkeeping has always been
 * best-effort — `generator.ts` swallows a failure here by design. Moving it from a
 * Postgres write to an HTTP POST changes nothing about that, and it is what lets the
 * function run outside a VPC (design.md L1/L2).
 */
const config = loadConfig();

const baseLogger = pino({ level: config.logLevel, base: { component: 'generator' } });

const storage = new S3Storage({
  bucket: config.storage.bucket,
  region: config.storage.region,
  ...(config.storage.endpoint !== undefined ? { endpoint: config.storage.endpoint } : {}),
  forcePathStyle: config.storage.forcePathStyle,
});

/*
 * Bookkeeping only — cost attribution, orphan GC, and answering "what did we actually
 * generate". Never read by the delivery path.
 *
 * The timeout is short and deliberate. A control plane that accepts the connection and
 * then stalls would otherwise hold a viewer's request open for as long as it takes to
 * hit the function's own timeout, turning a missing database row into a slow image.
 * The row is optional; the image is not.
 */
const callbackUrl = requireWorkerCallbackUrl(config, 'The generator');
const workerSecret = requireWorkerSecret(config, 'The generator');

const recordDerivative: RecordDerivative = async (record) => {
  const response = await fetch(`${callbackUrl}/internal/v1/derivatives`, {
    method: 'POST',
    signal: AbortSignal.timeout(config.worker.callbackTimeoutMs),
    headers: {
      'content-type': 'application/json',
      'x-imgopt-worker-secret': workerSecret,
    },
    body: JSON.stringify({ ...record, generatedBy: ONDEMAND }),
  });

  // Thrown, not returned: `generator.ts` owns the decision to swallow it, and it logs
  // the reason. Returning quietly here would move that decision somewhere invisible.
  if (!response.ok) {
    throw new Error(`derivative bookkeeping returned ${response.status}`);
  }
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
