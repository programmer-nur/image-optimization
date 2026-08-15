/**
 * Canonical key construction.
 *
 * The string this module produces is simultaneously the CloudFront cache key and the
 * S3 object key. They are the same value by construction rather than kept in sync by
 * convention — if they could drift, CloudFront would cache one path while the
 * generator wrote another, and every request would miss forever without raising a
 * single error. See design.md D3 and D4.
 *
 * Readable rather than hashed, so a stored object can be understood at a glance
 * during an incident — and reversible, because the generator reconstructs its work
 * from the key alone. `parseVariantName` at the bottom of this file is the inverse,
 * and the two are expected to stay exact inverses of each other.
 */

import type { TransformSpec } from './transform-spec.js';
import { EXTENSION_FORMATS, FORMAT_EXTENSIONS } from './formats.js';
import {
  BLUR_LEVELS,
  CROP_GRAVITIES,
  DEFAULT_GRAVITY,
  FIT_MODES,
  SHARPEN_LEVELS,
  type BlurLevel,
  type CropGravity,
  type FitMode,
  type SharpenLevel,
  fitCrops,
  fitUsesBackground,
} from './effects.js';
import { QUALITY_LEVELS, type QualityLevel } from './quality.js';

export const DERIVED_PREFIX = 'derived';
export const ORIGINAL_PREFIX = 'original';
export const MASTER_PREFIX = 'master';
export const STAGING_PREFIX = 'staging';

/** Width token used when no width was requested — the source's own dimensions. */
const FULL_WIDTH_TOKEN = 'full';

/**
 * Serializes the rare-parameter tail. Order is fixed, so the token is stable.
 *
 * Reversible by construction rather than hashed. The generator is handed nothing but
 * the canonical path — the edge drops the query string, and the delivery plane never
 * queries the database — so a one-way token would leave it knowing that extras
 * existed but not which, unable to produce the bytes its own key names.
 *
 * Length stays bounded without hashing because every value here is already
 * quantized: gravity is an enum, background is 6 or 8 hex digits, and both effects
 * are single levels. The worst possible tail is under 30 characters, which also
 * leaves the key fully self-describing during incident response — the reason the
 * readable form was chosen in the first place.
 */
function extrasTokens(spec: TransformSpec): string[] {
  const parts: string[] = [];
  if (spec.gravity !== undefined) parts.push(`g${spec.gravity}`);
  if (spec.background !== undefined) parts.push(`bg${spec.background}`);
  if (spec.blur !== undefined) parts.push(`bl${spec.blur}`);
  if (spec.sharpen !== undefined) parts.push(`sh${spec.sharpen}`);
  return parts;
}

/**
 * Builds the variant filename, e.g. `w640_h360_cover_q75.avif`.
 *
 * Token order is fixed and every token is quantized, so any two requests that
 * produce identical pixels produce this identical string.
 */
export function toVariantName(spec: TransformSpec): string {
  const parts: string[] = [];

  if (spec.width !== undefined) parts.push(`w${spec.width}`);
  if (spec.height !== undefined) parts.push(`h${spec.height}`);
  if (parts.length === 0) parts.push(FULL_WIDTH_TOKEN);

  if (spec.fit !== undefined) parts.push(spec.fit);
  parts.push(`q${spec.quality}`);
  parts.push(...extrasTokens(spec));

  return `${parts.join('_')}.${FORMAT_EXTENSIONS[spec.format]}`;
}

/**
 * The version path segment.
 *
 * Carries two independent numbers. `assetVersion` advances when source bytes are
 * replaced. `encoderEpoch` is deployment-wide and advances when encoder policy
 * changes — bumping it mints a fresh URL space for every asset at once, with no
 * per-asset write and no CDN invalidation. That second mechanism is what makes
 * `Cache-Control: immutable` safe to promise. See design.md D8.
 */
export function toVersionSegment(assetVersion: number, encoderEpoch: number): string {
  return `v${assetVersion}-${encoderEpoch}`;
}

export interface KeyParts {
  assetId: string;
  assetVersion: number;
  encoderEpoch: number;
  spec: TransformSpec;
}

/** Full S3 key for a derivative, identical to the rewritten CloudFront path. */
export function toCanonicalKey({ assetId, assetVersion, encoderEpoch, spec }: KeyParts): string {
  const version = toVersionSegment(assetVersion, encoderEpoch);
  return `${DERIVED_PREFIX}/${assetId}/${version}/${toVariantName(spec)}`;
}

