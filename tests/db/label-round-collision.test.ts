import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { getServerSession } from 'next-auth';
import { db, truncateAll, mkUser } from './helpers';

/**
 * A1, the submit route's ROUND COLLISION path.
 *
 * Two submits for the same item can derive the same round from the same stored
 * labels — two tabs, or a double-click on a slow connection. The second insert
 * then loses to
 * `GoldenLabel_goldenItemId_annotatorId_round_live_key` and, before this was
 * handled, surfaced as a bare 500. That reads to the annotator as "this broke",
 * so they retry, producing a third attempt at a reading that already succeeded.
 *
 * THE COLLISION IS INJECTED RATHER THAN RACED, for exactly the reason
 * tests/db/sample-index-retry.test.ts gives for the same choice one model up:
 * two concurrent POSTs may or may not interleave, so a test built on real
 * concurrency would pass without ever exercising the path — the worst kind of
 * green. Here `deriveReadingStates` is forced to report a STALE state (no
 * round-1 reading, when one exists), so the route derives round 1 a second
 * time and the insert collides deterministically.
 *
 * Only that one function is replaced. `nextRoundFor` and `coversCandidate`
 * must stay real — the route's decision path is what is under test, not a
 * stub of it.
 *
 * This lives in its own file because the mock is module-wide and would
 * otherwise reach every test in tests/db/labelling.test.ts.
 */

const hoisted = vi.hoisted(() => ({ stale: false }));

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
vi.mock('@/lib/labelling-queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/labelling-queue')>();
  return {
    ...actual,
    deriveReadingStates: vi.fn(
      (itemIds: string[], labels: Parameters<typeof actual.deriveReadingStates>[1]) => {
        const real = actual.deriveReadingStates(itemIds, labels);
        if (!hoisted.stale) return real;
        // The read that a concurrent writer has already invalidated.
        return real.map((s) => ({ ...s, hasRound1: false, hasRound2: false }));
      }
    ),
  };
});

const { POST: POST_LABEL } = await import(
  '@/app/api/golden-sets/[id]/items/[itemId]/labels/route'
);

let counter = 0;

async function mkAssignedSet(ownerId: string) {
  counter += 1;
  const dataset = await db.dataset.create({
    data: {
      name: `collision-fixture-${counter}`,
      slug: `collision-fixture-${counter}`,
      userId: ownerId,
      source: 'local',
      visibility: 'private',
      samples: { create: [{ index: 0, input: 'question-0' }] },
    },
    include: { samples: true },
  });
  const set = await db.goldenSet.create({
    data: {
      name: `collision-set-${counter}`,
      slug: `collision-set-${counter}`,
      ownerId,
      datasetId: dataset.id,
      protocol: 'pointwise',
      visibility: 'private',
      items: {
        create: [
          {
            index: 0,
            inputText: 'question-0',
            protocol: 'pointwise',
            sourceDatasetSampleId: dataset.samples[0].id,
          },
        ],
      },
    },
    include: { items: true },
  });
  await db.goldenAssignment.create({
    data: { goldenSetId: set.id, annotatorId: ownerId, round: 1 },
  });
  return { set, item: set.items[0] };
}

function submit(setId: string, itemId: string, body: unknown) {
  return POST_LABEL(
    new Request('http://localhost/labels', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({ id: setId, itemId }) }
  );
}

describe('submit — a concurrent round collision is a 409, not a bare 500', () => {
  beforeEach(async () => {
    await truncateAll();
    hoisted.stale = false;
    (getServerSession as unknown as Mock).mockReset();
  });

  it('reports 409 when another writer already recorded this item and round', async () => {
    const owner = await mkUser();
    const { set, item } = await mkAssignedSet(owner.id);
    (getServerSession as unknown as Mock).mockResolvedValue({
      user: { id: owner.id, email: owner.email },
    });

    expect((await submit(set.id, item.id, { overallScore: 4 })).status).toBe(201);

    // Now the route reads state that the write above has already invalidated.
    hoisted.stale = true;
    const res = await submit(set.id, item.id, { overallScore: 5 });
    expect(res.status).toBe(409);

    // And nothing was written: the reading that already exists still stands
    // alone, so a retry cannot produce a duplicate reading.
    expect(await db.goldenLabel.count({ where: { goldenItemId: item.id } })).toBe(1);
  });
});
