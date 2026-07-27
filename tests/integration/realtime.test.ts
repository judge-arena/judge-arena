import { afterAll, describe, expect, it, vi } from 'vitest';

// Integration suite — needs a live Redis (see .env.test's REDIS_URL and the
// podman `judge-arena-redis` container). Run via `npm run test:integration`,
// never as part of plain `npm test` (see vitest.config.ts's exclude).
//
// Every test here constructs RedisRealtimeEventBus directly (bypassing
// createRealtimeBus()/factory.ts's NODE_ENV=test => in-memory branch) so
// it's the real Redis-backed adapter under test throughout, except the
// last test which exercises the factory explicitly to prove it doesn't
// silently fall back to in-memory in production.
//
// '@/lib/redis' is wrapped (not replaced) so every test but the last one
// gets the real getConnectedRedis() implementation — only the "Redis down"
// test overrides it, and only for a single call (mockRejectedValueOnce).
vi.mock('@/lib/redis', async () => {
  const actual = await vi.importActual<typeof import('@/lib/redis')>('@/lib/redis');
  return {
    ...actual,
    getConnectedRedis: vi.fn(actual.getConnectedRedis),
  };
});

const { getConnectedRedis, disconnectRedis } = await import('@/lib/redis');
const { RedisRealtimeEventBus, closeRealtimeRedisConnections } = await import(
  '@/lib/realtime/redis-bus'
);
const { userTopic, runTopic } = await import('@/lib/realtime/types');
const { createRealtimeBus } = await import('@/lib/realtime/factory');

import type {
  DatasetSummaryUpdatedPayload,
  JudgmentCompletedPayload,
  RealtimeEnvelope,
} from '@/lib/realtime/types';

const SAMPLE_SUMMARY: DatasetSummaryUpdatedPayload['summary'] = {
  updatedAt: new Date().toISOString(),
  sampleCount: 3,
  samplesWithModelScores: 3,
  samplesWithHumanScores: 1,
  averageModelScore: 7.5,
  averageHumanScore: 8,
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

afterAll(async () => {
  // Close both the shared publisher/XADD connection and the realtime bus's
  // shared subscriber connection so `vitest run` can exit cleanly instead
  // of hanging on an open Redis socket.
  await closeRealtimeRedisConnections();
  await disconnectRedis();
});

describe('RedisRealtimeEventBus: cross-client delivery', () => {
  it('delivers an event published from one bus instance to a subscriber registered on a fresh bus instance', async () => {
    const topic = userTopic(`xclient-${Date.now()}`);
    const publisherBus = new RedisRealtimeEventBus();
    const subscriberBus = new RedisRealtimeEventBus();

    const { promise: received, resolve } = deferred<RealtimeEnvelope>();
    const unsubscribe = await subscriberBus.subscribe(topic, resolve);

    try {
      await publisherBus.publish(topic, {
        type: 'dataset.summary.updated',
        payload: { datasetId: 'ds-xclient', summary: SAMPLE_SUMMARY },
      });

      const event = await received;
      expect(event.type).toBe('dataset.summary.updated');
      expect((event.payload as DatasetSummaryUpdatedPayload).datasetId).toBe('ds-xclient');
      expect(typeof event.id).toBe('string');
      expect(event.id.length).toBeGreaterThan(0);
    } finally {
      unsubscribe();
    }
  }, 10000);
});

describe('RedisRealtimeEventBus: ownership scoping', () => {
  it("never delivers an event published on user B's topic to a subscriber on user A's topic", async () => {
    const topicA = userTopic(`scope-a-${Date.now()}`);
    const topicB = userTopic(`scope-b-${Date.now()}`);
    const bus = new RedisRealtimeEventBus();

    const receivedOnA: RealtimeEnvelope[] = [];
    const unsubscribeA = await bus.subscribe(topicA, (event) => receivedOnA.push(event));

    const { promise: receivedOnB, resolve: resolveB } = deferred<RealtimeEnvelope>();
    const unsubscribeB = await bus.subscribe(topicB, resolveB);

    try {
      await bus.publish(topicB, {
        type: 'dataset.summary.updated',
        payload: { datasetId: 'ds-scope-b', summary: SAMPLE_SUMMARY },
      });

      // Prove delivery actually works end-to-end first (so an empty
      // receivedOnA below isn't just "nothing published yet") — the
      // topic-B subscriber must receive it.
      const eventOnB = await receivedOnB;
      expect((eventOnB.payload as DatasetSummaryUpdatedPayload).datasetId).toBe('ds-scope-b');

      // The topic-A subscriber (a different user) must never see it.
      expect(receivedOnA).toHaveLength(0);
    } finally {
      unsubscribeA();
      unsubscribeB();
    }
  }, 10000);
});

describe('RedisRealtimeEventBus: resume via XRANGE', () => {
  it('replaySince(topic, id-of-#1) returns exactly #2 and #3, in order', async () => {
    const topic = runTopic(`resume-${Date.now()}`);
    const bus = new RedisRealtimeEventBus();

    const event1 = await bus.publish(topic, {
      type: 'judgment.completed',
      payload: { runId: 'run-resume', judgmentId: 'j-1', status: 'completed' },
    });
    const event2 = await bus.publish(topic, {
      type: 'judgment.completed',
      payload: { runId: 'run-resume', judgmentId: 'j-2', status: 'completed' },
    });
    const event3 = await bus.publish(topic, {
      type: 'judgment.completed',
      payload: { runId: 'run-resume', judgmentId: 'j-3', status: 'completed' },
    });

    const replayed = await bus.replaySince(topic, event1.id);

    expect(replayed.map((event) => event.id)).toEqual([event2.id, event3.id]);
    expect(
      replayed.map((event) => (event.payload as JudgmentCompletedPayload).judgmentId)
    ).toEqual(['j-2', 'j-3']);

    // Replaying from #3's id returns nothing further.
    const replayedFromLast = await bus.replaySince(topic, event3.id);
    expect(replayedFromLast).toEqual([]);
  });
});

describe('RedisRealtimeEventBus: publish failure propagation', () => {
  it('publish() throws (no silent local fallback) when Redis is unreachable, even under a production NODE_ENV stub', async () => {
    vi.mocked(getConnectedRedis).mockRejectedValueOnce(
      new Error('connect ECONNREFUSED 127.0.0.1:6379')
    );

    vi.stubEnv('NODE_ENV', 'production');
    try {
      const bus = createRealtimeBus();

      // The factory must not silently downgrade to the in-memory adapter
      // just because Redis happens to be unreachable at this instant —
      // production always gets a Redis-backed bus; an outage surfaces as a
      // thrown error from publish(), which is the caller's job to handle.
      expect(bus.name).toBe('redis');

      await expect(
        bus.publish(userTopic('redis-down-test-user'), {
          type: 'dataset.summary.updated',
          payload: { datasetId: 'ds-down', summary: SAMPLE_SUMMARY },
        })
      ).rejects.toThrow('ECONNREFUSED');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
