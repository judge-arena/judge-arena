import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { getServerSession } from 'next-auth';
import { db, truncateAll, mkUser } from './helpers';

/**
 * A1 — the labelling surface, end to end against a live Postgres.
 *
 * Everything here drives REAL route handlers rather than library calls, because
 * the two properties this phase exists to protect are properties of the
 * REQUEST, not of a function: the server decides which round a reading is, and
 * eligibility is re-checked on submit rather than trusted from the queue. A
 * library-level test cannot distinguish "the route ignored the client's round"
 * from "the client never sent one".
 */

// The three mocks a route-driving DB test needs. `next/headers` is not
// optional: requireAuth awaits headers() before any auth work, so without it
// every route call throws before reaching the handler. The rate-limit mock is
// because this suite shares one finite 120/min budget across files.
vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock('@/lib/rate-limit-redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rate-limit-redis')>();
  return {
    ...actual,
    apiLimiter: {
      check: vi.fn(async () => ({ ok: true, remaining: 999, resetAt: Date.now() + 60_000 })),
    },
  };
});

const { PATCH } = await import('@/app/api/golden-sets/[id]/items/route');
const {
  GET: GET_ASSIGNMENTS,
  POST: POST_ASSIGNMENT,
  DELETE: DELETE_ASSIGNMENT,
} = await import('@/app/api/golden-sets/[id]/assignments/route');

