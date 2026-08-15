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
