/**
 * Breakpoint bucketing — the structural property that makes the cost model work.
 *
 * An image CDN that accepts arbitrary widths has an unbounded object count, an
 * unbounded cache-key space, and therefore a permanently cold cache. Every width
 * that reaches storage comes from the ladder below.
 *
 * This module is pure arithmetic with no dependencies, because a subset of it is
 * code-generated into the CloudFront Function. If the two ever disagree, CloudFront
 * caches one key while the generator writes another — a silent permanent cache miss.
 * See design.md D3 and D4.
 */

/**
 * Small sizes for avatars, favicons, and thumbnail grids.
 *
 * Worth its own range: snapping a 40px avatar up to 320px would ship ~60x the
 * necessary bytes, and avatars are among the most numerous images on a typical page.
 */
export const ICON_WIDTHS = [16, 32, 48, 64, 96, 128, 192, 256] as const;

/** Display-scale widths, tracking common device and layout breakpoints. */
export const DEVICE_WIDTHS = [
  320, 480, 640, 750, 828, 960, 1080, 1200, 1440, 1920, 2560, 3840,
] as const;

/** The complete ordered ladder. Every stored derivative has one of these widths. */
export const LADDER: readonly number[] = [...ICON_WIDTHS, ...DEVICE_WIDTHS];

export const MIN_LADDER_WIDTH = ICON_WIDTHS[0];
export const MAX_LADDER_WIDTH = DEVICE_WIDTHS[DEVICE_WIDTHS.length - 1] as number;

/** Permitted device pixel ratios. Folded into width, never a key dimension itself. */
export const DPR_VALUES = [1, 2, 3] as const;
export type Dpr = (typeof DPR_VALUES)[number];

/**
 * Maps a requested width onto the ladder.
 *
 * Two rules pointing in opposite directions, each for its own reason:
 *
 * - **Snap up.** Snapping down would deliver fewer pixels than the layout needs and
 *   the browser would upscale, which is visibly soft. Serving 640 for a 602px slot
 *   costs ~13% extra bytes and looks correct; serving 480 costs nothing and looks
 *   wrong. A few percent of bytes is negotiable, quality is not.
 *
 * - **Cap at the source width.** Generating 3840 from a 1000px original produces a
 *   strictly larger file with no additional detail. Without this rule every small
 *   logo eventually acquires a 4K variant.
 *
 * `sourceWidth` is optional because the edge normalizer cannot know an asset's
 * intrinsic width — it has only the URL and no network access. When it is absent the
 * cap is skipped; the processing pipeline still refuses to enlarge, so the delivered
 * bytes are correct either way.
 *
 * @param requested   Width asked for, in CSS pixels.
 * @param dpr         Device pixel ratio, folded in before snapping.
 * @param sourceWidth Intrinsic width of the source, when known.
 */
export function snapWidth(requested: number, dpr: number = 1, sourceWidth?: number): number {
  const effective = Math.min(Math.ceil(Math.max(requested, 1) * dpr), MAX_LADDER_WIDTH);

  const snapped = snapUp(effective);
  if (sourceWidth === undefined) return snapped;

  return capToSource(snapped, sourceWidth);
}

/** Smallest ladder value >= `width`, or the ladder maximum. */
export function snapUp(width: number): number {
  for (const candidate of LADDER) {
    if (candidate >= width) return candidate;
  }
  return MAX_LADDER_WIDTH;
}

/**
 * Largest ladder value <= `sourceWidth`, never below the smallest rung.
 *
 * A source narrower than the smallest rung — a 12px sprite — has no bucket of its
 * own, and must not get one. The edge normalizer snaps every requested width up to a
 * rung, so a key at native width 12 is a key no viewer URL can ever ask for: bytes
 * written once and read never. It floors at the smallest rung instead, where the
 * pipeline's `withoutEnlargement` still delivers the source's own 12 pixels.
 */
export function capToSource(width: number, sourceWidth: number): number {
  if (width <= sourceWidth) return width;

  let capped: number | undefined;
  for (const candidate of LADDER) {
    if (candidate <= sourceWidth) capped = candidate;
    else break;
  }
  return capped ?? MIN_LADDER_WIDTH;
}

/** Whether a width is a ladder rung — the only widths a canonical key may carry. */
export function isLadderWidth(width: number): boolean {
  return LADDER.includes(width);
}

/**
 * Permitted aspect ratios, expressed as height / width so the value is orientation
 * agnostic. Both orientations of each shape are present: 3/4 is landscape 4:3, 4/3
 * is portrait 3:4.
 *
 * Heights are quantized through this set rather than snapped to the width ladder.
 * Snapping height directly would turn a 640x481 request into 640x640 — the ladder
 * gaps are wide, and forcing a height onto them distorts the image.
 */
