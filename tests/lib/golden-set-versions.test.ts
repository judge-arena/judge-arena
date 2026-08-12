import { describe, it, expect, vi } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  forkGoldenSet,
  GoldenSetVersionConflictError,
  type ForkGoldenSetInput,
} from '@/lib/golden-set-versions';

// ─── Fix round 1: the retry predicate's error arm, unit-tested ─────────────
//
// tests/db/golden-set-fork.test.ts's concurrency test proves the retry loop
// RECOVERS from a real Postgres race, but it cannot cheaply prove the loop
// stops retrying at the right time, or that it never retries a P2002 that
// isn't actually the version/slug race — those are properties of
// `isRetryableVersionConflict`'s FALSE arm and the `MAX_ATTEMPTS` bound, and
// a DB test can't manufacture a child-level unique-constraint collision
// (`[goldenItemId, position]`, `[goldenSetId, index]`) on demand without
// corrupting its own fixtures mid-transaction.
//
// This is cheap and deterministic without a database because `forkGoldenSet`
// takes `client: PrismaClient` as a parameter: a stub whose `$transaction`
// always rejects lets each branch be pinned by call-count and by exactly
// which error comes out the other side — no real transaction ever runs, so
// `input`'s field values below are never read.

const input: ForkGoldenSetInput = {
  rootGoldenSetId: 'root-1',
  sourceGoldenSetId: 'root-1',
  ownerId: 'owner-1',
  name: 'forked golden set',
  description: null,
};

function stubClient(rejection: unknown) {
  const $transaction = vi.fn().mockRejectedValue(rejection);
  return { client: { $transaction } as unknown as PrismaClient, $transaction };
}

function versionConflict(target: string[]) {
  return new Prisma.PrismaClientKnownRequestError(
    `Unique constraint failed on the fields: (${target.map((t) => `\`${t}\``).join(',')})`,
    { code: 'P2002', clientVersion: '6.19.2', meta: { target } }
  );
}

describe('forkGoldenSet: the retry loop, stubbed at the $transaction boundary', () => {
  it(
    'a version/slug P2002 on every attempt retries exactly MAX_ATTEMPTS (3) times, ' +
      'then throws GoldenSetVersionConflictError carrying attempts=3',
    async () => {
      const { client, $transaction } = stubClient(versionConflict(['parentId', 'version']));

      let thrown: unknown;
      try {
        await forkGoldenSet(client, input);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(GoldenSetVersionConflictError);
      expect((thrown as GoldenSetVersionConflictError).attempts).toBe(3);

      // Never a `while (true)` loop wearing a bounded loop's clothes: a
      // race test that always resolves in 2 attempts cannot tell 3 apart
      // from infinity. This pins the bound directly.
      expect($transaction).toHaveBeenCalledTimes(3);
    }
  );

  it(
    'a P2002 on a CHILD constraint ([goldenItemId, position]) is a real data bug, not the ' +
      'version race — it must surface unchanged on the FIRST attempt, never retried and ' +
      'never remapped into GoldenSetVersionConflictError',
    async () => {
      const childViolation = versionConflict(['goldenItemId', 'position']);
      const { client, $transaction } = stubClient(childViolation);

      // `.toBe`, not `.toBeInstanceOf(Prisma...)`: the ORIGINAL error object
      // must come out the other side untouched. A predicate this permissive
      // would silently paper over a genuine constraint violation — e.g. two
      // candidates written to the same item at the same position — as
      // "just retry", corrupting data three times over instead of failing
      // loudly once.
      await expect(forkGoldenSet(client, input)).rejects.toBe(childViolation);
      expect($transaction).toHaveBeenCalledTimes(1);
    }
  );

  it(
    'a P2002 on ANOTHER golden-set constraint ([goldenSetId, index]) is equally not the ' +
      'version race and is not retried either',
    async () => {
      const childViolation = versionConflict(['goldenSetId', 'index']);
      const { client, $transaction } = stubClient(childViolation);

      await expect(forkGoldenSet(client, input)).rejects.toBe(childViolation);
      expect($transaction).toHaveBeenCalledTimes(1);
    }
  );

  it(
    'a non-P2002 error (e.g. P2003, a foreign-key violation) is not retried either — the ' +
      'retry predicate is scoped to P2002 alone',
    async () => {
      const fkViolation = new Prisma.PrismaClientKnownRequestError(
        'Foreign key constraint failed on the field: `datasetId`',
        { code: 'P2003', clientVersion: '6.19.2', meta: { field_name: 'datasetId' } }
      );
      const { client, $transaction } = stubClient(fkViolation);

      await expect(forkGoldenSet(client, input)).rejects.toBe(fkViolation);
      expect($transaction).toHaveBeenCalledTimes(1);
    }
  );

  it('a plain (non-Prisma) error is not retried either', async () => {
    const genericError = new Error('connection reset');
    const { client, $transaction } = stubClient(genericError);

    await expect(forkGoldenSet(client, input)).rejects.toBe(genericError);
    expect($transaction).toHaveBeenCalledTimes(1);
  });
});

describe('GoldenSetVersionConflictError', () => {
  it('names itself, carries attempts, and its message states the count', () => {
    const error = new GoldenSetVersionConflictError(3);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('GoldenSetVersionConflictError');
    expect(error.attempts).toBe(3);
    expect(error.message).toContain('3');
  });
});
