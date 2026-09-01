-- v2j — queue lanes (per-server judgment serialization)
--
-- One row per SERIALIZATION DOMAIN: a normalized inference-server origin such
-- as `http://192.168.1.9:11434`, or `version:<judgeModelVersionId>` for a judge
-- with no endpoint URL. `id` is the assignment ORDER and is load-bearing — the
-- queue lane is derived from it as `(id - 1) % LANE_COUNT`.
--
-- WHY A TABLE AND NOT A HASH. Routing by consistent hash into N shards has a
-- birthday problem: at TWO distinct origins and 32 shards there is a ~3% chance
-- both land on the same shard, and the whole change then ships and does
-- nothing — silently, permanently, and invisible from shard depth. The key
-- space here is tiny and slow-moving, so the assignment is recorded rather than
-- computed. Zero collisions for the first LANE_COUNT origins, always; and
-- growing 8 -> 32 leaves every existing origin on its exact lane, because
-- (id-1) % 8 == (id-1) % 32 for id <= 8.
--
-- ENTIRELY ADDITIVE: one new table, no column added to or removed from any
-- existing table, no data touched. Production holds 2 ModelEndpoint rows and
-- this migration reads none of them — lanes are assigned lazily, on first
-- publish for an origin.

-- CreateTable
CREATE TABLE "QueueLane" (
    "id" SERIAL NOT NULL,
    "laneKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QueueLane_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QueueLane_laneKey_key" ON "QueueLane"("laneKey");

