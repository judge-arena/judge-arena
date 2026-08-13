import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { getServerSession } from 'next-auth';
import { Prisma } from '@prisma/client';
import { db, truncateAll, mkUser } from './helpers';
import { POST as importConfig } from '@/app/api/config/import/route';
import { GET as exportConfig } from '@/app/api/config/export/route';

// ─── Why this file exists, separately from config-import-export.test.ts ─────
//
// That file already has a test labelled "round-trip": it exports a document and
// asserts the export "re-imports as a no-op". That proves IDEMPOTENCY, and
// idempotency structurally CANNOT detect loss — a field the exporter drops
// entirely still re-imports as a no-op, because the importer never sees it and
// therefore changes nothing. Both halves agreeing to ignore a column looks
// identical to both halves handling it correctly.
//
// The owner has made "download your config and move to a self-hosted instance
// losslessly" a product guarantee (docs/superpowers/specs/
// 2026-08-08-north-star-rebaseline-design.md, "Portability is a product
// guarantee"). A guarantee needs a test that fails when it is broken, so this
// file asserts the two things idempotency misses:
//
//   1. FIDELITY — every value we import comes back out of the exporter. This is
//      what catches symmetric loss.
//   2. COVERAGE — every user-ownable column is consciously classified as
//      exported, excluded-by-design, or a known gap. This is the durable half:
//      adding a column fails the test until somebody decides which bucket it
//      belongs in, so the guarantee survives future schema growth instead of
//      decaying silently.
//
// (2) is deliberately more annoying than (1). That is the point.

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(),
}));
vi.mock('next/headers', () => ({
  headers: vi.fn(async () => new Headers()),
}));

function mockSessionFor(user: { id: string; email: string }) {
  (getServerSession as unknown as Mock).mockResolvedValue({
    user: { id: user.id, email: user.email },
  });
}

/**
 * A config document with EVERY optional field populated. Fidelity cannot be
 * measured with a minimal fixture: an exporter that drops `huggingFaceId` looks
 * perfect against a fixture that never set it.
 *
 * NOTE on `endpoint`: today any authenticated user may set it. The rebaseline
 * spec makes endpoint writes admin-only (decision C), at which point this
 * fixture's session must become an admin or the field moves to a separate
 * admin-only fidelity case. Left here so the change breaks this test loudly
 * rather than silently narrowing what round-trips.
 *
 * NOTE on `isDefault`: set false on purpose. It is slated for deletion (it is
 * the front-page-takeover vector), so it is asserted as present-and-false
 * rather than exercised as true.
 */
