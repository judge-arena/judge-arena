import { describe, expect, it, vi } from 'vitest';

/**
 * ─── TIME-TO-COMPUTE: the baseline the timeout policy branches on, and the
 *     (dataset, item, model) projection that makes runtime queryable ────────
 *
 * WHAT THIS SUITE IS DEFENDING, in the order the failures actually bite:
 *
 *  1. `judgeLatencyBaseline` MUST return `null` when this judge has never
 *     completed a judgment, not a zero-filled record. The dynamic timeout
 *     policy branches on exactly this value — "no successful response to
 *     baseline average response times" is the owner's first-record case, the
 *     one that gets the 5-minute "confirm model access, waiting 10 more
 *     minutes" alert instead of a health-based extension. A `{count: 0,
 *     meanMs: 0, ...}` record is not "unknown", it reads as "this judge
 *     answers instantly", which makes every real call look pathologically
 *     slow and inverts the branch. The injection named in the task brief —
 *     return zeros instead of null — has to go red here.
 *
 *  2. FAILURES MUST NOT ENTER THE BASELINE, and MUST enter the per-tuple
 *     projection. Those pull in opposite directions on purpose. The baseline
 *     answers "is this judge healthy", and health is defined (owner, verbatim)
 *     as "a successful response has been returned" — folding a 900s timeout
 *     into the mean would let the very failure the policy is sizing against
 *     inflate the budget that was supposed to catch it. The projection answers
 *     "what did this tuple cost", and a judgment that burned 15 minutes and
 *     died is the single most expensive row in the corpus; dropping it
 *     produces a runtime dataset that silently under-reports exactly where it
 *     matters.
 *
 *  3. A COMPLETED JUDGMENT WITH NO `latencyMs` IS REAL, not hypothetical.
 *     `scripts/importer/runs.ts:491` carries `latencyMs: v1.latencyMs`
 *     straight across from v1, nullable, and stamps `startedAt: null`
 *     (runs.ts:500). Averaging over those rows yields `NaN`; counting them
 *     yields a mean that is silently too low. Both are worse than reporting
 *     no baseline at all.
 *
 *  4. `selectOverdue` must ignore a row with no `startedAt`. `now - 0` is
 *     ~56 years, so a single v1-imported row would make the CLI shout an
 *     overdue alert on every poll for a judgment nobody is waiting on.
 */
const { judgmentUpdateMock } = vi.hoisted(() => ({ judgmentUpdateMock: vi.fn() }));

// The consumer's error-persist path writes through this one call. Faked so
// the write is observable without a live DB — the same reason
// tests/lib/llm-truncation.test.ts fakes it.
vi.mock('@/lib/db', () => ({ prisma: { modelJudgment: { update: judgmentUpdateMock } } }));

import {
  budgetWarningFor,
  describeBaseline,
  formatDurationMs,
  judgeLatencyBaseline,
  judgeThroughputEstimate,
  selectOverdue,
  summarizeLatencies,
  summarizeThroughput,
  timeToComputeByTuple,
  type JudgeLatencyClient,
  type TimeToComputeClient,
} from '@/lib/calibration/latency';

const JUDGE = 'jmv-qwen-1';
const OTHER_JUDGE = 'jmv-llama-1';

// ─── fakes ──────────────────────────────────────────────────────────────────

type FakeJudgment = {
  status: string;
  latencyMs: number | null;
  judgeModelVersionId: string | null;
  /** Read only by the throughput estimate. The baseline fixtures leave it
   *  out and the fake maps that to `null`, which is what the schema allows
   *  (`ModelJudgment.outputTokens Int?`). */
  outputTokens?: number | null;
  /** Also read only by the throughput estimate — `accountTokens()` needs it
   *  to tell whether `outputTokens` already counted the reasoning channel.
   *  The baseline and plain-outputTokens fixtures leave it out and the fake
   *  maps that to `null` ("no reasoning channel"), which makes
   *  `estimatedGeneratedTokens` equal `outputTokens` exactly — the fixtures
   *  that predate this task are unaffected by adding this field. */
  reasoningContent?: string | null;
};

const chars = (n: number): string => 'x'.repeat(n);

/**
 * A `modelJudgment.findMany` stand-in that HONOURS the two filters the
 * baseline query relies on — `judgeModelVersionId` and `status` — rather than
 * asserting on the call args, so a baseline that forgot either one fails a
 * behaviour test instead of passing a shape test (the doctrine
 * tests/lib/calibration-score.test.ts's `fakeClient` establishes).
 *
 * It deliberately does NOT filter on `latencyMs`: dropping the null-latency
 * rows is the module's own job (see #3 in the header), and a fake that did it
 * first would make that code untestable.
 */
function fakeJudgeClient(rows: readonly FakeJudgment[]): JudgeLatencyClient & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    modelJudgment: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrow structural stand-in for one Prisma delegate method
      findMany: async (args: any) => {
        calls.push(args);
        const wantJudge = args?.where?.judgeModelVersionId;
        const wantStatus = args?.where?.status;
        return rows
          .filter((r) => wantJudge === undefined || r.judgeModelVersionId === wantJudge)
          .filter((r) => wantStatus === undefined || r.status === wantStatus)
          .map((r) => ({
            latencyMs: r.latencyMs,
            outputTokens: r.outputTokens ?? null,
            reasoningContent: r.reasoningContent ?? null,
          }));
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
    } as any,
  };
}

