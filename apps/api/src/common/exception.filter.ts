/**
 * Global exception filter.
 *
 * Turns everything thrown anywhere into one JSON envelope: `{ error: { code,
 * message, details?, correlationId } }`. Domain `ApiError`s map straight through;
 * known errors from the lower layers (asset-not-found, validation) are translated;
 * anything unrecognized becomes a 500 with a generic message so an internal detail
 * never leaks to a client, while the real error is logged with the correlation id.
 */

import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Logger } from 'pino';
import { AssetNotFoundError } from '@imgopt/db';
import { requestContext } from './logger.js';
import { ApiError, type ErrorCode } from './errors.js';

interface FastifyReply {
  status(code: number): FastifyReply;
  send(body: unknown): FastifyReply;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const correlationId = requestContext.getStore()?.correlationId;

    const { status, code, message, details } = this.normalize(exception);

    if (status >= 500) {
      // Full detail to logs, never to the client.
      this.logger.error({ err: exception, code }, 'request failed');
    } else {
      this.logger.warn({ code, status }, message);
    }

    reply.status(status).send({
      error: {
        code,
        message,
        ...(details !== undefined ? { details } : {}),
        ...(correlationId !== undefined ? { correlationId } : {}),
      },
    });
  }

  private normalize(exception: unknown): {
    status: number;
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  } {
    if (exception instanceof ApiError) {
      return {
        status: exception.status,
        code: exception.code,
        message: exception.message,
        ...(exception.details !== undefined ? { details: exception.details } : {}),
      };
    }

    if (exception instanceof AssetNotFoundError) {
      return { status: 404, code: 'not_found', message: exception.message };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        status,
        code: status === 404 ? 'not_found' : 'validation_failed',
        message: exception.message,
      };
    }

    return { status: 500, code: 'internal_error', message: 'An unexpected error occurred.' };
  }
}
