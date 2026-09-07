import { describe, expect, it } from 'vitest';
import {
  scoreCalibrationRun,
  type CalibrationScoreClient,
} from '@/lib/calibration/score';
import { SCORING_RULES_VERSION } from '@/lib/calibration/scoring-version';
import type { PairOrder, Preference } from '@/lib/calibration/readings';

/**
 * A2.1 — THE SCORING TEST, pinned to a REAL ground-truth vector.
 *
 * The target set is 30 items: 17 'A>B', 13 'B>A', no ties, no nulls (verified
 * against the live corpus). That imbalance is the entire point of using it
 * rather than a tidy 15/15 fixture — a balanced key makes accuracy and kappa
 * move together, and the one case that separates them (a judge that answers
 * 'A>B' every single time) scores an innocuous 0.5 on a balanced key and a
 * respectable-looking 0.5667 on this one, while kappa correctly reports 0.
 *
 * The ORDER of the vector is not load-bearing: accuracy and Cohen's kappa are
 * both functions of the confusion matrix alone, so only the 17/13 counts
 * matter. The order below is grouped for readability.
 */
const GROUND_TRUTH: readonly Preference[] = [
  ...Array.from({ length: 17 }, () => 'A>B' as const),
  ...Array.from({ length: 13 }, () => 'B>A' as const),
];

const JUDGE_ID = 'judge-model-version-1';
const CALIBRATION_ID = 'cal-1';

/** The inverse of `preferenceFromVerdict` — what a judge holding preference
 *  `p` must SAY when it is shown the candidates in `order`. Written out
 *  independently rather than imported, so the test does not verify the
 *  mapping against itself. */
function verdictFor(p: Preference, order: PairOrder): 'A' | 'B' | 'tie' {
  if (p === 'tie') return 'tie';
  if (order === 'AB') return p === 'A>B' ? 'A' : 'B';
  return p === 'A>B' ? 'B' : 'A';
}

type FakeJudgment = {
  id: string;
  verdict: string | null;
  pairOrder: string | null;
  judgeModelVersionId: string | null;
  status: string;
};
type FakeRun = {
  id: string;
  goldenItemId: string;
  goldenItem: { id: string; index: number; expected: string | null };
  modelJudgments: FakeJudgment[];
};

/**
 * A Prisma stand-in that honours what the query actually relies on: the
 * `calibrationRunId` filter and the `orderBy` on the related golden item's
 * index. Both are enforced here rather than asserted on the call args, so a
 * scorer that forgot one FAILS a behaviour test instead of passing a shape
 * test.
 *
 * It ALSO knows how to filter `modelJudgments` by a nested `status`
 * where-clause (`wanted`, below) — that was load-bearing before this task,
 * when the query filtered to `status: 'completed'` server-side. The query no
 * longer sends that filter (score.ts's partition does the status gate now),
 * so `wanted` is always `undefined` here and that branch is DEAD against the
 * real query; it survives only because it is harmless and other test blocks
 * in this file construct their own equivalent by hand.
 *
 * `orderBy` is honoured because Postgres has no default row order. A scorer
 * that drops the clause reads rows in whatever order the planner returns them,
 * which on a real table is neither the insertion order nor the item index —
 * so a fake that always returned the fixture array as written would make the
 * clause untestable and its removal invisible.
 */
function fakeClient(runs: FakeRun[]): CalibrationScoreClient & {
  updates: Array<Record<string, unknown>>;
  row: Record<string, unknown>;
} {
  const updates: Array<Record<string, unknown>> = [];
  const rowState: Record<string, unknown> = { id: CALIBRATION_ID, verdictCount: 0 };

  return {
    updates,
    row: rowState,
    evaluationRun: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrow structural stand-in for one Prisma delegate method
      findMany: async (args: any) => {
        if (args?.where?.calibrationRunId !== CALIBRATION_ID) return [];
        const wanted = args?.select?.modelJudgments?.where?.status;
        // Only an explicit ascending orderBy on the item index sorts. Without
        // it the caller gets the fixture exactly as handed in — which the
        // ordering test below hands in shuffled.
        const ordered =
          args?.orderBy?.goldenItem?.index === 'asc'
            ? [...runs].sort((a, b) => (a.goldenItem?.index ?? -1) - (b.goldenItem?.index ?? -1))
            : runs;
        return ordered.map((r) => ({
          ...r,
          modelJudgments:
            wanted === undefined
              ? r.modelJudgments
              : r.modelJudgments.filter((j) => j.status === wanted),
        }));
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
    } as any,
    calibrationRun: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
      update: async (args: any) => {
        updates.push(args.data);
        Object.assign(rowState, args.data);
        return rowState;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
    } as any,
  };
}

/** 30 runs, one per golden item, each with one COMPLETED pairwise judgment
 *  carrying the model's preference encoded for `order`. */
function calibration(
  modelPreferences: readonly Preference[],
  opts: { order?: PairOrder; missingAt?: number[]; pendingAt?: number[] } = {}
): FakeRun[] {
  const order = opts.order ?? 'AB';
  const missing = new Set(opts.missingAt ?? []);
  const pending = new Set(opts.pendingAt ?? []);

  return GROUND_TRUTH.map((expected, index) => ({
    id: `run-${index}`,
    goldenItemId: `item-${index}`,
    goldenItem: { id: `item-${index}`, index, expected },
    modelJudgments: [
      {
        id: `j-${index}`,
        verdict: missing.has(index) ? null : verdictFor(modelPreferences[index], order),
        pairOrder: order,
        judgeModelVersionId: JUDGE_ID,
        status: pending.has(index) ? 'pending' : 'completed',
      },
    ],
  }));
}

/** Truth, with `flips` of each direction swapped — so the model's MARGINAL is
 *  unchanged (17/13) and only `po` moves. That is what makes the expected
 *  kappa hand-computable below. */
function withFlips(flipsPerDirection: number): Preference[] {
  const out = [...GROUND_TRUTH];
  let ab = flipsPerDirection;
  let ba = flipsPerDirection;
  for (let i = 0; i < out.length; i++) {
    if (out[i] === 'A>B' && ab > 0) {
      out[i] = 'B>A';
      ab -= 1;
    } else if (out[i] === 'B>A' && ba > 0) {
      out[i] = 'A>B';
      ba -= 1;
    }
  }
  return out;
}