const FULL_CONFIG = {
  version: '1.0' as const,
  exportedAt: '2026-01-01T00:00:00.000Z',
  projects: [
    {
      slug: 'proj-alpha',
      name: 'Project Alpha',
      description: 'project description, populated on purpose',
      isDefault: false,
    },
  ],
  rubrics: [
    {
      slug: 'rub-alpha',
      name: 'Rubric Alpha',
      description: 'rubric description, populated on purpose',
      version: 1,
      criteria: [
        { name: 'Accuracy', description: 'is the answer correct', maxScore: 5, weight: 2, order: 0 },
        { name: 'Style', description: 'is the answer well written', maxScore: 3, weight: 1, order: 1 },
      ],
    },
  ],
  models: [
    {
      slug: 'mod-alpha',
      name: 'Model Alpha',
      provider: 'openai',
      modelId: 'gpt-4o-mini',
      endpoint: 'https://api.openai.com/v1',
      isActive: true,
    },
  ],
  datasets: [
    {
      slug: 'ds-alpha',
      name: 'Dataset Alpha',
      description: 'dataset description, populated on purpose',
      source: 'manual',
      visibility: 'private' as const,
      sourceUrl: 'https://example.com/source',
      huggingFaceId: 'some-org/some-dataset',
      tags: ['tag-alpha', 'tag-beta'],
      projectSlug: 'proj-alpha',
      samples: [
        { index: 0, input: 'input zero', expected: 'expected zero', metadata: { note: 'first', n: 1 } },
        { index: 1, input: 'input one', expected: 'expected one', metadata: { note: 'second', n: 2 } },
      ],
    },
  ],
  goldenSets: [
    {
      slug: 'gs-alpha',
      name: 'Golden Set Alpha',
      description: 'golden set description, populated on purpose',
      visibility: 'private' as const,
      protocol: 'pairwise' as const,
      datasetSlug: 'ds-alpha',
      version: 1,
      items: [
        {
          index: 0,
          // MUST equal a DatasetSample.input of ds-alpha above. The importer
          // re-resolves GoldenItem.sourceDatasetSampleId (required,
          // onDelete: Restrict) by content, because a sample id is
          // instance-local — see that column's COVERAGE entry. Change one of
          // these strings without the other and the set is skipped, not
          // errored.
          inputText: 'input zero',
          // Item-level promptText/responseText are null for every JudgeBench
          // mapping; populated here anyway because this fixture measures
          // FIDELITY, and a field nobody sets is a field nobody notices
          // being dropped.
          promptText: 'item prompt zero',
          responseText: 'item response zero',
          expected: 'A>B',
          candidates: [
            { position: 0, promptText: 'cand prompt a0', responseText: 'cand response a0', label: 'A' },
            { position: 1, promptText: 'cand prompt b0', responseText: 'cand response b0', label: 'B' },
          ],
        },
        {
          index: 1,
          inputText: 'input one',
          promptText: 'item prompt one',
          responseText: 'item response one',
          expected: 'B>A',
          candidates: [
            { position: 0, promptText: 'cand prompt a1', responseText: 'cand response a1', label: 'A' },
            { position: 1, promptText: 'cand prompt b1', responseText: 'cand response b1', label: 'B' },
          ],
        },
      ],
    },
  ],
};

const EXPORT_QUERY = '?format=json&include=all&includeSamples=true';

async function exportDoc(): Promise<Record<string, any>> {
  const res = await exportConfig(new Request(`http://localhost/api/config/export${EXPORT_QUERY}`));
  expect(res.status).toBe(200);
  return res.json();
}

async function importDoc(doc: unknown): Promise<Record<string, any>> {
  const res = await importConfig(
    new Request('http://localhost/api/config/import?dryRun=false', {
      method: 'POST',
      body: JSON.stringify(doc),
      headers: { 'content-type': 'application/json' },
    })
  );
  const body = await res.json();
  expect(
    res.status,
    `import failed: ${JSON.stringify(body).slice(0, 400)}`
  ).toBeLessThan(300);
  return body;
}

/**
 * Strip values that are legitimately allowed to differ between two exports of
 * the same logical state, and impose a deterministic order so deep-equality is
 * meaningful. Anything removed here is a claim that it does not carry user
 * intent — keep the list short and justified.
 */
function normalize(doc: Record<string, any>): Record<string, any> {
  const bySlug = (a: any, b: any) => String(a.slug).localeCompare(String(b.slug));
  return {
    version: doc.version,
    // exportedAt is a wall-clock stamp of the export event, not user state.
    projects: [...(doc.projects ?? [])].sort(bySlug),
    rubrics: [...(doc.rubrics ?? [])].sort(bySlug).map((r: any) => ({
      ...r,
      criteria: [...(r.criteria ?? [])].sort((a: any, b: any) => a.order - b.order),
    })),
    models: [...(doc.models ?? [])].sort(bySlug),
    datasets: [...(doc.datasets ?? [])].sort(bySlug).map((d: any) => ({
      ...d,
      tags: d.tags ? [...d.tags].sort() : d.tags,
      samples: d.samples
        ? [...d.samples].sort((a: any, b: any) => a.index - b.index)
        : d.samples,
    })),
    goldenSets: [...(doc.goldenSets ?? [])].sort(bySlug).map((g: any) => ({
      ...g,
      items: [...(g.items ?? [])]
        .sort((a: any, b: any) => a.index - b.index)
        .map((i: any) => ({
          ...i,
          candidates: [...(i.candidates ?? [])].sort((a: any, b: any) => a.position - b.position),
        })),
    })),
  };
}

