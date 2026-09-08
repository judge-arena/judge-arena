import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * EVERY provider seam must carry the timeout-escalation context.
 *
 * ── THE BUG THIS FILE EXISTS FOR ────────────────────────────────────────────
 *
 * `sha-414e826a3ba3` shipped the escalating 5→15 minute timeout and wired it
 * into ONE of the three seams. `defaultRunProviderJudgment` (pointwise) got
 * it; `defaultRunProviderPairwise` and `defaultRunProviderResponse` did not.
 * Calibration is pairwise, so the path the feature was requested for was the
 * one path it never reached.
 *
 * IT FAILED SILENTLY, AND IN THE DIRECTION THAT LOOKS HEALTHY. `execute()`
 * arms its own timers from `resolveTimeoutBudgets()` unconditionally, so the
 * hard cap still aborted and the 5-minute alert still fired on production
 * logs. Nothing errored. What went missing was the *context*:
 *
 *   - `attempt` fell back to 1, so `hardCapAbortKind(1)` returned `retryable`
 *     forever and "two 15-minute attempts, then give up" was not enforced.
 *   - `latencyBaseline` was absent, so a real alert on a judge with 26
 *     completed judgments read "This is the first judgment for this judge".
 *   - `onInitialBudgetElapsed` never fired, so the alert never reached the
 *     running process — the half of the request that was actually novel.
 *
 * A test that exercised the pointwise seam would have passed. So these
 * assertions are deliberately written per-seam and named per-seam: the
 * invariant is "all of them", and the only way to encode that is to enumerate
 * them and fail on the one that forgot.
 */

const { executeJudgmentMock, executePairwiseMock, executeRespondMock, baselineMock, warnMock } =
  vi.hoisted(() => ({
    executeJudgmentMock: vi.fn(),
    executePairwiseMock: vi.fn(),
    executeRespondMock: vi.fn(),
    baselineMock: vi.fn(),
    warnMock: vi.fn(),
  }));

vi.mock('@/lib/llm', () => ({
  executeJudgment: executeJudgmentMock,
  executePairwise: executePairwiseMock,
  executeRespond: executeRespondMock,
}));

vi.mock('@/lib/calibration/latency', () => ({
  judgeLatencyBaseline: baselineMock,
}));

// Narrows the unit under test to the seams. The consumer imports
// `@/lib/realtime/events`, which pulls the whole bus/redis-bus chain in behind
// it — none of it reachable from a seam that never publishes, but all of it
// loaded, and therefore all of its uncovered branches added to the
// `src/lib/realtime/**` coverage denominator. Left unmocked, this file drops
// that glob from 87.5% to 77.77% branches and fails a floor **without changing
// which lines any test covers**. That is the failure mode vitest.config.ts
// already predicts for `src/worker/reaper.ts`: a ratio whose denominator moves
// with imports punishes exactly the tests it exists to encourage. Mocking the
// seam's unused dependency is the fix that does not involve lowering a floor.
vi.mock('@/lib/realtime/events', () => ({
  publishEvent: vi.fn(),
  runTopic: vi.fn(() => 'run:test'),
}));

