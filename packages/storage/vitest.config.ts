import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // These adapters are meaningfully tested only against a real service, so the
    // unit run legitimately has nothing to execute.
    passWithNoTests: true,
    include: ['src/**/*.test.ts'],
    // Integration specs need `pnpm dev:up`; they run under test:integration.
    exclude: ['**/node_modules/**', '**/*.integration.test.ts'],
    // Integration tests talk to MinIO over the network and do real multipart
    // uploads; the default 5s timeout is too tight for the 5MB part.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
