import { describe, it, expect, beforeEach } from 'vitest';
import { db, truncateAll, mkUser } from './helpers';
import { ensureJudgeIdentityForModelConfig } from '@/lib/judge-identity';
import type { ModelConfig } from '@prisma/client';

let modelConfigCounter = 0;

async function mkModelConfig(
  userId: string,
  overrides: Partial<Omit<ModelConfig, 'id' | 'userId' | 'createdAt' | 'updatedAt'>> = {}
) {
  modelConfigCounter += 1;
  return db.modelConfig.create({
    data: {
      name: `fixture-model-${modelConfigCounter}`,
      provider: 'openai',
      modelId: 'gpt-4o',
      userId,
      ...overrides,
    },
  });
}

describe('judge identity tables + versioned prompt templates', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('JudgeModelVersion (judgeModelId, ordinal) is unique', async () => {
    const judgeModel = await db.judgeModel.create({
      data: {
        name: 'GPT-4 Judge',
        slug: 'gpt-4-judge',
        judgeClass: 'prompted_api',
        scoringMechanism: 'critique_generative',
      },
    });
    await db.judgeModelVersion.create({
      data: {
        judgeModelId: judgeModel.id,
        ordinal: 1,
        servingBackend: 'openai',
        protocolSupport: { pointwise: ['score'] },
      },
    });
    await expect(
      db.judgeModelVersion.create({
        data: {
          judgeModelId: judgeModel.id,
          ordinal: 1,
          servingBackend: 'openai',
          protocolSupport: { pointwise: ['score'] },
        },
      })
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('deleting a JudgeModel with versions is restricted (P2003)', async () => {
    const judgeModel = await db.judgeModel.create({
      data: {
        name: 'Claude Judge',
        slug: 'claude-judge',
        judgeClass: 'prompted_api',
        scoringMechanism: 'critique_generative',
      },
    });
    await db.judgeModelVersion.create({
      data: {
        judgeModelId: judgeModel.id,
        ordinal: 1,
        servingBackend: 'anthropic',
        protocolSupport: { pointwise: ['score'] },
      },
    });
    await expect(db.judgeModel.delete({ where: { id: judgeModel.id } })).rejects.toMatchObject({
      code: 'P2003',
    });
  });

  it('ModelEndpoint requires an active user and a judge model version', async () => {
    const user = await mkUser();
    const judgeModel = await db.judgeModel.create({
      data: {
        name: 'Local Judge',
        slug: 'local-judge',
        judgeClass: 'prompted_open_weight',
        scoringMechanism: 'token_probability',
      },
    });
    const version = await db.judgeModelVersion.create({
      data: {
        judgeModelId: judgeModel.id,
        ordinal: 1,
        servingBackend: 'vllm',
        protocolSupport: { pointwise: ['score'] },
      },
    });
    const endpoint = await db.modelEndpoint.create({
      data: {
        userId: user.id,
        judgeModelVersionId: version.id,
        endpoint: 'http://localhost:8000',
      },
    });
    expect(endpoint.isActive).toBe(true);

    // Deleting the version it points to is restricted while the endpoint exists.
    await expect(
      db.judgeModelVersion.delete({ where: { id: version.id } })
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('PromptTemplate (name, version) is unique', async () => {
    await db.promptTemplate.create({
      data: { name: 'my-template', protocol: 'pointwise', version: 1, body: 'body v1' },
    });
    await expect(
      db.promptTemplate.create({
        data: { name: 'my-template', protocol: 'pointwise', version: 1, body: 'body v1 dup' },
      })
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('seed creates the v1-legacy prompt template idempotently', async () => {
    // Import lazily so this file can still fail cleanly before the seed
    // module exists / compiles against the new PromptTemplate model.
    const { seedPromptTemplates } = await import('../../prisma/seed-prompt-templates');
    await seedPromptTemplates(db);
    await seedPromptTemplates(db); // idempotent — re-running must not throw or duplicate

    const templates = await db.promptTemplate.findMany({
      where: { name: 'v1-legacy', version: 0 },
    });
    expect(templates).toHaveLength(1);
    const template = templates[0];
    expect(template.protocol).toBe('pointwise');
    expect(template.body).toContain('You are an expert evaluator acting as an impartial judge');
    expect(template.body).toContain('${rubricName}');
    expect(template.body).toContain('${criteriaList}');
  });
});

// ─── ensureJudgeIdentityForModelConfig (src/lib/judge-identity.ts) ────────
// Mirrors tests/importer/judges.db.test.ts's shapes (same find-or-create +
// idempotency contract), scoped to the live-runtime, single-ModelConfig
// resolver Task 9's web-tier producer path calls per selected model.
describe('ensureJudgeIdentityForModelConfig', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('creates a JudgeModel + JudgeModelVersion + ModelEndpoint on first call, reuses all three on a second call for the same ModelConfig', async () => {
    const user = await mkUser();
    const config = await mkModelConfig(user.id, {
      provider: 'anthropic',
      modelId: 'claude-3-opus',
      endpoint: null,
      apiKey: 'enc:v1:aaaa:bbbb:cccc',
      isActive: true,
    });

    const first = await ensureJudgeIdentityForModelConfig(db, config);
    expect(await db.judgeModel.count()).toBe(1);
    expect(await db.judgeModelVersion.count()).toBe(1);
    expect(await db.modelEndpoint.count()).toBe(1);

    const second = await ensureJudgeIdentityForModelConfig(db, config);
    expect(second.versionId).toBe(first.versionId);
    expect(second.endpointId).toBe(first.endpointId);
    // Still exactly one of each — the second call found-and-reused, it
    // didn't duplicate.
    expect(await db.judgeModel.count()).toBe(1);
    expect(await db.judgeModelVersion.count()).toBe(1);
    expect(await db.modelEndpoint.count()).toBe(1);

    const version = await db.judgeModelVersion.findUnique({ where: { id: first.versionId } });
    expect(version).toMatchObject({
      ordinal: 1,
      servingBackend: 'anthropic',
      endpointClass: null,
      protocolSupport: { pointwise: ['score'] },
      samplingDefaults: { temperature: 0.3, max_tokens: 4096 },
    });

    const judgeModel = await db.judgeModel.findUnique({ where: { id: version!.judgeModelId } });
    expect(judgeModel).toMatchObject({
      judgeClass: 'prompted_api',
      scoringMechanism: 'critique_generative',
      // Diverges from the v1 importer on purpose (see judge-identity.ts's
      // doc §1) — the literal provider model id IS available here.
      baseModel: 'claude-3-opus',
    });

    const endpoint = await db.modelEndpoint.findUnique({ where: { id: first.endpointId } });
    expect(endpoint).toMatchObject({
      userId: user.id,
      judgeModelVersionId: first.versionId,
      endpoint: null,
      isActive: true,
      // Carried through as-is (already encrypted) — see judge-identity.ts's
      // doc §2.
      apiKeyEnc: 'enc:v1:aaaa:bbbb:cccc',
    });
  });

  it("provider 'local' maps to servingBackend openai + endpointClass v1-local-unknown, judgeClass prompted_open_weight", async () => {
    const user = await mkUser();
    const config = await mkModelConfig(user.id, {
      provider: 'local',
      modelId: 'llama-3-70b',
      endpoint: 'http://localhost:11434/v1',
    });

    const { versionId } = await ensureJudgeIdentityForModelConfig(db, config);
    const version = await db.judgeModelVersion.findUnique({ where: { id: versionId } });
    expect(version).toMatchObject({ servingBackend: 'openai', endpointClass: 'v1-local-unknown' });

    const judgeModel = await db.judgeModel.findUnique({ where: { id: version!.judgeModelId } });
    expect(judgeModel?.judgeClass).toBe('prompted_open_weight');
  });

  it('two ModelConfigs sharing (provider, modelId, endpoint) resolve to the SAME JudgeModelVersion but get their OWN ModelEndpoint (different owning user)', async () => {
    const userA = await mkUser();
    const userB = await mkUser();
    const configA = await mkModelConfig(userA.id, {
      provider: 'openai',
      modelId: 'gpt-4o',
      endpoint: null,
    });
    const configB = await mkModelConfig(userB.id, {
      provider: 'openai',
      modelId: 'gpt-4o',
      endpoint: null,
    });

    const identityA = await ensureJudgeIdentityForModelConfig(db, configA);
    const identityB = await ensureJudgeIdentityForModelConfig(db, configB);

    expect(identityB.versionId).toBe(identityA.versionId);
    expect(identityB.endpointId).not.toBe(identityA.endpointId);
    expect(await db.judgeModel.count()).toBe(1);
    expect(await db.judgeModelVersion.count()).toBe(1);
    expect(await db.modelEndpoint.count()).toBe(2);
  });

  it('two ModelConfigs with the same (provider, modelId) but DIFFERENT endpoints resolve to DISTINCT JudgeModel identities', async () => {
    const user = await mkUser();
    const configA = await mkModelConfig(user.id, {
      provider: 'local',
      modelId: 'llama-3',
      endpoint: 'http://host-a:8000',
    });
    const configB = await mkModelConfig(user.id, {
      provider: 'local',
      modelId: 'llama-3',
      endpoint: 'http://host-b:8000',
    });

    const identityA = await ensureJudgeIdentityForModelConfig(db, configA);
    const identityB = await ensureJudgeIdentityForModelConfig(db, configB);

    expect(identityB.versionId).not.toBe(identityA.versionId);
    expect(await db.judgeModel.count()).toBe(2);
    expect(await db.judgeModelVersion.count()).toBe(2);
  });

  it('rejects an unrecognized provider', async () => {
    const user = await mkUser();
    const config = await mkModelConfig(user.id, { provider: 'not-a-real-provider' });

    // Task 10: classifyProvider's servingBackend resolution now delegates to
    // registry.ts's legacyProviderToBackend (the one place the legacy
    // provider-string -> ServingBackend mapping lives), which throws first
    // and carries this message instead.
    await expect(ensureJudgeIdentityForModelConfig(db, config)).rejects.toThrow(
      /legacyProviderToBackend: unrecognized legacy provider/
    );
  });

  it('a concurrent first-use race on a brand-new (provider, modelId, endpoint) triple resolves to the SAME versionId for both callers instead of one throwing P2002', async () => {
    // Both calls resolve the same never-before-seen (provider, modelId,
    // endpoint) triple concurrently — findOrCreateJudgeModel's and
    // findOrCreateVersion's find-then-create is not atomic, so both can see
    // "not found" and both attempt `create`. Before the fix, the loser's
    // `create` would reject with a raw P2002 (JudgeModel.slug /
    // JudgeModelVersion.(judgeModelId, ordinal) are real unique
    // constraints) and Promise.all would reject. With the fix, the loser
    // catches P2002 and re-finds the winner's row instead.
    const user = await mkUser();
    const config = await mkModelConfig(user.id, {
      provider: 'openai',
      modelId: 'gpt-4o-concurrent-race-fixture',
      endpoint: null,
    });

    const [first, second] = await Promise.all([
      ensureJudgeIdentityForModelConfig(db, config),
      ensureJudgeIdentityForModelConfig(db, config),
    ]);

    expect(first.versionId).toBe(second.versionId);
    expect(await db.judgeModel.count()).toBe(1);
    expect(await db.judgeModelVersion.count()).toBe(1);
  });
});
