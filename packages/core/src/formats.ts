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
 * @param accept      Raw Accept header. Absent or empty is treated as legacy.
 * @param sourceHasAlpha Whether the source carries transparency.
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
