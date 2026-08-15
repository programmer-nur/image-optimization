/**
 * Domain errors for the control plane.
 *
 * These carry a stable machine-readable `code` and an HTTP status. The global filter
 * turns them into a consistent JSON envelope, so a client can branch on `code`
 * rather than parsing prose or guessing from a status alone.
 */

export type ErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'validation_failed'
  | 'payload_too_large'
  | 'quota_exceeded'
  | 'content_type_mismatch'
  | 'unsupported_format'
  | 'pixel_limit_exceeded'
  | 'empty_file'
  | 'malware_detected'
  | 'conflict'
  | 'internal_error';

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, status: number, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }

  static unauthorized(message = 'Authentication required.'): ApiError {
    return new ApiError('unauthorized', 401, message);
  }
  static forbidden(message = 'Not permitted.'): ApiError {
    return new ApiError('forbidden', 403, message);
  }
  static notFound(message = 'Not found.'): ApiError {
    return new ApiError('not_found', 404, message);
  }
  static validation(message: string, details?: Record<string, unknown>): ApiError {
    return new ApiError('validation_failed', 400, message, details);
  }
  static payloadTooLarge(message: string, details?: Record<string, unknown>): ApiError {
    return new ApiError('payload_too_large', 413, message, details);
  }
  static quotaExceeded(message: string, details?: Record<string, unknown>): ApiError {
    return new ApiError('quota_exceeded', 413, message, details);
  }
  static conflict(message: string, details?: Record<string, unknown>): ApiError {
    return new ApiError('conflict', 409, message, details);
  }
  /**
   * 422 rather than 400: the request was well formed and the bytes were a valid
   * image. What failed was a policy check on the content itself, and a client should
   * not retry it verbatim.
   */
  static malwareDetected(message = 'Upload rejected by malware scanning.'): ApiError {
    return new ApiError('malware_detected', 422, message);
  }
}