describe('scoreCalibrationRun — accuracy is the primary number', () => {
  it('a judge that matches the key on all 30 scores accuracy 1.0 and kappa 1.0', async () => {
    const client = fakeClient(calibration(GROUND_TRUTH));
    const score = await scoreCalibrationRun(CALIBRATION_ID, client);

    expect(score.verdictCount).toBe(30);
    expect(score.correctCount).toBe(30);
    expect(score.accuracy).toBe(1);
    expect(score.kappa).toBeCloseTo(1, 10);
    expect(score.disagreements).toEqual([]);
  });

  /*  ORACLE — 24 of 30 correct, with 3 'A>B' items called 'B>A' and 3 'B>A'
   *  items called 'A>B'. The two flips cancel, so the model's marginal is the
   *  key's own 17/13 and only po moves:
   *
   *    po = 24 / 30                                          = 0.8
   *    pe = (17/30)(17/30) + (13/30)(13/30) = 458/900         = 0.508889
   *    kappa = (0.8 - 0.508889) / (1 - 0.508889)              = 0.5927602
   *
   *  Hand-worked before the implementation existed, which is what makes this
   *  an oracle rather than a snapshot of our own output. */
  it('an 80%-accurate judge scores the hand-worked kappa 0.5928', async () => {
    const client = fakeClient(calibration(withFlips(3)));
    const score = await scoreCalibrationRun(CALIBRATION_ID, client);

    expect(score.accuracy).toBeCloseTo(0.8, 10);
    expect(score.correctCount).toBe(24);
    expect(score.kappa).toBeCloseTo(0.5927602, 6);
  });

  /*  THE CASE THAT PROVES KAPPA IS DOING CHANCE CORRECTION, and the reason
   *  the number is reported at all.
   *
   *  A judge that answers 'A>B' on every item has learned nothing. On this
   *  key it is right 17 times out of 30 — accuracy 0.5667, which reads as
   *  "a bit better than a coin flip" and is completely wrong as a summary.
   *
   *    po = 17/30                                             = 0.566667
   *    model marginal: 'A>B' = 1, 'B>A' = 0
   *    pe = (17/30)(1) + (13/30)(0) = 17/30                    = 0.566667
   *    kappa = (po - pe) / (1 - pe) = 0 / (13/30)              = 0 exactly
   *
   *  Accuracy alone cannot express this and kappa alone cannot be compared
   *  across sets, which is why BOTH are stored. */
  it('an always-A>B judge scores accuracy 0.5667 and kappa 0.0000', async () => {
    const alwaysAB = GROUND_TRUTH.map(() => 'A>B' as const);
    const client = fakeClient(calibration(alwaysAB));
    const score = await scoreCalibrationRun(CALIBRATION_ID, client);

    expect(score.accuracy).toBeCloseTo(0.5667, 4);
    expect(score.correctCount).toBe(17);
    expect(score.kappa).toBeCloseTo(0, 10);
  });

  /*  TIES ARE MISSES. The corpus has no ties, so there is no item a 'tie'
   *  could be right about — crediting one as a partial hit would let a judge
   *  raise its score by refusing to answer.
   *
   *    27 of 30 correct, 3 'A>B' items called 'tie'
   *    po = 0.9
   *    model marginal: 'A>B' 14/30, 'B>A' 13/30, 'tie' 3/30
   *    key marginal:   'A>B' 17/30, 'B>A' 13/30, 'tie' 0
   *    pe = (17/30)(14/30) + (13/30)(13/30) + 0 = 407/900     = 0.452222
   *    kappa = (0.9 - 0.452222) / (1 - 0.452222)              = 0.8174442  */
  it('three ties cost three items: accuracy 0.90, and tie is a category in the matrix', async () => {
    const withTies = [...GROUND_TRUTH] as Preference[];
    withTies[0] = 'tie';
    withTies[1] = 'tie';
    withTies[2] = 'tie';
    const client = fakeClient(calibration(withTies));
    const score = await scoreCalibrationRun(CALIBRATION_ID, client);

    expect(score.accuracy).toBeCloseTo(0.9, 10);
    expect(score.correctCount).toBe(27);
    expect(score.kappa).toBeCloseTo(0.8174442, 6);
    expect(score.verdictCount).toBe(30);
    // A tie still COUNTS as a verdict — the judge answered, it was just wrong.
    // Excluding ties from the denominator would let the same refusal raise
    // accuracy instead of lowering it.
    expect(score.verdictDistribution.tie).toBe(3);
    expect(score.confusion['A>B'].tie).toBe(3);
    expect(score.disagreements).toHaveLength(3);
  });
});

describe('scoreCalibrationRun — the derived preference, not the verdict letter', () => {
  it('the SAME judge scored at pairOrder BA gives the SAME accuracy and kappa', async () => {
    // Every verdict letter is flipped relative to the AB encoding, so a
    // scorer that read `verdict` literally would score this run at 0.2 rather
    // than 0.8 — and phase 2's both-orders sweep is built entirely on this
    // holding. There is no other assertion in the suite that fails if the
    // scorer bypasses preferenceFromVerdict.
    const model = withFlips(3);
    const ab = await scoreCalibrationRun(CALIBRATION_ID, fakeClient(calibration(model, { order: 'AB' })));
    const ba = await scoreCalibrationRun(CALIBRATION_ID, fakeClient(calibration(model, { order: 'BA' })));

    expect(ba.accuracy).toBe(ab.accuracy);
    expect(ba.kappa).toBe(ab.kappa);
    expect(ba.confusion).toEqual(ab.confusion);
    // The RAW verdict distribution is the one thing that legitimately differs
    // — that asymmetry is what phase 2 measures position bias with.
    expect(ba.verdictDistribution).not.toEqual(ab.verdictDistribution);
  });
});

describe('scoreCalibrationRun — partitions by pairOrder before scoring', () => {
  it('scores the AB partition when a BA judgment is also present', async () => {
    // Two judgments per run, opposite orders, same judge. Before the
    // partition this threw duplicate-reading from groundTruthReadings.
    const client = fakeClient([
      {
        id: 'run-i1',
        goldenItemId: 'i1',
        goldenItem: { id: 'i1', index: 0, expected: 'A>B' },
        modelJudgments: [
          { id: 'j-i1-ab', verdict: 'A', pairOrder: 'AB', judgeModelVersionId: JUDGE_ID, status: 'completed' },
          { id: 'j-i1-ba', verdict: 'B', pairOrder: 'BA', judgeModelVersionId: JUDGE_ID, status: 'completed' },
        ],
      },
    ]);
    const score = await scoreCalibrationRun(CALIBRATION_ID, client);
    // AB only: one item, one verdict, correct.
    expect(score.verdictCount).toBe(1);
    expect(score.accuracy).toBe(1);
  });

  it('counts an item whose AB errored but whose BA completed as MISSING for AB', async () => {
    const client = fakeClient([
      {
        id: 'run-i1',
        goldenItemId: 'i1',
        goldenItem: { id: 'i1', index: 0, expected: 'A>B' },
        modelJudgments: [
          { id: 'j-i1-ab', verdict: null, pairOrder: 'AB', judgeModelVersionId: JUDGE_ID, status: 'error' },
          { id: 'j-i1-ba', verdict: 'B', pairOrder: 'BA', judgeModelVersionId: JUDGE_ID, status: 'completed' },
        ],
      },
    ]);
    const score = await scoreCalibrationRun(CALIBRATION_ID, client);
    // The run arrives with modelJudgments.length === 1, so the old
    // `length === 0` test misses it and missingVerdicts silently reads 0.
    expect(score.missingVerdicts).toBe(1);
    expect(score.verdictCount).toBe(0);
    expect(score.noVerdictRate).toBe(1);
  });

  it('keeps the disagreement list aligned to its own item after a BA row', async () => {
    const client = fakeClient([
      {
        id: 'run-i1',
        goldenItemId: 'i1',
        goldenItem: { id: 'i1', index: 0, expected: 'A>B' },
        modelJudgments: [
          { id: 'j-i1-ab', verdict: 'B', pairOrder: 'AB', judgeModelVersionId: JUDGE_ID, status: 'completed' },
          { id: 'j-i1-ba', verdict: 'A', pairOrder: 'BA', judgeModelVersionId: JUDGE_ID, status: 'completed' },
        ],
      },
      {
        id: 'run-i2',
        goldenItemId: 'i2',
        goldenItem: { id: 'i2', index: 1, expected: 'A>B' },
        modelJudgments: [
          { id: 'j-i2-ab', verdict: 'B', pairOrder: 'AB', judgeModelVersionId: JUDGE_ID, status: 'completed' },
        ],
      },
    ]);
    const score = await scoreCalibrationRun(CALIBRATION_ID, client);
    // Grouping `rows` without `context` slides i2's disagreement onto i1's runId.
    expect(score.disagreements.map((d) => d.itemIndex)).toEqual([0, 1]);
  });
});

