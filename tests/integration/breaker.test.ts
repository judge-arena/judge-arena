import { afterAll, describe, expect, it } from 'vitest';
import { CIRCUIT_OPEN_MS, getBreaker } from '@/lib/llm/breaker-redis';
import { disconnectRedis, getConnectedRedis } from '@/lib/redis';

// Integration suite — needs a live Redis (see .env.test's REDIS_URL and the
// podman `judge-arena-redis` container). Run via `npm run test:integration`,
// never as part of plain `npm test` (see vitest.config.ts's exclude).

afterAll(async () => {
  await disconnectRedis();
});

describe('breaker-redis: getBreaker (shared, atomic, single-probe)', () => {
  it('starts closed for a fresh key', async () => {
    const breaker = getBreaker(`fresh-${Date.now()}`);
    await expect(breaker.allow()).resolves.toBe('closed');
  });

  it('fewer than the failure threshold does not open the circuit', async () => {
    const breaker = getBreaker(`below-threshold-${Date.now()}`);

    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- sequential by design, to deterministically stay under the 5-failure threshold
      await breaker.onFailure();
    }

    await expect(breaker.allow()).resolves.toBe('closed');
  });

  it('two breaker instances (two replicas) share state: 5 failures split across both open the circuit for both', async () => {
    const key = `replica-share-${Date.now()}`;
    const replicaA = getBreaker(key);
    const replicaB = getBreaker(key);

    await expect(replicaA.allow()).resolves.toBe('closed');
    await expect(replicaB.allow()).resolves.toBe('closed');

    // Split 5 failures across the two replicas, alternating — no single
    // replica ever sees 5 failures locally, only Redis does.
    for (let i = 0; i < 5; i += 1) {
      const replica = i % 2 === 0 ? replicaA : replicaB;
      // eslint-disable-next-line no-await-in-loop -- sequential by design, to deterministically cross the threshold on the 5th call
      await replica.onFailure();
    }

    // Both replicas observe the circuit as open — state lives in Redis, not
    // in either replica's local memory (there is none).
    await expect(replicaA.allow()).resolves.toBe('open');
    await expect(replicaB.allow()).resolves.toBe('open');
  });

  it('failures older than the 60s window do not count toward the threshold', async () => {
    const key = `stale-failures-${Date.now()}`;
    const breaker = getBreaker(key);

    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- sequential setup
      await breaker.onFailure();
    }

    // Backdate all 4 recorded failures to well outside the 60s window so
    // the rolling ZREMRANGEBYSCORE prunes them on the next onFailure() —
    // exercises the real Redis-persisted pruning path instead of sleeping
    // 60s in the test.
    const client = await getConnectedRedis();
    const members = await client.zRange(`cb:${key}:failures`, 0, -1);
    const longAgo = Date.now() - 120_000;
    for (const member of members) {
      // eslint-disable-next-line no-await-in-loop -- sequential setup
      await client.zAdd(`cb:${key}:failures`, { score: longAgo, value: member });
    }

    // A 5th failure now: the 4 stale ones are pruned first, so this is
    // "failure #1" of a fresh window, not the 5th — stays closed.
    await breaker.onFailure();
    await expect(breaker.allow()).resolves.toBe('closed');
  });

  it('only one of N concurrent allow() calls during half-open returns half_open_probe', async () => {
    const key = `half-open-race-${Date.now()}`;
    const breaker = getBreaker(key);

    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- sequential setup, to deterministically trip the breaker open
      await breaker.onFailure();
    }
    await expect(breaker.allow()).resolves.toBe('open');

    // Backdate openedAt so the 30s cooldown reads as already elapsed —
    // exercises the real elapsed-cooldown branch without sleeping 30s.
    const client = await getConnectedRedis();
    await client.hSet(`cb:${key}`, 'openedAt', String(Date.now() - CIRCUIT_OPEN_MS - 1000));

    const N = 10;
    const replicas = Array.from({ length: N }, () => getBreaker(key));
    const results = await Promise.all(replicas.map((b) => b.allow()));

    const probes = results.filter((r) => r === 'half_open_probe');
    const stillOpen = results.filter((r) => r === 'open');

    expect(probes.length).toBe(1);
    expect(stillOpen.length).toBe(N - 1);
  });

  it('success closes the circuit — observed by every replica (and clears the probe lock)', async () => {
    const key = `success-closes-${Date.now()}`;
    const replicaA = getBreaker(key);
    const replicaB = getBreaker(key);

    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- sequential setup
      await replicaA.onFailure();
    }
    await expect(replicaA.allow()).resolves.toBe('open');

    // replicaB is the one that calls onSuccess() — proving the reset isn't
    // scoped to whichever instance tripped the breaker.
    await replicaB.onSuccess();

    await expect(replicaA.allow()).resolves.toBe('closed');
    await expect(replicaB.allow()).resolves.toBe('closed');
  });

  it('a failed half-open probe reopens the circuit with a fresh cooldown and releases the probe slot', async () => {
    const key = `probe-fails-reopens-${Date.now()}`;
    const breaker = getBreaker(key);

    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- sequential setup
      await breaker.onFailure();
    }

    const client = await getConnectedRedis();
    await client.hSet(`cb:${key}`, 'openedAt', String(Date.now() - CIRCUIT_OPEN_MS - 1000));

    // Win the single probe slot.
    await expect(breaker.allow()).resolves.toBe('half_open_probe');
    // A second caller arriving mid-probe is turned away.
    await expect(breaker.allow()).resolves.toBe('open');

    // The probe fails.
    await breaker.onFailure();

    // Circuit is open again, with openedAt reset to "just now" — so it
    // does NOT immediately re-offer a probe (the cooldown restarted).
    await expect(breaker.allow()).resolves.toBe('open');

    // The probe lock itself was released (not left dangling for its old
    // 10s TTL) — verified directly, since allow() alone can't distinguish
    // "no one probing yet" from "someone else's stale probe lock".
    const probeLockValue = await client.get(`cb:${key}:probe`);
    expect(probeLockValue).toBeNull();
  });

  it('a successful half-open probe closes the circuit', async () => {
    const key = `probe-succeeds-closes-${Date.now()}`;
    const breaker = getBreaker(key);

    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- sequential setup
      await breaker.onFailure();
    }

    const client = await getConnectedRedis();
    await client.hSet(`cb:${key}`, 'openedAt', String(Date.now() - CIRCUIT_OPEN_MS - 1000));

    await expect(breaker.allow()).resolves.toBe('half_open_probe');
    await breaker.onSuccess();

    await expect(breaker.allow()).resolves.toBe('closed');
  });
});
