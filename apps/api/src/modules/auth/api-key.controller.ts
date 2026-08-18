/**
 * API key administration.
 *
 * Guarded by the `admin` permission, so issuing keys requires a key that can — there
 * is no unauthenticated bootstrap endpoint. The first key is created out of band by
 * an operator; see the bootstrap guide (task 14.4).
 *
 * The plaintext is returned exactly once, here, and never again: only its hash is
 * stored, so there is no code path that could return it later even if asked. That is
 * the whole point of hashing it, and it is why the response says so explicitly.
 */

import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { ApiKey } from '@imgopt/db';
import { ApiError } from '../../common/errors.js';
import { ApiKeyGuard, requestScope, type AuthenticatedRequest } from './api-key.guard.js';
import { ApiKeyService, type CreateKeyInput } from './api-key.service.js';
import { RequirePermissions } from './permissions.decorator.js';

/** Public view of a key. Deliberately has no field that could carry the secret. */
export interface ApiKeyResponse {
  id: string;
  name: string;
  permissions: string[];
  quota: {
    maxBytes: string | null;
    maxAssets: number | null;
    usedBytes: string;
    usedAssets: number;
  };
  createdAt: string;
  revokedAt: string | null;
}

function present(key: ApiKey): ApiKeyResponse {
  return {
    id: key.id,
    name: key.name,
    permissions: key.permissions,
    quota: {
      // BigInt as a string: JSON has no BigInt, and narrowing to a number would
      // corrupt a byte count above 2^53.
      maxBytes: key.maxBytes === null ? null : key.maxBytes.toString(),
      maxAssets: key.maxAssets,
      usedBytes: key.usedBytes.toString(),
      usedAssets: key.usedAssets,
    },
    createdAt: key.createdAt.toISOString(),
    revokedAt: key.revokedAt === null ? null : key.revokedAt.toISOString(),
  };
}

interface CreateKeyBody {
  name?: string;
  permissions?: string[];
  maxBytes?: number;
  maxAssets?: number;
}

@Controller('v1/keys')
@UseGuards(ApiKeyGuard)
export class ApiKeyController {
  constructor(private readonly keys: ApiKeyService) {}

  @Post()
  @RequirePermissions('admin')
  async create(
    @Req() req: AuthenticatedRequest,
    @Body() body: CreateKeyBody,
  ): Promise<{ key: ApiKeyResponse; plaintext: string; warning: string }> {
    if (body?.name === undefined || body.name.trim() === '') {
      throw ApiError.validation('A key name is required.');
    }

    /*
     * A key is always issued into the issuer's own tenant, never a named one.
     *
     * Taking a tenant id from the body would make `admin` on any key a way to mint
     * credentials for someone else's data — the one privilege escalation this whole
     * change exists to prevent.
     */
    const input: CreateKeyInput = { tenantId: requestScope(req), name: body.name.trim() };
    if (body.permissions !== undefined) input.permissions = body.permissions;
    if (body.maxBytes !== undefined) input.maxBytes = body.maxBytes;
    if (body.maxAssets !== undefined) input.maxAssets = body.maxAssets;

    const { apiKey, plaintext } = await this.keys.create(input);

    return {
      key: present(apiKey),
      plaintext,
      warning: 'Store this now. Only a hash is kept, so it cannot be shown again.',
    };
  }

  @Get()
  @RequirePermissions('admin')
  async list(@Req() req: AuthenticatedRequest): Promise<{ keys: ApiKeyResponse[] }> {
    return { keys: (await this.keys.list(requestScope(req))).map(present) };
  }

  /**
   * Revocation is a soft delete, not a row deletion.
   *
   * The row carries the quota accounting and is referenced by the assets the key
   * uploaded. Deleting it would orphan that history exactly when someone is most
   * likely to be reading it — during the incident that prompted the revocation.
   */
  @Delete(':id')
  @RequirePermissions('admin')
  async revoke(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ key: ApiKeyResponse }> {
    return { key: present(await this.keys.revoke(requestScope(req), id)) };
  }
}
