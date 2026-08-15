/**
 * The configured client.
 *
 * A small object rather than a module-level singleton, so one process can render for
 * two deployments — a migration, a preview environment, a multi-brand server — which
 * a global would quietly make impossible.
 */

import { resolveConfig, type ClientConfig, type ResolvedConfig } from './config.js';
import { baseUrl, buildUrl, withTransform, type AssetRef, type TransformOptions } from './url.js';
import { buildSrcset, defaultWidth, sizes, type SizesInput, type SrcsetOptions } from './srcset.js';
import type { ImageAsset } from './types.js';

export interface ImageClient {
  readonly config: ResolvedConfig;

  /** Base delivery URL for a version, with no transform parameters. */
  base(asset: AssetRef): string;
  /** A single delivery URL. */
  url(asset: AssetRef, options?: TransformOptions): string;
  /** Ladder-aligned candidates, capped at the source width when known. */
  srcset(asset: AssetRef, options?: SrcsetOptions): string;
  /** `sizes` attribute from a media-query list. */
  sizes(input: SizesInput): string;

  /**
   * Everything needed to render one asset, derived from the API envelope.
   *
   * Prefer this over the primitives: it reads the intrinsic width off the asset and
   * caps the candidate set, which is the step most easily forgotten by hand.
   */
  forAsset(asset: ImageAsset, options?: SrcsetOptions): RenderableImage | null;

  /** Appends transform parameters to a base URL the API already produced. */
  fromBase(base: string, options?: TransformOptions): string;
}

export interface RenderableImage {
  src: string;
  srcset: string;
  /** Intrinsic dimensions, when the source has been measured. */
  width: number | null;
  height: number | null;
  /** Base64 placeholder, or null. */
  lqip: string | null;
  dominantColor: string | null;
  alt: string;
}

export function createImageClient(config: ClientConfig): ImageClient {
  const resolved = resolveConfig(config);

  return {
    config: resolved,

    base: (asset) => baseUrl(resolved, asset),
    url: (asset, options = {}) => buildUrl(resolved, asset, options),
    srcset: (asset, options = {}) => buildSrcset(resolved, asset, options),
    sizes,

    fromBase: (base, options = {}) => withTransform(base, options, resolved.defaultQuality),

    forAsset(asset, options = {}) {
      if (asset.urls === null) return null;

      const ref: AssetRef = { id: asset.id, version: asset.version };
      const sourceWidth = asset.source?.width ?? undefined;
      const { widths, sizes: sizesValue, ...transform } = options;

      const src = buildUrl(resolved, ref, {
        ...transform,
        width: options.width ?? defaultWidth(sourceWidth),
      });

      return {
        src,
        srcset: buildSrcset(resolved, ref, {
          ...transform,
          ...(sourceWidth !== undefined ? { sourceWidth } : {}),
          ...(widths !== undefined ? { widths } : {}),
          ...(sizesValue !== undefined ? { sizes: sizesValue } : {}),
        }),
        width: asset.source?.width ?? null,
        height: asset.source?.height ?? null,
        lqip: asset.lqip,
        dominantColor: asset.source?.dominantColor ?? null,
        alt: asset.altText ?? '',
      };
    },
  };
}
