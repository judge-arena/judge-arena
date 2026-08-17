import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { getServerSession } from 'next-auth';
import { db, truncateAll, mkUser } from './helpers';
import { POST as importConfig } from '@/app/api/config/import/route';
import { GET as exportConfig } from '@/app/api/config/export/route';

// Task 12 review fix: `POST /api/config/import`'s "Models" section used to
// CRUD the retired `ModelConfig` table directly — a live write path
// creating legacy rows the rest of the runtime no longer reads. It now
// creates JudgeModel/JudgeModelVersion/ModelEndpoint rows through the same
// `createCustomJudgeModel` helper `POST /api/models` (mode: 'custom') uses
// (src/lib/model-catalog.ts), and `GET /api/config/export` reads models
// back from that same domain instead of `ModelConfig`. Same "call the real
// route handler directly against a live test DB, mock next-auth for the
// session" pattern as tests/db/model-endpoint-crud.test.ts.

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

function importRequest(body: string, dryRun = false) {
  return new Request(`http://localhost/api/config/import?dryRun=${dryRun}`, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json' },
  });
}

function exportRequest(query = ''): Request {
  return new Request(`http://localhost/api/config/export${query}`);
}

function baseConfig(model: Record<string, unknown>) {
  return {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    projects: [],
    rubrics: [],
    models: [model],
    datasets: [],
  };
}

