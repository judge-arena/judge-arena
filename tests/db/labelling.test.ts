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
const { GET: GET_QUEUE } = await import('@/app/api/golden-sets/[id]/queue/route');
const { GET: GET_AGREEMENT } = await import('@/app/api/golden-sets/[id]/agreement/route');
const { GET: GET_DISAGREEMENTS } = await import(
  '@/app/api/golden-sets/[id]/disagreements/route'
);
const { GET: GET_HISTORY } = await import(
  '@/app/api/golden-sets/[id]/items/[itemId]/history/route'
);
const { POST: POST_LABEL } = await import(
  '@/app/api/golden-sets/[id]/items/[itemId]/labels/route'
);

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

// ─── Task 6 fixtures: a set the owner already holds a whole-set assignment on ──

async function mkAssignedSet(
  ownerId: string,
  opts: { itemCount?: number; retestIntervalItems?: number; protocol?: 'pointwise' | 'pairwise' } = {}
) {
  const { set, items } = await mkGoldenSet(ownerId, {
    count: opts.itemCount ?? 1,
    protocol: opts.protocol ?? 'pointwise',
  });
  if (opts.retestIntervalItems !== undefined) {
    await db.goldenSet.update({
      where: { id: set.id },
      data: { retestIntervalItems: opts.retestIntervalItems },
    });
  }
  await db.goldenAssignment.create({
    data: { goldenSetId: set.id, annotatorId: ownerId, round: 1 },
  });
  return { set, items };
}

function submitLabel(setId: string, itemId: string, body: unknown) {
  return POST_LABEL(jsonRequest(body, 'POST'), {
    params: Promise.resolve({ id: setId, itemId }),
  });
}

function queueRequest(setId: string) {
  return GET_QUEUE(new Request(`http://localhost/api/golden-sets/${setId}/queue`), {
    params: Promise.resolve({ id: setId }),
  });
}