describe('Config export/import — fidelity, not just idempotency', () => {
  let user: { id: string; email: string };

  beforeEach(async () => {
    await truncateAll();
    user = (await mkUser()) as unknown as { id: string; email: string };
    mockSessionFor(user);
  });

  it('every value in an imported config survives back out through the exporter', async () => {
    await importDoc(FULL_CONFIG);
    const exported = normalize(await exportDoc());
    const expected = normalize(FULL_CONFIG as unknown as Record<string, any>);

    // Asserted per-entity rather than as one deep-equal so a failure names the
    // entity that lost data instead of dumping the whole document.
    expect(exported.projects, 'projects lost data on round-trip').toEqual(expected.projects);
    expect(exported.rubrics, 'rubrics lost data on round-trip').toEqual(expected.rubrics);
    expect(exported.models, 'models lost data on round-trip').toEqual(expected.models);
    expect(exported.datasets, 'datasets lost data on round-trip').toEqual(expected.datasets);
    expect(exported.goldenSets, 'golden sets lost data on round-trip').toEqual(expected.goldenSets);
  });

  it('a config exported from one instance reproduces byte-identical state on a fresh instance', async () => {
    // This is the actual product promise: hosted -> download -> self-host.
    await importDoc(FULL_CONFIG);
    const first = await exportDoc();

    // Stand up a genuinely empty "instance": no rows, new owner.
    await truncateAll();
    const migrated = (await mkUser({ email: 'migrated@example.com' })) as unknown as {
      id: string;
      email: string;
    };
    mockSessionFor(migrated);

    await importDoc(first);
    const second = await exportDoc();

    expect(normalize(second)).toEqual(normalize(first));
  });

  it('importing an export twice is idempotent and does not duplicate rows', async () => {
    await importDoc(FULL_CONFIG);
    const doc = await exportDoc();
    await importDoc(doc);

    const [projects, rubrics, datasets, samples, endpoints, goldenSets, goldenItems, goldenCandidates] =
      await Promise.all([
        db.project.count({ where: { userId: user.id } }),
        db.rubric.count({ where: { userId: user.id } }),
        db.dataset.count({ where: { userId: user.id } }),
        db.datasetSample.count(),
        db.modelEndpoint.count({ where: { userId: user.id } }),
        // GoldenSet keys ownership on ownerId, not userId.
        db.goldenSet.count({ where: { ownerId: user.id } }),
        db.goldenItem.count(),
        db.goldenCandidate.count(),
      ]);

    expect({ projects, rubrics, datasets, samples, endpoints, goldenSets, goldenItems, goldenCandidates }).toEqual({
      projects: 1,
      rubrics: 1,
      datasets: 1,
      samples: 2,
      endpoints: 1,
      // A second import must find the set by (ownerId, slug) and skip it.
      // 2 here instead of 1 means the slug match failed; 4 items means the
      // update path recreated instead of matching.
      goldenSets: 1,
      goldenItems: 2,
      goldenCandidates: 4,
    });
  });
});

// ─── The durable half ──────────────────────────────────────────────────────
//
// Every user-ownable scalar/enum column of every model the config document
// covers must be classified. `exported` means it appears in the document;
// `excludedByDesign` means it deliberately does not, with a reason;
// `knownGaps` means it SHOULD round-trip and does not yet.
//
// A name MAY appear in both `exported` and `knownGaps` at once — that is not
// a double-claim, it is a narrower one: the column IS structurally exported,
// but a caveat about it is recorded. See GoldenItem.index: the column round-
// trips, but its VALUES are not stable across a replace-after-tombstone
// import, which is a different claim than "not exported at all".
// `excludedByDesign` may not overlap with either of the other two buckets —
// "never exported by design" is not compatible with being exported or being
// a gap in what's exported.
//
// knownGaps is not a suppression list — the test asserts its exact contents, so
// a gap cannot be added or quietly fixed without updating this file.

type Coverage = {
  exported: string[];
  excludedByDesign: Record<string, string>;
  knownGaps: Record<string, string>;
};

