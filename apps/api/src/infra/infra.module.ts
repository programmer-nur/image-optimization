/**
 * Infrastructure wiring.
 *
 * One global module that constructs the config, the storage and queue adapters, the
 * Prisma client, the repository, and the logger, and exposes them by token. Global
 * because these are cross-cutting singletons every feature module needs; wiring them
 * once here keeps feature modules declaring only their own providers.
 *
 * The adapters come from the shared `@imgopt/*` packages — the API holds no S3, SQS,
 * or Postgres code of its own, only the composition.
 */

import { Global, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import { loadConfig, type AppConfig } from '@imgopt/config';
import { S3Storage, type StoragePort } from '@imgopt/storage';
import { SqsQueue, type QueuePort } from '@imgopt/queue';
import { TenantScopedRepository, createPrismaClient, type PrismaClient } from '@imgopt/db';
import { createLogger } from '../common/logger.js';
import { APP_CONFIG, ASSET_REPOSITORY, LOGGER, PRISMA, QUEUE, STORAGE } from '../tokens.js';

/** Closes pooled connections on shutdown so tests and redeploys drain cleanly. */
@Injectable()
class ResourceCleanup implements OnApplicationShutdown {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(QUEUE) private readonly queue: QueuePort,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.prisma.$disconnect();
    (this.storage as S3Storage).destroy?.();
    (this.queue as SqsQueue).destroy?.();
  }
}

@Global()
@Module({
  providers: [
    { provide: APP_CONFIG, useFactory: (): AppConfig => loadConfig() },
    {
      provide: LOGGER,
      useFactory: (config: AppConfig) => createLogger(config.logLevel),
      inject: [APP_CONFIG],
    },
    {
      provide: STORAGE,
      useFactory: (config: AppConfig): StoragePort =>
        new S3Storage({
          bucket: config.storage.bucket,
          region: config.storage.region,
          ...(config.storage.endpoint !== undefined ? { endpoint: config.storage.endpoint } : {}),
          forcePathStyle: config.storage.forcePathStyle,
        }),
      inject: [APP_CONFIG],
    },
    {
      provide: QUEUE,
      useFactory: (config: AppConfig): QueuePort =>
        new SqsQueue({
          queueUrl: config.queue.optimizeQueueUrl,
          region: config.storage.region,
          ...(config.queue.endpoint !== undefined ? { endpoint: config.queue.endpoint } : {}),
        }),
      inject: [APP_CONFIG],
    },
    {
      provide: PRISMA,
      useFactory: (config: AppConfig): PrismaClient =>
        createPrismaClient({
          connectionString: config.database.url,
          context: 'container',
          maxConnections: config.database.maxConnections,
        }),
      inject: [APP_CONFIG],
    },
    {
      provide: ASSET_REPOSITORY,
      // The control plane gets the *scoped* repository and nothing else. There is no
      // provider for the unscoped one here, so a service that wanted to skip a tenant
      // filter would have to construct it — visibly — rather than inject it.
      useFactory: (prisma: PrismaClient) => new TenantScopedRepository(prisma),
      inject: [PRISMA],
    },
    ResourceCleanup,
  ],
  exports: [APP_CONFIG, LOGGER, STORAGE, QUEUE, PRISMA, ASSET_REPOSITORY],
})
export class InfraModule {}
