import { build } from 'esbuild';

// Bundles the handler for the arm64 Lambda runtime. No `sharp` here: maintenance
// moves and deletes objects, and never decodes one — so it needs no native binary
// and no layer.
//
// `.mjs`, not `.js`: the output is ESM and a deployed function has no package.json
// above it, so a bare `.js` is read as CommonJS and fails at init on its own first
// `import`. See apps/generator/esbuild.mjs for the full note.
await build({
  entryPoints: ['src/handler.ts'],
  outfile: 'dist-bundle/index.mjs',
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

console.log('maintenance bundled -> dist-bundle/index.mjs');