/** Immutable source key. Written exactly once, never read-modify-written. */
export function toOriginalKey(assetId: string, assetVersion: number, extension: string): string {
  return `${ORIGINAL_PREFIX}/${assetId}/${assetVersion}/source.${extension}`;
}

/**
 * Prefix holding one version's original.
 *
 * The generator needs this because it cannot construct the original's key directly:
 * the extension depends on the uploaded format, and the delivery path has no
 * database to ask. Listing the prefix costs one call and keeps that lookup off
 * PostgreSQL.
 */
export function toOriginalPrefix(assetId: string, assetVersion: number): string {
  return `${ORIGINAL_PREFIX}/${assetId}/${assetVersion}/`;
}

/** Bounded intermediate for very large sources. Never served to clients. */
export function toMasterKey(assetId: string, assetVersion: number): string {
  return `${MASTER_PREFIX}/${assetId}/${assetVersion}/master.webp`;
}

/** Untrusted upload location. Private, CDN-unreachable, lifecycle-expired. */
export function toStagingKey(uploadId: string): string {
  return `${STAGING_PREFIX}/${uploadId}`;
}

/** Prefix covering every object of one asset version, for version-scoped cleanup. */
export function toDerivedPrefix(
  assetId: string,
  assetVersion: number,
  encoderEpoch: number,
): string {
  return `${DERIVED_PREFIX}/${assetId}/${toVersionSegment(assetVersion, encoderEpoch)}/`;
}

/* -------------------------------------------------------------------------- *
 * The inverse.
 *
 * The generator is invoked by CloudFront origin failover with the rewritten path
 * and nothing else: no query string, no asset metadata, no database. Everything it
 * needs to reproduce the named bytes therefore has to be recoverable from the key,
 * which is why the extras token above is reversible.
 * -------------------------------------------------------------------------- */

export type KeyParseResult =
  | { ok: true; parts: KeyParts }
  | { ok: false; reason: 'malformed_path' | 'malformed_version' | 'malformed_variant' };

export type VariantParseResult =
  { ok: true; spec: TransformSpec } | { ok: false; reason: 'malformed_variant' };

const HEX_COLOR = /^([0-9a-f]{6}|[0-9a-f]{8})$/;

function isMember<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value);
}

function parseLevel<T extends number>(levels: readonly T[], raw: string): T | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return levels.find((level) => level === value);
}

/** Positive integer, no leading zeros — the only form `toVariantName` ever emits. */
function parseDimension(raw: string): number | undefined {
  if (!/^[1-9]\d*$/.test(raw)) return undefined;
  return Number(raw);
}

/**
 * Whether a spec is free of inert parameters, mirroring the elision rules in
 * `parseTransform`.
 *
 * Round-tripping through `toVariantName` catches malformed and misordered keys, but
 * not keys that are well-formed and merely *inert* — `_bl0`, `_gcenter`, a
 * background on a fit that never pads. Those serialize back to themselves happily,
 * so they need their own check. Left unguarded they are a cache-fragmentation hole
 * of exactly the kind bucketing exists to close: several distinct keys, all holding
 * byte-identical output, each costing its own generation and its own object.
 */
function isFreeOfInertParameters(spec: TransformSpec): boolean {
  const boxConstrained = spec.width !== undefined && spec.height !== undefined;
  if ((spec.fit !== undefined) !== boxConstrained) return false;

  if (spec.gravity !== undefined) {
    if (spec.fit === undefined || !fitCrops(spec.fit)) return false;
    if (spec.gravity === DEFAULT_GRAVITY) return false;
  }

  if (spec.background !== undefined) {
    if (spec.fit === undefined || !fitUsesBackground(spec.fit)) return false;
  }

  if (spec.blur !== undefined && spec.blur === 0) return false;
  if (spec.sharpen !== undefined && spec.sharpen === 0) return false;

  return true;
}

/**
 * Parses a variant filename back into the spec that produced it.
 *
 * Deliberately strict. Beyond per-token validation the result must clear two gates:
 * it must be free of inert parameters, and re-serializing it must reproduce the
 * input byte for byte. The re-serialization gate subsumes a pile of individual
 * checks — duplicated tokens, tokens out of order, a width with a leading zero — and
 * guarantees the property the generator depends on, which is that the key it writes
 * to is the key it was asked for. A forged path that merely looks plausible is
 * rejected rather than silently materialized as an object.
 */
