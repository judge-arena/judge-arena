import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { getServerSession } from 'next-auth';
import { db, truncateAll, mkUser } from './helpers';
import { GET, POST } from '@/app/api/models/route';
import { GET as getCatalog } from '@/app/api/models/catalog/route';
import { PATCH, DELETE } from '@/app/api/models/[id]/route';
import { POST as postVerify } from '@/app/api/models/[id]/verify/route';

// Task 12 — /api/models becomes JudgeModel catalog + ModelEndpoint CRUD.
// Same "call the real route handler directly against a live test DB, mock
// next-auth for the session" pattern as tests/db/dataset-version-samples.test.ts.

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(),
}));
vi.mock('next/headers', () => ({
  headers: vi.fn(async () => new Headers()),
}));

// The verify route dispatches through registry.ts's execute() -> the real
// backend modules — mock those (same pattern as tests/lib/registry.test.ts/
// verify.test.ts) so "verify persists archFingerprint" is testable without
// a live LLM provider call.
const { callAnthropicMock } = vi.hoisted(() => ({ callAnthropicMock: vi.fn() }));
vi.mock('@/lib/llm/anthropic', () => ({ callAnthropic: callAnthropicMock }));

function mockSessionFor(user: { id: string; email: string }) {
  (getServerSession as unknown as Mock).mockResolvedValue({
    user: { id: user.id, email: user.email },
  });
}

function jsonRequest(url: string, method: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  return new Request(url, init);
}

/** Direct-DB fixture — a catalog JudgeModel + JudgeModelVersion (ordinal 1),
 * mirroring what `POST /api/models` (mode: 'custom') would create, for
 * tests that need an EXISTING catalog entry to select from (mode: 'catalog'). */