describe('A1 queue and submit — blinding, and the two security properties', () => {
  beforeEach(async () => {
    await truncateAll();
    (getServerSession as unknown as Mock).mockReset();
  });

  it('the queue never reveals that an item is a RE-READ', async () => {
    // Blinding is the whole reliability signal. A response that differs in
    // shape — or that helpfully includes the previous answer — defeats it.
    const owner = await mkUser();
    const { set, items } = await mkAssignedSet(owner.id, { itemCount: 3, retestIntervalItems: 1 });
    sessionFor(owner);
    await submitLabel(set.id, items[0].id, { overallScore: 4 });
    await submitLabel(set.id, items[1].id, { overallScore: 2 });

    const body = await (await queueRequest(set.id)).json();
    expect(body.next).not.toBeNull();
    expect(Object.keys(body.next).sort()).toEqual([
      'candidates',
      'inputText',
      'itemId',
      'promptText',
      'protocol',
      'responseText',
    ]);
    expect(JSON.stringify(body)).not.toContain('round');
    expect(JSON.stringify(body)).not.toContain('overallScore');
  });

  it('a RETEST and a FIRST reading are byte-identical in shape', async () => {
    // The assertion above pins the key set of whatever the queue happened to
    // serve. This one forces the comparison the annotator would actually make:
    // one set where the next item is a first reading, one where it can only be
    // a re-read, same keys either way.
    const owner = await mkUser();
    sessionFor(owner);

    const fresh = await mkAssignedSet(owner.id, { itemCount: 1 });
    const freshBody = await (await queueRequest(fresh.set.id)).json();

    const retest = await mkAssignedSet(owner.id, { itemCount: 1, retestIntervalItems: 0 });
    await submitLabel(retest.set.id, retest.items[0].id, { overallScore: 3 });
    const retestBody = await (await queueRequest(retest.set.id)).json();

    expect(retestBody.next.itemId).toBe(retest.items[0].id); // it IS the re-read
    expect(Object.keys(retestBody.next).sort()).toEqual(Object.keys(freshBody.next).sort());
    expect(Object.keys(retestBody).sort()).toEqual(Object.keys(freshBody).sort());
  });

  it('the SERVER decides the round — a client-supplied round is ignored', async () => {
    const owner = await mkUser();
    const { set, items } = await mkAssignedSet(owner.id, { itemCount: 1, retestIntervalItems: 0 });
    sessionFor(owner);
    await submitLabel(set.id, items[0].id, { overallScore: 4 });
    const res = await submitLabel(set.id, items[0].id, { overallScore: 5, round: 1 }); // asks for round 1 again
    expect(res.status).toBe(201);
    expect((await res.json()).round).toBe(2); // server said 2
  });

  it('refuses a submit for an item the annotator holds no active assignment for', async () => {
    // The queue never offered it; a back button, a stale tab or a crafted POST
    // must not be able to write a reading anyway.
    const owner = await mkUser();
    const stranger = await mkUser();
    const { set, items } = await mkAssignedSet(owner.id, { itemCount: 1 });
    sessionFor(stranger);
    const res = await submitLabel(set.id, items[0].id, { overallScore: 4 });
    expect(res.status).toBe(403);
    expect(await db.goldenLabel.count()).toBe(0);
  });

  it('refuses a submit once the assignment is REVOKED — eligibility is re-checked, not remembered', async () => {
    const owner = await mkUser();
    const { set, items } = await mkAssignedSet(owner.id, { itemCount: 2 });
    sessionFor(owner);
    await submitLabel(set.id, items[0].id, { overallScore: 4 });

    await db.goldenAssignment.updateMany({
      where: { goldenSetId: set.id },
      data: { revokedAt: new Date(), revokedReason: 'reassigned' },
    });

    const res = await submitLabel(set.id, items[1].id, { overallScore: 4 });
    expect(res.status).toBe(403);
    expect(await db.goldenLabel.count()).toBe(1);
  });

  it('refuses a RETEST submit that is not yet eligible, even though round 1 was fine', async () => {
    // The submit-side re-check is not only about assignment. A crafted POST
    // that skips the interval would produce a second reading the annotator
    // still remembers, and a test-retest number computed over it measures
    // memory rather than consistency.
    const owner = await mkUser();
    const { set, items } = await mkAssignedSet(owner.id, { itemCount: 1, retestIntervalItems: 20 });
    sessionFor(owner);
    expect((await submitLabel(set.id, items[0].id, { overallScore: 4 })).status).toBe(201);

    const res = await submitLabel(set.id, items[0].id, { overallScore: 5 });
    expect(res.status).toBe(409);
    expect(await db.goldenLabel.count()).toBe(1);
  });

  it('refuses a score on a PAIRWISE item and a preference on a POINTWISE one', async () => {
    // The CHECK would refuse it at the database as a 500; the route refuses it
    // as a 400 that names the field.
    const owner = await mkUser();
    const { set, items } = await mkAssignedSet(owner.id, { itemCount: 1, protocol: 'pairwise' });
    sessionFor(owner);
    expect((await submitLabel(set.id, items[0].id, { overallScore: 4 })).status).toBe(400);
    expect((await submitLabel(set.id, items[0].id, { preference: 'A>B' })).status).toBe(201);
  });

  it('a set with no assignment reports no-assignment, not set-complete', async () => {
    // Two different facts: 'you have done everything asked of you' versus
    // 'nothing was asked of you'. Only one of them means the annotator is
    // finished, and an empty queue conflates them.
    const owner = await mkUser();
    const { set } = await mkGoldenSet(owner.id, { count: 2 });
    sessionFor(owner);
    const body = await (await queueRequest(set.id)).json();
    expect(body).toEqual({ next: null, reason: 'no-assignment' });
  });

  it('a fully-read set reports set-complete', async () => {
    const owner = await mkUser();
    const { set, items } = await mkAssignedSet(owner.id, { itemCount: 1, retestIntervalItems: 0 });
    sessionFor(owner);
    await submitLabel(set.id, items[0].id, { overallScore: 4 });
    await submitLabel(set.id, items[0].id, { overallScore: 4 });
    const body = await (await queueRequest(set.id)).json();
    expect(body).toEqual({ next: null, reason: 'set-complete' });
  });

  it('a too-small set says retest-not-yet-eligible WITH a shortfall, not "empty"', async () => {
    // The accepted limitation of intervening-items-only: a set smaller than K
    // can never produce a retest. The queue must say so explicitly rather than
    // look finished.
    const owner = await mkUser();
    const { set, items } = await mkAssignedSet(owner.id, { itemCount: 1, retestIntervalItems: 20 });
    sessionFor(owner);
    await submitLabel(set.id, items[0].id, { overallScore: 4 });
    const body = await (await queueRequest(set.id)).json();
    expect(body).toEqual({ next: null, reason: 'retest-not-yet-eligible', labelsUntilRetest: 20 });
  });

  it('an ITEM-level assignment covers only the round it names', async () => {
    const owner = await mkUser();
    const { set, items } = await mkGoldenSet(owner.id, { count: 2 });
    await db.goldenSet.update({ where: { id: set.id }, data: { retestIntervalItems: 0 } });
    // Assigned item 0 at round 1 only — nothing else.
    await db.goldenAssignment.create({
      data: { goldenSetId: set.id, annotatorId: owner.id, goldenItemId: items[0].id, round: 1 },
    });
    sessionFor(owner);

    expect((await submitLabel(set.id, items[0].id, { overallScore: 4 })).status).toBe(201);
    // Item 1 was never assigned...
    expect((await submitLabel(set.id, items[1].id, { overallScore: 4 })).status).toBe(403);
    // ...and neither was item 0's SECOND round.
    expect((await submitLabel(set.id, items[0].id, { overallScore: 5 })).status).toBe(403);
  });

  it('completing every item of a whole-set assignment stamps completedAt', async () => {
    const owner = await mkUser();
    const { set, items } = await mkAssignedSet(owner.id, { itemCount: 2 });
    sessionFor(owner);

    await submitLabel(set.id, items[0].id, { overallScore: 4 });
    let assignment = await db.goldenAssignment.findFirstOrThrow({ where: { goldenSetId: set.id } });
    expect(assignment.completedAt).toBeNull();

    await submitLabel(set.id, items[1].id, { overallScore: 4 });
    assignment = await db.goldenAssignment.findFirstOrThrow({ where: { goldenSetId: set.id } });
    expect(assignment.completedAt).not.toBeNull();
  });

  it('a label written now points at NO revision — it saw the current content', async () => {
    // The other half of the provenance invariant, from the write side:
    // goldenItemRevisionId IS NULL means "current content", and it is the EDIT
    // that back-fills it. A writer that set it here would be claiming the
    // annotator saw a before-image that does not exist yet.
    const owner = await mkUser();
    const { set, items } = await mkAssignedSet(owner.id, { itemCount: 1 });
    sessionFor(owner);
    await submitLabel(set.id, items[0].id, { overallScore: 4, reasoning: 'clear' });
    const label = await db.goldenLabel.findFirstOrThrow({ where: { goldenItemId: items[0].id } });
    expect(label.goldenItemRevisionId).toBeNull();
    expect(label.round).toBe(1);
    expect(label.reasoning).toBe('clear');
  });
});