export const RATIOS: readonly number[] = [
  9 / 21, // 0.4286  landscape ultrawide
  9 / 16, // 0.5625  landscape 16:9
  2 / 3, //  0.6667  landscape 3:2
  3 / 4, //  0.75    landscape 4:3
  1, //      1.0     square
  4 / 3, //  1.3333  portrait 3:4
  3 / 2, //  1.5     portrait 2:3
  16 / 9, // 1.7778  portrait 9:16
  21 / 9, // 2.3333  portrait ultrawide
];

/** Relative tolerance for matching a requested ratio to a listed one. */
export const RATIO_TOLERANCE = 0.03;

/** Bounds the fallback quantization so the ratio axis stays finite. */
export const MIN_RATIO = 0.05;
export const MAX_RATIO = 20;

/**
 * Quantizes a height/width ratio.
 *
 * Ratios within tolerance of a listed shape snap to it, so 640x360 and 640x362 share
 * a cache entry. Anything else rounds to two decimal places, which keeps unusual
 * crops expressible while still bounding the axis.
 */
export function quantizeRatio(ratio: number): number {
  const clamped = Math.min(Math.max(ratio, MIN_RATIO), MAX_RATIO);

  let best: number | undefined;
  let bestDelta = Infinity;
  for (const candidate of RATIOS) {
    const delta = Math.abs(clamped - candidate) / candidate;
    if (delta <= RATIO_TOLERANCE && delta < bestDelta) {
      best = candidate;
      bestDelta = delta;
    }
  }
  if (best !== undefined) return best;

  return Math.round(clamped * 100) / 100;
}

/**
 * Whether a height is one the ratio quantizer can produce for this width.
 *
 * The generator's guarantee is that a key it accepts is a key the edge could have
 * asked for. Widths are checked against the ladder; heights cannot be, because they
 * are derived from a quantized *ratio* rather than snapped. This is the height half
 * of that check, and it is deliberately a superset of the reachable set: it accepts
 * every height `resolveDimensions` can emit — rejecting one would 400 a legitimate
 * viewer URL permanently — while bounding the axis to at most ~2000 values per
 * width, which is what closes the unbounded-key-space hole. See design.md D3.
 *
 * Arithmetic is kept identical to the producing path, `Math.round(width * ratio)`,
 * down to the operation order: `width * (k / 100)` and `width * k / 100` differ in
 * the last bit often enough to reject real keys.
 */
export function isQuantizedHeight(width: number, height: number): boolean {
  for (const ratio of RATIOS) {
    if (Math.round(width * ratio) === height) return true;
  }

  // The non-listed branch rounds the ratio to two decimals, so the only candidates
  // are k/100 for integer k. Rounding is monotonic in k, so the neighbourhood of the
  // implied k is exhaustive.
  const approx = (height * 100) / width;
  const lower = Math.floor(approx) - 1;
  for (let k = lower; k <= lower + 3; k += 1) {
    if (k < MIN_RATIO * 100 || k > MAX_RATIO * 100) continue;
    if (Math.round(width * (k / 100)) === height) return true;
  }

  return false;
}

/**
 * Resolves the output box.
 *
 * With only a width, height follows the source's own proportions and contributes
 * nothing to the key. With both, the width snaps to the ladder and the height is
 * derived from the quantized ratio. With only a height, the height snaps to the
 * ladder and the width follows the source.
 *
 * Both requested values are floored at one pixel first. Zero is the case that
 * matters: `?w=0&h=0` would otherwise divide zero by zero, carry NaN through the
 * ratio, and produce an `hNaN` key — one the edge emits happily and the generator
 * then refuses forever. Clamping matches how every other out-of-range number here is
 * treated, so a slightly wrong URL keeps working.
 */
export function resolveDimensions(input: {
  width?: number | undefined;
  height?: number | undefined;
  dpr?: number | undefined;
  sourceWidth?: number | undefined;
}): { width?: number; height?: number } {
  const { dpr = 1, sourceWidth } = input;
  const width = input.width === undefined ? undefined : Math.max(input.width, 1);
  const height = input.height === undefined ? undefined : Math.max(input.height, 1);

  if (width !== undefined && height !== undefined) {
    const w = snapWidth(width, dpr, sourceWidth);
    const ratio = quantizeRatio(height / width);
    return { width: w, height: Math.round(w * ratio) };
  }

  if (width !== undefined) {
    return { width: snapWidth(width, dpr, sourceWidth) };
  }

  if (height !== undefined) {
    return { height: snapWidth(height, dpr) };
  }

  return {};
}
