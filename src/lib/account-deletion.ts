/**
 * ─── Account Deletion (P1.7) ─────────────────────────────────────────────────
 *
 * Deletes a user account while preserving the provenance of artifacts that
 * are still visible to (or used by) other users:
 *
 *   - `private` artifacts (Project/Dataset/Rubric/GoldenSet visibility) are
 *     owned outright by the deleting user, so they hard-delete — cascades
 *     take their Evaluations/Runs/Judgments with them.
 *   - `public` artifacts are reassigned (`userId`/`ownerId` -> archiveUserId)
 *     instead of deleted, so the leaderboard/meta-eval data they anchor
 *     survives.
 *   - Rows that would otherwise be silently deleted or nulled out by a raw
 *     `user.delete()` cascade, but that hang off a *surviving* run (public,
 *     or an evaluation/config reassigned above), are explicitly reassigned
 *     to archiveUserId first so the final delete doesn't erase them:
 *     Evaluation.userId, HumanJudgment.userId, and any of the user's
 *     ModelConfig rows still referenced by a surviving ModelJudgment or
 *     EvaluationModelSelection (ModelJudgment -> ModelConfig is `onDelete:
 *     Restrict`, so a config still in use can't be deleted at all; either
 *     relation counts, since EvaluationModelSelection is written as soon as
 *     an Evaluation template's default model list is saved, before any run
 *     — and therefore any ModelJudgment — exists).
 *   - A private Rubric that a *surviving* run still pins (`onDelete:
 *     Restrict` on EvaluationRun.rubricId), or that still has child
 *     versions (`onDelete: NoAction` on Rubric.parentId), can't be
 *     hard-deleted either — it's soft-retired (`retiredAt` set, row kept)
 *     instead.
 *   - A private GoldenSet that a CalibrationRun still references
 *     (`onDelete: Restrict` on CalibrationRun.goldenSetId) can't be
 *     hard-deleted either, for the identical reason (1b-prereq (a), closed
 *     by Task 15) — it's soft-retired (`retiredAt` set, row kept) instead.
 *     That "is anything still referencing it" test is the golden-set FREEZE
 *     PREDICATE, and it has exactly one definition — `isGoldenSetFrozen` in
 *     src/lib/golden-sets.ts — shared with the golden-set route guards so
 *     the account-lifecycle path and the product path cannot drift into
 *     disagreeing about what "frozen" means (A0, "Freeze and fork").
 *     Unlike Rubric.userId (`onDelete: Cascade`), GoldenSet.ownerId is
 *     `onDelete: SetNull`, so a retired GoldenSet needs no ownership
 *     reassignment to survive the final `user.delete()` — it resolves to
 *     `ownerId: null` on its own.
 *
 * Order matters: private Projects are purged FIRST so their Evaluations/
 * Runs/Judgments/HumanJudgments are gone before we look at what's left
 * (only surviving rows remain referenced at that point).
 *
 * Everything else — ModelEndpoint, DeveloperApiKey (Cascade), AuditLog.userId
 * (SetNull), GoldenLabel.annotatorId (SetNull), EvaluationRun.triggeredById
 * (SetNull) — is left to the FK behavior on the final `user.delete()`.
 */

import { prisma } from '@/lib/db';
import { isGoldenSetFrozen } from '@/lib/golden-sets';

export interface DeleteUserAccountResult {
  purged: Record<string, number>;
  reassigned: Record<string, number>;
  retired: Record<string, number>;
}

// 1b-prereq (c): every category this function EVER tallies, shared by all
// three result maps so a caller reading `result.retired.datasets` (say)
// always gets `0` rather than `undefined` just because this particular run
// never had anything to retire in that category — a category not
// meaningful for a given map (e.g. `retired.user`) simply stays at its
// initialized 0 forever, but the KEY is always there.
const RESULT_CATEGORIES = [
  'projects',
  'evaluations',
  'datasets',
  'goldenSets',
  'humanJudgments',
  'rubrics',
  'modelConfigs',
  'user',
] as const;

function zeroedResultMap(): Record<string, number> {
  const map: Record<string, number> = {};
  for (const category of RESULT_CATEGORIES) map[category] = 0;
  return map;
}

