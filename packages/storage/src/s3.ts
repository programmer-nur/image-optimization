/**
 * S3 adapter.
 *
 * Also the local-development adapter: MinIO speaks the S3 API, so pointing
 * `endpoint` at it and enabling path-style addressing is the whole difference. That
 * keeps one code path under test rather than a production adapter and a separate
 * in-memory fake that drifts from it.
 */

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import {
  ObjectNotFoundError,
  StorageError,
  type ConditionalPutResult,
  type ListOptions,
  type ListResult,
  type MultipartUpload,
  type ObjectHead,
  type PresignedUploadOptions,
  type PresignedUploadTarget,
  type PutOptions,
  type PutResult,
  type StoragePort,
} from './port.js';

export interface S3StorageConfig {
  bucket: string;
  region: string;
  /** Set for MinIO; leave undefined in AWS so the SDK resolves the real endpoint. */
  endpoint?: string;
  forcePathStyle?: boolean;
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

/** S3 signals "no such key" differently depending on the operation and permissions. */
function isNotFound(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === 'NotFound' ||
    e?.name === 'NoSuchKey' ||
    e?.$metadata?.httpStatusCode === 404 ||
    // With OAC and no s3:ListBucket, a missing key reads as 403 rather than 404.
    // The same asymmetry drives the CloudFront origin-failover config. See design.md D5.
    e?.$metadata?.httpStatusCode === 403
  );
}

function isPreconditionFailed(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'PreconditionFailed' || e?.$metadata?.httpStatusCode === 412;
}