// ─── Task 7 fixtures: reporting ───────────────────────────────────────────

function setAnonymous() {
  (getServerSession as unknown as Mock).mockResolvedValue(null);
}

function getRequest(path: string) {
  return new Request(`http://localhost/api/golden-sets/${path}`);
}

/** N items, two annotators, the first `overlapping` of them read by BOTH. */
async function mkTwoAnnotatorSet(opts: { items: number; overlapping: number }) {
  const owner = await mkUser();
  const second = await mkUser();
  const { set, items } = await mkGoldenSet(owner.id, { count: opts.items });
  for (const [i, item] of items.entries()) {
    await db.goldenLabel.create({
      data: { goldenItemId: item.id, annotatorId: owner.id, round: 1, overallScore: 4 },
    });
    if (i < opts.overlapping) {
      await db.goldenLabel.create({
        data: { goldenItemId: item.id, annotatorId: second.id, round: 1, overallScore: i === 0 ? 4 : 2 },
      });
    }
  }
  return { owner, second, set, items };
}

async function mkSingleAnnotatorSet() {
  const owner = await mkUser();
  const { set, items } = await mkGoldenSet(owner.id, { count: 3 });
  for (const item of items) {
    await db.goldenLabel.create({
      data: { goldenItemId: item.id, annotatorId: owner.id, round: 1, overallScore: 3 },
    });
  }
  return { owner, set, items };
}

async function mkPublicSet(published: boolean) {
  const owner = await mkUser();
  const { set, items } = await mkGoldenSet(owner.id, { count: 1 });
  const updated = await db.goldenSet.update({
    where: { id: set.id },
    data: { visibility: 'public', publishedAt: published ? new Date() : null },
  });
  return { owner, set: updated, items };
}

