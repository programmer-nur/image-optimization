import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-bundle/**',
      '**/coverage/**',
      '**/cdk.out/**',
      // Next.js build output and its generated ambient types.
      '**/.next/**',
      '**/next-env.d.ts',
      // Emitted from packages/core by the codegen step; see task 8.1.
      'infra/cloudfront/normalize.generated.js',
      // Emitted by `prisma generate`.
      'packages/db/src/generated/**',
    ],
  },
  js.configs.recommended,
  // Node build scripts (esbuild bundlers, config files) run outside the typed
  // project and need Node globals like `console` and `process`.
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: { globals: globals.node },
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Root-level config files sit outside every package tsconfig.
          allowDefaultProject: ['*.mjs', '*.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // The transform pipeline leans on exhaustiveness switches. A `default` clause
      // counts as exhaustive: several of these map an optional domain union onto a
      // library vocabulary, where the default *is* the documented fallback.
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true },
      ],
    },
  },
  /*
   * The unscoped registry is opt-in, per directory.
   *
   * `UnscopedAssetRepository` reads and writes across every tenant in the deployment.
   * That is correct for reclamation, which walks the whole bucket by nature, and for
   * the two workers, which act on a job or a key they were handed rather than on
   * behalf of a caller. It is wrong anywhere a request is being served, and the
   * difference is one import that reviews cleanly on its own.
   *
   * Denied everywhere by default and re-enabled below for the three apps that need
   * it, so adding a fourth is a visible edit to this file rather than an import
   * nobody looked twice at. The control plane never appears in that list: it injects
   * `TenantScopedRepository`, whose methods do not compile without a scope.
   */
  {
    files: ['**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@imgopt/db',
              importNames: ['UnscopedAssetRepository', 'addVersionInTransaction'],
              message:
                'Reads and writes across every tenant. Request paths use TenantScopedRepository, whose methods require a TenantScope. If this really is deployment-wide work, add the directory to the allowlist in eslint.config.mjs.',
            },
          ],
        },
      ],
    },
  },
  {
    /*
     * The allowlist.
     *
     * `apps/maintenance` walks the whole registry by nature. `packages/db` defines the
     * class. `apps/api/src/modules/internal` is the narrow exception: the workers no
     * longer hold a database connection, so the control plane records their results on
     * their behalf — and that work has no tenant to be scoped to, because a worker acts
     * on an asset a queue message named rather than on behalf of a caller.
     *
     * Note the path, not the app. Everything else under `apps/api` is still denied, so
     * an unscoped read cannot drift into a request-serving route.
     */
    files: [
      'apps/maintenance/**/*.ts',
      'apps/api/src/modules/internal/**/*.ts',
      'packages/db/**/*.ts',
      // Stands in for the control plane so the optimizer's integration suite can run
      // its real logic against a real database. Excluded from the build, and never
      // bundled — the deployed worker's lack of a database driver is asserted against
      // the artifact rather than inferred from this directory's name.
      'apps/optimizer/src/test-support/**/*.ts',
    ],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: ['**/*.test.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // Config files are plain JS with untyped imports; typed rules have nothing to
    // work with and only produce noise about the linter's own configuration.
    files: ['**/*.mjs', '**/*.js', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // The CloudFront Function template is a bare script for a restricted runtime:
    // no module system, and `handler` is called by name from global scope rather
    // than by anything in the file.
    files: ['infra/cloudfront/normalize.template.js'],
    languageOptions: { sourceType: 'script' },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^handler$' }],
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  prettier,
);