describe('Config import/export — models on the catalog+endpoint domain (Task 12 review fix)', () => {
  beforeEach(async () => {
    await truncateAll();
    (getServerSession as unknown as Mock).mockReset();
  });

  it('importing a new model creates JudgeModel + JudgeModelVersion + ModelEndpoint, never a ModelConfig row', async () => {
    const user = await mkUser();
    mockSessionFor(user);

    const configJson = JSON.stringify(
      baseConfig({ slug: 'imported-claude', name: 'Imported Claude', provider: 'anthropic', modelId: 'claude-sonnet-4-5', isActive: true })
    );

    const res = await importConfig(importRequest(configJson));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary).toEqual({ create: 1, update: 0, skip: 0 });

    expect(await db.modelConfig.count()).toBe(0);

    const judgeModel = await db.judgeModel.findUniqueOrThrow({ where: { slug: 'imported-claude' } });
    expect(judgeModel).toMatchObject({
      name: 'Imported Claude',
      judgeClass: 'prompted_api',
      scoringMechanism: 'critique_generative',
      baseModel: 'claude-sonnet-4-5',
    });

    const version = await db.judgeModelVersion.findFirstOrThrow({ where: { judgeModelId: judgeModel.id } });
    expect(version).toMatchObject({ ordinal: 1, servingBackend: 'anthropic' });

    const endpoint = await db.modelEndpoint.findFirstOrThrow({
      where: { userId: user.id, judgeModelVersionId: version.id },
    });
    expect(endpoint.isActive).toBe(true);
    expect(endpoint.apiKeyEnc).toBeNull(); // API keys are never imported
  });

  it('legacy "local" provider maps to servingBackend openai + judgeClass prompted_open_weight (same defaults scripts/importer/judges.ts uses)', async () => {
    const user = await mkUser();
    mockSessionFor(user);

    const configJson = JSON.stringify(
      baseConfig({ slug: 'imported-local', name: 'Imported Local', provider: 'local', modelId: 'self-hosted-model', isActive: true })
    );
    await importConfig(importRequest(configJson));

    const judgeModel = await db.judgeModel.findUniqueOrThrow({ where: { slug: 'imported-local' } });
    expect(judgeModel.judgeClass).toBe('prompted_open_weight');
    const version = await db.judgeModelVersion.findFirstOrThrow({ where: { judgeModelId: judgeModel.id } });
    expect(version.servingBackend).toBe('openai'); // legacyProviderToBackend('local') === 'openai'
  });

  it('a real (non-legacy) ServingBackend value in the config imports directly, no legacyProviderToBackend translation', async () => {
    const user = await mkUser();
    mockSessionFor(user);

    const configJson = JSON.stringify(
      baseConfig({ slug: 'imported-vllm', name: 'Imported vLLM Judge', provider: 'vllm', modelId: 'meta-llama/Llama-3-70b-Instruct', isActive: true })
    );
    await importConfig(importRequest(configJson));

    const judgeModel = await db.judgeModel.findUniqueOrThrow({ where: { slug: 'imported-vllm' } });
    expect(judgeModel.judgeClass).toBe('prompted_open_weight'); // vllm -> self-hosted default
    const version = await db.judgeModelVersion.findFirstOrThrow({ where: { judgeModelId: judgeModel.id } });
    expect(version.servingBackend).toBe('vllm');
  });

  it('the created JudgeModel uses the CONFIG\'s own slug verbatim, not a re-derivation of the name — required for re-import idempotency when they differ', async () => {
    const user = await mkUser();
    mockSessionFor(user);

    // `generateSlug('Imported vLLM Judge')` would produce
    // 'imported-vllm-judge', NOT 'imported-vllm' — a deliberately mismatched
    // pair to guard against `createCustomJudgeModel` silently re-deriving
    // the slug from `name` and creating a row the next import's slug-based
    // existence check (`prisma.judgeModel.findUnique({ where: { slug } })`)
    // can never find again.
    const model = { slug: 'imported-vllm', name: 'Imported vLLM Judge', provider: 'vllm', modelId: 'meta-llama/Llama-3-70b-Instruct', isActive: true };
    const configJson = JSON.stringify(baseConfig(model));

    const firstRes = await importConfig(importRequest(configJson));
    const firstBody = await firstRes.json();
    expect(firstBody.summary).toEqual({ create: 1, update: 0, skip: 0 });
    expect(await db.judgeModel.count({ where: { slug: 'imported-vllm' } })).toBe(1);
    expect(await db.judgeModel.count({ where: { slug: 'imported-vllm-judge' } })).toBe(0);

    const secondRes = await importConfig(importRequest(configJson));
    const secondBody = await secondRes.json();
    expect(secondBody.summary).toEqual({ create: 0, update: 0, skip: 1 }); // finds the SAME row, not a duplicate
    expect(await db.judgeModel.count()).toBe(1);
  });

  it('re-importing the identical config is idempotent: second import reports skip, no duplicate rows', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const configJson = JSON.stringify(
      baseConfig({ slug: 'imported-idempotent', name: 'Imported Idempotent', provider: 'openai', modelId: 'gpt-4o', isActive: true })
    );

    await importConfig(importRequest(configJson));
    const res2 = await importConfig(importRequest(configJson));
    const body2 = await res2.json();
    expect(body2.summary).toEqual({ create: 0, update: 0, skip: 1 });

    expect(await db.judgeModel.count({ where: { slug: 'imported-idempotent' } })).toBe(1);
  });

  it('re-importing with a changed endpoint/isActive updates the ModelEndpoint in place, without touching JudgeModel identity (immutable catalog)', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const model = { slug: 'imported-mutable', name: 'Imported Mutable', provider: 'openai', modelId: 'gpt-4o', isActive: true };

    await importConfig(importRequest(JSON.stringify(baseConfig(model))));
    const judgeModelBefore = await db.judgeModel.findUniqueOrThrow({ where: { slug: 'imported-mutable' } });

    const changedConfig = baseConfig({ ...model, isActive: false, endpoint: 'https://my-proxy.example.com/v1' });
    const res2 = await importConfig(importRequest(JSON.stringify(changedConfig)));
    const body2 = await res2.json();
    expect(body2.summary).toEqual({ create: 0, update: 1, skip: 0 });

    const judgeModelAfter = await db.judgeModel.findUniqueOrThrow({ where: { slug: 'imported-mutable' } });
    expect(judgeModelAfter).toEqual(judgeModelBefore); // catalog identity untouched
    expect(await db.judgeModelVersion.count({ where: { judgeModelId: judgeModelAfter.id } })).toBe(1); // no new version either

    const endpoint = await db.modelEndpoint.findFirstOrThrow({
      where: { userId: user.id, judgeModelVersion: { judgeModelId: judgeModelAfter.id } },
    });
    expect(endpoint.isActive).toBe(false);
    expect(endpoint.endpoint).toBe('https://my-proxy.example.com/v1');
  });

  it('dryRun=true reports the diff without writing anything', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const configJson = JSON.stringify(
      baseConfig({ slug: 'imported-dry-run', name: 'Imported Dry Run', provider: 'anthropic', modelId: 'claude-haiku', isActive: true })
    );
    const res = await importConfig(importRequest(configJson, true));
    const body = await res.json();
    expect(body.summary).toEqual({ create: 1, update: 0, skip: 0 });
    expect(await db.judgeModel.count()).toBe(0);
    expect(await db.modelEndpoint.count()).toBe(0);
  });

  it('export emits models from the ModelEndpoint/JudgeModel domain with the REAL servingBackend, and the exported doc re-imports as a no-op (round-trip)', async () => {
    const user = await mkUser();
    mockSessionFor(user);

    // A custom vllm-backed judge created directly via the catalog domain —
    // mirrors what POST /api/models (mode: 'custom') or a prior import
    // would have produced. Export must read THIS, never a ModelConfig row
    // (there isn't one).
    const judgeModel = await db.judgeModel.create({
      data: {
        name: 'Exported vLLM Judge',
        slug: 'exported-vllm-judge',
        judgeClass: 'prompted_open_weight',
        scoringMechanism: 'critique_generative',
        baseModel: 'meta-llama/Llama-3-70b-Instruct',
      },
    });
    const version = await db.judgeModelVersion.create({
      data: { judgeModelId: judgeModel.id, ordinal: 1, servingBackend: 'vllm', protocolSupport: { pointwise: ['score'] } },
    });
    await db.modelEndpoint.create({
      data: { userId: user.id, judgeModelVersionId: version.id, endpoint: 'http://localhost:8000/v1', isActive: true },
    });

    const exportRes = await exportConfig(exportRequest('?format=json'));
    expect(exportRes.status).toBe(200);
    const exported = await exportRes.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const exportedModel = exported.models.find((m: any) => m.slug === 'exported-vllm-judge');
    expect(exportedModel).toMatchObject({
      name: 'Exported vLLM Judge',
      provider: 'vllm',
      modelId: 'meta-llama/Llama-3-70b-Instruct',
      endpoint: 'http://localhost:8000/v1',
      isActive: true,
    });

    // Re-importing the export for the SAME user is a no-op: this user
    // already owns a matching, unchanged endpoint against that slug.
    const reImportRes = await importConfig(importRequest(JSON.stringify(exported)));
    const reImportBody = await reImportRes.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const modelDiff = reImportBody.items.find((i: any) => i.slug === 'exported-vllm-judge');
    expect(modelDiff.action).toBe('skip');
    expect(await db.judgeModel.count({ where: { slug: 'exported-vllm-judge' } })).toBe(1); // no duplicate created
    expect(await db.modelConfig.count()).toBe(0);
  });
});

