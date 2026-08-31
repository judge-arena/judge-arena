import { describe, expect, it } from 'vitest';
import {
  GATE_WAIT_TIMEOUT_MS,
  HARD_CONCURRENCY_CAP,
  JudgeGateTimeoutError,
  MAX_IN_FLIGHT_MESSAGES,
  createKeyedGate,
  judgeGateKey,
  resolveWorkerConcurrency,
} from '@/worker/concurrency';

/** Yield past microtasks AND one macrotask turn, so anything that was going
 *  to resolve "immediately" has had every chance to. Used to assert that
 *  something did NOT happen — the only honest way to test a negative here. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

describe('per-judge concurrency — a HARD cap, not a default', () => {
  it('clamps any request above the cap, and reports that it did', () => {
    // The configuration is allowed to ask (env.ts permits 1-16). It is not
    // allowed to get. Asking must not throw — only fail to take effect.
    for (const asked of ['2', '4', '8', '16']) {
      const r = resolveWorkerConcurrency(asked);
      expect(r.effective).toBe(HARD_CONCURRENCY_CAP);
      expect(r.capped).toBe(true);
      expect(r.requested).toBe(Number(asked));
    }
  });

  it('does not flag capped when the request is already at or below the cap', () => {
    const r = resolveWorkerConcurrency('1');
    expect(r.effective).toBe(1);
    expect(r.capped).toBe(false);
  });

  it('defaults to the env default of 2 and clamps it', () => {
    const r = resolveWorkerConcurrency(undefined);
    expect(r.requested).toBe(2);
    expect(r.effective).toBe(1);
    expect(r.capped).toBe(true);
  });

  it('floors garbage and sub-1 values to 1 rather than throwing', () => {
    // This runs at module load in the worker entrypoint. A boot crash over a
    // typo'd env var is a worse failure than quietly doing the safe thing.
    for (const bad of ['', 'two', 'NaN', '0', '-5', '0.5']) {
      const r = resolveWorkerConcurrency(bad);
      expect(r.effective).toBe(1);
      expect(Number.isFinite(r.requested)).toBe(true);
      expect(r.requested).toBeGreaterThanOrEqual(1);
    }
  });

  it('truncates a fractional request rather than carrying a float around', () => {
    expect(resolveWorkerConcurrency('2.7').requested).toBe(2);
    expect(Number.isInteger(resolveWorkerConcurrency('2.7').effective)).toBe(true);
  });
});

describe('prefetch is a DIFFERENT quantity from the per-judge cap', () => {
  it('is a constant the configuration cannot influence', () => {
    // The old shape returned `prefetch` from resolveWorkerConcurrency(), tying
    // the total in-flight ceiling to a knob whose name says "per run". That
    // coupling is exactly how eight concurrent calls reached a two-slot
    // server. The function no longer exposes a prefetch at all.
    for (const asked of [undefined, '1', '2', '8', '16', 'garbage']) {
      expect(resolveWorkerConcurrency(asked)).not.toHaveProperty('prefetch');
    }
    expect(Number.isInteger(MAX_IN_FLIGHT_MESSAGES)).toBe(true);
  });

  it('exceeds the per-judge cap — that gap IS the feature', () => {
    // Prefetch bounds how many DIFFERENT judges can be in flight; the cap
    // bounds calls to any ONE of them. Collapsing them back to equality would
    // re-serialize the whole fleet behind whichever server is slowest, which
    // is the 22-minute block this change exists to remove.
    expect(MAX_IN_FLIGHT_MESSAGES).toBeGreaterThan(HARD_CONCURRENCY_CAP);
    expect(HARD_CONCURRENCY_CAP).toBe(1);
  });

  it('keeps the worst-case gate park inside the RabbitMQ consumer_timeout budget', () => {
    // The two constants are one design. Worst-case park is bounded by
    // (prefetch - 1) x per-item latency because only that many deliveries can
    // be parked at once; the gate timeout must sit above that and, added to
    // the post-gate work (LEASE_MS = 330s in production), well below
    // RabbitMQ's 30-minute consumer_timeout — which closes the SHARED confirm
    // channel and stops this worker consuming at all.
    const CONSUMER_TIMEOUT_MS = 30 * 60_000;
    const WORST_POST_GATE_WORK_MS = 330_000;
    const WORST_ITEM_LATENCY_MS = 95_100; // measured, run cmthr58r100013s0sykuvn41x

    expect((MAX_IN_FLIGHT_MESSAGES - 1) * WORST_ITEM_LATENCY_MS).toBeLessThan(GATE_WAIT_TIMEOUT_MS);
    expect(GATE_WAIT_TIMEOUT_MS + WORST_POST_GATE_WORK_MS).toBeLessThan(CONSUMER_TIMEOUT_MS / 1.5);
  });
});

describe('judgeGateKey — what a NULL judgeModelVersionId means', () => {
  it('keys on the judge version when there is one, so every judgment for it shares a lane', () => {
    expect(judgeGateKey('j1', 'v1')).toBe(judgeGateKey('j2', 'v1'));
    expect(judgeGateKey('j1', 'v1')).not.toBe(judgeGateKey('j1', 'v2'));
  });

  it('gives a NULL version its own per-judgment lane — not one shared null lane', () => {
    // A shared `judge:null` key would collapse every null-version judgment in
    // the system into one global serial queue: fleet-wide serialization
    // reintroduced through the back door on a subset of rows.
    expect(judgeGateKey('j1', null)).not.toBe(judgeGateKey('j2', null));
    expect(judgeGateKey('j1', undefined)).not.toBe(judgeGateKey('j2', undefined));
    expect(judgeGateKey('j1', null)).toBe(judgeGateKey('j1', undefined));
  });

  it('does not bypass the gate for a NULL version — it still returns a key', () => {
    // "Skip the gate when the key is missing" is the hole that stops
    // protecting anything the day another code path leaves the column null.
    // Safe because judgment-consumer.ts errors such a row out before any
    // provider seam runs, so there is no server to over-subscribe.
    expect(judgeGateKey('j1', null)).toBeTypeOf('string');
    expect(judgeGateKey('j1', null).length).toBeGreaterThan(0);
    expect(judgeGateKey('j1', null)).not.toBe(judgeGateKey('j1', 'v1'));
  });
});

describe('keyed gate — different judges in parallel, one judge sequential', () => {
  it('lets DIFFERENT judge keys proceed concurrently', async () => {
    // The feature. Two judges on two machines contend for nothing, so holding
    // a permit for one must not delay the other by a single tick.
    //
    // Keys come from `judgeGateKey`, not from string literals, so that a
    // regression in the KEYING (e.g. someone collapsing it to one constant)
    // breaks the parallelism test too, not only judgeGateKey's own unit tests.
    const gate = createKeyedGate();
    const qwen = judgeGateKey('judgment-1', 'version-qwen');
    const granite = judgeGateKey('judgment-2', 'version-granite');

    const releaseA = await gate.acquire(qwen, 50);
    // Bounded wait, so a regression that serialized these fails fast with a
    // JudgeGateTimeoutError instead of hanging the suite.
    const releaseB = await gate.acquire(granite, 50);

    expect(gate.heldKeys()).toBe(2);
    expect(gate.waiting(qwen)).toBe(0);
    expect(gate.waiting(granite)).toBe(0);

    releaseA();
    releaseB();
    expect(gate.heldKeys()).toBe(0);
  });

  it('lets two judgments with DIFFERENT judges run at once, and the same judge not', async () => {
    // The two halves of the property in one place, both keyed the way
    // judgment-consumer.ts keys them: a judgment's lane is its judge's lane.
    const gate = createKeyedGate();
    const sameJudgeA = judgeGateKey('judgment-a', 'version-qwen');
    const sameJudgeB = judgeGateKey('judgment-b', 'version-qwen');
    const otherJudge = judgeGateKey('judgment-c', 'version-granite');

    const held = await gate.acquire(sameJudgeA, 1_000);

    // A different judge is admitted immediately...
    const other = await gate.acquire(otherJudge, 50);
    // ...and a second judgment for the SAME judge is not.
    await expect(gate.acquire(sameJudgeB, 20)).rejects.toBeInstanceOf(JudgeGateTimeoutError);

    held();
    other();
  });

  it('serializes the SAME judge key — the second call does not START until the first releases', async () => {
    // The safety property. Asserted as ORDERING, not as a count: a count of 1
    // in-flight is also satisfied by the second call never running at all.
    const gate = createKeyedGate();
    const order: string[] = [];

    const release1 = await gate.acquire('judge:qwen', 1_000);
    order.push('first:enter');

    const second = gate.acquire('judge:qwen', 1_000).then((release) => {
      order.push('second:enter');
      return release;
    });

    await settle();
    // Nothing the second caller does has happened yet, and the gate agrees.
    expect(order).toEqual(['first:enter']);
    expect(gate.waiting('judge:qwen')).toBe(1);

    order.push('first:exit');
    release1();

    const release2 = await second;
    expect(order).toEqual(['first:enter', 'first:exit', 'second:enter']);
    release2();
  });

  it('serializes a queue of same-key waiters in FIFO order', async () => {
    const gate = createKeyedGate();
    const order: number[] = [];

    const first = await gate.acquire('judge:qwen', 1_000);
    const rest = [1, 2, 3].map((n) =>
      gate.acquire('judge:qwen', 1_000).then((release) => {
        order.push(n);
        return release;
      })
    );

    await settle();
    expect(order).toEqual([]);
    expect(gate.waiting('judge:qwen')).toBe(3);

    first();
    // Each waiter releases in turn, so the whole queue drains one at a time.
    for (const pending of rest) {
      // eslint-disable-next-line no-await-in-loop -- the serialization under test IS the ordering; running these in parallel would destroy what is being asserted
      const release = await pending;
      release();
    }
    expect(order).toEqual([1, 2, 3]);
    expect(gate.heldKeys()).toBe(0);
  });

  it('releases the permit when the critical section THROWS', async () => {
    // Without the finally, one unexpected error wedges that judge for the life
    // of the process: every later message waits out the full timeout and
    // requeues, forever, while the server sits idle.
    const gate = createKeyedGate();

    await expect(
      gate.runExclusive(
        'judge:qwen',
        async () => {
          throw new Error('persist blew up');
        },
        1_000
      )
    ).rejects.toThrow('persist blew up');

    expect(gate.heldKeys()).toBe(0);

    // Provable, not just inferred from the counter: the next caller gets in.
    const order: string[] = [];
    await gate.runExclusive(
      'judge:qwen',
      async () => {
        order.push('next-message-ran');
      },
      50
    );
    expect(order).toEqual(['next-message-ran']);
  });

  it('runExclusive returns the value and frees the lane on success', async () => {
    const gate = createKeyedGate();
    await expect(gate.runExclusive('judge:qwen', async () => 'ok', 50)).resolves.toBe('ok');
    expect(gate.heldKeys()).toBe(0);
  });

  it('is idempotent on double-release — a second call must not hand out a second permit', async () => {
    const gate = createKeyedGate();
    const release = await gate.acquire('judge:qwen', 1_000);

    const entered: string[] = [];
    const waiter = gate.acquire('judge:qwen', 1_000).then((r) => {
      entered.push('waiter');
      return r;
    });

    release();
    release(); // a caller that releases in both a catch and a finally
    await settle();

    // Exactly one waiter admitted, and the lane is held by it — not freed
    // underneath it by the second release.
    expect(entered).toEqual(['waiter']);
    expect(gate.heldKeys()).toBe(1);
    (await waiter)();
    expect(gate.heldKeys()).toBe(0);
  });
});

describe('keyed gate — the bounded wait', () => {
  it('times out instead of waiting forever, and signals REQUEUE via a typed error', async () => {
    // Unbounded waiting walks into RabbitMQ's 30-minute consumer_timeout,
    // which closes the shared confirm channel and stops this worker consuming
    // at all. The distinct error class is what lets judgment-consumer.ts pick
    // nack-requeue without confusing this for a provider or persist failure.
    const gate = createKeyedGate();
    const release = await gate.acquire('judge:qwen', 1_000);

    const error = await gate.acquire('judge:qwen', 20).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(JudgeGateTimeoutError);
    const timeout = error as JudgeGateTimeoutError;
    expect(timeout.key).toBe('judge:qwen');
    expect(timeout.waitedMs).toBeGreaterThanOrEqual(0);
    expect(timeout.message).toContain('judge:qwen');
    release();
  });

  it('does not hand the permit to a waiter that already timed out', async () => {
    // That waiter's delivery has been nack-requeued; nothing will ever call
    // its release. Granting it the permit would hold the lane forever and stop
    // that judge making progress until the process restarts.
    const gate = createKeyedGate();
    const release = await gate.acquire('judge:qwen', 1_000);

    await expect(gate.acquire('judge:qwen', 20)).rejects.toBeInstanceOf(JudgeGateTimeoutError);
    expect(gate.waiting('judge:qwen')).toBe(0);

    release();
    // Freed, not stranded: a fresh delivery acquires immediately.
    const next = await gate.acquire('judge:qwen', 20);
    expect(gate.heldKeys()).toBe(1);
    next();
  });

  it('runExclusive never runs the body when the wait times out', async () => {
    // The requeue path must be indistinguishable from "this delivery did
    // nothing": no claim, no provider call, no write.
    const gate = createKeyedGate();
    const release = await gate.acquire('judge:qwen', 1_000);

    let ran = false;
    await expect(
      gate.runExclusive(
        'judge:qwen',
        async () => {
          ran = true;
        },
        20
      )
    ).rejects.toBeInstanceOf(JudgeGateTimeoutError);

    expect(ran).toBe(false);
    release();
  });

  it('a timeout on one judge does not disturb another judge already running', async () => {
    const gate = createKeyedGate();
    const busy = await gate.acquire('judge:qwen', 1_000);
    const other = await gate.acquire('judge:granite', 1_000);

    await expect(gate.acquire('judge:qwen', 20)).rejects.toBeInstanceOf(JudgeGateTimeoutError);

    expect(gate.waiting('judge:granite')).toBe(0);
    expect(gate.heldKeys()).toBe(2);
    busy();
    other();
    expect(gate.heldKeys()).toBe(0);
  });
});