describe('scoreCalibrationRun — the denominator is items with a verdict', () => {
  it('a judgment that never completed is not a wrong answer, it is an absent one', async () => {
    // status: 'pending' means the worker has not answered yet. Counting it in
    // the denominator would make an in-flight calibration look like a bad
    // judge, and the number would settle upward as the queue drained — a
    // metric that improves while nothing improves.
    const client = fakeClient(calibration(GROUND_TRUTH, { pendingAt: [0, 1, 2, 3, 4] }));
    const score = await scoreCalibrationRun(CALIBRATION_ID, client);

    expect(score.verdictCount).toBe(25);
    expect(score.accuracy).toBe(1);
    expect(score.itemCount).toBe(25);
  });

  it('a COMPLETED judgment with a null verdict is counted as missing, never as a miss', async () => {
    const client = fakeClient(calibration(GROUND_TRUTH, { missingAt: [0, 1] }));
    const score = await scoreCalibrationRun(CALIBRATION_ID, client);

    expect(score.missingVerdicts).toBe(2);
    expect(score.verdictCount).toBe(28);
    expect(score.accuracy).toBe(1);
  });

  it('a calibration with nothing scored yet reports null, not 0', async () => {
    // 0 reads as "this judge agreed with the key on nothing". The honest
    // answer for an empty denominator is that there is no number — the same
    // rule agreement() applies to its own insufficiency cases.
    const client = fakeClient([]);
    const score = await scoreCalibrationRun(CALIBRATION_ID, client);

    expect(score.verdictCount).toBe(0);
    expect(score.accuracy).toBeNull();
    expect(score.kappa).toBeNull();
    expect(client.row.rawAgreement).toBeNull();
    expect(client.row.kappa).toBeNull();
  });
});

describe('scoreCalibrationRun — the constant-verdict floor, per denominator', () => {
  /** Minimal stand-in for hand-built rows — the `calibration()` builder cannot
   *  express a 'tie' KEY or a hand-picked key balance. It ENFORCES the filter
   *  the query relies on (`where.calibrationRunId`) for the same reason
   *  `fakeClient` above does (its docblock, :54-67): enforcing it here means a
   *  scorer that drops it fails a BEHAVIOUR test, where a fake that ignored it
   *  would let these three cases pass a shape test. It also carries the same
   *  nested `status` where-matcher `fakeClient` does, and for the same reason
   *  that one is now dead against the real query — the fixtures below always
   *  pass `status: 'completed'` on their own rows instead. `orderBy` is
   *  deliberately NOT honoured — every fixture below is handed in index order,
   *  and the ordering clause is already pinned by `fakeClient`'s own test.
   *  Captures every update's data. */
  type FindManyArgs = {
    where?: { calibrationRunId?: string };
    select?: { modelJudgments?: { where?: { status?: string } } };
  };
  type RowJudgment = {
    verdict: string | null;
    pairOrder: string;
    judgeModelVersionId: string;
    status: string;
  };
  type Row = {
    id: string;
    goldenItem: { id: string; index: number; expected: string };
    modelJudgments: RowJudgment[];
  };
  function rowsClient(
    calibrationRunId: string,
    runs: Row[]
  ): CalibrationScoreClient & { updates: Array<Record<string, unknown>> } {
    const updates: Array<Record<string, unknown>> = [];
    return {
      updates,
      evaluationRun: {
        findMany: async (args: FindManyArgs) => {
          if (args?.where?.calibrationRunId !== calibrationRunId) return [];
          const wanted = args?.select?.modelJudgments?.where?.status;
          return runs.map((r) => ({
            ...r,
            modelJudgments:
              wanted === undefined
                ? r.modelJudgments
                : r.modelJudgments.filter((j) => j.status === wanted),
          }));
        },
      },
      calibrationRun: {
        update: async (args: { data: Record<string, unknown> }) => {
          updates.push(args.data);
          return {};
        },
      },
    } as unknown as CalibrationScoreClient & { updates: Array<Record<string, unknown>> };
  }
  /** `status: 'completed'` is not decoration: without it `rowsClient`'s nested
   *  filter drops every judgment and all three cases below score nothing. */
  const item = (id: string, index: number, expected: string, verdict: string | null): Row => ({
    id: `run-${id}`,
    goldenItem: { id, index, expected },
    modelJudgments: [{ verdict, pairOrder: 'AB', judgeModelVersionId: 'v1', status: 'completed' }],
  });

  it('the always-A>B judge scores EXACTLY the floor — margin 0, and the floor names it', async () => {
    // The assertion that the emitted floor is the RIGHT floor: the judge
    // that defines it must land on it to the last bit.
    const alwaysAB = GROUND_TRUTH.map(() => 'A>B' as const);
    const score = await scoreCalibrationRun(CALIBRATION_ID, fakeClient(calibration(alwaysAB)));

    expect(score.constantBaseline).toEqual({
      accuracy: 17 / 30,
      preferences: ['A>B'],
      keyCounts: { 'A>B': 17, 'B>A': 13, tie: 0 },
      denominator: 30,
    });
    expect(score.accuracy).toBe(score.constantBaseline?.accuracy);
    expect(score.marginOverConstant).toBeCloseTo(0, 10);
  });

  it('a judge that matches the key on all 30 clears the floor by 13/30 — the margin has a SIGN', async () => {
    // Every other margin in this block is 0 by construction (a judge that IS
    // the stamp), and a margin of 0 is symmetric: with no signed oracle,
    // swapping the subtraction to floor − accuracy leaves the suite green
    // while the CLI prints Qwen's +0.30 as −0.30.
    const score = await scoreCalibrationRun(CALIBRATION_ID, fakeClient(calibration(GROUND_TRUTH)));

    expect(score.accuracy).toBe(1);
    expect(score.constantBaseline?.accuracy).toBeCloseTo(17 / 30, 10);
    expect(score.marginOverConstant).toBeCloseTo(1 - 17 / 30, 10);
    expect(score.marginOverConstant).toBeGreaterThan(0);
  });

  it("a judge BELOW the floor reports a NEGATIVE margin — granite4.1:3b's case, the reason the line exists", async () => {
    // 3 items keyed 2 'A>B' / 1 'B>A'; the judge answers 'B' every time, so it
    // is right once: accuracy 1/3 against a floor of 2/3. The motivating case
    // of the whole feature is a NEGATIVE margin, and nothing else here has one.
    const client = rowsClient('cal-below', [
      item('i1', 0, 'A>B', 'B'),
      item('i2', 1, 'A>B', 'B'),
      item('i3', 2, 'B>A', 'B'),
    ]);
    const score = await scoreCalibrationRun('cal-below', client);

    expect(score.accuracy).toBeCloseTo(1 / 3, 10);
    expect(score.constantBaseline).toEqual({
      accuracy: 2 / 3,
      preferences: ['A>B'],
      keyCounts: { 'A>B': 2, 'B>A': 1, tie: 0 },
      denominator: 3,
    });
    expect(score.marginOverConstant).toBeCloseTo(1 / 3 - 2 / 3, 10);
    expect(score.marginOverConstant).toBeLessThan(0);
    // The relation the CLI's ⚠ branch tests, pinned at the score level.
    expect(score.accuracy).toBeLessThan(score.constantBaseline?.accuracy ?? 0);
  });

  it("the floor is over the SCORED subset: 25 of 30 keyed 14/11 gives 0.5600, not the full set's 0.5667", async () => {
    // GROUND_TRUTH is 'A>B' at indices 0-16 and 'B>A' at 17-29. Holding back
    // three of the first group and two of the second leaves 14/11 over 25 —
    // run 9's exact shape (granite4.2:3b, five items lost to a repetition loop).
    const score = await scoreCalibrationRun(
      CALIBRATION_ID,
      fakeClient(calibration(GROUND_TRUTH, { pendingAt: [0, 1, 2, 17, 18] }))
    );

    expect(score.verdictCount).toBe(25);
    expect(score.constantBaseline?.keyCounts).toEqual({ 'A>B': 14, 'B>A': 11, tie: 0 });
    expect(score.constantBaseline?.denominator).toBe(25);
    expect(score.constantBaseline?.accuracy).toBeCloseTo(0.56, 10);
    expect(Math.abs((score.constantBaseline?.accuracy ?? 0) - 17 / 30)).toBeGreaterThan(0.005);
  });

  it("a COMPLETED judgment with a null verdict is outside the floor's denominator too", async () => {
    // Same five items, but these rows REACH the scoring loop (status
    // completed, verdict null) instead of being filtered out by the query.
    // This is the discriminating case: counting the key BEFORE the
    // null-verdict gate leaves the pendingAt test green and turns this red.
    const score = await scoreCalibrationRun(
      CALIBRATION_ID,
      fakeClient(calibration(GROUND_TRUTH, { missingAt: [0, 1, 2, 17, 18] }))
    );

    expect(score.missingVerdicts).toBe(5);
    expect(score.verdictCount).toBe(25);
    expect(score.constantBaseline).toEqual({
      accuracy: 14 / 25,
      preferences: ['A>B'],
      keyCounts: { 'A>B': 14, 'B>A': 11, tie: 0 },
      denominator: 25,
    });
  });

  it('keyCounts agree with the confusion matrix row sums, and the denominator IS verdictCount', async () => {
    // Two independent accumulators for one fact, pinned to each other. An
    // implementation that DERIVES one from the other passes this by
    // construction — the discriminating injection for keyCounts is the
    // null-verdict case above, not this one.
    const score = await scoreCalibrationRun(
      CALIBRATION_ID,
      fakeClient(calibration(withFlips(3), { missingAt: [4, 21] }))
    );
    const floor = score.constantBaseline;
    expect(floor).not.toBeNull();
    for (const expected of ['A>B', 'B>A', 'tie'] as const) {
      const rowSum = Object.values(score.confusion[expected]).reduce((a, b) => a + b, 0);
      expect(floor?.keyCounts[expected]).toBe(rowSum);
    }
    expect(floor?.denominator).toBe(score.verdictCount);
  });

  it('the floor is a property of the KEY: identical at pairOrder BA', async () => {
    const model = withFlips(3);
    const ab = await scoreCalibrationRun(CALIBRATION_ID, fakeClient(calibration(model, { order: 'AB' })));
    const ba = await scoreCalibrationRun(CALIBRATION_ID, fakeClient(calibration(model, { order: 'BA' })));

    // An absolute oracle first: comparing two absent fields to each other
    // passes in the red state (`expect(undefined).toEqual(undefined)`), which
    // would make this case decoration rather than a test.
    expect(ab.constantBaseline).toEqual({
      accuracy: 17 / 30,
      preferences: ['A>B'],
      keyCounts: { 'A>B': 17, 'B>A': 13, tie: 0 },
      denominator: 30,
    });
    expect(ba.constantBaseline).toEqual(ab.constantBaseline);
    expect(ba.marginOverConstant).toBe(ab.marginOverConstant);
  });

  it('a tie-containing KEY is scored, a tie verdict against it is a HIT, and the floor can be tie', async () => {
    // FIRST test in the repo of a 'tie' answer key. Reachable in production:
    // PATCH /api/golden-sets/[id]/items writes `expected` with no vocabulary
    // check on an unfrozen set, and readings.ts accepts 'tie' as ground truth.
    const client = rowsClient('cal-tie', [
      item('i1', 0, 'A>B', 'A'),
      item('i2', 1, 'tie', 'tie'),
      item('i3', 2, 'tie', 'A'),
    ]);
    const score = await scoreCalibrationRun('cal-tie', client);

    expect(score.verdictCount).toBe(3);
    expect(score.correctCount).toBe(2);
    expect(score.confusion.tie.tie).toBe(1);
    expect(score.constantBaseline).toEqual({
      accuracy: 2 / 3,
      preferences: ['tie'],
      keyCounts: { 'A>B': 1, 'B>A': 0, tie: 2 },
      denominator: 3,
    });
    expect(score.marginOverConstant).toBeCloseTo(0, 10);
  });

  it('a two-way tie of top key classes reports BOTH, in PREFERENCES order, never broken', async () => {
    const client = rowsClient('cal-even', [
      item('i1', 0, 'B>A', 'B'),
      item('i2', 1, 'A>B', 'A'),
      item('i3', 2, 'B>A', 'A'),
      item('i4', 3, 'A>B', 'B'),
    ]);
    const score = await scoreCalibrationRun('cal-even', client);

    expect(score.constantBaseline?.preferences).toEqual(['A>B', 'B>A']);
    expect(score.constantBaseline?.accuracy).toBe(0.5);
    expect(score.accuracy).toBe(0.5);
    expect(score.marginOverConstant).toBe(0);
  });

  it('nothing scored → no floor, no margin, and NULL (not 0) lands on the row', async () => {
    const client = fakeClient([]);
    const score = await scoreCalibrationRun(CALIBRATION_ID, client);

    expect(score.constantBaseline).toBeNull();
    expect(score.marginOverConstant).toBeNull();
    expect(client.updates[0].constantBaselineAccuracy).toBeNull();
  });

  it('the row carries the floor beside rawAgreement — same overwrite, same denominator', async () => {
    // The §8 scoreboard SQL reads CalibrationRun directly; without this the
    // query cannot show the floor beside the number it floors. Written in the
    // SAME full-overwrite update as rawAgreement/verdictCount, so re-scoring
    // after a drain moves all three together.
    const client = fakeClient(calibration(withFlips(3), { pendingAt: [0, 1, 2, 17, 18] }));
    const score = await scoreCalibrationRun(CALIBRATION_ID, client);
    const data = client.updates[0];

    expect(data.constantBaselineAccuracy).toBe(score.constantBaseline?.accuracy);
    expect(data.constantBaselineAccuracy).toBeCloseTo(0.56, 10);
    expect(data.rawAgreement).toBe(score.accuracy);
    expect(data.verdictCount).toBe(25);
  });
});