/** `latencyMs` in ms for a judgment that completed in `seconds`. */
function secs(n: number): number {
  return Math.round(n * 1000);
}

/** One completed judgment for `JUDGE` at `ms`. */
function done(ms: number | null, judge = JUDGE): FakeJudgment {
  return { status: 'completed', latencyMs: ms, judgeModelVersionId: judge };
}

type FakeTupleRun = {
  calibrationRunId: string | null;
  goldenItem: {
    id: string;
    index: number;
    goldenSetId: string;
    goldenSet: { datasetId: string };
  } | null;
  modelJudgments: FakeJudgment[];
};

/**
 * An `evaluationRun.findMany` stand-in for the tuple projection. Honours the
 * `calibrationRunId` scope, the `datasetId` scope (through the
 * goldenItem -> goldenSet join the tuple is actually reachable by) and the
 * nested `judgeModelVersionId` filter.
 *
 * It does NOT honour `goldenItemId: { not: null }` and it does NOT sort. Both
 * omissions are deliberate: a run with no golden item cannot name a tuple and
 * must be skipped by the module, and Postgres has no default row order, so
 * the deterministic ordering of the report has to come from the module's own
 * sort. A fake that pre-sorted would make removing that sort invisible.
 */
function fakeTupleClient(runs: readonly FakeTupleRun[]): TimeToComputeClient {
  return {
    evaluationRun: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrow structural stand-in for one Prisma delegate method
      findMany: async (args: any) => {
        const wantCalibration = args?.where?.calibrationRunId;
        const wantDataset = args?.where?.goldenItem?.goldenSet?.datasetId;
        const wantJudge = args?.select?.modelJudgments?.where?.judgeModelVersionId;
        return runs
          .filter((r) => wantCalibration === undefined || r.calibrationRunId === wantCalibration)
          .filter((r) => wantDataset === undefined || r.goldenItem?.goldenSet.datasetId === wantDataset)
          .map((r) => ({
            goldenItem: r.goldenItem,
            modelJudgments: r.modelJudgments.filter(
              (j) => wantJudge === undefined || j.judgeModelVersionId === wantJudge
            ),
          }));
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
    } as any,
  };
}

function run(
  index: number,
  judgments: FakeJudgment[],
  opts: { calibrationRunId?: string; datasetId?: string; goldenSetId?: string } = {}
): FakeTupleRun {
  return {
    calibrationRunId: opts.calibrationRunId ?? 'cal-1',
    goldenItem: {
      id: `item-${index}`,
      index,
      goldenSetId: opts.goldenSetId ?? 'gs-1',
      goldenSet: { datasetId: opts.datasetId ?? 'ds-1' },
    },
    modelJudgments: judgments,
  };
}

// ─── summarizeLatencies: the arithmetic, with no DB anywhere near it ────────

describe('summarizeLatencies', () => {
  it('returns null — never zeros — for an empty sample', () => {
    // THE INJECTION TARGET. `{count: 0, meanMs: 0, ...}` is not "unknown", it
    // is "instant", and the timeout policy reads it as a healthy baseline.
    expect(summarizeLatencies([])).toBeNull();
  });

  it('returns null when every value is null (the v1-imported completed row)', () => {
    // Mean over [null] is NaN; counting them is a mean that is silently low.
    expect(summarizeLatencies([null, null])).toBeNull();
  });

  it('computes mean / p50 / p90 / max by nearest rank over a known fixture', () => {
    // 100..1000 ascending. Nearest rank (no interpolation): p50 -> index
    // ceil(0.5*10)-1 = 4 -> 500; p90 -> index ceil(0.9*10)-1 = 8 -> 900.
    const values = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    expect(summarizeLatencies(values)).toEqual({
      count: 10,
      meanMs: 550,
      p50Ms: 500,
      p90Ms: 900,
      maxMs: 1000,
    });
  });

  it('sorts before ranking — an unsorted sample gives the same answer', () => {
    const shuffled = [700, 100, 1000, 400, 200, 900, 300, 800, 600, 500];
    expect(summarizeLatencies(shuffled)).toEqual({
      count: 10,
      meanMs: 550,
      p50Ms: 500,
      p90Ms: 900,
      maxMs: 1000,
    });
  });

  it('reports an OBSERVED value at every percentile, including even samples', () => {
    // Nearest rank, pinned deliberately: p50 of [10, 20] is 10, not 15. A
    // budget is sized against latencies that actually happened; an
    // interpolated 15 is a number no call ever took.
    expect(summarizeLatencies([10, 20])).toEqual({
      count: 2,
      meanMs: 15,
      p50Ms: 10,
      p90Ms: 20,
      maxMs: 20,
    });
  });

  it('rounds the mean to whole milliseconds', () => {
    // Live Qwen numbers: 16.1s / 42.6s / 95.1s. Sub-millisecond precision on
    // a 60 tok/s CPU model is noise in a printed alert.
    const s = summarizeLatencies([secs(16.1), secs(42.6), secs(95.1)]);
    expect(s?.meanMs).toBe(51267);
    expect(s?.p50Ms).toBe(42600);
    expect(s?.maxMs).toBe(95100);
  });

  it('a single sample is a baseline of one, not no baseline', () => {
    expect(summarizeLatencies([42600])).toEqual({
      count: 1,
      meanMs: 42600,
      p50Ms: 42600,
      p90Ms: 42600,
      maxMs: 42600,
    });
  });
});