vi.mock('@/lib/logger', () => ({
  logger: { warn: warnMock, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  serializeError: (e: unknown) => ({ message: (e as Error)?.message }),
}));

const BASELINE = { count: 26, meanMs: 94_500, p50Ms: 83_400, p90Ms: 200_000, maxMs: 250_200 };

const version = { id: 'ver_granite42', servingBackend: 'ollama', judgeModel: { name: 'granite4.2:3b' } };
const endpoint = { endpoint: 'http://192.168.1.9:11434/v1', apiKeyEnc: null };
const rubric = { name: 'General Quality Assessment', description: 'd', criteria: [] };

/** `attemptCount: 2` is load-bearing: it is the value that must survive to
 *  `hardCapAbortKind`, and the bug's signature was seeing 1 here. */
const judgment = {
  id: 'mj_1',
  attemptCount: 2,
  promptTemplate: { id: 'tpl_1', protocol: 'pairwise' },
};

const run = {
  evaluation: { inputText: 'in', promptText: 'p' },
  runCandidates: [
    { position: 0, promptText: 'p', responseText: 'A', label: 'A' },
    { position: 1, promptText: 'p', responseText: 'B', label: 'B' },
  ],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const input = { judgment, run, rubric, version, endpoint } as any;

describe('every provider seam carries the timeout escalation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    baselineMock.mockResolvedValue(BASELINE);
    executeJudgmentMock.mockResolvedValue({ overallScore: 1, reasoning: '', criteriaScores: [], latencyMs: 1 });
    executePairwiseMock.mockResolvedValue({ verdict: 'A', reasoning: '', rawResponse: '{}', latencyMs: 1 });
    executeRespondMock.mockResolvedValue({ responseText: 'x', latencyMs: 1 });
  });

  const seams = [
    { name: 'pointwise (defaultRunProviderJudgment)', fn: 'defaultRunProviderJudgment', spy: executeJudgmentMock },
    { name: 'PAIRWISE (defaultRunProviderPairwise)', fn: 'defaultRunProviderPairwise', spy: executePairwiseMock },
    { name: 'respond (defaultRunProviderResponse)', fn: 'defaultRunProviderResponse', spy: executeRespondMock },
  ] as const;

  for (const seam of seams) {
    it(`${seam.name} passes escalation with the ROW's attempt, the version id and the baseline`, async () => {
      const mod = await import('@/worker/judgment-consumer');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (mod as any)[seam.fn](input);

      expect(seam.spy).toHaveBeenCalledTimes(1);
      const passed = seam.spy.mock.calls[0][0];

      // The whole point. Before the fix, two of these three were `undefined`.
      expect(passed.escalation).toBeDefined();

      // `2`, not `1`. A default of 1 makes hardCapAbortKind always return 'retryable'
      // and silently converts "two attempts" into "three".
      expect(passed.escalation.attempt).toBe(2);
      expect(passed.escalation.judgeModelVersionId).toBe('ver_granite42');
      expect(passed.escalation.latencyBaseline).toEqual(BASELINE);
      expect(typeof passed.escalation.onInitialBudgetElapsed).toBe('function');

      expect(baselineMock).toHaveBeenCalledWith('ver_granite42');
    });
  }

  it('a baseline read that THROWS does not fail the judgment — it degrades to unbaselined', async () => {
    // The owner asked to be forgiving about the first record. A judge with no
    // history is the case the alert must still fire for, so a failure to LOAD
    // history must not fail the judgment that would have CREATED it.
    baselineMock.mockRejectedValue(new Error('db down'));
    const mod = await import('@/worker/judgment-consumer');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (mod as any).defaultRunProviderPairwise(input);

    const passed = executePairwiseMock.mock.calls[0][0];
    expect(passed.escalation.latencyBaseline).toBeNull();
    expect(passed.escalation.attempt).toBe(2);
    expect(warnMock).toHaveBeenCalledWith(
      'judgeLatencyBaseline failed — treating this call as unbaselined',
      expect.objectContaining({ judgeModelVersionId: 'ver_granite42' })
    );
  });

  it('null from the baseline read is passed through as null, NOT as zeros', async () => {
    // `latency.ts`'s contract: null and a zero-filled record are different
    // facts, and `meanMs: 0` lies in the dangerous direction — it reads as a
    // judge that answers instantly, so every real call looks pathologically
    // slow and the first-record branch never runs.
    baselineMock.mockResolvedValue(null);
    const mod = await import('@/worker/judgment-consumer');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (mod as any).defaultRunProviderPairwise(input);

    expect(executePairwiseMock.mock.calls[0][0].escalation.latencyBaseline).toBeNull();
  });

  it('a missing attemptCount falls back to 1 rather than to undefined', async () => {
    const mod = await import('@/worker/judgment-consumer');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (mod as any).defaultRunProviderPairwise({
      ...input,
      judgment: { ...judgment, attemptCount: null },
    });

    // `undefined` would be stripped by registry.ts's `escalationFields`
    // (it spreads only defined keys), putting us straight back in the bug.
    expect(executePairwiseMock.mock.calls[0][0].escalation.attempt).toBe(1);
  });

  /**
   * #11 (2026-09-01). The pairwise seam is a PASSTHROUGH — it returns the
   * registry's PairwiseResult unchanged — and that is the only reason
   * `parseMode` reaches persistPairwiseSuccess without a seam edit. Nothing
   * else in the suite can see it: the registry unit tests assert upstream of
   * this function, and the integration test replaces it with a fake. An edit
   * that "tidies" this into an explicit field map would drop parseMode with
   * tsc, unit and integration ALL green (handoff §5.1's shape: a feature that
   * reaches some seams and looks live). Injection F verifies this red.
   */
  it('PAIRWISE returns the registry result UNCHANGED — parseMode survives the seam', async () => {
    executePairwiseMock.mockResolvedValue({
      verdict: 'A',
      reasoning: '',
      rawResponse: '{}',
      latencyMs: 1,
      parseMode: 'structured',
    });

    const mod = await import('@/worker/judgment-consumer');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (mod as any).defaultRunProviderPairwise(input);

    expect(result.parseMode).toBe('structured');
  });

  /**
   * Task 4: `ModelJudgment.pairOrder` has existed since v2b and, until this
   * task, was read NOWHERE in `src/` — the presented order was fixed by the
   * query's `orderBy: { position: 'asc' }`, so writing 'BA' produced a row
   * that lied about the prompt the model actually saw. These pin the last
   * hop of the threading chain: the `registryInput` literal in
   * `defaultRunProviderPairwise`.
   */
  describe('pairOrder threading (Task 4)', () => {
    it('passes the judgment pairOrder into the registry input', async () => {
      const mod = await import('@/worker/judgment-consumer');
      await (mod as any).defaultRunProviderPairwise({
        ...input,
        judgment: { ...judgment, pairOrder: 'BA' },
      });

      expect(executePairwiseMock.mock.calls[0][0].pairOrder).toBe('BA');
    });

    it('falls back to AB for an unrecognised pairOrder rather than rendering BA', async () => {
      const mod = await import('@/worker/judgment-consumer');
      await (mod as any).defaultRunProviderPairwise({
        ...input,
        // Not a Prisma enum — a nullable String column — so a bad value like
        // this is storable and must not silently fall through to a BA render.
        judgment: { ...judgment, pairOrder: 'ba' },
      });

      expect(executePairwiseMock.mock.calls[0][0].pairOrder).toBe('AB');
    });

    it('falls back to AB when pairOrder is absent — the pre-BA baseline', async () => {
      const mod = await import('@/worker/judgment-consumer');
      await (mod as any).defaultRunProviderPairwise(input);

      expect(executePairwiseMock.mock.calls[0][0].pairOrder).toBe('AB');
    });
  });
});
