/**
 * API key lifecycle and verification.
 *
 * Verification looks the row up by the id embedded in the key, then timing-safely
 * compares hashes. Quota accounting also lives here because it is keyed by API key:
 * the reservation is a conditional update that only succeeds while the key stays
 * under its limits, so two concurrent uploads cannot both slip past the last slot.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { ApiKey, PrismaClient } from '@imgopt/db';
import { newApiKeyId } from '@imgopt/db';
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
        name: input.name,
        hash: generated.hash,
        permissions: input.permissions ?? [],
        ...(input.maxBytes !== undefined ? { maxBytes: BigInt(input.maxBytes) } : {}),
        ...(input.maxAssets !== undefined ? { maxAssets: input.maxAssets } : {}),
      },
    });

    return { apiKey, plaintext: generated.plaintext };
  }

  /** Newest first. Never selects the hash — nothing outside this class needs it. */
  async list(): Promise<ApiKey[]> {
    return this.prisma.apiKey.findMany({ orderBy: { createdAt: 'desc' } });
  }

  /**
   * Revokes a key.
   *
   * Idempotent: re-revoking keeps the original timestamp rather than moving it, so
   * the record of *when* access was cut stays accurate through a retried or
   * duplicated incident-response step.
   */
  async revoke(keyId: string): Promise<ApiKey> {
    const existing = await this.prisma.apiKey.findUnique({ where: { id: keyId } });
    if (existing === null) throw ApiError.notFound(`No API key "${keyId}".`);
    if (existing.revokedAt !== null) return existing;

    return this.prisma.apiKey.update({
      where: { id: keyId },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Reserves quota for one asset of `bytes`.
   *
   * A conditional `updateMany` guarded by the current usage: it only matches while
   * the key is under both limits, so the check and the increment are one atomic
   * step. Doing this as read-then-write would let two concurrent uploads each read
   * the last free slot and both proceed. Null limits mean unlimited.
   */
  async reserveQuota(keyId: string, bytes: number): Promise<void> {
    const key = await this.prisma.apiKey.findUnique({ where: { id: keyId } });
    if (key === null) throw ApiError.unauthorized('Unknown API key.');

    const updated = await this.prisma.apiKey.updateMany({
      where: {
        id: keyId,
        AND: [
          key.maxBytes === null ? {} : { usedBytes: { lte: key.maxBytes - BigInt(bytes) } },
          key.maxAssets === null ? {} : { usedAssets: { lt: key.maxAssets } },
        ],
      },
      data: {
        usedBytes: { increment: BigInt(bytes) },
        usedAssets: { increment: 1 },
      },
    });

    if (updated.count === 0) {
      throw ApiError.quotaExceeded('Storage or asset quota exceeded for this API key.', {
        maxBytes: key.maxBytes?.toString(),
        maxAssets: key.maxAssets,
      });
    }
  }

  /** Releases a prior reservation, e.g. when an upload is rejected after reserving. */
  async releaseQuota(keyId: string, bytes: number): Promise<void> {
    await this.prisma.apiKey.updateMany({
      where: { id: keyId },
      data: {
        usedBytes: { decrement: BigInt(bytes) },
        usedAssets: { decrement: 1 },
      },
    });
  }
}
