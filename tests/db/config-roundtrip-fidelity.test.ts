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

    const [projects, rubrics, datasets, samples, endpoints] = await Promise.all([
      db.project.count({ where: { userId: user.id } }),
      db.rubric.count({ where: { userId: user.id } }),
      db.dataset.count({ where: { userId: user.id } }),
      db.datasetSample.count(),
      db.modelEndpoint.count({ where: { userId: user.id } }),
    ]);

    expect({ projects, rubrics, datasets, samples, endpoints }).toEqual({
      projects: 1,
      rubrics: 1,
      datasets: 1,
      samples: 2,
      endpoints: 1,
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
    });
  });
});