export class S3Storage implements StoragePort {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: S3StorageConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: config.region,
      ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
      ...(config.forcePathStyle !== undefined ? { forcePathStyle: config.forcePathStyle } : {}),
      ...(config.credentials !== undefined ? { credentials: config.credentials } : {}),
    });
  }

  /** Exposed so callers can share one client and shut it down cleanly. */
  get s3(): S3Client {
    return this.client;
  }

  destroy(): void {
    this.client.destroy();
  }

  async head(key: string): Promise<ObjectHead | undefined> {
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        bytes: out.ContentLength ?? 0,
        etag: (out.ETag ?? '').replaceAll('"', ''),
        lastModified: out.LastModified ?? new Date(0),
        ...(out.ContentType !== undefined ? { contentType: out.ContentType } : {}),
        ...(out.CacheControl !== undefined ? { cacheControl: out.CacheControl } : {}),
        metadata: out.Metadata ?? {},
      };
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw new StorageError('head_failed', `Failed to head "${key}".`, { key, cause: error });
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.head(key)) !== undefined;
  }

  async get(key: string): Promise<Buffer> {
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const bytes = await out.Body!.transformToByteArray();
      return Buffer.from(bytes);
    } catch (error) {
      if (isNotFound(error)) throw new ObjectNotFoundError(key);
      throw new StorageError('get_failed', `Failed to read "${key}".`, { key, cause: error });
    }
  }

  async getRange(key: string, start: number, end: number): Promise<Buffer> {
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=${start}-${end}` }),
      );
      const bytes = await out.Body!.transformToByteArray();
      return Buffer.from(bytes);
    } catch (error) {
      if (isNotFound(error)) throw new ObjectNotFoundError(key);
      throw new StorageError('get_range_failed', `Failed to read range of "${key}".`, {
        key,
        cause: error,
      });
    }
  }

  async getStream(key: string): Promise<Readable> {
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return out.Body as Readable;
    } catch (error) {
      if (isNotFound(error)) throw new ObjectNotFoundError(key);
      throw new StorageError('get_stream_failed', `Failed to open "${key}".`, {
        key,
        cause: error,
      });
    }
  }

  async put(
    key: string,
    body: Buffer | Uint8Array | Readable,
    options: PutOptions = {},
  ): Promise<PutResult> {
    try {
      // lib-storage switches to multipart automatically for large or streamed
      // bodies, which is what keeps a 100MB upload from being buffered in memory.
      const upload = new Upload({
        client: this.client,
        params: {
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ...(options.contentType !== undefined ? { ContentType: options.contentType } : {}),
          ...(options.cacheControl !== undefined ? { CacheControl: options.cacheControl } : {}),
          ...(options.metadata !== undefined ? { Metadata: options.metadata } : {}),
        },
      });
      const out = await upload.done();
      return { key, etag: (out.ETag ?? '').replaceAll('"', '') };
    } catch (error) {
      throw new StorageError('put_failed', `Failed to write "${key}".`, { key, cause: error });
    }
  }

  async putIfAbsent(
    key: string,
    body: Buffer | Uint8Array,
    options: PutOptions = {},
  ): Promise<ConditionalPutResult> {
    try {
      const out = await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          IfNoneMatch: '*',
          ...(options.contentType !== undefined ? { ContentType: options.contentType } : {}),
          ...(options.cacheControl !== undefined ? { CacheControl: options.cacheControl } : {}),
          ...(options.metadata !== undefined ? { Metadata: options.metadata } : {}),
        }),
      );
      return { key, etag: (out.ETag ?? '').replaceAll('"', ''), written: true };
    } catch (error) {
      if (isPreconditionFailed(error)) {
        // Lost the race. Harmless: rendering is deterministic, so the winner wrote
        // the same bytes we were about to.
        const existing = await this.head(key);
        return { key, etag: existing?.etag ?? '', written: false };
      }
      throw new StorageError('conditional_put_failed', `Failed to write "${key}".`, {
        key,
        cause: error,
      });
    }
  }

  /**
   * Object tags.
   *
   * Read for one reason: GuardDuty Malware Protection records its verdict as a tag
   * on the scanned object rather than in an API a caller can query. An absent tag is
   * therefore not an error — it means the scan has not finished — so a missing object
   * and an unscanned one are distinguished by returning undefined only for the former.
   */
  async getTags(key: string): Promise<Record<string, string> | undefined> {
    try {
      const out = await this.client.send(
        new GetObjectTaggingCommand({ Bucket: this.bucket, Key: key }),
      );

      const tags: Record<string, string> = {};
      for (const tag of out.TagSet ?? []) {
        if (tag.Key !== undefined && tag.Value !== undefined) tags[tag.Key] = tag.Value;
      }
      return tags;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw new StorageError('get_tags_failed', `Failed to read tags for "${key}".`, {
        key,
        cause: error,
      });
    }
  }

  async copy(sourceKey: string, destinationKey: string, options: PutOptions = {}): Promise<void> {
    try {
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          Key: destinationKey,
          CopySource: `${this.bucket}/${sourceKey}`,
          ...(options.contentType !== undefined
            ? { ContentType: options.contentType, MetadataDirective: 'REPLACE' as const }
            : {}),
          ...(options.cacheControl !== undefined ? { CacheControl: options.cacheControl } : {}),
          ...(options.metadata !== undefined
            ? { Metadata: options.metadata, MetadataDirective: 'REPLACE' as const }
            : {}),
        }),
      );
    } catch (error) {
      if (isNotFound(error)) throw new ObjectNotFoundError(sourceKey);
      throw new StorageError(
        'copy_failed',
        `Failed to copy "${sourceKey}" to "${destinationKey}".`,
        { key: sourceKey, cause: error },
      );
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      throw new StorageError('delete_failed', `Failed to delete "${key}".`, { key, cause: error });
    }
  }

  async deletePrefix(prefix: string): Promise<number> {
    let deleted = 0;
    let continuationToken: string | undefined;

    do {
      const page = await this.list(prefix, {
        maxKeys: 1000,
        ...(continuationToken !== undefined ? { continuationToken } : {}),
      });
      if (page.objects.length === 0) break;

      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: page.objects.map((o) => ({ Key: o.key })), Quiet: true },
        }),
      );
      deleted += page.objects.length;
      continuationToken = page.continuationToken;
    } while (continuationToken !== undefined);

    return deleted;
  }

  async list(prefix: string, options: ListOptions = {}): Promise<ListResult> {
    try {
      const out = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ...(options.maxKeys !== undefined ? { MaxKeys: options.maxKeys } : {}),
          ...(options.continuationToken !== undefined
            ? { ContinuationToken: options.continuationToken }
            : {}),
        }),
      );

      return {
        objects: (out.Contents ?? []).map((o) => ({
          key: o.Key ?? '',
          bytes: o.Size ?? 0,
          lastModified: o.LastModified ?? new Date(0),
          etag: (o.ETag ?? '').replaceAll('"', ''),
        })),
        ...(out.NextContinuationToken !== undefined
          ? { continuationToken: out.NextContinuationToken }
          : {}),
      };
    } catch (error) {
      throw new StorageError('list_failed', `Failed to list "${prefix}".`, { cause: error });
    }
  }

  async presignUpload(
    key: string,
    options: PresignedUploadOptions,
  ): Promise<PresignedUploadTarget> {
    try {
      const { url, fields } = await createPresignedPost(this.client, {
        Bucket: this.bucket,
        Key: key,
        Conditions: [
          // Enforced by S3 itself, so an oversized upload is rejected before a single
          // byte becomes our problem.
          ['content-length-range', options.minBytes, options.maxBytes],
          ['eq', '$Content-Type', options.contentType],
        ],
        Fields: { 'Content-Type': options.contentType },
        Expires: options.expiresInSeconds,
      });

      return {
        url,
        fields,
        key,
        expiresAt: new Date(Date.now() + options.expiresInSeconds * 1000),
      };
    } catch (error) {
      throw new StorageError('presign_failed', `Failed to presign upload for "${key}".`, {
        key,
        cause: error,
      });
    }
  }

  async presignDownload(key: string, options: { expiresInSeconds: number }): Promise<string> {
    try {
      return await getSignedUrl(
        this.client,
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { expiresIn: options.expiresInSeconds },
      );
    } catch (error) {
      throw new StorageError('presign_failed', `Failed to presign download for "${key}".`, {
        key,
        cause: error,
      });
    }
  }

  async createMultipartUpload(
    key: string,
    partCount: number,
    options: { contentType: string; expiresInSeconds: number },
  ): Promise<MultipartUpload> {
    try {
      const created = await this.client.send(
        new CreateMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          ContentType: options.contentType,
        }),
      );
      const uploadId = created.UploadId!;

      const partUrls = await Promise.all(
        Array.from({ length: partCount }, (_, i) =>
          getSignedUrl(
            this.client,
            new UploadPartCommand({
              Bucket: this.bucket,
              Key: key,
              UploadId: uploadId,
              PartNumber: i + 1,
            }),
            { expiresIn: options.expiresInSeconds },
          ),
        ),
      );

      return { uploadId, key, partUrls };
    } catch (error) {
      throw new StorageError('multipart_create_failed', `Failed to start upload for "${key}".`, {
        key,
        cause: error,
      });
    }
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: Array<{ partNumber: number; etag: string }>,
  ): Promise<PutResult> {
    try {
      const out = await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts
              .slice()
              .sort((a, b) => a.partNumber - b.partNumber)
              .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
          },
        }),
      );
      return { key, etag: (out.ETag ?? '').replaceAll('"', '') };
    } catch (error) {
      throw new StorageError('multipart_complete_failed', `Failed to complete "${key}".`, {
        key,
        cause: error,
      });
    }
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }),
      );
    } catch (error) {
      throw new StorageError('multipart_abort_failed', `Failed to abort "${key}".`, {
        key,
        cause: error,
      });
    }
  }
}