export function parseVariantName(name: string): VariantParseResult {
  const reject = { ok: false, reason: 'malformed_variant' } as const;

  const dot = name.lastIndexOf('.');
  if (dot <= 0) return reject;

  const format = EXTENSION_FORMATS[name.slice(dot + 1)];
  if (format === undefined) return reject;

  const tokens = name.slice(0, dot).split('_');
  if (tokens.length === 0) return reject;

  let width: number | undefined;
  let height: number | undefined;
  let fit: FitMode | undefined;
  let quality: QualityLevel | undefined;
  let gravity: CropGravity | undefined;
  let background: string | undefined;
  let blur: BlurLevel | undefined;
  let sharpen: SharpenLevel | undefined;

  for (const token of tokens) {
    if (token === FULL_WIDTH_TOKEN) continue;

    if (token.startsWith('bg')) {
      const hex = token.slice(2);
      if (!HEX_COLOR.test(hex)) return reject;
      background = hex;
      continue;
    }
    if (token.startsWith('bl')) {
      blur = parseLevel(BLUR_LEVELS, token.slice(2));
      if (blur === undefined) return reject;
      continue;
    }
    if (token.startsWith('sh')) {
      sharpen = parseLevel(SHARPEN_LEVELS, token.slice(2));
      if (sharpen === undefined) return reject;
      continue;
    }
    if (token.startsWith('w')) {
      width = parseDimension(token.slice(1));
      if (width === undefined) return reject;
      continue;
    }
    if (token.startsWith('h')) {
      height = parseDimension(token.slice(1));
      if (height === undefined) return reject;
      continue;
    }
    if (token.startsWith('q')) {
      quality = parseLevel(QUALITY_LEVELS, token.slice(1));
      if (quality === undefined) return reject;
      continue;
    }
    if (token.startsWith('g')) {
      const value = token.slice(1);
      if (!isMember(CROP_GRAVITIES, value)) return reject;
      gravity = value;
      continue;
    }
    if (isMember(FIT_MODES, token)) {
      fit = token;
      continue;
    }
    return reject;
  }

  if (quality === undefined) return reject;

  const spec: TransformSpec = { format, quality };
  if (width !== undefined) spec.width = width;
  if (height !== undefined) spec.height = height;
  if (fit !== undefined) spec.fit = fit;
  if (gravity !== undefined) spec.gravity = gravity;
  if (background !== undefined) spec.background = background;
  if (blur !== undefined) spec.blur = blur;
  if (sharpen !== undefined) spec.sharpen = sharpen;

  if (!isFreeOfInertParameters(spec)) return reject;

  return toVariantName(spec) === name ? { ok: true, spec } : reject;
}

/** Parses `v{assetVersion}-{encoderEpoch}`. */
export function parseVersionSegment(
  segment: string,
): { assetVersion: number; encoderEpoch: number } | undefined {
  const match = /^v(\d+)-(\d+)$/.exec(segment);
  if (match === null) return undefined;
  return { assetVersion: Number(match[1]), encoderEpoch: Number(match[2]) };
}

/**
 * Parses a full derivative key, with or without a leading slash.
 *
 * The asset id is accepted as an opaque token rather than validated as a ULID: the
 * generator's authority for whether an asset exists is storage, not string shape,
 * and an unknown id simply finds no source.
 */
export function parseCanonicalKey(key: string): KeyParseResult {
  const segments = key.replace(/^\//, '').split('/');
  if (segments.length !== 4) return { ok: false, reason: 'malformed_path' };

  const [prefix, assetId, version, variant] = segments as [string, string, string, string];
  if (prefix !== DERIVED_PREFIX || assetId === '') return { ok: false, reason: 'malformed_path' };

  const parsedVersion = parseVersionSegment(version);
  if (parsedVersion === undefined) return { ok: false, reason: 'malformed_version' };

  const parsedVariant = parseVariantName(variant);
  if (!parsedVariant.ok) return { ok: false, reason: 'malformed_variant' };

  return {
    ok: true,
    parts: {
      assetId,
      assetVersion: parsedVersion.assetVersion,
      encoderEpoch: parsedVersion.encoderEpoch,
      spec: parsedVariant.spec,
    },
  };
}
