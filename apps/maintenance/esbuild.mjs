import { build } from 'esbuild';

// Bundles the reclamation CLI into one self-contained file.
//
// Not a Lambda any more: reclamation holds the only remaining direct database
// connection and runs beside the database on the control-plane host (design.md L2).
// It is bundled rather than run from source so the API image can carry it as a single
// COPY — the Dockerfile's workspace dependency list is hand-maintained, and a bundle
// has nothing to add to it.
//
// No `sharp`: maintenance moves and deletes objects and never decodes one, so it needs
// no native binary and no layer.
//
// `.mjs`, not `.js`: the output is ESM and there is no package.json beside it in the
// image, so a bare `.js` would be read as CommonJS and fail on its own first `import`.
await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist-bundle/maintenance.mjs',
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

console.log('maintenance bundled -> dist-bundle/maintenance.mjs');
