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
 *   - A private GoldenSet is never hard-deleted at all. One that a
 *     CalibrationRun still references (`onDelete: Restrict` on
 *     CalibrationRun.goldenSetId — 1b-prereq (a)) is soft-retired
 *     (`retiredAt` set, row kept): out of circulation, still valid ground
 *     truth for the run that measured it. One that nothing references is
 *     TOMBSTONED (`tombstonedAt` set, row kept): pending purge, which is a
 *     later wave. The two columns are not synonyms — `retiredAt` is a
 *     product state a user can choose and reverse, `tombstonedAt` is an
 *     account-lifecycle state only this function writes. That "is anything
 *     still referencing it" test is the golden-set FREEZE PREDICATE, and it
 *     has exactly one definition — `isGoldenSetFrozen` in
 *     src/lib/golden-sets.ts — shared with the golden-set route guards so
 *     the account-lifecycle path and the product path cannot drift into
 *     disagreeing about what "frozen" means (A0, "Freeze and fork"). Keeping
 *     the row on both paths is also what stops GoldenSet.parentId
 *     (`onDelete: NoAction`) aborting this transaction when the account
 *     holds a forked child set. Unlike Rubric.userId (`onDelete: Cascade`),
 *     GoldenSet.ownerId is `onDelete: SetNull`, so neither path needs an
 *     ownership reassignment to survive the final `user.delete()`.
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

    // Private GoldenSets are NEVER hard-deleted. Two soft paths, writing two
    // DIFFERENT columns, because they mean two different things:
    //
    //   - pinned by a CalibrationRun -> `retiredAt`. Out of circulation, but
    //     still valid ground truth: it is precisely what a finished
    //     calibration measured, and that run's kappa is uninterpretable
    //     without it. A PRODUCT verb — the same state
    //     `POST /api/golden-sets/[id]/retire` writes. Also the original
    //     1b-prereq (a) fix: CalibrationRun.goldenSetId is `onDelete:
    //     Restrict`, so deleting through it aborts this transaction.
    //   - unpinned -> `tombstonedAt`. Nothing references it and its owner is
    //     gone, so it is pending purge. An ACCOUNT-LIFECYCLE verb, kept in a
    //     column distinct from `retiredAt` so the two states stay
    //     distinguishable at the row level: a reader that cares can always
    //     tell "still valid ground truth for a run" apart from "pending
    //     purge, no longer owned by anyone". As of A0 there is no read-path
    //     distinction yet — `?includeRetired=true` clears BOTH the
    //     `retiredAt` and `tombstonedAt` filters together (src/app/api/
    //     golden-sets/route.ts:47-49, and the same shape in [id]/route.ts
    //     and [id]/items/route.ts), so a tombstoned set is exposed by the
    //     same flag a retired one is. Giving tombstoned sets their own
    //     escape hatch (or none at all) is a later task's job; this one only
    //     writes the correct column so that distinction is possible.
    //
    // The unpinned branch used to hard-delete. Beyond the owner's
    // "hard deletion may lose data" ruling, A0 has a mechanical reason to
    // stop: GoldenSet gained `parentId` with `onDelete: NoAction`, so
    // deleting a forked PARENT while its child row still exists raises P2003
    // and rolls back this entire transaction — the user, and every
    // reassignment above, left undone. Deleting nothing means that FK is
    // never exercised, so no child-version guard is needed here (unlike the
    // Rubric branch below, which still hard-deletes and therefore still
    // checks).
    //
    // Neither path reassigns ownership: GoldenSet.ownerId is `onDelete:
    // SetNull` (not Cascade like Rubric.userId), so the kept row resolves to
    // `ownerId: null` on its own at the final user.delete().
    const privateGoldenSets = await tx.goldenSet.findMany({
      where: { ownerId: userId, visibility: 'private' },
      select: { id: true },
    });

    let tombstonedGoldenSetCount = 0;
    let retiredGoldenSetCount = 0;
    for (const goldenSet of privateGoldenSets) {
      // Shared predicate — see src/lib/golden-sets.ts. `tx` is passed
      // through rather than the singleton so this check and the update that
      // follows it stay in ONE transaction: a CalibrationRun that starts
      // between them would otherwise pin a set this loop has already
      // decided to tombstone. ONE definition of "frozen", shared with the
      // golden-set route guards (PATCH/DELETE `/api/golden-sets/[id]`) — do
      // not re-inline the CalibrationRun count here.
      if (await isGoldenSetFrozen(tx, goldenSet.id)) {
        await tx.goldenSet.update({
          where: { id: goldenSet.id },
          data: { retiredAt: new Date() },
        });
        retiredGoldenSetCount += 1;
      } else {
        await tx.goldenSet.update({
          where: { id: goldenSet.id },
          data: { tombstonedAt: new Date() },
        });
        tombstonedGoldenSetCount += 1;
      }
    }

    // RESULT_CATEGORIES is a frozen 8-key set — tests/db/account-deletion.
    // test.ts:461-483 asserts Object.keys() of all three maps equals it
    // exactly — so tombstones get neither a new key nor a fourth map. They
    // are tallied under `retired`, which already means "soft-handled, row
    // kept" for Rubric in step 7. `purged.goldenSets` is now structurally 0:
    // assigned explicitly so a future edit that reintroduces a delete has to
    // notice this line.
    purged.goldenSets = 0;
    retired.goldenSets = retiredGoldenSetCount + tombstonedGoldenSetCount;

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
