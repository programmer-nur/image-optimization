/**
 * Art direction.
 *
 * `<picture>` is *not* how this service does AVIF and WebP fallback — that happens
 * server-side from `Accept`, on a single URL, with no markup branching. Reaching for
 * `<picture>` to list formats would give up that advantage and freeze the format
 * choice into every page's HTML.
 *
 * What `<picture>` is genuinely for is art direction: a different *crop* at different
 * breakpoints, such as a wide banner on desktop and a square on mobile. That is a
 * different image, not a different encoding of the same one, and it cannot be
 * expressed by `srcset` alone.
 */

import type { ImgHTMLAttributes, JSX } from 'react';
import type { ImageClient } from '../client.js';
import type { SrcsetOptions } from '../srcset.js';
import type { ImageAsset } from '../types.js';

export interface ArtDirectedSource {
  /** e.g. `(max-width: 768px)`. Evaluated in order; the first match wins. */
  media: string;
  /** The crop for this breakpoint — typically a different width/height ratio. */
  transform: SrcsetOptions;
  sizes?: string;
}

export interface PictureProps extends Omit<
  ImgHTMLAttributes<HTMLImageElement>,
  'src' | 'srcSet' | 'sizes'
> {
  client: ImageClient;
  asset: ImageAsset;
  /** Ordered; the browser takes the first whose media query matches. */
  sources: ArtDirectedSource[];
  /** The fallback `<img>`, used when no source matches. */
  fallback?: SrcsetOptions;
  sizes?: string;
  alt?: string;
  priority?: boolean;
}

export function Picture({
  client,
  asset,
  sources,
  fallback = {},
  sizes,
  alt,
  priority = false,
  ...rest
}: PictureProps): JSX.Element | null {
  const base = client.forAsset(asset, fallback);
  if (base === null) return null;

  return (
    <picture>
      {sources.map((source) => {
        const rendered = client.forAsset(asset, source.transform);
        if (rendered === null) return null;

        return (
          <source
            key={source.media}
            media={source.media}
            srcSet={rendered.srcset}
            {...(source.sizes !== undefined ? { sizes: source.sizes } : {})}
          />
        );
      })}
      <img
        {...rest}
        src={base.src}
        srcSet={base.srcset}
        {...(sizes !== undefined ? { sizes } : {})}
        alt={alt ?? base.alt}
        {...(base.width !== null && base.height !== null
          ? { width: base.width, height: base.height }
          : {})}
        loading={priority ? 'eager' : 'lazy'}
        fetchPriority={priority ? 'high' : 'auto'}
        decoding="async"
      />
    </picture>
  );
}