describe('scoreCalibrationRun — what lands on the CalibrationRun row', () => {
  it('writes rawAgreement === accuracy, plus the labels that make kappa readable', async () => {
    const client = fakeClient(calibration(withFlips(3)));
    const score = await scoreCalibrationRun(CALIBRATION_ID, client);

    expect(client.updates).toHaveLength(1);
    const data = client.updates[0];
    // rawAgreement IS accuracy. The column predates this phase and the name
    // is inherited; storing anything else there would make two columns that
    // sound like the same number disagree.
    expect(data.rawAgreement).toBe(score.accuracy);
    expect(data.kappa).toBe(score.kappa);
    expect(data.verdictCount).toBe(30);
    expect(data.kappaVariant).toBe('cohen');
    expect(data.kappaWeighting).toBe('none');
    expect(data.thresholdMetric).toBe('accuracy');
    expect(data.finishedAt).toBeInstanceOf(Date);
  });

  it("kappaWeighting is 'none' because a preference has no distance", async () => {
    // 'A>B' vs 'tie' is not closer than 'A>B' vs 'B>A' — that would be a
    // claim about the domain. agreement() downgrades any requested weighting
    // for non-numeric categories, and the stored label must report what was
    // USED rather than what was asked for.
    const client = fakeClient(calibration(GROUND_TRUTH));
    const score = await scoreCalibrationRun(CALIBRATION_ID, client);
    expect(score.method.weighting).toBe('none');
    expect(score.method.statistic).toBe('cohen');
    expect(score.method.annotatorCount).toBe(2);
    expect(score.method.itemCount).toBe(30);
  });

  it('re-scoring is idempotent: same numbers, and verdictCount does not double', async () => {
    // The landmine is `verdictCount`, an Int with @default(0): an
    // implementation reaching for `{ increment }` reads perfectly and
    // produces 60 on the second pass. Every field is a full overwrite
    // recomputed from the source rows, so a re-score after a partial failure
    // resumes rather than accumulating.
    const client = fakeClient(calibration(withFlips(3)));
    const first = await scoreCalibrationRun(CALIBRATION_ID, client);
    const second = await scoreCalibrationRun(CALIBRATION_ID, client);

    expect(second).toEqual(first);
    expect(client.row.verdictCount).toBe(30);
    expect(client.row.rawAgreement).toBe(first.accuracy);
    expect(client.row.kappa).toBe(first.kappa);
  });
});

