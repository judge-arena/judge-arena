import { describe, expect, it, vi } from 'vitest';

/**
 * ─── THE THREE PERMUTATION DETECTORS (spec §5) ──────────────────────────────
 *
 * A permuted calibration judges every golden item in BOTH screen orders, as
 * two `EvaluationRun`s sharing a `goldenItemId`, one `ModelJudgment` each. The
 * swap happens in exactly ONE place — `buildPairwiseUserPrompt` presents the
 * sorted candidates in the requested order — and is undone in exactly one
 * place — `preferenceFromVerdict` maps the verdict letter back to a candidate.
 * Two inversions, net identity.
 *
 * ── BUILD IT WRONG AND THERE IS NO SYMPTOM ──────────────────────────────────
 *
 * Every number stays in range, the confusion matrix stays square, accuracy
 * lands on a plausible `1 − x`, and only the ranking silently inverts. Three
 * wrong builds produce it:
 *
 *   K  — mirror the answer key (invert `GoldenItem.expected` on the BA side).
 *        Forbidden by design: the GoldenSet is never modified.
 *   W  — materialise the swap into `RunCandidate.position`. Then the render's
 *        ascending sort by `position` re-sorts it, the `order === 'AB' ? … :
 *        …` line reverses it again, THE MIRROR PROMPT COMES OUT BYTE-IDENTICAL
 *        TO AB, and `preferenceFromVerdict` inverts anyway — every mirror
 *        verdict filed against the wrong candidate.
 *   W3 — never thread the order to the renderer but stamp the judgment 'BA'.
 *        Same outcome as W, one layer up (`defaultRunProviderPairwise` is the
 *        layer that reads `judgment.pairOrder`).
 *
 * ── WHY THE CONSTANT FLOOR IS NOT THE DETECTOR ──────────────────────────────
 *
 * Verified against production (`GoldenSet cmt057h5d00097y01ymubpre5`, 620 live
 * items): the key is 336 `A>B` / 284 `B>A`, floor 336/620 = 0.5419355. Under
 * the CORRECT build the pooled key doubles UNIFORMLY to 672/568 and the pooled
 * floor is 0.5419355 — bit-identical. Under build W it is ALSO 0.5419355. So
 * "the floor didn't change" fires on every correct run and passes both silent
 * wrong builds. That assertion is not written anywhere in this file except as
 * the deliberate demonstration in `describe('the trap')`, which asserts the
 * floor is EQUAL under V and W precisely to show it carries no signal.
 *
 * ── WHAT EACH DETECTOR ACTUALLY SEES ────────────────────────────────────────
 *
 *   detector | V (correct) | K      | W      | W3
 *   A  floor |   pass      | FAIL   | pass   | pass
 *   B  bytes |   pass      | pass   | FAIL   | FAIL
 *   C  oracle|   pass      | FAIL   | FAIL   | FAIL
 *
 * Every cell above is executed by `describe('discrimination')` at the bottom
 * of this file: the wrong builds are constructed here, run through the same
 * pipeline, and each detector's own predicate is asserted to be FALSE under
 * the builds it exists to catch. A detector that passes under both the correct
 * and the broken build is not a detector.
 *
 * ── HOW MUCH OF THIS IS REAL ────────────────────────────────────────────────
 *
 * `runPermutedCalibration` below is the launch→worker→provider→read chain with
 * ONLY the launch's `RunCandidate` materialisation simulated (so that build W
 * can be injected here). Everything downstream is production code, running for
 * real:
 *
 *   `defaultRunProviderPairwise` (src/worker/judgment-consumer.ts)  reads
 *      `judgment.pairOrder` and maps `run.runCandidates` into the submission
 *   `prepareJudgmentCall` → `renderJudgmentPrompt` → `buildPairwiseUserPrompt`
 *      (src/lib/llm/registry.ts, src/lib/llm/render.ts)  applies the swap
 *   `callOpenAICompatible` (src/lib/llm/openai-compatible.ts)  puts the bytes
 *      on the wire; the mocked client is where the ORACLE reads them, so the
 *      judge answers from the prompt it was actually sent and from nothing else
 *   `commonSuccessUpdateData` (src/worker/judgment-consumer.ts)  produces the
 *      `ModelJudgment` column write detector B reads `userPromptSha256` off
 *   `preferenceFromVerdict` (src/lib/calibration/readings.ts)  undoes the swap
 *   `constantVerdictBaseline` (src/lib/calibration/baseline.ts)  the floors
 *   `positionBiasFromPairs` (src/lib/calibration/position-bias.ts)  the
 *      estimators, over the RAW letters
 *
 * The one simulated layer is separately pinned against the real database by
 * tests/db/calibration-link.test.ts's "copies RunCandidate positions VERBATIM
 * into both orders — no materialised swap".
 */

