/**
 * API key primitives.
 *
 * A key is `img_<keyId>_<secret>`: the id half is indexed for an O(1) lookup, the
 * secret half is 32 bytes of entropy. Only a hash of the whole key is stored, and
 * verification is a timing-safe compare — so a database leak does not hand out
 * working keys, and comparison time does not reveal how much of a guess was right.
 *
 * At 256 bits of entropy a per-key random salt buys little against brute force, so
 * the stored hash is a plain SHA-256; the value being protected is high-entropy by
 * construction rather than a human-chosen password.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { newApiKeyId } from '@imgopt/db';

const KEY_PREFIX = 'imgk';

export interface GeneratedKey {
  /** Shown to the caller exactly once. Never stored. */
  plaintext: string;
  /** Row id, embedded in the key for lookup. */
  keyId: string;
  /** What is persisted. */
  hash: string;
}

export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

export function generateApiKey(): GeneratedKey {
  const keyId = newApiKeyId();
  // Hex rather than base64url so the secret never contains the `_` separator.
  const secret = randomBytes(32).toString('hex');
  const plaintext = `${KEY_PREFIX}_${keyId}_${secret}`;
  return { plaintext, keyId, hash: hashApiKey(plaintext) };
}

/** Extracts the row id from a presented key without trusting the rest of it. */
export function keyIdFromPlaintext(plaintext: string): string | undefined {
  const parts = plaintext.split('_');
  // imgk _ key _ <ulid> _ secret  -> the id is "key_<ulid>"
  if (parts.length < 4 || parts[0] !== KEY_PREFIX) return undefined;
  return `${parts[1]}_${parts[2]}`;
}

/** Constant-time comparison of two hex digests of equal length. */
export function hashesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}
