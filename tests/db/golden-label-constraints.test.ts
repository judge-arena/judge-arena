import { beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll, mkUser } from './helpers';

// DB-backed (v2h, A1 Task 1): exercises the THREE hand edits in
// prisma/migrations/20260818120000_v2h_human_verification/migration.sql.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// Same argument as tests/db/tombstone-check-constraint.test.ts one migration
// earlier. Every other statement in v2h is generated, and drift tooling would
// notice if it went missing. These three are the statements nothing notices:
// Prisma's schema engine has no internal representation of a CHECK or of an
// index WHERE predicate, so `migrate diff` never proposes them, `db pull`
// never reads them back, and a drift gate passes clean whether they are
// present or absent. That was verified while authoring v2h rather than
// assumed — the generated diff for this schema change emitted no statement
// for any of the three, including no DROP for the v2e index hand edit 2
// replaces. See CONTRIBUTING.md's "Known migrate-diff pseudo-drift" table,
// rows six through eight.
//
// `npm run test:db` replays the entire migration chain against a real
// Postgres before running, so a constraint that is dropped — or never re-added
// by a later migration that rebuilds one of these tables — fails here.
//
// ── WHY THE INSERTS ARE RAW ─────────────────────────────────────────────────
// For the CHECK, because the typed client cannot CONSTRUCT a violating row:
// `overallScore` and `preference` are separate optional inputs, so neither
// "both set" nor "neither set" is expressible as an intentional create the
// way a valid one is — a typed `create({ data: {} })` fails on the required
// FKs first, and a probe that dies on a bogus FK proves only that SOME
// constraint fired, not that this one did. Raw SQL lets the test name the
// constraint it caught.
//
// The two PARTIAL UNIQUE indexes are different: the typed client CAN violate
// those (the predicate is invisible to it, so a second create simply
// collides), and those tests use it deliberately — a typed create is the
// shape production actually uses, which is the thing worth pinning.

let counter = 0;

/** A golden set with one item, built from the minimum real rows the FKs need. */
async function mkItem(userId: string) {
  counter += 1;
  const dataset = await db.dataset.create({
    data: {
      name: `v2h-fixture-${counter}`,
      slug: `v2h-fixture-${counter}`,
      userId,
      visibility: 'private',
      inputType: 'query-response',
    },
  });
  const sample = await db.datasetSample.create({
    data: { datasetId: dataset.id, index: 0, input: 'q' },
  });
  const set = await db.goldenSet.create({
    data: {
      name: `v2h-fixture-set-${counter}`,
      // Slug is not optional in practice: GoldenSet_ownerId_slug_key is
      // NULLS NOT DISTINCT, so two slug-null sets would collide.
      slug: `v2h-fixture-set-${counter}`,
      visibility: 'private',
      protocol: 'pointwise',
      version: 1,
      datasetId: dataset.id,
      ownerId: userId,
    },
  });
  return db.goldenItem.create({
    data: {
      goldenSetId: set.id,
      index: 0,
      inputText: 'q',
      protocol: 'pointwise',
      sourceDatasetSampleId: sample.id,
    },
  });
}

describe('v2h hand-edited constraints', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('refuses a label with NEITHER a score nor a preference', async () => {
    const user = await mkUser();
    const item = await mkItem(user.id);
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "GoldenLabel" ("id","goldenItemId","annotatorId","round","createdAt","updatedAt")
         VALUES ('lbl_none', $1, $2, 1, now(), now())`,
        item.id,
        user.id
      )
    ).rejects.toThrow(/GoldenLabel_score_xor_preference/);
  });

  it('refuses a label with BOTH', async () => {
    const user = await mkUser();
    const item = await mkItem(user.id);
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "GoldenLabel" ("id","goldenItemId","annotatorId","round","overallScore","preference","createdAt","updatedAt")
         VALUES ('lbl_both', $1, $2, 1, 4, 'A>B', now(), now())`,
        item.id,
        user.id
      )
    ).rejects.toThrow(/GoldenLabel_score_xor_preference/);
  });

  it('permits TWO ROUNDS by one annotator on one item — the whole point of the widened index', async () => {
    const user = await mkUser();
    const item = await mkItem(user.id);
    for (const round of [1, 2]) {
      await db.goldenLabel.create({
        data: { goldenItemId: item.id, annotatorId: user.id, round, overallScore: 4 },
      });
    }
    expect(await db.goldenLabel.count({ where: { goldenItemId: item.id } })).toBe(2);
  });

  it('still refuses a SECOND live label in the SAME round', async () => {
    const user = await mkUser();
    const item = await mkItem(user.id);
    await db.goldenLabel.create({
      data: { goldenItemId: item.id, annotatorId: user.id, round: 1, overallScore: 4 },
    });
    await expect(
      db.goldenLabel.create({
        data: { goldenItemId: item.id, annotatorId: user.id, round: 1, overallScore: 5 },
      })
    ).rejects.toThrow();
  });

  it('permits a re-read after the first is tombstoned — the partial predicate is load-bearing', async () => {
    const user = await mkUser();
    const item = await mkItem(user.id);
    const first = await db.goldenLabel.create({
      data: { goldenItemId: item.id, annotatorId: user.id, round: 1, overallScore: 4 },
    });
    await db.goldenLabel.update({
      where: { id: first.id },
      data: { tombstonedAt: new Date(), tombstonedReason: 'item-content-edit' },
    });
    await expect(
      db.goldenLabel.create({
        data: { goldenItemId: item.id, annotatorId: user.id, round: 1, overallScore: 5 },
      })
    ).resolves.toBeTruthy();
  });

  it('refuses a second ACTIVE assignment for the same (item, annotator, round), and permits one after revocation', async () => {
    const user = await mkUser();
    const item = await mkItem(user.id);
    const set = await db.goldenItem.findUniqueOrThrow({
      where: { id: item.id },
      select: { goldenSetId: true },
    });
    const base = {
      goldenSetId: set.goldenSetId,
      goldenItemId: item.id,
      annotatorId: user.id,
      round: 1,
    };
    const a = await db.goldenAssignment.create({ data: base });
    await expect(db.goldenAssignment.create({ data: base })).rejects.toThrow();
    await db.goldenAssignment.update({
      where: { id: a.id },
      data: { revokedAt: new Date(), revokedReason: 'reassigned' },
    });
    await expect(db.goldenAssignment.create({ data: base })).resolves.toBeTruthy();
  });
});