const {
  openaiCreateMock,
  OpenAIConstructorMock,
  getBreakerMock,
  allowMock,
  onSuccessMock,
  onFailureMock,
  latencyBaselineMock,
} = vi.hoisted(() => ({
  openaiCreateMock: vi.fn(),
  OpenAIConstructorMock: vi.fn(),
  getBreakerMock: vi.fn(),
  allowMock: vi.fn(),
  onSuccessMock: vi.fn(),
  onFailureMock: vi.fn(),
  latencyBaselineMock: vi.fn(),
}));

// Same constructor-level interception tests/lib/pairwise-execution.test.ts
// uses, and for the same reason: the REAL `callOpenAICompatible` /
// `execute()` / `prepareJudgmentCall` / `executePairwiseCall` all run, so this
// exercises the actual request-shaping and the actual `userPromptSha256`
// computation rather than a re-implementation of either.
vi.mock('openai', () => ({
  default: OpenAIConstructorMock.mockImplementation(() => ({
    chat: { completions: { create: openaiCreateMock } },
  })),
}));
vi.mock('@/lib/llm/breaker-redis', () => ({ getBreaker: getBreakerMock }));
// `buildTimeoutEscalation` reads a latency baseline through Prisma. Mocked so
// the seam runs without a live Postgres — it is orthogonal to everything here
// and is pinned by tests/lib/judgment-consumer-escalation.test.ts.
vi.mock('@/lib/calibration/latency', () => ({ judgeLatencyBaseline: latencyBaselineMock }));
// Narrows the unit under test to the provider seam, for the reason
// tests/lib/judgment-consumer-escalation.test.ts states at length: the
// consumer imports `@/lib/realtime/events`, which pulls the whole
// bus/redis-bus chain in behind it — none of it reachable from a seam that
// never publishes, but all of it loaded, and therefore all of its uncovered
// branches added to the `src/lib/realtime/**` coverage denominator. Left
// unmocked, this file alone drops that glob's branches from 87.50% to 77.77%
// and fails an 84% floor WITHOUT CHANGING WHICH LINES ANY TEST COVERS
// (measured both ways; the delta is entirely `redis-bus.ts` going from a 0/0
// "100%" to a 0/N). Mocking the seam's unused dependency is the fix that does
// not involve lowering a floor.
vi.mock('@/lib/realtime/events', () => ({
  publishEvent: vi.fn(),
  runTopic: vi.fn(() => 'run:permuted'),
}));

const { defaultRunProviderPairwise, commonSuccessUpdateData } = await import(
  '@/worker/judgment-consumer'
);

import { constantVerdictBaseline, type ConstantBaseline } from '@/lib/calibration/baseline';
import { positionBiasFromPairs, type PairedVerdictRow } from '@/lib/calibration/position-bias';
import {
  PREFERENCES,
  preferenceFromVerdict,
  type PairOrder,
  type Preference,
  type Verdict,
} from '@/lib/calibration/readings';

// ─── The corpus ─────────────────────────────────────────────────────────────
//
// The REAL key shape, not a tidy fixture: prod `GoldenSet
// cmt057h5d00097y01ymubpre5`, 620 live items, 336 'A>B', 284 'B>A', 0 'tie'.
// The imbalance is load-bearing — on a balanced key the constant floor is
// 0.5000 and build K becomes indistinguishable from the correct build by the
// floor, which is the one thing detector A is for.

const KEY_A_OVER_B = 336;
const KEY_B_OVER_A = 284;
const ITEM_COUNT = KEY_A_OVER_B + KEY_B_OVER_A; // 620
/** 336/620, to the last bit. Written as the division, not as a decimal
 *  literal, so it IS the float the code computes rather than a rounding of
 *  it. */
const AB_FLOOR = KEY_A_OVER_B / ITEM_COUNT;