/**
 * A1 wave 1 — the importer's dataset-CREATE branch is the one hide-then-write
 * pair in the tree that is not a single transaction: `dataset.create` (which
 * writes `sampleCount: samples.length`) and `datasetSample.createMany` (which
 * writes the document's `index` verbatim) are two round trips with nothing
 * between them. A duplicate index therefore reached P2002 in the SECOND, after
 * the first had already committed — a 500 over a dataset row claiming N
 * samples with zero sample rows behind it.
 *
 * Pre-existing in substance, and previously unlikely because exports were
 * dense. A1 makes a filtered export GAPPED, which makes hand-renumbering a
 * config document a natural thing to do and a collision a natural mistake.
 */
describe('Config import — duplicate sample indices are refused at the schema (A1 wave 1)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  function datasetDoc(indices: number[]) {
    return JSON.stringify({
      version: '1.0',
      exportedAt: new Date().toISOString(),
      projects: [],
      rubrics: [],
      models: [],
      datasets: [
        {
          slug: 'dup-index-corpus',
          name: 'Dup Index Corpus',
          source: 'local',
          visibility: 'private',
          samples: indices.map((index) => ({ index, input: `row-${index}` })),
        },
      ],
    });
  }

  it('400s naming the field, and leaves NO half-applied dataset behind', async () => {
    const user = await mkUser();
    mockSessionFor(user);

    const res = await importConfig(importRequest(datasetDoc([0, 0, 1])));

    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('duplicate index');

    // The shape the 500 used to leave: a dataset row whose stored count
    // describes rows that are not there.
    await expect(db.dataset.count({ where: { slug: 'dup-index-corpus' } })).resolves.toBe(0);
    await expect(db.datasetSample.count()).resolves.toBe(0);
  });

  it('a GAPPED index sequence still imports — the refine rejects duplicates, not holes', async () => {
    // A filtered export emits gaps by construction (`config.ts` writes
    // `index: s.index` verbatim from a `liveSamplesOnly()` read), so a refine
    // that demanded a dense 0..n-1 run would break every export A1 produces.
    const user = await mkUser();
    mockSessionFor(user);

    const res = await importConfig(importRequest(datasetDoc([0, 2, 7])));

    expect(res.status).toBe(200);
    const created = await db.dataset.findFirstOrThrow({
      where: { slug: 'dup-index-corpus' },
      include: { samples: { orderBy: { index: 'asc' } } },
    });
    expect(created.samples.map((s) => s.index)).toEqual([0, 2, 7]);
    expect(created.sampleCount).toBe(3);
  });
});
