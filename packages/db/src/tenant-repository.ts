/**
 * Tenant rows.
 *
 * Small on purpose. A deployment has one tenant today (T2: tenancy is the deployment,
 * not the URL), so this exists to create and read that row — for the bootstrap path,
 * for tests that need a second tenant to prove isolation, and for whatever admin
 * surface a shared deployment would eventually want. Quota *accounting* is not here;
 * it lives with the code that reserves it, next to the upload path.
 */

import type { PrismaClient } from './generated/client.js';
import { DEFAULT_TENANT_ID } from './tenant-scope.js';

export interface CreateTenantInput {
  id?: string;
  /** Operator-facing handle. Unique, and safe to rename — it reaches no URL. */
  slug: string;
  name?: string;
  maxBytes?: number;
  maxAssets?: number;
}

export class TenantRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateTenantInput) {
    return this.prisma.tenant.create({
      data: {
        id: input.id ?? `tenant_${input.slug}`,
        slug: input.slug,
        name: input.name ?? input.slug,
        ...(input.maxBytes !== undefined ? { maxBytes: BigInt(input.maxBytes) } : {}),
        ...(input.maxAssets !== undefined ? { maxAssets: input.maxAssets } : {}),
      },
    });
  }

  async findById(tenantId: string) {
    return this.prisma.tenant.findUnique({ where: { id: tenantId } });
  }

  async findBySlug(slug: string) {
    return this.prisma.tenant.findUnique({ where: { slug } });
  }

  async list() {
    return this.prisma.tenant.findMany({ orderBy: { id: 'asc' } });
  }

  /**
   * Makes sure the default tenant exists, without disturbing it if it does.
   *
   * The migration creates this row, so on a migrated database this is a no-op. It
   * matters for a database built by `prisma db push` — a test harness, a throwaway
   * local stack — where no migration ran and the first upload would otherwise fail on
   * a foreign key nobody thought about.
   *
   * `update: {}` rather than an update with values: re-running bootstrap must not
   * reset a quota an operator has since raised.
   */
  async ensureDefault() {
    return this.prisma.tenant.upsert({
      where: { id: DEFAULT_TENANT_ID },
      update: {},
      create: { id: DEFAULT_TENANT_ID, slug: 'default', name: 'Default' },
    });
  }
}