const SURROGATE = 'surrogate key, meaningless across instances';
const OWNER = 'owner is the importing session, never carried in the document';
const TIMESTAMP = 'server-assigned on write';
const PUBLICATION = 'publication state is instance-scoped: you cannot carry "published on the hosted board" to your own instance';
// GoldenLabel.annotatorId is a real User FK, nullable via `onDelete: SetNull`
// since it was introduced in 20260725012218_v2_meta_eval. Uniqueness on it is
// per-LIVE-label, not whole-table: the hand-written partial index
// GoldenLabel_goldenItemId_annotatorId_live_key (WHERE "tombstonedAt" IS
// NULL, added by 20260813120000_v2e_golden_item_label_tombstones) replaced
// `@@unique([goldenItemId, annotatorId])`, because a tombstoned label would
// otherwise occupy its annotator's slot forever and block re-annotation —
// see that migration's own comment. That change is about re-annotation, not
// portability; it does not touch the argument below.
const ANNOTATION =
  'human annotations do not round-trip: GoldenLabel.annotatorId is a real User FK with no portable representation, and the importer attributes everything to session.user.id (src/app/api/config/import/route.ts:216). Carrying a label across instances would forge an attribution — an annotator would be recorded as having scored text they never saw.';
const HOMOGENEOUS =
  'the set is homogeneous: GoldenSet.protocol is the single source of truth and import stamps every item with it';

