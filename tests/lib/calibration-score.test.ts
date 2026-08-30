import { describe, expect, it } from 'vitest';
import {
  scoreCalibrationRun,
  type CalibrationScoreClient,
} from '@/lib/calibration/score';
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
 * A Prisma stand-in that honours the three things the query actually relies
 * on: the `calibrationRunId` filter, the nested `status: 'completed'` filter
 * on modelJudgments, and the `orderBy` on the related golden item's index.
 * All three are enforced here rather than asserted on the call args, so a
 * scorer that forgot one FAILS a behaviour test instead of passing a shape
 * test.
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