async function mkCatalogVersion(overrides: { slug?: string; servingBackend?: 'anthropic' | 'openai' } = {}) {
  const judgeModel = await db.judgeModel.create({
    data: {
      name: 'Fixture Judge',
      slug: overrides.slug ?? `fixture-judge-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      judgeClass: 'prompted_api',
      scoringMechanism: 'critique_generative',
      baseModel: 'fixture-base-model',
    },
  });
  const version = await db.judgeModelVersion.create({
    data: {
      judgeModelId: judgeModel.id,
      ordinal: 1,
      servingBackend: overrides.servingBackend ?? 'anthropic',
      protocolSupport: { pointwise: ['score'] },
    },
  });
  return { judgeModel, version };
}

describe('/api/models — ModelEndpoint CRUD + catalog (Task 12)', () => {
  beforeEach(async () => {
    await truncateAll();
    (getServerSession as unknown as Mock).mockReset();
    callAnthropicMock.mockReset();
  });

  describe('GET /api/models/catalog', () => {
    it('lists non-retired JudgeModelVersions with their JudgeModel joined, excludes retired entries', async () => {
      const user = await mkUser();
      mockSessionFor(user);
      const { judgeModel, version } = await mkCatalogVersion({ slug: 'catalog-alpha' });
      const retired = await mkCatalogVersion({ slug: 'catalog-retired' });
      await db.judgeModel.update({ where: { id: retired.judgeModel.id }, data: { retiredAt: new Date() } });

      const res = await getCatalog();
      expect(res.status).toBe(200);
      const body = await res.json();
      const ids = body.map((c: any) => c.judgeModelVersionId);
      expect(ids).toContain(version.id);
      expect(ids).not.toContain(retired.version.id);

      const entry = body.find((c: any) => c.judgeModelVersionId === version.id);
      expect(entry).toMatchObject({
        judgeModelId: judgeModel.id,
        ordinal: 1,
        servingBackend: 'anthropic',
        name: 'Fixture Judge',
        slug: 'catalog-alpha',
      });
    });
  });

  describe('POST /api/models — create an endpoint for an existing catalog version', () => {
    it('mode: catalog creates ONLY a ModelEndpoint (no new JudgeModel/JudgeModelVersion), sanitized response (no apiKeyEnc)', async () => {
      const user = await mkUser();
      mockSessionFor(user);
      const { version } = await mkCatalogVersion({ slug: 'catalog-select-me' });

      const beforeModels = await db.judgeModel.count();
      const beforeVersions = await db.judgeModelVersion.count();

      const res = await POST(
        jsonRequest('http://localhost/api/models', 'POST', {
          mode: 'catalog',
          judgeModelVersionId: version.id,
          apiKey: 'sk-fixture-secret',
          isActive: true,
        })
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.judgeModelVersionId).toBe(version.id);
      expect(body.hasApiKey).toBe(true);
      expect(body.apiKeyEnc).toBeUndefined();
      expect(body.apiKey).toBeUndefined();
      expect(body.userId).toBe(user.id);
      expect(body.isVerified).toBe(false); // verifiedAt starts null

      expect(await db.judgeModel.count()).toBe(beforeModels); // no new catalog entry
      expect(await db.judgeModelVersion.count()).toBe(beforeVersions);

      const endpoint = await db.modelEndpoint.findUniqueOrThrow({ where: { id: body.id } });
      expect(endpoint.judgeModelVersionId).toBe(version.id);
      expect(endpoint.userId).toBe(user.id);
      // Stored encrypted, never plaintext.
      expect(endpoint.apiKeyEnc).not.toBe('sk-fixture-secret');
      expect(endpoint.apiKeyEnc).toMatch(/^enc:v1:/);
    });

    it('rejects a retired judge model version', async () => {
      const user = await mkUser();
      mockSessionFor(user);
      const { version, judgeModel } = await mkCatalogVersion({ slug: 'catalog-retired-post' });
      await db.judgeModel.update({ where: { id: judgeModel.id }, data: { retiredAt: new Date() } });

      const res = await POST(
        jsonRequest('http://localhost/api/models', 'POST', { mode: 'catalog', judgeModelVersionId: version.id })
      );
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/models — add a custom model', () => {
    it('mode: custom creates a NEW JudgeModel + JudgeModelVersion (ordinal 1) + the user\'s ModelEndpoint', async () => {
      const user = await mkUser();
      mockSessionFor(user);

      const res = await POST(
        jsonRequest('http://localhost/api/models', 'POST', {
          mode: 'custom',
          name: 'My Custom Judge',
          judgeClass: 'prompted_open_weight',
          scoringMechanism: 'token_probability',
          servingBackend: 'vllm',
          baseModel: 'meta-llama/Llama-3-70b-Instruct',
          endpoint: 'http://localhost:8000/v1',
          isActive: true,
        })
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe('My Custom Judge');
      expect(body.servingBackend).toBe('vllm');
      expect(body.baseModel).toBe('meta-llama/Llama-3-70b-Instruct');
      expect(body.ordinal).toBe(1);

      const judgeModel = await db.judgeModel.findUniqueOrThrow({ where: { id: body.judgeModelId } });
      expect(judgeModel).toMatchObject({
        judgeClass: 'prompted_open_weight',
        scoringMechanism: 'token_probability',
        baseModel: 'meta-llama/Llama-3-70b-Instruct',
      });

      const version = await db.judgeModelVersion.findUniqueOrThrow({ where: { id: body.judgeModelVersionId } });
      expect(version).toMatchObject({ judgeModelId: judgeModel.id, ordinal: 1, servingBackend: 'vllm' });

      const endpoint = await db.modelEndpoint.findUniqueOrThrow({ where: { id: body.id } });
      expect(endpoint.userId).toBe(user.id);
      expect(endpoint.judgeModelVersionId).toBe(version.id);
    });

    it('two custom-model POSTs with the same name get distinct JudgeModel slugs (no P2002)', async () => {
      const user = await mkUser();
      mockSessionFor(user);
      const payload = {
        mode: 'custom',
        name: 'Duplicate Name Judge',
        judgeClass: 'prompted_api',
        scoringMechanism: 'critique_generative',
        servingBackend: 'openai',
        baseModel: 'gpt-4o',
      };

      const first = await POST(jsonRequest('http://localhost/api/models', 'POST', payload));
      const second = await POST(jsonRequest('http://localhost/api/models', 'POST', payload));

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      const firstBody = await first.json();
      const secondBody = await second.json();
      expect(firstBody.judgeModelId).not.toBe(secondBody.judgeModelId);
      expect(firstBody.slug).not.toBe(secondBody.slug);
    });
  });

  describe('GET /api/models — own endpoints only, catalog-joined', () => {
    it('returns only the calling user\'s ModelEndpoints, joined to JudgeModelVersion/JudgeModel', async () => {
      const userA = await mkUser();
      const userB = await mkUser();
      const { version } = await mkCatalogVersion({ slug: 'catalog-shared' });
      await db.modelEndpoint.create({ data: { userId: userA.id, judgeModelVersionId: version.id } });
      await db.modelEndpoint.create({ data: { userId: userB.id, judgeModelVersionId: version.id } });

      mockSessionFor(userA);
      const res = await GET();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].userId).toBe(userA.id);
      expect(body[0].judgeModelVersionId).toBe(version.id);
    });
  });

  describe('PATCH /api/models/[id] — connection-only edit', () => {
    it('toggles isActive without touching the catalog identity', async () => {
      const user = await mkUser();
      mockSessionFor(user);
      const { version } = await mkCatalogVersion({ slug: 'catalog-patch' });
      const endpoint = await db.modelEndpoint.create({
        data: { userId: user.id, judgeModelVersionId: version.id, isActive: true },
      });

      const res = await PATCH(
        jsonRequest(`http://localhost/api/models/${endpoint.id}`, 'PATCH', { isActive: false }),
        { params: Promise.resolve({ id: endpoint.id }) }
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.isActive).toBe(false);
      expect(body.judgeModelVersionId).toBe(version.id); // identity unchanged
    });

    it('rotating the endpoint/apiKey resets verifiedAt + verificationError + archFingerprint', async () => {
      const user = await mkUser();
      mockSessionFor(user);
      const { version } = await mkCatalogVersion({ slug: 'catalog-rotate' });
      const endpoint = await db.modelEndpoint.create({
        data: {
          userId: user.id,
          judgeModelVersionId: version.id,
          verifiedAt: new Date(),
          archFingerprint: { servedModelId: 'stale' },
        },
      });

      const res = await PATCH(
        jsonRequest(`http://localhost/api/models/${endpoint.id}`, 'PATCH', { apiKey: 'new-secret' }),
        { params: Promise.resolve({ id: endpoint.id }) }
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.isVerified).toBe(false);
      expect(body.verificationError).toMatch(/changed/i);
      expect(body.archFingerprint).toBeNull();
    });

    it('a non-owner PATCH is forbidden (403)', async () => {
      const owner = await mkUser();
      const attacker = await mkUser();
      const { version } = await mkCatalogVersion({ slug: 'catalog-forbidden-patch' });
      const endpoint = await db.modelEndpoint.create({ data: { userId: owner.id, judgeModelVersionId: version.id } });

      mockSessionFor(attacker);
      const res = await PATCH(
        jsonRequest(`http://localhost/api/models/${endpoint.id}`, 'PATCH', { isActive: false }),
        { params: Promise.resolve({ id: endpoint.id }) }
      );
      expect(res.status).toBe(403);
    });
  });

  describe('DELETE /api/models/[id]', () => {
    it('deletes the endpoint but leaves the catalog JudgeModel/JudgeModelVersion untouched', async () => {
      const user = await mkUser();
      mockSessionFor(user);
      const { version, judgeModel } = await mkCatalogVersion({ slug: 'catalog-delete' });
      const endpoint = await db.modelEndpoint.create({ data: { userId: user.id, judgeModelVersionId: version.id } });

      const res = await DELETE(
        jsonRequest(`http://localhost/api/models/${endpoint.id}`, 'DELETE'),
        { params: Promise.resolve({ id: endpoint.id }) }
      );
      expect(res.status).toBe(200);

      expect(await db.modelEndpoint.findUnique({ where: { id: endpoint.id } })).toBeNull();
      expect(await db.judgeModelVersion.findUnique({ where: { id: version.id } })).not.toBeNull();
      expect(await db.judgeModel.findUnique({ where: { id: judgeModel.id } })).not.toBeNull();
    });

    it('a non-owner DELETE is forbidden (403) and the row survives', async () => {
      const owner = await mkUser();
      const attacker = await mkUser();
      const { version } = await mkCatalogVersion({ slug: 'catalog-forbidden-delete' });
      const endpoint = await db.modelEndpoint.create({ data: { userId: owner.id, judgeModelVersionId: version.id } });

      mockSessionFor(attacker);
      const res = await DELETE(
        jsonRequest(`http://localhost/api/models/${endpoint.id}`, 'DELETE'),
        { params: Promise.resolve({ id: endpoint.id }) }
      );
      expect(res.status).toBe(403);
      expect(await db.modelEndpoint.findUnique({ where: { id: endpoint.id } })).not.toBeNull();
    });
  });

  describe('POST /api/models/[id]/verify — Task 10 carry closed: persists archFingerprint', () => {
    it('a successful verification persists archFingerprint + verifiedAt onto the ModelEndpoint', async () => {
      const user = await mkUser();
      mockSessionFor(user);
      const { version } = await mkCatalogVersion({ slug: 'catalog-verify-ok', servingBackend: 'anthropic' });
      const endpoint = await db.modelEndpoint.create({
        data: { userId: user.id, judgeModelVersionId: version.id, apiKeyEnc: 'sk-plaintext-fixture-key' },
      });

      callAnthropicMock.mockResolvedValue({ text: 'ok', servedModelId: 'fixture-served-model', latencyMs: 3 });

      const res = await postVerify(
        jsonRequest(`http://localhost/api/models/${endpoint.id}/verify`, 'POST'),
        { params: Promise.resolve({ id: endpoint.id }) }
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.isVerified).toBe(true);
      expect(body.archFingerprint).toEqual({ servedModelId: 'fixture-served-model' });

      const persisted = await db.modelEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } });
      expect(persisted.verifiedAt).not.toBeNull();
      expect(persisted.verificationError).toBeNull();
      expect(persisted.archFingerprint).toEqual({ servedModelId: 'fixture-served-model' });

      // The stored key was plaintext-tagged-as-fixture in this test, but
      // the route must have gone through decryptSafe before calling out —
      // assert the call received it, not ciphertext.
      expect(callAnthropicMock).toHaveBeenCalledTimes(1);
      expect(callAnthropicMock.mock.calls[0][0].apiKey).toBe('sk-plaintext-fixture-key');
    });

    it('a failed verification persists verificationError and clears verifiedAt, without touching archFingerprint on success paths since none is returned', async () => {
      const user = await mkUser();
      mockSessionFor(user);
      const { version } = await mkCatalogVersion({ slug: 'catalog-verify-fail', servingBackend: 'anthropic' });
      const endpoint = await db.modelEndpoint.create({
        data: { userId: user.id, judgeModelVersionId: version.id, apiKeyEnc: 'sk-plaintext-fixture-key' },
      });

      callAnthropicMock.mockRejectedValue(new Error('simulated provider auth failure'));

      const res = await postVerify(
        jsonRequest(`http://localhost/api/models/${endpoint.id}/verify`, 'POST'),
        { params: Promise.resolve({ id: endpoint.id }) }
      );

      expect(res.status).toBe(400);
      const persisted = await db.modelEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } });
      expect(persisted.verifiedAt).toBeNull();
      expect(persisted.verificationError).toContain('simulated provider auth failure');
    });

    it('refuses (400) when the JudgeModel has no baseModel configured, before attempting any call', async () => {
      const user = await mkUser();
      mockSessionFor(user);
      const judgeModel = await db.judgeModel.create({
        data: {
          name: 'No Base Model Judge',
          slug: 'catalog-verify-no-basemodel',
          judgeClass: 'prompted_api',
          scoringMechanism: 'critique_generative',
          // baseModel intentionally omitted
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
      const endpoint = await db.modelEndpoint.create({ data: { userId: user.id, judgeModelVersionId: version.id } });

      const res = await postVerify(
        jsonRequest(`http://localhost/api/models/${endpoint.id}/verify`, 'POST'),
        { params: Promise.resolve({ id: endpoint.id }) }
      );
      expect(res.status).toBe(400);
      expect(callAnthropicMock).not.toHaveBeenCalled();
    });
  });
});