// ─── judgeLatencyBaseline: what counts as "health is good" ──────────────────

describe('judgeLatencyBaseline', () => {
  it('returns null when this judge has never completed a judgment', async () => {
    // The owner's first-record case, verbatim: "If it's the first record (no
    // successful response to baseline average response times)". Running,
    // pending and errored rows are all present and none of them is health.
    const client = fakeJudgeClient([
      { status: 'running', latencyMs: null, judgeModelVersionId: JUDGE },
      { status: 'pending', latencyMs: null, judgeModelVersionId: JUDGE },
      { status: 'error', latencyMs: 900_000, judgeModelVersionId: JUDGE },
    ]);

    expect(await judgeLatencyBaseline(JUDGE, client)).toBeNull();
  });

  it('never returns a zero-filled record in place of null', async () => {
    // Stated as its own assertion because the two are trivially confusable at
    // a call site (`baseline.count === 0` vs `baseline === null`) and only one
    // of them survives `if (!baseline)`.
    const baseline = await judgeLatencyBaseline(JUDGE, fakeJudgeClient([]));
    expect(baseline).toBeNull();
    expect(baseline).not.toEqual({ count: 0, meanMs: 0, p50Ms: 0, p90Ms: 0, maxMs: 0 });
  });

  it('returns null when the only completed judgments carry no latencyMs', async () => {
    // v1-imported rows: `latencyMs: v1.latencyMs` (nullable) with
    // `startedAt: null` — scripts/importer/runs.ts:491,500. There is no
    // runtime here to baseline against, and NaN is not a baseline.
    const client = fakeJudgeClient([done(null), done(null)]);
    expect(await judgeLatencyBaseline(JUDGE, client)).toBeNull();
  });

  it('summarises only the COMPLETED judgments for this judge', async () => {
    const client = fakeJudgeClient([
      done(secs(16.1)),
      done(secs(42.6)),
      done(secs(95.1)),
      // A 15-minute timeout for the SAME judge. Health is "a successful
      // response has been returned"; folding this in would let the failure
      // the policy exists to catch inflate the budget meant to catch it.
      { status: 'error', latencyMs: 900_000, judgeModelVersionId: JUDGE },
      // A different judge on a different server. Its speed says nothing
      // about this one.
      done(secs(0.4), OTHER_JUDGE),
    ]);

    const baseline = await judgeLatencyBaseline(JUDGE, client);
    expect(baseline).toEqual({
      count: 3,
      meanMs: 51267,
      p50Ms: 42600,
      p90Ms: 95100,
      maxMs: 95100,
    });
  });

  it('asks the database for this judge and this status, not for everything', async () => {
    // Belt to the fake's braces: the filters above are enforced behaviourally,
    // but a baseline that pulled every judgment ever and filtered in memory
    // would be a full-table read on the hot alert path.
    const client = fakeJudgeClient([done(1000)]);
    await judgeLatencyBaseline(JUDGE, client);
    expect(client.calls[0]).toMatchObject({
      where: { judgeModelVersionId: JUDGE, status: 'completed' },
      select: { latencyMs: true },
    });
  });
});

// ─── the stacked-limits input: how fast does this judge emit tokens ─────────

describe('summarizeThroughput', () => {
  it('returns null — never zero — for an empty sample', () => {
    // Zero tok/s reads as "this judge emits nothing"; a caller dividing
    // max_tokens by it gets Infinity. Same contract as summarizeLatencies.
    expect(summarizeThroughput([])).toBeNull();
  });

  it('POOLS tokens over seconds rather than averaging per-judgment rates', () => {
    // 1000 tokens in 10 s (100 tok/s) and 3000 tokens in 60 s (50 tok/s).
    // Pooled: 4000 / 70 s = 57.14 tok/s. The mean of the two rates is 75 —
    // the fixture is asymmetric precisely so the two answers differ, because
    // a mean of rates weights a 109-token verdict the same as a 7,000-token
    // one and that is not the number a budget is sized against.
    // `reasoningContent: null` on both rows — no reasoning channel — so
    // `accountTokens` returns `estimatedGeneratedTokens === outputTokens`
    // exactly, keeping this test's numbers isolated to the pooling logic.
    const estimate = summarizeThroughput([
      { outputTokens: 1000, latencyMs: 10_000, reasoningContent: null },
      { outputTokens: 3000, latencyMs: 60_000, reasoningContent: null },
    ]);
    expect(estimate?.n).toBe(2);
    expect(estimate?.tokPerSec).toBeCloseTo(57.14, 1);
  });

  it('excludes a row with no outputTokens — or none, or a non-finite count — rather than counting it as zero', () => {
    // A v1-imported judgment carries no token counts; a completed row that
    // emitted 0 tokens is not a measurement of speed either. `accountTokens`
    // already returns `estimatedGeneratedTokens: null` for both (its own
    // "an absent or non-positive provider count is an ABSENCE" contract,
    // pinned in tests/lib/calibration-token-accounting.test.ts) — this test
    // is the INTEGRATION check that `summarizeThroughput` correctly drops
    // what `accountTokens` marks unmeasurable, rather than pooling it as
    // zero. The NaN row is NOT decoration: `ThroughputRow` is exported
    // public surface, so a caller can hand one in, and `accountTokens`
    // itself does NOT reject it (`NaN <= 0` is `false`, so its own
    // early-return guard does not fire; with no reasoning channel it returns
    // `estimatedGeneratedTokens: NaN`) — only `summarizeThroughput`'s own
    // `Number.isFinite` guard on the DERIVED value stops it. Without this
    // row that guard is never the deciding clause in any test
    // (CONTRIBUTING.md's "unreachable guard" class). All four rows carry
    // `reasoningContent: null` so this stays isolated to the
    // outputTokens/NaN exclusion, not the reasoning-channel arithmetic.
    const estimate = summarizeThroughput([
      { outputTokens: null, latencyMs: 10_000, reasoningContent: null },
      { outputTokens: 0, latencyMs: 10_000, reasoningContent: null },
      { outputTokens: Number.NaN, latencyMs: 10_000, reasoningContent: null },
      { outputTokens: 1000, latencyMs: 10_000, reasoningContent: null },
    ]);
    expect(estimate).toEqual({ tokPerSec: 100, n: 1 });
  });

  it('excludes a zero, missing or non-finite latencyMs instead of dividing by it', () => {
    // Same reasoning for the latency guard: `Infinity <= 0` is false, so only
    // the isFinite arm rejects it, and an included Infinity would silently
    // drive the pooled rate to 0 rather than to null. This guard is entirely
    // `summarizeThroughput`'s own — `accountTokens` never touches `latencyMs`.
    expect(
      summarizeThroughput([
        { outputTokens: 1000, latencyMs: 0, reasoningContent: null },
        { outputTokens: 1000, latencyMs: null, reasoningContent: null },
        { outputTokens: 1000, latencyMs: Number.POSITIVE_INFINITY, reasoningContent: null },
      ])
    ).toBeNull();
  });
});

