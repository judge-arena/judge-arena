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

export interface DeleteUserAccountResult {
  purged: Record<string, number>;
  reassigned: Record<string, number>;
  retired: Record<string, number>;
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

    const purged: Record<string, number> = {};
    const reassigned: Record<string, number> = {};
    const retired: Record<string, number> = {};

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

    // ── 5. GoldenSets: private delete, public reassign owner ───────────────
    const purgedGoldenSets = await tx.goldenSet.deleteMany({
      where: { ownerId: userId, visibility: 'private' },
    });
    purged.goldenSets = purgedGoldenSets.count;

    const reassignedGoldenSets = await tx.goldenSet.updateMany({
      where: { ownerId: userId, visibility: 'public' },
      data: { ownerId: archiveUserId },
    });
    reassigned.goldenSets = reassignedGoldenSets.count;

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