export async function deleteUserAccount(
  userId: string,
  opts: { archiveUserId: string }
): Promise<DeleteUserAccountResult> {
  const { archiveUserId } = opts;

  if (userId === archiveUserId) {
    throw new Error('deleteUserAccount: userId and archiveUserId must differ');
  }

  return prisma.$transaction(async (tx) => {
    const archiveUser = await tx.user.findUnique({
      where: { id: archiveUserId },
      select: { id: true },
    });
    if (!archiveUser) {
      throw new Error(`deleteUserAccount: archive user ${archiveUserId} does not exist`);
    }

    const purged = zeroedResultMap();
    const reassigned = zeroedResultMap();
    const retired = zeroedResultMap();

    // ── 1. Private Projects: hard-delete first ────────────────────────────
    // Cascades: Evaluation -> EvaluationRun -> ModelJudgment/HumanJudgment/
    // RunCandidate/RunModelSelection. Must run before every later step, so
    // those later steps only ever see rows attached to *surviving* runs.
    const purgedProjects = await tx.project.deleteMany({
      where: { userId, visibility: 'private' },
    });
    purged.projects = purgedProjects.count;

    // ── 2. Public Projects: reassign ownership ─────────────────────────────
    const reassignedProjects = await tx.project.updateMany({
      where: { userId, visibility: 'public' },
      data: { userId: archiveUserId },
    });
    reassigned.projects = reassignedProjects.count;

    // ── 3. Evaluations still owned by this user ────────────────────────────
    // Evaluation.userId is `onDelete: Cascade` — anything left pointing at
    // this user after step 1 belongs to a surviving project (this user's
    // now-reassigned public project, or another user's project). Reassign
    // so the final user.delete() doesn't cascade-erase it.
    const reassignedEvaluations = await tx.evaluation.updateMany({
      where: { userId },
      data: { userId: archiveUserId },
    });
    reassigned.evaluations = reassignedEvaluations.count;

    // ── 4. Datasets: private delete, public reassign ───────────────────────
    const purgedDatasets = await tx.dataset.deleteMany({
      where: { userId, visibility: 'private' },
    });
    purged.datasets = purgedDatasets.count;

    const reassignedDatasets = await tx.dataset.updateMany({
      where: { userId, visibility: 'public' },
      data: { userId: archiveUserId },
    });
    reassigned.datasets = reassignedDatasets.count;

    // ── 5. GoldenSets: private retire-or-delete, public reassign owner ─────
    const reassignedGoldenSets = await tx.goldenSet.updateMany({
      where: { ownerId: userId, visibility: 'public' },
      data: { ownerId: archiveUserId },
    });
    reassigned.goldenSets = reassignedGoldenSets.count;

    // Private GoldenSets: hard-delete, UNLESS a CalibrationRun still
    // references it (`onDelete: Restrict` on CalibrationRun.goldenSetId) —
    // deleting through that would abort the transaction with a P2003
    // (1b-prereq (a): this is the "account-deletion hard-deletes private
    // GoldenSets but CalibrationRun.goldenSetId is Restrict -> tx abort"
    // carry from 1a). Check first and soft-retire instead of hard-deleting,
    // the same pattern step 7 below uses for Rubric. No ownership
    // reassignment needed on the retired path — GoldenSet.ownerId is
    // `onDelete: SetNull` (not Cascade like Rubric.userId), so leaving it
    // pointed at the about-to-be-deleted user is fine; the final
    // user.delete() nulls it out on its own.
    const privateGoldenSets = await tx.goldenSet.findMany({
      where: { ownerId: userId, visibility: 'private' },
      select: { id: true },
    });

    let purgedGoldenSetCount = 0;
    let retiredGoldenSetCount = 0;
    for (const goldenSet of privateGoldenSets) {
      // Shared predicate — see src/lib/golden-sets.ts. `tx` is passed
      // through rather than the singleton so this count and the update or
      // delete that follows it stay in ONE transaction: a CalibrationRun
      // that starts between them would otherwise pin a set this loop has
      // already decided to hard-delete, and the delete aborts the whole
      // account deletion on a P2003.
      if (await isGoldenSetFrozen(tx, goldenSet.id)) {
        await tx.goldenSet.update({
          where: { id: goldenSet.id },
          data: { retiredAt: new Date() },
        });
        retiredGoldenSetCount += 1;
      } else {
        await tx.goldenSet.delete({ where: { id: goldenSet.id } });
        purgedGoldenSetCount += 1;
      }
    }
    purged.goldenSets = purgedGoldenSetCount;
    retired.goldenSets = retiredGoldenSetCount;

    // GoldenLabel.annotatorId is `onDelete: SetNull` — anonymizes cleanly on
    // the final user.delete(); nothing to do here.

    // ── 6. HumanJudgments still owned by this user ─────────────────────────
    // HumanJudgment.userId is `onDelete: Cascade` (verified against
    // schema.prisma), NOT SetNull — a raw user.delete() would silently
    // delete any human judgment this user authored, even one sitting on a
    // surviving public run, destroying leaderboard provenance. Anything
    // left after step 1 is on a surviving run, so reassign it.
    const reassignedHumanJudgments = await tx.humanJudgment.updateMany({
      where: { userId },
      data: { userId: archiveUserId },
    });
    reassigned.humanJudgments = reassignedHumanJudgments.count;

    // ── 7. Rubrics ──────────────────────────────────────────────────────────
    // Public rubrics: reassign ownership.
    const reassignedRubrics = await tx.rubric.updateMany({
      where: { userId, visibility: 'public' },
      data: { userId: archiveUserId },
    });
    reassigned.rubrics = reassignedRubrics.count;

    // Private rubrics: hard-delete, UNLESS a surviving EvaluationRun still
    // pins it (`onDelete: Restrict` on EvaluationRun.rubricId) or it still
    // has child versions (`onDelete: NoAction` on Rubric.parentId) — either
    // would abort the transaction with a P2003 if we tried to delete
    // through it, so check first and soft-retire instead of hard-deleting.
    const privateRubrics = await tx.rubric.findMany({
      where: { userId, visibility: 'private' },
      select: { id: true },
    });

    let purgedRubricCount = 0;
    let retiredRubricCount = 0;
    for (const rubric of privateRubrics) {
      const [pinningRunCount, childVersionCount] = await Promise.all([
        tx.evaluationRun.count({ where: { rubricId: rubric.id } }),
        tx.rubric.count({ where: { parentId: rubric.id } }),
      ]);

      if (pinningRunCount > 0 || childVersionCount > 0) {
        // Retiring alone isn't enough: Rubric.userId is `onDelete: Cascade`,
        // so leaving ownership on the deleting user would have the final
        // user.delete() cascade-delete this "retired" row anyway — which
        // then aborts on the very same Restrict FK we're retiring to avoid.
        // Reassign ownership together with retiring it.
        await tx.rubric.update({
          where: { id: rubric.id },
          data: { retiredAt: new Date(), userId: archiveUserId },
        });
        retiredRubricCount += 1;
      } else {
        await tx.rubric.delete({ where: { id: rubric.id } });
        purgedRubricCount += 1;
      }
    }
    purged.rubrics = purgedRubricCount;
    retired.rubrics = retiredRubricCount;

    // ── 8. ModelConfigs owned by this user ─────────────────────────────────
    // ModelJudgment.modelConfigId is `onDelete: Restrict` — a config still
    // referenced by a surviving judgment can't be deleted at all, so
    // reassign it instead; unreferenced configs delete cleanly.
    //
    // EvaluationModelSelection.modelConfigId is `onDelete: Cascade` (not
    // Restrict), and is written independently of any run — an Evaluation
    // template's default model list is saved as soon as it's configured,
    // before any run (and therefore any ModelJudgment) exists. A config
    // referenced only there, by a surviving (public, or reassigned-above)
    // Evaluation, would pass the ModelJudgment-only check as "unreferenced"
    // and hard-delete, cascading away the surviving Evaluation's model
    // selection out from under it. So a config counts as referenced if
    // EITHER relation still points at it. (RunModelSelection needs no
    // separate check: it's always created atomically alongside a
    // ModelJudgment, so the ModelJudgment check already covers it.)
    const userConfigs = await tx.modelConfig.findMany({
      where: { userId },
      select: { id: true },
    });
    const userConfigIds = userConfigs.map((c) => c.id);

    let purgedConfigCount = 0;
    let reassignedConfigCount = 0;
    if (userConfigIds.length > 0) {
      const [judgmentRows, selectionRows] = await Promise.all([
        tx.modelJudgment.findMany({
          where: { modelConfigId: { in: userConfigIds } },
          select: { modelConfigId: true },
          distinct: ['modelConfigId'],
        }),
        tx.evaluationModelSelection.findMany({
          where: { modelConfigId: { in: userConfigIds } },
          select: { modelConfigId: true },
          distinct: ['modelConfigId'],
        }),
      ]);
      const referencedIds = new Set([
        ...judgmentRows.map((r) => r.modelConfigId),
        ...selectionRows.map((r) => r.modelConfigId),
      ]);
      const toReassign = userConfigIds.filter((id) => referencedIds.has(id));
      const toDelete = userConfigIds.filter((id) => !referencedIds.has(id));

      if (toReassign.length > 0) {
        const reassignedConfigs = await tx.modelConfig.updateMany({
          where: { id: { in: toReassign } },
          data: { userId: archiveUserId },
        });
        reassignedConfigCount = reassignedConfigs.count;
      }
      if (toDelete.length > 0) {
        const purgedConfigs = await tx.modelConfig.deleteMany({
          where: { id: { in: toDelete } },
        });
        purgedConfigCount = purgedConfigs.count;
      }
    }
    purged.modelConfigs = purgedConfigCount;
    reassigned.modelConfigs = reassignedConfigCount;

    // ── 9. Delete the user row ──────────────────────────────────────────────
    // Remaining direct relations are all non-destructive-to-others by now:
    // ModelEndpoint/DeveloperApiKey (Cascade, this user's own rows only),
    // AuditLog.userId (SetNull), GoldenLabel.annotatorId (SetNull),
    // EvaluationRun.triggeredById (SetNull) — this is where runs'
    // triggeredById actually goes to null.
    await tx.user.delete({ where: { id: userId } });
    purged.user = 1;

    return { purged, reassigned, retired };
  });
}
