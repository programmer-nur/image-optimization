import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Synthesis walks the whole construct tree and reads every asset.
    testTimeout: 60_000,
  },
});
