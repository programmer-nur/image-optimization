/**
 * esbuild plugin: resolve `sharp` from the Lambda layer at runtime.
 *
 * The native binaries are not bundled — they must be built for linux/arm64, and a
 * binary resolved on whoever ran the deploy is the classic way to ship a Lambda that
 * deploys cleanly and then throws `Could not load the "sharp" module using the
 * linux-arm64 runtime` on its first real request. They ship in a layer instead, which
 * Lambda unpacks to `/opt/nodejs/node_modules` (see infra/cdk/scripts/build-sharp-layer.sh).
 *
 * WHY A PLUGIN AND NOT `external: ['sharp']`.
 *
 * Lambda publishes a layer's modules by putting that directory on `NODE_PATH` — and
 * `NODE_PATH` is a CommonJS mechanism that Node's ESM resolver does not consult at
 * all. These bundles are ESM (`.mjs`, because a bare `.js` with no package.json above
 * it is read as CommonJS and fails on its own first `import`). esbuild leaves an
 * external dependency as a literal `import sharp from 'sharp'`, so the deployed
 * function fails at init with ERR_MODULE_NOT_FOUND — every invocation, with the layer
 * attached and the infrastructure entirely correct.
 *
 * Verified rather than assumed, on Node 22: with `NODE_PATH` pointing at a directory,
 * `require('pkg')` resolves and `import 'pkg'` does not, while
 * `createRequire(import.meta.url)('pkg')` does. That last form is what this plugin
 * substitutes for the import.
 *
 * Safe for the whole call graph: every runtime import of sharp is a default import
 * (packages/core/src/pipeline/render.ts, metadata.ts, apps/*_/src/sharp-init.ts) and
 * the only named imports are types, which esbuild erases.
 */
export const sharpFromLayer = {
  name: 'sharp-from-layer',
  setup(build) {
    build.onResolve({ filter: /^sharp$/ }, () => ({ path: 'sharp', namespace: 'sharp-layer' }));

    build.onLoad({ filter: /.*/, namespace: 'sharp-layer' }, () => ({
      contents: [
        "import { createRequire } from 'node:module';",
        "const sharp = createRequire(import.meta.url)('sharp');",
        'export default sharp;',
      ].join('\n'),
      loader: 'js',
    }));
  },
};
