import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { getServerSession } from 'next-auth';
import { headers } from 'next/headers';
import { createHash } from 'crypto';
import { db, truncateAll, mkUser, mkRubric } from './helpers';

import { GET as getLeaderboard } from '@/app/api/leaderboard/route';

import { GET as listRubrics, POST as createRubricRoute } from '@/app/api/rubrics/route';
import { GET as getRubric, PATCH as patchRubric, DELETE as deleteRubric } from '@/app/api/rubrics/[id]/route';

import { GET as listDatasets, POST as createDatasetRoute } from '@/app/api/datasets/route';
import { GET as getDataset, PATCH as patchDataset, DELETE as deleteDataset } from '@/app/api/datasets/[id]/route';

import { GET as listProjects, POST as createProjectRoute } from '@/app/api/projects/route';
import { GET as getProject, PATCH as patchProject, DELETE as deleteProject } from '@/app/api/projects/[id]/route';

import { GET as getEvaluation, PATCH as patchEvaluation, DELETE as deleteEvaluation } from '@/app/api/evaluations/[id]/route';

import { GET as getModelEndpoint, PATCH as patchModelEndpoint, DELETE as deleteModelEndpoint } from '@/app/api/models/[id]/route';

import {
  GET as listApiKeys,
  POST as createApiKeyRoute,
} from '@/app/api/api-keys/route';
import {
  GET as getApiKey,
  PATCH as patchApiKeyRoute,
  DELETE as deleteApiKeyRoute,
} from '@/app/api/api-keys/[id]/route';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE ACCESS MATRIX (Task 14, spec §7 + D3)
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Model: PUBLIC research data (visibility: 'public' rubrics/datasets/
 * projects, the leaderboard) defaults to open READS. ALL writes, and
 * every resource WITHOUT a visibility concept (Evaluation, ModelEndpoint
 * — user-created/uploaded data), are fully GATED: ownership on every
 * mutation, no anonymous access at all.
 *
 * Real route handlers are invoked directly against a live test DB (same
 * "call the real handler, mock next-auth for the session" pattern as
 * tests/db/model-endpoint-crud.test.ts); this file's ACCESS_MATRIX table
 * below, plus the registry that dispatches each row to the real handler,
 * IS the documentation for the matrix — see the task-14-report.md summary
 * for the prose version.
 *
 * Actors:
 *   - anonymous: no session at all (optionalAuth() returns null /
 *     requireAuth() 401s)
 *   - stranger:  a signed-in user who does NOT own the target resource
 *   - owner:     the resource's actual owner
 *   - admin:     a signed-in admin (role: 'admin') who does not own it
 *
 * API keys (privilege-escalation / interactive-session requirement) and
 * PII-stripping / ownerless-create-IDOR assertions live in their own
 * `describe` blocks below the generated matrix — they need actor shapes
 * (Bearer API keys, response-body inspection) the generic status-only
 * table isn't set up for.
 */

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(),
}));
vi.mock('next/headers', () => ({
  headers: vi.fn(async () => new Headers()),
}));
// The shared requireAuth() rate-limit chokepoint (src/lib/auth-guard.ts)
// hits a real Redis-backed sliding window keyed by client IP (always
// '127.0.0.1' in this test env — see src/lib/client-ip.ts). That window is
// SHARED across every tests/db/**/*.test.ts file in one `npm run test:db`
// run (fileParallelism: false => one process, one Redis connection) — this
// file alone drives ~90 requireAuth() calls, which would risk tripping the
// real 120/min limit and failing tests on rate-limiting, not the
// authorization logic under test. Fake the limiter to always admit, the
// same pattern rate-limit.ts's module doc calls out ("so code that wants
// to fake a limiter in a test... has a type to implement").
vi.mock('@/lib/rate-limit-redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rate-limit-redis')>();
  return {
    ...actual,
    apiLimiter: { check: async () => ({ ok: true, remaining: 999, resetAt: Date.now() + 60_000 }) },
  };
});

type Actor = 'anonymous' | 'stranger' | 'owner' | 'admin';
type Visibility = 'private' | 'public';

interface Ctx {
  ownerId: string;
  strangerId: string;
  adminId: string;
}

function setSessionFor(actor: Actor, ctx: Ctx) {
  if (actor === 'anonymous') {
    (getServerSession as unknown as Mock).mockResolvedValue(null);
    return;
  }
  const userId = actor === 'owner' ? ctx.ownerId : actor === 'admin' ? ctx.adminId : ctx.strangerId;
  (getServerSession as unknown as Mock).mockResolvedValue({ user: { id: userId } });
}

