/**
 * Upload endpoints.
 *
 * `POST /v1/images` proxies a small multipart file straight into staging. Anything
 * over the proxy threshold gets a 413 pointing at the presigned flow, whose two
 * steps are `POST /v1/images/uploads` and `.../uploads/:id/complete`.
 */

import { Readable } from 'node:stream';
import { Body, Controller, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { AppConfig } from '@imgopt/config';
import { APP_CONFIG } from '../../tokens.js';
import { ApiError } from '../../common/errors.js';
import { ApiKeyGuard, requestScope, type AuthenticatedRequest } from '../auth/api-key.guard.js';
import { RequirePermissions } from '../auth/permissions.decorator.js';
import { DeliveryService } from '../delivery/delivery.service.js';
import { presentAsset, type AssetResponse } from '../assets/asset.presenter.js';
import { UploadService } from './upload.service.js';

/** Minimal shape of a Fastify request carrying multipart support. */
interface MultipartRequest extends AuthenticatedRequest {
  isMultipart?(): boolean;
  file?(options?: unknown): Promise<
    | {
        file: Readable;
        filename: string;
        mimetype: string;
        fields: Record<string, unknown>;
      }
    | undefined
  >;
}

/**
 * Response envelope shared by both ingest modes.
 *
 * `held` is present when the bytes passed validation but are waiting on a malware
 * verdict. The asset exists and is addressable, but nothing has been promoted, so
 * this is reported as 202 rather than 200 — a client that treats it as success would
 * link to an image that is not there yet.
 */
export interface UploadResponse {
  asset: AssetResponse;
  duplicate: boolean;
  held?: { reason: string };
}

interface CreateUploadBody {
  contentType?: string;
  altText?: string;
  tags?: string[];
}

@Controller('v1/images')
@UseGuards(ApiKeyGuard)
export class UploadController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly uploads: UploadService,
    private readonly delivery: DeliveryService,
  ) {}

  @Post()
  @RequirePermissions('upload')
  async proxied(
    @Req() req: MultipartRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<UploadResponse> {
    if (req.isMultipart?.() !== true || req.file === undefined) {
      throw ApiError.validation('Expected a multipart/form-data upload with a file part.');
    }

    let part;
    try {
      part = await req.file();
    } catch {
      // @fastify/multipart throws when the file exceeds the configured limit.
      throw ApiError.payloadTooLarge('File exceeds the proxied-upload limit.', {
        maxBytes: this.config.upload.proxyThresholdBytes,
        hint: 'Use POST /v1/images/uploads for large files.',
      });
    }
    if (part === undefined) throw ApiError.validation('No file part in the request.');

    const result = await this.uploads.ingestStream(
      requestScope(req),
      part.file,
      part.mimetype,
      req.apiKey?.id,
    );

    // 201 for a promoted upload, 202 when it is held awaiting a malware verdict —
    // the asset exists and is addressable, but nothing has been promoted, and a
    // client treating that as success would link to an image that is not there.
    if (result.held !== undefined) reply.status(202);

    return {
      asset: presentAsset(result.asset, this.delivery),
      duplicate: result.duplicate,
      ...(result.held !== undefined ? { held: result.held } : {}),
    };
  }

  @Post('uploads')
  @RequirePermissions('upload')
  async createUpload(
    @Req() req: AuthenticatedRequest,
    @Body() body: CreateUploadBody,
  ): Promise<{
    assetId: string;
    upload: { url: string; fields: Record<string, string>; key: string; expiresAt: string };
  }> {
    if (body.contentType === undefined) {
      throw ApiError.validation('A declared contentType is required.');
    }

    const { asset, target } = await this.uploads.createUploadTarget(
      requestScope(req),
      body.contentType,
      req.apiKey?.id,
      {
        ...(body.altText !== undefined ? { altText: body.altText } : {}),
        ...(body.tags !== undefined ? { tags: body.tags } : {}),
      },
    );

    return {
      assetId: asset.id,
      upload: {
        url: target.url,
        fields: target.fields,
        key: target.key,
        expiresAt: target.expiresAt.toISOString(),
      },
    };
  }

  @Post('uploads/:id/complete')
  @RequirePermissions('upload')
  async completeUpload(
    @Param('id') id: string,
    @Body() body: { contentType?: string },
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<UploadResponse> {
    const result = await this.uploads.completeUpload(
      requestScope(req),
      id,
      body?.contentType,
      req.apiKey?.id,
    );
    if (result.held !== undefined) reply.status(202);

    return {
      asset: presentAsset(result.asset, this.delivery),
      duplicate: result.duplicate,
      ...(result.held !== undefined ? { held: result.held } : {}),
    };
  }
}
