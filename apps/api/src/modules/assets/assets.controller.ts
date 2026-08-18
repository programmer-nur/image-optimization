/**
 * Asset lifecycle endpoints.
 */

import { Readable } from 'node:stream';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AssetStatus, type FocalPoint } from '@imgopt/db';
import { ApiError } from '../../common/errors.js';
import { ApiKeyGuard, requestScope, type AuthenticatedRequest } from '../auth/api-key.guard.js';
import { RequirePermissions } from '../auth/permissions.decorator.js';
import { DeliveryService } from '../delivery/delivery.service.js';
import { AssetsService } from './assets.service.js';
import { presentAsset, type AssetResponse } from './asset.presenter.js';

interface UpdateBody {
  altText?: string | null;
  tags?: string[];
  focalPoint?: FocalPoint | null;
}

interface RawRequest extends AuthenticatedRequest {
  raw?: Readable;
  headers: Record<string, string | string[] | undefined>;
}

@Controller('v1/images')
@UseGuards(ApiKeyGuard)
export class AssetsController {
  constructor(
    private readonly assets: AssetsService,
    private readonly delivery: DeliveryService,
  ) {}

  /*
   * Reads carry a permission of their own.
   *
   * They used to require only a valid key, which meant a key issued with
   * `permissions: []` — the default for a key created without any — could enumerate
   * the entire catalog and read every asset's metadata. That is the opposite of what
   * an empty permission list should grant, and it made "least privilege" impossible
   * to express: there was no way to hand out a key that can upload but not list.
   */
  @Get(':id')
  @RequirePermissions('read')
  async get(@Req() req: AuthenticatedRequest, @Param('id') id: string): Promise<AssetResponse> {
    const asset = await this.assets.get(requestScope(req), id);
    return presentAsset(asset, this.delivery);
  }

  @Get(':id/variants')
  @RequirePermissions('read')
  async variants(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{
    variants: Array<{
      canonicalKey: string;
      format: string;
      width: number | null;
      height: number | null;
      bytes: string;
      generatedBy: string;
      generatedAt: string;
    }>;
  }> {
    const rows = await this.assets.listVariants(requestScope(req), id);
    return {
      variants: rows.map((v) => ({
        canonicalKey: v.canonicalKey,
        format: v.format,
        width: v.width,
        height: v.height,
        bytes: v.bytes.toString(),
        generatedBy: v.generatedBy,
        generatedAt: v.generatedAt.toISOString(),
      })),
    };
  }

  @Patch(':id')
  @RequirePermissions('upload')
  async update(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: UpdateBody,
  ): Promise<AssetResponse> {
    const asset = await this.assets.updateMetadata(requestScope(req), id, {
      ...(body.altText !== undefined ? { altText: body.altText } : {}),
      ...(body.tags !== undefined ? { tags: body.tags } : {}),
      ...(body.focalPoint !== undefined ? { focalPoint: body.focalPoint } : {}),
    });
    return presentAsset(asset, this.delivery);
  }

  @Put(':id/source')
  @RequirePermissions('upload')
  async replaceSource(
    @Param('id') id: string,
    @Req() req: RawRequest,
  ): Promise<{ asset: AssetResponse; duplicate: boolean }> {
    const body = req.raw;
    if (body === undefined) throw ApiError.validation('Expected a raw image body.');

    const declaredType = this.headerValue(req.headers['content-type']);
    const result = await this.assets.replaceSource(
      requestScope(req),
      id,
      body,
      declaredType,
      req.apiKey?.id,
    );
    return { asset: presentAsset(result.asset, this.delivery), duplicate: result.duplicate };
  }

  @Post(':id/reprocess')
  @RequirePermissions('upload')
  async reprocess(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ status: string }> {
    await this.assets.reprocess(requestScope(req), id);
    return { status: 'queued' };
  }

  @Delete(':id')
  @RequirePermissions('delete')
  async remove(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ status: string }> {
    await this.assets.delete(requestScope(req), id);
    return { status: AssetStatus.deleted };
  }

  @Get()
  @RequirePermissions('read')
  async list(
    @Req() req: AuthenticatedRequest,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('status') status?: string,
  ): Promise<{ assets: AssetResponse[]; nextCursor?: string }> {
    const result = await this.assets.list(requestScope(req), {
      ...(limit !== undefined ? { limit: Number(limit) } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
      ...(this.isStatus(status) ? { status } : {}),
    });

    return {
      assets: result.assets.map((a) => presentAsset(a, this.delivery)),
      ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}),
    };
  }

  private isStatus(value: string | undefined): value is AssetStatus {
    return value !== undefined && (Object.values(AssetStatus) as string[]).includes(value);
  }

  private headerValue(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
  }
}
