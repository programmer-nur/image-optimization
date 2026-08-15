/**
 * Responsive candidate generation.
 *
 * Two rules, and both are load-bearing:
 *
 * - **Every candidate is a ladder rung**, so whichever one the browser picks maps
 *   directly to a stored object. A candidate off the ladder snaps at the edge to a
 *   different width than the one advertised in the descriptor, which means the
 *   browser chose based on a number that is not what it receives.
 *
 * - **No candidate exceeds the source width.** The edge cannot apply this cap — it
 *   has no asset metadata — so a `?w=3840` against a 2000px source yields an object
 *   keyed `w3840_…` holding 2000px of pixels. Harmless, but it is a wasted bucket and
 *   a wasted generation. The SDK has the metadata, so it is capped here. See D3.
 */

import { DEVICE_WIDTHS, LADDER } from '@imgopt/core';
import type { ResolvedConfig } from './config.js';
import { buildUrl, type AssetRef, type TransformOptions } from './url.js';

export interface SrcsetOptions extends TransformOptions {
  /** Intrinsic width of the source. Candidates stop at the largest rung below it. */
  sourceWidth?: number;
  /**
   * The `sizes` the image will be rendered with.
   *
   * Not emitted here — it selects the *candidate set*. See `candidateWidths`.
   */
  sizes?: string;
  /** Explicit candidate widths, replacing the derived set entirely. */
  widths?: readonly number[];
}

export interface CandidateOptions {
  sourceWidth?: number;
  sizes?: string;
  /** Nominal render width, used only for a fixed-size image. */
  targetWidth?: number;
  widths?: readonly number[];
}

/** Whether `sizes` scales with the viewport, as opposed to naming a fixed size. */
function isResponsive(sizes: string | undefined): boolean {
  // Absent means the browser assumes 100vw, which is responsive.
  if (sizes === undefined || sizes === '') return true;
  return /\d\s*(vw|vh|vmin|vmax|%)/.test(sizes);
}

/**
 * The candidate widths for a source.
 *
 * Emitting every rung at or below the source is correct but wasteful, and the waste
 * is not only markup. Each distinct width a browser actually requests becomes its own
 * generated, stored object — so offering `16w` on a full-bleed hero means some
 * browser, somewhere, eventually causes a 16-pixel hero to be rendered and kept.
 *
 * So the set is chosen the way the browser will use it, which turns on one question:
 *
 * - **Responsive** (`sizes` scales with the viewport, or is absent). The image can
 *   render at any width up to the viewport, so the device rungs apply and the icon
 *   rungs cannot ever be selected. A 3000px source drops from nineteen candidates to
 *   eleven, none of them ones a browser would have picked.
 *
 * - **Fixed** (`sizes` names a length, e.g. `48px`). The render width is known, so
 *   only two candidates are useful: the rung covering 1× and the rung covering 2×,
 *   which is where the icon rungs earn their place. Anything else is dead markup.
 *
 * This mirrors how `next/image` partitions its own `deviceSizes` and `imageSizes`,
 * which is also why the two lists are exported for `next.config`.
 */
export function candidateWidths(options: CandidateOptions = {}): number[] {
  const { sourceWidth, sizes, targetWidth, widths } = options;

  const cap = (candidates: readonly number[]): number[] => {
    if (sourceWidth === undefined) return [...candidates];

    const fitting = candidates.filter((width) => width <= sourceWidth);
    // A source narrower than every rung keeps its own width rather than yielding an
    // empty set: 12 pixels has no sensible bucket, and emitting nothing would leave
    // the browser with only `src`.
    return fitting.length > 0 ? fitting : [sourceWidth];
  };

  if (widths !== undefined) return cap(widths);

  if (isResponsive(sizes)) return cap(DEVICE_WIDTHS);

  // Fixed size: the rung covering the declared width, and the one covering 2× it for
  // high-density displays.
  const target = targetWidth ?? 0;
  const atLeast = (width: number): number | undefined =>
    LADDER.find((rung) => rung >= width) ?? LADDER[LADDER.length - 1];

  const selected = [atLeast(target), atLeast(target * 2)].filter(
    (width): width is number => width !== undefined,
  );

  return cap([...new Set(selected)].sort((a, b) => a - b));
}

/** A `srcset` value: ladder-aligned candidates with `w` descriptors. */
export function buildSrcset(
  config: ResolvedConfig,
  asset: AssetRef,
  options: SrcsetOptions = {},
): string {
  const { sourceWidth, widths, sizes: sizesValue, ...transform } = options;

  /*
   * A candidate set varies the width, so a pinned height has to travel with it.
   *
   * Carrying the caller's `height` unchanged onto every candidate is the subtle
   * version of this bug: a `w=1200,h=800` crop would emit `w=320&h=800`, asking for
   * a portrait 2.5 ratio where a 3:2 landscape was intended. The image still renders
   * and still fills its box, so nothing looks broken until someone notices the
   * mobile breakpoint is cropped differently from the desktop one — and each wrong
   * ratio is its own cache key and its own generation.
   *
   * A height without a width has no ratio to preserve and is left alone; pairing one
   * with a candidate set is not meaningful, since candidates vary the very dimension
   * that was not constrained. Pass both.
   */
  const ratio =
    transform.width !== undefined && transform.height !== undefined
      ? transform.height / transform.width
      : undefined;

  return candidateWidths({
    ...(sourceWidth !== undefined ? { sourceWidth } : {}),
    ...(sizesValue !== undefined ? { sizes: sizesValue } : {}),
    ...(widths !== undefined ? { widths } : {}),
    targetWidth: transform.width ?? defaultWidth(sourceWidth),
  })
    .map((width) => {
      const url = buildUrl(config, asset, {
        ...transform,
        width,
        ...(ratio !== undefined ? { height: Math.round(width * ratio) } : {}),
      });

      // The descriptor is the width the browser reasons about; it must equal the
      // width the URL actually requests.
      return `${url} ${width}w`;
    })
    .join(', ');
}

/**
 * The width to use for `src`.
 *
 * `src` is the fallback for browsers ignoring `srcset` and the value a preload uses
 * when no candidate matches, so it should be a plausible rendering width rather than
 * the largest available. Defaults to the largest rung at or below the source, capped
 * at a sensible display width.
 */
export function defaultWidth(sourceWidth?: number, preferred = 1080): number {
  if (sourceWidth === undefined) return preferred;

  const fitting = LADDER.filter((width) => width <= sourceWidth);
  if (fitting.length === 0) return sourceWidth;

  const capped = fitting.filter((width) => width <= preferred);
  return capped.length > 0 ? capped[capped.length - 1]! : fitting[0]!;
}

export type SizesInput = string | Array<[media: string, size: string]>;

/**
 * Builds a `sizes` attribute.
 *
 * `sizes` tells the browser how wide the image will *render* so it can choose a
 * candidate before layout exists. Omitting it means the browser assumes `100vw` and
 * routinely downloads a candidate several times larger than needed — the single most
 * common way a correct `srcset` still ships too many bytes.
 *
 * Entries are emitted in order and the final bare value is the fallback:
 *
 *   sizes([['(max-width: 768px)', '100vw'], ['', '50vw']])
 *   -> "(max-width: 768px) 100vw, 50vw"
 */
export function sizes(input: SizesInput): string {
  if (typeof input === 'string') return input;

  return input.map(([media, size]) => (media === '' ? size : `${media} ${size}`)).join(', ');
}
