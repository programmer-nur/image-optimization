import { defineConfig, env } from 'prisma/config';

/**
 * Prisma CLI configuration.
 *
 * In Prisma 7 the connection URL lives here rather than in the schema's datasource
 * block. This file configures the *CLI* — migrate, generate, studio. The runtime
 * client gets its connection through a driver adapter instead (see `client.ts`).
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
