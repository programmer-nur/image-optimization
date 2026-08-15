/**
 * Build-artifact locations, resolved with a real existence check.
 *
 * CDK will happily package a missing or empty directory and deploy a function that
 * fails on its first invocation, so each path is verified here and the error names
 * the command that produces it. A deploy that is going to fail should fail at synth,
 * on the developer's machine, not in a viewer's browser.
 */

import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');

function requireArtifact(path: string, produce: string): string {
  if (!existsSync(path) || readdirSync(path).length === 0) {
    throw new Error(
      `Missing build artifact at ${path}.\nRun: ${produce}\n` +
        'See infra/cdk/README.md for the full release order.',
    );
  }
  return path;
}

/** esbuild output for the SQS worker. Plain JS — `sharp` is external. */
export function optimizerBundle(): string {
  return requireArtifact(
    join(repoRoot, 'apps', 'optimizer', 'dist-bundle'),
    'pnpm --filter @imgopt/infra build:bundles',
  );
}

/** esbuild output for the on-miss generator. Plain JS — `sharp` is external. */
export function generatorBundle(): string {
  return requireArtifact(
    join(repoRoot, 'apps', 'generator', 'dist-bundle'),
    'pnpm --filter @imgopt/infra build:bundles',
  );
}

/**
 * The one artifact containing native code, built in a linux/arm64 container.
 *
 * Kept out of the function bundles on purpose: a sharp binary resolved on whoever
 * ran the deploy is the classic way to ship a Lambda that deploys cleanly and then
 * throws `Could not load the "sharp" module using the linux-arm64 runtime` on its
 * first real request.
 */
export function sharpLayer(): string {
  return requireArtifact(
    join(here, '..', 'layers', 'sharp'),
    'pnpm --filter @imgopt/infra build:layer',
  );
}

/** esbuild output for the scheduled maintenance worker. No native code at all. */
export function maintenanceBundle(): string {
  return requireArtifact(
    join(repoRoot, 'apps', 'maintenance', 'dist-bundle'),
    'pnpm --filter @imgopt/infra build:bundles',
  );
}

/** The generated CloudFront Function. Never hand-edited; see infra/cloudfront. */
export function edgeFunctionPath(): string {
  const path = join(repoRoot, 'infra', 'cloudfront', 'normalize.generated.js');
  if (!existsSync(path)) {
    throw new Error(`Missing ${path}.\nRun: pnpm --filter @imgopt/edge generate`);
  }
  return path;
}