describe('judgeThroughputEstimate', () => {
  it('returns null when this judge has never completed a judgment', async () => {
    const client = fakeJudgeClient([
      { status: 'running', latencyMs: null, judgeModelVersionId: JUDGE, outputTokens: null, reasoningContent: null },
      // A timed-out call with a recorded runtime is NOT a rate: it says the
      // judge did not answer, not how fast it answers. Same reasoning as the
      // latency baseline's status filter. No reasoning channel on this row,
      // so if the status filter were dropped it would score as a rate of
      // outputTokens / latencyMs exactly (see the "asks the database" test
      // and Break (4) below) — this row is deliberately the SIMPLE case.
      { status: 'error', latencyMs: 900_000, judgeModelVersionId: JUDGE, outputTokens: 12_288, reasoningContent: null },
    ]);
    expect(await judgeThroughputEstimate(JUDGE, client)).toBeNull();
  });

  it('pools only the COMPLETED judgments of THIS judge', async () => {
    // Qwen3.6's measured envelope: 2869 output tokens in 49.0 s = 58.55 tok/s
    // — a judge whose provider count already INCLUDES the reasoning channel
    // (token-accounting.ts's `includes_reasoning` band), so `reasoningContent:
    // null` here keeps `estimatedGeneratedTokens === outputTokens` and this
    // test isolated to the STATUS/JUDGE scoping, not the reasoning-channel
    // arithmetic (that gets its own test below).
    const client = fakeJudgeClient([
      { ...done(secs(49)), outputTokens: 2869, reasoningContent: null },
      { ...done(secs(49)), outputTokens: 2869, reasoningContent: null },
      { status: 'error', latencyMs: 900_000, judgeModelVersionId: JUDGE, outputTokens: 12_288, reasoningContent: null },
      // A different judge on a different server. Its speed says nothing
      // about this one.
      { ...done(secs(1), OTHER_JUDGE), outputTokens: 5000, reasoningContent: null },
    ]);
    const estimate = await judgeThroughputEstimate(JUDGE, client);
    expect(estimate?.n).toBe(2);
    expect(estimate?.tokPerSec).toBeCloseTo(58.55, 1);
  });

  it('pools via accountTokens, not raw outputTokens — the qwen3.5:9b shape (small outputTokens, large reasoningContent)', async () => {
    // THE DEFECT THIS TASK EXISTS TO PREVENT. qwen3.5:9b's judge path always
    // sends response_format: json_schema (ollamaStructuredRequestFields /
    // openai-compatible.ts:210-212), and on this model `outputTokens`
    // (usage.completion_tokens) EXCLUDES the reasoning channel entirely —
    // measured 2026-09-02 against judge-arena-pg-1, length(reasoningContent)
    // / outputTokens ranges 36.7…156.7 over every completed judgment of the
    // currently-registered version, all classified `excludes_reasoning` by
    // REASONING_EXCLUDED_RATIO (= 8, token-accounting.ts). The two rows below
    // are the SAME fixtures tests/lib/calibration-token-accounting.test.ts
    // uses (`Q35_MIN_RATIO`, `Q35_THE_INCIDENT`), so `estimatedGeneratedTokens`
    // cross-checks against that file's own pinned values: 1683 and 5065
    // (148 + round(5589/3.64) = 1683; 115 + round(18019/3.64) = 5065).
    const client = fakeJudgeClient([
      { ...done(secs(200)), outputTokens: 148, reasoningContent: chars(5589) },
      { ...done(secs(350)), outputTokens: 115, reasoningContent: chars(18019) },
    ]);
    const estimate = await judgeThroughputEstimate(JUDGE, client);
    expect(estimate?.n).toBe(2);
    // Pooled: (1683 + 5065) / (200 + 350) = 6748 / 550 = 12.269... tok/s.
    // NOT a mean of the two rows' own rates (1683/200=8.415, 5065/350=14.471,
    // mean 11.44) — same pooling argument as the "POOLS tokens" test above.
    // The number this task exists to get right: Σ outputTokens / Σ latencyMs
    // over these SAME two rows is (148+115) / 550 = 0.478 tok/s — the exact
    // ~20x-too-slow defect `token-accounting` (e438da2/0bd6b6b/db5bff9) fixed
    // elsewhere in this codebase, which this test proves is NOT reintroduced
    // here. See Break (8) below for the injection that reintroduces it.
    expect(estimate?.tokPerSec).toBeCloseTo(12.27, 1);
    expect(estimate?.tokPerSec).toBeGreaterThan(12);
    expect(estimate?.tokPerSec).toBeLessThan(13);
  });

  it('asks the database for this judge, this status and ONLY those three columns', async () => {
    // Belt to the fake's braces, as the baseline's own query-shape test is:
    // a full-table read here would run on every calibration launch.
    const client = fakeJudgeClient([{ ...done(1000), outputTokens: 100, reasoningContent: null }]);
    await judgeThroughputEstimate(JUDGE, client);
    expect(client.calls[0]).toMatchObject({
      where: { judgeModelVersionId: JUDGE, status: 'completed' },
    });
    // `toEqual`, NOT the surrounding `toMatchObject`, and this is the whole
    // point of the assertion. `fakeJudgeClient` ignores `select` entirely —
    // it always projects all three columns — so a subset match cannot tell
    // `{ outputTokens, latencyMs, reasoningContent }` from that plus
    // `rawResponse, systemPrompt, userPrompt`, i.e. from the full-table read
    // this test exists to prevent. `toEqual` fails on the extra key.
    // (The existing `judgeLatencyBaseline` query-shape test at :303-313 has
    // the subset limitation; it is not in scope to change here, but do not
    // copy its shape.)
    expect((client.calls[0] as { select?: unknown }).select).toEqual({
      outputTokens: true,
      latencyMs: true,
      reasoningContent: true,
    });
  });
});

