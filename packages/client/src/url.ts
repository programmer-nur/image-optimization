/**
 * Delivery URL construction.
 *
 * The browser-side twin of the API's `DeliveryService`. Both exist so a consumer
 * never hand-writes a delivery URL and drifts off the ladder — a hand-written
 * `?w=602` still works, but it snaps to 640 at the edge and the extra round trip
 * through normalization is pure waste.
 *
 * Types come from `@imgopt/core`, so a fit mode outside the enum fails to compile
 * rather than producing a URL that is rejected at request time.
 */

import {
  type CropGravity,
  type Dpr,
  type FitMode,
  type RequestedFormat,
  toVersionSegment,
} from '@imgopt/core';
import type { ResolvedConfig } from './config.js';

export interface TransformOptions {
  /** CSS pixels. Snapped up to the ladder by the edge, so any integer is safe. */
  width?: number;
  height?: number;
  /** Nominal, perceptual quality — not a raw codec value. Snapped to the level set. */
  quality?: number;
  /** Only meaningful when both dimensions are given; otherwise elided from the key. */
  fit?: FitMode;
  /** Omit to let the edge negotiate from `Accept`, which is almost always right. */
  format?: RequestedFormat;
  /** Named gravity only. Absolute rectangles go through the authenticated API. */
  crop?: CropGravity;
  /** Hex, with or without `#`. Only meaningful on padding fits. */
  background?: string;
  blur?: number;
  sharpen?: number;
  /** Folded into width at the edge; never its own cache dimension. */
  dpr?: Dpr;
}

export interface AssetRef {
  id: string;
  /** The asset's `version`, not the full version segment. */
  version: number;
  /** Decoration only. Dropped during normalization; never affects the bytes. */
  slug?: string;
}

/**
 * Emitted in this order regardless of the caller's object key order.
 *
 * The edge is order-insensitive, so this does not affect the CDN cache key. It
 * affects the *string*: a server render and a client hydration that disagree on
 * parameter order produce different `src` attributes and React replaces the element,
 * which discards an in-flight or already-decoded image.
 */
const PARAM_ORDER = [
  'w',
  'h',
  'dpr',
  'q',
  'fit',
  'format',
  'crop',
  'background',
  'blur',
  'sharpen',
] as const;

/** Base delivery URL for a version, without any transform parameters. */
export function baseUrl(config: ResolvedConfig, asset: AssetRef): string {
  const version = toVersionSegment(asset.version, config.encoderEpoch);
  const path =
    asset.slug === undefined || asset.slug === ''
      ? `${asset.id}/${version}`
      : `${asset.id}/${version}/${encodeURIComponent(asset.slug)}`;

  return `${config.origin}/i/${path}`;
}

/** Appends transform parameters to any base URL. */
export function withTransform(
  base: string,
  options: TransformOptions,
  defaultQuality?: number,
): string {
  const params: Partial<Record<(typeof PARAM_ORDER)[number], string>> = {};

  if (options.width !== undefined) params.w = String(Math.round(options.width));
  if (options.height !== undefined) params.h = String(Math.round(options.height));
  if (options.dpr !== undefined && options.dpr !== 1) params.dpr = String(options.dpr);

  const quality = options.quality ?? defaultQuality;
  // Elided when it matches the service default: `?q=75` and no `q` normalize to one
  // key, so emitting it only lengthens every URL on the page.
  if (quality !== undefined && quality !== defaultQuality) params.q = String(quality);

  if (options.fit !== undefined) params.fit = options.fit;
  if (options.format !== undefined && options.format !== 'auto') params.format = options.format;
  if (options.crop !== undefined) params.crop = options.crop;
  if (options.background !== undefined) params.background = options.background.replace(/^#/, '');
  if (options.blur !== undefined && options.blur > 0) params.blur = String(options.blur);
  if (options.sharpen !== undefined && options.sharpen > 0) {
    params.sharpen = String(options.sharpen);
  }

  const query = PARAM_ORDER.filter((key) => params[key] !== undefined)
    .map((key) => `${key}=${encodeURIComponent(params[key]!)}`)
    .join('&');

  if (query === '') return base;
  return `${base}${base.includes('?') ? '&' : '?'}${query}`;
}

/** A single delivery URL. */
export function buildUrl(
  config: ResolvedConfig,
  asset: AssetRef,
  options: TransformOptions = {},
): string {
  return withTransform(baseUrl(config, asset), options, config.defaultQuality);
}
