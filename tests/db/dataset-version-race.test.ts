import { describe, it, expect, beforeEach } from 'vitest';
import { db, truncateAll, mkUser } from './helpers';
import {
  createDatasetVersion,
  CreateDatasetVersionInput,
} from '@/lib/dataset-versions';

// ─── Task 15: dataset version numbering under transaction + retry ─────────
//
// Mirrors tests/db/rubric-version-race.test.ts exactly (1a Task 13's fix for
// the identical race on Rubric) — `POST /api/datasets/[id]/versions` used to
// read MAX(version) for a family and `create` the next version as two
// separate, unsynchronized calls. The `@@unique([parentId, version])`
// constraint (Task 15, prisma/migrations/20260730120000_v2b_visibility_cleanup)
// turns the race between two concurrent requests into a P2002 crash instead
// of a silent duplicate. `createDatasetVersion` (src/lib/dataset-versions.ts)
// fixes this the same way createRubricVersion does: the max-read + create
// (+ nested sample create) run inside one `$transaction`, retrying (bounded
// to 3 attempts) on a version-constraint P2002.
//
// Tested directly against the extracted lib function (bypassing the route's
// `requireAuth`), per the Task 11 precedent (tests/db/human-judgment-score.test.ts)
// rubric-version-race.test.ts already follows.

async function mkDataset(userId: string, overrides: Partial<{ version: number }> = {}) {
  return db.dataset.create({
    data: { name: 'fixture-dataset', userId, version: overrides.version ?? 1 },
  });
}

const baseInput = (
  rootDatasetId: string,
  userId: string,
  overrides: Partial<Omit<CreateDatasetVersionInput, 'rootDatasetId' | 'userId'>> = {}
): CreateDatasetVersionInput => ({
  rootDatasetId,
  userId,
  name: 'fixture-dataset',
  description: null,
  source: 'local',
  visibility: 'private',
  inputType: 'query-response',
  sourceUrl: null,
  huggingFaceId: null,
  remoteMetadata: null,
  format: null,
  localData: null,
  splits: null,
  features: null,
  tags: null,
  projectId: null,
  samples: [],
  ...overrides,
});

describe('createDatasetVersion: transactional version numbering + retry', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('sequential calls: two versions land on N+1 and N+2 (fixture root = version 1)', async () => {
    const user = await mkUser();
    const root = await mkDataset(user.id, { version: 1 });

    const v2 = await createDatasetVersion(db, baseInput(root.id, user.id));
    expect(v2.version).toBe(2);

    const v3 = await createDatasetVersion(db, baseInput(root.id, user.id));
    expect(v3.version).toBe(3);

    const family = await db.dataset.findMany({
      where: { OR: [{ id: root.id }, { parentId: root.id }] },
      orderBy: { version: 'asc' },
    });
    expect(family.map((d) => d.version)).toEqual([1, 2, 3]);
  });

  it(
    'concurrent calls (Promise.all): both land — versions 2 and 3, never duplicate ' +
      '(looped 20x to force the race deterministically under the transaction+retry fix)',
    async () => {
      for (let i = 0; i < 20; i++) {
        await truncateAll();
        const user = await mkUser();
        const root = await mkDataset(user.id, { version: 1 });

        const [resultA, resultB] = await Promise.all([
          createDatasetVersion(db, baseInput(root.id, user.id, { name: 'concurrent-a' })),
          createDatasetVersion(db, baseInput(root.id, user.id, { name: 'concurrent-b' })),
        ]);

        // Both calls must succeed and land on distinct versions — never the
        // same number (that would be the pre-fix duplicate-version bug) and
        // never a P2002 bubbling up as a rejection (that would be the
        // Task-15-constraint-surfaces-the-race regression this fixes).
        const versions = [resultA.version, resultB.version].sort((a, b) => a - b);
        expect(versions).toEqual([2, 3]);

        const family = await db.dataset.findMany({
          where: { OR: [{ id: root.id }, { parentId: root.id }] },
          orderBy: { version: 'asc' },
        });
        expect(family.map((d) => d.version)).toEqual([1, 2, 3]);

        // No duplicate (parentId, version) pair snuck through.
        const versionSet = new Set(family.map((d) => d.version));
        expect(versionSet.size).toBe(family.length);
      }
    },
    30_000
  );

  it('samples are attached atomically — each created version has exactly its own sample rows', async () => {
    const user = await mkUser();
    const root = await mkDataset(user.id, { version: 1 });

    const [resultA, resultB] = await Promise.all([
      createDatasetVersion(
        db,
        baseInput(root.id, user.id, {
          name: 'with-two-samples',
          samples: [
            { input: 'a1', expected: 'exp-a1', metadata: null },
            { input: 'a2', expected: null, metadata: JSON.stringify({ k: 'v' }) },
          ],
        })
      ),
      createDatasetVersion(
        db,
        baseInput(root.id, user.id, {
          name: 'with-one-sample',
          samples: [{ input: 'b1', expected: null, metadata: null }],
        })
      ),
    ]);

    // Returned rows already include samples — assert on those directly.
    expect(resultA.samples).toHaveLength(2);
    expect(resultA.samples.map((s) => s.input).sort()).toEqual(['a1', 'a2']);
    expect(resultB.samples).toHaveLength(1);
    expect(resultB.samples.map((s) => s.input)).toEqual(['b1']);

    // Re-fetch from the DB (not the in-memory return value) to confirm the
    // sample rows actually persisted — and only against the correct parent
    // dataset, no bleed between the two concurrent creates.
    const [dbA, dbB] = await Promise.all([
      db.dataset.findUniqueOrThrow({
        where: { id: resultA.id },
        include: { samples: true },
      }),
      db.dataset.findUniqueOrThrow({
        where: { id: resultB.id },
        include: { samples: true },
      }),
    ]);
    expect(dbA.samples).toHaveLength(2);
    expect(dbB.samples).toHaveLength(1);

    const totalSamplesForFamily = await db.datasetSample.count({
      where: { dataset: { OR: [{ id: root.id }, { parentId: root.id }] } },
    });
    expect(totalSamplesForFamily).toBe(3);
  });

  it(
    'slugs stay unique across concurrent versions even though both start from the same base ' +
      'name (looped 20x — both requests can race to read `existingSlugs` before either commits ' +
      'and derive the identical slug, a P2002 on [userId, slug] rather than [parentId, version]; ' +
      'the retry loop must treat that as retryable too, not just the version constraint)',
    async () => {
      for (let i = 0; i < 20; i++) {
        await truncateAll();
        const user = await mkUser();
        const root = await mkDataset(user.id, { version: 1 });

        const [resultA, resultB] = await Promise.all([
          createDatasetVersion(db, baseInput(root.id, user.id)),
          createDatasetVersion(db, baseInput(root.id, user.id)),
        ]);

        expect(resultA.slug).not.toBeNull();
        expect(resultB.slug).not.toBeNull();
        expect(resultA.slug).not.toBe(resultB.slug);
      }
    },
    30_000
  );
});
