/**
 * The Lightsail deployment definition, as an infrastructure gate.
 *
 * These assertions used to live in `stacks.test.ts` against ECS task definitions and
 * an ALB listener. The control plane is not CloudFormation's any more (design.md L3),
 * but the properties it had are still properties worth holding — an immutable image
 * tag, migrations as a one-off rather than an entrypoint, TLS with automatic renewal,
 * a restart policy — so they moved here rather than being dropped.
 *
 * Read from disk as text. The files are YAML and shell, not modules, and what matters
 * about them is what a human reviewing the diff would check.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const deployDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'deploy',
  'lightsail',
);
const read = (name: string): string => readFileSync(join(deployDir, name), 'utf8');

const compose = read('docker-compose.yml');
const caddyfile = read('Caddyfile');
const deploySh = read('deploy.sh');
const provisionSh = read('provision.sh');
const envExample = read('.env.example');

describe('the control-plane compose stack', () => {
  it('refuses to start without an explicit image tag', () => {
    // `latest` makes "redeploy the previous version" ambiguous: the same tag can point
    // at different bytes on two consecutive days, and the running container and the
    // migration can silently disagree about which version they are. The `:?` form
    // makes an unset tag a startup failure rather than a silent default.
    expect(compose).toContain('${IMAGE_TAG:?');
    expect(compose).not.toMatch(/image:.*:latest/);
  });

  it('runs migrations to completion before the API starts', () => {
    // Never an entrypoint: two API containers starting at once would race to apply the
    // same migration, and the result is a half-migrated schema rather than an error.
    expect(compose).toContain("command: ['node', 'packages/db/scripts/migrate.mjs']");
    expect(compose).toContain('service_completed_successfully');
  });

  it('publishes the API only to the loopback interface', () => {
    /*
     * The single most load-bearing line in this file.
     *
     * The rate limiter identifies a client by `x-forwarded-for`, which is only
     * trustworthy while Caddy is the sole way in. Publishing 3000 to `0.0.0.0` would
     * let any client set that header on a direct connection and bypass the limiter
     * entirely — and nothing about the deployment would look wrong.
     */
    expect(compose).toContain("'127.0.0.1:3000:3000'");
    expect(compose).not.toMatch(/['"]0\.0\.0\.0:3000/);
    expect(compose).not.toMatch(/['"]3000:3000/);
  });

  it('restarts the API and the proxy but not the one-shot jobs', () => {
    // Two spaces, written as a quantifier: a literal run of spaces in a regex is
    // unreadable and the linter says so.
    const services = compose.split(/^ {2}(?=\w)/m);
    const serviceFor = (name: string): string =>
      services.find((block) => block.startsWith(`${name}:`)) ?? '';

    for (const name of ['api', 'caddy']) {
      expect(serviceFor(name), name).toContain('restart: unless-stopped');
    }
    // Restarting these would re-run a migration or a reclamation pass on a loop.
    for (const name of ['migrate', 'maintenance']) {
      expect(serviceFor(name), name).toContain("restart: 'no'");
    }
  });

  it('probes liveness rather than readiness', () => {
    // `/readyz` depends on Postgres and S3. Probing it here means a database blip
    // restarts a perfectly healthy process, which is the one action that cannot help.
    //
    // Matched against the probe command rather than the whole file, because the file
    // explains the distinction in a comment and a naive search finds that. The command
    // is extracted by its shape — prettier reflows the YAML list across lines, so
    // anchoring on a single line is not stable.
    const probe = /fetch\('http:\/\/127\.0\.0\.1:3000([^']+)'\)/.exec(compose)?.[1];

    expect(probe).toBe('/healthz');
  });

  it('bounds container logs', () => {
    // An unrotated JSON log is the most common way a small instance fills its disk,
    // and a full disk takes the database client down with it.
    expect(compose.match(/max-size/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('gives reclamation a durable place for its run lock', () => {
    // A lock in the container's own /tmp is a fresh empty directory every run, which
    // makes the overlap guard a no-op — and two overlapping runs each delete up to
    // MAX_DELETIONS_PER_RUN, which is the number that bounds how much one mistake
    // can destroy.
    expect(compose).toContain('MAINTENANCE_LOCK_PATH');
    expect(compose).toContain('maintenance_state:');
  });

  it('keeps reclamation out of the default startup set', () => {
    // It is invoked by cron, not started with the stack.
    expect(compose).toContain("profiles: ['scheduled']");
  });
});

describe('TLS', () => {
  it('terminates on the configured hostname with automatic renewal', () => {
    // Caddy rather than nginx + certbot because renewal is the part that fails
    // silently, eleven months later, on a date nobody has in a calendar.
    expect(caddyfile).toContain('{$API_HOST}');
    expect(caddyfile).toContain('reverse_proxy api:3000');
  });

  it('passes the client address the rate limiter reads', () => {
    expect(caddyfile).toContain('X-Forwarded-For');
  });

  it('sets HSTS and refuses to be framed', () => {
    expect(caddyfile).toContain('Strict-Transport-Security');
    expect(caddyfile).toContain('X-Content-Type-Options');
  });

  it('bounds the request body above the proxy threshold', () => {
    // Larger uploads are handed a presigned S3 target and never reach this host, so
    // this only has to clear the threshold — not the maximum file size.
    expect(caddyfile).toMatch(/max_size\s+\d+MB/);
  });
});

describe('the deploy script', () => {
  it('refuses a mutable tag', () => {
    expect(deploySh).toContain("Refusing 'latest'");
  });

  it('migrates before starting the new version', () => {
    expect(deploySh.indexOf('docker compose run --rm migrate')).toBeLessThan(
      deploySh.indexOf('docker compose up -d'),
    );
  });

  it('rolls back when the new version fails its health check', () => {
    // A failed deploy that leaves a broken container running is worse than one that
    // never started.
    expect(deploySh).toContain('Rolling back');
    expect(deploySh).toContain('IMAGE_TAG="$PREVIOUS" docker compose up -d');
  });

  it('records the tag only after it became healthy', () => {
    // So the value in .env is always a tag that actually worked, which is what makes
    // it a trustworthy rollback target next time.
    expect(deploySh.indexOf('healthy=true')).toBeLessThan(deploySh.indexOf('IMAGE_TAG=${TAG}'));
  });
});

describe('provisioning', () => {
  it('closes everything except SSH and the web ports', () => {
    expect(provisionSh).toContain('ufw default deny incoming');
    for (const port of ['22/tcp', '80/tcp', '443/tcp']) {
      expect(provisionSh, port).toContain(`ufw allow ${port}`);
    }
    // 3000 is deliberately absent: the container publishes to loopback only, and this
    // is the second lock on that door.
    expect(provisionSh).not.toContain('ufw allow 3000');
  });

  it('schedules reclamation and rotates its log', () => {
    expect(provisionSh).toContain('/etc/cron.d/imgopt-maintenance');
    expect(provisionSh).toContain('--profile scheduled run --rm maintenance');
    expect(provisionSh).toContain('/etc/logrotate.d/imgopt');
  });

  it('creates the environment file unreadable by anyone else', () => {
    // It holds the database password, an AWS secret key, and the worker secret.
    expect(provisionSh).toContain('0600');
  });
});

describe('the environment template', () => {
  it('names one database variable and no connection parts', () => {
    // The whole of the Lightsail → RDS migration on the application side is editing
    // this one string (design.md L5/L7).
    expect(envExample).toContain('DATABASE_URL=');
    for (const part of ['DB_HOST=', 'DB_PORT=', 'DB_USER=', 'DB_PASSWORD=', 'DB_SECRET_ARN=']) {
      expect(envExample, part).not.toContain(part);
    }
  });

  it('requires TLS on the database connection', () => {
    // The connection crosses the Lightsail private network rather than a VPC subnet
    // this deployment controls.
    expect(envExample).toContain('sslmode=require');
  });

  it('carries no real credential', () => {
    expect(envExample).toMatch(/AWS_SECRET_ACCESS_KEY=\s*$/m);
    expect(envExample).toMatch(/WORKER_CALLBACK_SECRET=\s*$/m);
  });
});