let counter = 0;
function uniq(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

function sessionFor(user: { id: string; email: string }) {
  (getServerSession as unknown as Mock).mockResolvedValue({
    user: { id: user.id, email: user.email, name: 'Labelling Tester' },
  });
}

function jsonRequest(body: unknown, method = 'PATCH') {
  return new Request('http://localhost/api/golden-sets/x/items', {
    method,
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

type ItemSpec = {
  inputText?: string;
  promptText?: string | null;
  responseText?: string | null;
  expected?: string | null;
};

/** A private golden set owned by `ownerId`, with `count` items. */
async function mkGoldenSet(
  ownerId: string,
  opts: { count?: number; protocol?: 'pointwise' | 'pairwise'; item?: ItemSpec } = {}
) {
  const count = opts.count ?? 1;
  const protocol = opts.protocol ?? 'pointwise';
  const dataset = await db.dataset.create({
    data: {
      name: uniq('labelling-fixture'),
      slug: uniq('labelling-fixture'),
      userId: ownerId,
      source: 'local',
      visibility: 'private',
      samples: {
        create: Array.from({ length: count }, (_, i) => ({
          index: i,
          input: opts.item?.inputText ?? `question-${i}`,
        })),
      },
    },
    include: { samples: { orderBy: { index: 'asc' } } },
  });
  const set = await db.goldenSet.create({
    data: {
      name: uniq('labelling-set'),
      slug: uniq('labelling-set'),
      ownerId,
      datasetId: dataset.id,
      protocol,
      visibility: 'private',
      items: {
        create: dataset.samples.map((s, i) => ({
          index: i,
          inputText: opts.item?.inputText ?? s.input,
          promptText: opts.item?.promptText ?? null,
          responseText: opts.item?.responseText ?? null,
          expected: opts.item?.expected ?? null,
          protocol,
          sourceDatasetSampleId: s.id,
        })),
      },
    },
    include: { items: { orderBy: { index: 'asc' } } },
  });
  return { dataset, set, items: set.items };
}

/** The single-item shape the provenance tests use. */
async function mkGoldenSetWithItem(ownerId: string, item: ItemSpec = {}) {
  const { set, items } = await mkGoldenSet(ownerId, { count: 1, item });
  return { set, item: items[0] };
}

describe('A1 provenance — an item edit records the before-image', () => {
  beforeEach(async () => {
    await truncateAll();
    (getServerSession as unknown as Mock).mockReset();
  });

  it('an item edit records the BEFORE image and stamps the labels that saw it', async () => {
    const owner = await mkUser();
    const { set, item } = await mkGoldenSetWithItem(owner.id, { inputText: 'original question' });
    const label = await db.goldenLabel.create({
      data: { goldenItemId: item.id, annotatorId: owner.id, round: 1, overallScore: 4 },
    });
    sessionFor(owner);

    const res = await PATCH(jsonRequest({ items: [{ id: item.id, inputText: 'edited question' }] }), {
      params: Promise.resolve({ id: set.id }),
    });
    expect(res.status).toBe(200);

    // The revision holds the OLD text...
    const revisions = await db.goldenItemRevision.findMany({ where: { goldenItemId: item.id } });
    expect(revisions).toHaveLength(1);
    expect(revisions[0].inputText).toBe('original question');
    expect(revisions[0].actorId).toBe(owner.id);

    // ...and the label that saw it points AT it, so "what did they see" is a
    // join rather than a timestamp inference.
    const after = await db.goldenLabel.findUniqueOrThrow({ where: { id: label.id } });
    expect(after.goldenItemRevisionId).toBe(revisions[0].id);
    expect(after.tombstonedReason).toBe('item-content-edit');
  });

  it('a metadata-only PATCH writes NO revision — contentChanged is the gate', async () => {
    const owner = await mkUser();
    const { set, item } = await mkGoldenSetWithItem(owner.id, { inputText: 'unchanged' });
    sessionFor(owner);
    await PATCH(jsonRequest({ items: [{ id: item.id, inputText: 'unchanged' }] }), {
      params: Promise.resolve({ id: set.id }),
    });
    expect(await db.goldenItemRevision.count()).toBe(0);
  });

  it('a SECOND edit does not re-stamp labels an earlier edit already stamped', async () => {
    const owner = await mkUser();
    const { set, item } = await mkGoldenSetWithItem(owner.id, { inputText: 'v1' });
    const first = await db.goldenLabel.create({
      data: { goldenItemId: item.id, annotatorId: owner.id, round: 1, overallScore: 4 },
    });
    sessionFor(owner);
    await PATCH(jsonRequest({ items: [{ id: item.id, inputText: 'v2' }] }), {
      params: Promise.resolve({ id: set.id }),
    });
    const stampedWith = (await db.goldenLabel.findUniqueOrThrow({ where: { id: first.id } }))
      .goldenItemRevisionId;

    await PATCH(jsonRequest({ items: [{ id: item.id, inputText: 'v3' }] }), {
      params: Promise.resolve({ id: set.id }),
    });

    // Still pointing at the v1 before-image: the second edit's updateMany
    // filters on tombstonedAt: null and never reaches an already-tombstoned row.
    const again = await db.goldenLabel.findUniqueOrThrow({ where: { id: first.id } });
    expect(again.goldenItemRevisionId).toBe(stampedWith);
    expect(await db.goldenItemRevision.count()).toBe(2);
  });
});

describe('A1 assignment — overlap is designed, not accidental', () => {
  beforeEach(async () => {
    await truncateAll();
    (getServerSession as unknown as Mock).mockReset();
  });

  const params = (id: string) => ({ params: Promise.resolve({ id }) });

  it('assigns a WHOLE SET with a null goldenItemId — 620 rows is the exception, not the norm', async () => {
    const owner = await mkUser();
    const { set } = await mkGoldenSet(owner.id, { count: 3 });
    sessionFor(owner);

    const res = await POST_ASSIGNMENT(
      jsonRequest({ annotatorId: owner.id }, 'POST'),
      params(set.id)
    );
    expect(res.status).toBe(201);
    const { assignment } = await res.json();
    expect(assignment.goldenItemId).toBeNull();
    expect(assignment.round).toBe(1);
    expect(assignment.revokedAt).toBeNull();
  });

  it('assigns a SINGLE ITEM, for adjudication or a targeted re-read', async () => {
    const owner = await mkUser();
    const { set, items } = await mkGoldenSet(owner.id, { count: 3 });
    sessionFor(owner);

    const res = await POST_ASSIGNMENT(
      jsonRequest({ annotatorId: owner.id, goldenItemId: items[1].id, round: 2 }, 'POST'),
      params(set.id)
    );
    expect(res.status).toBe(201);
    const { assignment } = await res.json();
    expect(assignment.goldenItemId).toBe(items[1].id);
    expect(assignment.round).toBe(2);
  });

  it('records WHO DID THE ASKING, not just who was asked', async () => {
    // Decision 6 is "assignment is explicit rows"; the audit trail is half the
    // reason. An assignment with no assignedBy cannot answer "who put this on
    // my queue", which is the first question an annotator asks.
    const owner = await mkUser();
    const admin = await mkUser({ role: 'admin' });
    const { set } = await mkGoldenSet(owner.id);
    sessionFor(admin);

    const res = await POST_ASSIGNMENT(
      jsonRequest({ annotatorId: owner.id }, 'POST'),
      params(set.id)
    );
    expect(res.status).toBe(201);
    const { assignment } = await res.json();
    expect(assignment.assignedById).toBe(admin.id);
    expect(assignment.annotatorId).toBe(owner.id);
  });

  it('DELETE REVOKES — the row survives, because it records what was asked', async () => {
    const owner = await mkUser();
    const { set, items } = await mkGoldenSet(owner.id);
    sessionFor(owner);
    const created = await (
      await POST_ASSIGNMENT(
        jsonRequest({ annotatorId: owner.id, goldenItemId: items[0].id }, 'POST'),
        params(set.id)
      )
    ).json();

    const res = await DELETE_ASSIGNMENT(
      jsonRequest({ assignmentId: created.assignment.id, reason: 'reassigned' }, 'DELETE'),
      params(set.id)
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true });

    // NOT deleted. A delete would destroy the audit trail the model exists for.
    const row = await db.goldenAssignment.findUniqueOrThrow({
      where: { id: created.assignment.id },
    });
    expect(row.revokedAt).not.toBeNull();
    expect(row.revokedReason).toBe('reassigned');
    expect(await db.goldenAssignment.count()).toBe(1);
  });

  it('a re-assignment after revocation SUCCEEDS — the partial index permits it', async () => {
    // The whole reason the active-assignment unique is partial. A whole-table
    // unique would let one revoked row block that annotator from ever being
    // given the same item and round again.
    const owner = await mkUser();
    const { set, items } = await mkGoldenSet(owner.id);
    sessionFor(owner);
    const body = { annotatorId: owner.id, goldenItemId: items[0].id, round: 1 };

    const first = await (
      await POST_ASSIGNMENT(jsonRequest(body, 'POST'), params(set.id))
    ).json();

    // The same assignment again, while the first is ACTIVE, is refused.
    const dupe = await POST_ASSIGNMENT(jsonRequest(body, 'POST'), params(set.id));
    expect(dupe.status).toBe(409);

    await DELETE_ASSIGNMENT(
      jsonRequest({ assignmentId: first.assignment.id }, 'DELETE'),
      params(set.id)
    );

    const again = await POST_ASSIGNMENT(jsonRequest(body, 'POST'), params(set.id));
    expect(again.status).toBe(201);
    expect(await db.goldenAssignment.count()).toBe(2);
  });

  it('GET lists ACTIVE assignments, and revoked ones only when asked for', async () => {
    const owner = await mkUser();
    const { set, items } = await mkGoldenSet(owner.id, { count: 2 });
    sessionFor(owner);
    const a = await (
      await POST_ASSIGNMENT(
        jsonRequest({ annotatorId: owner.id, goldenItemId: items[0].id }, 'POST'),
        params(set.id)
      )
    ).json();
    await POST_ASSIGNMENT(
      jsonRequest({ annotatorId: owner.id, goldenItemId: items[1].id }, 'POST'),
      params(set.id)
    );
    await DELETE_ASSIGNMENT(
      jsonRequest({ assignmentId: a.assignment.id }, 'DELETE'),
      params(set.id)
    );

    const active = await (
      await GET_ASSIGNMENTS(
        new Request(`http://localhost/api/golden-sets/${set.id}/assignments`),
        params(set.id)
      )
    ).json();
    expect(active.assignments).toHaveLength(1);

    const all = await (
      await GET_ASSIGNMENTS(
        new Request(`http://localhost/api/golden-sets/${set.id}/assignments?includeRevoked=true`),
        params(set.id)
      )
    ).json();
    expect(all.assignments).toHaveLength(2);
  });

  it('refuses to assign work to somebody who may not HOLD an assignment', async () => {
    // Decision 8, and the reason mechanism and policy are separate concerns:
    // with one account owner+admin collapse to "the owner", but the check is
    // written as a policy so widening it later is a one-line change rather
    // than a redesign. Without it, a coordinator could queue work onto a
    // stranger's account and there is no path by which they would ever see it.
    const owner = await mkUser();
    const stranger = await mkUser();
    const { set } = await mkGoldenSet(owner.id);
    sessionFor(owner);

    const res = await POST_ASSIGNMENT(
      jsonRequest({ annotatorId: stranger.id }, 'POST'),
      params(set.id)
    );
    expect(res.status).toBe(403);
    expect(await db.goldenAssignment.count()).toBe(0);
  });

  it('refuses an item that belongs to a DIFFERENT golden set', async () => {
    // Otherwise the id in the URL is decoration and an assignment can point
    // across sets, which every downstream queue query would then mis-scope.
    const owner = await mkUser();
    const { set } = await mkGoldenSet(owner.id);
    const other = await mkGoldenSet(owner.id);
    sessionFor(owner);

    const res = await POST_ASSIGNMENT(
      jsonRequest({ annotatorId: owner.id, goldenItemId: other.items[0].id }, 'POST'),
      params(set.id)
    );
    expect(res.status).toBe(400);
  });
});
