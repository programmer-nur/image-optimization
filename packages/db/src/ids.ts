/**
 * Identifier generation.
 *
 * ULIDs rather than UUIDs: they are lexicographically sortable by creation time,
 * which makes `ORDER BY id` free and keeps B-tree inserts append-mostly instead of
 * scattering across the index the way random UUIDv4 does. They are also Crockford
 * base32 — no hyphens, no case ambiguity, safe in a URL path segment without
 * encoding, which matters because the asset id *is* part of the public delivery URL.
 */

import { ulid } from 'ulidx';

/** Prefixes make an id self-describing in logs and error reports. */
const ASSET_PREFIX = 'img_';
const UPLOAD_PREFIX = 'upl_';
const KEY_PREFIX = 'key_';

export function newAssetId(seedTime?: number): string {
  return `${ASSET_PREFIX}${ulid(seedTime).toLowerCase()}`;
}

export function newUploadId(seedTime?: number): string {
  return `${UPLOAD_PREFIX}${ulid(seedTime).toLowerCase()}`;
}

export function newApiKeyId(seedTime?: number): string {
  return `${KEY_PREFIX}${ulid(seedTime).toLowerCase()}`;
}

/** Crockford base32 excludes I, L, O, and U to avoid transcription ambiguity. */
const ULID_BODY = /^[0-9abcdefghjkmnpqrstvwxyz]{26}$/;

export function isAssetId(value: string): boolean {
  return value.startsWith(ASSET_PREFIX) && ULID_BODY.test(value.slice(ASSET_PREFIX.length));
}

export function isUploadId(value: string): boolean {
  return value.startsWith(UPLOAD_PREFIX) && ULID_BODY.test(value.slice(UPLOAD_PREFIX.length));
}
