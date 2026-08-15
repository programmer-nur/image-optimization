/**
 * Next.js integration.
 *
 * A custom loader keeps `next/image`'s layout, lazy-loading, and placeholder
 * behaviour while delegating the actual optimization to this service — which also
 * takes image transformation off the Next.js server entirely. On a serverless
 * deployment that is a real saving: `next/image`'s built-in optimizer runs per
 * request in the application's own function.
 *
 * No `next` import. The loader signature is three fields, so declaring it here keeps
 * this subpath dependency-free and usable from any Next version.
 */

import { DEVICE_WIDTHS, ICON_WIDTHS, LADDER } from '@imgopt/core';
import { resolveConfig, type ClientConfig } from '../config.js';
import { withTransform } from '../url.js';

/** Structurally identical to Next's `ImageLoaderProps`. */
export interface ImageLoaderProps {
  src: string;
  width: number;
  quality?: number;
}

export type ImageLoader = (props: ImageLoaderProps) => string;

/**
 * Device and image sizes aligned to the ladder.
 *
 * Next asks the loader for widths drawn from these two lists. Left at Next's
 * defaults, it would request widths like 384, 768, and 1200 — the service snaps
 * those up, so the URLs still resolve, but the width Next advertised in the `srcset`
 * descriptor is not the width the object holds. The browser then chooses a candidate
 * using a number that is wrong by up to a full rung.
 *
 * Aligning both lists removes the mismatch: every width Next asks for is a width the
 * service already buckets to.
 *
 *   // next.config.js
 *   images: { loader: 'custom', loaderFile: './imgopt-loader.js', ...imageSizes }
 */
export const nextImageSizes = {
  /** Used for `sizes` values expressed in viewport widths. */
  deviceSizes: [...DEVICE_WIDTHS],
  /** Used for fixed-size and small images. */
  imageSizes: [...ICON_WIDTHS],
} as const;

export interface NextLoaderConfig extends ClientConfig {
  /**
   * Prepended when `src` is a bare path.
   *
   * `next/image` passes `src` through from the component, which is usually a
   * root-relative path. Anything already absolute is used as-is.
   */
  basePath?: string;
}

/**
 * Builds the loader.
 *
 * `src` is expected to be a delivery path or URL — `/i/{assetId}/{version}/{slug}` —
 * because that is what the API hands back. The loader's only job is to append the
 * width and quality Next asked for.
 */
export function createNextLoader(config: NextLoaderConfig): ImageLoader {
  const resolved = resolveConfig(config);
  const basePath = (config.basePath ?? '').replace(/\/+$/, '');

  return ({ src, width, quality }) => {
    const absolute = /^https?:\/\//.test(src)
      ? src
      : `${resolved.origin}${basePath}${src.startsWith('/') ? '' : '/'}${src}`;

    return withTransform(
      absolute,
      { width, ...(quality !== undefined ? { quality } : {}) },
      resolved.defaultQuality,
    );
  };
}

/**
 * Whether a width is a ladder rung.
 *
 * Exported for the consumer's own tests: a `next.config` that drifts off
 * `nextImageSizes` reintroduces the descriptor mismatch above, and nothing at
 * runtime will complain about it.
 */
export function isLadderWidth(width: number): boolean {
  return LADDER.includes(width);
}
