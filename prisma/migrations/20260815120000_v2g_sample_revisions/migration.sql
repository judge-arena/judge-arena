-- v2g — the sample revision log (Plan L2)
--
-- Append-only history for DatasetSample mutations. One row per edit, delete or
-- restore, carrying the values as they stood BEFORE the change.
--
-- GENERATED VERBATIM by `prisma migrate diff`. There are NO hand edits in this
-- migration — unlike 20260814120000_v2f_tombstone_overlay, which hand-adds a
-- CHECK constraint. Consequently this migration adds NO row to CONTRIBUTING's
-- "Known migrate-diff pseudo-drift" table; if you are here looking for one,
-- there is nothing to find.
--
-- Companion to, not a replacement for, the Tombstone overlay in v2f. Tombstone
-- is current state (one row per entity, @unique, consulted by every read
-- filter); this is the log (many rows per entity, filtered by nothing).
--
-- NOTE ON THE LABEL: plan "L2" was called "A2" until 2026-08-16. The lifecycle
-- plans were renamed L1/L2 to stop colliding with Roadmap A's A0..A5 phases,
-- whose A2 is the calibration engine. v2f's header still says "Plan A1"
-- because that migration is already applied and Prisma checksums it.

-- CreateTable
CREATE TABLE "SampleRevision" (
    "id" TEXT NOT NULL,
    "datasetSampleId" TEXT NOT NULL,
    "changeType" TEXT NOT NULL,
    "input" TEXT,
    "expected" TEXT,
    "metadata" TEXT,
    "actorId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SampleRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SampleRevision_datasetSampleId_at_idx" ON "SampleRevision"("datasetSampleId", "at");

-- AddForeignKey
ALTER TABLE "SampleRevision" ADD CONSTRAINT "SampleRevision_datasetSampleId_fkey" FOREIGN KEY ("datasetSampleId") REFERENCES "DatasetSample"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SampleRevision" ADD CONSTRAINT "SampleRevision_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