// ─── the stacked-limits rule: max_tokens / tok_per_s against the hard cap ───

describe('budgetWarningFor', () => {
  const HARD_CAP = 900_000;

  it('says nothing when there is no history — a first-ever judge must launch', () => {
    // The first calibration of any judge has no completed judgment to
    // measure. null is "nothing to say", never a refusal.
    expect(budgetWarningFor({ maxTokens: 12288, throughput: null, hardCapMs: HARD_CAP })).toBeNull();
  });

  it('says nothing when the budget fits', () => {
    // Qwen: 12288 / 58.5 = 210 s against a 900 s cap (spec §2.1).
    expect(
      budgetWarningFor({ maxTokens: 12288, throughput: { tokPerSec: 58.5, n: 30 }, hardCapMs: HARD_CAP })
    ).toBeNull();
  });

  it('exhausting EXACTLY at the cap is not a warning — the rule is strictly over', () => {
    // 900 tokens at 1 tok/s is 900 s: the cap itself. `>`, not `>=`, so the
    // boundary is stated rather than left to floating-point luck.
    expect(
      budgetWarningFor({ maxTokens: 900, throughput: { tokPerSec: 1, n: 1 }, hardCapMs: HARD_CAP })
    ).toBeNull();
  });

  it('names the budget, the rate, the sample, both durations and the LOWER-bound caveat when it does not fit', () => {
    // THE REAL CASE, not a round number, and NOT the raw-formula figure round
    // 3 carried ("measured at 11.9 tok/s" via Σ outputTokens / Σ latencyMs).
    // qwen3.5:9b's judge path always sends response_format: json_schema, and
    // outputTokens EXCLUDES the reasoning channel for this model — a naive
    // Σ outputTokens / Σ latencyMs computes ~0.5 tok/s here, not a measure of
    // this judge's real speed (see the `judgeThroughputEstimate` test "pools
    // via accountTokens" in Task 1, which pins the mechanism). The number
    // below is the POOLED, `accountTokens`-derived rate: measured via
    // read-only psql against judge-arena-pg-1 on 2026-09-02, over the 15
    // completed judgments of the currently-registered version
    // (`cmtkqwen35ord2v20000001`, ordinal 2) — Σ estimatedGeneratedTokens
    // 46,401 (= Σ (outputTokens + round(reasoningChars / 3.64)) per row) /
    // Σ latencyMs 3,856,364 ms = 12.032 tok/s, rounded to **12.0 tok/s** at
    // one decimal place, the same precision every other measured envelope in
    // this plan uses (58.5, 35.9, 23.2). `max_tokens: 12288` is kept as an
    // illustrative registered budget (the two ACTUAL registered versions
    // carry 6144 and 8192, not 12288 — chosen here, as in round 3, so the
    // boundary math stays close). 12288 / 12.0 = **1024.0 s exactly** (a
    // clean division, no repeating decimal), which formatDurationMs rounds
    // to 1024 s = 17m4s, against a 15m0s cap. Deliberately the NEAREST
    // fixture to the boundary in this file (1.14x over): the db fixtures
    // are 2 tok/s / 6.8x over, and a 6.8x margin cannot discriminate an
    // off-by-a-factor error in the seconds↔milliseconds conversion the way
    // a 1.14x one can.
    const warning = budgetWarningFor({ maxTokens: 12288, throughput: { tokPerSec: 12.0, n: 15 }, hardCapMs: HARD_CAP });
    expect(warning).not.toBeNull();
    expect(warning).toContain('max_tokens 12288');
    expect(warning).toContain('12.0 tok/s');
    // Pinned to its ROLE, not as the bare substring `n=1`: `toContain('n=1')`
    // would also match `n=10`, `n=15`, `n=100` (failure mode 3, the
    // substring class). The phrase is the rendered clause.
    expect(warning).toContain('(n=15 completed judgment(s))');
    // Each duration is pinned to its ROLE, not merely to its presence. Bare
    // toContain('17m4s') + toContain('15m0s') cannot tell the two apart, so
    // an implementation that swaps the two formatDurationMs arguments —
    // "cannot be produced inside the 17m4s hard cap … takes ~15m0s", which
    // inverts the whole sentence for the operator — would still pass.
    expect(warning).toContain('inside the 15m0s hard cap');
    expect(warning).toContain('takes ~17m4s');
    // Throughput DECAYS with output length (granite4.2: 35.9 tok/s at 4.5k
    // tokens, 23.2 at 12k — spec §5.4.1), so the linear figure understates
    // the tail and the text must say so.
    expect(warning).toMatch(/LOWER bound/);
    // Never the advice registry.ts gives on truncation ("raise
    // samplingDefaults.max_tokens") — raising max_tokens is what produces
    // this condition in the first place. (No line number on purpose: the
    // dependency plan's Task 1 moves every registry.ts line >= 460 by -36,
    // so the familiar :673 becomes :637. Locate it with
    // `grep -n -a 'raise samplingDefaults.max_tokens' src/lib/llm/registry.ts`.)
    expect(warning).not.toMatch(/raise samplingDefaults\.max_tokens/);
  });

  it('uses the hardCapMs it was GIVEN, not the 900 s default', () => {
    // `hardCapMs` is the one input `budgetWarningFor` cannot self-check, and
    // until this case existed no test varied it: all the others use
    // HARD_CAP = 900_000, which is byte-identical to `DEFAULT_HARD_CAP_MS`
    // (src/lib/llm/timeout-policy.ts:55). Name the wrong implementation:
    // one that destructures `hardCapMs` for the TEXT but compares against
    // the imported `DEFAULT_HARD_CAP_MS`. It passes every other test here,
    // renders the identical string, and lint stays clean because
    // `hardCapMs` is still used by formatDurationMs. Only a cap that is not
    // 900 000 can tell them apart.
    //
    // 900 tokens at 1 tok/s = 900 s against a 60 s cap. Note that `15m0s`
    // is the ESTIMATE here and `1m0s` is the cap — the inverse of the test
    // above, where `15m0s` is the cap; that is deliberate, and it is a
    // second guard on the argument order.
    const warning = budgetWarningFor({ maxTokens: 900, throughput: { tokPerSec: 1, n: 4 }, hardCapMs: 60_000 });
    expect(warning).toContain('inside the 1m0s hard cap');
    expect(warning).toContain('takes ~15m0s');
  });

  it('a NaN estimate is silence, not a sentence with NaN in it', () => {
    // The `!( … > …)` form is load-bearing and the JSDoc says so, but nothing
    // else here discriminates it: the obvious `if (estimatedMs <= hardCapMs)
    // return null;` passes all four tests above and yet renders
    // "max_tokens NaN cannot be produced inside the 15m0s hard cap … takes
    // ~NaNmNaNs" to the operator, because `NaN <= cap` is false.
    // The caller can produce exactly this: a RAW read of the nullable
    // `samplingDefaults.max_tokens` is `undefined`, and `undefined / rate` is
    // NaN (see the Task 3 db test 'reads the RESOLVED budget', whose comment
    // rests on this being silence).
    expect(
      budgetWarningFor({ maxTokens: Number.NaN, throughput: { tokPerSec: 2, n: 1 }, hardCapMs: HARD_CAP })
    ).toBeNull();
  });
});

