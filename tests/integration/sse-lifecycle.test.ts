import { afterAll, describe, expect, it, vi } from 'vitest';

// Integration suite — needs a live Redis (see .env.test's REDIS_URL and the
// podman `judge-arena-redis` container). Run via `npm run test:integration`,
// never as part of plain `npm test` (see vitest.config.ts's exclude).
//
// This file is dedicated to the SSE route's (src/app/api/events/route.ts)
// abort-before-subscribe race: a client can disconnect while
// replayTopicSince()/subscribeTopic() are still in flight, and the fix
// under test is that cleanup() always runs exactly once and always tears
// down whatever subscription eventually materializes — never leaking a
// listener in the process-wide realtime bus singleton or an orphaned Redis
// SUBSCRIBE with no consumer.
//
// `NODE_ENV` is forced to 'production' *before* anything imports
// '@/lib/realtime/events' (dynamically, below) so that module's
// `createRealtimeBus()` singleton picks the real `RedisRealtimeEventBus`
// instead of the NODE_ENV=test in-memory adapter (see factory.ts) — this
// suite needs to observe actual Redis PUBSUB/(un)subscribe behavior, the
// same way tests/integration/realtime.test.ts does by constructing
// RedisRealtimeEventBus directly. Route handlers can't be pointed at a bus
// instance directly (it's a module-private singleton inside events.ts), so
// this is the only way to get the real adapter under the route itself.
vi.stubEnv('NODE_ENV', 'production');

// Auth is irrelevant to the race being tested — bypass it entirely rather
// than standing up a real NextAuth session/DB user. No `?run=` query param
// is ever used below, so `prisma` is never touched either.
const TEST_USER_ID = 'sse-lifecycle-test-user';
vi.mock('@/lib/auth-guard', () => ({
  requireAuth: vi.fn(async () => ({
    user: {
      id: 'sse-lifecycle-test-user',
      email: 'sse-lifecycle@example.com',
      name: null,
      role: 'user',
    },
  })),
  requireScope: vi.fn(() => null),
}));

// Partial mock: every export passes through to the real module (so
// replayTopicSince/getRealtimeSubscriberCount/userTopic/etc., and the
// underlying realtime bus singleton itself, are all genuine) except
// `subscribeTopic`, which is wrapped with an artificial 50ms delay before
// it calls through to the real implementation. That delay is what makes the
// abort-during-subscribe race deterministically reproducible: the test
// aborts at 10ms, well before this resolves.
vi.mock('@/lib/realtime/events', async () => {
  const actual = await vi.importActual<typeof import('@/lib/realtime/events')>(
    '@/lib/realtime/events'
  );
  return {
    ...actual,
    subscribeTopic: vi.fn(async (topic: string, listener: Parameters<typeof actual.subscribeTopic>[1]) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return actual.subscribeTopic(topic, listener);
    }),
  };
});

const { GET } = await import('@/app/api/events/route');
const { getRealtimeSubscriberCount, userTopic } = await import('@/lib/realtime/events');
const { closeRealtimeRedisConnections } = await import('@/lib/realtime/redis-bus');
const { getConnectedRedis, disconnectRedis } = await import('@/lib/redis');

const TOPIC = userTopic(TEST_USER_ID);

afterAll(async () => {
  vi.unstubAllEnvs();
  // Close both the shared publisher connection and the realtime bus's
  // shared subscriber connection so `vitest run` can exit cleanly instead
  // of hanging on an open Redis socket.
  await closeRealtimeRedisConnections();
  await disconnectRedis();
});

/** No listener left anywhere on the process-wide bus singleton, and no
 * orphaned Redis channel subscription for this test's topic specifically. */
async function assertFullyCleanedUp(baselineListenerCount: number): Promise<void> {
  expect(getRealtimeSubscriberCount()).toBe(baselineListenerCount);

  const client = await getConnectedRedis();
  const channels = await client.pubSubChannels(TOPIC);
  expect(channels).toEqual([]);
}

describe('SSE route: abort-before-subscribe race (src/app/api/events/route.ts)', () => {
  it('aborting mid-subscribe leaves no listener and no orphaned Redis SUBSCRIBE once the delayed subscribeTopic() resolves', async () => {
    const baselineListenerCount = getRealtimeSubscriberCount();

    const abortController = new AbortController();
    const request = new Request('http://localhost/api/events', {
      signal: abortController.signal,
    });

    // Fires while route.ts's `await subscribeTopic(topic, emit)` is still
    // pending inside the mocked 50ms delay — this is the race: the abort
    // listener must already be registered (it's registered before the
    // ReadableStream is even constructed) so cleanup() runs immediately,
    // and the subscription that later materializes at ~50ms must still get
    // torn down even though cleanup() already ran once.
    setTimeout(() => abortController.abort(), 10);

    const response = await GET(request);
    expect(response.status).toBe(200);

    // Let the delayed subscribeTopic() resolve, the real Redis SUBSCRIBE
    // round-trip complete, and the resulting direct unsubscribe() (see
    // route.ts's `if (cleanedUp) { unsubscribe(); return; }`) fully settle.
    await new Promise((resolve) => setTimeout(resolve, 400));

    await assertFullyCleanedUp(baselineListenerCount);
  }, 10000);
});

describe('SSE route: ReadableStream cancel() backstop', () => {
  it('cancelling the stream directly (no request.signal abort) also cleans up a subscription still in flight', async () => {
    const baselineListenerCount = getRealtimeSubscriberCount();

    // Deliberately no AbortController/signal at all — request.signal never
    // fires. Only the ReadableStream's own cancel() runs, proving it's a
    // real backstop for consumer-side cancellation and not dead code
    // shadowed by the abort-listener path exercised above.
    const request = new Request('http://localhost/api/events');
    const response = await GET(request);
    expect(response.status).toBe(200);
    expect(response.body).not.toBeNull();

    // subscribeTopic() is still inside its artificial 50ms delay here —
    // cancel well before it resolves.
    await response.body?.cancel('test-consumer-cancelled');

    await new Promise((resolve) => setTimeout(resolve, 400));

    await assertFullyCleanedUp(baselineListenerCount);
  }, 10000);
});
