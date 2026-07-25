import { describe, it, expect, beforeEach } from 'vitest';
import { db, truncateAll, mkUser, mkRubric } from './helpers';
import {
  createRubricVersion,
  CreateRubricVersionCriterionInput,
} from '@/lib/rubric-versions';

// ─── Task 13: rubric version numbering under transaction + retry ──────────
//
// `POST /api/rubrics/[id]/versions` used to read MAX(version) for a family
// and `create` the next version as two separate, unsynchronized calls. The
// `@@unique([parentId, version])` constraint (Task 2) turns the race between
// two concurrent requests into a P2002 crash instead of a silent duplicate.
// `createRubricVersion` (src/lib/rubric-versions.ts) fixes this by wrapping
// the max-read + create (+ nested criteria create) in one `$transaction`,
// retrying (bounded to 3 attempts) on a version-constraint P2002.
//
// Tested directly against the extracted lib function (bypassing the route's
// `requireAuth`), per the Task 11 precedent (tests/db/human-judgment-score.test.ts).

const oneCriterion = (name: string): CreateRubricVersionCriterionInput[] => [
  { name, description: `${name} description`, maxScore: 10, weight: 1 },
];

describe('createRubricVersion: transactional version numbering + retry', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('sequential calls: two versions land on N+1 and N+2 (fixture root = version 1)', async () => {
    const user = await mkUser();
    const root = await mkRubric(user.id, { version: 1 });

    const v2 = await createRubricVersion(db, {
      rootRubricId: root.id,
      userId: user.id,
      name: 'v2',
      criteria: oneCriterion('c1'),
    });
    expect(v2.version).toBe(2);

    const v3 = await createRubricVersion(db, {
      rootRubricId: root.id,
      userId: user.id,
      name: 'v3',
      criteria: oneCriterion('c1'),
    });
    expect(v3.version).toBe(3);

    const family = await db.rubric.findMany({
      where: { OR: [{ id: root.id }, { parentId: root.id }] },
      orderBy: { version: 'asc' },
    });
    expect(family.map((r) => r.version)).toEqual([1, 2, 3]);
  });

  it(
    'concurrent calls (Promise.all): both land — versions 2 and 3, never duplicate ' +
      '(looped 20x to force the race deterministically under the transaction+retry fix)',
    async () => {
      for (let i = 0; i < 20; i++) {
        await truncateAll();
        const user = await mkUser();
        const root = await mkRubric(user.id, { version: 1 });

        const [resultA, resultB] = await Promise.all([
          createRubricVersion(db, {
            rootRubricId: root.id,
            userId: user.id,
            name: 'concurrent-a',
            criteria: oneCriterion('a-crit'),
          }),
          createRubricVersion(db, {
            rootRubricId: root.id,
            userId: user.id,
            name: 'concurrent-b',
            criteria: oneCriterion('b-crit'),
          }),
        ]);

        // Both calls must succeed and land on distinct versions — never the
        // same number (that would be the pre-fix duplicate-version bug) and
        // never a P2002 bubbling up as a rejection (that would be the
        // Task-2-constraint-surfaces-the-race regression this fixes).
        const versions = [resultA.version, resultB.version].sort((a, b) => a - b);
        expect(versions).toEqual([2, 3]);

        const family = await db.rubric.findMany({
          where: { OR: [{ id: root.id }, { parentId: root.id }] },
          orderBy: { version: 'asc' },
        });
        expect(family.map((r) => r.version)).toEqual([1, 2, 3]);

        // No duplicate (parentId, version) pair snuck through.
        const versionSet = new Set(family.map((r) => r.version));
        expect(versionSet.size).toBe(family.length);
      }
    },
    30_000
  );

  it('criteria are attached atomically — each created version has exactly its own criteria rows', async () => {
    const user = await mkUser();
    const root = await mkRubric(user.id, { version: 1 });

    const [resultA, resultB] = await Promise.all([
      createRubricVersion(db, {
        rootRubricId: root.id,
        userId: user.id,
        name: 'with-two-criteria',
        criteria: [
          { name: 'accuracy', description: 'accuracy desc', maxScore: 10, weight: 2 },
          { name: 'clarity', description: 'clarity desc', maxScore: 5, weight: 1 },
        ],
      }),
      createRubricVersion(db, {
        rootRubricId: root.id,
        userId: user.id,
        name: 'with-one-criterion',
        criteria: [{ name: 'safety', description: 'safety desc', maxScore: 10, weight: 1 }],
      }),
    ]);

    // Returned rows already include criteria — assert on those directly.
    expect(resultA.criteria).toHaveLength(2);
    expect(resultA.criteria.map((c) => c.name).sort()).toEqual(['accuracy', 'clarity']);
    expect(resultB.criteria).toHaveLength(1);
    expect(resultB.criteria.map((c) => c.name)).toEqual(['safety']);

    // Re-fetch from the DB (not the in-memory return value) to confirm the
    // criteria rows actually persisted — and only against the correct
    // parent rubric, no bleed between the two concurrent creates.
    const [dbA, dbB] = await Promise.all([
      db.rubric.findUniqueOrThrow({
        where: { id: resultA.id },
        include: { criteria: true },
      }),
      db.rubric.findUniqueOrThrow({
        where: { id: resultB.id },
        include: { criteria: true },
      }),
    ]);
    expect(dbA.criteria).toHaveLength(2);
    expect(dbB.criteria).toHaveLength(1);

    const totalCriteriaForFamily = await db.rubricCriterion.count({
      where: { rubric: { OR: [{ id: root.id }, { parentId: root.id }] } },
    });
    expect(totalCriteriaForFamily).toBe(3);
  });
});