describe('scoreCalibrationRun — rows that are not measurements', () => {
  it('an EvaluationRun with no golden item contributes to nothing', async () => {
    // `EvaluationRun.goldenItemId` is nullable and Postgres' default NULLS
    // DISTINCT lets @@unique([calibrationRunId, goldenItemId]) hold any number
    // of them, so a stray link is expressible. It cannot be scored against a
    // key it does not have; counting it as a miss would penalise a judge for
    // a row the launcher wrote wrong.
    const runs = calibration(GROUND_TRUTH);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- modelling a nullable FK the fixture builder cannot express
    (runs[0] as any).goldenItem = null;
    const score = await scoreCalibrationRun(CALIBRATION_ID, fakeClient(runs));

    expect(score.verdictCount).toBe(29);
    expect(score.itemCount).toBe(29);
    expect(score.accuracy).toBe(1);
    expect(score.disagreements).toEqual([]);
  });

  it('a judgment with no judgeModelVersionId still resolves to ONE rater', async () => {
    // modelConfigId/judgeModelVersionId are dual-written and both nullable
    // (see judge-identity.ts). If the id is absent the readings still need a
    // rater name, and it must be the SAME name for every row — a per-row
    // fallback would mint one rater per item, which is `insufficient-overlap`
    // for every item and a null kappa for a calibration that ran fine.
    const runs = calibration(GROUND_TRUTH).map((r) => ({
      ...r,
      modelJudgments: r.modelJudgments.map((j) => ({ ...j, judgeModelVersionId: null })),
    }));
    const score = await scoreCalibrationRun(CALIBRATION_ID, fakeClient(runs));

    expect(score.method.annotatorCount).toBe(2);
    expect(score.accuracy).toBe(1);
    expect(score.kappa).toBeCloseTo(1, 10);
  });
});

describe('scoreCalibrationRun — the disagreement list is the debugging surface', () => {
  it('names every missed item with the key, the derived preference and the raw verdict', async () => {
    const model = [...GROUND_TRUTH] as Preference[];
    model[5] = 'B>A'; // key says 'A>B'
    model[20] = 'A>B'; // key says 'B>A'
    const client = fakeClient(calibration(model));
    const score = await scoreCalibrationRun(CALIBRATION_ID, client);

    expect(score.disagreements).toEqual([
      {
        itemId: 'item-5',
        itemIndex: 5,
        runId: 'run-5',
        expected: 'A>B',
        actual: 'B>A',
        verdict: 'B',
        pairOrder: 'AB',
      },
      {
        itemId: 'item-20',
        itemIndex: 20,
        runId: 'run-20',
        expected: 'B>A',
        actual: 'A>B',
        verdict: 'A',
        pairOrder: 'AB',
      },
    ]);
  });

  it('reports the run and index of the item actually missed, even when rows were skipped', async () => {
    // THE PARALLEL-ARRAY TRAP. `itemIndex`/`runId` come from a `context` array
    // built alongside `rows`, and every skip — a pending judgment, a run with
    // no golden item — must skip BOTH or the two slide out of step. The
    // disagreement then carries the right `itemId` beside the wrong `runId`,
    // pointing an operator at an item the judge got right. Nothing downstream
    // can spot that, because every field is individually well-formed.
    //
    // The other disagreement tests use a full 30/30 calibration, where an
    // off-by-five misalignment is invisible. This one skips the first five
    // items and then disagrees, so the two arrays are only in step if the
    // skips were applied to both.
    const model = [...GROUND_TRUTH] as Preference[];
    model[10] = 'B>A'; // key says 'A>B'
    model[25] = 'A>B'; // key says 'B>A'
    const client = fakeClient(calibration(model, { pendingAt: [0, 1, 2, 3, 4] }));
    const score = await scoreCalibrationRun(CALIBRATION_ID, client);

    expect(score.verdictCount).toBe(25);
    expect(score.disagreements).toEqual([
      {
        itemId: 'item-10',
        itemIndex: 10,
        runId: 'run-10',
        expected: 'A>B',
        actual: 'B>A',
        verdict: 'B',
        pairOrder: 'AB',
      },
      {
        itemId: 'item-25',
        itemIndex: 25,
        runId: 'run-25',
        expected: 'B>A',
        actual: 'A>B',
        verdict: 'A',
        pairOrder: 'AB',
      },
    ]);
  });

  it('is ordered by golden-item index even when the rows arrive shuffled', async () => {
    // Postgres returns rows in no guaranteed order, so the scorer asks for
    // `orderBy: { goldenItem: { index: 'asc' } }`. Drop that clause and the
    // disagreement list an operator reads comes back in planner order — the
    // numbers all stay correct, so only the list's READABILITY breaks, which
    // is exactly the kind of regression that survives a review. The fixture is
    // handed in reversed so the clause has something to do.
    const model = [...GROUND_TRUTH] as Preference[];
    model[3] = 'B>A';
    model[12] = 'B>A';
    model[28] = 'A>B';
    const client = fakeClient([...calibration(model)].reverse());
    const score = await scoreCalibrationRun(CALIBRATION_ID, client);

    expect(score.disagreements.map((d) => d.itemIndex)).toEqual([3, 12, 28]);
    expect(score.disagreements.map((d) => d.runId)).toEqual(['run-3', 'run-12', 'run-28']);
  });

  it('the confusion matrix is fully populated over the whole preference space', async () => {
    // Fixed rows and columns, zeros included, so a matrix from one set is the
    // same shape as a matrix from another — the cross-set comparison this
    // phase exists for. An absent key would be indistinguishable from a zero.
    const client = fakeClient(calibration(withFlips(3)));
    const score = await scoreCalibrationRun(CALIBRATION_ID, client);

    expect(score.confusion).toEqual({
      'A>B': { 'A>B': 14, 'B>A': 3, tie: 0 },
      'B>A': { 'A>B': 3, 'B>A': 10, tie: 0 },
      tie: { 'A>B': 0, 'B>A': 0, tie: 0 },
    });
  });
});

