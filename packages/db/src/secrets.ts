/**
 * Database credential resolution for Lambda.
 *
 * ECS can inject a Secrets Manager value straight into a container's environment,
 * so the control plane needs nothing at runtime. Lambda has no equivalent: an
 * environment variable on a function is plaintext, visible in the console and in the
 * template, which is exactly what "secrets never in plain deployment parameters"
 * rules out. So the functions receive the secret's *ARN* and fetch the value here.
 *
 * Called once during module initialization — free time on a managed runtime, before
 * the first invocation — and the result is reused for the life of the container.
 */

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

/** Shape of the secret RDS generates for a database instance. */
interface RdsSecret {
  password?: string;
  username?: string;
  host?: string;
  port?: number;
  dbname?: string;
}

let resolved: Promise<void> | undefined;

/**
 * Populates `DB_PASSWORD` from Secrets Manager so `loadConfig` can compose the
 * connection URL exactly as it does in a container.
 *
 * A no-op when the password is already present or no ARN is configured, which keeps
 * local development and the integration tests on plain environment variables with no
 * AWS call and no special case in the callers.
 *
 * Deliberately idempotent and memoized: a warm Lambda container re-imports nothing,
 * but a retry path calling this twice should not pay for a second round trip.
 */
export function hydrateDatabaseCredentials(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  resolved ??= resolve(env);
  return resolved;
}

async function resolve(env: NodeJS.ProcessEnv): Promise<void> {
  const arn = env['DB_SECRET_ARN'];
  if (arn === undefined || arn === '' || env['DB_PASSWORD'] !== undefined) return;

  const client = new SecretsManagerClient({});
  try {
    const result = await client.send(new GetSecretValueCommand({ SecretId: arn }));
    if (result.SecretString === undefined) {
      throw new Error('Secret has no string value.');
    }

    const secret = JSON.parse(result.SecretString) as RdsSecret;
    if (secret.password === undefined) {
      throw new Error('Secret contains no "password" field.');
    }

    env['DB_PASSWORD'] = secret.password;
    // Only used as fallbacks — the deployment passes host, port, user, and name as
    // plain environment already, and those survive a credential rotation that moves
    // the endpoint.
    env['DB_HOST'] ??= secret.host ?? '';
    env['DB_USER'] ??= secret.username ?? '';
    env['DB_NAME'] ??= secret.dbname ?? '';
    if (secret.port !== undefined) env['DB_PORT'] ??= String(secret.port);
  } catch (error) {
    // Fail loudly and immediately. The alternative is a function that starts fine
    // and then fails every invocation with a connection error pointing nowhere.
    throw new Error(`Could not read database credentials from ${arn}: ${(error as Error).message}`);
  } finally {
    client.destroy();
  }
}

/** Test seam: forgets the memoized resolution. */
export function resetCredentialCache(): void {
  resolved = undefined;
}
