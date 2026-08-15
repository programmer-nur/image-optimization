/**
 * Builds the Nest + Fastify application.
 *
 * Shared by `main.ts` and the integration tests, so the tests exercise the same
 * wiring — multipart limits, the raw-body parser, the global filter and guard —
 * that production runs, rather than a hand-assembled subset.
 */

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyMultipart from '@fastify/multipart';
import type { Logger } from 'pino';
import type { AppConfig } from '@imgopt/config';
import { AppModule } from './app.module.js';
import { APP_CONFIG, LOGGER } from './tokens.js';
import { GlobalExceptionFilter } from './common/exception.filter.js';
import { registerSecurityHeaders } from './common/security-headers.js';
import { registerRequestLogging } from './common/request-logging.js';
import { ApiKeyGuard } from './modules/auth/api-key.guard.js';

/** Content types accepted as a raw image body on `PUT /v1/images/:id/source`. */
const RAW_IMAGE_TYPES = [
  'application/octet-stream',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
  'image/tiff',
];

export async function createApp(): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({ bodyLimit: 200 * 1024 * 1024 });

  // Leave raw image bodies as an unconsumed stream so the upload service can pipe
  // them straight into S3 rather than buffering the whole file.
  adapter
    .getInstance()
    .addContentTypeParser(
      RAW_IMAGE_TYPES,
      (_req: unknown, payload: unknown, done: (err: Error | null, body?: unknown) => void) => {
        done(null, payload);
      },
    );

  // Registered on the adapter rather than as Nest middleware so it also covers
  // responses Nest never sees — a 404 for an unrouted path, or a body-limit
  // rejection thrown by Fastify before the framework is involved.
  registerSecurityHeaders(adapter.getInstance());

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bufferLogs: true,
  });

  const config = app.get<AppConfig>(APP_CONFIG);
  const logger = app.get<Logger>(LOGGER);

  await app.register(fastifyMultipart, {
    limits: {
      // The proxied path is for small files; anything larger is directed to the
      // presigned flow rather than streamed through the container.
      fileSize: config.upload.proxyThresholdBytes,
      files: 1,
    },
  });

  // After the container exists, so it can use the configured logger, but still on
  // the adapter so it sees requests Nest never routes.
  registerRequestLogging(adapter.getInstance(), logger);

  app.useGlobalFilters(new GlobalExceptionFilter(logger));

  // One global auth guard, resolved from the container; routes opt out with @Public().
  app.useGlobalGuards(app.get(ApiKeyGuard));

  app.enableShutdownHooks();
  return app;
}
