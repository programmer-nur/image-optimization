import { build } from 'esbuild';

// Bundles the handler for the arm64 Lambda runtime. `sharp` is marked external:
// its native binaries ship in a Lambda layer built for linux-arm64 (see infra/cdk,
// group 9), so bundling the host's binary would ship the wrong architecture.
await build({
  entryPoints: ['src/handler.ts'],
  outfile: 'dist-bundle/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: true,
  sourcemap: true,
  external: ['sharp'],
  // ESM interop for CJS-only AWS SDK internals when bundled.
  banner: {
    js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
  },
});

console.log('optimizer bundled -> dist-bundle/index.js (sharp external)');
