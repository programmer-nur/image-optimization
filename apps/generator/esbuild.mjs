import { build } from 'esbuild';
import { sharpFromLayer } from '../../scripts/esbuild-sharp-layer.mjs';

// Bundles the handler for the arm64 Lambda runtime. `sharp` is not bundled: its
// native binaries ship in a Lambda layer built for linux-arm64 (see infra/cdk,
// group 9), so bundling the host's binary would ship the wrong architecture.
//
// The `.mjs` extension is load-bearing. The output is ESM, and a deployed function
// has no package.json above it — so a bare `.js` is read as CommonJS and the very
// first line, an `import`, throws `Cannot use import statement outside a module`
// during init. Every invocation fails, before any of this code runs. The Node
// runtime resolves `index.mjs` for the handler string `index.handler`, so the
// extension is the whole fix — for that error. See the plugin for the one it
// uncovers.
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

console.log('generator bundled -> dist-bundle/index.mjs (sharp from the layer)');