function jsonRequest(url: string, method: string, body?: unknown): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  return new Request(url, init);
}

// ─── Fixture helpers (Dataset/Project/Evaluation/ModelEndpoint have no
// mk* helper in ./helpers.ts today — mkUser/mkRubric do) ───────────────────

let counter = 0;
function uniq(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

async function mkDataset(userId: string, visibility: Visibility = 'private') {
  return db.dataset.create({ data: { name: uniq('fixture-dataset'), userId, visibility } });
}

async function mkProject(userId: string, visibility: Visibility = 'private') {
  return db.project.create({ data: { name: uniq('fixture-project'), userId, visibility } });
}

async function mkEvaluation(userId: string) {
  const project = await mkProject(userId);
  return db.evaluation.create({ data: { userId, projectId: project.id, inputText: 'fixture input' } });
}

async function mkCatalogVersion() {
  const judgeModel = await db.judgeModel.create({
    data: {
      name: 'Fixture Judge',
      slug: uniq('fixture-judge'),
      judgeClass: 'prompted_api',
      scoringMechanism: 'critique_generative',
      baseModel: 'fixture-base-model',
    },
  });
  return db.judgeModelVersion.create({
    data: {
      judgeModelId: judgeModel.id,
      ordinal: 1,
      servingBackend: 'anthropic',
      protocolSupport: { pointwise: ['score'] },
    },
  });
}

async function mkModelEndpoint(userId: string) {
  const version = await mkCatalogVersion();
  return db.modelEndpoint.create({ data: { userId, judgeModelVersionId: version.id } });
}

// ─── Per-resource dispatch registry — routes a matrix row to the real
// handler for that resource ──────────────────────────────────────────────

interface ResourceHandlers {
  createTarget: (ctx: Ctx, visibility: Visibility) => Promise<{ id: string }>;
  get: (id: string) => Promise<Response>;
  patch: (id: string) => Promise<Response>;
  del: (id: string) => Promise<Response>;
}

const registry: Record<'rubric' | 'dataset' | 'project' | 'evaluation' | 'modelEndpoint', ResourceHandlers> = {
  rubric: {
    createTarget: (ctx, visibility) => mkRubric(ctx.ownerId, { visibility }),
    get: (id) => getRubric(new Request(`http://localhost/api/rubrics/${id}`), { params: Promise.resolve({ id }) }),
    patch: (id) =>
      patchRubric(jsonRequest(`http://localhost/api/rubrics/${id}`, 'PATCH', {}), {
        params: Promise.resolve({ id }),
      }),
    del: (id) =>
      deleteRubric(new Request(`http://localhost/api/rubrics/${id}`, { method: 'DELETE' }), {
        params: Promise.resolve({ id }),
      }),
  },
  dataset: {
    createTarget: (ctx, visibility) => mkDataset(ctx.ownerId, visibility),
    get: (id) => getDataset(new Request(`http://localhost/api/datasets/${id}`), { params: Promise.resolve({ id }) }),
    patch: (id) =>
      patchDataset(jsonRequest(`http://localhost/api/datasets/${id}`, 'PATCH', {}), {
        params: Promise.resolve({ id }),
      }),
    del: (id) =>
      deleteDataset(new Request(`http://localhost/api/datasets/${id}`, { method: 'DELETE' }), {
        params: Promise.resolve({ id }),
      }),
  },
  project: {
    createTarget: (ctx, visibility) => mkProject(ctx.ownerId, visibility),
    get: (id) => getProject(new Request(`http://localhost/api/projects/${id}`), { params: Promise.resolve({ id }) }),
    patch: (id) =>
      patchProject(jsonRequest(`http://localhost/api/projects/${id}`, 'PATCH', {}), {
        params: Promise.resolve({ id }),
      }),
    del: (id) =>
      deleteProject(new Request(`http://localhost/api/projects/${id}`, { method: 'DELETE' }), {
        params: Promise.resolve({ id }),
      }),
  },
  evaluation: {
    // Evaluation has no visibility field at all (never public — spec §7
    // D3: user-created data is always gated) — the `visibility` param is
    // accepted for a uniform registry shape but ignored.
    createTarget: (ctx) => mkEvaluation(ctx.ownerId),
    get: (id) =>
      getEvaluation(new Request(`http://localhost/api/evaluations/${id}`), { params: Promise.resolve({ id }) }),
    patch: (id) =>
      patchEvaluation(jsonRequest(`http://localhost/api/evaluations/${id}`, 'PATCH', {}), {
        params: Promise.resolve({ id }),
      }),
    del: (id) =>
      deleteEvaluation(new Request(`http://localhost/api/evaluations/${id}`, { method: 'DELETE' }), {
        params: Promise.resolve({ id }),
      }),
  },
  modelEndpoint: {
    // ModelEndpoint carries per-user credentials (apiKeyEnc) — never
    // public, regardless of any future visibility concept elsewhere.
    createTarget: (ctx) => mkModelEndpoint(ctx.ownerId),
    get: (id) => getModelEndpoint(new Request(`http://localhost/api/models/${id}`), { params: Promise.resolve({ id }) }),
    patch: (id) =>
      patchModelEndpoint(jsonRequest(`http://localhost/api/models/${id}`, 'PATCH', {}), {
        params: Promise.resolve({ id }),
      }),
    del: (id) =>
      deleteModelEndpoint(new Request(`http://localhost/api/models/${id}`, { method: 'DELETE' }), {
        params: Promise.resolve({ id }),
      }),
  },
};

interface MatrixRow {
  resource: keyof typeof registry;
  method: 'GET' | 'PATCH' | 'DELETE';
  visibility: Visibility; // ignored by evaluation/modelEndpoint (never public)
  actor: Actor;
  expected: number;
}

// ═══════════════════ THE TABLE ═══════════════════
// prettier-ignore
const ACCESS_MATRIX: MatrixRow[] = [
  // ── Rubric ── (GET can be public; every mutation is gated regardless)
  { resource: 'rubric', method: 'GET',    visibility: 'private', actor: 'anonymous', expected: 401 },
  { resource: 'rubric', method: 'GET',    visibility: 'private', actor: 'stranger',  expected: 403 },
  { resource: 'rubric', method: 'GET',    visibility: 'private', actor: 'owner',     expected: 200 },
  { resource: 'rubric', method: 'GET',    visibility: 'private', actor: 'admin',     expected: 200 },
  { resource: 'rubric', method: 'GET',    visibility: 'public',  actor: 'anonymous', expected: 200 },
  { resource: 'rubric', method: 'GET',    visibility: 'public',  actor: 'stranger',  expected: 200 },
  { resource: 'rubric', method: 'GET',    visibility: 'public',  actor: 'owner',     expected: 200 },
  { resource: 'rubric', method: 'GET',    visibility: 'public',  actor: 'admin',     expected: 200 },
  { resource: 'rubric', method: 'PATCH',  visibility: 'private', actor: 'anonymous', expected: 401 },
  { resource: 'rubric', method: 'PATCH',  visibility: 'private', actor: 'stranger',  expected: 403 },
  { resource: 'rubric', method: 'PATCH',  visibility: 'private', actor: 'owner',     expected: 200 },
  { resource: 'rubric', method: 'PATCH',  visibility: 'private', actor: 'admin',     expected: 200 },
  { resource: 'rubric', method: 'PATCH',  visibility: 'public',  actor: 'anonymous', expected: 401 },
  { resource: 'rubric', method: 'PATCH',  visibility: 'public',  actor: 'stranger',  expected: 403 },
  { resource: 'rubric', method: 'DELETE', visibility: 'private', actor: 'anonymous', expected: 401 },
  { resource: 'rubric', method: 'DELETE', visibility: 'private', actor: 'stranger',  expected: 403 },
  { resource: 'rubric', method: 'DELETE', visibility: 'private', actor: 'owner',     expected: 200 },
  { resource: 'rubric', method: 'DELETE', visibility: 'private', actor: 'admin',     expected: 200 },
  { resource: 'rubric', method: 'DELETE', visibility: 'public',  actor: 'anonymous', expected: 401 },
  { resource: 'rubric', method: 'DELETE', visibility: 'public',  actor: 'stranger',  expected: 403 },

  // ── Dataset ── (the T14 critique's named PII-leak resource — full coverage)
  { resource: 'dataset', method: 'GET',    visibility: 'private', actor: 'anonymous', expected: 401 },
  { resource: 'dataset', method: 'GET',    visibility: 'private', actor: 'stranger',  expected: 403 },
  { resource: 'dataset', method: 'GET',    visibility: 'private', actor: 'owner',     expected: 200 },
  { resource: 'dataset', method: 'GET',    visibility: 'private', actor: 'admin',     expected: 200 },
  { resource: 'dataset', method: 'GET',    visibility: 'public',  actor: 'anonymous', expected: 200 },
  { resource: 'dataset', method: 'GET',    visibility: 'public',  actor: 'stranger',  expected: 200 },
  { resource: 'dataset', method: 'GET',    visibility: 'public',  actor: 'owner',     expected: 200 },
  { resource: 'dataset', method: 'GET',    visibility: 'public',  actor: 'admin',     expected: 200 },
  { resource: 'dataset', method: 'PATCH',  visibility: 'private', actor: 'anonymous', expected: 401 },
  { resource: 'dataset', method: 'PATCH',  visibility: 'private', actor: 'stranger',  expected: 403 },
  { resource: 'dataset', method: 'PATCH',  visibility: 'private', actor: 'owner',     expected: 200 },
  { resource: 'dataset', method: 'PATCH',  visibility: 'private', actor: 'admin',     expected: 200 },
  { resource: 'dataset', method: 'PATCH',  visibility: 'public',  actor: 'anonymous', expected: 401 },
  { resource: 'dataset', method: 'PATCH',  visibility: 'public',  actor: 'stranger',  expected: 403 },
  { resource: 'dataset', method: 'PATCH',  visibility: 'public',  actor: 'owner',     expected: 200 },
  { resource: 'dataset', method: 'PATCH',  visibility: 'public',  actor: 'admin',     expected: 200 },
  { resource: 'dataset', method: 'DELETE', visibility: 'private', actor: 'anonymous', expected: 401 },
  { resource: 'dataset', method: 'DELETE', visibility: 'private', actor: 'stranger',  expected: 403 },
  { resource: 'dataset', method: 'DELETE', visibility: 'private', actor: 'owner',     expected: 200 },
  { resource: 'dataset', method: 'DELETE', visibility: 'private', actor: 'admin',     expected: 200 },
  { resource: 'dataset', method: 'DELETE', visibility: 'public',  actor: 'anonymous', expected: 401 },
  { resource: 'dataset', method: 'DELETE', visibility: 'public',  actor: 'stranger',  expected: 403 },
  { resource: 'dataset', method: 'DELETE', visibility: 'public',  actor: 'owner',     expected: 200 },
  { resource: 'dataset', method: 'DELETE', visibility: 'public',  actor: 'admin',     expected: 200 },

  // ── Project ──
  { resource: 'project', method: 'GET',    visibility: 'private', actor: 'anonymous', expected: 401 },
  { resource: 'project', method: 'GET',    visibility: 'private', actor: 'stranger',  expected: 403 },
  { resource: 'project', method: 'GET',    visibility: 'private', actor: 'owner',     expected: 200 },
  { resource: 'project', method: 'GET',    visibility: 'private', actor: 'admin',     expected: 200 },
  { resource: 'project', method: 'GET',    visibility: 'public',  actor: 'anonymous', expected: 200 },
  { resource: 'project', method: 'GET',    visibility: 'public',  actor: 'stranger',  expected: 200 },
  { resource: 'project', method: 'GET',    visibility: 'public',  actor: 'owner',     expected: 200 },
  { resource: 'project', method: 'GET',    visibility: 'public',  actor: 'admin',     expected: 200 },
  { resource: 'project', method: 'PATCH',  visibility: 'private', actor: 'anonymous', expected: 401 },
  { resource: 'project', method: 'PATCH',  visibility: 'private', actor: 'stranger',  expected: 403 },
  { resource: 'project', method: 'PATCH',  visibility: 'private', actor: 'owner',     expected: 200 },
  { resource: 'project', method: 'PATCH',  visibility: 'private', actor: 'admin',     expected: 200 },
  { resource: 'project', method: 'PATCH',  visibility: 'public',  actor: 'anonymous', expected: 401 },
  { resource: 'project', method: 'PATCH',  visibility: 'public',  actor: 'stranger',  expected: 403 },
  { resource: 'project', method: 'DELETE', visibility: 'private', actor: 'anonymous', expected: 401 },
  { resource: 'project', method: 'DELETE', visibility: 'private', actor: 'stranger',  expected: 403 },
  { resource: 'project', method: 'DELETE', visibility: 'private', actor: 'owner',     expected: 200 },
  { resource: 'project', method: 'DELETE', visibility: 'private', actor: 'admin',     expected: 200 },
  { resource: 'project', method: 'DELETE', visibility: 'public',  actor: 'anonymous', expected: 401 },
  { resource: 'project', method: 'DELETE', visibility: 'public',  actor: 'stranger',  expected: 403 },

  // ── Evaluation ── (never public — user-created data, spec §7 D3)
  { resource: 'evaluation', method: 'GET',    visibility: 'private', actor: 'anonymous', expected: 401 },
  { resource: 'evaluation', method: 'GET',    visibility: 'private', actor: 'stranger',  expected: 403 },
  { resource: 'evaluation', method: 'GET',    visibility: 'private', actor: 'owner',     expected: 200 },
  { resource: 'evaluation', method: 'GET',    visibility: 'private', actor: 'admin',     expected: 200 },
  { resource: 'evaluation', method: 'PATCH',  visibility: 'private', actor: 'stranger',  expected: 403 },
  { resource: 'evaluation', method: 'PATCH',  visibility: 'private', actor: 'owner',     expected: 200 },
  { resource: 'evaluation', method: 'DELETE', visibility: 'private', actor: 'stranger',  expected: 403 },
  { resource: 'evaluation', method: 'DELETE', visibility: 'private', actor: 'owner',     expected: 200 },

  // ── ModelEndpoint ── (per-user credentials — never public)
  { resource: 'modelEndpoint', method: 'GET',    visibility: 'private', actor: 'anonymous', expected: 401 },
  { resource: 'modelEndpoint', method: 'GET',    visibility: 'private', actor: 'stranger',  expected: 403 },
  { resource: 'modelEndpoint', method: 'GET',    visibility: 'private', actor: 'owner',     expected: 200 },
  { resource: 'modelEndpoint', method: 'GET',    visibility: 'private', actor: 'admin',     expected: 200 },
  { resource: 'modelEndpoint', method: 'PATCH',  visibility: 'private', actor: 'stranger',  expected: 403 },
  { resource: 'modelEndpoint', method: 'PATCH',  visibility: 'private', actor: 'owner',     expected: 200 },
  { resource: 'modelEndpoint', method: 'DELETE', visibility: 'private', actor: 'stranger',  expected: 403 },
  { resource: 'modelEndpoint', method: 'DELETE', visibility: 'private', actor: 'owner',     expected: 200 },
];

describe('Access matrix — table-driven (spec §7 D3: public reads, gated writes)', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    await truncateAll();
    (getServerSession as unknown as Mock).mockReset();
    (headers as unknown as Mock).mockReset();
    (headers as unknown as Mock).mockImplementation(async () => new Headers());
    const owner = await mkUser();
    const stranger = await mkUser();
    const admin = await mkUser({ role: 'admin' });
    ctx = { ownerId: owner.id, strangerId: stranger.id, adminId: admin.id };
  });

  for (const row of ACCESS_MATRIX) {
    it(`${row.resource} ${row.method} (${row.visibility}) as ${row.actor} -> ${row.expected}`, async () => {
      const handlers = registry[row.resource];
      const target = await handlers.createTarget(ctx, row.visibility);
      setSessionFor(row.actor, ctx);

      const res =
        row.method === 'GET' ? await handlers.get(target.id)
        : row.method === 'PATCH' ? await handlers.patch(target.id)
        : await handlers.del(target.id);

      expect(res.status).toBe(row.expected);
    });
  }

  it('sanity: GET /api/leaderboard is public with no auth at all (pre-existing, unaffected)', async () => {
    (getServerSession as unknown as Mock).mockResolvedValue(null);
    const res = await getLeaderboard();
    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// List endpoints: anonymous -> public only; authed -> public + own
// ═══════════════════════════════════════════════════════════════════════

describe('Access matrix — list endpoints (anonymous: public only; authed: own + public)', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    await truncateAll();
    (getServerSession as unknown as Mock).mockReset();
    const owner = await mkUser();
    const stranger = await mkUser();
    const admin = await mkUser({ role: 'admin' });
    ctx = { ownerId: owner.id, strangerId: stranger.id, adminId: admin.id };
  });

  it('GET /api/rubrics: anonymous sees ONLY public rubrics, never a private one from any user', async () => {
    const pub = await mkRubric(ctx.ownerId, { visibility: 'public' });
    const priv = await mkRubric(ctx.ownerId, { visibility: 'private' });

    setSessionFor('anonymous', ctx);
    const res = await listRubrics();
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.map((r: any) => r.id);
    expect(ids).toContain(pub.id);
    expect(ids).not.toContain(priv.id);
  });

  it('GET /api/rubrics: an authed stranger sees public rubrics + their OWN private ones, not the owner\'s private one', async () => {
    const ownerPublic = await mkRubric(ctx.ownerId, { visibility: 'public' });
    const ownerPrivate = await mkRubric(ctx.ownerId, { visibility: 'private' });
    const strangerPrivate = await mkRubric(ctx.strangerId, { visibility: 'private' });

    setSessionFor('stranger', ctx);
    const res = await listRubrics();
    const body = await res.json();
    const ids = body.map((r: any) => r.id);
    expect(ids).toContain(ownerPublic.id);
    expect(ids).toContain(strangerPrivate.id);
    expect(ids).not.toContain(ownerPrivate.id);
  });

  it('GET /api/datasets: anonymous sees ONLY public datasets', async () => {
    const pub = await mkDataset(ctx.ownerId, 'public');
    const priv = await mkDataset(ctx.ownerId, 'private');

    setSessionFor('anonymous', ctx);
    const res = await listDatasets(new Request('http://localhost/api/datasets'));
    const body = await res.json();
    const ids = body.data.map((d: any) => d.id);
    expect(ids).toContain(pub.id);
    expect(ids).not.toContain(priv.id);
  });

  it('GET /api/projects: anonymous sees ONLY public/default projects', async () => {
    const pub = await mkProject(ctx.ownerId, 'public');
    const priv = await mkProject(ctx.ownerId, 'private');

    setSessionFor('anonymous', ctx);
    const res = await listProjects(new Request('http://localhost/api/projects'));
    const body = await res.json();
    const ids = body.data.map((p: any) => p.id);
    expect(ids).toContain(pub.id);
    expect(ids).not.toContain(priv.id);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PII stripping: the public view NEVER carries owner email; the owner's
// OWN view still does (proving the strip is public-view-specific, not a
// blanket regression on the authenticated/owner experience).
// ═══════════════════════════════════════════════════════════════════════

describe('Access matrix — PII stripping on the public view (T14: "dataset responses embed owner email")', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    await truncateAll();
    (getServerSession as unknown as Mock).mockReset();
    const owner = await mkUser({ email: 'owner-secret-pii@test.local' });
    const stranger = await mkUser();
    const admin = await mkUser({ role: 'admin' });
    ctx = { ownerId: owner.id, strangerId: stranger.id, adminId: admin.id };
  });

  it('dataset: anonymous GET of a public dataset never contains the owner email; the owner\'s own GET does', async () => {
    const dataset = await mkDataset(ctx.ownerId, 'public');

    setSessionFor('anonymous', ctx);
    const anonRes = await getDataset(new Request(`http://localhost/api/datasets/${dataset.id}`), {
      params: Promise.resolve({ id: dataset.id }),
    });
    expect(anonRes.status).toBe(200);
    const anonText = await anonRes.text();
    expect(anonText).not.toContain('owner-secret-pii@test.local');

    setSessionFor('owner', ctx);
    const ownerRes = await getDataset(new Request(`http://localhost/api/datasets/${dataset.id}`), {
      params: Promise.resolve({ id: dataset.id }),
    });
    const ownerText = await ownerRes.text();
    expect(ownerText).toContain('owner-secret-pii@test.local');
  });

  it('dataset: a STRANGER (authed, non-owner) viewing a public dataset ALSO gets the stripped view, not the owner shape', async () => {
    const dataset = await mkDataset(ctx.ownerId, 'public');

    setSessionFor('stranger', ctx);
    const res = await getDataset(new Request(`http://localhost/api/datasets/${dataset.id}`), {
      params: Promise.resolve({ id: dataset.id }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('owner-secret-pii@test.local');
  });

  it('rubric: anonymous GET of a public rubric never contains the owner email', async () => {
    const rubric = await mkRubric(ctx.ownerId, { visibility: 'public' });

    setSessionFor('anonymous', ctx);
    const res = await getRubric(new Request(`http://localhost/api/rubrics/${rubric.id}`), {
      params: Promise.resolve({ id: rubric.id }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('owner-secret-pii@test.local');
  });

  it('project: anonymous GET of a public project never contains the owner email, and carries no evaluations array at all', async () => {
    const project = await mkProject(ctx.ownerId, 'public');

    setSessionFor('anonymous', ctx);
    const res = await getProject(new Request(`http://localhost/api/projects/${project.id}`), {
      params: Promise.resolve({ id: project.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain('owner-secret-pii@test.local');
    expect(body.evaluations).toBeUndefined();
  });

  it('dataset list: a public dataset owned by someone else never carries that owner\'s email in the list response', async () => {
    await mkDataset(ctx.ownerId, 'public');

    setSessionFor('stranger', ctx);
    const res = await listDatasets(new Request('http://localhost/api/datasets'));
    const text = await res.text();
    expect(text).not.toContain('owner-secret-pii@test.local');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Ownerless-create IDOR: POST always sets owner = the calling session
// user, never a client-supplied value.
// ═══════════════════════════════════════════════════════════════════════

describe('Access matrix — create always owns to the caller (ownerless-create IDOR)', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    await truncateAll();
    (getServerSession as unknown as Mock).mockReset();
    const owner = await mkUser();
    const stranger = await mkUser();
    const admin = await mkUser({ role: 'admin' });
    ctx = { ownerId: owner.id, strangerId: stranger.id, adminId: admin.id };
  });

  it('POST /api/rubrics ignores a spoofed userId in the body — created row belongs to the caller', async () => {
    setSessionFor('stranger', ctx);
    const res = await createRubricRoute(
      jsonRequest('http://localhost/api/rubrics', 'POST', {
        name: 'Spoof Test Rubric',
        userId: ctx.ownerId, // attacker-controlled — must be ignored
        criteria: [{ name: 'C1', description: 'desc', maxScore: 10, weight: 1 }],
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.userId).toBe(ctx.strangerId);
    expect(body.userId).not.toBe(ctx.ownerId);
  });

  it('POST /api/datasets ignores a spoofed userId in the body', async () => {
    setSessionFor('stranger', ctx);
    const res = await createDatasetRoute(
      jsonRequest('http://localhost/api/datasets', 'POST', {
        name: 'Spoof Test Dataset',
        source: 'local',
        visibility: 'private',
        userId: ctx.ownerId,
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.userId).toBe(ctx.strangerId);
  });

  it('POST /api/projects ignores a spoofed userId in the body', async () => {
    setSessionFor('stranger', ctx);
    const res = await createProjectRoute(
      jsonRequest('http://localhost/api/projects', 'POST', {
        name: 'Spoof Test Project',
        userId: ctx.ownerId,
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.userId).toBe(ctx.strangerId);
  });

  it('anonymous POST /api/rubrics is 401 (creation is never public, even for public-eligible resources)', async () => {
    setSessionFor('anonymous', ctx);
    const res = await createRubricRoute(
      jsonRequest('http://localhost/api/rubrics', 'POST', {
        name: 'Anon Rubric',
        criteria: [{ name: 'C1', description: 'desc', maxScore: 10, weight: 1 }],
      })
    );
    expect(res.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// API key management: requires an INTERACTIVE SESSION — a scoped
// developer API key (even a "Full Access" one) must never be able to
// mint, edit, revoke, or list keys. Closes the T14 privilege-escalation
// finding (these routes previously called bare requireAuth(), which
// accepts a Bearer key too, and no `apikeys:*` scope exists).
// ═══════════════════════════════════════════════════════════════════════

describe('Access matrix — API keys require an interactive session (privilege-escalation fix)', () => {
  let ctx: Ctx;
  let rawKey: string;

  beforeEach(async () => {
    await truncateAll();
    (getServerSession as unknown as Mock).mockReset();
    (headers as unknown as Mock).mockReset();
    (headers as unknown as Mock).mockImplementation(async () => new Headers());

    const owner = await mkUser();
    const stranger = await mkUser();
    const admin = await mkUser({ role: 'admin' });
    ctx = { ownerId: owner.id, strangerId: stranger.id, adminId: admin.id };

    // A developer API key with EVERY scope (SCOPE_PRESETS' "Full Access")
    // — the worst case: even this must not be able to touch key-management
    // routes.
    rawKey = `vgk_${Buffer.from(`fullscope-${Date.now()}`).toString('base64url')}`;
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    await db.developerApiKey.create({
      data: {
        userId: ctx.ownerId,
        name: 'Full Access Key',
        prefix: rawKey.slice(0, 12),
        keyHash,
        scopes: JSON.stringify([
          'projects:read', 'projects:write', 'projects:export',
          'rubrics:read', 'rubrics:write',
          'models:read', 'models:write', 'models:verify',
          'evaluations:read', 'evaluations:write', 'evaluations:run', 'evaluations:export', 'evaluations:judge',
          'datasets:read', 'datasets:write', 'datasets:export',
          'config:read', 'config:write',
          'stats:read',
        ]),
      },
    });
  });

  function useScopedKeyAuth() {
    // Both requireAuth() headers() calls (the rate-limit chokepoint's
    // getClientIp, and authenticateApiKey()'s Bearer lookup) must see the
    // Authorization header for the WHOLE duration of one request — a
    // mockImplementation (not a one-shot mockResolvedValueOnce) covers
    // both calls within a single requireAuth() invocation.
    (headers as unknown as Mock).mockImplementation(
      async () => new Headers({ authorization: `Bearer ${rawKey}` })
    );
  }

  function useInteractiveSession() {
    (headers as unknown as Mock).mockImplementation(async () => new Headers());
    setSessionFor('owner', ctx);
  }

  it('a scoped API key (even Full Access) calling POST /api/api-keys is 403 — cannot mint a new key', async () => {
    useScopedKeyAuth();
    const before = await db.developerApiKey.count();

    const res = await createApiKeyRoute(
      jsonRequest('http://localhost/api/api-keys', 'POST', {
        name: 'Minted Via Scoped Key',
        scopes: ['stats:read'],
      }) as any
    );
    expect(res.status).toBe(403);
    expect(await db.developerApiKey.count()).toBe(before); // nothing minted
  });

  it('a scoped API key calling GET /api/api-keys is 403 — cannot enumerate keys either', async () => {
    useScopedKeyAuth();
    const res = await listApiKeys();
    expect(res.status).toBe(403);
  });

  it('a scoped API key calling PATCH /api/api-keys/[id] (even its OWN key) is 403', async () => {
    useScopedKeyAuth();
    const own = await db.developerApiKey.findFirstOrThrow({ where: { userId: ctx.ownerId } });

    const res = await patchApiKeyRoute(
      jsonRequest(`http://localhost/api/api-keys/${own.id}`, 'PATCH', { isActive: false }) as any,
      { params: Promise.resolve({ id: own.id }) }
    );
    expect(res.status).toBe(403);
  });

  it('a scoped API key calling DELETE /api/api-keys/[id] is 403 — cannot revoke keys', async () => {
    useScopedKeyAuth();
    const own = await db.developerApiKey.findFirstOrThrow({ where: { userId: ctx.ownerId } });

    const res = await deleteApiKeyRoute(jsonRequest(`http://localhost/api/api-keys/${own.id}`, 'DELETE') as any, {
      params: Promise.resolve({ id: own.id }),
    });
    expect(res.status).toBe(403);
    expect(await db.developerApiKey.findUnique({ where: { id: own.id } })).not.toBeNull(); // survives
  });

  it('an INTERACTIVE session (not an API key) can mint a new key normally — the fix does not lock out real users', async () => {
    useInteractiveSession();
    const res = await createApiKeyRoute(
      jsonRequest('http://localhost/api/api-keys', 'POST', {
        name: 'Minted Via Session',
        scopes: ['stats:read'],
      }) as any
    );
    expect(res.status).toBe(201);
  });

  it('anonymous (no session, no API key) calling POST /api/api-keys is 401, not 403', async () => {
    (headers as unknown as Mock).mockImplementation(async () => new Headers());
    (getServerSession as unknown as Mock).mockResolvedValue(null);

    const res = await createApiKeyRoute(
      jsonRequest('http://localhost/api/api-keys', 'POST', { name: 'X', scopes: ['stats:read'] }) as any
    );
    expect(res.status).toBe(401);
  });

  it('GET /api/api-keys/[id] also requires an interactive session (scoped key -> 403)', async () => {
    useScopedKeyAuth();
    const own = await db.developerApiKey.findFirstOrThrow({ where: { userId: ctx.ownerId } });

    const res = await getApiKey(new Request(`http://localhost/api/api-keys/${own.id}`) as any, {
      params: Promise.resolve({ id: own.id }),
    });
    expect(res.status).toBe(403);
  });
});
