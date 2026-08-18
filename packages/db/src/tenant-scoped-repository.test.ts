/**
 * Scoping coverage (task 3.9).
 *
 * The guarantee "every method is scoped" is worth exactly as much as its coverage, so
 * this does not test a hand-picked sample. It enumerates the repository's own method
 * names at runtime and asserts each one appears in the table below — a method added
 * later fails here until someone states what scoping it. That is the point: the test
 * that catches the omission is the one nobody has to remember to write.
 *
 * It runs against a fake Prisma client rather than a database, because what is being
 * checked is the *query* — whether `tenantId` reached the `where` clause — and a real
 * database can only show the consequence. Both matter; the integration suite covers
 * the consequence with two real tenants.
 */

import { describe, expect, it } from 'vitest';
import type { PrismaClient } from './generated/client.js';
import { TenantScopedRepository } from './tenant-scoped-repository.js';
import type { TenantScope } from './tenant-scope.js';

const SCOPE = 'tenant_a' as TenantScope;

/** Every `where` clause the repository built during one call. */
interface Recorder {
  wheres: Array<Record<string, unknown>>;
}

/**
 * A Prisma stand-in that records `where` clauses and answers plausibly.
 *
 * Reads return a row already carrying `tenantId: SCOPE`, so the repository's own
 * post-filtering never rejects the fixture and every method reaches its query.
 */
function fakePrisma(recorder: Recorder): PrismaClient {
  const asset = {
    id: 'asset_1',
    tenantId: SCOPE,
    currentVersion: 1,
    status: 'stored',
    deletedAt: null,
    versions: [],
  };

  const record = (args?: { where?: Record<string, unknown> }) => {
    if (args?.where !== undefined) recorder.wheres.push(args.where);
  };

  const model = <T>(row: T) => ({
    findFirst: (args?: { where?: Record<string, unknown> }) => {
      record(args);
      return Promise.resolve(row);
    },
    findUnique: (args?: { where?: Record<string, unknown> }) => {
      record(args);
      return Promise.resolve(row);
    },
    findMany: (args?: { where?: Record<string, unknown> }) => {
      record(args);
      return Promise.resolve([row]);
    },
    create: (args?: { data?: Record<string, unknown> }) => {
      // A create has no `where`; the tenant arrives in `data` instead.
      if (args?.data !== undefined) recorder.wheres.push(args.data);
      return Promise.resolve(row);
    },
    update: (args?: { where?: Record<string, unknown> }) => {
      record(args);
      return Promise.resolve(row);
    },
    updateMany: (args?: { where?: Record<string, unknown> }) => {
      record(args);
      return Promise.resolve({ count: 1 });
    },
  });

  const version = {
    assetId: 'asset_1',
    version: 1,
    contentHash: 'abc',
    createdAt: new Date(0),
    asset,
  };

  const client = {
    asset: model(asset),
    assetVersion: model(version),
    derivative: model({ canonicalKey: 'k', assetId: 'asset_1', version: 1 }),
    // The transactional path gets the same fake, so `addVersion` records its
    // opening lookup exactly as the non-transactional methods do.
    $transaction: (fn: (tx: unknown) => unknown) => Promise.resolve(fn(client)),
  };

  return client as unknown as PrismaClient;
}

/**
 * How each method is expected to be scoped.
 *
 * `direct` — the tenant appears in a query this method issues itself.
 * `viaOwnership` — the method leads with a scoped ownership check and then acts on a
 * primary key. Distinguished rather than merged, because the two fail differently: a
 * `direct` method that loses its filter reads across tenants, while a `viaOwnership`
 * one stops at a 404.
 */
const EXPECTED: Record<string, 'direct' | 'viaOwnership'> = {
  create: 'direct',
  findById: 'direct',
  requireById: 'direct',
  currentVersion: 'viaOwnership',
  list: 'direct',
  updateMetadata: 'viaOwnership',
  softDelete: 'viaOwnership',
  listDerivatives: 'viaOwnership',
  findByContentHash: 'direct',
  addVersion: 'direct',
  markRejected: 'viaOwnership',
};

/** Arguments after the scope, per method. */
const ARGS: Record<string, unknown[]> = {
  create: [{}],
  findById: ['asset_1'],
  requireById: ['asset_1'],
  currentVersion: ['asset_1'],
  list: [{}],
  updateMetadata: ['asset_1', { altText: 'x' }],
  softDelete: ['asset_1'],
  listDerivatives: ['asset_1'],
  findByContentHash: ['hash'],
  addVersion: [{ assetId: 'asset_1', sourceKey: 'k', contentHash: 'h' }],
  markRejected: ['asset_1', 'invalid_format'],
};

function methodNames(): string[] {
  return Object.getOwnPropertyNames(TenantScopedRepository.prototype).filter(
    (name) => name !== 'constructor',
  );
}

/** True if the tenant id appears anywhere in a recorded clause, however nested. */
function mentionsTenant(clause: unknown): boolean {
  if (clause === null || typeof clause !== 'object') return clause === SCOPE;
  return Object.values(clause as Record<string, unknown>).some(mentionsTenant);
}

describe('tenant scoping coverage', () => {
  it('has an expectation for every method on the repository', () => {
    // The whole point of the suite: a method added without an entry fails here.
    expect(methodNames().sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(methodNames())('%s filters on the tenant', async (name) => {
    const recorder: Recorder = { wheres: [] };
    const repo = new TenantScopedRepository(fakePrisma(recorder));

    const method = (repo as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name];
    await method.call(repo, SCOPE, ...(ARGS[name] ?? []));

    expect(recorder.wheres.length, `${name} issued no query`).toBeGreaterThan(0);
    expect(recorder.wheres.some(mentionsTenant), `${name} never mentioned the tenant`).toBe(true);
  });

  it('scopes the *first* query, not a later one', async () => {
    // Ordering matters for the ownership-check methods. If the scoped check ran after
    // the write, the write would already have touched another tenant's row.
    for (const name of methodNames()) {
      const recorder: Recorder = { wheres: [] };
      const repo = new TenantScopedRepository(fakePrisma(recorder));
      const method = (repo as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[
        name
      ];
      await method.call(repo, SCOPE, ...(ARGS[name] ?? []));

      expect(
        mentionsTenant(recorder.wheres[0]),
        `${name} scoped a later query, not its first`,
      ).toBe(true);
    }
  });
});
