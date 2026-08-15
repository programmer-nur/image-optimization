/**
 * The storage port.
 *
 * Deliberately free of AWS types so the API, both Lambdas, and the tests all depend
 * on this shape rather than on the S3 client. That is what lets processing logic be
 * exercised without a cloud account, and it keeps a non-S3 backend possible without
 * touching callers.
 */

import type { Readable } from 'node:stream';

export interface ObjectHead {
  bytes: number;
  etag: string;
  lastModified: Date;
  contentType?: string;
  cacheControl?: string;
  metadata: Record<string, string>;
}

export interface ObjectSummary {
  key: string;
  bytes: number;
  lastModified: Date;
  etag: string;
}

export interface PutOptions {
  contentType?: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
}

export interface PutResult {
  etag: string;
  key: string;
}

export interface ConditionalPutResult extends PutResult {
  /**
   * False when the key already existed and this write was discarded.
   *
   * This is what makes concurrent generation of the same derivative safe without a
   * distributed lock: generators race, the loser drops its output, and because
   * rendering is deterministic both would have produced identical bytes anyway.
   */
  written: boolean;
}

export interface ListOptions {
  maxKeys?: number;
  continuationToken?: string;
}

export interface ListResult {
  objects: ObjectSummary[];
  continuationToken?: string;
}

export interface PresignedUploadTarget {
  url: string;
  fields: Record<string, string>;
  key: string;
  expiresAt: Date;
}

export interface PresignedUploadOptions {
  /** Hard byte range enforced by the storage service itself, before our code runs. */
  minBytes: number;
  maxBytes: number;
  contentType: string;
  expiresInSeconds: number;
}

export interface MultipartUpload {
  uploadId: string;
  key: string;
  /** Presigned URL per part, in order. */
  partUrls: string[];
}

export interface StoragePort {
  head(key: string): Promise<ObjectHead | undefined>;
  exists(key: string): Promise<boolean>;
  /** Object tags, or undefined when the object does not exist. */
  getTags(key: string): Promise<Record<string, string> | undefined>;

  get(key: string): Promise<Buffer>;
  /** Inclusive byte range. Used to sniff magic bytes without reading a 100MB file. */
  getRange(key: string, start: number, end: number): Promise<Buffer>;
  getStream(key: string): Promise<Readable>;

  put(key: string, body: Buffer | Uint8Array | Readable, options?: PutOptions): Promise<PutResult>;
  /** Writes only when the key is absent. See {@link ConditionalPutResult.written}. */
  putIfAbsent(
    key: string,
    body: Buffer | Uint8Array,
    options?: PutOptions,
  ): Promise<ConditionalPutResult>;

  /** Server-side copy. Promotes staged uploads without moving bytes through us. */
  copy(sourceKey: string, destinationKey: string, options?: PutOptions): Promise<void>;

  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<number>;

  list(prefix: string, options?: ListOptions): Promise<ListResult>;

  presignUpload(key: string, options: PresignedUploadOptions): Promise<PresignedUploadTarget>;
  createMultipartUpload(
    key: string,
    partCount: number,
    options: { contentType: string; expiresInSeconds: number },
  ): Promise<MultipartUpload>;
  completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: Array<{ partNumber: number; etag: string }>,
  ): Promise<PutResult>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
}

export class StorageError extends Error {
  readonly code: string;
  readonly key?: string;

  constructor(code: string, message: string, options?: { key?: string; cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = 'StorageError';
    this.code = code;
    if (options?.key !== undefined) this.key = options.key;
  }
}

export class ObjectNotFoundError extends StorageError {
  constructor(key: string) {
    super('not_found', `No object at key "${key}".`, { key });
    this.name = 'ObjectNotFoundError';
  }
}