const COVERAGE: Record<string, Coverage> = {
  Project: {
    exported: ['slug', 'name', 'description', 'isDefault'],
    excludedByDesign: {
      id: SURROGATE,
      userId: OWNER,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
      visibility: PUBLICATION,
      publishedAt: PUBLICATION,
    },
    knownGaps: {},
  },

  Rubric: {
    exported: ['slug', 'name', 'description', 'version'],
    excludedByDesign: {
      id: SURROGATE,
      userId: OWNER,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
      visibility: PUBLICATION,
      publishedAt: PUBLICATION,
      retiredAt: 'soft-delete state; a retired rubric is not part of a portable working set',
    },
    knownGaps: {
      parentId:
        'rubric version LINEAGE does not round-trip. ConfigRubric carries `version` but not the parent link, so exporting v1+v2 yields two independent rubrics on import. Versioning is a pinned product capability, so this is real loss, not a nicety.',
    },
  },

  RubricCriterion: {
    exported: ['name', 'description', 'maxScore', 'weight', 'order'],
    excludedByDesign: {
      id: SURROGATE,
      rubricId: 'implied by document nesting',
    },
    knownGaps: {},
  },

  Dataset: {
    exported: [
      'slug',
      'name',
      'description',
      'source',
      'visibility',
      'sourceUrl',
      'huggingFaceId',
      'tags',
      'projectId', // emitted as `projectSlug`
    ],
    excludedByDesign: {
      id: SURROGATE,
      userId: OWNER,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
      publishedAt: PUBLICATION,
      sampleCount: 'derived from the samples array',
      localData: 'instance-local payload; the samples array is the portable form',
      filePath: 'instance-local filesystem pointer, meaningless on another host',
      remoteMetadata: 're-derivable from huggingFaceId',
    },
    knownGaps: {
      version:
        'dataset version number is dropped entirely, so a versioned dataset family flattens on export.',
      parentId:
        'dataset version LINEAGE does not round-trip — same defect as Rubric.parentId and the more severe of the two, because dataset families are what benchmarks are built on.',
      inputType: 'not represented in ConfigDataset; import re-derives or defaults it.',
      format: 'not represented in ConfigDataset.',
      splits: 'not represented in ConfigDataset; a split definition is user intent, not derivable.',
      features: 'not represented in ConfigDataset.',
    },
  },

  DatasetSample: {
    exported: ['index', 'input', 'expected', 'metadata'],
    excludedByDesign: {
      id: SURROGATE,
      datasetId: 'implied by document nesting',
      createdAt: TIMESTAMP,
    },
    knownGaps: {},
  },

  GoldenSet: {
    exported: [
      'slug',
      'name',
      'description',
      'visibility',
      'protocol',
      'version',
      'datasetId', // emitted as `datasetSlug`
    ],
    excludedByDesign: {
      id: SURROGATE,
      ownerId: OWNER,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
      publishedAt: PUBLICATION,
      retiredAt:
        'retire state is a product verb meaning "out of circulation on THIS instance"; carrying it would let a re-import silently resurrect a retired set, and a retired set is not part of a portable working set',
      tombstonedAt:
        'account-lifecycle state, pending purge — never user intent, and a tombstoned set must not come back through a config file',
    },
    knownGaps: {
      parentId:
        'golden set version LINEAGE does not round-trip. ConfigGoldenSet carries `version` but not the parent link, so exporting v1+v2 yields two independent root sets on import. Same defect as Rubric.parentId and Dataset.parentId, and the same fix would close all three.',
    },
  },

  GoldenItem: {
    exported: ['index', 'inputText', 'promptText', 'responseText', 'expected'],
    excludedByDesign: {
      id: SURROGATE,
      goldenSetId: 'implied by document nesting',
      protocol: HOMOGENEOUS,
      sourceDatasetSampleId:
        'a DatasetSample id is instance-local, so the FK itself is not portable. It is re-resolved on import from the set’s datasetSlug + this item’s inputText (which is DatasetSample.input verbatim for all three protocol mappings). Two samples with identical input collapse onto the lowest-index one — accepted, because the annotation is over the input text.',
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
      tombstonedAt:
        'curation-lifecycle state, not user intent to preserve: the export query filters tombstoned items out before dbGoldenSetToConfig ever sees them (goldenItemLifecycleWhere(false) in src/app/api/config/export/route.ts), and a re-import must not resurrect an item its owner removed as live content. Same register as GoldenSet.tombstonedAt, different verb — GoldenSet’s is account-lifecycle (pending purge); an item’s is a product action (PATCH /api/golden-sets/[id]/items, or a config-import replace).',
    },
    knownGaps: {
      index:
        'index VALUES do not survive a re-import into a set that already has tombstoned items. Items are never re-packed (a tombstoned row keeps its ordinal), so a replace appends the document’s items above the set’s high-water mark rather than at 0..n-1 — the second export therefore emits shifted indices, stepping up by the item count on each export→edit→import cycle. Relative ORDER is preserved, which is what every consumer actually reads, and what the importer’s own create/update/skip comparison keys on; absolute values are not stable across a replace-after-tombstone. Note the cost is not only ordinal: a replace retires the set’s HUMAN ANNOTATIONS wholesale — every live GoldenLabel of the set is tombstoned with reason "config-import-replace", including labels on items whose content the document did not change, because the importer does not re-identify the document’s items against the existing rows. Re-importing a config is therefore not annotation-preserving, and a set that has been annotated should be edited through PATCH /api/golden-sets/[id]/items rather than round-tripped through a config document.',
    },
  },

  GoldenCandidate: {
    exported: ['position', 'promptText', 'responseText', 'label'],
    excludedByDesign: {
      id: SURROGATE,
      goldenItemId: 'implied by document nesting',
    },
    knownGaps: {},
  },

  // Listed with an EMPTY `exported` array on purpose. GoldenLabel is inside
  // the config document's blast radius — it hangs off GoldenItem, which the
  // document does carry — and every one of its columns is deliberately
  // absent. Recording that here rather than omitting the model means a new
  // label column still fails this test until somebody decides, instead of
  // slipping in under "we don't cover that table".
  GoldenLabel: {
    exported: [],
    excludedByDesign: {
      id: SURROGATE,
      goldenItemId: 'implied by document nesting — except nothing is nested; see annotatorId',
      annotatorId: ANNOTATION,
      overallScore: ANNOTATION,
      criteriaScores: ANNOTATION,
      reasoning: ANNOTATION,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
      tombstonedAt:
        'same register as GoldenItem.tombstonedAt one level up: lifecycle state for a row that is not carried at all regardless of its state (see annotatorId) — even if labels round-tripped, a tombstoned label is retired on THIS instance (its item was edited, or a config import replaced the set) and must not come back live through an import elsewhere.',
      tombstonedReason:
        'not a timestamp, but the same argument: records WHY a label was retired ("item-content-edit" | "config-import-replace", src/lib/golden-sets.ts) on THIS instance. Instance-local audit trail for a row that never round-trips in the first place (see annotatorId) — carrying it across instances would misattribute a retirement event that happened here to an import that happened elsewhere.',
    },
    knownGaps: {},
  },
};

