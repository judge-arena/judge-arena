import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { getServerSession } from 'next-auth';
import { db, truncateAll, mkUser } from './helpers';
import { POST } from '@/app/api/models/route';

// `llamacpp` has been a real `ServingBackend` in prisma/schema.prisma and a
// fully-wired provider descriptor (src/lib/llm/registry.ts, verified against
// the live server at 192.168.1.164:8001) since Task 11 — but the ONLY runtime
// path that mints new catalog entries, `POST /api/models` with
// `mode: 'custom'`, validated `servingBackend` against a hand-maintained
// literal tuple that predated the descriptor. So the backend the product
// dogfoods on was unreachable from the product: every attempt to add one came
// back 400 "Validation failed" from zod, never reaching Prisma. That is the
// regression this file pins — an allow-list that drifts from the enum it is
// supposed to mirror fails CLOSED and silently, which is exactly the shape of
// bug a green suite hides.
//
// Same "drive the real route handler against the live test DB with next-auth
// mocked" pattern as tests/db/model-endpoint-crud.test.ts.

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

function jsonRequest(url: string, method: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  return new Request(url, init);
}

const LLAMACPP_PAYLOAD = {
  mode: 'custom',
  name: 'Qwen3.6-35B-A3B (llama.cpp)',
  judgeClass: 'prompted_open_weight',
  scoringMechanism: 'critique_generative',
  servingBackend: 'llamacpp',
  baseModel: 'Qwen3.6-35B-A3B',
  endpoint: 'http://192.168.1.164:8001/v1',
  isActive: true,
};

describe('POST /api/models — llamacpp is selectable (write-path allow-list)', () => {
  beforeEach(async () => {
    await truncateAll();
    (getServerSession as unknown as Mock).mockReset();
  });

  it("mode: custom with servingBackend 'llamacpp' is ACCEPTED and creates JudgeModel + Version + ModelEndpoint", async () => {
    const user = await mkUser();
    mockSessionFor(user);

    const res = await POST(jsonRequest('http://localhost/api/models', 'POST', LLAMACPP_PAYLOAD));

    // Assert on the BODY before the status. When the allow-list is missing
    // llamacpp this is `{ error: 'Validation failed', details: [...] }` with
    // a zod invalid_enum_value on `servingBackend` — naming it here means the
    // failure output states the actual bug rather than "expected 400 to be
    // 201", which could equally be auth, FK or serialisation.
    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(res.status).toBe(201);

    expect(body.servingBackend).toBe('llamacpp');
    expect(body.baseModel).toBe('Qwen3.6-35B-A3B');
    expect(body.ordinal).toBe(1);

    const judgeModel = await db.judgeModel.findUniqueOrThrow({ where: { id: body.judgeModelId } });
    expect(judgeModel).toMatchObject({
      name: 'Qwen3.6-35B-A3B (llama.cpp)',
      judgeClass: 'prompted_open_weight',
      scoringMechanism: 'critique_generative',
      baseModel: 'Qwen3.6-35B-A3B',
    });

    // The enum value must survive the round-trip to Postgres, not just zod:
    // `ServingBackend` is a native PG enum, so a value zod admits but the
    // database does not would fail here and nowhere else.
    const version = await db.judgeModelVersion.findUniqueOrThrow({ where: { id: body.judgeModelVersionId } });
    expect(version).toMatchObject({
      judgeModelId: judgeModel.id,
      ordinal: 1,
      servingBackend: 'llamacpp',
    });

    const endpoint = await db.modelEndpoint.findUniqueOrThrow({ where: { id: body.id } });
    expect(endpoint.userId).toBe(user.id);
    expect(endpoint.judgeModelVersionId).toBe(version.id);
    expect(endpoint.endpoint).toBe('http://192.168.1.164:8001/v1');
  });

  it('still rejects a servingBackend that is not in the ServingBackend enum', async () => {
    // The fix must widen the allow-list, not delete it: `z.enum` is what keeps
    // an arbitrary string out of a native-PG-enum column, where it would
    // surface as a raw Prisma 500 instead of a 400.
    const user = await mkUser();
    mockSessionFor(user);

    const res = await POST(
      jsonRequest('http://localhost/api/models', 'POST', { ...LLAMACPP_PAYLOAD, servingBackend: 'llamacpp-turbo' })
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'Validation failed' });
    expect(await db.judgeModel.count()).toBe(0);
  });
});