describe('scoreCalibrationRun — items that produced NOTHING', () => {
  // Regression for the first production calibration (2026-08-31), which
  // reported `missingVerdicts 0` while four of thirty items had dead-lettered.
  // Two DISTINCT shapes both have to land as missing, and this block pins
  // both: a judgment row that EXISTS but never reached 'completed' (the
  // completed-only filter now lives in the partition, not the query, so this
  // row is no longer stripped before score.ts sees it), and a run with NO
  // judgment row at all — unreachable today (launchSingleRun nests a run's
  // judgments in the same evaluationRun.create) but still covered, because
  // the OLD flat loop counted `modelJudgments.length === 0` here and the
  // partitioned version must not silently stop doing so.
  const goldenItem = (id: string, index: number, expected: string) => ({ id, index, expected });

  function clientWith(runs: unknown[]): CalibrationScoreClient {
    return {
      evaluationRun: { findMany: async () => runs },
      calibrationRun: { update: async () => ({}) },
    } as unknown as CalibrationScoreClient;
  }

  it('counts a run whose judgment errored as a MISSING verdict, not as absent', async () => {
    const client = clientWith([
      {
        id: 'r1',
        goldenItem: goldenItem('i1', 0, 'A>B'),
        modelJudgments: [{ verdict: 'A', pairOrder: 'AB', judgeModelVersionId: 'v1', status: 'completed' }],
      },
      // Errored/DLQ'd: the row exists (the query no longer filters it out)
      // but its status is never 'completed'.
      {
        id: 'r2',
        goldenItem: goldenItem('i2', 1, 'B>A'),
        modelJudgments: [{ verdict: null, pairOrder: 'AB', judgeModelVersionId: 'v1', status: 'error' }],
      },
      // The OTHER shape: no judgment row at all. Currently unreachable in
      // production, but `scoreCalibrationRun` must keep counting it in both
      // `dispatchedItemCount` and `missingVerdicts` regardless — that is
      // exactly what `judgmentlessRuns` in score.ts exists to guarantee.
      { id: 'r3', goldenItem: goldenItem('i3', 2, 'A>B'), modelJudgments: [] },
    ]);

    const score = await scoreCalibrationRun('cal-1', client);

    expect(score.verdictCount).toBe(1);
    expect(score.missingVerdicts).toBe(2);
    // The denominator and the missing count must describe the same 3 items.
    expect(score.verdictCount + score.missingVerdicts).toBe(3);
    expect(score.accuracy).toBe(1);
    expect(score.dispatchedItemCount).toBe(3);
  });

  it('reports 0 missing when every launched item produced a verdict', async () => {
    const client = clientWith([
      {
        id: 'r1',
        goldenItem: goldenItem('i1', 0, 'A>B'),
        modelJudgments: [{ verdict: 'A', pairOrder: 'AB', judgeModelVersionId: 'v1', status: 'completed' }],
      },
      {
        id: 'r2',
        goldenItem: goldenItem('i2', 1, 'B>A'),
        modelJudgments: [{ verdict: 'B', pairOrder: 'AB', judgeModelVersionId: 'v1', status: 'completed' }],
      },
    ]);
    const score = await scoreCalibrationRun('cal-2', client);
    expect(score.missingVerdicts).toBe(0);
    expect(score.verdictCount).toBe(2);
  });
});

