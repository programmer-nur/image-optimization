/**
 * Prisma client construction.
 *
 * Prisma 7 has no Rust query engine: queries are compiled in TypeScript and issued
 * through a driver adapter. That removes the native binary that used to dominate a
 * Lambda bundle, which is what made Prisma a poor fit for this architecture
 * originally. See design.md D11.
 *
 * Two very different execution contexts share this module, and they want opposite
 * pool settings — hence {@link createPrismaClient}'s `context` argument.
 */

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client.js';

export type ExecutionContext = 'container' | 'lambda';

export interface PrismaClientOptions {
  connectionString: string;
  /**
   * `container` keeps a warm pool across many concurrent requests.
   * `lambda` uses a single connection: each concurrent invocation is its own
   * process, so a pool per invocation multiplies straight into Postgres'
   * connection limit — the classic way a serverless workload exhausts a database.
   */
  context?: ExecutionContext;
  maxConnections?: number;
  logQueries?: boolean;
}

export function createPrismaClient(options: PrismaClientOptions): PrismaClient {
  const context = options.context ?? 'container';
  const max = context === 'lambda' ? 1 : (options.maxConnections ?? 10);

  const adapter = new PrismaPg({
    connectionString: options.connectionString,
    max,
    // A Lambda that idles between invocations should not hold a connection open
    // for the life of the container.
    idleTimeoutMillis: context === 'lambda' ? 1_000 : 30_000,
  });

  return new PrismaClient({
    adapter,
    ...(options.logQueries === true ? { log: ['query', 'warn', 'error'] as const } : {}),
  });
}

export { PrismaClient };
export type { Asset, AssetVersion, Derivative, ApiKey } from './generated/client.js';
export { AssetStatus, DerivativeOrigin } from './generated/enums.js';
