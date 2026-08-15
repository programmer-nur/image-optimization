import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

/** Boots the real app against MinIO, Postgres, and ElasticMQ. Needs `pnpm dev:up`. */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['src/**/*.integration.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