// ─── the (dataset, item, model) projection ──────────────────────────────────

describe('timeToComputeByTuple', () => {
  it('groups by (dataset, item, model) and sums the runtime of each tuple', async () => {
    const client = fakeTupleClient([
      run(1, [{ status: 'completed', latencyMs: 40_000, judgeModelVersionId: JUDGE }]),
      run(0, [
        { status: 'completed', latencyMs: 20_000, judgeModelVersionId: JUDGE },
        { status: 'completed', latencyMs: 5_000, judgeModelVersionId: OTHER_JUDGE },
      ]),
    ]);

    const rows = await timeToComputeByTuple({}, client);

    // Sorted by item index then judge — the fixture is handed in out of
    // order, because Postgres has no default row order and the report's
    // stability must come from the module. Within one item the tie-break is
    // the judge id, so OTHER_JUDGE ('jmv-llama-1') precedes JUDGE
    // ('jmv-qwen-1') regardless of which was written first.
    expect(rows).toEqual([
      {
        datasetId: 'ds-1',
        goldenSetId: 'gs-1',
        goldenItemId: 'item-0',
        goldenItemIndex: 0,
        judgeModelVersionId: OTHER_JUDGE,
        count: 1,
        completedCount: 1,
        failedCount: 0,
        totalMs: 5_000,
        maxMs: 5_000,
      },
      {
        datasetId: 'ds-1',
        goldenSetId: 'gs-1',
        goldenItemId: 'item-0',
        goldenItemIndex: 0,
        judgeModelVersionId: JUDGE,
        count: 1,
        completedCount: 1,
        failedCount: 0,
        totalMs: 20_000,
        maxMs: 20_000,
      },
      {
        datasetId: 'ds-1',
        goldenSetId: 'gs-1',
        goldenItemId: 'item-1',
        goldenItemIndex: 1,
        judgeModelVersionId: JUDGE,
        count: 1,
        completedCount: 1,
        failedCount: 0,
        totalMs: 40_000,
        maxMs: 40_000,
      },
    ]);
  });

  it('collapses repeat measurements of the same tuple across calibration runs', async () => {
    // The tuple is (dataset, item, model) — NOT (run, item, model). Re-running
    // the same judge over the same golden item in a later calibration is a
    // second measurement of one tuple's cost, and the projection is where that
    // is visible. Nothing is stored to make this true (A2.3: the report is a
    // projection, not a column).
    const client = fakeTupleClient([
      run(0, [{ status: 'completed', latencyMs: 30_000, judgeModelVersionId: JUDGE }], {
        calibrationRunId: 'cal-1',
      }),
      run(0, [{ status: 'completed', latencyMs: 50_000, judgeModelVersionId: JUDGE }], {
        calibrationRunId: 'cal-2',
      }),
    ]);

    expect(await timeToComputeByTuple({}, client)).toEqual([
      {
        datasetId: 'ds-1',
        goldenSetId: 'gs-1',
        goldenItemId: 'item-0',
        goldenItemIndex: 0,
        judgeModelVersionId: JUDGE,
        count: 2,
        completedCount: 2,
        failedCount: 0,
        totalMs: 80_000,
        maxMs: 50_000,
      },
    ]);
  });

  it('the same item in two datasets is two tuples', async () => {
    const client = fakeTupleClient([
      run(0, [{ status: 'completed', latencyMs: 10_000, judgeModelVersionId: JUDGE }], {
        datasetId: 'ds-1',
        goldenSetId: 'gs-1',
      }),
      run(0, [{ status: 'completed', latencyMs: 70_000, judgeModelVersionId: JUDGE }], {
        datasetId: 'ds-2',
        goldenSetId: 'gs-2',
      }),
    ]);

    const rows = await timeToComputeByTuple({}, client);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.datasetId, r.totalMs])).toEqual([
      ['ds-1', 10_000],
      ['ds-2', 70_000],
    ]);
  });

  it('INCLUDES a failure that recorded a runtime — that is the expensive row', async () => {
    // A judgment that ran 15 minutes and then timed out is the single most
    // costly entry in the corpus. A time-to-compute dataset that silently
    // excludes the slow failures under-reports exactly where it matters.
    const client = fakeTupleClient([
      run(0, [
        { status: 'error', latencyMs: 900_000, judgeModelVersionId: JUDGE },
        { status: 'completed', latencyMs: 42_600, judgeModelVersionId: JUDGE },
      ]),
    ]);

    expect(await timeToComputeByTuple({}, client)).toEqual([
      {
        datasetId: 'ds-1',
        goldenSetId: 'gs-1',
        goldenItemId: 'item-0',
        goldenItemIndex: 0,
        judgeModelVersionId: JUDGE,
        count: 2,
        completedCount: 1,
        failedCount: 1,
        totalMs: 942_600,
        maxMs: 900_000,
      },
    ]);
  });

  it('EXCLUDES a judgment that never recorded a runtime, and drops a tuple left empty', async () => {
    // `pending`/`running` rows have no runtime yet, and a v1-imported
    // completed row may have none ever. Counting them as zero would drag every
    // mean down; counting them at all would make `count` a row count rather
    // than a measurement count.
    const client = fakeTupleClient([
      run(0, [
        { status: 'completed', latencyMs: 40_000, judgeModelVersionId: JUDGE },
        { status: 'pending', latencyMs: null, judgeModelVersionId: JUDGE },
        { status: 'running', latencyMs: null, judgeModelVersionId: JUDGE },
      ]),
      run(1, [{ status: 'pending', latencyMs: null, judgeModelVersionId: JUDGE }]),
    ]);

    const rows = await timeToComputeByTuple({}, client);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ goldenItemIndex: 0, count: 1, totalMs: 40_000 });
  });

  it('skips a judgment with no judgeModelVersionId — a tuple with no model is not a tuple', async () => {
    // `ModelJudgment.judgeModelVersionId` is nullable (schema.prisma:484). The
    // model leg of (dataset, item, model) has to come from somewhere; an
    // unattributable runtime is dropped rather than filed under a fake key.
    const client = fakeTupleClient([
      run(0, [
        { status: 'completed', latencyMs: 40_000, judgeModelVersionId: null },
        { status: 'completed', latencyMs: 10_000, judgeModelVersionId: JUDGE },
      ]),
    ]);

    const rows = await timeToComputeByTuple({}, client);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ judgeModelVersionId: JUDGE, count: 1, totalMs: 10_000 });
  });

  it('skips an ordinary run with no golden item — it names no dataset and no item', async () => {
    // EvaluationRun.goldenItemId is NULL on every non-calibration run
    // (schema.prisma:416-420). Those rows carry runtimes too; they just have
    // no tuple to be filed under.
    const client = fakeTupleClient([
      { calibrationRunId: null, goldenItem: null, modelJudgments: [done(99_000)] },
      run(0, [{ status: 'completed', latencyMs: 10_000, judgeModelVersionId: JUDGE }]),
    ]);

    const rows = await timeToComputeByTuple({}, client);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ goldenItemId: 'item-0' });
  });

  it('scopes to one calibration run, one dataset and one judge when asked', async () => {
    const client = fakeTupleClient([
      run(0, [{ status: 'completed', latencyMs: 10_000, judgeModelVersionId: JUDGE }], {
        calibrationRunId: 'cal-1',
      }),
      run(1, [{ status: 'completed', latencyMs: 20_000, judgeModelVersionId: OTHER_JUDGE }], {
        calibrationRunId: 'cal-1',
      }),
      run(2, [{ status: 'completed', latencyMs: 30_000, judgeModelVersionId: JUDGE }], {
        calibrationRunId: 'cal-2',
      }),
      run(3, [{ status: 'completed', latencyMs: 40_000, judgeModelVersionId: JUDGE }], {
        calibrationRunId: 'cal-1',
        datasetId: 'ds-2',
      }),
    ]);

    const scoped = await timeToComputeByTuple(
      { calibrationRunId: 'cal-1', datasetId: 'ds-1', judgeModelVersionId: JUDGE },
      client
    );
    expect(scoped.map((r) => r.goldenItemIndex)).toEqual([0]);
  });
});

