import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createImportCtx } from '../../scripts/importer/context';
import { resolveOwners, ARCHIVE_USER_EMAIL } from '../../scripts/importer/owners';
import { importArtifacts } from '../../scripts/importer/artifacts';
import { db, truncateAll } from '../db/helpers';
import {
  v1db,
  truncateAllV1,
  mkV1User,
  mkV1Project,
  mkV1Rubric,
  mkV1RubricCriterion,
  mkV1Dataset,
  mkV1DatasetSample,
  mkV1Evaluation,
} from './helpers';
import type { OwnerMap } from '../../scripts/importer/context';

// DB-backed: needs BOTH the v1 scratch DB (V1_DATABASE_URL) and the v2 test
// DB (DATABASE_URL/TEST_DATABASE_URL) reachable. Named *.db.test.ts and
// listed in vitest.db.config.ts's include (NOT vitest.config.ts's), so
// plain `npm test` never runs this file — see tests/importer/helpers.ts.
describe('importArtifacts (DB)', () => {
  beforeEach(async () => {
    await truncateAll();
    await truncateAllV1();
  });

  afterAll(async () => {
    await v1db.$disconnect();
    await db.$disconnect();
  });

  it(
    'full fixture: rubric v1+v2 chain, project (+dropped +default-archived), ' +
      'dataset with 2 samples (+dropped), 2 evaluations (1 surviving, 1 dropped via its project) — ' +
      'id-map completeness, criterion remap, and report counts all match the fixture arithmetic',
    async () => {
      const userA = await mkV1User(); // mapped
      const userB = await mkV1User(); // dropped (absent from ownerMap entirely)

      const ownerMap: OwnerMap = {
        [userA.id]: { email: 'a@v2.example', oidcIssuer: 'https://idp.test.local', oidcSubject: 'sub-a' },
      };
      const ctx = createImportCtx({ mode: 'apply', ownerMap });
      const owners = await resolveOwners(ctx);

      // ── Rubric v1 (root) + v2 (child), each with one criterion ──
      const rootRubric = await mkV1Rubric(userA.id, { name: 'Correctness', version: 1 });
      const rootCriterion = await mkV1RubricCriterion(rootRubric.id, { name: 'Accuracy', order: 0 });
      const childRubric = await mkV1Rubric(userA.id, {
        name: 'Correctness',
        version: 2,
        parentId: rootRubric.id,
      });
      const childCriterion = await mkV1RubricCriterion(childRubric.id, { name: 'Accuracy v2', order: 0 });

      // A rubric owned by the dropped user: always dropped, no archive path.
      const droppedRubric = await mkV1Rubric(userB.id, { name: 'Owned by dropped user' });
      const droppedRubricCriterion = await mkV1RubricCriterion(droppedRubric.id, { name: 'N/A' });

      // ── Projects: surviving, dropped, and default-archived ──
      const project = await mkV1Project(userA.id, { name: 'Main project' });
      const droppedProject = await mkV1Project(userB.id, { name: 'Dropped project' });
      const defaultProject = await mkV1Project(userB.id, {
        name: 'Leaderboard',
        isDefault: true,
      });

      // ── Dataset (+2 samples) and a dropped dataset (+1 sample) ──
      const dataset = await mkV1Dataset(userA.id, {
        name: 'Eval set',
        projectId: project.id,
        visibility: 'private',
        inputType: 'query-response',
      });
      const sample1 = await mkV1DatasetSample(dataset.id, 0, { input: 'q1', expected: 'a1' });
      const sample2 = await mkV1DatasetSample(dataset.id, 1, { input: 'q2', expected: 'a2' });

      const droppedDataset = await mkV1Dataset(userB.id, { visibility: 'private' });
      await mkV1DatasetSample(droppedDataset.id, 0);

      // ── Evaluations: one survives (under `project`), one is dropped
      // because its project (`droppedProject`) never made it into v2. ──
      const survivingEvaluation = await mkV1Evaluation(project.id, userA.id, {
        title: 'Surviving eval',
        rubricId: childRubric.id,
        datasetId: dataset.id,
        datasetSampleId: sample1.id,
      });
      const droppedEvaluation = await mkV1Evaluation(droppedProject.id, userB.id, {
        title: 'Dropped-with-its-project eval',
      });

      const ids = await importArtifacts(ctx, owners);

      // ── Id-map completeness: every surviving v1 id has a v2 id ──
      expect(ids.rubric.get(rootRubric.id)).toBeTruthy();
      expect(ids.rubric.get(childRubric.id)).toBeTruthy();
      expect(ids.rubric.has(droppedRubric.id)).toBe(false);
      expect(ids.criterion.get(rootCriterion.id)).toBeTruthy();
      expect(ids.criterion.get(childCriterion.id)).toBeTruthy();
      expect(ids.criterion.has(droppedRubricCriterion.id)).toBe(false);

      expect(ids.project.get(project.id)).toBeTruthy();
      expect(ids.project.has(droppedProject.id)).toBe(false);
      expect(ids.project.get(defaultProject.id)).toBeTruthy();

      expect(ids.dataset.get(dataset.id)).toBeTruthy();
      expect(ids.dataset.has(droppedDataset.id)).toBe(false);
      expect(ids.sample.get(sample1.id)).toBeTruthy();
      expect(ids.sample.get(sample2.id)).toBeTruthy();

      expect(ids.evaluation.get(survivingEvaluation.id)).toBeTruthy();
      expect(ids.evaluation.has(droppedEvaluation.id)).toBe(false);

      // ── Rubric chain lineage preserved through the remap ──
      const v2Root = await db.rubric.findUnique({ where: { id: ids.rubric.get(rootRubric.id)! } });
      const v2Child = await db.rubric.findUnique({ where: { id: ids.rubric.get(childRubric.id)! } });
      expect(v2Root).toMatchObject({ version: 1, parentId: null });
      expect(v2Child).toMatchObject({ version: 2, parentId: v2Root!.id });

      // ── Default/leaderboard project: archived + made public ──
      const archiveUser = await db.user.findFirst({ where: { email: ARCHIVE_USER_EMAIL } });
      const v2DefaultProject = await db.project.findUnique({ where: { id: ids.project.get(defaultProject.id)! } });
      expect(v2DefaultProject).toMatchObject({
        isDefault: true,
        visibility: 'public',
        userId: archiveUser!.id,
      });

      // ── Ordinary (non-default) project keeps its default private visibility ──
      const v2Project = await db.project.findUnique({ where: { id: ids.project.get(project.id)! } });
      expect(v2Project).toMatchObject({ visibility: 'private', userId: owners.get(userA.id) });

      // ── Dataset fields + samples carried, visibility as-is ──
      const v2Dataset = await db.dataset.findUnique({
        where: { id: ids.dataset.get(dataset.id)! },
        include: { samples: true },
      });
      expect(v2Dataset).toMatchObject({ name: 'Eval set', visibility: 'private', projectId: v2Project!.id });
      expect(v2Dataset!.samples).toHaveLength(2);

      // ── Evaluation remaps: rubricId/datasetId/datasetSampleId/userId ──
      const v2Evaluation = await db.evaluation.findUnique({
        where: { id: ids.evaluation.get(survivingEvaluation.id)! },
      });
      expect(v2Evaluation).toMatchObject({
        projectId: v2Project!.id,
        rubricId: v2Child!.id,
        datasetId: v2Dataset!.id,
        datasetSampleId: ids.sample.get(sample1.id),
        userId: owners.get(userA.id),
        title: 'Surviving eval',
      });

      // ── Timestamps preserved (verify one row per the task's own checklist) ──
      expect(v2Root!.createdAt.getTime()).toBe(rootRubric.createdAt.getTime());
      expect(v2Root!.updatedAt.getTime()).toBe(rootRubric.updatedAt.getTime());

      // ── Report counts match the fixture arithmetic ──
      const counts = ctx.report.counts();
      expect(counts.Rubric).toMatchObject({ created: 2, dropped: 1 });
      expect(counts.RubricCriterion).toMatchObject({ created: 2, dropped: 1 });
      expect(counts.Project).toMatchObject({ created: 2, dropped: 1 }); // project + defaultProject
      expect(counts.Dataset).toMatchObject({ created: 1, dropped: 1 });
      expect(counts.DatasetSample).toMatchObject({ created: 2, dropped: 1 });
      expect(counts.Evaluation).toMatchObject({ created: 1, dropped: 1 });

      // Real row counts in v2 match what wasn't dropped.
      expect(await db.rubric.count()).toBe(2);
      expect(await db.rubricCriterion.count()).toBe(2);
      expect(await db.project.count()).toBe(2);
      expect(await db.dataset.count()).toBe(1);
      expect(await db.datasetSample.count()).toBe(2);
      expect(await db.evaluation.count()).toBe(1);
    }
  );

  it('is idempotent in apply mode: re-running the full fixture leaves row counts stable', async () => {
    const userA = await mkV1User();
    const ownerMap: OwnerMap = {
      [userA.id]: { email: 'idem@v2.example', oidcIssuer: 'https://idp.test.local', oidcSubject: 'sub-idem' },
    };

    const rootRubric = await mkV1Rubric(userA.id, { name: 'Idempotent rubric', version: 1 });
    await mkV1RubricCriterion(rootRubric.id, { name: 'Only criterion' });
    const project = await mkV1Project(userA.id);
    const dataset = await mkV1Dataset(userA.id, { projectId: project.id });
    await mkV1DatasetSample(dataset.id, 0);
    await mkV1Evaluation(project.id, userA.id, { rubricId: rootRubric.id, datasetId: dataset.id });

    const ctx1 = createImportCtx({ mode: 'apply', ownerMap });
    const owners1 = await resolveOwners(ctx1);
    const ids1 = await importArtifacts(ctx1, owners1);

    const ctx2 = createImportCtx({ mode: 'apply', ownerMap });
    const owners2 = await resolveOwners(ctx2);
    const ids2 = await importArtifacts(ctx2, owners2);

    expect(ids2.rubric.get(rootRubric.id)).toBe(ids1.rubric.get(rootRubric.id));
    expect(ids2.project.get(project.id)).toBe(ids1.project.get(project.id));
    expect(ids2.dataset.get(dataset.id)).toBe(ids1.dataset.get(dataset.id));
    expect(ids2.evaluation.size).toBe(ids1.evaluation.size);

    expect(await db.rubric.count()).toBe(1);
    expect(await db.rubricCriterion.count()).toBe(1);
    expect(await db.project.count()).toBe(1);
    expect(await db.dataset.count()).toBe(1);
    expect(await db.datasetSample.count()).toBe(1);
    expect(await db.evaluation.count()).toBe(1);

    expect(ctx2.report.counts().Rubric).toMatchObject({ created: 0, skipped: 1 });
    expect(ctx2.report.counts().Project).toMatchObject({ created: 0, skipped: 1 });
    expect(ctx2.report.counts().Dataset).toMatchObject({ created: 0, skipped: 1 });
    expect(ctx2.report.counts().Evaluation).toMatchObject({ created: 0, skipped: 1 });
  });

  it('report mode tallies counts but writes nothing to v2', async () => {
    const userA = await mkV1User();
    const ownerMap: OwnerMap = {
      [userA.id]: { email: 'report@v2.example', oidcIssuer: 'https://idp.test.local', oidcSubject: 'sub-report' },
    };
    const project = await mkV1Project(userA.id);
    const rubric = await mkV1Rubric(userA.id);
    await mkV1RubricCriterion(rubric.id);
    const dataset = await mkV1Dataset(userA.id);
    await mkV1DatasetSample(dataset.id, 0);
    await mkV1Evaluation(project.id, userA.id);

    const ctx = createImportCtx({ mode: 'report', ownerMap });
    const owners = await resolveOwners(ctx);
    const ids = await importArtifacts(ctx, owners);

    // Placeholder ids are still returned, so downstream phases (runs.ts) can
    // dry-run against them coherently even though nothing is real yet.
    expect(ids.project.get(project.id)).toBeTruthy();
    expect(ids.rubric.get(rubric.id)).toBeTruthy();
    expect(ids.dataset.get(dataset.id)).toBeTruthy();

    expect(await db.project.count()).toBe(0);
    expect(await db.rubric.count()).toBe(0);
    expect(await db.rubricCriterion.count()).toBe(0);
    expect(await db.dataset.count()).toBe(0);
    expect(await db.datasetSample.count()).toBe(0);
    expect(await db.evaluation.count()).toBe(0);

    expect(ctx.report.counts().Project).toMatchObject({ created: 1, skipped: 0 });
    expect(ctx.report.counts().Rubric).toMatchObject({ created: 1, skipped: 0 });
    expect(ctx.report.counts().Evaluation).toMatchObject({ created: 1, skipped: 0 });
  });

  it('an evaluation whose author is dropped but whose project survives is attributed to archive (not dropped)', async () => {
    const userA = await mkV1User(); // mapped, owns the project
    const userB = await mkV1User(); // dropped, but authors an evaluation in userA's project
    const ownerMap: OwnerMap = {
      [userA.id]: { email: 'owner@v2.example', oidcIssuer: 'https://idp.test.local', oidcSubject: 'sub-owner' },
    };
    const ctx = createImportCtx({ mode: 'apply', ownerMap });
    const owners = await resolveOwners(ctx);

    const project = await mkV1Project(userA.id);
    const evaluation = await mkV1Evaluation(project.id, userB.id);

    const ids = await importArtifacts(ctx, owners);
    expect(ids.evaluation.has(evaluation.id)).toBe(true);

    const archiveUser = await db.user.findFirst({ where: { email: ARCHIVE_USER_EMAIL } });
    const v2Evaluation = await db.evaluation.findUnique({ where: { id: ids.evaluation.get(evaluation.id)! } });
    expect(v2Evaluation!.userId).toBe(archiveUser!.id);
  });

  it('an isDefault project is always visibility public, regardless of ownership path (kept owner or archive-dispositioned owner)', async () => {
    const userKept = await mkV1User(); // stays mapped to a live v2 user
    const userArchived = await mkV1User(); // ownerMap disposition is literally 'archive'
    const ownerMap: OwnerMap = {
      [userKept.id]: { email: 'kept@v2.example', oidcIssuer: 'https://idp.test.local', oidcSubject: 'sub-kept' },
      [userArchived.id]: 'archive',
    };
    const ctx = createImportCtx({ mode: 'apply', ownerMap });
    const owners = await resolveOwners(ctx);

    const keptDefaultProject = await mkV1Project(userKept.id, { name: 'Leaderboard (kept)', isDefault: true });
    const archivedDefaultProject = await mkV1Project(userArchived.id, {
      name: 'Leaderboard (archived)',
      isDefault: true,
    });

    const ids = await importArtifacts(ctx, owners);

    const archiveUser = await db.user.findFirst({ where: { email: ARCHIVE_USER_EMAIL } });

    // isDefault + KEPT owner: public, and still attributed to the live mapped user (not archive).
    const v2KeptDefault = await db.project.findUnique({ where: { id: ids.project.get(keptDefaultProject.id)! } });
    expect(v2KeptDefault).toMatchObject({
      isDefault: true,
      visibility: 'public',
      userId: owners.get(userKept.id),
    });
    expect(v2KeptDefault!.userId).not.toBe(archiveUser!.id);

    // isDefault + 'archive'-dispositioned owner: public, and archive-owned.
    const v2ArchivedDefault = await db.project.findUnique({
      where: { id: ids.project.get(archivedDefaultProject.id)! },
    });
    expect(v2ArchivedDefault).toMatchObject({
      isDefault: true,
      visibility: 'public',
      userId: archiveUser!.id,
    });
  });

  it('a public dataset with a dropped owner is attributed to archive; a private one with a dropped owner is dropped', async () => {
    const userB = await mkV1User(); // dropped, no ownerMap entry at all
    const ctx = createImportCtx({ mode: 'apply', ownerMap: {} });
    const owners = await resolveOwners(ctx);

    const publicDataset = await mkV1Dataset(userB.id, { visibility: 'public' });
    const privateDataset = await mkV1Dataset(userB.id, { visibility: 'private' });

    const ids = await importArtifacts(ctx, owners);

    const archiveUser = await db.user.findFirst({ where: { email: ARCHIVE_USER_EMAIL } });
    expect(ids.dataset.get(publicDataset.id)).toBeTruthy();
    const v2PublicDataset = await db.dataset.findUnique({ where: { id: ids.dataset.get(publicDataset.id)! } });
    expect(v2PublicDataset!.userId).toBe(archiveUser!.id);

    expect(ids.dataset.has(privateDataset.id)).toBe(false);
    expect(ctx.report.counts().Dataset).toMatchObject({ created: 1, dropped: 1 });
  });
});