describe('scoreCalibrationRun — coverage and selective accuracy', () => {
  /** Hand-built rows, the same stand-in shape and for the same reason as the
   *  constant-floor block above: `calibration()` cannot express a hand-picked
   *  key balance or a 'tie' KEY, and both are load-bearing here. It ENFORCES
   *  the `calibrationRunId` filter so a scorer that drops it fails a
   *  BEHAVIOUR test. It also carries the same nested `status` where-matcher
   *  as `rowsClient` above, which the real query no longer sends — every
   *  fixture below passes `status: 'completed'` on its own rows instead.
   *  `orderBy` is not honoured; every fixture below is handed in index order
   *  and the ordering clause is pinned by `fakeClient`'s own test. */
  type CoverageArgs = {
    where?: { calibrationRunId?: string };
    select?: { modelJudgments?: { where?: { status?: string } } };
  };
  type CoverageRow = {
    id: string;
    goldenItem: { id: string; index: number; expected: string };
    modelJudgments: Array<{
      verdict: string | null;
      pairOrder: string;
      judgeModelVersionId: string;
      status: string;
    }>;
  };
  function coverageClient(
    calibrationRunId: string,
    rows: CoverageRow[]
  ): CalibrationScoreClient & { updates: Array<Record<string, unknown>> } {
    const updates: Array<Record<string, unknown>> = [];
    return {
      updates,
      evaluationRun: {
        findMany: async (args: CoverageArgs) => {
          if (args?.where?.calibrationRunId !== calibrationRunId) return [];
          const wanted = args?.select?.modelJudgments?.where?.status;
          return rows.map((r) => ({
            ...r,
            modelJudgments:
              wanted === undefined
                ? r.modelJudgments
                : r.modelJudgments.filter((j) => j.status === wanted),
          }));
        },
      },
      calibrationRun: {
        update: async (args: { data: Record<string, unknown> }) => {
          updates.push(args.data);
          return {};
        },
      },
    } as unknown as CalibrationScoreClient & { updates: Array<Record<string, unknown>> };
  }
  const row = (index: number, expected: string, verdict: string | null): CoverageRow => ({
    id: `run-${index}`,
    goldenItem: { id: `item-${index}`, index, expected },
    modelJudgments: [{ verdict, pairOrder: 'AB', judgeModelVersionId: 'v1', status: 'completed' }],
  });
  // `coverageClient`/`row` duplicate `rowsClient`/`item` in the constant-floor
  // describe above almost exactly. That is a DELIBERATE choice, not an oversight:
  // hoisting the existing pair to module scope would move ~50 lines of a passing
  // block in the same commit that adds eight tests, and one concern per commit
  // wins. The cost is real and is written down here so the next reader does not
  // have to rediscover it — a change to the query shape has to be made twice, and
  // the copy that is not updated keeps passing. Fold them together in a
  // follow-up commit that touches nothing else.

  it('a judge that never abstains has coverage 1 and selective accuracy EQUAL to accuracy', async () => {
    // The degenerate case, and the one that proves the new fields do not
    // silently redefine the old one: with no ties the two denominators are the
    // same set, so every number must coincide.
    const score = await scoreCalibrationRun(CALIBRATION_ID, fakeClient(calibration(withFlips(3))));

    expect(score.coverage).toBe(1);
    expect(score.committedCount).toBe(30);
    expect(score.abstainedCount).toBe(0);
    expect(score.committedCorrectCount).toBe(score.correctCount);
    expect(score.selectiveAccuracy).toBe(score.accuracy);
    expect(score.selectiveBaseline).toEqual(score.constantBaseline);
  });

  it('three ties: ACCURACY stays 0.9000 and selective accuracy is 1.0 — the split the metric exists for', async () => {
    // Fixture S2. The accuracy assertion is copied from the pre-existing test
    // at :222 deliberately: this is the pin that rawAgreement's MEANING did not
    // move when coverage landed beside it.
    const withTies = [...GROUND_TRUTH] as Preference[];
    withTies[0] = 'tie';
    withTies[1] = 'tie';
    withTies[2] = 'tie';
    const client = fakeClient(calibration(withTies));
    const score = await scoreCalibrationRun(CALIBRATION_ID, client);

    expect(score.accuracy).toBeCloseTo(0.9, 10);
    expect(score.correctCount).toBe(27);
    expect(score.verdictCount).toBe(30);
    expect(score.coverage).toBeCloseTo(0.9, 10);
    expect(score.committedCount).toBe(27);
    expect(score.abstainedCount).toBe(3);
    expect(score.committedCorrectCount).toBe(27);
    expect(score.selectiveAccuracy).toBe(1);
    // Committed key is 14 'A>B' / 13 'B>A' — the three abstentions came off the
    // 'A>B' side, so the floor MOVES from 17/30 to 14/27.
    expect(score.selectiveBaseline?.accuracy).toBeCloseTo(14 / 27, 10);
    expect(score.constantBaseline?.accuracy).toBeCloseTo(17 / 30, 10);
    expect(score.selectiveMarginOverConstant).toBeCloseTo(1 - 14 / 27, 10);

    // rawAgreement MUST NOT CHANGE, pinned HERE because accuracy (0.9) and
    // selective accuracy (1.0) DIFFER on this fixture. Every PRE-EXISTING
    // rawAgreement assertion — :296 (both null), :545, :560 and :594 — runs on a
    // `withFlips(3)` fixture, and `withFlips` (:141-155) only swaps 'A>B'<->'B>A'
    // and emits no 'tie', so on all of them the two numbers are IDENTICALLY equal
    // and none can see "selective accuracy is the better metric, store it in the
    // column that already exists". This assertion and the `cal-s3` row test below
    // are the only two places in the file where that swap is visible.
    expect(score.selectiveAccuracy).not.toBe(score.accuracy);
    expect(client.updates[0].rawAgreement).toBe(score.accuracy);
    expect(client.updates[0].rawAgreement).toBeCloseTo(0.9, 10);
  });

  it('the selective floor is over the COMMITTED subset — and here it names a DIFFERENT class', async () => {
    // Fixture S3, and the only assertion in this file that can catch
    // `constantVerdictBaseline(keyCounts)` written where
    // `constantVerdictBaseline(committedKeyCounts)` belongs. The two floors
    // differ in their TOP CLASS, not just in a decimal: the judge abstained on
    // three 'A>B' items, which flips the plurality of what remains.
    const score = await scoreCalibrationRun(
      'cal-s3',
      coverageClient('cal-s3', [
        row(0, 'A>B', 'tie'),
        row(1, 'A>B', 'tie'),
        row(2, 'A>B', 'tie'),
        row(3, 'A>B', 'A'),
        row(4, 'A>B', 'A'),
        row(5, 'A>B', 'B'),
        row(6, 'B>A', 'B'),
        row(7, 'B>A', 'B'),
        row(8, 'B>A', 'B'),
        row(9, 'B>A', 'A'),
      ])
    );

    expect(score.verdictCount).toBe(10);
    expect(score.correctCount).toBe(5);
    expect(score.accuracy).toBe(0.5);
    expect(score.coverage).toBeCloseTo(0.7, 10);
    expect(score.committedCount).toBe(7);
    expect(score.committedCorrectCount).toBe(5);
    expect(score.selectiveAccuracy).toBeCloseTo(5 / 7, 10);

    expect(score.constantBaseline).toEqual({
      accuracy: 0.6,
      preferences: ['A>B'],
      keyCounts: { 'A>B': 6, 'B>A': 4, tie: 0 },
      denominator: 10,
    });
    expect(score.selectiveBaseline).toEqual({
      accuracy: 4 / 7,
      preferences: ['B>A'],
      keyCounts: { 'A>B': 3, 'B>A': 4, tie: 0 },
      denominator: 7,
    });
    expect(score.selectiveMarginOverConstant).toBeCloseTo(5 / 7 - 4 / 7, 10);
  });

  it('a CORRECT tie against a tie KEY is not a commitment — selective accuracy cannot exceed 1', async () => {
    // Fixture S4. A tie key is reachable (PATCH /api/golden-sets/[id]/items
    // writes `expected` with no vocabulary check on an unfrozen set) and a tie
    // verdict against it is a HIT, which score.ts:54-63 preserves on purpose.
    // Reusing `correctCount` as the selective numerator over a denominator that
    // excluded those hits gives 3/2 = 1.5.
    const score = await scoreCalibrationRun(
      'cal-s4',
      coverageClient('cal-s4', [
        row(0, 'tie', 'tie'),
        row(1, 'tie', 'tie'),
        row(2, 'A>B', 'A'),
        row(3, 'A>B', 'B'),
      ])
    );

    expect(score.correctCount).toBe(3);
    expect(score.committedCount).toBe(2);
    expect(score.committedCorrectCount).toBe(1);
    expect(score.selectiveAccuracy).toBe(0.5);
    expect(score.selectiveAccuracy).toBeLessThanOrEqual(1);
  });

  it('a judge that committed to NOTHING reports selectiveAccuracy null — not 0, not 1, not NaN', async () => {
    // Fixture S5, and a real production shape: cmton7ip500012lyjubiqohy8 has 16
    // completed judgments and committed on ONE.
    const score = await scoreCalibrationRun(
      'cal-s5',
      coverageClient('cal-s5', [row(0, 'A>B', 'tie'), row(1, 'A>B', 'tie'), row(2, 'A>B', 'tie')])
    );

    expect(score.verdictCount).toBe(3);
    expect(score.committedCount).toBe(0);
    expect(score.abstainedCount).toBe(3);
    // Coverage 0 IS a measurement: the judge answered three times and committed
    // to none of them. Selective accuracy is not.
    expect(score.coverage).toBe(0);
    expect(score.selectiveAccuracy).toBeNull();
    expect(score.selectiveBaseline).toBeNull();
    expect(score.selectiveMarginOverConstant).toBeNull();
    expect(Number.isNaN(score.selectiveAccuracy as unknown as number)).toBe(false);
  });

  it('nothing scored at all: coverage is null too, and the counts are 0', async () => {
    const score = await scoreCalibrationRun('cal-empty', coverageClient('cal-empty', []));

    expect(score.verdictCount).toBe(0);
    expect(score.coverage).toBeNull();
    expect(score.selectiveAccuracy).toBeNull();
    expect(score.committedCount).toBe(0);
    expect(score.abstainedCount).toBe(0);
    expect(score.committedCorrectCount).toBe(0);
  });

  it('the row carries committedCount, selectiveAccuracy, its floor AND the scoring version', async () => {
    // One full overwrite: the numbers and the stamp that says which rules made
    // them cannot move independently.
    const client = coverageClient('cal-s3', [
      row(0, 'A>B', 'tie'),
      row(1, 'A>B', 'tie'),
      row(2, 'A>B', 'tie'),
      row(3, 'A>B', 'A'),
      row(4, 'A>B', 'A'),
      row(5, 'A>B', 'B'),
      row(6, 'B>A', 'B'),
      row(7, 'B>A', 'B'),
      row(8, 'B>A', 'B'),
      row(9, 'B>A', 'A'),
    ]);
    await scoreCalibrationRun('cal-s3', client);

    expect(client.updates).toHaveLength(1);
    const data = client.updates[0];
    expect(data.rawAgreement).toBe(0.5);
    expect(data.committedCount).toBe(7);
    expect(data.selectiveAccuracy).toBeCloseTo(5 / 7, 10);
    expect(data.selectiveBaselineAccuracy).toBeCloseTo(4 / 7, 10);
    // Written from the CONSTANT, and asserted against BOTH the constant and the
    // literal 2. The constant alone cannot tell a hardcoded literal from a
    // reference (they are equal today); the literal alone would not fail when
    // the constant is bumped without the write following it.
    expect(data.scoringVersion).toBe(SCORING_RULES_VERSION);
    expect(data.scoringVersion).toBe(3);
    // The floor over ALL scored items is a DIFFERENT column and a different
    // number — 0.6 against 4/7. Two floors on one row, and the wrong one is the
    // one that gets quoted.
    expect(data.constantBaselineAccuracy).toBe(0.6);
  });

  it('re-scoring is idempotent on the new fields too — nothing accumulates', async () => {
    const rows = [row(0, 'A>B', 'tie'), row(1, 'A>B', 'A'), row(2, 'B>A', 'B')];
    const client = coverageClient('cal-idem', rows);
    const first = await scoreCalibrationRun('cal-idem', client);
    const second = await scoreCalibrationRun('cal-idem', client);

    expect(second.committedCount).toBe(first.committedCount);
    expect(second.abstainedCount).toBe(first.abstainedCount);
    expect(second.committedCorrectCount).toBe(first.committedCorrectCount);
    expect(second.coverage).toBe(first.coverage);
    expect(second.selectiveAccuracy).toBe(first.selectiveAccuracy);
    expect(client.updates[1].committedCount).toBe(2);
  });
});