describe('A1 reporting — the number, its method, and what it was computed over', () => {
  beforeEach(async () => {
    await truncateAll();
    (getServerSession as unknown as Mock).mockReset();
  });

  const params = (id: string) => ({ params: Promise.resolve({ id }) });

  it('reports the method and the OVERLAP, not the set size', async () => {
    // An agreement number over 2 shared items in a 50-item set is an anecdote.
    // The only thing that makes that visible is reporting what it was over.
    const { owner, set } = await mkTwoAnnotatorSet({ items: 50, overlapping: 2 });
    sessionFor(owner);
    const body = await (
      await GET_AGREEMENT(getRequest(`${set.id}/agreement`), params(set.id))
    ).json();
    expect(body.itemCount).toBe(2);
    expect(body.annotatorCount).toBe(2);
    expect(body.statistic).toBe('cohen');
  });

  it('a set with ONE annotator reports insufficient-annotators, not a number', async () => {
    const { owner, set } = await mkSingleAnnotatorSet();
    sessionFor(owner);
    const body = await (
      await GET_AGREEMENT(getRequest(`${set.id}/agreement`), params(set.id))
    ).json();
    expect(body.value).toBeNull();
    expect(body.reason).toBe('insufficient-annotators');
  });

  it('a TOMBSTONED reading is not a reading — it applied to text that is gone', async () => {
    const { owner, second, set, items } = await mkTwoAnnotatorSet({ items: 2, overlapping: 2 });
    sessionFor(owner);
    await db.goldenLabel.updateMany({
      where: { annotatorId: second.id },
      data: { tombstonedAt: new Date(), tombstonedReason: 'item-content-edit' },
    });
    const body = await (
      await GET_AGREEMENT(getRequest(`${set.id}/agreement`), params(set.id))
    ).json();
    expect(body.annotatorCount).toBe(1);
    expect(body.reason).toBe('insufficient-annotators');
    expect(items).toHaveLength(2);
  });

  it('an ANONYMISED reading is excluded, and the exclusion is REPORTED not hidden', async () => {
    // Account deletion nulls annotatorId by design. Such a reading cannot be
    // attributed, and two deleted annotators would otherwise collapse into one
    // rater — silently changing the statistic. Dropping it is right; dropping
    // it quietly is the confidently-wrong-number failure this phase exists to
    // prevent, so the count travels with the result.
    const { owner, second, set } = await mkTwoAnnotatorSet({ items: 2, overlapping: 2 });
    sessionFor(owner);
    await db.goldenLabel.updateMany({ where: { annotatorId: second.id }, data: { annotatorId: null } });
    const body = await (
      await GET_AGREEMENT(getRequest(`${set.id}/agreement`), params(set.id))
    ).json();
    expect(body.excludedAnonymisedReadings).toBe(2);
    expect(body.annotatorCount).toBe(1);
    expect(body.reason).toBe('insufficient-annotators');
  });

  it('ranks disagreements by spread, descending — A3 reads this as its next round', async () => {
    const { owner, set, items } = await mkTwoAnnotatorSet({ items: 3, overlapping: 3 });
    sessionFor(owner);
    const body = await (
      await GET_DISAGREEMENTS(getRequest(`${set.id}/disagreements`), params(set.id))
    ).json();
    // Item 0 is 4-vs-4 (spread 0); items 1 and 2 are 4-vs-2 (spread 2).
    expect(body.items[0].spread).toBe(2);
    expect(body.items.map((i: { spread: number }) => i.spread)).toEqual([2, 2, 0]);
    expect(body.items[0].itemId).not.toBe(items[0].id);
  });

  it('history resolves each reading to the text THAT annotator saw, after an edit', async () => {
    const owner = await mkUser();
    const { set, item } = await mkGoldenSetWithItem(owner.id, { inputText: 'as first seen' });
    await db.goldenLabel.create({
      data: { goldenItemId: item.id, annotatorId: owner.id, round: 1, overallScore: 4 },
    });
    sessionFor(owner);
    await PATCH(jsonRequest({ items: [{ id: item.id, inputText: 'edited later' }] }), params(set.id));

    const body = await (
      await GET_HISTORY(getRequest(`${set.id}/items/${item.id}/history`), {
        params: Promise.resolve({ id: set.id, itemId: item.id }),
      })
    ).json();
    // NOT 'edited later'. Without the revision join this returns the current
    // text and looks perfectly fine.
    expect(body.readings[0].sawText.inputText).toBe('as first seen');
    expect(body.readings[0].sawRevisionId).not.toBeNull();
  });

  it('history falls back to CURRENT content when no revision is stamped', async () => {
    // The other half of the invariant: a null revision id means the annotator
    // saw what is there now. A fallback that returned null instead would make
    // every un-edited item look like missing provenance.
    const owner = await mkUser();
    const { set, item } = await mkGoldenSetWithItem(owner.id, { inputText: 'never edited' });
    await db.goldenLabel.create({
      data: { goldenItemId: item.id, annotatorId: owner.id, round: 1, overallScore: 4 },
    });
    sessionFor(owner);
    const body = await (
      await GET_HISTORY(getRequest(`${set.id}/items/${item.id}/history`), {
        params: Promise.resolve({ id: set.id, itemId: item.id }),
      })
    ).json();
    expect(body.readings[0].sawRevisionId).toBeNull();
    expect(body.readings[0].sawText.inputText).toBe('never edited');
  });

  it('anonymous gets agreement for a PUBLISHED public set, and 401 for an unpublished one', async () => {
    const pub = await mkPublicSet(true);
    const draft = await mkPublicSet(false);
    setAnonymous();
    expect((await GET_AGREEMENT(getRequest(`${pub.set.id}/agreement`), params(pub.set.id))).status).toBe(200);
    expect((await GET_AGREEMENT(getRequest(`${draft.set.id}/agreement`), params(draft.set.id))).status).toBe(401);
  });

  it('the public branch does not name the annotators', async () => {
    // Every other public read path in this codebase strips user data to
    // { id, name } of the OWNER and nothing else (src/lib/serializers.ts).
    // A published agreement number is an artifact; who scored what is not
    // part of it.
    const owner = await mkUser();
    const { set, item } = await mkGoldenSetWithItem(owner.id);
    await db.goldenSet.update({
      where: { id: set.id },
      data: { visibility: 'public', publishedAt: new Date() },
    });
    await db.goldenLabel.create({
      data: { goldenItemId: item.id, annotatorId: owner.id, round: 1, overallScore: 4 },
    });

    sessionFor(owner);
    const asOwner = await (
      await GET_HISTORY(getRequest(`${set.id}/items/${item.id}/history`), {
        params: Promise.resolve({ id: set.id, itemId: item.id }),
      })
    ).json();
    expect(asOwner.readings[0].annotator).toEqual({ id: owner.id, name: owner.name });

    setAnonymous();
    const asAnon = await (
      await GET_HISTORY(getRequest(`${set.id}/items/${item.id}/history`), {
        params: Promise.resolve({ id: set.id, itemId: item.id }),
      })
    ).json();
    expect(asAnon.readings[0].annotator).toBeNull();
    expect(JSON.stringify(asAnon)).not.toContain(owner.id);
  });

  it('a deliberately INCONSISTENT re-read moves testRetest in the expected direction', async () => {
    // The exit-gate clause that is only exercisable once two rounds exist.
    // Two items, each read twice: consistent readings give 1, and flipping one
    // of the second readings must move the number DOWN.
    const owner = await mkUser();
    const { set, items } = await mkAssignedSet(owner.id, { itemCount: 2, retestIntervalItems: 0 });
    sessionFor(owner);
    for (const item of items) await submitLabel(set.id, item.id, { overallScore: 4 });
    for (const item of items) await submitLabel(set.id, item.id, { overallScore: 4 });

    const consistent = await (
      await GET_AGREEMENT(getRequest(`${set.id}/agreement`), params(set.id))
    ).json();
    expect(consistent.testRetest.value).toBe(1);
    expect(consistent.testRetest.itemCount).toBe(2);

    // Now make one re-read disagree with its own first reading.
    const secondReading = await db.goldenLabel.findFirstOrThrow({
      where: { goldenItemId: items[0].id, round: 2 },
    });
    await db.goldenLabel.update({ where: { id: secondReading.id }, data: { overallScore: 1 } });

    const inconsistent = await (
      await GET_AGREEMENT(getRequest(`${set.id}/agreement`), params(set.id))
    ).json();
    expect(inconsistent.testRetest.value).toBeLessThan(consistent.testRetest.value);
  });
});
