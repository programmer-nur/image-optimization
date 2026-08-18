-- AlterTable
--
-- No backfill is possible: the size was never written anywhere, so masters created
-- before this column contribute 0 to the storage totals until their asset is
-- reprocessed. Nothing has been deployed, so that set is empty in practice — if this
-- ever lands on a populated database, say so in the release note rather than
-- inventing a number.
ALTER TABLE "asset_versions" ADD COLUMN "master_bytes" BIGINT;
