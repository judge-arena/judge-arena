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
// covers must be classified into EXACTLY ONE of `exported` /
// `excludedByDesign` / `knownGaps` — no column may be claimed in two of
// these at once. `exported` means it appears in the document;
// `excludedByDesign` means it deliberately does not, with a reason;
// `knownGaps` means it SHOULD round-trip and does not yet.
//
// `exportedCaveats` is a fourth, separate, OPTIONAL bucket layered on top of
// `exported`, not an alternative to it: it records a caveat about a column
// that DOES round-trip structurally but has some other recorded wrinkle. See
// GoldenItem.index — the column IS exported (every consumer reads relative
// order off it), but its absolute VALUES are not stable across a
// replace-after-tombstone import, which is a materially different claim from
// `knownGaps`' "should round-trip and does not yet" (src/lib/config.ts:116-124
// documents the non-dense-index behaviour as intentional, so this is not an
// unfixed bug the way the parentId gaps are). Every `exportedCaveats` key
// must also appear in that model's `exported` array — asserted below — so a
// caveat can never quietly stand in for an export claim nobody actually made.
//
// knownGaps (and exportedCaveats) are not suppression lists — the test
// asserts each one's exact contents, so an entry cannot be added or quietly
// dropped without updating this file.

type Coverage = {
  exported: string[];
  excludedByDesign: Record<string, string>;
  knownGaps: Record<string, string>;
  /** Caveats about a column that IS exported. Keys must be a subset of `exported`. */
  exportedCaveats?: Record<string, string>;
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
      retestIntervalItems:
        'the measurement protocol in force on THIS instance, not part of the set as an artifact',
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
    knownGaps: {},
    exportedCaveats: {
      index:
        'index VALUES do not survive a re-import into a set that already has tombstoned items. Items are never re-packed (a tombstoned row keeps its ordinal), so a replace appends the document’s items above the set’s high-water mark rather than at 0..n-1 — the second export therefore emits shifted indices, stepping up by the item count on each export→edit→import cycle. Relative ORDER is preserved, which is what every consumer actually reads, and what the importer’s own create/update/skip comparison keys on; absolute values are not stable across a replace-after-tombstone. Note the cost is not only ordinal: a replace retires the set’s HUMAN ANNOTATIONS wholesale — every live GoldenLabel of the set is tombstoned with reason "config-import-replace", including labels on items whose content the document did not change, because the importer does not re-identify the document’s items against the existing rows. Re-importing a modified config is therefore not annotation-preserving, and a set that has been annotated should be edited through PATCH /api/golden-sets/[id]/items rather than round-tripped through a config document.',
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
      preference:
        'the human verdict for a pairwise item, same register as overallScore beside it',
      round: 'which blind reading this is — instance-local measurement protocol, not content',
      goldenItemRevisionId: 'instance-local FK to an instance-local revision row',
      criteriaScores: ANNOTATION,
      reasoning: ANNOTATION,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
      tombstonedAt:
        'same register as GoldenItem.tombstonedAt one level up: lifecycle state for a row that is not carried at all regardless of its state (see annotatorId) — even if labels round-tripped, a tombstoned label is retired on THIS instance (its item was edited, or a config import replaced the set) and must not come back live through an import elsewhere. See GoldenItem.exportedCaveats.index for what a config-import replace actually does to THIS table: it tombstones every live label of the set wholesale, not just the ones on items whose content changed.',
      tombstonedReason:
        'not a timestamp, but the same argument: records WHY a label was retired ("item-content-edit" | "config-import-replace", src/lib/golden-sets.ts) on THIS instance. Instance-local audit trail for a row that never round-trips in the first place (see annotatorId) — carrying it across instances would misattribute a retirement event that happened here to an import that happened elsewhere.',
    },
    knownGaps: {},
  },

  // Listed with an EMPTY `exported` array, like GoldenLabel above, and for a
  // related reason: a Tombstone records that a Dataset or DatasetSample is
  // HIDDEN on this instance, and the exporter is not meant to see a hidden
  // row in the first place. The document therefore represents a tombstone by
  // ABSENCE, which is the correct portable form: carrying the row would let a
  // re-import hide rows on another instance that its owner there never
  // deleted.
  //
  // THE FILTERING THIS DEPENDS ON NOW EXISTS, and this comment used to say it
  // did not. A1 Tasks 8 and 9 landed it (`23deeb2`):
  // src/app/api/config/export/route.ts's dataset loop takes
  // `liveDatasetsOnly()` on BOTH the admin and the owner arm, and its nested
  // `samples` include is `{ where: liveSamplesOnly(), orderBy: { index: 'asc' } }`.
  // So `exported: []` is now both what this model SHOULD contribute to the
  // document (nothing) and what the exporter actually does — and the
  // config/export coverage that `23deeb2` added alongside the filters is what
  // holds it there.
  //
  // This is deliberately NOT a knownGap. `knownGaps` means "should round-trip
  // and does not yet"; nothing on this model should round-trip. Recording one
  // here would also fail the gap ledger below, whose expected object is
  // locked to exactly {Rubric, Dataset, GoldenSet} — and that lock is
  // correct, so the entry is shaped to leave it alone rather than to edit it.
  Tombstone: {
    exported: [],
    excludedByDesign: {
      id: SURROGATE,
      datasetSampleId:
        'a DatasetSample id is instance-local and meaningless across instances, the same argument as GoldenItem.sourceDatasetSampleId — that alone excludes it today. It is additionally pointless once A1 Task 9 filters the nested `samples` include, because the hidden sample will then be absent from the document entirely, leaving nothing on the other side for this FK to point at.',
      datasetId:
        'same as datasetSampleId one column up, in both halves: the id is instance-local regardless, and now that A1 Task 8 filters the dataset export loop the document carries no hidden dataset for this FK to name',
      isTombstone:
        'the hide/un-hide flag itself. Instance-local curation state in the same register as GoldenItem.tombstonedAt: a row hidden HERE must not arrive hidden on another instance, and a re-import must neither resurrect nor re-bury anything. Absence from the document IS the representation.',
      reason:
        'free-text audit of WHY a row was hidden on THIS instance — same argument as GoldenLabel.tombstonedReason. Carrying it would misattribute a deletion that happened here to an import that happened elsewhere.',
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    },
    knownGaps: {},
  },

  // Empty `exported`, for the same reason as Tombstone directly above: a
  // revision records WHAT HAPPENED ON THIS INSTANCE. The config document
  // describes a dataset's CURRENT content, not its history, and carrying
  // revisions would attribute edits made here to an import made elsewhere —
  // the same forged-attribution argument that keeps GoldenLabel out of the
  // document.
  //
  // Not a knownGap: nothing here should round-trip. Recording one would also
  // fail the gap ledger below, whose expected object is locked to exactly
  // {Rubric, Dataset, GoldenSet}.
  SampleRevision: {
    exported: [],
    excludedByDesign: {
      id: SURROGATE,
      datasetSampleId:
        'instance-local FK to a row whose id is itself instance-local, the same argument as GoldenItem.sourceDatasetSampleId',
      changeType:
        'describes a mutation that happened on THIS instance; an import performs its own mutations and records its own rows',
      input:
        "the PRE-EDIT text of a sample on this instance. The document carries the sample's CURRENT text; carrying its history would let an import resurrect text the target instance never had",
      expected: 'same as input one column up — a before-image, not current content',
      metadata: 'same as input two columns up — a before-image, not current content',
      actorId:
        'a real User FK with no portable representation, exactly as GoldenLabel.annotatorId: carrying it across instances would forge an attribution',
      at: TIMESTAMP,
    },
    knownGaps: {},
  },

  // Instance-local mutation history, exactly as SampleRevision above: a
  // revision records WHAT HAPPENED HERE. The config document describes a
  // golden set's current content, not its edit history.
  GoldenItemRevision: {
    exported: [],
    excludedByDesign: {
      id: SURROGATE,
      goldenItemId: 'instance-local FK, the same argument as SampleRevision.datasetSampleId',
      inputText:
        'the PRE-EDIT text of an item on THIS instance; the document carries current content',
      promptText: 'same as inputText one column up — a before-image, not current content',
      responseText: 'same as inputText two columns up — a before-image, not current content',
      expected:
        "the ground truth AS IT STOOD before an edit here, not the document's current value",
      actorId: 'a real User FK with no portable representation, exactly as GoldenLabel.annotatorId',
      at: TIMESTAMP,
    },
    knownGaps: {},
  },

  // Workflow state, not content. WHO WAS ASKED to annotate on this instance
  // says nothing about the set as an artifact, and carrying it would assign
  // work to strangers on import.
  GoldenAssignment: {
    exported: [],
    excludedByDesign: {
      id: SURROGATE,
      goldenSetId: 'instance-local FK',
      annotatorId: 'a real User FK with no portable representation',
      goldenItemId: 'instance-local FK; NULL means the whole set',
      round: 'which reading this assignment is for — instance-local workflow state',
      assignedById: 'a real User FK with no portable representation',
      assignedAt: TIMESTAMP,
      completedAt: TIMESTAMP,
      revokedAt: TIMESTAMP,
      revokedReason: 'free-text audit of why an assignment was withdrawn HERE',
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

      // Nothing may be claimed in two buckets at once.
      const seen = new Set<string>();
      const dupes: string[] = [];
      for (const name of [
        ...spec.exported,
        ...Object.keys(spec.excludedByDesign),
        ...Object.keys(spec.knownGaps),
      ]) {
        if (seen.has(name)) dupes.push(name);
        seen.add(name);
      }
      expect(dupes, `${modelName} classifies column(s) in more than one bucket`).toEqual([]);

      // Every classified name must actually exist, so the lists cannot rot.
      const stale = [...classified].filter((c) => !columns.includes(c)).sort();
      expect(stale, `${modelName} classifies column(s) that no longer exist`).toEqual([]);

      // `exportedCaveats` is layered ON TOP of `exported`, never an alternative
      // to it — a caveat about a column the map does not even claim is
      // exported would be describing something that doesn't exist.
      const caveatKeys = Object.keys(spec.exportedCaveats ?? {});
      const caveatsNotExported = caveatKeys.filter((c) => !spec.exported.includes(c)).sort();
      expect(
        caveatsNotExported,
        `${modelName} has exportedCaveats for column(s) not listed in exported: ` +
          `${caveatsNotExported.join(', ')}`
      ).toEqual([]);
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
    });
  });

  it('the set of caveats on exported columns is exactly what we have recorded', () => {
    const actual: Record<string, string[]> = {};
    for (const [modelName, spec] of Object.entries(COVERAGE)) {
      const caveats = Object.keys(spec.exportedCaveats ?? {}).sort();
      if (caveats.length) actual[modelName] = caveats;
    }

    // Same locking property as the gap ledger above, for a different claim:
    // GoldenItem.index round-trips (it IS in `exported`), but its absolute
    // VALUES are not stable across a replace-after-tombstone import — not
    // the same defect as the parentId gaps above, where the column is
    // missing from the document entirely.
    expect(actual).toEqual({
      GoldenItem: ['index'],
    });
  });
});
