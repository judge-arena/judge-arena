import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { getServerSession } from 'next-auth';
import { db, truncateAll, mkUser } from './helpers';
import { forkGoldenSet } from '@/lib/golden-set-versions';
import { POST as importConfig } from '@/app/api/config/import/route';
import { GET as exportConfig } from '@/app/api/config/export/route';

// ─── Why every assertion here is on ROWS ────────────────────────────────────
// `configDocumentSchema` is a plain `z.object` with no `.strict()`, so an
// unknown `goldenSets` key is SILENTLY STRIPPED. An export-only
// implementation therefore returns 200 with a clean `summary` while losing
// every golden set. `res.status` and `body.summary` cannot see that; a
// `db.goldenSet.findFirstOrThrow` can.

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(),
}));
vi.mock('next/headers', () => ({
  headers: vi.fn(async () => new Headers()),
}));

// Same fake, same reason, as tests/db/access-matrix.test.ts:78-98 — read the
// long comment there. Short version: requireAuth()'s rate-limit chokepoint
// hits a REAL Redis sliding window keyed by client IP, always '127.0.0.1'
// here, and `fileParallelism: false` makes that 120/min budget shared by
// every file in one `npm run test:db` run. Measured before adding this: the
// suite peaked at 89 of 120 without this file and pinned at the 120 cap with
// it, failing whichever tests happened to be running at the time — in other
// files, on some runs only. Every request this file makes is an export or an
// import, so it is a heavy consumer for its size.
vi.mock('@/lib/rate-limit-redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rate-limit-redis')>();
  return {
    ...actual,
    apiLimiter: { check: vi.fn(async () => ({ ok: true, remaining: 999, resetAt: Date.now() + 60_000 })) },
  };
});

function mockSessionFor(user: { id: string; email: string }) {
  (getServerSession as unknown as Mock).mockResolvedValue({
    user: { id: user.id, email: user.email },
  });
}

function importRequest(body: string, dryRun = false) {
  return new Request(`http://localhost/api/config/import?dryRun=${dryRun}`, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json' },
  });
}