describe('scoreCalibrationRun — noVerdictRate: a FLEET property, never abstention', () => {
  /** Rows that can be SHAPED, which is what this block is about: an item the
   *  judge was asked and that produced nothing at all. Two shapes reach the
   *  scorer differently and both are exercised — a COMPLETED judgment whose
   *  verdict is null, and a judgment row whose status never reached
   *  'completed' (the query sends every row regardless of status now; the
   *  `wanted`/nested-status matcher below mirrors `fakeClient`'s and is dead
   *  the same way — it is score.ts's OWN partition that filters these out).
   *  A THIRD shape, an EvaluationRun with no goldenItem, was never asked
   *  about anything and must be counted in neither. */
  type FleetRow = {
    id: string;
    goldenItem: { id: string; index: number; expected: string } | null;
    modelJudgments: Array<{
      verdict: string | null;
      pairOrder: string;
      judgeModelVersionId: string;
      status: string;
    }>;
  };
  type FleetArgs = {
    where?: { calibrationRunId?: string };
    select?: { modelJudgments?: { where?: { status?: string } } };
  };
  function fleetClient(calibrationRunId: string, rows: FleetRow[]): CalibrationScoreClient {
    return {
      evaluationRun: {
        findMany: async (args: FleetArgs) => {
          if (args?.where?.calibrationRunId !== calibrationRunId) return [];
          const wanted = args?.select?.modelJudgments?.where?.status;
          return rows.map((r) => ({
            ...r,
            modelJudgments:
              wanted === undefined
                ? r.modelJudgments
                : r.modelJudgments.filter((j) => j.status === wanted),
          }));
        },
      },
      calibrationRun: { update: async () => ({}) },
    } as unknown as CalibrationScoreClient;
  }
  const judgment = (verdict: string | null, status: string) => ({
    verdict,
    pairOrder: 'AB',
    judgeModelVersionId: 'v1',
    status,
  });
  /** `answered` items are keyed 'A>B' and answered 'A', so the run is also a
   *  perfect judge — deliberately, so that nothing below can be read off
   *  accuracy or coverage by accident. */
  function fleet(counts: {
    answered: number;
    truncated: number;
    dead: number;
    orphaned?: number;
  }): FleetRow[] {
    const rows: FleetRow[] = [];
    let i = 0;
    const item = (index: number) => ({ id: `item-${index}`, index, expected: 'A>B' });
    for (let n = 0; n < counts.answered; n++, i++)
      rows.push({ id: `run-${i}`, goldenItem: item(i), modelJudgments: [judgment('A', 'completed')] });
    // finishReason='length': the request came back and carried no usable verdict.
    for (let n = 0; n < counts.truncated; n++, i++)
      rows.push({ id: `run-${i}`, goldenItem: item(i), modelJudgments: [judgment(null, 'completed')] });
    // A dead request: nothing ever COMPLETED, so the status filter leaves the
    // scorer an empty array and only `unjudgedItems` can see it.
    for (let n = 0; n < counts.dead; n++, i++)
      rows.push({ id: `run-${i}`, goldenItem: item(i), modelJudgments: [judgment(null, 'error')] });
    for (let n = 0; n < (counts.orphaned ?? 0); n++, i++)
      rows.push({ id: `run-${i}`, goldenItem: null, modelJudgments: [judgment('A', 'completed')] });
    return rows;
  }

  it('N1 — lfm2.5:8b: 17 of 620 asked items produced nothing, over BOTH shapes', async () => {
    // cmtondblm…, the production shape this metric exists for. 603 verdicts is
    // what rawAgreement was scored over; 620 is what the judge was ASKED.
    const score = await scoreCalibrationRun(
      'cal-n1',
      fleetClient('cal-n1', fleet({ answered: 603, truncated: 9, dead: 8 }))
    );

    expect(score.dispatchedItemCount).toBe(620);
    expect(score.verdictCount).toBe(603);
    expect(score.missingVerdicts).toBe(17);
    expect(score.noVerdictRate).toBeCloseTo(17 / 620, 10);
    expect(score.noVerdictRate?.toFixed(4)).toBe('0.0274');
    // The identity that holds in phase 1 — one judgment per run. It is ASSERTED
    // rather than assumed because a BA sweep breaking it is the thing the
    // separate accumulator exists to make visible.
    expect(score.dispatchedItemCount).toBe(score.verdictCount + score.missingVerdicts);
  });

  it('N2 — Qwen3.6: a HEALTHY run is not zero, it is 1/620', async () => {
    const score = await scoreCalibrationRun(
      'cal-n2',
      fleetClient('cal-n2', fleet({ answered: 619, truncated: 1, dead: 0 }))
    );

    expect(score.dispatchedItemCount).toBe(620);
    expect(score.verdictCount).toBe(619);
    expect(score.noVerdictRate).toBeCloseTo(1 / 620, 10);
    expect(score.noVerdictRate?.toFixed(4)).toBe('0.0016');
  });

  it('N3 — lfm2.5-thinking: everything answered reports 0, NEVER null', async () => {
    // "Nothing was lost" is a measurement. Paired with N4's `toBeNull()` on
    // purpose: a single `toBeFalsy()` would pass on both and pin neither.
    const score = await scoreCalibrationRun(
      'cal-n3',
      fleetClient('cal-n3', fleet({ answered: 620, truncated: 0, dead: 0 }))
    );

    expect(score.dispatchedItemCount).toBe(620);
    expect(score.missingVerdicts).toBe(0);
    expect(score.noVerdictRate).toBe(0);
    expect(score.noVerdictRate).not.toBeNull();
  });

  it('N4 — nothing dispatched reports null, not 0 and not NaN from 0/0', async () => {
    const score = await scoreCalibrationRun('cal-n4', fleetClient('cal-n4', []));

    expect(score.dispatchedItemCount).toBe(0);
    expect(score.missingVerdicts).toBe(0);
    expect(score.noVerdictRate).toBeNull();
    expect(Number.isNaN(score.noVerdictRate as unknown as number)).toBe(false);
  });

  it('N5 — the DISCRIMINATOR: the denominator is DISPATCHED, not verdictCount', async () => {
    // 8 of 10 asked items produced nothing. Over `verdictCount` this is 8/2 =
    // 4.0 — above 1, which no rate can be. N1/N2/N6 cannot separate the two
    // denominators sharply enough to be evidence; this one can.
    const score = await scoreCalibrationRun(
      'cal-n5',
      fleetClient('cal-n5', fleet({ answered: 2, truncated: 3, dead: 5 }))
    );

    expect(score.dispatchedItemCount).toBe(10);
    expect(score.verdictCount).toBe(2);
    expect(score.missingVerdicts).toBe(8);
    expect(score.noVerdictRate).toBeCloseTo(0.8, 10);
    expect(score.noVerdictRate).toBeLessThanOrEqual(1);
  });

  it('N6 — the VOID run reads as abandoned, not as a judge that answered 16 times', async () => {
    // cmton7ip5…: 604 of 620 asked items produced nothing. rawAgreement over
    // the surviving 16 says nothing about the run, and this line says so.
    const score = await scoreCalibrationRun(
      'cal-n6',
      fleetClient('cal-n6', fleet({ answered: 16, truncated: 0, dead: 604 }))
    );

    expect(score.dispatchedItemCount).toBe(620);
    expect(score.verdictCount).toBe(16);
    expect(score.missingVerdicts).toBe(604);
    expect(score.noVerdictRate?.toFixed(4)).toBe('0.9742');
  });

  it('an EvaluationRun with NO golden item was never ASKED — it is dispatched to nothing', async () => {
    // `dispatchedItemCount` sits past the same `goldenItem === null` gate as
    // every other count: a row that cannot be scored against anything did not
    // ask a question either, and counting it would invent a denominator.
    const score = await scoreCalibrationRun(
      'cal-orphan',
      fleetClient('cal-orphan', fleet({ answered: 5, truncated: 0, dead: 0, orphaned: 3 }))
    );

    expect(score.dispatchedItemCount).toBe(5);
    expect(score.verdictCount).toBe(5);
    expect(score.missingVerdicts).toBe(0);
    expect(score.noVerdictRate).toBe(0);
  });
});
