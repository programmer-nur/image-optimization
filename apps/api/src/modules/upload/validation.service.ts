/**
 * Upload validation.
 *
 * The security-critical rule: the true type comes from the bytes, never from the
 * client's declared `Content-Type`. A file claiming `image/jpeg` that is actually a
 * PDF, a script, or an HTML/GIF polyglot is rejected here, before it is ever
 * promoted out of the untrusted staging prefix.
 *
 * Pure and dependency-injected so it unit-tests without a container: it takes a
 * header buffer and the config, and returns a verdict or throws.
 */

import { Inject, Injectable } from '@nestjs/common';
import { fileTypeFromBuffer } from 'file-type';
import { ProcessingError, readMetadata } from '@imgopt/core/pipeline';
import type { UploadConfig } from '@imgopt/config';
import { APP_CONFIG } from '../../tokens.js';
import type { AppConfig } from '@imgopt/config';
import { ApiError } from '../../common/errors.js';

/** Detected image formats, normalized to our vocabulary. */
export type DetectedFormat = 'jpeg' | 'png' | 'webp' | 'avif' | 'gif' | 'tiff';

const MIME_TO_FORMAT: Record<string, DetectedFormat> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/tiff': 'tiff',
};

/** Normalizes a declared content type down to our format vocabulary, if possible. */
function declaredToFormat(declared: string | undefined): DetectedFormat | undefined {
  if (declared === undefined) return undefined;
  const base = declared.split(';')[0]!.trim().toLowerCase();
  return MIME_TO_FORMAT[base] ?? (base === 'image/jpg' ? 'jpeg' : undefined);
}

export interface ValidationResult {
  format: DetectedFormat;
  width: number;
  height: number;
  bytes: number;
}

@Injectable()
export class ValidationService {
  private readonly config: UploadConfig;
  private readonly maxPixels: number;

  constructor(@Inject(APP_CONFIG) appConfig: AppConfig) {
    this.config = appConfig.upload;
    this.maxPixels = appConfig.upload.maxPixels;
  }

  /**
   * Validates staged bytes.
   *
   * @param header       Leading bytes, enough to carry the signature and dimensions.
   *                     For most formats these live in the first few KB.
   * @param totalBytes   Size from the object head.
   * @param declaredType Client-declared content type. Used only to detect a mismatch.
   */
  async validate(
    header: Buffer,
    totalBytes: number,
    declaredType: string | undefined,
  ): Promise<ValidationResult> {
    if (totalBytes <= 0) {
      throw new ApiError('empty_file', 400, 'Uploaded file is empty.');
    }
    if (totalBytes > this.config.maxFileBytes) {
      throw ApiError.payloadTooLarge('File exceeds the maximum permitted size.', {
        maxBytes: this.config.maxFileBytes,
        bytes: totalBytes,
      });
    }

    const sniffed = await fileTypeFromBuffer(header);

    // Undetectable includes SVG, which is text rather than a binary signature.
    if (sniffed === undefined) {
      if (this.config.allowSvg && this.looksLikeSvg(header)) {
        throw new ApiError(
          'unsupported_format',
          422,
          'SVG support is enabled but sanitization is not yet implemented.',
        );
      }
      throw new ApiError(
        'unsupported_format',
        422,
        'Could not determine the file type from its contents.',
      );
    }

    const detected = MIME_TO_FORMAT[sniffed.mime];
    if (detected === undefined || !this.config.acceptedFormats.includes(detected)) {
      throw new ApiError(
        'unsupported_format',
        422,
        `Detected type "${sniffed.mime}" is not an accepted image format.`,
        { detected: sniffed.mime },
      );
    }

    // A declared type that resolves to a *different* format is a spoof attempt.
    const declared = declaredToFormat(declaredType);
    if (declared !== undefined && declared !== detected) {
      throw new ApiError(
        'content_type_mismatch',
        422,
        `Declared "${declaredType}" but the file is actually ${detected}.`,
        { declared, detected },
      );
    }

    return this.checkDimensions(header, detected, totalBytes);
  }

  private async checkDimensions(
    header: Buffer,
    format: DetectedFormat,
    totalBytes: number,
  ): Promise<ValidationResult> {
    try {
      // metadata() reads the header only; it does not allocate the bitmap, so a
      // decompression bomb is rejected on its declared dimensions rather than by
      // decoding it. The pipeline's own limitInputPixels is the hard backstop.
      const meta = await readMetadata(header, { maxPixels: this.maxPixels });

      if (meta.width * meta.height > this.maxPixels) {
        throw new ApiError(
          'pixel_limit_exceeded',
          422,
          'Image dimensions exceed the permitted pixel count.',
          { pixels: meta.width * meta.height, maxPixels: this.maxPixels },
        );
      }

      return { format, width: meta.width, height: meta.height, bytes: totalBytes };
    } catch (error) {
      if (error instanceof ApiError) throw error;

      /*
       * `readMetadata` enforces the pixel ceiling itself and *throws* rather than
       * returning oversized dimensions — so for exactly the images this check exists
       * to stop, it never returns and the comparison above is unreachable. Letting
       * that throw fall into the tolerant branch below accepted every decompression
       * bomb while the explicit check sat there looking correct.
       *
       * Rethrown as a rejection here. Everything else really is "the header was too
       * short to read dimensions from", which is not grounds to refuse a valid image.
       */
      if (error instanceof ProcessingError && error.code === 'pixel_limit_exceeded') {
        throw new ApiError(
          'pixel_limit_exceeded',
          422,
          'Image dimensions exceed the permitted pixel count.',
          { maxPixels: this.maxPixels },
        );
      }

      // Header truncated or unreadable for dimensions. Format is already verified;
      // the pipeline enforces the pixel ceiling at processing time, so accept with
      // unknown dimensions rather than rejecting a valid image.
      return { format, width: 0, height: 0, bytes: totalBytes };
    }
  }

  private looksLikeSvg(header: Buffer): boolean {
    const text = header.subarray(0, 1024).toString('utf8').trimStart().toLowerCase();
    return text.startsWith('<?xml') || text.startsWith('<svg');
  }
}
