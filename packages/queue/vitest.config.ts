import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // These adapters are meaningfully tested only against a real service, so the
    // unit run legitimately has nothing to execute.
    passWithNoTests: true,
    include: ['src/**/*.test.ts'],
    // Integration specs need `pnpm dev:up`; they run under test:integration.
    exclude: ['**/node_modules/**', '**/*.integration.test.ts'],
    // Redrive and visibility-timeout tests wait on real queue timers.
    testTimeout: 40_000,
    hookTimeout: 40_000,
    // Shared queue state: parallel files would consume each other's messages.
    fileParallelism: false,
  },
});