function exportRequest(query = '?format=json&include=all&includeSamples=true') {
  return new Request(`http://localhost/api/config/export${query}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function exportDoc(query?: string): Promise<any> {
  const res = await exportConfig(exportRequest(query));
  expect(res.status).toBe(200);
  return res.json();
}

let datasetCounter = 0;

async function mkAnnotatedDataset(
  ownerId: string,
  opts: { slug: string; visibility?: 'private' | 'public' }
) {
  datasetCounter += 1;
  return db.dataset.create({
    data: {
      name: `fixture-dataset-${datasetCounter}`,
      slug: opts.slug,
      source: 'local',
      visibility: opts.visibility ?? 'private',
      inputType: 'query-response',
      userId: ownerId,
      sampleCount: 2,
      samples: {
        create: [
          { index: 0, input: 'who wrote hamlet', expected: 'A>B', metadata: JSON.stringify({ response_A: 'shakespeare', response_B: 'bacon' }) },
          { index: 1, input: 'what is 2 + 2', expected: 'B>A', metadata: JSON.stringify({ response_A: 'five', response_B: 'four' }) },
        ],
      },
    },
    include: { samples: { orderBy: { index: 'asc' } } },
  });
}

async function mkGoldenSet(
  ownerId: string,
  dataset: { id: string; samples: { id: string; input: string }[] },
  opts: { slug: string; name: string }
) {
  return db.goldenSet.create({
    data: {
      name: opts.name,
      slug: opts.slug,
      description: 'fixture golden set',
      visibility: 'private',
      protocol: 'pairwise',
      version: 1,
      datasetId: dataset.id,
      ownerId,
      items: {
        create: dataset.samples.map((sample, i) => ({
          sourceDatasetSampleId: sample.id,
          index: i,
          inputText: sample.input,
          protocol: 'pairwise' as const,
          expected: i === 0 ? 'A>B' : 'B>A',
          candidates: {
            create: [
              { position: 0, responseText: `A-${i}`, label: 'A' },
              { position: 1, responseText: `B-${i}`, label: 'B' },
            ],
          },
        })),
      },
    },
  });
}

let judgeCounter = 0;

/** A CalibrationRun is what freezes a set. It needs a JudgeModelVersion. */
async function mkCalibrationRun(goldenSetId: string) {
  judgeCounter += 1;
  const judgeModel = await db.judgeModel.create({
    data: {
      name: `Fixture Judge ${judgeCounter}`,
      slug: `fixture-judge-${judgeCounter}`,
      judgeClass: 'prompted_api',
      scoringMechanism: 'critique_generative',
      baseModel: 'fixture-base-model',
    },
  });
  const version = await db.judgeModelVersion.create({
    data: {
      judgeModelId: judgeModel.id,
      ordinal: 1,
      servingBackend: 'anthropic',
      protocolSupport: { pointwise: ['score'] },
    },
  });
  return db.calibrationRun.create({
    data: { judgeModelVersionId: version.id, goldenSetId },
  });
}

/** Live items of a set, in ordinal order, with their candidates. */
function liveItems(goldenSetId: string) {
  return db.goldenItem.findMany({
    where: { goldenSetId, tombstonedAt: null },
    orderBy: { index: 'asc' },
    include: { candidates: { orderBy: { position: 'asc' } } },
  });
}

describe('Config export/import — golden sets', () => {
  beforeEach(async () => {
    await truncateAll();
    (getServerSession as unknown as Mock).mockReset();
  });

  it('?include=all emits goldenSets with items and candidates always embedded, even without ?includeSamples', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const dataset = await mkAnnotatedDataset(user.id, { slug: 'ds-fixture' });
    await mkGoldenSet(user.id, dataset, { slug: 'gs-fixture', name: 'Fixture Golden Set' });

    // Guards the FIRST of the export route's two halves: the hard-coded
    // `sections` array. Without 'goldensets' in it the block never runs and
    // this section comes back empty with a 200.
    const doc = await exportDoc('?format=json&include=all');

    expect(doc.goldenSets).toHaveLength(1);
    expect(doc.goldenSets[0]).toMatchObject({
      slug: 'gs-fixture',
      name: 'Fixture Golden Set',
      description: 'fixture golden set',
      visibility: 'private',
      protocol: 'pairwise',
      datasetSlug: 'ds-fixture',
      version: 1,
    });

    // The asymmetry, pinned: dataset samples are absent without
    // ?includeSamples, golden items are present regardless.
    expect(doc.datasets[0].samples).toBeUndefined();
    expect(doc.goldenSets[0].items).toHaveLength(2);
    expect(doc.goldenSets[0].items[0].candidates).toEqual([
      { position: 0, responseText: 'A-0', label: 'A' },
      { position: 1, responseText: 'B-0', label: 'B' },
    ]);
  });

  it('an export that does NOT select the section still emits an empty goldenSets key', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const dataset = await mkAnnotatedDataset(user.id, { slug: 'ds-fixture' });
    await mkGoldenSet(user.id, dataset, { slug: 'gs-fixture', name: 'Fixture Golden Set' });

    // Guards the SECOND half: the `config: ConfigDocument` literal. The test
    // above passes with the literal unseeded (the section block assigns the
    // key on its way past), and this one passes with the `sections` array
    // unchanged — only both together cover both sites.
    const doc = await exportDoc('?format=json&include=datasets');
    expect(doc.datasets).toHaveLength(1);
    expect(doc.goldenSets).toEqual([]); // present and empty, never undefined
  });

  it('an explicit ?include=goldenSets exports the section (the include param is lowercased before comparison)', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const dataset = await mkAnnotatedDataset(user.id, { slug: 'ds-fixture' });
    await mkGoldenSet(user.id, dataset, { slug: 'gs-fixture', name: 'Fixture Golden Set' });

    const doc = await exportDoc('?format=json&include=goldenSets');
    expect(doc.goldenSets).toHaveLength(1);
    expect(doc.datasets).toEqual([]);
  });

  it('export omits TOMBSTONED items — they are removed content, not portable content', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const dataset = await mkAnnotatedDataset(user.id, { slug: 'ds-fixture' });
    const goldenSet = await mkGoldenSet(user.id, dataset, { slug: 'gs-fixture', name: 'Fixture Golden Set' });
    await db.goldenItem.updateMany({
      where: { goldenSetId: goldenSet.id, index: 0 },
      data: { tombstonedAt: new Date() },
    });

    const doc = await exportDoc('?format=json&include=all');

    // An unfiltered export would emit both, and importing it would resurrect
    // an item its owner removed on this instance.
    expect(doc.goldenSets[0].items).toHaveLength(1);
    expect(doc.goldenSets[0].items[0].inputText).toBe('what is 2 + 2');
    // The survivor keeps its ordinal — items are never re-packed.
    expect(doc.goldenSets[0].items[0].index).toBe(1);
  });

  it('export omits RETIRED and TOMBSTONED sets by default, and ?includeRetired=true brings back the retired one ONLY', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const dataset = await mkAnnotatedDataset(user.id, { slug: 'ds-fixture' });
    await mkGoldenSet(user.id, dataset, { slug: 'live-set', name: 'Live Set' });
    const retired = await mkGoldenSet(user.id, dataset, {
      slug: 'retired-set',
      name: 'Retired Set',
    });
    const tombstoned = await mkGoldenSet(user.id, dataset, {
      slug: 'tombstoned-set',
      name: 'Tombstoned Set',
    });
    await db.goldenSet.update({ where: { id: retired.id }, data: { retiredAt: new Date() } });
    await db.goldenSet.update({
      where: { id: tombstoned.id },
      data: { tombstonedAt: new Date() },
    });

    // Asserted on the exported ROWS, never on res.status — an export that
    // lost every set would still be a 200 with a clean document.
    const doc = await exportDoc('?format=json&include=all');
    expect(doc.goldenSets.map((g: { slug: string }) => g.slug)).toEqual(['live-set']);

    const all = await exportDoc('?format=json&include=all&includeRetired=true');
    expect(all.goldenSets.map((g: { slug: string }) => g.slug).sort()).toEqual([
      'live-set',
      'retired-set',
    ]);
    // Still never the tombstoned one. A fixture carrying only a retired set
    // would pass here against the coupled predicate this replaced, which
    // released both columns under the one flag.
    expect(all.goldenSets.some((g: { slug: string }) => g.slug === 'tombstoned-set')).toBe(false);

    // And the reason the default is off rather than on: `retiredAt` is
    // excludedByDesign from the config format — there is no field to carry
    // it — so a set exported under this flag re-imports as a LIVE one.
    expect(all.goldenSets.every((g: Record<string, unknown>) => !('retiredAt' in g))).toBe(true);
  });

  it('export → fresh instance → import reproduces the golden set as real rows', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const dataset = await mkAnnotatedDataset(user.id, { slug: 'ds-fixture' });
    await mkGoldenSet(user.id, dataset, { slug: 'gs-fixture', name: 'Fixture Golden Set' });

    const doc = await exportDoc();

    // A genuinely empty instance: no rows, new owner.
    await truncateAll();
    const migrated = await mkUser({ email: 'migrated@test.local' });
    mockSessionFor(migrated);
    await importConfig(importRequest(JSON.stringify(doc)));

    const imported = await db.goldenSet.findFirstOrThrow({
      where: { ownerId: migrated.id, slug: 'gs-fixture' },
      include: {
        items: {
          orderBy: { index: 'asc' },
          include: { candidates: { orderBy: { position: 'asc' } } },
        },
      },
    });
    expect(imported.protocol).toBe('pairwise');
    expect(imported.version).toBe(1);
    expect(imported.visibility).toBe('private');
    expect(imported.items).toHaveLength(2);
    expect(imported.items[0].inputText).toBe('who wrote hamlet');
    expect(imported.items[0].expected).toBe('A>B');
    expect(imported.items[0].protocol).toBe('pairwise');
    expect(imported.items[0].candidates.map((c) => c.responseText)).toEqual(['A-0', 'B-0']);

    // The required, `Restrict` source FK is re-resolved against the freshly
    // imported dataset — never carried across as an id.
    const migratedSample = await db.datasetSample.findFirstOrThrow({
      where: { dataset: { slug: 'ds-fixture' }, index: 0 },
    });
    expect(imported.items[0].sourceDatasetSampleId).toBe(migratedSample.id);
    expect(imported.datasetId).toBe(migratedSample.datasetId);
  });

  it('a POINTWISE set with no description round-trips its item- and candidate-level prompt/response text', async () => {
    // Every other case here is pairwise, described, and carries `expected` on
    // every item — so nothing else pins what the converter does with the
    // EMPTY side of each optional, and an exporter that dropped `promptText`
    // would round-trip vacuously through all of them.
    const user = await mkUser();
    mockSessionFor(user);
    const dataset = await mkAnnotatedDataset(user.id, { slug: 'ds-pointwise' });
    await db.goldenSet.create({
      data: {
        name: 'Pointwise Fixture',
        slug: 'gs-pointwise',
        // description left null on purpose: an absent optional must stay
        // absent, not come back as an empty string.
        visibility: 'private',
        protocol: 'pointwise',
        datasetId: dataset.id,
        ownerId: user.id,
        items: {
          create: [
            {
              sourceDatasetSampleId: dataset.samples[0].id,
              index: 0,
              inputText: dataset.samples[0].input,
              protocol: 'pointwise',
              // A pointwise import of a preference corpus has NO ground
              // truth: the label is a preference between two responses, not
              // a score for one (src/lib/golden-sets.ts's module doc).
              expected: null,
              promptText: 'You are a careful grader.',
              responseText: 'shakespeare',
              candidates: {
                create: [{ position: 0, promptText: 'grade this', responseText: 'shakespeare' }],
              },
            },
          ],
        },
      },
    });

    const doc = await exportDoc();
    const exported = doc.goldenSets[0];
    expect(exported.protocol).toBe('pointwise');
    expect(exported).not.toHaveProperty('description');
    expect(exported.items[0]).toEqual({
      index: 0,
      inputText: 'who wrote hamlet',
      promptText: 'You are a careful grader.',
      responseText: 'shakespeare',
      candidates: [{ position: 0, promptText: 'grade this', responseText: 'shakespeare' }],
    });
    expect(exported.items[0]).not.toHaveProperty('expected');

    await truncateAll();
    const migrated = await mkUser({ email: 'migrated4@test.local' });
    mockSessionFor(migrated);
    await importConfig(importRequest(JSON.stringify(doc)));

    const imported = await db.goldenSet.findFirstOrThrow({
      where: { ownerId: migrated.id, slug: 'gs-pointwise' },
      include: { items: { include: { candidates: true } } },
    });
    expect(imported.description).toBeNull();
    expect(imported.protocol).toBe('pointwise');
    expect(imported.items[0]).toMatchObject({
      protocol: 'pointwise',
      promptText: 'You are a careful grader.',
      responseText: 'shakespeare',
      expected: null,
    });
    expect(imported.items[0].candidates[0]).toMatchObject({
      position: 0,
      promptText: 'grade this',
      responseText: 'shakespeare',
      label: null,
    });
  });

  it('re-importing into the SAME instance resolves a platform-owned public dataset the exporter never emitted', async () => {
    const platform = await mkUser({ email: 'platform@judgearena.local' });
    const user = await mkUser();
    mockSessionFor(user);
    const dataset = await mkAnnotatedDataset(platform.id, { slug: 'judgebench-v1', visibility: 'public' });
    await mkGoldenSet(user.id, dataset, { slug: 'gs-platform', name: 'Over A Platform Corpus' });

    const doc = await exportDoc();
    // The datasets section is scoped `{ userId }`, so the platform corpus is
    // NOT in the document — only the golden set pointing at it. Without the
    // importer's public-dataset fallback, every real golden set (all of them
    // are over judgebench-v1) would fail to resolve on re-import.
    expect(doc.datasets).toEqual([]);
    expect(doc.goldenSets[0].datasetSlug).toBe('judgebench-v1');

    await importConfig(importRequest(JSON.stringify(doc)));

    expect(await db.goldenSet.count({ where: { ownerId: user.id } })).toBe(1); // no duplicate
    const set = await db.goldenSet.findFirstOrThrow({ where: { ownerId: user.id, slug: 'gs-platform' } });
    expect(set.datasetId).toBe(dataset.id);
    expect(await db.goldenItem.count({ where: { goldenSetId: set.id } })).toBe(2);
  });

  it('a golden set whose items match no dataset sample is skipped and writes no rows', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const dataset = await mkAnnotatedDataset(user.id, { slug: 'ds-fixture' });
    await mkGoldenSet(user.id, dataset, { slug: 'gs-fixture', name: 'Fixture Golden Set' });

    // Exported WITHOUT ?includeSamples: the dataset arrives sampleless, so
    // the items have nothing to bind their required source FK to. Skipping
    // is the honest outcome — the alternative is a P2003 in a 500.
    const doc = await exportDoc('?format=json&include=all');

    await truncateAll();
    const migrated = await mkUser({ email: 'migrated2@test.local' });
    mockSessionFor(migrated);
    const res = await importConfig(importRequest(JSON.stringify(doc)));
    const body = await res.json();

    expect(await db.dataset.count({ where: { userId: migrated.id } })).toBe(1);
    expect(await db.goldenSet.count()).toBe(0);
    expect(await db.goldenItem.count()).toBe(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const diff = body.items.find((i: any) => i.slug === 'gs-fixture');
    expect(diff.action).toBe('skip');
    expect(diff.changes[0]).toContain('no matching sample');
  });

  it('a golden set missing its required protocol is a 400 for the WHOLE document, not a partial import', async () => {
    // `goldenSetSchema.protocol` has no default on purpose — the set is
    // homogeneous and every item is stamped with it, so there is no safe
    // value to invent. Validation happens before any write, so the projects
    // and datasets alongside it must not land either.
    const user = await mkUser();
    mockSessionFor(user);

    const res = await importConfig(
      importRequest(
        JSON.stringify({
          version: '1.0',
          exportedAt: '2026-01-01T00:00:00.000Z',
          projects: [{ slug: 'proj-alpha', name: 'Project Alpha', isDefault: false }],
          goldenSets: [
            { slug: 'gs-broken', name: 'Broken Set', datasetSlug: 'ds-fixture', items: [] },
          ],
        })
      )
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('goldenSets.0.protocol');
    expect(await db.project.count()).toBe(0);
    expect(await db.goldenSet.count()).toBe(0);
  });

  it('dryRun=true reports the golden set without writing it', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const dataset = await mkAnnotatedDataset(user.id, { slug: 'ds-fixture' });
    await mkGoldenSet(user.id, dataset, { slug: 'gs-fixture', name: 'Fixture Golden Set' });
    const doc = await exportDoc();

    await truncateAll();
    const migrated = await mkUser({ email: 'migrated3@test.local' });
    mockSessionFor(migrated);
    await importConfig(importRequest(JSON.stringify(doc), true));

    expect(await db.goldenSet.count()).toBe(0);
    expect(await db.goldenCandidate.count()).toBe(0);
  });

  it('replacing an unfrozen set TOMBSTONES its items and appends the document above the high-water mark', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const dataset = await mkAnnotatedDataset(user.id, { slug: 'ds-fixture' });
    const goldenSet = await mkGoldenSet(user.id, dataset, { slug: 'gs-fixture', name: 'Fixture Golden Set' });

    // TWO replaces, because ONE proves nothing: the first runs against a set
    // with no tombstoned rows, where the high-water offset is 0 and
    // `item.index + offset` is indistinguishable from a raw 0..n-1. The
    // SECOND has to clear the first's tombstoned ordinals, and a raw 0..n-1
    // collides with them on @@unique([goldenSetId, index]) (P2002), aborting
    // the transaction and 500ing the import.
    const doc = await exportDoc();
    doc.goldenSets[0].items[0].candidates[0].responseText = 'A-0 (edit 1)';
    expect((await importConfig(importRequest(JSON.stringify(doc)))).status).toBe(200);

    let items = await liveItems(goldenSet.id);
    expect(items.map((i) => i.index)).toEqual([2, 3]);
    expect(items[0].candidates[0].responseText).toBe('A-0 (edit 1)');

    doc.goldenSets[0].items[0].candidates[0].responseText = 'A-0 (edit 2)';
    expect((await importConfig(importRequest(JSON.stringify(doc)))).status).toBe(200);

    items = await liveItems(goldenSet.id);
    expect(items.map((i) => i.index)).toEqual([4, 5]);
    expect(items[0].candidates[0].responseText).toBe('A-0 (edit 2)');

    // Nothing was removed: 2 original + 2 + 2, four of them tombstoned.
    expect(await db.goldenItem.count({ where: { goldenSetId: goldenSet.id } })).toBe(6);
    expect(
      await db.goldenItem.count({ where: { goldenSetId: goldenSet.id, tombstonedAt: { not: null } } })
    ).toBe(4);

    // And re-importing the SAME document is a no-op rather than another
    // replace: content is compared on relative ORDER, which survives the
    // offset, not on the raw `index` values, which do not.
    const res = await importConfig(importRequest(JSON.stringify(doc)));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const diff = (await res.json()).items.find((i: any) => i.slug === 'gs-fixture');
    expect(diff.action).toBe('skip');
    expect(await db.goldenItem.count({ where: { goldenSetId: goldenSet.id } })).toBe(6);
  });

  it('a replace tombstones the LABELS of every item it retires, with a reason that does not lie', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const dataset = await mkAnnotatedDataset(user.id, { slug: 'ds-fixture' });
    const goldenSet = await mkGoldenSet(user.id, dataset, { slug: 'gs-fixture', name: 'Fixture Golden Set' });
    const annotator = await mkUser({ email: 'annotator@test.local' });
    const before = await liveItems(goldenSet.id);
    await db.goldenLabel.createMany({
      data: [
        { goldenItemId: before[0].id, annotatorId: annotator.id, overallScore: 1 },
        { goldenItemId: before[1].id, annotatorId: annotator.id, overallScore: 2 },
      ],
    });

    // Only item 0 is edited. Item 1's label is invalidated ANYWAY: a replace
    // does not re-identify the document's items against the old rows, so
    // nothing can honestly claim item 1's score still applies to a row that
    // is now tombstoned.
    const doc = await exportDoc();
    doc.goldenSets[0].items[0].candidates[0].responseText = 'A-0 (edited)';
    expect((await importConfig(importRequest(JSON.stringify(doc)))).status).toBe(200);

    const labels = await db.goldenLabel.findMany({ orderBy: { overallScore: 'asc' } });
    expect(labels).toHaveLength(2); // tombstoned, never deleted
    expect(labels.every((l) => l.tombstonedAt !== null)).toBe(true);
    // A human label is attribution: the row survives and still names who made it.
    expect(labels.every((l) => l.annotatorId === annotator.id)).toBe(true);
    // 'item-content-edit' would be a false statement about item 1.
    expect(labels.map((l) => l.tombstonedReason)).toEqual([
      'config-import-replace',
      'config-import-replace',
    ]);

    // One instant for the whole replace — items and labels alike — so the
    // rows it invalidated read as one event rather than a scatter.
    const stamps = new Set<number>([
      ...labels.map((l) => l.tombstonedAt!.getTime()),
      ...(
        await db.goldenItem.findMany({
          where: { goldenSetId: goldenSet.id, tombstonedAt: { not: null } },
        })
      ).map((i) => i.tombstonedAt!.getTime()),
    ]);
    expect(stamps.size).toBe(1);

    // No live label is left pointing at a dead item.
    expect(
      await db.goldenLabel.count({
        where: { tombstonedAt: null, goldenItem: { tombstonedAt: { not: null } } },
      })
    ).toBe(0);
  });

  it('an export → edit → import cycle grows the high-water mark linearly, not exponentially', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const dataset = await mkAnnotatedDataset(user.id, { slug: 'ds-fixture' });
    const goldenSet = await mkGoldenSet(user.id, dataset, { slug: 'gs-fixture', name: 'Fixture Golden Set' });

    // Three full cycles, each exporting what is ACTUALLY there rather than
    // re-sending the original document. That is the loop that compounds: a
    // fresh export emits the indices the previous replace wrote, so adding
    // the offset to the document's RAW index roughly doubles the high-water
    // mark each time (2, 6, 14, …) and overflows GoldenItem.index's Int in
    // ~31 cycles. Writing POSITION + offset steps by the item count instead.
    for (const edit of ['edit 1', 'edit 2', 'edit 3']) {
      const doc = await exportDoc();
      doc.goldenSets[0].items[0].candidates[0].responseText = `A-0 (${edit})`;
      expect((await importConfig(importRequest(JSON.stringify(doc)))).status).toBe(200);
    }

    const items = await liveItems(goldenSet.id);
    expect(items.map((i) => i.index)).toEqual([6, 7]); // raw-index + offset gives [14, 15]
    expect(items[0].candidates[0].responseText).toBe('A-0 (edit 3)');
    expect(await db.goldenItem.count({ where: { goldenSetId: goldenSet.id } })).toBe(8);
  });

  it('a version family spanning two owners is not writable through the other owner\'s import', async () => {
    const owner = await mkUser({ email: 'family-owner@test.local' });
    const admin = await mkUser({ email: 'family-admin@test.local', role: 'admin' });
    mockSessionFor(owner);
    const dataset = await mkAnnotatedDataset(owner.id, { slug: 'ds-fixture' });
    const goldenSet = await mkGoldenSet(owner.id, dataset, { slug: 'gs-fixture', name: 'Fixture Golden Set' });

    // requireOwnership admits admins, so an admin may fork another user's set.
    // The result is ONE version family with TWO owners: root owned by `owner`,
    // v2 owned by `admin`.
    const adminFork = await forkGoldenSet(db, {
      rootGoldenSetId: goldenSet.id,
      sourceGoldenSetId: goldenSet.id,
      ownerId: admin.id,
      name: 'Admin Fork',
      description: null,
    });
    expect(adminFork.version).toBe(2);

    // The owner exports (their v1 only — export is ownerId-scoped) and
    // re-imports it edited. Unscoped, the family lookup resolves `existing`
    // to the newest member — the ADMIN's fork — and rewrites it.
    const doc = await exportDoc();
    expect(doc.goldenSets).toHaveLength(1);
    doc.goldenSets[0].items[0].candidates[0].responseText = 'A-0 (edited)';
    expect((await importConfig(importRequest(JSON.stringify(doc)))).status).toBe(200);

    const forkAfter = await db.goldenSet.findUniqueOrThrow({ where: { id: adminFork.id } });
    expect(forkAfter.name).toBe('Admin Fork');
    expect(forkAfter.ownerId).toBe(admin.id);
    expect(await db.goldenItem.count({ where: { goldenSetId: adminFork.id } })).toBe(2);
    expect(
      await db.goldenItem.count({ where: { goldenSetId: adminFork.id, tombstonedAt: { not: null } } })
    ).toBe(0);

    // …and the import wrote the set the session actually owns.
    const ownItems = await liveItems(goldenSet.id);
    expect(ownItems.map((i) => i.index)).toEqual([2, 3]);
    expect(ownItems[0].candidates[0].responseText).toBe('A-0 (edited)');
  });

  it('a FROZEN set forks instead of mutating, and the fork carries the document\'s items', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const dataset = await mkAnnotatedDataset(user.id, { slug: 'ds-fixture' });
    const goldenSet = await mkGoldenSet(user.id, dataset, { slug: 'gs-fixture', name: 'Fixture Golden Set' });

    const annotator = await mkUser({ email: 'fork-annotator@test.local' });
    const sourceItems = await liveItems(goldenSet.id);
    await db.goldenLabel.create({
      data: { goldenItemId: sourceItems[0].id, annotatorId: annotator.id, overallScore: 4 },
    });

    const doc = await exportDoc();
    await mkCalibrationRun(goldenSet.id); // freezes it
    doc.goldenSets[0].items[0].expected = 'B>A';

    const res = await importConfig(importRequest(JSON.stringify(doc)));
    expect(res.status).toBe(200);
    const body = await res.json();

    // The measured set is untouched — that is the whole point of decision #6.
    const original = await liveItems(goldenSet.id);
    expect(original.map((i) => i.index)).toEqual([0, 1]);
    expect(original.map((i) => i.expected)).toEqual(['A>B', 'B>A']);
    expect(await db.goldenItem.count({ where: { goldenSetId: goldenSet.id } })).toBe(2);

    const fork = await db.goldenSet.findFirstOrThrow({ where: { ownerId: user.id, version: 2 } });
    expect(fork.parentId).toBe(goldenSet.id);
    expect(fork.datasetId).toBe(dataset.id);

    // The fork's OWN items: forkGoldenSet copied the source's two at 0,1, and
    // the document's two replaced them — tombstoned, not deleted, so the
    // replacements land at 2,3. Same offset rule as the unfrozen path.
    const forkItems = await liveItems(fork.id);
    expect(forkItems.map((i) => i.index)).toEqual([2, 3]);
    expect(forkItems.map((i) => i.expected)).toEqual(['B>A', 'B>A']);
    expect(await db.goldenItem.count({ where: { goldenSetId: fork.id } })).toBe(4);

    // The source's label is untouched — the measured set is not being
    // replaced. Its COPY on the fork is tombstoned with the replace, because
    // the fork's copied items are exactly what the document supersedes.
    const sourceLabels = await db.goldenLabel.findMany({
      where: { goldenItem: { goldenSetId: goldenSet.id } },
    });
    expect(sourceLabels).toHaveLength(1);
    expect(sourceLabels[0].tombstonedAt).toBeNull();

    const forkLabels = await db.goldenLabel.findMany({
      where: { goldenItem: { goldenSetId: fork.id } },
    });
    expect(forkLabels).toHaveLength(1); // copied by forkGoldenSet, then invalidated
    expect(forkLabels[0].tombstonedAt).not.toBeNull();
    expect(forkLabels[0].tombstonedReason).toBe('config-import-replace');
    expect(forkLabels[0].annotatorId).toBe(annotator.id);

    // Reported as a `create`, never a new DiffAction value.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const diff = body.items.find((i: any) => i.type === 'goldenSet');
    expect(diff.action).toBe('create');
    expect(diff.changes[diff.changes.length - 1]).toContain('forked to version 2');
    // Three keys, unchanged: a fork is a `create`, not a fourth DiffAction.
    expect(body.summary).toEqual({ create: 1, update: 0, skip: 1 }); // + the unchanged dataset
  });

  it('a document pointing an existing set at a DIFFERENT dataset is refused, never repointed', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const datasetA = await mkAnnotatedDataset(user.id, { slug: 'ds-a' });
    await mkAnnotatedDataset(user.id, { slug: 'ds-b' });
    const goldenSet = await mkGoldenSet(user.id, datasetA, { slug: 'gs-fixture', name: 'Fixture Golden Set' });

    // ds-b carries the same inputs, so the items RESOLVE against it — this is
    // exactly the case that would otherwise produce a set claiming ds-a whose
    // items' sourceDatasetSampleId belong to ds-b. The item edit is what makes
    // the hazard reachable: without it there is nothing else to apply, and an
    // unguarded importer would merely under-report. With it, an unguarded
    // importer takes the replace path and writes ds-b's sample ids under a set
    // that still says ds-a.
    const doc = await exportDoc();
    doc.goldenSets[0].datasetSlug = 'ds-b';
    doc.goldenSets[0].items[0].candidates[0].responseText = 'A-0 (edited)';

    const res = await importConfig(importRequest(JSON.stringify(doc)));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const diff = (await res.json()).items.find((i: any) => i.slug === 'gs-fixture');
    expect(diff.action).toBe('skip');
    expect(diff.changes[0]).toContain('immutable');

    const after = await db.goldenSet.findUniqueOrThrow({ where: { id: goldenSet.id } });
    expect(after.datasetId).toBe(datasetA.id);
    // Refused outright: not even the item content was replaced.
    expect(await db.goldenItem.count({ where: { goldenSetId: goldenSet.id } })).toBe(2);
    expect(
      await db.goldenItem.count({ where: { goldenSetId: goldenSet.id, tombstonedAt: { not: null } } })
    ).toBe(0);
    // And no item cites a sample outside the set's own dataset.
    const foreign = await db.goldenItem.count({
      where: { goldenSetId: goldenSet.id, sourceSample: { datasetId: { not: datasetA.id } } },
    });
    expect(foreign).toBe(0);
  });
});