/** The marker the ORACLE reads out of the rendered prompt. Neither string is
 *  a substring of the other, and neither appears anywhere else in the prompt
 *  (the rubric, the template body and the question are all fixed text). */
const STRONGER = 'STRONGER-ANSWER';
const WEAKER = 'WEAKER-ANSWER';

/**
 * The answer key, spread evenly rather than blocked (Bresenham): item `i` is
 * 'A>B' exactly when the running 336/620 quota advances at `i`, which yields
 * EXACTLY 336 of them with no run of 336 identical items for an order-
 * dependent bug to hide behind. Pinned by a fixture test below.
 */
const GOLDEN_KEY: readonly Preference[] = Array.from({ length: ITEM_COUNT }, (_, i) =>
  Math.floor(((i + 1) * KEY_A_OVER_B) / ITEM_COUNT) > Math.floor((i * KEY_A_OVER_B) / ITEM_COUNT)
    ? ('A>B' as const)
    : ('B>A' as const)
);

type CandidateRow = {
  position: number;
  promptText: string | null;
  responseText: string | null;
  label: string | null;
};

type GoldenItemFixture = {
  id: string;
  index: number;
  inputText: string;
  /** `GoldenItem.expected`. Stated against `position`, never against a slot. */
  expected: Preference;
  /** `GoldenCandidate` rows, position-ascending — what the launch copies
   *  verbatim into every order's `RunCandidate` set. */
  candidates: CandidateRow[];
};

/** `position` IS candidate identity (golden-sets.ts:48, "position IS the
 *  identity (0 = A, 1 = B)"), so `expected: 'A>B'` means the candidate AT
 *  POSITION 0 is the better one — regardless of which slot it is shown in. */
const ITEMS: readonly GoldenItemFixture[] = GOLDEN_KEY.map((expected, index) => ({
  id: `item-${index}`,
  index,
  inputText: `Question ${index}: which answer is better?`,
  expected,
  candidates: [
    {
      position: 0,
      promptText: null,
      responseText: `item ${index} · candidate-at-position-0 · ${expected === 'A>B' ? STRONGER : WEAKER}`,
      label: null,
    },
    {
      position: 1,
      promptText: null,
      responseText: `item ${index} · candidate-at-position-1 · ${expected === 'B>A' ? STRONGER : WEAKER}`,
      label: null,
    },
  ],
}));

// ─── The builds ─────────────────────────────────────────────────────────────

/**
 * The three degrees of freedom a wrong build moves. Every one of them is a
 * decision made OUTSIDE the renderer, which is why the renderer alone cannot
 * be tested into safety.
 */
type Build = {
  name: string;
  /** What the LAUNCH writes as this run's `RunCandidate` rows. */
  candidatesFor: (item: GoldenItemFixture, order: PairOrder) => CandidateRow[];
  /** What the SCORER reads off this run's `GoldenItem.expected`. */
  expectedFor: (item: GoldenItemFixture, order: PairOrder) => Preference;
  /** What order actually reaches the RENDERER. The run and its judgment are
   *  stamped with `order` either way — that is what makes W3 silent. */
  renderedOrderFor: (order: PairOrder) => PairOrder;
};

/** V — the spec's build. Candidates verbatim, key untouched, order threaded. */
const BUILD_V: Build = {
  name: 'V (correct)',
  candidatesFor: (item) => item.candidates,
  expectedFor: (item) => item.expected,
  renderedOrderFor: (order) => order,
};

const invert = (p: Preference): Preference => (p === 'A>B' ? 'B>A' : p === 'B>A' ? 'A>B' : 'tie');

/** K — the forbidden fork: a mirror `GoldenItem` carrying an inverted key. */
const BUILD_K: Build = {
  ...BUILD_V,
  name: 'K (mirrored answer key)',
  expectedFor: (item, order) => (order === 'AB' ? item.expected : invert(item.expected)),
};

/** W — the swap materialised into `RunCandidate.position`. */
const BUILD_W: Build = {
  ...BUILD_V,
  name: 'W (swap materialised into RunCandidate.position)',
  candidatesFor: (item, order) =>
    order === 'AB'
      ? item.candidates
      : item.candidates.map((candidate) => ({ ...candidate, position: 1 - candidate.position })),
};

/** W3 — the order never reaches the renderer, but the row still says 'BA'. */
const BUILD_W3: Build = {
  ...BUILD_V,
  name: 'W3 (order not threaded to the renderer)',
  renderedOrderFor: () => 'AB',
};

