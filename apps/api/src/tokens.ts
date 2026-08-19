/**
 * Dependency-injection tokens.
 *
 * The interface- and value-typed singletons (config, storage, queue, prisma, the
 * repository, the logger) are injected by these symbol tokens with an explicit
 * `@Inject(TOKEN)`, because interfaces and plain values have no runtime type for
 * Nest to reflect on. Class-typed dependencies (services, guards) are injected by
 * type in the normal NestJS way; that relies on emitted `design:paramtypes`
 * metadata, which `tsc` provides in production and SWC provides under vitest (see
 * vitest.config.ts). esbuild does not emit it, which is why the tests use SWC.
 */

export const APP_CONFIG = Symbol('APP_CONFIG');
export const STORAGE = Symbol('STORAGE');
export const QUEUE = Symbol('QUEUE');
export const PRISMA = Symbol('PRISMA');
export const ASSET_REPOSITORY = Symbol('ASSET_REPOSITORY');
export const LOGGER = Symbol('LOGGER');

/**
 * The shared secret authenticating the internal worker routes.
 *
 * A token rather than a config read at the guard, so the control plane resolves it at
 * boot and refuses to start without one — see `InternalModule`.
 */
export const WORKER_SECRET = Symbol('WORKER_SECRET');
