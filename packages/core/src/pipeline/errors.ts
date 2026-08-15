/**
 * Processing error classification.
 *
 * The retriable/terminal split drives real behaviour: a terminal failure must skip
 * the retry budget and dead-letter immediately, because retrying a corrupt source
 * three times just burns Lambda invocations to reach the same conclusion. It also
 * separates "this image is broken" from "our infrastructure is broken" in the
 * failure metrics, which is the difference between ignoring an alert and paging.
 */

export type ProcessingErrorCode =
  /** Source bytes are truncated or malformed. Terminal. */
  | 'corrupt_source'
  /** Decoded pixel count exceeds the configured ceiling. Terminal. */
  | 'pixel_limit_exceeded'
  /** Input is not an image format we handle. Terminal. */
  | 'unsupported_input'
  /** Generation exceeded its time budget. Retriable. */
  | 'timeout'
  /** Anything unrecognized. Retriable, on the assumption it may be transient. */
  | 'unexpected';

const TERMINAL: ReadonlySet<ProcessingErrorCode> = new Set([
  'corrupt_source',
  'pixel_limit_exceeded',
  'unsupported_input',
]);

export class ProcessingError extends Error {
  readonly code: ProcessingErrorCode;
  readonly retriable: boolean;

  constructor(code: ProcessingErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = 'ProcessingError';
    this.code = code;
    this.retriable = !TERMINAL.has(code);
  }
}

/**
 * Maps a thrown value onto a classified error.
 *
 * libvips reports through message text rather than error codes, so this matches on
 * substrings. The patterns are asserted against real sharp failures in the tests —
 * without that, a libvips upgrade could silently reclassify every corrupt upload as
 * `unexpected` and start retrying terminal failures.
 */
export function classifyError(error: unknown): ProcessingError {
  if (error instanceof ProcessingError) return error;

  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (lower.includes('exceeds pixel limit') || lower.includes('too large')) {
    return new ProcessingError('pixel_limit_exceeded', message, { cause: error });
  }

  if (
    lower.includes('unsupported image format') ||
    lower.includes('bad extension') ||
    lower.includes('is not a known')
  ) {
    return new ProcessingError('unsupported_input', message, { cause: error });
  }

  if (
    lower.includes('corrupt') ||
    lower.includes('truncated') ||
    lower.includes('premature end') ||
    lower.includes('not enough data') ||
    lower.includes('unexpected end of')
  ) {
    return new ProcessingError('corrupt_source', message, { cause: error });
  }

  if (lower.includes('timeout') || lower.includes('timed out')) {
    return new ProcessingError('timeout', message, { cause: error });
  }

  return new ProcessingError('unexpected', message, { cause: error });
}
