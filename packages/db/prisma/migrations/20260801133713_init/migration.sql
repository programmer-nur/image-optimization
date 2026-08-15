-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('pending_upload', 'stored', 'ready', 'rejected', 'failed', 'deleted');

-- CreateEnum
CREATE TYPE "DerivativeOrigin" AS ENUM ('warm', 'ondemand');

-- CreateTable
CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "current_version" INTEGER NOT NULL DEFAULT 0,
    "status" "AssetStatus" NOT NULL DEFAULT 'pending_upload',
    "alt_text" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "focal_point" JSONB,
    "failure_reason" TEXT,
    "api_key_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_versions" (
    "asset_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "source_key" TEXT NOT NULL,
    "master_key" TEXT,
    "content_hash" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "format" TEXT,
    "bytes" BIGINT,
    "has_alpha" BOOLEAN,
    "colorspace" TEXT,
    "orientation" INTEGER,
    "dominant_color" TEXT,
    "lqip" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_versions_pkey" PRIMARY KEY ("asset_id","version")
);

-- CreateTable
CREATE TABLE "derivatives" (
    "canonical_key" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "format" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "bytes" BIGINT NOT NULL,
    "generated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generated_by" "DerivativeOrigin" NOT NULL,

    CONSTRAINT "derivatives_pkey" PRIMARY KEY ("canonical_key")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "max_bytes" BIGINT,
    "max_assets" INTEGER,
    "used_bytes" BIGINT NOT NULL DEFAULT 0,
    "used_assets" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assets_status_idx" ON "assets"("status");

-- CreateIndex
CREATE INDEX "assets_created_at_idx" ON "assets"("created_at");

-- CreateIndex
CREATE INDEX "assets_api_key_id_idx" ON "assets"("api_key_id");

-- CreateIndex
CREATE INDEX "asset_versions_content_hash_idx" ON "asset_versions"("content_hash");

-- CreateIndex
CREATE INDEX "derivatives_asset_id_version_idx" ON "derivatives"("asset_id", "version");

-- CreateIndex
CREATE INDEX "derivatives_generated_at_idx" ON "derivatives"("generated_at");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_hash_key" ON "api_keys"("hash");

-- AddForeignKey
ALTER TABLE "asset_versions" ADD CONSTRAINT "asset_versions_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "derivatives" ADD CONSTRAINT "derivatives_asset_id_version_fkey" FOREIGN KEY ("asset_id", "version") REFERENCES "asset_versions"("asset_id", "version") ON DELETE CASCADE ON UPDATE CASCADE;
