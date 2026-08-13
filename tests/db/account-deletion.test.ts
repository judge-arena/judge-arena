import { describe, it, expect, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { db, truncateAll, mkUser, mkRubric } from './helpers';
import { deleteUserAccount } from '@/lib/account-deletion';

// ─── Local fixture helpers ──────────────────────────────────────────────────
// Project/Evaluation/EvaluationRun/ModelConfig chain-builders mirror
// tests/db/judgment-provenance.test.ts (kept file-local per the established
// "shared only once actually shared" convention — this file needs its own
// `visibility` override on mkProject that the provenance file doesn't).

async function mkProject(
  userId: string,
  overrides: Partial<Omit<Prisma.ProjectUncheckedCreateInput, 'userId'>> = {}
) {
  return db.project.create({ data: { name: 'fixture-project', userId, ...overrides } });
}

async function mkEvaluation(
  projectId: string,
  userId: string,
  overrides: Partial<{ rubricId: string }> = {}
) {
  return db.evaluation.create({
    data: { projectId, userId, inputText: 'fixture input', ...overrides },
  });
}

async function mkEvaluationRun(
  evaluationId: string,
  triggeredById: string | null,
  overrides: Partial<{ rubricId: string }> = {}
) {
  return db.evaluationRun.create({
    data: { evaluationId, triggeredById, ...overrides },
  });
}

let modelConfigCounter = 0;

async function mkModelConfig(userId: string) {
  modelConfigCounter += 1;
  return db.modelConfig.create({
    data: {
      name: `fixture-model-${modelConfigCounter}`,
      provider: 'openai',
      modelId: 'gpt-4',
      userId,
    },
  });
}

// A0: GoldenSet.datasetId is required and `onDelete: Restrict`. The corpus is
// owned by a SEPARATE user and marked public, mirroring production (golden
// sets may only be built over public platform-owned datasets) — deleteUserAccount
// hard-deletes a departing user's PRIVATE datasets, which would abort on the
// Restrict FK if the fixture put the corpus under the same owner.
let goldenCorpusCounter = 0;

async function mkGoldenCorpus() {
  const platformUser = await mkUser();
  goldenCorpusCounter += 1;
  return db.dataset.create({
    data: {
      name: `fixture-golden-corpus-${goldenCorpusCounter}`,
      userId: platformUser.id,
      source: 'local',
      visibility: 'public',
    },
  });
}

// A CalibrationRun needs a JudgeModelVersion; kept file-local per the
// established "shared only once actually shared" convention — same shape as
// tests/db/meta-eval.test.ts's own copy.
let judgeModelCounter = 0;

async function mkJudgeModelVersion() {
  judgeModelCounter += 1;
  const judgeModel = await db.judgeModel.create({
    data: {
      name: `fixture-judge-${judgeModelCounter}`,
      slug: `fixture-judge-${judgeModelCounter}`,
      judgeClass: 'prompted_api',
      scoringMechanism: 'critique_generative',
    },
  });
  return db.judgeModelVersion.create({
    data: {
      judgeModelId: judgeModel.id,
      ordinal: 1,
      servingBackend: 'openai',
      protocolSupport: { pointwise: ['score'] },
    },
  });
}

// A GoldenSet needs a source Dataset and a protocol as of the v2d golden
// substrate migration. The dataset is deliberately owned by a SEPARATE user:
// golden sets are built from platform-curated public corpora, and a source
// dataset owned by the *deleting* user would be hard-deleted by step 4 of
// deleteUserAccount before step 5 ever runs — aborting on
// GoldenSet.datasetId's Restrict FK. POST /api/golden-sets only accepts
// platform-owned public datasets, so that combination is unreachable
// through the API and is not what this file is testing.
let goldenSetCounter = 0;

async function mkGoldenSet(
  ownerId: string,
  overrides: Partial<Omit<Prisma.GoldenSetUncheckedCreateInput, 'ownerId'>> = {}
) {
  goldenSetCounter += 1;
  const platformUser = await mkUser();
  const dataset = await db.dataset.create({
    data: {
      name: `fixture-golden-source-${goldenSetCounter}`,
      userId: platformUser.id,
      visibility: 'public',
    },
  });
  return db.goldenSet.create({
    data: {
      name: `fixture-golden-set-${goldenSetCounter}`,
      // GoldenSet has a hand-edited @@unique([ownerId, slug]) with NULLS NOT
      // DISTINCT (schema.prisma:689-696) — at most one slug-NULL set per
      // owner. Default a real slug here so any caller building two or more
      // sets under the same owner through this helper doesn't have to
      // remember to supply one to avoid a P2002.
      slug: `fixture-golden-set-${goldenSetCounter}`,
      ownerId,
      datasetId: dataset.id,
      protocol: 'pairwise',
      ...overrides,
    },
  });
}

describe('deleteUserAccount (P1.7 account deletion)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('throws if userId === archiveUserId', async () => {
    const user = await mkUser();

    await expect(deleteUserAccount(user.id, { archiveUserId: user.id })).rejects.toThrow();

    // nothing should have happened
    expect(await db.user.findUnique({ where: { id: user.id } })).not.toBeNull();
  });

  it('throws if the archive user does not exist, and rolls back / does nothing', async () => {
    const user = await mkUser();

    await expect(
      deleteUserAccount(user.id, { archiveUserId: 'does-not-exist' })
    ).rejects.toThrow();

    expect(await db.user.findUnique({ where: { id: user.id } })).not.toBeNull();
  });

  it(
    'purges the private project (+ its evaluation/run), reassigns the public project ' +
      "(+ its evaluation), nulls the surviving run's triggeredById, and removes the user row",
    async () => {
      const archiveUser = await mkUser();
      const owner = await mkUser();

      const privateProject = await mkProject(owner.id); // visibility defaults to private
      const publicProject = await mkProject(owner.id, { visibility: 'public' });

      const privateEvaluation = await mkEvaluation(privateProject.id, owner.id);
      const privateRun = await mkEvaluationRun(privateEvaluation.id, owner.id);

      const publicEvaluation = await mkEvaluation(publicProject.id, owner.id);
      const publicRun = await mkEvaluationRun(publicEvaluation.id, owner.id);

      const result = await deleteUserAccount(owner.id, { archiveUserId: archiveUser.id });

      // private project + its evaluation + its run are gone (cascade)
      expect(await db.project.findUnique({ where: { id: privateProject.id } })).toBeNull();
      expect(await db.evaluation.findUnique({ where: { id: privateEvaluation.id } })).toBeNull();
      expect(await db.evaluationRun.findUnique({ where: { id: privateRun.id } })).toBeNull();

      // public project survives, reassigned to the archive user
      const survivedProject = await db.project.findUnique({ where: { id: publicProject.id } });
      expect(survivedProject).not.toBeNull();
      expect(survivedProject?.userId).toBe(archiveUser.id);

      // its evaluation survives too (reassigned — else Evaluation.userId's
      // own Cascade FK would have erased it out from under the surviving
      // project when the user row is deleted)
      const survivedEvaluation = await db.evaluation.findUnique({
        where: { id: publicEvaluation.id },
      });
      expect(survivedEvaluation).not.toBeNull();
      expect(survivedEvaluation?.userId).toBe(archiveUser.id);

      // the run survives, triggeredById nulled via FK (not reassigned)
      const survivedRun = await db.evaluationRun.findUnique({ where: { id: publicRun.id } });
      expect(survivedRun).not.toBeNull();
      expect(survivedRun?.triggeredById).toBeNull();

      // user row is gone
      expect(await db.user.findUnique({ where: { id: owner.id } })).toBeNull();

      expect(result.purged.projects).toBe(1);
      expect(result.reassigned.projects).toBe(1);
      expect(result.reassigned.evaluations).toBe(1);
      expect(result.purged.user).toBe(1);
    }
  );

  it('soft-retires (sets retiredAt, keeps the row) a private rubric still pinned by a surviving run', async () => {
    const archiveUser = await mkUser();
    const owner = await mkUser();
    const rubric = await mkRubric(owner.id); // visibility defaults to private

    const publicProject = await mkProject(owner.id, { visibility: 'public' });
    const evaluation = await mkEvaluation(publicProject.id, owner.id);
    const run = await mkEvaluationRun(evaluation.id, owner.id, { rubricId: rubric.id });

    const result = await deleteUserAccount(owner.id, { archiveUserId: archiveUser.id });

    const survivedRubric = await db.rubric.findUnique({ where: { id: rubric.id } });
    expect(survivedRubric).not.toBeNull();
    expect(survivedRubric?.retiredAt).not.toBeNull();
    expect(survivedRubric?.visibility).toBe('private');
    // ownership must also transfer — Rubric.userId is `onDelete: Cascade`,
    // so a retired-but-still-owned-by-the-deleted-user row would vanish
    // (and abort the transaction on its own pinning-run Restrict FK) the
    // moment the user row is deleted.
    expect(survivedRubric?.userId).toBe(archiveUser.id);

    // the pinning run is untouched — rubricId still points at the retired rubric
    const survivedRun = await db.evaluationRun.findUnique({ where: { id: run.id } });
    expect(survivedRun?.rubricId).toBe(rubric.id);

    expect(result.retired.rubrics).toBe(1);
    expect(result.purged.rubrics ?? 0).toBe(0);
  });

  it('hard-deletes a private rubric with no surviving pinning run', async () => {
    const archiveUser = await mkUser();
    const owner = await mkUser();
    const rubric = await mkRubric(owner.id);

    const result = await deleteUserAccount(owner.id, { archiveUserId: archiveUser.id });

    expect(await db.rubric.findUnique({ where: { id: rubric.id } })).toBeNull();
    expect(result.purged.rubrics).toBe(1);
    expect(result.retired.rubrics ?? 0).toBe(0);
  });

  it('reassigns a HumanJudgment on a surviving public run, but lets one on a purged private run cascade away', async () => {
    const archiveUser = await mkUser();
    const owner = await mkUser();

    const privateProject = await mkProject(owner.id);
    const privateEvaluation = await mkEvaluation(privateProject.id, owner.id);
    const privateRun = await mkEvaluationRun(privateEvaluation.id, owner.id);
    const privateHumanJudgment = await db.humanJudgment.create({
      data: { runId: privateRun.id, userId: owner.id, overallScore: 5 },
    });

    const publicProject = await mkProject(owner.id, { visibility: 'public' });
    const publicEvaluation = await mkEvaluation(publicProject.id, owner.id);
    const publicRun = await mkEvaluationRun(publicEvaluation.id, owner.id);
    const publicHumanJudgment = await db.humanJudgment.create({
      data: { runId: publicRun.id, userId: owner.id, overallScore: 8 },
    });

    const result = await deleteUserAccount(owner.id, { archiveUserId: archiveUser.id });

    // private run's human judgment is gone (cascade with the private project)
    expect(
      await db.humanJudgment.findUnique({ where: { id: privateHumanJudgment.id } })
    ).toBeNull();

    // public run's human judgment survives, reassigned — NOT cascade-deleted,
    // even though HumanJudgment.userId is `onDelete: Cascade` in this schema
    const survivedJudgment = await db.humanJudgment.findUnique({
      where: { id: publicHumanJudgment.id },
    });
    expect(survivedJudgment).not.toBeNull();
    expect(survivedJudgment?.userId).toBe(archiveUser.id);

    expect(result.reassigned.humanJudgments).toBe(1);
  });

  it('reassigns a ModelConfig still referenced by a surviving judgment, but deletes an unreferenced one', async () => {
    const archiveUser = await mkUser();
    const owner = await mkUser();

    const referencedConfig = await mkModelConfig(owner.id);
    const unreferencedConfig = await mkModelConfig(owner.id);

    const publicProject = await mkProject(owner.id, { visibility: 'public' });
    const publicEvaluation = await mkEvaluation(publicProject.id, owner.id);
    const publicRun = await mkEvaluationRun(publicEvaluation.id, owner.id);
    await db.modelJudgment.create({
      data: { runId: publicRun.id, modelConfigId: referencedConfig.id },
    });

    // this judgment (and its run) is purged along with the private project,
    // so by the time ModelConfig cleanup runs, unreferencedConfig really is
    // unreferenced
    const privateProject = await mkProject(owner.id);
    const privateEvaluation = await mkEvaluation(privateProject.id, owner.id);
    const privateRun = await mkEvaluationRun(privateEvaluation.id, owner.id);
    await db.modelJudgment.create({
      data: { runId: privateRun.id, modelConfigId: unreferencedConfig.id },
    });

    const result = await deleteUserAccount(owner.id, { archiveUserId: archiveUser.id });

    const survivedConfig = await db.modelConfig.findUnique({
      where: { id: referencedConfig.id },
    });
    expect(survivedConfig).not.toBeNull();
    expect(survivedConfig?.userId).toBe(archiveUser.id);

    expect(await db.modelConfig.findUnique({ where: { id: unreferencedConfig.id } })).toBeNull();

    expect(result.reassigned.modelConfigs).toBe(1);
    expect(result.purged.modelConfigs).toBe(1);
  });

  it(
    'reassigns a ModelConfig referenced only via a surviving Evaluation\'s ' +
      'EvaluationModelSelection (default model list, no run ever created)',
    async () => {
      const archiveUser = await mkUser();
      const owner = await mkUser();

      const config = await mkModelConfig(owner.id);

      const publicProject = await mkProject(owner.id, { visibility: 'public' });
      const publicEvaluation = await mkEvaluation(publicProject.id, owner.id);
      await db.evaluationModelSelection.create({
        data: { evaluationId: publicEvaluation.id, modelConfigId: config.id },
      });

      const result = await deleteUserAccount(owner.id, { archiveUserId: archiveUser.id });

      // the selection row survives (not cascaded away)
      const survivedSelection = await db.evaluationModelSelection.findFirst({
        where: { evaluationId: publicEvaluation.id, modelConfigId: config.id },
      });
      expect(survivedSelection).not.toBeNull();

      // the config it points at is reassigned, not hard-deleted
      const survivedConfig = await db.modelConfig.findUnique({ where: { id: config.id } });
      expect(survivedConfig).not.toBeNull();
      expect(survivedConfig?.userId).toBe(archiveUser.id);

      expect(result.reassigned.modelConfigs).toBe(1);
      expect(result.purged.modelConfigs ?? 0).toBe(0);
    }
  );

  it('reassigns a public Rubric not pinned by any run', async () => {
    const archiveUser = await mkUser();
    const owner = await mkUser();
    const rubric = await mkRubric(owner.id, { visibility: 'public' });

    const result = await deleteUserAccount(owner.id, { archiveUserId: archiveUser.id });

    const survivedRubric = await db.rubric.findUnique({ where: { id: rubric.id } });
    expect(survivedRubric).not.toBeNull();
    expect(survivedRubric?.userId).toBe(archiveUser.id);
    expect(survivedRubric?.visibility).toBe('public');

    expect(result.reassigned.rubrics).toBe(1);
  });

  it('deletes a private Dataset but reassigns a public one', async () => {
    const archiveUser = await mkUser();
    const owner = await mkUser();
    const privateDataset = await db.dataset.create({
      data: { name: 'fixture-private-ds', userId: owner.id },
    });
    const publicDataset = await db.dataset.create({
      data: { name: 'fixture-public-ds', userId: owner.id, visibility: 'public' },
    });

    const result = await deleteUserAccount(owner.id, { archiveUserId: archiveUser.id });

    expect(await db.dataset.findUnique({ where: { id: privateDataset.id } })).toBeNull();
    const survived = await db.dataset.findUnique({ where: { id: publicDataset.id } });
    expect(survived).not.toBeNull();
    expect(survived?.userId).toBe(archiveUser.id);

    expect(result.purged.datasets).toBe(1);
    expect(result.reassigned.datasets).toBe(1);
  });

  it('tombstones a private GoldenSet but reassigns a public one', async () => {
    const archiveUser = await mkUser();
    const owner = await mkUser();
    const corpus = await mkGoldenCorpus();
    const privateGoldenSet = await db.goldenSet.create({
      data: {
        name: 'fixture-private-gs',
        slug: 'fixture-private-gs',
        ownerId: owner.id,
        datasetId: corpus.id,
        protocol: 'pointwise',
      },
    });
    const publicGoldenSet = await db.goldenSet.create({
      data: {
        name: 'fixture-public-gs',
        slug: 'fixture-public-gs',
        ownerId: owner.id,
        visibility: 'public',
        datasetId: corpus.id,
        protocol: 'pointwise',
      },
    });

    const result = await deleteUserAccount(owner.id, { archiveUserId: archiveUser.id });

    // Private GoldenSets are never hard-deleted (see account-deletion.ts
    // step 5) — the row is kept and tombstoned instead.
    const survivedPrivate = await db.goldenSet.findUnique({ where: { id: privateGoldenSet.id } });
    expect(survivedPrivate).not.toBeNull();
    expect(survivedPrivate?.tombstonedAt).not.toBeNull();
    expect(survivedPrivate?.retiredAt).toBeNull();

    const survived = await db.goldenSet.findUnique({ where: { id: publicGoldenSet.id } });
    expect(survived).not.toBeNull();
    expect(survived?.ownerId).toBe(archiveUser.id);

    expect(result.purged.goldenSets).toBe(0);
    expect(result.retired.goldenSets).toBe(1);
    expect(result.reassigned.goldenSets).toBe(1);
  });

  it(
    'soft-retires (sets retiredAt, keeps the row) a private GoldenSet a CalibrationRun still ' +
      'references, and the user delete still completes (1b-prereq (a): a raw hard-delete would ' +
      "abort the transaction on CalibrationRun.goldenSetId's Restrict FK)",
    async () => {
      const archiveUser = await mkUser();
      const owner = await mkUser();
      const corpus = await mkGoldenCorpus();
      const goldenSet = await db.goldenSet.create({
        data: {
          name: 'fixture-golden-set-with-run',
          slug: 'fixture-golden-set-with-run',
          ownerId: owner.id,
          datasetId: corpus.id,
          protocol: 'pointwise',
        },
      });
      const judgeModelVersion = await mkJudgeModelVersion();
      const calibrationRun = await db.calibrationRun.create({
        data: { judgeModelVersionId: judgeModelVersion.id, goldenSetId: goldenSet.id },
      });

      const result = await deleteUserAccount(owner.id, { archiveUserId: archiveUser.id });

      // user delete completed — this is the whole point: pre-fix, this
      // would have thrown (P2003) and rolled back the entire transaction,
      // leaving the user row (and everything else in it) undeleted.
      expect(await db.user.findUnique({ where: { id: owner.id } })).toBeNull();

      const survivedGoldenSet = await db.goldenSet.findUnique({ where: { id: goldenSet.id } });
      expect(survivedGoldenSet).not.toBeNull();
      expect(survivedGoldenSet?.retiredAt).not.toBeNull();
      expect(survivedGoldenSet?.visibility).toBe('private');
      // GoldenSet.ownerId is `onDelete: SetNull` (unlike Rubric.userId's
      // Cascade) — no reassignment needed for the retired row to survive;
      // it resolves to null on its own.
      expect(survivedGoldenSet?.ownerId).toBeNull();

      // the pinning calibration run is untouched
      const survivedRun = await db.calibrationRun.findUnique({ where: { id: calibrationRun.id } });
      expect(survivedRun?.goldenSetId).toBe(goldenSet.id);

      expect(result.retired.goldenSets).toBe(1);
      expect(result.purged.goldenSets ?? 0).toBe(0);
    }
  );

  it(
    'tombstones (sets tombstonedAt, keeps the row) a private GoldenSet no CalibrationRun ' +
      'references, instead of hard-deleting it — and leaves retiredAt NULL, because the two ' +
      'columns are not synonyms: retiredAt means out-of-circulation-but-still-valid-ground-' +
      'truth (a product verb), tombstonedAt means pending-purge (an account-lifecycle verb)',
    async () => {
      const archiveUser = await mkUser();
      const owner = await mkUser();
      const goldenSet = await mkGoldenSet(owner.id, { name: 'fixture-golden-set-no-run' });

      const result = await deleteUserAccount(owner.id, { archiveUserId: archiveUser.id });

      expect(await db.user.findUnique({ where: { id: owner.id } })).toBeNull();

      const survived = await db.goldenSet.findUnique({ where: { id: goldenSet.id } });
      expect(survived).not.toBeNull();
      expect(survived?.tombstonedAt).not.toBeNull();
      // The load-bearing assertion: the tombstone write must stamp
      // `tombstonedAt`, not `retiredAt`, so the two account-lifecycle-vs-
      // product states stay distinguishable at the row level. (As of A0,
      // `?includeRetired=true` still clears both filters together — see
      // src/app/api/golden-sets/route.ts:47-49 — so there is no read-path
      // distinction yet; that's a later task. This assertion only checks
      // that deleteUserAccount writes the correct column.)
      expect(survived?.retiredAt).toBeNull();
      // GoldenSet.ownerId is `onDelete: SetNull` — the kept row needs no
      // ownership reassignment to survive the final user.delete().
      expect(survived?.ownerId).toBeNull();

      // Nothing in deleteUserAccount deletes a GoldenSet row any more.
      expect(result.purged.goldenSets).toBe(0);
      expect(result.retired.goldenSets).toBe(1);
    }
  );

  it(
    'tombstones a FORKED CHILD golden set and its parent together and keeps the lineage edge — ' +
      'hard-deleting the parent would abort the whole transaction on GoldenSet.parentId ' +
      "(`onDelete: NoAction`) with a P2003, leaving the user row undeleted",
    async () => {
      const archiveUser = await mkUser();
      const owner = await mkUser();
      const parent = await mkGoldenSet(owner.id, { name: 'fixture-golden-parent' });
      // GoldenSet has a hand-edited @@unique([ownerId, slug]) with NULLS NOT
      // DISTINCT (schema.prisma:689-696) — at most one slug-NULL set per
      // owner. `mkGoldenSet` defaults the parent to a real (non-NULL) slug,
      // so the child below only needs its OWN distinct slug to avoid
      // colliding with the parent's — matching the established convention
      // of explicit slugs whenever a fixture puts two+ sets under one owner.
      const child = await db.goldenSet.create({
        data: {
          name: 'fixture-golden-child',
          slug: 'fixture-golden-child',
          ownerId: owner.id,
          datasetId: parent.datasetId,
          protocol: parent.protocol,
          parentId: parent.id,
          version: 2,
        },
      });

      const result = await deleteUserAccount(owner.id, { archiveUserId: archiveUser.id });

      // The whole point: the transaction committed.
      expect(await db.user.findUnique({ where: { id: owner.id } })).toBeNull();

      const survivedParent = await db.goldenSet.findUnique({ where: { id: parent.id } });
      const survivedChild = await db.goldenSet.findUnique({ where: { id: child.id } });
      expect(survivedParent?.tombstonedAt).not.toBeNull();
      expect(survivedChild?.tombstonedAt).not.toBeNull();

      // Lineage survives the tombstone — the later purge wave needs it to
      // delete children before parents.
      expect(survivedChild?.parentId).toBe(parent.id);
      expect(survivedChild?.version).toBe(2);

      expect(result.purged.goldenSets).toBe(0);
      expect(result.retired.goldenSets).toBe(2);
    }
  );

  it(
    '1b-prereq (c): purged/reassigned/retired result maps always carry the SAME full set of ' +
      'keys, defaulted to 0 — never sparse just because a category had nothing to do',
    async () => {
      const archiveUser = await mkUser();
      const owner = await mkUser();

      // Deliberately minimal scenario: nothing but the user row itself.
      // Every category this function ever tallies must still appear, at 0,
      // in every map it doesn't touch — not merely `undefined`.
      const result = await deleteUserAccount(owner.id, { archiveUserId: archiveUser.id });

      const expectedKeys = [
        'projects',
        'evaluations',
        'datasets',
        'goldenSets',
        'humanJudgments',
        'rubrics',
        'modelConfigs',
        'user',
      ].sort();

      expect(Object.keys(result.purged).sort()).toEqual(expectedKeys);
      expect(Object.keys(result.reassigned).sort()).toEqual(expectedKeys);
      expect(Object.keys(result.retired).sort()).toEqual(expectedKeys);

      // Every value is a number (0, not undefined) for every key, in every map.
      for (const map of [result.purged, result.reassigned, result.retired]) {
        for (const key of expectedKeys) {
          expect(typeof map[key]).toBe('number');
        }
      }

      // Categories this minimal scenario didn't touch are exactly 0, not
      // merely present-but-undefined.
      expect(result.reassigned.datasets).toBe(0);
      expect(result.retired.datasets).toBe(0);
      expect(result.retired.projects).toBe(0);
      expect(result.retired.user).toBe(0);
      expect(result.purged.evaluations).toBe(0);

      // The one thing that DID happen in this scenario.
      expect(result.purged.user).toBe(1);
    }
  );
});
