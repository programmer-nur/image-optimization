/**
 * Container entrypoint.
 *
 * Config is validated inside the module factory at construction time, so a
 * misconfigured deployment fails here at startup — naming the bad key — rather than
 * on the first request that happens to touch it.
 */

import 'reflect-metadata';
import type { Logger } from 'pino';
import { createApp } from './app.factory.js';
import { LOGGER } from './tokens.js';

const PORT = Number(process.env['PORT'] ?? 3000);
const HOST = process.env['HOST'] ?? '0.0.0.0';

async function bootstrap(): Promise<void> {
  const app = await createApp();
  const logger = app.get<Logger>(LOGGER);

  await app.listen(PORT, HOST);
  logger.info({ port: PORT, host: HOST }, 'control plane listening');
}

void bootstrap();
