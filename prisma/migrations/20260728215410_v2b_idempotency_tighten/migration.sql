-- v2b: real pointwise idempotency + nullable modelConfigId + finalizedAt backfill
-- (1b Task 6 — closes 1a handoff flags I2 and M4)

-- ── ModelJudgment.modelConfigId becomes optional ────────────────────────────
-- The 1b write path (Task 9) stops populating this column — JudgeModelVersion
-- is the write-path identity now. `onDelete: Restrict` is unchanged; only the
-- NOT NULL constraint is dropped. Generated verbatim by:
--   npx prisma migrate diff --from-url "$DATABASE_URL" \
--     --to-schema-datamodel prisma/schema.prisma --script
ALTER TABLE "ModelJudgment" ALTER COLUMN "modelConfigId" DROP NOT NULL;

-- ── Real pointwise idempotency: NULLS NOT DISTINCT ──────────────────────────
-- HAND-EDITED — Prisma cannot express NULLS NOT DISTINCT (PG15+) in the
-- schema DSL, so `@@unique([runId, judgeModelVersionId, pairOrder])` in
-- prisma/schema.prisma is left UNCHANGED and this block is added by hand.
--
-- Before this migration, Postgres's default NULLS DISTINCT semantics meant
-- two pointwise judgments (pairOrder IS NULL, the only case for pointwise)
-- on the same (runId, judgeModelVersionId) never collided at the DB level —
-- the unique index silently treated every NULL as distinct from every other
-- NULL. Recreating it NULLS NOT DISTINCT makes the index a real dedupe key
-- for pointwise: a second judgment on the same (run, judge version) with
-- pairOrder still NULL now hits P2002 instead of silently coexisting.
-- Pairwise rows (pairOrder = 'AB' | 'BA') are unaffected — NULLS NOT DISTINCT
-- only changes how NULL vs NULL compares; non-null pairOrder values keep
-- normal per-value uniqueness.
--
-- KNOWN MIGRATE-DIFF PSEUDO-DRIFT (see CONTRIBUTING.md "Known migrate-diff
-- pseudo-drift" section — verified empirically against Prisma 6.19.2, not
-- just inferred): because `@@unique([...])` in schema.prisma cannot declare
-- NULLS NOT DISTINCT, Prisma's schema engine has NO representation for this
-- PG15+ index option at all — `prisma db pull` against this exact database
-- introspects the index back to a plain `@@unique([runId,
-- judgeModelVersionId, pairOrder])`, silently dropping the flag from its
-- own model of the schema. In practice this means BOTH `prisma migrate
-- diff --from-url ... --to-schema-datamodel prisma/schema.prisma` AND
-- `prisma db push` report this index as already in sync (empty diff / "The
-- database is already in sync") — Prisma isn't comparing and deciding to
-- ignore the difference, it genuinely cannot see one. There is currently
-- nothing to whitelist in a CI drift check for THIS index specifically.
-- The real hazard is different and asymmetric: because schema.prisma can
-- never re-declare NULLS NOT DISTINCT, this raw SQL block is the ONLY
-- record of that guarantee. If a FUTURE migration ever needs to recreate
-- this same index for an unrelated reason (renaming a column it covers,
-- etc.), that migration must hand-add NULLS NOT DISTINCT again — nothing
-- will warn if it's forgotten, since Prisma's tooling has no way to notice
-- the regression either. `npm run test:db` (migrate reset) replays this
-- migration file's raw SQL directly, so it exercises the real constraint
-- (see tests/db/idempotency-tighten.test.ts) regardless of what
-- diff/introspection tooling can or can't see.
DROP INDEX "ModelJudgment_runId_judgeModelVersionId_pairOrder_key";
CREATE UNIQUE INDEX "ModelJudgment_runId_judgeModelVersionId_pairOrder_key"
  ON "ModelJudgment"("runId", "judgeModelVersionId", "pairOrder") NULLS NOT DISTINCT;

-- ── finalizedAt semantics: backfill imported needs_human runs ───────────────
-- HAND-EDITED. 1a handoff flag M4: finalization (1b Task 8) sets
-- `finalizedAt` for BOTH `completed` and `needs_human` (previously only
-- `completed` reliably had it set). Rows already imported by the v1->v2
-- importer as `needs_human` before this migration predate that fix — the
-- importer itself is updated (scripts/importer/runs.ts) to set
-- `finalizedAt` for needs_human going forward, but pre-existing rows need a
-- one-time backfill. `updatedAt` is used as the best available proxy for
-- "when this run last changed" (mirrors the importer's own treatment of
-- `completed`/`error` terminal runs).
UPDATE "EvaluationRun"
SET "finalizedAt" = "updatedAt"
WHERE status = 'needs_human' AND "finalizedAt" IS NULL;
