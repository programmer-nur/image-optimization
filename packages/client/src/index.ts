export { resolveConfig, type ClientConfig, type ResolvedConfig } from './config.js';

export { baseUrl, buildUrl, withTransform, type AssetRef, type TransformOptions } from './url.js';

export {
  buildSrcset,
  candidateWidths,
  defaultWidth,
  sizes,
  type SizesInput,
  type SrcsetOptions,
} from './srcset.js';

export { createImageClient, type ImageClient, type RenderableImage } from './client.js';

export { isReady, type ImageAsset, type ImageSource } from './types.js';

export {
  DEFAULT_PROXY_THRESHOLD_BYTES,
  UploadClient,
  UploadError,
  type UploadClientConfig,
  type UploadMetadata,
  type UploadOptions,
  type UploadResult,
} from './upload.js';

// Re-exported so a consumer can type against the transform grammar without taking a
// direct dependency on @imgopt/core.
export {
  DEVICE_WIDTHS,
  ICON_WIDTHS,
  LADDER,
  QUALITY_LEVELS,
  type CropGravity,
  type Dpr,
  type FitMode,
  type OutputFormat,
  type QualityLevel,
  type RequestedFormat,
} from '@imgopt/core';