// ─── the CLI's overdue detector ─────────────────────────────────────────────

describe('selectOverdue', () => {
  const NOW = new Date('2026-09-01T12:00:00.000Z').getTime();
  const ago = (ms: number) => new Date(NOW - ms);

  it('reports a judgment past the budget, worst first, and leaves the rest alone', () => {
    const overdue = selectOverdue(
      [
        { id: 'a', startedAt: ago(310_000), judgeModelVersionId: JUDGE, goldenItemIndex: 3 },
        { id: 'b', startedAt: ago(42_000), judgeModelVersionId: JUDGE, goldenItemIndex: 4 },
        { id: 'c', startedAt: ago(880_000), judgeModelVersionId: JUDGE, goldenItemIndex: 5 },
      ],
      NOW,
      300_000
    );

    expect(overdue.map((o) => o.id)).toEqual(['c', 'a']);
    expect(overdue[0].elapsedMs).toBe(880_000);
    expect(overdue[0].goldenItemIndex).toBe(5);
    // Echoed back so the caller can key "already alerted" on the ATTEMPT: a
    // reclaim re-stamps startedAt, and the second attempt going long is news.
    expect(overdue[0].startedAt).toEqual(ago(880_000));
  });

  it('fires AT the budget, not only past it', () => {
    // "if it's surpassing 5min" — a call sitting at exactly the budget has
    // reached it, and the alert exists to be sent before the operator is
    // already staring at a stalled run.
    const overdue = selectOverdue(
      [{ id: 'a', startedAt: ago(300_000), judgeModelVersionId: JUDGE, goldenItemIndex: 0 }],
      NOW,
      300_000
    );
    expect(overdue.map((o) => o.id)).toEqual(['a']);
  });

  it('ignores a row with no startedAt', () => {
    // `now - 0` is ~56 years. A v1-imported judgment (startedAt: null,
    // scripts/importer/runs.ts:500) would otherwise be screamed about on
    // every 5-second poll forever.
    const overdue = selectOverdue(
      [{ id: 'ghost', startedAt: null, judgeModelVersionId: JUDGE, goldenItemIndex: null }],
      NOW,
      300_000
    );
    expect(overdue).toEqual([]);
  });

  it('ignores a startedAt in the future rather than reporting a negative age', () => {
    const overdue = selectOverdue(
      [{ id: 'skewed', startedAt: new Date(NOW + 60_000), judgeModelVersionId: JUDGE, goldenItemIndex: 0 }],
      NOW,
      300_000
    );
    expect(overdue).toEqual([]);
  });
});

