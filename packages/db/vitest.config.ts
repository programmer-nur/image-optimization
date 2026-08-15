import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The registry is meaningfully tested only against a real database.
    passWithNoTests: true,
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/generated/**', '**/*.integration.test.ts'],
  },
});
