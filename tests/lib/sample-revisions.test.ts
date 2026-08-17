import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { recordSampleRevision, recordSampleRevisions } from '@/lib/sample-revisions';

/**
 * These assert the PAYLOAD the writers hand Prisma, using a stub client, for
 * the same reason tests/lib/golden-sets.test.ts:388-426 asserts a returned
 * where-fragment: the value is the contract, and a DB round trip would hide a
 * wrong field name behind a passing insert.
 *
 * The stub is returned TYPED and cast at each call site rather than being cast
 * to `never` inside the helper. Casting the return type erases it, which makes
 * every later `tx.sampleRevision.create` assertion type `never` — it compiles,
 * but nothing checks that the property being asserted still exists.
 *
 * Both spies DECLARE their argument type. `vi.fn(async () => …)` would infer a
 * zero-argument tuple, and `.mock.calls[0][0]` on it is a type error
 * (TS2493, "tuple of length 0 has no element at index 0") — which is what
 * pushes a writer towards blanket `as never` casts. Declaring the parameter
 * keeps the payload assertions genuinely type-checked instead.
 */
function stubTx() {
  const create = vi.fn(async (args: { data: Record<string, unknown> }) => args);
  const createMany = vi.fn(async (args: { data: Record<string, unknown>[] }) => ({
    count: args.data.length,
  }));
  return { sampleRevision: { create, createMany } };
}

const asTx = (stub: ReturnType<typeof stubTx>) => stub as unknown as Prisma.TransactionClient;

describe('recordSampleRevision', () => {
  it('an edit carries the BEFORE values, the actor, and no id of its own', async () => {
    const tx = stubTx();
    await recordSampleRevision(asTx(tx), {
      datasetSampleId: 'smp_1',
      changeType: 'edit',
      actorId: 'usr_1',
      before: { input: 'old question', expected: 'old answer', metadata: '{"split":"train"}' },
    });

    expect(tx.sampleRevision.create).toHaveBeenCalledWith({
      data: {
        datasetSampleId: 'smp_1',
        changeType: 'edit',
        actorId: 'usr_1',
        input: 'old question',
        expected: 'old answer',
        metadata: '{"split":"train"}',
      },
    });
  });

  it('a delete carries NO content columns — a before-image would duplicate the live row', async () => {
    const tx = stubTx();
    await recordSampleRevision(asTx(tx), {
      datasetSampleId: 'smp_1',
      changeType: 'delete',
      actorId: 'usr_1',
    });

    const call = tx.sampleRevision.create.mock.calls[0][0];
    expect(call.data).toEqual({
      datasetSampleId: 'smp_1',
      changeType: 'delete',
      actorId: 'usr_1',
    });
    // Explicit: absent, not null. A null would claim "this row had no input",
    // which is false — it had one, and it still does.
    expect('input' in call.data).toBe(false);
    expect('expected' in call.data).toBe(false);
    expect('metadata' in call.data).toBe(false);
  });

  it('a null actor is written through, not dropped — an anonymised edit is still an edit', async () => {
    const tx = stubTx();
    await recordSampleRevision(asTx(tx), {
      datasetSampleId: 'smp_1',
      changeType: 'restore',
      actorId: null,
    });

    const call = tx.sampleRevision.create.mock.calls[0][0];
    expect(call.data.actorId).toBeNull();
  });
});

describe('recordSampleRevisions', () => {
  it('writes one row per id in a single createMany and returns the count', async () => {
    const tx = stubTx();
    const n = await recordSampleRevisions(asTx(tx), {
      datasetSampleIds: ['smp_1', 'smp_2'],
      changeType: 'delete',
      actorId: 'usr_1',
    });

    expect(tx.sampleRevision.createMany).toHaveBeenCalledWith({
      data: [
        { datasetSampleId: 'smp_1', changeType: 'delete', actorId: 'usr_1' },
        { datasetSampleId: 'smp_2', changeType: 'delete', actorId: 'usr_1' },
      ],
    });
    expect(n).toBe(2);
  });

  it('de-duplicates ids, so a repeated id in one request logs one revision', async () => {
    const tx = stubTx();
    const n = await recordSampleRevisions(asTx(tx), {
      datasetSampleIds: ['smp_1', 'smp_1', 'smp_2'],
      changeType: 'delete',
      actorId: null,
    });
    expect(n).toBe(2);
    const call = tx.sampleRevision.createMany.mock.calls[0][0];
    expect(call.data).toHaveLength(2);
  });

  it('an empty id list is a no-op that writes nothing and returns 0', async () => {
    const tx = stubTx();
    const n = await recordSampleRevisions(asTx(tx), {
      datasetSampleIds: [],
      changeType: 'delete',
      actorId: 'usr_1',
    });
    expect(n).toBe(0);
    expect(tx.sampleRevision.createMany).not.toHaveBeenCalled();
  });
});
