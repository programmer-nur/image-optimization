import { build } from 'esbuild';

// Bundles the handler for the arm64 Lambda runtime. No `sharp` here: maintenance
// moves and deletes objects, and never decodes one — so it needs no native binary
// and no layer.
await build({
  entryPoints: ['src/handler.ts'],
  outfile: 'dist-bundle/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: true,
  sourcemap: true,
  // ESM interop for CJS-only AWS SDK internals when bundled.
  banner: {
    js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
  },
});

console.log('maintenance bundled -> dist-bundle/index.js');
