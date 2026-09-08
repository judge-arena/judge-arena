-- v2p. The order discriminator moves from ModelJudgment up to EvaluationRun,
-- so a permuted calibration is 2N runs with ONE judgment each rather than N
-- runs with two. That restores the invariant timeout-policy.ts:230-258 states
-- outright ("it is always 1 ... queue-depth independence is the entire
-- point"), which the two-judgments-per-run shape had broken.
--
-- Hand-written, not Prisma-generated: the DSL cannot express a partial index,
-- NULLS NOT DISTINCT, or a CHECK. This is the ninth hand-edited migration in
-- the repo (CONTRIBUTING.md).
--
-- BACKFILL IS EXACT: all 4200 production ModelJudgment rows carry
-- pairOrder 'AB' — zero 'BA', zero NULL — so every existing calibration run
-- genuinely presented AB and the CHECK below is satisfiable without guessing.

DROP INDEX "EvaluationRun_calibrationRunId_goldenItemId_key";

ALTER TABLE "EvaluationRun" ADD COLUMN "pairOrder" TEXT;

UPDATE "EvaluationRun" SET "pairOrder" = 'AB' WHERE "calibrationRunId" IS NOT NULL;

-- THREE clauses, all load-bearing. A plain
-- @@unique([calibrationRunId, goldenItemId, pairOrder]) gets all three wrong.
--
-- WHERE: ordinary (non-calibration) runs leave the index entirely. Without it
-- the NULLS NOT DISTINCT below makes every ordinary run's (NULL, NULL, NULL)
-- equal to every other's, and the SECOND ordinary run ever launched fails
-- P2002.
--
-- NULLS NOT DISTINCT: inside the calibration partition, two rows with a NULL
-- order must still collide. Postgres' default NULLS DISTINCT would silently
-- delete the idempotency guard score.ts relies on to know its source rows
-- cannot be double-counted.
CREATE UNIQUE INDEX "EvaluationRun_calibrationRunId_goldenItemId_pairOrder_key"
  ON "EvaluationRun" ("calibrationRunId", "goldenItemId", "pairOrder")
  NULLS NOT DISTINCT
  WHERE "calibrationRunId" IS NOT NULL;

-- Makes "a calibration run always names its order" a database fact rather than
-- a convention, so a later writer cannot produce a row score.ts would silently
-- file into the wrong partition.
ALTER TABLE "EvaluationRun" ADD CONSTRAINT "EvaluationRun_calibration_needs_order"
  CHECK ("calibrationRunId" IS NULL OR "pairOrder" IS NOT NULL);
