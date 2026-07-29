import { describe, it, expect, beforeEach } from 'vitest';
import { db, truncateAll, mkUser } from './helpers';

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
