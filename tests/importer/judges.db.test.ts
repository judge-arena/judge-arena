import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createImportCtx } from '../../scripts/importer/context';
import { resolveOwners } from '../../scripts/importer/owners';
import { synthesizeJudges } from '../../scripts/importer/judges';
import { db, truncateAll } from '../db/helpers';
import { v1db, truncateAllV1, mkV1User, mkV1ModelConfig } from './helpers';
import type { OwnerMap } from '../../scripts/importer/context';

// DB-backed: needs BOTH the v1 scratch DB (V1_DATABASE_URL) and the v2 test
// DB (DATABASE_URL/TEST_DATABASE_URL) reachable. Named *.db.test.ts and
// listed in vitest.db.config.ts's include (NOT vitest.config.ts's), so
// plain `npm test` never runs this file — see tests/importer/helpers.ts.
describe('synthesizeJudges (DB)', () => {
  beforeEach(async () => {
    await truncateAll();
    await truncateAllV1();
  });

  afterAll(async () => {
    await v1db.$disconnect();
    await db.$disconnect();
  });

  it('groups by (provider, modelId, endpoint): shared triple -> 1 JudgeModel/Version + 2 Endpoints; distinct triple -> +1 each', async () => {
    const userA = await mkV1User();
    const userB = await mkV1User();

    const sharedA = await mkV1ModelConfig(userA.id, {
      provider: 'anthropic',
      modelId: 'claude-3-opus',
      endpoint: null,
    });
    const sharedB = await mkV1ModelConfig(userB.id, {
      provider: 'anthropic',
      modelId: 'claude-3-opus',
      endpoint: null,
    });
    const distinct = await mkV1ModelConfig(userA.id, {
      provider: 'openai',
      modelId: 'gpt-4o',
      endpoint: null,
    });

    const ownerMap: OwnerMap = {
      [userA.id]: { email: 'a@v2.example', oidcIssuer: 'https://idp.test.local', oidcSubject: 'sub-a' },
      [userB.id]: { email: 'b@v2.example', oidcIssuer: 'https://idp.test.local', oidcSubject: 'sub-b' },
    };
    const ctx = createImportCtx({ mode: 'apply', ownerMap });
    const owners = await resolveOwners(ctx);
    const result = await synthesizeJudges(ctx, owners);

    expect(await db.judgeModel.count()).toBe(2);
    expect(await db.judgeModelVersion.count()).toBe(2);
    expect(await db.modelEndpoint.count()).toBe(3);

    const sharedEntry = result.get(sharedA.id)!;
    expect(result.get(sharedB.id)!.versionId).toBe(sharedEntry.versionId);
    const distinctEntry = result.get(distinct.id)!;
    expect(distinctEntry.versionId).not.toBe(sharedEntry.versionId);

    // One endpoint per owning v1 user within the shared group, keyed by v1 userId.
    const endpointA = sharedEntry.endpointIdByUser.get(userA.id);
    const endpointB = sharedEntry.endpointIdByUser.get(userB.id);
    expect(endpointA).toBeTruthy();
    expect(endpointB).toBeTruthy();
    expect(endpointA).not.toBe(endpointB);

    const version = await db.judgeModelVersion.findUnique({ where: { id: sharedEntry.versionId } });
    expect(version).toMatchObject({
      ordinal: 1,
      weightsRevision: 'v1-unknown',
      quantization: 'none',
      servingBackend: 'anthropic',
      endpointClass: null,
      protocolSupport: { pointwise: ['score'] },
      samplingDefaults: { temperature: 0.3, max_tokens: 4096 },
      trustState: 'untrusted',
    });

    const judgeModel = await db.judgeModel.findUnique({ where: { id: version!.judgeModelId } });
    expect(judgeModel).toMatchObject({
      slug: 'anthropic-claude-3-opus',
      judgeClass: 'prompted_api',
      scoringMechanism: 'critique_generative',
    });
  });

  it("provider 'local' maps to servingBackend openai + endpointClass v1-local-unknown, judgeClass prompted_open_weight", async () => {
    const user = await mkV1User();
    const config = await mkV1ModelConfig(user.id, {
      provider: 'local',
      modelId: 'llama-3-70b',
      endpoint: 'http://localhost:11434/v1',
    });
    const ownerMap: OwnerMap = {
      [user.id]: { email: 'c@v2.example', oidcIssuer: 'https://idp.test.local', oidcSubject: 'sub-c' },
    };
    const ctx = createImportCtx({ mode: 'apply', ownerMap });
    const owners = await resolveOwners(ctx);
    const result = await synthesizeJudges(ctx, owners);

    const entry = result.get(config.id)!;
    const version = await db.judgeModelVersion.findUnique({ where: { id: entry.versionId } });
    expect(version).toMatchObject({ servingBackend: 'openai', endpointClass: 'v1-local-unknown' });

    const judgeModel = await db.judgeModel.findUnique({ where: { id: version!.judgeModelId } });
    expect(judgeModel?.judgeClass).toBe('prompted_open_weight');
  });

  it('a dropped owner gets no ModelEndpoint, but the JudgeModel/Version for its distinct triple is still created', async () => {
    const user = await mkV1User();
    const config = await mkV1ModelConfig(user.id, {
      provider: 'openai',
      modelId: 'gpt-4o-mini',
      endpoint: null,
    });
    const ctx = createImportCtx({ mode: 'apply', ownerMap: { [user.id]: 'drop' } });
    const owners = await resolveOwners(ctx);
    const result = await synthesizeJudges(ctx, owners);

    expect(await db.judgeModel.count()).toBe(1);
    expect(await db.judgeModelVersion.count()).toBe(1);
    expect(await db.modelEndpoint.count()).toBe(0);

    const entry = result.get(config.id)!;
    expect(entry.versionId).toBeTruthy();
    expect(entry.endpointIdByUser.size).toBe(0);
    expect(ctx.report.counts().ModelEndpoint).toMatchObject({ created: 0, dropped: 1 });
  });

  it('slug collisions across distinct groups sharing (provider, modelId) get suffixed -2, -3, ...', async () => {
    const user = await mkV1User();
    const cfg1 = await mkV1ModelConfig(user.id, {
      provider: 'local',
      modelId: 'llama-3',
      endpoint: 'http://host-a:8000',
    });
    const cfg2 = await mkV1ModelConfig(user.id, {
      provider: 'local',
      modelId: 'llama-3',
      endpoint: 'http://host-b:8000',
    });
    const ownerMap: OwnerMap = {
      [user.id]: { email: 'd@v2.example', oidcIssuer: 'https://idp.test.local', oidcSubject: 'sub-d' },
    };
    const ctx = createImportCtx({ mode: 'apply', ownerMap });
    const owners = await resolveOwners(ctx);
    const result = await synthesizeJudges(ctx, owners);

    const version1 = await db.judgeModelVersion.findUnique({ where: { id: result.get(cfg1.id)!.versionId } });
    const version2 = await db.judgeModelVersion.findUnique({ where: { id: result.get(cfg2.id)!.versionId } });
    const jm1 = await db.judgeModel.findUnique({ where: { id: version1!.judgeModelId } });
    const jm2 = await db.judgeModel.findUnique({ where: { id: version2!.judgeModelId } });

    expect([jm1?.slug, jm2?.slug].sort()).toEqual(['local-llama-3', 'local-llama-3-2']);
  });

  it('is idempotent in apply mode: re-running against the same v1 data finds the same rows, no duplicates', async () => {
    const user = await mkV1User();
    const config = await mkV1ModelConfig(user.id, {
      provider: 'anthropic',
      modelId: 'claude-3-haiku',
      endpoint: null,
    });
    const ownerMap: OwnerMap = {
      [user.id]: { email: 'e@v2.example', oidcIssuer: 'https://idp.test.local', oidcSubject: 'sub-e' },
    };

    const ctx1 = createImportCtx({ mode: 'apply', ownerMap });
    const owners1 = await resolveOwners(ctx1);
    const result1 = await synthesizeJudges(ctx1, owners1);

    const ctx2 = createImportCtx({ mode: 'apply', ownerMap });
    const owners2 = await resolveOwners(ctx2);
    const result2 = await synthesizeJudges(ctx2, owners2);

    expect(result2.get(config.id)!.versionId).toBe(result1.get(config.id)!.versionId);
    expect(await db.judgeModel.count()).toBe(1);
    expect(await db.judgeModelVersion.count()).toBe(1);
    expect(await db.modelEndpoint.count()).toBe(1);

    expect(ctx2.report.counts().JudgeModel).toMatchObject({ created: 0, skipped: 1 });
    expect(ctx2.report.counts().JudgeModelVersion).toMatchObject({ created: 0, skipped: 1 });
    expect(ctx2.report.counts().ModelEndpoint).toMatchObject({ created: 0, skipped: 1 });
  });

  it('report mode tallies created counts but writes nothing to v2 (real counts stay 0)', async () => {
    const userA = await mkV1User();
    const userB = await mkV1User();
    const sharedA = await mkV1ModelConfig(userA.id, {
      provider: 'anthropic',
      modelId: 'claude-3-opus',
      endpoint: null,
    });
    const sharedB = await mkV1ModelConfig(userB.id, {
      provider: 'anthropic',
      modelId: 'claude-3-opus',
      endpoint: null,
    });
    const distinct = await mkV1ModelConfig(userA.id, {
      provider: 'openai',
      modelId: 'gpt-4o',
      endpoint: null,
    });

    const ownerMap: OwnerMap = {
      [userA.id]: { email: 'f@v2.example', oidcIssuer: 'https://idp.test.local', oidcSubject: 'sub-f' },
      [userB.id]: { email: 'g@v2.example', oidcIssuer: 'https://idp.test.local', oidcSubject: 'sub-g' },
    };
    const ctx = createImportCtx({ mode: 'report', ownerMap });
    const owners = await resolveOwners(ctx);
    const result = await synthesizeJudges(ctx, owners);

    expect(ctx.report.counts()).toMatchObject({
      User: { created: 2, skipped: 0 },
      JudgeModel: { created: 2, skipped: 0 },
      JudgeModelVersion: { created: 2, skipped: 0 },
      ModelEndpoint: { created: 3, skipped: 0 },
    });

    expect(await db.user.count()).toBe(0);
    expect(await db.judgeModel.count()).toBe(0);
    expect(await db.judgeModelVersion.count()).toBe(0);
    expect(await db.modelEndpoint.count()).toBe(0);

    // Still keyed for every v1 ModelConfig id, even though nothing real exists yet.
    expect(result.size).toBe(3);
    expect(result.has(sharedA.id)).toBe(true);
    expect(result.has(sharedB.id)).toBe(true);
    expect(result.has(distinct.id)).toBe(true);
    expect(result.get(sharedA.id)!.versionId).toBe(result.get(sharedB.id)!.versionId);
  });

  it('slug collision: two v1 ModelConfigs with identical (provider,modelId) but different endpoints -> X and X-2 (idempotent across runs)', async () => {
    const user = await mkV1User();

    // Two configs with same (provider, modelId) but different endpoints:
    // both will slugify to 'anthropic-claude-3-sonnet', creating a collision.
    const cfg1 = await mkV1ModelConfig(user.id, {
      provider: 'anthropic',
      modelId: 'claude-3-sonnet',
      endpoint: 'https://endpoint-a.example.com',
    });
    const cfg2 = await mkV1ModelConfig(user.id, {
      provider: 'anthropic',
      modelId: 'claude-3-sonnet',
      endpoint: 'https://endpoint-b.example.com',
    });

    const ownerMap: OwnerMap = {
      [user.id]: { email: 'h@v2.example', oidcIssuer: 'https://idp.test.local', oidcSubject: 'sub-h' },
    };

    // Run 1: apply mode, capture JudgeModel ids
    const ctx1 = createImportCtx({ mode: 'apply', ownerMap });
    const owners1 = await resolveOwners(ctx1);
    const result1 = await synthesizeJudges(ctx1, owners1);

    const version1a = await db.judgeModelVersion.findUnique({ where: { id: result1.get(cfg1.id)!.versionId } });
    const version1b = await db.judgeModelVersion.findUnique({ where: { id: result1.get(cfg2.id)!.versionId } });
    const jm1a = await db.judgeModel.findUnique({ where: { id: version1a!.judgeModelId } });
    const jm1b = await db.judgeModel.findUnique({ where: { id: version1b!.judgeModelId } });

    expect([jm1a?.slug, jm1b?.slug].sort()).toEqual(['anthropic-claude-3-sonnet', 'anthropic-claude-3-sonnet-2']);
    const jm1aId = jm1a!.id;
    const jm1bId = jm1b!.id;

    // Run 2: same v1 data, re-run the importer against v2 DB
    const ctx2 = createImportCtx({ mode: 'apply', ownerMap });
    const owners2 = await resolveOwners(ctx2);
    const result2 = await synthesizeJudges(ctx2, owners2);

    // Should find the same JudgeModel rows (idempotent).
    const version2a = await db.judgeModelVersion.findUnique({ where: { id: result2.get(cfg1.id)!.versionId } });
    const version2b = await db.judgeModelVersion.findUnique({ where: { id: result2.get(cfg2.id)!.versionId } });
    const jm2a = await db.judgeModel.findUnique({ where: { id: version2a!.judgeModelId } });
    const jm2b = await db.judgeModel.findUnique({ where: { id: version2b!.judgeModelId } });

    expect(jm2a!.id).toBe(jm1aId);
    expect(jm2b!.id).toBe(jm1bId);

    // Second run should skip both JudgeModels (no new creates).
    expect(ctx2.report.counts().JudgeModel).toMatchObject({ created: 0, skipped: 2 });
  });
});
