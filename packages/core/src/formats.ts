/**
 * Format policy.
 *
 * Format negotiation happens at the edge, not the origin: the CloudFront Function
 * reads `Accept` and bakes a concrete format into the rewritten path. The
 * alternative — one URL with `Vary: Accept` — fragments the cache by the full
 * Accept header string, and browsers send wildly varied ones. Resolving to a
 * concrete format collapses that to at most three branches per variant.
 *
 * Because AVIF is ~30-50% smaller than JPEG at comparable quality, and bandwidth is
 * roughly 75% of the running cost, this is simultaneously the largest cost lever and
 * the largest performance win in the system. See design.md D9 and D16.
 */

export const OUTPUT_FORMATS = ['avif', 'webp', 'jpeg', 'png'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/** What a client may ask for. `auto` resolves against the Accept header. */
export const REQUESTED_FORMATS = ['auto', ...OUTPUT_FORMATS] as const;
export type RequestedFormat = (typeof REQUESTED_FORMATS)[number];

/** File extension for a format. Distinct from the format name only for jpeg. */
export const FORMAT_EXTENSIONS: Record<OutputFormat, string> = {
  avif: 'avif',
  webp: 'webp',
  jpeg: 'jpg',
  png: 'png',
};

/**
 * Extension back to format. The generator reconstructs a spec from the object key
 * alone, so this direction has to exist and has to be exact.
 */
export const EXTENSION_FORMATS: Record<string, OutputFormat> = {
  avif: 'avif',
  webp: 'webp',
  jpg: 'jpeg',
  png: 'png',
};

export const FORMAT_MIME_TYPES: Record<OutputFormat, string> = {
  avif: 'image/avif',
  webp: 'image/webp',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

/** Formats that carry an alpha channel. */
export function supportsAlpha(format: OutputFormat): boolean {
  return format !== 'jpeg';
}

/**
 * Resolves `format=auto` from the viewer's Accept header.
 *
 * Preference order is by compression efficiency. PNG is selected only as the
 * fallback for sources with transparency, since a legacy browser that supports
 * neither modern format cannot receive alpha as JPEG.
 *
 * ON THE DELIVERY PATH, `sourceHasAlpha` IS ALWAYS FALSE — and structurally must be.
 * Normalization happens in the CloudFront Function, which has no asset metadata and
 * no network, and the generator derives its spec from the key the edge already built.
 * Neither can know whether a source carries transparency, so `auto` on a client that
 * advertises neither AVIF nor WebP resolves to JPEG and the pipeline flattens the
 * image onto the configured background. The PNG branch is reachable only from callers
 * that hold real metadata: the programmatic API and the browser SDK, which can pass
 * `format=png` explicitly for a transparent asset.
 *
 * The alternative — one URL with `Vary: Accept` and an origin that knows the asset —
 * is the design this system rejected, and for a reason bigger than this edge case:
 * it fragments the cache by the raw Accept string. Every browser shipping today
 * supports WebP, so the affected population is legacy clients requesting transparent
 * images, and they get a correct opaque image rather than a broken one. See design.md
 * D9 and specs/cdn-delivery.
 *
 * @param accept      Raw Accept header. Absent or empty is treated as legacy.
 * @param sourceHasAlpha Whether the source carries transparency. Unknowable at the edge.
 */
export function resolveAutoFormat(
  accept: string | undefined,
  sourceHasAlpha: boolean = false,
): OutputFormat {
  const header = accept ?? '';

  if (header.includes('image/avif')) return 'avif';
  if (header.includes('image/webp')) return 'webp';
  return sourceHasAlpha ? 'png' : 'jpeg';
}

/** Resolves a requested format, consulting Accept only for `auto`. */
export function resolveFormat(
  requested: RequestedFormat,
  accept: string | undefined,
  sourceHasAlpha: boolean = false,
): OutputFormat {
  return requested === 'auto' ? resolveAutoFormat(accept, sourceHasAlpha) : requested;
}
