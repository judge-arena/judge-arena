import { describe, expect, it, vi } from 'vitest';
import type { Channel, ConsumeMessage } from 'amqplib';
import { QUEUE_JUDGMENT_EXECUTE, QUEUE_RUN_CREATE } from '@/lib/queue/topology';
import type { JudgmentExecuteMsg } from '@/lib/queue/publish';
import { handleDispatchFailure } from '@/worker/dispatch-failure';

// Unit suite for main.ts's dispatch()-failure decision, extracted into
// `handleDispatchFailure` (src/worker/dispatch-failure.ts) precisely so it
// can be exercised here with a mocked `Channel` and an injected
// `publishJudgmentRetry30s`, with no live RabbitMQ connection and without
// importing main.ts itself (which calls `main()` at module scope). See
// tests/integration/worker-claims.test.ts for the same fakeMessage/
// fakeChannel shape used against the real consumers.

// ─── Fake amqplib primitives ────────────────────────────────────────────────

function fakeMessage(payload: unknown, redelivered: boolean): ConsumeMessage {
  return {
    content: Buffer.from(JSON.stringify(payload)),
    fields: { redelivered } as ConsumeMessage['fields'],
    properties: {} as ConsumeMessage['properties'],
  } as ConsumeMessage;
}

interface SpyChannel extends Channel {
  ackCalls: ConsumeMessage[];
  nackCalls: Array<{ msg: ConsumeMessage; allUpTo: boolean; requeue: boolean }>;
}

function fakeChannel(): SpyChannel {
  const ackCalls: ConsumeMessage[] = [];
  const nackCalls: SpyChannel['nackCalls'] = [];
  return {
    ack: (msg: ConsumeMessage) => {
      ackCalls.push(msg);
    },
    nack: (msg: ConsumeMessage, allUpTo?: boolean, requeue?: boolean) => {
      nackCalls.push({ msg, allUpTo: Boolean(allUpTo), requeue: Boolean(requeue) });
    },
    ackCalls,
    nackCalls,
  } as unknown as SpyChannel;
}

const judgmentMsg: JudgmentExecuteMsg = { judgmentId: 'j1', runId: 'r1', attempt: 2 };

describe('handleDispatchFailure', () => {
  it('redelivered judgment.execute: routes to judgment.retry.30s with attempt preserved, then acks (no nack)', async () => {
    const ch = fakeChannel();
    const raw = fakeMessage(judgmentMsg, true);
    const publishJudgmentRetry30s = vi.fn().mockResolvedValue(undefined);

    await handleDispatchFailure(ch, raw, QUEUE_JUDGMENT_EXECUTE, new Error('boom'), {
      publishJudgmentRetry30s,
    });

    expect(publishJudgmentRetry30s).toHaveBeenCalledTimes(1);
    expect(publishJudgmentRetry30s).toHaveBeenCalledWith(judgmentMsg);
    expect(ch.ackCalls).toEqual([raw]);
    expect(ch.nackCalls).toEqual([]);
  });

  it('first-delivery judgment.execute: nack-requeues without publishing to the retry queue', async () => {
    const ch = fakeChannel();
    const raw = fakeMessage(judgmentMsg, false);
    const publishJudgmentRetry30s = vi.fn().mockResolvedValue(undefined);

    await handleDispatchFailure(ch, raw, QUEUE_JUDGMENT_EXECUTE, new Error('boom'), {
      publishJudgmentRetry30s,
    });

    expect(publishJudgmentRetry30s).not.toHaveBeenCalled();
    expect(ch.ackCalls).toEqual([]);
    expect(ch.nackCalls).toEqual([{ msg: raw, allUpTo: false, requeue: true }]);
  });

  it('redelivered run.create: nack-requeues — no retry queue exists for run.create', async () => {
    const ch = fakeChannel();
    const raw = fakeMessage({ evaluationId: 'e1' }, true);
    const publishJudgmentRetry30s = vi.fn().mockResolvedValue(undefined);

    await handleDispatchFailure(ch, raw, QUEUE_RUN_CREATE, new Error('boom'), {
      publishJudgmentRetry30s,
    });

    expect(publishJudgmentRetry30s).not.toHaveBeenCalled();
    expect(ch.ackCalls).toEqual([]);
    expect(ch.nackCalls).toEqual([{ msg: raw, allUpTo: false, requeue: true }]);
  });

  it('retry-publish itself throwing falls back to nack-requeue rather than propagating', async () => {
    const ch = fakeChannel();
    const raw = fakeMessage(judgmentMsg, true);
    const publishJudgmentRetry30s = vi.fn().mockRejectedValue(new Error('broker unreachable'));

    await expect(
      handleDispatchFailure(ch, raw, QUEUE_JUDGMENT_EXECUTE, new Error('boom'), {
        publishJudgmentRetry30s,
      })
    ).resolves.toBeUndefined();

    expect(publishJudgmentRetry30s).toHaveBeenCalledTimes(1);
    expect(ch.ackCalls).toEqual([]);
    expect(ch.nackCalls).toEqual([{ msg: raw, allUpTo: false, requeue: true }]);
  });
});
