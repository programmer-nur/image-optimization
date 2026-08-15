import { describe, expect, it } from 'vitest';
import { AssetStatus } from './generated/enums.js';
import {
  FAILURE_REASONS,
  IllegalStatusTransition,
  REJECTION_REASONS,
  SERVABLE_STATUSES,
  TERMINAL_STATUSES,
  assertTransition,
  canTransition,
} from './status.js';
import { isAssetId, isUploadId, newAssetId, newUploadId } from './ids.js';

describe('status transitions', () => {
  it('allows the happy path', () => {
    expect(canTransition(AssetStatus.pending_upload, AssetStatus.stored)).toBe(true);
    expect(canTransition(AssetStatus.stored, AssetStatus.ready)).toBe(true);
  });

  it('allows a source replacement before processing finishes', () => {
    // The self-transition means "a new version arrived".
    expect(canTransition(AssetStatus.stored, AssetStatus.stored)).toBe(true);
    expect(canTransition(AssetStatus.ready, AssetStatus.stored)).toBe(true);
  });

  it('allows recovery from failure', () => {
    expect(canTransition(AssetStatus.failed, AssetStatus.stored)).toBe(true);
    expect(canTransition(AssetStatus.failed, AssetStatus.ready)).toBe(true);
  });

  it('treats rejection as terminal', () => {
    // Retrying cannot help: the bytes themselves were refused.
    expect(canTransition(AssetStatus.rejected, AssetStatus.ready)).toBe(false);
    expect(canTransition(AssetStatus.rejected, AssetStatus.stored)).toBe(false);
    expect(canTransition(AssetStatus.rejected, AssetStatus.deleted)).toBe(true);
  });

  it('never revives a deleted asset', () => {
    for (const target of Object.values(AssetStatus)) {
      expect(canTransition(AssetStatus.deleted, target)).toBe(false);
    }
  });

  it('allows deletion from every non-deleted state', () => {
    for (const from of Object.values(AssetStatus)) {
      if (from === AssetStatus.deleted) continue;
      expect(canTransition(from, AssetStatus.deleted), `from ${from}`).toBe(true);
    }
  });

  it('throws with both states named', () => {
    expect(() => assertTransition(AssetStatus.rejected, AssetStatus.ready)).toThrow(
      IllegalStatusTransition,
    );
    expect(() => assertTransition(AssetStatus.rejected, AssetStatus.ready)).toThrow(
      /rejected.*ready/,
    );
  });

  it('classifies servable and terminal states', () => {
    expect(SERVABLE_STATUSES).toContain(AssetStatus.ready);
    expect(SERVABLE_STATUSES).not.toContain(AssetStatus.pending_upload);
    expect(TERMINAL_STATUSES).toContain(AssetStatus.rejected);
  });

  it('keeps reason codes machine-readable', () => {
    // These become metric dimensions, so they must stay enumerable rather than free text.
    for (const reason of [...REJECTION_REASONS, ...FAILURE_REASONS]) {
      expect(reason).toMatch(/^[a-z_]+$/);
    }
  });
});

describe('identifiers', () => {
  it('produces prefixed, URL-safe ids', () => {
    const id = newAssetId();

    expect(id.startsWith('img_')).toBe(true);
    expect(encodeURIComponent(id)).toBe(id);
  });

  it('sorts lexicographically by creation time', () => {
    // ULID ordering is what makes `ORDER BY id` chronological and keeps index
    // inserts append-mostly instead of scattering like UUIDv4.
    const earlier = newAssetId(1_700_000_000_000);
    const later = newAssetId(1_800_000_000_000);

    expect(later > earlier).toBe(true);
  });

  it('avoids ambiguous base32 characters', () => {
    for (let i = 0; i < 50; i++) {
      expect(newAssetId().slice(4)).not.toMatch(/[ilou]/);
    }
  });

  it('validates its own ids', () => {
    expect(isAssetId(newAssetId())).toBe(true);
    expect(isUploadId(newUploadId())).toBe(true);
  });

  it('rejects foreign or malformed ids', () => {
    expect(isAssetId('img_short')).toBe(false);
    expect(isAssetId(newUploadId())).toBe(false);
    expect(isAssetId('../../etc/passwd')).toBe(false);
  });

  it('is unique across rapid generation', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newAssetId()));
    expect(ids.size).toBe(1000);
  });
});