// ─── The judges ─────────────────────────────────────────────────────────────

/** Split the rendered user prompt back into its two presented responses. Every
 *  branch THROWS: a judge that silently guessed on a malformed prompt would
 *  make the oracle's 1.0000 mean nothing. */
function presentedResponses(userPrompt: string): { slotA: string; slotB: string } {
  const afterA = userPrompt.split('\n## Response A\n');
  if (afterA.length !== 2) throw new Error('rendered prompt has no single "## Response A" section');
  const split = afterA[1].split('\n\n## Response B\n');
  if (split.length !== 2) throw new Error('rendered prompt has no single "## Response B" section');
  const slotB = split[1].split('\n</submission>');
  if (slotB.length !== 2) throw new Error('rendered prompt has no closing </submission>');
  return { slotA: split[0], slotB: slotB[0] };
}

/** THE ORACLE. A content-perfect judge: it answers from the bytes it was sent
 *  and from nothing else — it is handed no order, no item id and no key. That
 *  is the whole point. A judge that took `(expected, order)` as input would
 *  score 1.0000 under build W too, because build W does not change either. */
function contentPerfectJudge(userPrompt: string): Verdict {
  const { slotA, slotB } = presentedResponses(userPrompt);
  const aStrong = slotA.includes(STRONGER);
  const bStrong = slotB.includes(STRONGER);
  if (aStrong === bStrong) {
    throw new Error(`prompt presents ${aStrong ? 'two' : 'no'} stronger answers`);
  }
  return aStrong ? 'A' : 'B';
}

/** The spec's third column: a judge that always names the first slot. */
const slotAStamper = (): Verdict => 'A';

// ─── The pipeline ───────────────────────────────────────────────────────────

type JudgedRow = {
  itemId: string;
  /** `EvaluationRun.pairOrder` — what the ROW says it presented. */
  pairOrder: PairOrder;
  /** `GoldenItem.expected` as the scorer reads it for this run. */
  expected: Preference;
  /** `ModelJudgment.verdict`, RAW. Names a slot. */
  verdict: Verdict;
  /** `ModelJudgment.userPromptSha256`, off the real persist mapping. */
  userPromptSha256: string;
  userPrompt: string;
};

const VERSION = {
  id: 'ver_permuted',
  servingBackend: 'vllm' as const,
  samplingDefaults: null,
  judgeModel: { baseModel: 'meta-llama/Llama-3-70B', slug: 'llama3-judge', name: 'llama3-judge' },
};
const ENDPOINT = { apiKeyEnc: 'sk-vllm-test', endpoint: 'http://vllm.internal:8000/v1' };
const RUBRIC = {
  name: 'Pair Rubric',
  description: 'd',
  criteria: [
    { id: 'c1', rubricId: 'r1', name: 'Accuracy', description: 'desc', maxScore: 10, weight: 1, order: 0 },
  ],
};
const TEMPLATE = {
  id: 'tpl_pairwise',
  protocol: 'pairwise' as const,
  body: 'Rubric: ${rubricName}\nCriteria: ${criteriaList}',
};

/**
 * One permuted calibration, end to end: N items × 2 orders → 2N runs, one
 * judgment each. `judge` never sees anything but the prompt bytes the provider
 * was actually called with.
 */
