import { describe, it, expect, beforeEach } from 'vitest';
import { db, truncateAll, mkUser } from './helpers';

// DB-backed (v2f, A1 Task 1): exercises the ONE hand edit in
// prisma/migrations/20260814120000_v2f_tombstone_overlay/migration.sql — the
// `Tombstone_exactly_one_entity` CHECK.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// Every other statement in that migration is generated, and drift tooling
// would notice if it went missing. The CHECK is the one statement nothing
// notices: Prisma's schema engine has no internal representation of a CHECK,
// so `migrate diff` never proposes it, `db pull` never reads it back, and a
// drift gate passes clean whether the constraint is present or absent (see
// CONTRIBUTING.md's "Known migrate-diff pseudo-drift" table, fifth row). The
// migration's own header warns that a future migration rebuilding this table
// must hand-add the constraint again because nothing in the toolchain will
// warn. THIS FILE is what warns. `npm run test:db` replays the entire
// migration chain against a real Postgres before running, so a constraint
// that is dropped, or never re-added by a later table rebuild, fails here.
//
// ── WHY THE INSERTS ARE RAW ─────────────────────────────────────────────────
// The invariant is unrepresentable in the typed client: `datasetSample` and
// `dataset` are separate optional relation inputs, so no typed call can build
// a row with both FKs set or neither. Raw SQL is the only way to attempt a
// violating row at all. Same reasoning, and same tool, as
// tests/db/idempotency-tighten.test.ts, which reruns its own migration's
// statement raw rather than through the client.

async function mkDatasetWithSample() {
  const owner = await mkUser();
  const dataset = await db.dataset.create({
    data: {
      name: 'tombstone-check-fixture',
      userId: owner.id,
      source: 'local',
      visibility: 'public',
      samples: { create: [{ index: 0, input: 'question-0', expected: 'A>B' }] },
    },
    include: { samples: true },
  });
  return { owner, dataset, sample: dataset.samples[0] };
}

/** The raw INSERT the typed client cannot express. */
function insertTombstone(
  id: string,
  datasetSampleId: string | null,
  datasetId: string | null
): Promise<number> {
  return db.$executeRawUnsafe(
    `INSERT INTO "Tombstone" ("id","datasetSampleId","datasetId","isTombstone","createdAt","updatedAt")
     VALUES ($1, $2, $3, true, now(), now())`,
    id,
    datasetSampleId,
    datasetId
  );
}

describe('v2f Tombstone_exactly_one_entity (DB) — the hand-edited CHECK', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('rejects a BOTH-NULL row — a tombstone that hides nothing', async () => {
    // Nothing but the CHECK stands in the way of this row. Both FK columns
    // are `@unique`, and Postgres permits unlimited NULLs in a unique index,
    // so the indexes alone accept it — and accept a second, and a third.
    await expect(insertTombstone('probe-both-null', null, null)).rejects.toThrow(
      /Tombstone_exactly_one_entity/
    );

    expect(await db.tombstone.count()).toBe(0);
  });

  it('rejects a BOTH-SET row whose FKs are both REAL — so only the CHECK can be rejecting it', async () => {
    const { dataset, sample } = await mkDatasetWithSample();

    // The FK values are real ON PURPOSE, and this is the whole subtlety of
    // the test. With bogus ids ('no-such-sample') the row is refused by
    // `Tombstone_datasetSampleId_fkey` before the CHECK is ever the reason —
    // so that version of this test passes identically whether the CHECK is
    // present or dropped, and would report success on a database missing the
    // very constraint it claims to cover. Verified by dropping the
    // constraint: the bogus-FK insert then fails on the FK, while THIS
    // insert succeeds. Real parents are what make the assertion discriminate.
    await expect(insertTombstone('probe-both-set', sample.id, dataset.id)).rejects.toThrow(
      /Tombstone_exactly_one_entity/
    );

    expect(await db.tombstone.count()).toBe(0);
  });

  it('accepts EXACTLY ONE — a sample tombstone and a dataset tombstone both insert', async () => {
    // The positive control. Without it the two rejections above are also
    // satisfied by a constraint that refuses everything, which would break
    // every delete path A1 goes on to build.
    const { dataset, sample } = await mkDatasetWithSample();

    await expect(insertTombstone('sample-tombstone', sample.id, null)).resolves.toBe(1);
    await expect(insertTombstone('dataset-tombstone', null, dataset.id)).resolves.toBe(1);

    const rows = await db.tombstone.findMany({ orderBy: { id: 'asc' } });
    expect(rows.map((r) => [r.datasetSampleId, r.datasetId])).toEqual([
      [null, dataset.id],
      [sample.id, null],
    ]);
    // The column the overlay reads through, defaulted by the table itself.
    expect(rows.every((r) => r.isTombstone)).toBe(true);
  });
});
