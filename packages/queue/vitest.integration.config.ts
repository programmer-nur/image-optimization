import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

/** Integration specs only. Requires the local stack: `pnpm dev:up`. */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['src/**/*.integration.test.ts'],
    exclude: ['**/node_modules/**'],
  },
});
