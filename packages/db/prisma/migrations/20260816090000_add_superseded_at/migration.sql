-- AlterTable
ALTER TABLE "asset_versions" ADD COLUMN "superseded_at" TIMESTAMPTZ(3);

-- CreateIndex
CREATE INDEX "asset_versions_superseded_at_idx" ON "asset_versions"("superseded_at");

-- Backfill.
--
-- The supersession moment is not a guess: a version stopped being current exactly
-- when its successor row was created, and that row still carries the timestamp. So
-- every superseded version whose successor survives gets its true value, and the
-- invariant the runtime write maintains — superseded_at equals the successor's
-- created_at — holds for old rows and new ones alike.
--
-- Rows whose successor has already been reclaimed keep NULL, and NULL is not
-- reclaimable. "We do not know when this stopped being current" has to fail toward
-- keeping: the objects at stake include originals, which cannot be regenerated.
UPDATE "asset_versions" AS v
SET "superseded_at" = (
  SELECT n."created_at"
  FROM "asset_versions" AS n
  WHERE n."asset_id" = v."asset_id"
    AND n."version" > v."version"
  ORDER BY n."version" ASC
  LIMIT 1
)
WHERE v."version" < (SELECT a."current_version" FROM "assets" AS a WHERE a."id" = v."asset_id");
