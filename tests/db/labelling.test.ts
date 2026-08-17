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
