-- v2o. The BA sweep: a second ModelJudgment per item at pairOrder 'BA', and
-- the two estimators computed from the pair.
--
-- NO BACKFILL. All 22 pre-existing CalibrationRun rows measured one order and
-- genuinely did not measure position bias; NULL is the honest state and
-- `ordersRequested` is what makes that NULL unambiguous.
--
-- positionBias already exists (v2_meta_eval, 2026-07-25) and was never
-- written by any code path. It is documented here for the first time.
ALTER TABLE "CalibrationRun" ADD COLUMN "orderFlipRate" DOUBLE PRECISION;
ALTER TABLE "CalibrationRun" ADD COLUMN "pairedDecisiveCount" INTEGER;
ALTER TABLE "CalibrationRun" ADD COLUMN "ordersRequested" TEXT;