describe('Config export/import — schema coverage', () => {
  for (const [modelName, spec] of Object.entries(COVERAGE)) {
    it(`${modelName}: every column is classified as exported, excluded, or a known gap`, () => {
      const model = Prisma.dmmf.datamodel.models.find((m) => m.name === modelName);
      expect(model, `${modelName} is not in the Prisma datamodel`).toBeDefined();

      const columns = model!.fields
        .filter((f) => f.kind === 'scalar' || f.kind === 'enum')
        .map((f) => f.name);

      const classified = new Set([
        ...spec.exported,
        ...Object.keys(spec.excludedByDesign),
        ...Object.keys(spec.knownGaps),
      ]);

      const unclassified = columns.filter((c) => !classified.has(c)).sort();
      expect(
        unclassified,
        `${modelName} has unclassified column(s): ${unclassified.join(', ')}. ` +
          'A new column must be added to exactly one of exported / excludedByDesign / ' +
          'knownGaps in tests/db/config-roundtrip-fidelity.test.ts. This test is the ' +
          'only thing standing between "lossless portability" and a promise that ' +
          'quietly stopped being true.'
      ).toEqual([]);

      // `excludedByDesign` may not overlap with `exported` or `knownGaps` —
      // "never exported by design" contradicts being exported or being a gap
      // in what's exported.
      const excludedNames = Object.keys(spec.excludedByDesign);
      const otherNames = new Set([...spec.exported, ...Object.keys(spec.knownGaps)]);
      const excludedContradictions = excludedNames.filter((n) => otherNames.has(n)).sort();
      expect(
        excludedContradictions,
        `${modelName} classifies column(s) as excludedByDesign together with exported/knownGaps`
      ).toEqual([]);

      // `exported` and `knownGaps` MAY share a name (see the comment above
      // the `Coverage` type) — but a name may not appear twice within the
      // SAME bucket, which is always a copy-paste mistake, not a claim.
      const withinBucketDupes = (names: string[]) =>
        names.filter((name, i) => names.indexOf(name) !== i);
      expect(
        withinBucketDupes(spec.exported),
        `${modelName} lists the same column twice in exported`
      ).toEqual([]);
      expect(
        withinBucketDupes(Object.keys(spec.knownGaps)),
        `${modelName} lists the same column twice in knownGaps`
      ).toEqual([]);

      // Every classified name must actually exist, so the lists cannot rot.
      const stale = [...classified].filter((c) => !columns.includes(c)).sort();
      expect(stale, `${modelName} classifies column(s) that no longer exist`).toEqual([]);
    });
  }

  it('the set of known portability gaps is exactly what we have accepted', () => {
    const actual: Record<string, string[]> = {};
    for (const [modelName, spec] of Object.entries(COVERAGE)) {
      const gaps = Object.keys(spec.knownGaps).sort();
      if (gaps.length) actual[modelName] = gaps;
    }

    // Locking this down means closing a gap fails the test too — which is
    // correct: the fix and the record of it land together.
    expect(actual).toEqual({
      Rubric: ['parentId'],
      Dataset: ['features', 'format', 'inputType', 'parentId', 'splits', 'version'],
      // A0 adds the third instance of the same defect: version number
      // round-trips, the parent link does not. Recorded, not fixed — closing
      // it means teaching the importer to reconstruct a family from slugs,
      // which is one change across all three models and not A0's.
      GoldenSet: ['parentId'],
      // Not the same defect as the above three: the column itself round-trips
      // fine (see GoldenItem.exported); only its VALUES are unstable across a
      // replace-after-tombstone import. See this entry's own text for why.
      GoldenItem: ['index'],
    });
  });
});