// ─── the strings the operator actually reads ────────────────────────────────

describe('describeBaseline / formatDurationMs', () => {
  it('says NO BASELINE in words when there is none, rather than printing zeros', () => {
    // This string is the difference between "the judge is instant" and "we
    // have never seen this judge finish anything" on an operator's screen.
    expect(describeBaseline(null)).toMatch(/no baseline/i);
    expect(describeBaseline(null)).not.toMatch(/\b0ms\b/);
  });

  it('names the sample size beside the percentiles', () => {
    const text = describeBaseline({ count: 30, meanMs: 42_600, p50Ms: 39_100, p90Ms: 78_000, maxMs: 95_100 });
    expect(text).toContain('n=30');
    expect(text).toContain('42.6s');
    // 95.1s is over a minute, so it renders as an m/s duration — the live
    // Qwen max, in the units an operator compares against a 5m budget.
    expect(text).toContain('1m35s');
  });

  it('formats durations at the scale a human reads them', () => {
    expect(formatDurationMs(940)).toBe('940ms');
    expect(formatDurationMs(42_600)).toBe('42.6s');
    expect(formatDurationMs(300_000)).toBe('5m0s');
    expect(formatDurationMs(312_000)).toBe('5m12s');
    expect(formatDurationMs(900_000)).toBe('15m0s');
  });
});

// ─── the failure path has to record the runtime too ─────────────────────────

