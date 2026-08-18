-- Tenancy in the control plane.
--
-- Nothing here touches a URL, an object key, or the edge. A tenant is an owner of
-- rows and of quota; the delivery plane never reads this database, so it cannot and
-- must not know about tenants. See openspec/changes/multi-tenancy/design.md.
--
-- The backfill is the interesting part. An existing installation is a single-tenant
-- installation, so the honest migration is to name that tenant and attribute
-- everything to it — NOT to leave the column nullable and hope every query
-- remembers to filter. Nullable would make "unowned" a representable state, and an
-- unowned row is one that every scoped query silently skips: an asset that exists,
-- bills storage, and is invisible to its owner.

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "max_bytes" BIGINT,
    "max_assets" INTEGER,
    "used_bytes" BIGINT NOT NULL DEFAULT 0,
    "used_assets" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- The one tenant this deployment already is.
--
-- A fixed id rather than a generated one: it is referenced by the backfill below and
-- by the bootstrap path, and a deployment that has never had a second tenant should
-- have a name an operator recognises rather than a ULID nobody can place.
INSERT INTO "tenants" ("id", "slug", "name")
VALUES ('tenant_default', 'default', 'Default')
ON CONFLICT ("id") DO NOTHING;

-- AlterTable: assets
ALTER TABLE "assets" ADD COLUMN "tenant_id" TEXT;
UPDATE "assets" SET "tenant_id" = 'tenant_default' WHERE "tenant_id" IS NULL;
ALTER TABLE "assets" ALTER COLUMN "tenant_id" SET NOT NULL;

-- AlterTable: api_keys
ALTER TABLE "api_keys" ADD COLUMN "tenant_id" TEXT;
UPDATE "api_keys" SET "tenant_id" = 'tenant_default' WHERE "tenant_id" IS NULL;
ALTER TABLE "api_keys" ALTER COLUMN "tenant_id" SET NOT NULL;

-- Carry the existing per-key usage onto the tenant, so the accounting unit changes
-- without the totals resetting. Summed rather than copied: a deployment with several
-- keys has its usage spread across them, and the tenant owns the whole of it.
UPDATE "tenants" SET
    "used_bytes" = COALESCE((SELECT SUM("used_bytes") FROM "api_keys"), 0),
    "used_assets" = COALESCE((SELECT SUM("used_assets") FROM "api_keys"), 0)
WHERE "id" = 'tenant_default';

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
--
-- Each of these leads with tenant_id. An index that does not turns a tenant-filtered
-- query into a scan of every tenant's rows — correct, and progressively slower for
-- everyone as any one tenant grows.
CREATE INDEX "assets_tenant_id_status_idx" ON "assets"("tenant_id", "status");
CREATE INDEX "assets_tenant_id_created_at_idx" ON "assets"("tenant_id", "created_at");
CREATE INDEX "assets_tenant_id_id_idx" ON "assets"("tenant_id", "id");
CREATE INDEX "api_keys_tenant_id_idx" ON "api_keys"("tenant_id");

-- The single-tenant indexes these replace.
DROP INDEX IF EXISTS "assets_status_idx";
DROP INDEX IF EXISTS "assets_created_at_idx";
