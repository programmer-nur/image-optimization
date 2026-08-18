import { build } from 'esbuild';
import { sharpFromLayer } from '../../scripts/esbuild-sharp-layer.mjs';

// Bundles the handler for the arm64 Lambda runtime. `sharp` is not bundled: its
// native binaries ship in a Lambda layer built for linux-arm64 (see infra/cdk,
// group 9), so bundling the host's binary would ship the wrong architecture.
//
// `.mjs`, not `.js`: the output is ESM and a deployed function has no package.json
// above it, so a bare `.js` is read as CommonJS and fails at init on its own first
// `import`. The plugin is what makes the layer reachable from an ESM bundle at all —
// see scripts/esbuild-sharp-layer.mjs, which explains both halves.
await build({
  entryPoints: ['src/handler.ts'],
  outfile: 'dist-bundle/index.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: true,
  sourcemap: true,
  plugins: [sharpFromLayer],
  // ESM interop for CJS-only AWS SDK internals when bundled.
  banner: {
    js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
  },
});

console.log('optimizer bundled -> dist-bundle/index.mjs (sharp from the layer)');
