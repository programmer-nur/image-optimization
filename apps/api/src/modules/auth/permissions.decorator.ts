import { SetMetadata } from '@nestjs/common';

/**
 * Route metadata read by the guard.
 *
 * `SetMetadata` writes its value explicitly through reflect-metadata, so — unlike
 * type-reflection DI — it works without emitted `design:` metadata, which is why the
 * app resolves the same under tsc and under esbuild.
 */

export const PUBLIC_KEY = 'isPublic';
export const PERMISSIONS_KEY = 'requiredPermissions';

/** Marks a route as reachable without authentication (health, public delivery). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_KEY, true);

/** Requires the caller's key to hold every listed permission. */
export const RequirePermissions = (...permissions: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSIONS_KEY, permissions);
