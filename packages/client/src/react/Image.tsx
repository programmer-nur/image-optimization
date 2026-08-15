/**
 * The image component.
 *
 * Renders a plain `<img>`. No `<picture>`, no per-format `<source>` elements: format
 * negotiation happens server-side from `Accept`, so one URL serves AVIF, WebP, or
 * JPEG according to what the viewer supports. A browser that gains AVIF support
 * later starts receiving AVIF with no change here. `<picture>` remains available for
 * art direction, which is the case it actually exists for — see `Picture`.
 *
 * Nothing in this file uses state or effects, so it renders on a server, streams,
 * and ships no JavaScript to the client.
 */

import type { CSSProperties, ImgHTMLAttributes, JSX } from 'react';
import type { ImageClient, RenderableImage } from '../client.js';
import type { SrcsetOptions } from '../srcset.js';
import type { ImageAsset } from '../types.js';

type ImgProps = Omit<
  ImgHTMLAttributes<HTMLImageElement>,
  'src' | 'srcSet' | 'sizes' | 'width' | 'height' | 'loading' | 'placeholder'
>;

export interface ImageProps extends ImgProps {
  client: ImageClient;
  asset: ImageAsset;
  /** How the image will render. Omitting it makes the browser assume `100vw`. */
  sizes?: string;
  alt?: string;
  /**
   * Above-the-fold. Loads eagerly, hints high fetch priority, and can be paired with
   * a preload link. Use it for the LCP element and essentially nothing else — marking
   * everything priority is the same as marking nothing.
   */
  priority?: boolean;
  /** Blur-up from the stored placeholder, a flat dominant color, or nothing. */
  placeholder?: 'blur' | 'color' | 'none';
  /** Used when the source has not been measured yet, to reserve layout space. */
  aspectRatio?: number;
  transform?: SrcsetOptions;
}

/**
 * Background styling for the placeholder.
 *
 * The LQIP is roughly 24 pixels wide, so scaling it to cover produces the blur for
 * free — no filter, no second element, and no extra network request, because the
 * bytes arrived inline with the asset metadata.
 *
 * Nothing clears it on load, deliberately: an `<img>` paints its content over its own
 * background, so the placeholder disappears on its own. Clearing it would require
 * state, which would make this a client component and ship JavaScript for an effect
 * the browser already performs. The visible consequence is that a transparent PNG
 * shows the placeholder through its transparent regions.
 */
function placeholderStyle(
  image: RenderableImage,
  mode: ImageProps['placeholder'],
): CSSProperties | undefined {
  if (mode === 'none' || mode === undefined) return undefined;

  if (mode === 'blur' && image.lqip !== null) {
    return {
      backgroundImage: `url(${image.lqip})`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      backgroundRepeat: 'no-repeat',
    };
  }

  if (image.dominantColor !== null) {
    return { backgroundColor: image.dominantColor };
  }

  return undefined;
}

/**
 * Dimension attributes.
 *
 * Always emitted when known: `width` and `height` let the browser reserve layout
 * space before any bytes arrive, and their absence is the usual cause of cumulative
 * layout shift — a Core Web Vital, not a nicety. When the source has not been
 * measured yet, `aspectRatio` covers the same ground through CSS.
 */
function dimensions(
  image: RenderableImage,
  aspectRatio: number | undefined,
): { width?: number; height?: number; style?: CSSProperties } {
  if (image.width !== null && image.height !== null) {
    return { width: image.width, height: image.height };
  }
  if (aspectRatio !== undefined) {
    return { style: { aspectRatio: String(aspectRatio), width: '100%' } };
  }
  return {};
}

export function Image({
  client,
  asset,
  sizes,
  alt,
  priority = false,
  placeholder = 'blur',
  aspectRatio,
  transform = {},
  style,
  ...rest
}: ImageProps): JSX.Element | null {
  // `sizes` is forwarded into candidate selection, not just onto the element: it is
  // what distinguishes a viewport-scaled image (device rungs) from a fixed-size one
  // (icon rungs at 1x and 2x).
  const image = client.forAsset(asset, {
    ...transform,
    ...(sizes !== undefined ? { sizes } : {}),
  });
  // Nothing renderable yet — still uploading, still processing, or deleted. Returning
  // null beats rendering a broken image element.
  if (image === null) return null;

  const box = dimensions(image, aspectRatio);

  return (
    <img
      {...rest}
      src={image.src}
      srcSet={image.srcset}
      {...(sizes !== undefined ? { sizes } : {})}
      alt={alt ?? image.alt}
      {...(box.width !== undefined ? { width: box.width, height: box.height } : {})}
      // Eager plus a high priority hint for the LCP element; everything else defers
      // until it is near the viewport.
      loading={priority ? 'eager' : 'lazy'}
      fetchPriority={priority ? 'high' : 'auto'}
      // Off the main thread, so decoding a large image cannot jank scrolling.
      decoding="async"
      style={{ ...placeholderStyle(image, placeholder), ...box.style, ...style }}
    />
  );
}

export interface PreloadProps {
  client: ImageClient;
  asset: ImageAsset;
  sizes?: string;
  transform?: SrcsetOptions;
}

/**
 * A preload hint for the LCP image.
 *
 * `imagesrcset` and `imagesizes` matter: without them the browser preloads whatever
 * `href` names, then the `<img>` selects a different candidate and the preload is
 * wasted bytes rather than a saving. With them, the preloaded candidate is the one
 * actually used.
 *
 * **On React 19 this is usually unnecessary.** React emits its own
 * `<link rel="preload" as="image">` for any image rendered with
 * `fetchPriority="high"`, carrying the same `srcset` and `sizes` — so `<Image
 * priority sizes=... />` alone already produces the hint, and adding this beside it
 * ships the same hint twice. It remains useful on React 18, and for preloading an
 * image that is not rendered by this component.
 *
 * React hoists `<link>` into `<head>` wherever it is rendered, so this can sit next
 * to the image. On React 18 and below, use `preloadLinkProps` and place it yourself.
 */
export function ImagePreload({
  client,
  asset,
  sizes,
  transform,
}: PreloadProps): JSX.Element | null {
  const props = preloadLinkProps({
    client,
    asset,
    ...(sizes !== undefined ? { sizes } : {}),
    ...(transform !== undefined ? { transform } : {}),
  });
  if (props === null) return null;

  return <link {...props} />;
}

/** The same hint as plain props, for frameworks that manage `<head>` themselves. */
export function preloadLinkProps({ client, asset, sizes, transform = {} }: PreloadProps): {
  rel: 'preload';
  as: 'image';
  href: string;
  imageSrcSet: string;
  imageSizes?: string;
} | null {
  const image = client.forAsset(asset, {
    ...transform,
    ...(sizes !== undefined ? { sizes } : {}),
  });
  if (image === null) return null;

  return {
    rel: 'preload',
    as: 'image',
    href: image.src,
    imageSrcSet: image.srcset,
    ...(sizes !== undefined ? { imageSizes: sizes } : {}),
  };
}
