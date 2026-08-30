import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';

import { seedAll } from '../../prisma/seed-core';
import { seedPromptTemplates } from '../../prisma/seed-prompt-templates';

import { db, truncateAll } from './helpers';

/**
 * The catalog the seeder ships is the ONLY path a fresh deployment has to a
 * judgment: no ModelEndpoint is seeded (BYOK), so a user's first act is to
 * attach a key to one of these three rows and run it. Two defects shipped in
 * that path and neither was visible from the seeder's own output.
 *
 * These are guards on the two, plus the third that made them invisible:
 *
 *   1. Every seeded `baseModel` was a model id that does not exist. It is
 *      what `requireBaseModel` (src/lib/llm/registry.ts:550) hands the
 *      Anthropic API verbatim, so all three 404'd at call time and the
 *      default catalog could not produce a judgment at all.
 *   2. `update: {}` on the JudgeModel upsert meant a re-seed could not repair
 *      a row it had already created — the fix for (1) would have shipped in
 *      the image and changed nothing in the database it ran against.
 *   3. The prompt-template log said "Created" unconditionally, so its output
 *      could not tell an insert from a no-op. That is not cosmetic: it is
 *      what a committed handoff doc cited as evidence rows had been created.
 *
 * Expected model ids are written out LITERALLY here rather than imported from
 * `CATALOG_JUDGES`. Importing them would make this test agree with the
 * seeder by construction — including when the seeder is wrong, which is the
 * state it shipped in. These three strings are from the authoritative
 * Anthropic model reference; `claude-sonnet-4-6` genuinely has no dated
 * snapshot, and its bare id is complete.
 */
const EXPECTED_BASE_MODELS: Record<string, string> = {
  'claude-sonnet-4-5': 'claude-sonnet-4-5-20250929',
  'claude-sonnet-4-6': 'claude-sonnet-4-6',
  'claude-opus-4-5': 'claude-opus-4-5-20251101',
};

describe('prisma seed — catalog model ids and repair', () => {
  beforeAll(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    await truncateAll();
  });

  it('seeds catalog judges with model ids that exist', async () => {
    await seedAll(db);

    const judges = await db.judgeModel.findMany({ select: { slug: true, baseModel: true } });
    expect(Object.fromEntries(judges.map((j) => [j.slug, j.baseModel]))).toEqual(
      EXPECTED_BASE_MODELS
    );

    // The specific wrong ids that shipped, named so a partial revert is
    // caught rather than merely a total one. `-20250514` is a Sonnet 4
    // snapshot date, which is how the first of them was born.
    const shipped = judges.map((j) => j.baseModel);
    expect(shipped).not.toContain('claude-sonnet-4-5-20250514');
    expect(shipped).not.toContain('claude-opus-4-5-20250630');
    expect(shipped).not.toContain('claude-sonnet-4-6-20250627');
  });

  it('is idempotent — a second run mints no second catalog row', async () => {
    await seedAll(db);
    await seedAll(db);

    await expect(db.judgeModel.count()).resolves.toBe(3);
    await expect(db.judgeModelVersion.count()).resolves.toBe(3);
    await expect(db.promptTemplate.count()).resolves.toBe(2);

    const judges = await db.judgeModel.findMany({ select: { slug: true, baseModel: true } });
    expect(Object.fromEntries(judges.map((j) => [j.slug, j.baseModel]))).toEqual(
      EXPECTED_BASE_MODELS
    );
  });

  it('REPAIRS a stale baseModel on re-seed — the fix has to reach rows that already exist', async () => {
    await seedAll(db);

    // Put the database back into the exact state production is in: the three
    // ids the first seeder wrote. A re-seed is the ONLY repair path — there
    // is no write path in the app that mutates `JudgeModel.baseModel` (see
    // src/app/api/config/import/route.ts:421, which reports the diff and
    // refuses to apply it), so if the seeder cannot fix this, nothing can
    // short of hand-editing production SQL.
    await db.judgeModel.update({
      where: { slug: 'claude-sonnet-4-5' },
      data: { baseModel: 'claude-sonnet-4-5-20250514' },
    });
    await db.judgeModel.update({
      where: { slug: 'claude-opus-4-5' },
      data: { baseModel: 'claude-opus-4-5-20250630' },
    });
    await db.judgeModel.update({
      where: { slug: 'claude-sonnet-4-6' },
      data: { baseModel: 'claude-sonnet-4-6-20250627' },
    });

    await seedAll(db);

    const judges = await db.judgeModel.findMany({ select: { slug: true, baseModel: true } });
    expect(Object.fromEntries(judges.map((j) => [j.slug, j.baseModel]))).toEqual(
      EXPECTED_BASE_MODELS
    );

    // Repaired in place, not replaced. `JudgeModelVersion` FKs the model with
    // `onDelete: Restrict` and every `ModelJudgment` pins a version, so a
    // repair that minted a new JudgeModel row would strand all of it.
    await expect(db.judgeModel.count()).resolves.toBe(3);
    await expect(db.judgeModelVersion.count()).resolves.toBe(3);
  });

  it('leaves the immutable JudgeModelVersion alone on re-seed', async () => {
    await seedAll(db);

    // A version is the provenance pin every `ModelJudgment` FKs, and the
    // program invariant is that no update path exists for one. Widening the
    // JudgeModel upsert must not have widened this one by sympathy: a
    // hand-set trustState survives, because the seeder does not write here.
    await db.judgeModelVersion.updateMany({ data: { trustState: 'untrusted' } });

    await seedAll(db);

    const versions = await db.judgeModelVersion.findMany({ select: { trustState: true } });
    expect(versions).toHaveLength(3);
    expect(versions.every((v) => v.trustState === 'untrusted')).toBe(true);
  });
});

