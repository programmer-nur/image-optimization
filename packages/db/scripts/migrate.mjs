/**
 * Migration entrypoint for the deployed image.
 *
 * The API's container image doubles as the migration image: the ECS one-off task runs
 * this file, and only this file, before a new task definition takes traffic. It
 * exists because the Prisma CLI cannot be invoked directly in that environment for
 * three separate reasons, each of which fails at a different, confusing place.
 *
 * 1. THE URL. The CLI reads `DATABASE_URL` and nothing else, but a deployed task is
 *    given the parts — `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_NAME` as plain
 *    environment values and `DB_PASSWORD` from the secret store — precisely so the
 *    password is not a literal in a task definition or a CloudFormation template. So
 *    the URL is composed here, in the process, and never becomes an environment
 *    variable anyone can read back off the task. This must stay in step with
 *    `composeDatabaseUrl` in packages/config/src/config.ts, including the percent
 *    encoding: generated RDS passwords routinely contain characters that terminate a
 *    URL early, and the resulting failure reads as "wrong password".
 *
 * 2. THE PATHS. `prisma.config.ts` names the schema and migrations relative to
 *    itself, so the CLI must be pointed at it explicitly and cannot rely on the
 *    working directory the container happens to start in.
 *
 * 3. THE EXIT CODE. ECS decides a one-off task succeeded purely from the exit code,
 *    so the child's code is propagated rather than swallowed. A migration that fails
 *    silently is worse than one that fails: the deploy continues onto a schema that
 *    is not there.
 *
 * Deliberately plain ESM with node builtins only. `packages/db` does not depend on
 * `@imgopt/config`, and an import that cannot resolve inside the pruned production
 * image would turn a migration into a module-resolution error.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  console.error(`migration aborted: ${message}`);
  process.exit(1);
}

function databaseUrl() {
  const preset = process.env['DATABASE_URL'];
  if (preset !== undefined && preset !== '') return preset;

  const host = process.env['DB_HOST'];
  const user = process.env['DB_USER'];
  const password = process.env['DB_PASSWORD'];
  const name = process.env['DB_NAME'];
  const port = process.env['DB_PORT'] ?? '5432';

  const missing = [
    ['DB_HOST', host],
    ['DB_USER', user],
    ['DB_PASSWORD', password],
    ['DB_NAME', name],
  ]
    .filter(([, value]) => value === undefined || value === '')
    .map(([key]) => key);

  if (missing.length > 0) {
    fail(
      `set DATABASE_URL, or all of DB_HOST, DB_USER, DB_PASSWORD and DB_NAME ` +
        `(missing: ${missing.join(', ')}).`,
    );
  }

  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${name}`;
}

const cli = join(packageRoot, 'node_modules', 'prisma', 'build', 'index.js');
const config = join(packageRoot, 'prisma.config.ts');

// Checked rather than assumed: both are here only because the image copies them and
// because `prisma` is a production dependency. Either can be lost by an edit to the
// Dockerfile or to package.json, and the resulting CLI error names neither cause.
if (!existsSync(cli)) {
  fail(
    `the Prisma CLI is not in this image (${cli}). It must be a production ` +
      'dependency of @imgopt/db — `--prod` prunes devDependencies.',
  );
}
if (!existsSync(config)) {
  fail(`${config} is missing. The image must copy packages/db/prisma.config.ts and prisma/.`);
}

const result = spawnSync(process.execPath, [cli, 'migrate', 'deploy', '--config', config], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: databaseUrl() },
});

if (result.error !== undefined) fail(String(result.error));
process.exit(result.status ?? 1);
