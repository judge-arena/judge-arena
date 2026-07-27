import { afterAll, describe, expect, it } from 'vitest';
import { createLimiter } from '@/lib/rate-limit-redis';
import { disconnectRedis, redisHealthy } from '@/lib/redis';

// Integration suite — needs a live Redis (see .env.test's REDIS_URL and the
// podman `judge-arena-redis` container). Run via `npm run test:integration`,
// never as part of plain `npm test` (see vitest.config.ts's exclude).

afterAll(async () => {
  // Close the singleton connection so `vitest run` can exit cleanly instead
  // of hanging on an open Redis socket.
  await disconnectRedis();
});

describe('redisHealthy()', () => {
  it('PINGs the running Redis container and resolves true', async () => {
    await expect(redisHealthy()).resolves.toBe(true);
  });
});

describe('rate-limit-redis: createLimiter (atomic Lua sliding window)', () => {
  it('atomicity: 30 concurrent checks against a limit of 20 admit exactly 20', async () => {
    // A unique limiter name per test run avoids collisions with any
    // leftover key from a previous run/other suite sharing this Redis.
    const limiter = createLimiter(`atomicity-${Date.now()}`, 20, 60);

    const results = await Promise.all(
      Array.from({ length: 30 }, () => limiter.check('shared-key'))
    );

    const okCount = results.filter((r) => r.ok).length;
    const deniedCount = results.filter((r) => !r.ok).length;

    // The Lua script's ZREMRANGEBYSCORE+ZCARD+ZADD+PEXPIRE sequence runs as
    // one atomic EVAL, so there's no read/check/write race window for 30
    // concurrent Node-side calls to over-admit through — exactly `limit`
    // (20) must succeed, no more, no fewer.
    expect(okCount).toBe(20);
    expect(deniedCount).toBe(10);

    // Denied results still report a sane remaining/resetAt.
    const denied = results.find((r) => !r.ok);
    expect(denied?.remaining).toBe(0);
    expect(denied?.resetAt).toBeGreaterThan(Date.now());
  });

  it('window expiry: a denied key is allowed again once the window elapses', async () => {
    const limiter = createLimiter(`expiry-${Date.now()}`, 1, 1); // limit 1, 1s window

    const first = await limiter.check('solo-key');
    expect(first.ok).toBe(true);
    expect(first.remaining).toBe(0);

    const second = await limiter.check('solo-key');
    expect(second.ok).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const third = await limiter.check('solo-key');
    expect(third.ok).toBe(true);
  });

  it('two limiter instances (simulating two replicas) share one Redis-backed budget', async () => {
    // Same name + same key => same Redis sorted set (`rl:{name}:{key}`),
    // regardless of which JS object issued the call. This is what makes
    // the limiter correct across multiple app replicas: there's no
    // in-process state to desync, only the shared Redis key.
    const name = `replica-shared-${Date.now()}`;
    const replicaA = createLimiter(name, 5, 60);
    const replicaB = createLimiter(name, 5, 60);

    const results: boolean[] = [];
    for (let i = 0; i < 8; i += 1) {
      const limiter = i % 2 === 0 ? replicaA : replicaB;
      // eslint-disable-next-line no-await-in-loop -- sequential by design, to prove shared state without relying on the atomicity test's concurrency
      const result = await limiter.check('shared-across-replicas');
      results.push(result.ok);
    }

    expect(results.filter(Boolean).length).toBe(5);
    expect(results).toEqual([true, true, true, true, true, false, false, false]);
  });

  it('different limiter names never collide, even against the same key', async () => {
    const key = `no-collision-${Date.now()}`;
    const limiterA = createLimiter('no-collision-a', 1, 60);
    const limiterB = createLimiter('no-collision-b', 1, 60);

    expect((await limiterA.check(key)).ok).toBe(true);
    // Would be false if both limiters shared a Redis key.
    expect((await limiterB.check(key)).ok).toBe(true);
  });

  it('remaining decrements correctly across sequential check() calls on one key', async () => {
    const limiter = createLimiter(`remaining-${Date.now()}`, 5, 60);
    const key = 'single-key';

    const check1 = await limiter.check(key);
    expect(check1.ok).toBe(true);
    expect(check1.remaining).toBe(4);

    const check2 = await limiter.check(key);
    expect(check2.ok).toBe(true);
    expect(check2.remaining).toBe(3);

    const check3 = await limiter.check(key);
    expect(check3.ok).toBe(true);
    expect(check3.remaining).toBe(2);

    const check4 = await limiter.check(key);
    expect(check4.ok).toBe(true);
    expect(check4.remaining).toBe(1);

    const check5 = await limiter.check(key);
    expect(check5.ok).toBe(true);
    expect(check5.remaining).toBe(0);

    // Next call should be denied with remaining=0
    const check6 = await limiter.check(key);
    expect(check6.ok).toBe(false);
    expect(check6.remaining).toBe(0);
  });

  it('two different keys under the same limiter are tracked independently', async () => {
    const limiter = createLimiter(`independent-keys-${Date.now()}`, 2, 60);

    // Key A: use up its budget
    const keyA1 = await limiter.check('key-a');
    expect(keyA1.ok).toBe(true);
    expect(keyA1.remaining).toBe(1);

    const keyA2 = await limiter.check('key-a');
    expect(keyA2.ok).toBe(true);
    expect(keyA2.remaining).toBe(0);

    // Key A is now exhausted
    const keyA3 = await limiter.check('key-a');
    expect(keyA3.ok).toBe(false);

    // Key B should still have its full budget, unaffected by A's exhaustion
    const keyB1 = await limiter.check('key-b');
    expect(keyB1.ok).toBe(true);
    expect(keyB1.remaining).toBe(1);

    const keyB2 = await limiter.check('key-b');
    expect(keyB2.ok).toBe(true);
    expect(keyB2.remaining).toBe(0);

    // Key B is now also exhausted
    const keyB3 = await limiter.check('key-b');
    expect(keyB3.ok).toBe(false);
  });
});