/**
 * The seeder's output as a claim about what it did.
 *
 * `PromptTemplate` has NO `updatedAt` column (schema.prisma:321-331), so the
 * usual `createdAt === updatedAt` inference is not available here — the
 * insert has to be observed at the moment it happens or not at all.
 */
describe('prisma seed — prompt-template log distinguishes an insert from a no-op', () => {
  let logged: string[];

  beforeEach(async () => {
    await truncateAll();
    logged = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('says Created on the run that inserts, and Exists on every run after', async () => {
    await seedPromptTemplates(db);

    expect(logged).toContain('  ✓ Created prompt template: v1-legacy v0');
    expect(logged).toContain('  ✓ Created prompt template: v1-pairwise v0');

    logged = [];
    await seedPromptTemplates(db);

    expect(logged).toContain('  ✓ Exists prompt template: v1-legacy v0');
    expect(logged).toContain('  ✓ Exists prompt template: v1-pairwise v0');
    // The whole point: the second run must not be able to claim an insert.
    expect(logged.filter((line) => line.includes('Created'))).toEqual([]);
  });

  it('reports per row, not per run — a half-seeded database gets one of each', async () => {
    // The state a database lands in if `v1-pairwise` was added after it was
    // seeded, which is exactly what happened when A0 introduced that row. A
    // per-run flag would call this whole run "Exists" and hide the insert.
    await db.promptTemplate.create({
      data: { name: 'v1-legacy', protocol: 'pointwise', version: 0, body: 'placeholder' },
    });

    await seedPromptTemplates(db);

    expect(logged).toContain('  ✓ Exists prompt template: v1-legacy v0');
    expect(logged).toContain('  ✓ Created prompt template: v1-pairwise v0');
  });

  it('still returns the v1-legacy row on the no-op run — callers destructure .id off it', async () => {
    // tests/integration/worker-claims.test.ts:276 and :584 pin a pointwise
    // judgment with this return value, and they call the seeder against a
    // database that may already hold the row.
    const first = await seedPromptTemplates(db);
    const second = await seedPromptTemplates(db);

    expect(second.id).toBe(first.id);
    expect(second.name).toBe('v1-legacy');
    expect(second.version).toBe(0);
  });
});
