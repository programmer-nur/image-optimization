/**
 * Authentication and coarse authorization.
 *
 * Reads the key from `x-api-key` or a bearer token, verifies it, and attaches the
 * row to the request so handlers can read `req.apiKey`. Routes marked `@Public()`
 * skip auth; routes marked `@RequirePermissions(...)` additionally require those
 * permissions on the key.
 */

import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { scopeOf, type ApiKey, type TenantScope } from '@imgopt/db';
import { ApiError } from '../../common/errors.js';
import { ApiKeyService } from './api-key.service.js';
import { PERMISSIONS_KEY, PUBLIC_KEY } from './permissions.decorator.js';

export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  apiKey?: ApiKey;
}

/**
 * The tenant scope for an authenticated request.
 *
 * The single doorway between HTTP and the registry: `scopeOf` is the only way to make
 * a `TenantScope`, and this is the only place a request reaches it. `apiKey` is typed
 * optional because `@Public()` routes share the request shape, so this throws rather
 * than asserting — a route that loses its guard gets a 401, not an unscoped query.
 */
export function requestScope(req: AuthenticatedRequest): TenantScope {
  if (req.apiKey === undefined) throw ApiError.unauthorized();
  return scopeOf(req.apiKey);
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly keys: ApiKeyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const presented = this.extractKey(req);
    if (presented === undefined) throw ApiError.unauthorized();

    const apiKey = await this.keys.verify(presented);
    if (apiKey === null) throw ApiError.unauthorized('Invalid or revoked API key.');

    const required =
      this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    const missing = required.filter((p) => !apiKey.permissions.includes(p));
    if (missing.length > 0) {
      throw ApiError.forbidden(`Missing permission(s): ${missing.join(', ')}.`);
    }

    req.apiKey = apiKey;
    return true;
  }

  private extractKey(req: AuthenticatedRequest): string | undefined {
    const header = req.headers['x-api-key'];
    if (typeof header === 'string' && header.length > 0) return header;

    const auth = req.headers['authorization'];
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7);

    return undefined;
  }
}
