/**
 * The tenant scope.
 *
 * A branded string that a repository method cannot be called without. The point is
 * not the type gymnastics — it is that forgetting to scope a query becomes a *build*
 * error rather than a cross-tenant read discovered in production.
 *
 * Why a brand rather than a plain `string` parameter: a plain string is satisfied by
 * any string in scope, and the strings nearest to hand at a call site are `assetId`,
 * `apiKeyId`, and whatever the caller passed in. `scopeOf(request.apiKey)` is the only
 * way to make one, so a scope can only come from a request that actually authenticated.
 *
 * Why not row-level security in Postgres instead: it would be stronger, and it is the
 * right answer for a deployment with many tenants and untrusted operators. It also
 * requires a session variable set on every connection from a pooled client, which is
 * a runtime coupling this codebase does not otherwise have — and it would not catch
 * the mistake at build time, which is where it is cheapest to catch.
 */

declare const TenantBrand: unique symbol;

/** Proof that a caller has been resolved to one tenant. */
export type TenantScope = string & { readonly [TenantBrand]: true };

/**
 * Derives a scope from something that carries a tenant.
 *
 * Takes the record rather than a bare id so a caller cannot invent a scope from a
 * value it happens to hold: the only sources of one are an authenticated key and the
 * tenant row itself.
 */
export function scopeOf(owner: { tenantId: string }): TenantScope {
  return owner.tenantId as TenantScope;
}

/** A scope for a tenant row, used where the tenant itself is the subject. */
export function scopeOfTenant(tenant: { id: string }): TenantScope {
  return tenant.id as TenantScope;
}

/**
 * The tenant every pre-tenancy row was attributed to.
 *
 * Referenced by the bootstrap path and by tests. A deployment that has never had a
 * second tenant keeps this one; the id is fixed rather than generated so it matches
 * the migration's backfill and reads as something an operator can place.
 */
export const DEFAULT_TENANT_ID = 'tenant_default';

/*
 * There is deliberately no `everyTenant()` here.
 *
 * A wildcard scope would have to be a sentinel — `'*'` — and a sentinel used as a
 * filter value matches nothing, so the escape hatch would silently return an empty
 * result instead of every row. Work that is genuinely deployment-wide, like
 * reclamation, uses `UnscopedAssetRepository`, which asks for no scope at all and is
 * named to make that visible.
 */