async function runPermutedCalibration(
  build: Build,
  judge: (userPrompt: string) => Verdict,
  items: readonly GoldenItemFixture[] = ITEMS
): Promise<JudgedRow[]> {
  latencyBaselineMock.mockResolvedValue(null);
  getBreakerMock.mockImplementation(() => ({
    allow: allowMock,
    onSuccess: onSuccessMock,
    onFailure: onFailureMock,
  }));
  allowMock.mockResolvedValue('closed');
  // THE JUDGE READS THE WIRE. `params.messages[1].content` is the user prompt
  // `callOpenAICompatible` is about to send — the same string the registry
  // hashes into `userPromptSha256` — so a build that renders the wrong bytes
  // gets judged on the wrong bytes, exactly as a real judge would be.
  openaiCreateMock.mockImplementation(async (params: { messages: { content: string }[] }) => ({
    model: 'served-model',
    choices: [
      {
        message: { content: JSON.stringify({ verdict: judge(params.messages[1].content), reasoning: 'r' }) },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  }));

  const rows: JudgedRow[] = [];
  for (const item of items) {
    for (const order of ['AB', 'BA'] as const) {
      const input = {
        judgment: {
          id: `mj-${item.id}-${order}`,
          attemptCount: 1,
          promptTemplate: TEMPLATE,
          // Dual-written from ONE variable with `EvaluationRun.pairOrder` at
          // creation (run-launch.ts) — so the stamped order is `order` under
          // every build, including W3, where only what the renderer RECEIVES
          // differs.
          pairOrder: build.renderedOrderFor(order),
        },
        run: {
          evaluation: { inputText: item.inputText, promptText: null },
          runCandidates: build.candidatesFor(item, order),
        },
        rubric: RUBRIC,
        version: VERSION,
        endpoint: ENDPOINT,
      };

      // eslint-disable-next-line no-await-in-loop -- each judgment is a distinct provider call whose prompt must be judged before the next is built; the mock is stateless but the pipeline is deliberately sequential, as the worker is
      const result = await defaultRunProviderPairwise(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural stand-in for the Prisma-derived RunProviderPairwiseInput, same shape and same cast as tests/lib/judgment-consumer-escalation.test.ts
        input as any
      );
      // The SHARED persist mapping — this is the `ModelJudgment` column write,
      // not a re-derivation of it.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
      const persisted = commonSuccessUpdateData(result, VERSION as any);

      rows.push({
        itemId: item.id,
        pairOrder: order,
        expected: build.expectedFor(item, order),
        verdict: result.verdict,
        userPromptSha256: persisted.userPromptSha256!,
        userPrompt: persisted.userPrompt!,
      });
    }
  }
  return rows;
}

// ─── Readings over a pooled permuted calibration ────────────────────────────

const keyCountsOf = (rows: readonly JudgedRow[]): Record<Preference, number> => {
  const counts: Record<Preference, number> = { 'A>B': 0, 'B>A': 0, tie: 0 };
  for (const row of rows) counts[row.expected] += 1;
  return counts;
};

const floorOf = (rows: readonly JudgedRow[]): ConstantBaseline | null =>
  constantVerdictBaseline(keyCountsOf(rows));

/** Pooled accuracy: the REAL `preferenceFromVerdict` undoes the presentation
 *  order, then the result is compared against the key. This is the one number
 *  the stored, AB-only `rawAgreement` cannot show you. */
function pooledAccuracy(rows: readonly JudgedRow[]): { correct: number; accuracy: number } {
  let correct = 0;
  for (const row of rows) {
    if (preferenceFromVerdict(row.verdict, row.pairOrder) === row.expected) correct += 1;
  }
  return { correct, accuracy: correct / rows.length };
}

const pairedRowsOf = (rows: readonly JudgedRow[]): PairedVerdictRow[] =>
  rows.map((row) => ({ itemId: row.itemId, verdict: row.verdict, pairOrder: row.pairOrder }));

/** Items whose two orders produced the SAME prompt bytes. Detector B's
 *  predicate is that this list is empty. */
function itemsWithIdenticalPrompts(rows: readonly JudgedRow[]): string[] {
  const byItem = new Map<string, Partial<Record<PairOrder, string>>>();
  for (const row of rows) {
    const entry = byItem.get(row.itemId) ?? {};
    if (entry[row.pairOrder] !== undefined) {
      throw new Error(`duplicate (${row.itemId}, ${row.pairOrder}) — the fixture is not a permuted run`);
    }
    entry[row.pairOrder] = row.userPromptSha256;
    byItem.set(row.itemId, entry);
  }
  const identical: string[] = [];
  for (const [itemId, entry] of byItem) {
    if (entry.AB === undefined || entry.BA === undefined) {
      throw new Error(`item ${itemId} did not produce both orders`);
    }
    if (entry.AB === entry.BA) identical.push(itemId);
  }
  return identical;
}

// ─── Fixture sanity ─────────────────────────────────────────────────────────

describe('the fixture is the real 336/284 key shape', () => {
  it('carries exactly 336 A>B and 284 B>A over 620 items, and no ties', () => {
    const counts = keyCountsOf(
      ITEMS.map((item) => ({ expected: item.expected }) as JudgedRow)
    );
    expect(counts).toEqual({ 'A>B': 336, 'B>A': 284, tie: 0 });
    expect(ITEMS).toHaveLength(620);
  });

  it('the AB-only floor is 336/620 = 0.5419355', () => {
    const floor = constantVerdictBaseline({ 'A>B': KEY_A_OVER_B, 'B>A': KEY_B_OVER_A, tie: 0 });
    expect(floor?.accuracy).toBe(AB_FLOOR);
    expect(floor?.accuracy).toBeCloseTo(0.5419355, 7);
    expect(floor?.preferences).toEqual(['A>B']);
    expect(floor?.denominator).toBe(620);
  });
});

// ─── DETECTOR A — key doubling ──────────────────────────────────────────────

describe('DETECTOR A — the key doubles UNIFORMLY (catches build K)', () => {
  it('has an equal AB and BA run count in every expected class', async () => {
    const rows = await runPermutedCalibration(BUILD_V, contentPerfectJudge);

    const ab = keyCountsOf(rows.filter((row) => row.pairOrder === 'AB'));
    const ba = keyCountsOf(rows.filter((row) => row.pairOrder === 'BA'));

    // Per class, not in total: a build that inverted the key would keep the
    // TOTAL at 1240 and only move the class split, which is exactly how it
    // stays invisible.
    for (const preference of PREFERENCES) {
      expect({ preference, ab: ab[preference], ba: ba[preference] }).toEqual({
        preference,
        ab: ab[preference],
        ba: ab[preference],
      });
    }
    expect(ab).toEqual({ 'A>B': 336, 'B>A': 284, tie: 0 });
    expect(ba).toEqual({ 'A>B': 336, 'B>A': 284, tie: 0 });
  });

  it('so the pooled floor is BIT-IDENTICAL to the AB-only floor', async () => {
    const rows = await runPermutedCalibration(BUILD_V, contentPerfectJudge);

    const pooled = floorOf(rows);
    const abOnly = floorOf(rows.filter((row) => row.pairOrder === 'AB'));

    // Exact float equality, deliberately — `toBeCloseTo` would accept a key
    // that moved by less than its tolerance, and 620/1240 vs 672/1240 differ
    // by 0.0419, but a PARTIALLY mirrored key differs by less.
    expect(pooled?.accuracy).toBe(abOnly?.accuracy);
    expect(pooled?.accuracy).toBe(AB_FLOOR);
    expect(pooled?.keyCounts).toEqual({ 'A>B': 672, 'B>A': 568, tie: 0 });
    expect(pooled?.denominator).toBe(1240);
  });
});

// ─── DETECTOR B — the prompt bytes changed ──────────────────────────────────

describe('DETECTOR B — every item renders DIFFERENT bytes in the two orders (catches W and W3)', () => {
  it('no golden item shares a userPromptSha256 between its AB and BA judgments', async () => {
    const rows = await runPermutedCalibration(BUILD_V, contentPerfectJudge);

    expect(rows).toHaveLength(1240);
    // THE assertion. `userPromptSha256` is off `commonSuccessUpdateData` — the
    // column write itself. A swap materialised into `RunCandidate.position`
    // (W) or an order that never reached the renderer (W3) produces
    // byte-identical prompts, and this is the only thing in the tree that
    // sees either.
    //
    // Reported as a COUNT plus a sample rather than as the bare list: under
    // the builds this exists to catch, every one of the 620 items collides,
    // and a 620-element array diff buries the number that matters.
    const identical = itemsWithIdenticalPrompts(rows);
    expect({ items: 620, sharingPromptBytes: identical.length, sample: identical.slice(0, 3) }).toEqual({
      items: 620,
      sharingPromptBytes: 0,
      sample: [],
    });
  });

  it('and it changed in the RIGHT direction — position 1 is presented first under BA', async () => {
    const rows = await runPermutedCalibration(BUILD_V, contentPerfectJudge);

    // Not just "different bytes": different in the one way that makes the
    // read-time inversion correct. A renderer that shuffled the question or
    // relabelled the sections would also produce different bytes.
    const wrongDirection = rows.filter((row) => {
      const zero = row.userPrompt.indexOf('candidate-at-position-0');
      const one = row.userPrompt.indexOf('candidate-at-position-1');
      return row.pairOrder === 'AB' ? zero > one : one > zero;
    });
    expect({
      judgments: 1240,
      presentedInTheWrongOrder: wrongDirection.length,
      sample: wrongDirection.slice(0, 3).map((row) => `${row.itemId}/${row.pairOrder}`),
    }).toEqual({ judgments: 1240, presentedInTheWrongOrder: 0, sample: [] });
  });
});

// ─── DETECTOR C — the oracle ────────────────────────────────────────────────

describe('DETECTOR C — a content-perfect judge scores 1.0000 pooled (separates V from W)', () => {
  it('scores every one of the 1240 pooled judgments correct', async () => {
    const rows = await runPermutedCalibration(BUILD_V, contentPerfectJudge);
    const { correct, accuracy } = pooledAccuracy(rows);

    expect(correct).toBe(1240);
    // 1.0000, not 0.5000. Under build W the AB half is perfect and the BA half
    // is perfectly WRONG, which lands here on exactly 0.5 — a number that
    // looks like a coin flip rather than like a bug.
    expect(accuracy).toBe(1);
    expect(accuracy - (floorOf(rows)?.accuracy ?? 0)).toBeCloseTo(1 - AB_FLOOR, 12);
  });

  it('and reports no position bias and no order flips through the real estimators', async () => {
    const rows = await runPermutedCalibration(BUILD_V, contentPerfectJudge);
    const bias = positionBiasFromPairs(pairedRowsOf(rows));

    // position-bias.ts's own archetype table: perfect content = 0.0 / 0.0.
    // Under W the same judge is indistinguishable from a slot stamper on the
    // RAW letters and flips its derived preference on every single item.
    expect(bias.pairedDecisiveCount).toBe(620);
    expect(bias.orderFlipRate).toBe(0);
    expect(bias.positionBias).toBe(0);
    expect(bias.tieExcludedCount).toBe(0);
    expect(bias.unpairedCount).toBe(0);
  });

  it('while a slot-A stamper scores exactly 0.5000 pooled — BELOW the 0.5419 floor', async () => {
    const rows = await runPermutedCalibration(BUILD_V, slotAStamper);
    const { correct, accuracy } = pooledAccuracy(rows);
    const bias = positionBiasFromPairs(pairedRowsOf(rows));

    // The spec's third column. 336 hits in AB + 284 in BA = 620 of 1240.
    expect(correct).toBe(620);
    expect(accuracy).toBe(0.5);
    expect(accuracy - (floorOf(rows)?.accuracy ?? 0)).toBeCloseTo(-0.0419355, 7);
    // And the estimators name it for what it is.
    expect(bias.positionBias).toBe(0.5);
    expect(bias.orderFlipRate).toBe(1);
  });
});

// ─── The trap, asserted rather than described ───────────────────────────────

describe('the trap — the constant floor cannot tell V from W', () => {
  it('reads the same 0.5419355 under the correct build AND under build W', async () => {
    const correct = await runPermutedCalibration(BUILD_V, contentPerfectJudge);
    const broken = await runPermutedCalibration(BUILD_W, contentPerfectJudge);

    // Bit-identical, both of them. This is why "the floor didn't change" is
    // not an acceptable regression check for this feature.
    expect(floorOf(correct)?.accuracy).toBe(AB_FLOOR);
    expect(floorOf(broken)?.accuracy).toBe(AB_FLOOR);
    expect(floorOf(broken)?.accuracy).toBe(floorOf(correct)?.accuracy);
  });

  it('and neither can the stored AB-only accuracy, which is 1.0000 under both', async () => {
    const correct = await runPermutedCalibration(BUILD_V, contentPerfectJudge);
    const broken = await runPermutedCalibration(BUILD_W, contentPerfectJudge);

    // Spec D4: `rawAgreement` / `kappa` / `verdictCount` stay AB-only, and the
    // AB half is untouched by build W. So the number on the scoreboard is
    // 1.0000 for a build that files every mirror verdict against the wrong
    // candidate. Detector C has to be POOLED or it sees nothing.
    const abOnly = (rows: JudgedRow[]) => pooledAccuracy(rows.filter((r) => r.pairOrder === 'AB'));
    expect(abOnly(correct).accuracy).toBe(1);
    expect(abOnly(broken).accuracy).toBe(1);
  });
});

// ─── PROOF OF DISCRIMINATION ────────────────────────────────────────────────
//
// Each detector's predicate, evaluated against the build it exists to catch,
// and asserted to be FALSE. Written as the NEGATION of the detector rather
// than as a fresh predicate: if the assertion above and the assertion below
// ever stop being each other's complement, one of them is wrong.

describe('discrimination — each detector FAILS on its wrong build', () => {
  it('A fails on build K: the classes no longer double uniformly', async () => {
    const rows = await runPermutedCalibration(BUILD_K, contentPerfectJudge);

    const ab = keyCountsOf(rows.filter((row) => row.pairOrder === 'AB'));
    const ba = keyCountsOf(rows.filter((row) => row.pairOrder === 'BA'));
    expect(ab).toEqual({ 'A>B': 336, 'B>A': 284, tie: 0 });
    expect(ba).toEqual({ 'A>B': 284, 'B>A': 336, tie: 0 }); // mirrored
    expect(ba['A>B']).not.toBe(ab['A>B']);

    // And the floor collapses to 0.5000, which is the +0.0419 of free margin
    // the forbidden build would hand every judge.
    expect(floorOf(rows)?.accuracy).toBe(0.5);
    expect(floorOf(rows)?.accuracy).not.toBe(AB_FLOOR);
  });

  it('A PASSES on builds W and W3 — which is the whole reason B and C exist', async () => {
    for (const build of [BUILD_W, BUILD_W3]) {
      // eslint-disable-next-line no-await-in-loop -- two sequential fixtures, each a full 1240-judgment pipeline
      const rows = await runPermutedCalibration(build, contentPerfectJudge);
      expect(floorOf(rows)?.accuracy).toBe(AB_FLOOR);
      expect(keyCountsOf(rows.filter((row) => row.pairOrder === 'BA'))).toEqual({
        'A>B': 336,
        'B>A': 284,
        tie: 0,
      });
    }
  });

  it('B fails on build W: all 620 items render byte-identical prompts', async () => {
    const rows = await runPermutedCalibration(BUILD_W, contentPerfectJudge);

    const identical = itemsWithIdenticalPrompts(rows);
    expect(identical).toHaveLength(620);
    expect(identical).not.toEqual([]);
    // The double swap, spelled out: sorted-by-position then reversed is the
    // original order again.
    const [ab, ba] = rows.filter((row) => row.itemId === 'item-0');
    expect(ba.userPrompt).toBe(ab.userPrompt);
  });

  it('B fails on build W3: the order never reached the renderer', async () => {
    const rows = await runPermutedCalibration(BUILD_W3, contentPerfectJudge);

    expect(itemsWithIdenticalPrompts(rows)).toHaveLength(620);
  });

  it('B PASSES on build K — a mirrored key renders perfectly good bytes', async () => {
    const rows = await runPermutedCalibration(BUILD_K, contentPerfectJudge);
    expect(itemsWithIdenticalPrompts(rows)).toHaveLength(0);
  });

  it('C fails on build W: the oracle scores 0.5000, not 1.0000', async () => {
    const rows = await runPermutedCalibration(BUILD_W, contentPerfectJudge);
    const { correct, accuracy } = pooledAccuracy(rows);

    expect(accuracy).not.toBe(1);
    expect(accuracy).toBe(0.5);
    expect(correct).toBe(620);
    // Every AB judgment right, every BA judgment wrong — the signature.
    expect(pooledAccuracy(rows.filter((row) => row.pairOrder === 'AB')).accuracy).toBe(1);
    expect(pooledAccuracy(rows.filter((row) => row.pairOrder === 'BA')).accuracy).toBe(0);
    // And the estimators invert too: a perfect judge reported as a stamper.
    const bias = positionBiasFromPairs(pairedRowsOf(rows));
    expect(bias.orderFlipRate).toBe(1);
    expect(bias.orderFlipRate).not.toBe(0);
  });

  it('C fails on build W3: same 0.5000, one layer up', async () => {
    const rows = await runPermutedCalibration(BUILD_W3, contentPerfectJudge);
    expect(pooledAccuracy(rows).accuracy).toBe(0.5);
  });

  it('C fails on build K too: the mirrored half is scored against an inverted key', async () => {
    const rows = await runPermutedCalibration(BUILD_K, contentPerfectJudge);
    expect(pooledAccuracy(rows).accuracy).toBe(0.5);
    expect(pooledAccuracy(rows.filter((row) => row.pairOrder === 'BA')).accuracy).toBe(0);
  });
});
