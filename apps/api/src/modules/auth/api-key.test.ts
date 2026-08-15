import { describe, expect, it } from 'vitest';
import { generateApiKey, hashApiKey, hashesMatch, keyIdFromPlaintext } from './api-key.js';

describe('generateApiKey', () => {
  it('embeds a lookupable id and stores only a hash', () => {
    const key = generateApiKey();

    expect(key.plaintext.startsWith('imgk_')).toBe(true);
    expect(keyIdFromPlaintext(key.plaintext)).toBe(key.keyId);
    // The stored value is a hash, never the plaintext.
    expect(key.hash).not.toContain(key.plaintext);
    expect(key.hash).toBe(hashApiKey(key.plaintext));
  });

  it('produces distinct keys', () => {
    const keys = new Set(Array.from({ length: 100 }, () => generateApiKey().plaintext));
    expect(keys.size).toBe(100);
  });

  it('uses hex secrets so the separator never appears in the secret', () => {
    const key = generateApiKey();
    const secret = key.plaintext.slice(`imgk_${key.keyId}_`.length);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('keyIdFromPlaintext', () => {
  it('recovers the id regardless of the secret', () => {
    const key = generateApiKey();
    expect(keyIdFromPlaintext(key.plaintext)).toBe(key.keyId);
  });

  it('rejects malformed keys', () => {
    expect(keyIdFromPlaintext('nonsense')).toBeUndefined();
    expect(keyIdFromPlaintext('imgk_only')).toBeUndefined();
    expect(keyIdFromPlaintext('wrong_key_01hxxx_secret')).toBeUndefined();
  });
});

describe('hashesMatch', () => {
  it('matches identical hashes', () => {
    const hash = hashApiKey('imgk_key_abc_secret');
    expect(hashesMatch(hash, hash)).toBe(true);
  });

  it('rejects different hashes', () => {
    expect(hashesMatch(hashApiKey('a'), hashApiKey('b'))).toBe(false);
  });

  it('rejects empty or mismatched-length input without throwing', () => {
    expect(hashesMatch('', '')).toBe(false);
    expect(hashesMatch('abcd', 'abcdef')).toBe(false);
  });
});
