/**
 * API key lifecycle and verification.
 *
 * Verification looks the row up by the id embedded in the key, then timing-safely
 * compares hashes.
 *
 * Quota accounting also lives here, because the calling key is what a request has in
 * hand — but the *allowance* belongs to the tenant. Issuing a second key must not
 * double an application's storage, which is exactly what per-key limits did: the way
 * to raise a ceiling was to ask for another key.
 *
 * The per-key limits survive as a secondary, narrowing ceiling — a build key capped
 * well under its tenant's allowance — and they can only narrow. Both counters are
 * still incremented so per-key attribution stays readable.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { ApiKey, PrismaClient } from '@imgopt/db';
import { newApiKeyId, type TenantScope } from '@imgopt/db';
import { PRISMA } from '../../tokens.js';
import { ApiError } from '../../common/errors.js';
import {
  generateApiKey,
  hashApiKey,
  hashesMatch,
  keyIdFromPlaintext,
  type GeneratedKey,
} from './api-key.js';

export interface CreateKeyInput {
  tenantId: string;
  name: string;
  permissions?: string[];
  maxBytes?: number;
  maxAssets?: number;
}

@Injectable()
export class ApiKeyService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  /** Verifies a presented key. Returns the row, or null for any failure. */
  async verify(plaintext: string): Promise<ApiKey | null> {
    const keyId = keyIdFromPlaintext(plaintext);
    if (keyId === undefined) return null;

    const key = await this.prisma.apiKey.findUnique({ where: { id: keyId } });
    if (key === null || key.revokedAt !== null) return null;

    return hashesMatch(hashApiKey(plaintext), key.hash) ? key : null;
  }

  async create(input: CreateKeyInput): Promise<{ apiKey: ApiKey; plaintext: string }> {
    const generated: GeneratedKey = generateApiKey();

    const apiKey = await this.prisma.apiKey.create({
      data: {
        id: keyIdFromPlaintext(generated.plaintext) ?? newApiKeyId(),
        tenantId: input.tenantId,
        name: input.name,
        hash: generated.hash,
        permissions: input.permissions ?? [],
        ...(input.maxBytes !== undefined ? { maxBytes: BigInt(input.maxBytes) } : {}),
        ...(input.maxAssets !== undefined ? { maxAssets: input.maxAssets } : {}),
      },
    });

    return { apiKey, plaintext: generated.plaintext };
  }

  /** Newest first, within one tenant. Never returns another tenant's keys. */
  async list(scope: TenantScope): Promise<ApiKey[]> {
    return this.prisma.apiKey.findMany({
      where: { tenantId: scope },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Revokes a key.
   *
   * Idempotent: re-revoking keeps the original timestamp rather than moving it, so
   * the record of *when* access was cut stays accurate through a retried or
   * duplicated incident-response step.
   */
  async revoke(scope: TenantScope, keyId: string): Promise<ApiKey> {
    // 404 rather than 403 for another tenant's key id, for the same reason the asset
    // routes do it: a 403 confirms the id is real.
    const existing = await this.prisma.apiKey.findFirst({ where: { id: keyId, tenantId: scope } });
    if (existing === null) throw ApiError.notFound(`No API key "${keyId}".`);
    if (existing.revokedAt !== null) return existing;

    return this.prisma.apiKey.update({
      where: { id: keyId },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Reserves quota for one asset of `bytes`, against the tenant.
   *
   * Two conditional `updateMany`s inside one transaction — the tenant's allowance and
   * the key's narrower ceiling. Each is guarded by the usage it read, so the check and
   * the increment are one atomic step; read-then-write would let two concurrent
   * uploads each see the last free slot and both take it.
   *
   * They are in a transaction together because a partial reservation is worse than a
   * refused one: charging the tenant and then failing on the key would leak allowance
   * on every rejected upload until someone noticed the drift. Null limits mean
   * unlimited on that side.
   */
  async reserveQuota(keyId: string, bytes: number): Promise<void> {
    const key = await this.prisma.apiKey.findUnique({
      where: { id: keyId },
      include: { tenant: true },
    });
    if (key === null) throw ApiError.unauthorized('Unknown API key.');

    const { tenant } = key;

    await this.prisma.$transaction(async (tx) => {
      const tenantUpdate = await tx.tenant.updateMany({
        where: {
          id: tenant.id,
          AND: [
            tenant.maxBytes === null ? {} : { usedBytes: { lte: tenant.maxBytes - BigInt(bytes) } },
            tenant.maxAssets === null ? {} : { usedAssets: { lt: tenant.maxAssets } },
          ],
        },
        data: { usedBytes: { increment: BigInt(bytes) }, usedAssets: { increment: 1 } },
      });

      if (tenantUpdate.count === 0) {
        throw ApiError.quotaExceeded('Storage or asset quota exceeded for this tenant.', {
          maxBytes: tenant.maxBytes?.toString(),
          maxAssets: tenant.maxAssets,
        });
      }

      const keyUpdate = await tx.apiKey.updateMany({
        where: {
          id: keyId,
          AND: [
            key.maxBytes === null ? {} : { usedBytes: { lte: key.maxBytes - BigInt(bytes) } },
            key.maxAssets === null ? {} : { usedAssets: { lt: key.maxAssets } },
          ],
        },
        data: { usedBytes: { increment: BigInt(bytes) }, usedAssets: { increment: 1 } },
      });

      if (keyUpdate.count === 0) {
        // Rolls back the tenant increment above.
        throw ApiError.quotaExceeded('Storage or asset quota exceeded for this API key.', {
          maxBytes: key.maxBytes?.toString(),
          maxAssets: key.maxAssets,
        });
      }
    });
  }

  /**
   * Releases a prior reservation, e.g. when an upload is rejected after reserving.
   *
   * Both counters, since both were charged. Not conditional and not allowed to throw:
   * this runs on the failure path, and a release that fails would strand the
   * allowance it was trying to return.
   */
  async releaseQuota(keyId: string, bytes: number): Promise<void> {
    const key = await this.prisma.apiKey.findUnique({ where: { id: keyId } });
    if (key === null) return;

    await this.prisma.$transaction([
      this.prisma.tenant.updateMany({
        where: { id: key.tenantId },
        data: { usedBytes: { decrement: BigInt(bytes) }, usedAssets: { decrement: 1 } },
      }),
      this.prisma.apiKey.updateMany({
        where: { id: keyId },
        data: { usedBytes: { decrement: BigInt(bytes) }, usedAssets: { decrement: 1 } },
      }),
    ]);
  }
}
