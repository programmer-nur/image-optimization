/**
 * Node-only entry point. Imports sharp, a native module.
 *
 * Kept off the package root so browser consumers of `@imgopt/core` — the client SDK
 * URL builder in particular — never pull a native binary into their bundle.
 */

export {
  AVIF_EFFORT_REDUCTION_WIDTH,
  type EncoderOptions,
  avifOptions,
  encoderOptionsFor,
  jpegOptions,
  pngOptions,
  webpOptions,
} from './encoder-options.js';

export { type ProcessingErrorCode, ProcessingError, classifyError } from './errors.js';

export {
  DEFAULT_FLATTEN_BACKGROUND,
  DEFAULT_MAX_PIXELS,
  type RenderOptions,
  type RenderResult,
  applyTransform,
  buildPipeline,
  render,
  renderWithTimeout,
} from './render.js';

export {
  type LqipOptions,
  type MasterOptions,
  type SourceMetadata,
  generateLqip,
  generateMaster,
  needsMaster,
  readDominantColor,
  readMetadata,
} from './metadata.js';
