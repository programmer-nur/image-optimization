import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  test: {
    globals: false,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
  },
  plugins: [
    // NestJS DI resolves class dependencies through `emitDecoratorMetadata`, which
    // esbuild (vitest's default transform) does not emit. SWC does, so the app
    // bootstraps under test exactly as it does under `tsc` in production. Token
    // injections still use explicit `@Inject`, so this only backs the class deps.
    swc.vite({
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: 'es2022',
      },
    }),
  ],
});
