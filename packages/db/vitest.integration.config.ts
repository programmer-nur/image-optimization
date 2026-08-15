import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

/** Integration specs only. Requires `pnpm dev:up` plus applied migrations. */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['src/**/*.integration.test.ts'],
    exclude: ['**/node_modules/**', '**/generated/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Shared database rows; parallel files would interfere.
    fileParallelism: false,
  },
});
