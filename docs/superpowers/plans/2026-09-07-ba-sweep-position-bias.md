# BA Sweep / Position Bias Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render every pairwise judgment in both candidate orders and store two independent position-bias estimators, so a judge's position preference can be separated from its content signal.

**Architecture:** A calibration item gets two `ModelJudgment` rows — `pairOrder` `'AB'` and `'BA'` — created in one transaction on the same `EvaluationRun`. The renderer gains an order parameter threaded five hops from the worker. `scoreCalibrationRun` partitions judgments by `pairOrder` and scores the AB partition into the existing stored columns unchanged; a new pure module computes `positionBias` and `orderFlipRate` from the paired raw verdicts.

**Tech Stack:** TypeScript, Next.js, Prisma/PostgreSQL, RabbitMQ, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-07-ba-sweep-position-bias-design.md`

## Global Constraints

- **Coverage floors do not move.** `vitest.db.config.ts:165` `branches: 77` against a measured 77.4094% (1004/1297) — six uncovered branches of slack. `src/worker/**` 114/125 vs floor 87 — also six. Every new branch ships with a test.
- **`tests/integration/**` carries no coverage instrumentation.** Logic covered only by an integration test counts as uncovered. Unit-test the threading.
- **Never run `npm run test:db` concurrently** — one shared `judge_arena_test` database. Serialize.
- **`grep -a` always.** `src/lib/calibration/readings.ts` contains a deliberate NUL byte and plain `grep` silently skips it.
- **Exactly one layer inverts.** The renderer swaps what the model is *shown*; `preferenceFromVerdict` swaps what the verdict *means*. Both together is a no-symptom bug.
- **`positionBias` is computed on the RAW verdict letter, before `preferenceFromVerdict`.** Computing it from preferences yields a key-balance-confounded statistic that is anticorrelated with position bias.
- **No production row is re-scored** to prove any step inert. Fixtures only.
- Every task ends green on `npx vitest run` for its own test file, and the touched suite.

---

### Task 1: `SamplingParams` carries a repetition penalty

Independent of the BA work. Unblocks `granite4.2:3b`, whose documented failure is a repetition loop (spec §5.4.2 of `2026-09-01-judge-scoreboard-and-model-envelopes.md`) that no configuration can currently address, because `effectiveSamplingParams` rebuilds a literal two-key object and drops anything else.

**Files:**
- Modify: `src/lib/llm/sampling.ts:25-28` (the interface), `:66-69` (the reconstruction)
- Modify: `src/lib/llm/openai-compatible.ts:200-208` (the request params)
- Test: `tests/lib/sampling.test.ts`, `tests/lib/pairwise-execution.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SamplingParams` gains optional `repeat_penalty?: number` and `frequency_penalty?: number`. `effectiveSamplingParams` resolves both per-field like the existing two.

- [ ] **Step 1: Write the failing test**

In `tests/lib/sampling.test.ts`:

```ts
it('carries repeat_penalty from the version defaults', () => {
  const params = effectiveSamplingParams({ temperature: 0.3, max_tokens: 8192, repeat_penalty: 1.15 });
  expect(params.repeat_penalty).toBe(1.15);
  expect(params.max_tokens).toBe(8192);
});

it('omits the penalties entirely when nothing sets them', () => {
  const params = effectiveSamplingParams({ temperature: 0.3, max_tokens: 4096 });
  expect('repeat_penalty' in params).toBe(false);
  expect('frequency_penalty' in params).toBe(false);
});

it('lets a per-call override beat the version default', () => {
  const params = effectiveSamplingParams({ repeat_penalty: 1.1 }, { repeat_penalty: 1.3 });
  expect(params.repeat_penalty).toBe(1.3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/sampling.test.ts -t repeat_penalty`
Expected: FAIL — `repeat_penalty` is `undefined`.

- [ ] **Step 3: Widen the interface**

`src/lib/llm/sampling.ts`, replacing lines 25-28:

```ts
export interface SamplingParams {
  temperature: number;
  max_tokens: number;
  /** Ollama/llama.cpp repetition penalty. OPTIONAL and OMITTED when unset —
   * never defaulted to 1.0. A provider that receives an explicit 1.0 and one
   * that receives nothing are the same call, but the STORED
   * `ModelJudgment.samplingParams` would differ, and that field is the
   * provenance record for a run. Absent means "not configured". */
  repeat_penalty?: number;
  /** OpenAI-dialect equivalent, for backends that speak it instead. Both are
   * carried because the fleet is mixed; a version sets whichever its backend
   * honours. */
  frequency_penalty?: number;
}
```

- [ ] **Step 4: Carry them through the reconstruction**

`src/lib/llm/sampling.ts`, replacing the return in `effectiveSamplingParams` (lines 66-69):

```ts
  const resolved: SamplingParams = {
    temperature: overrides?.temperature ?? versionShape?.temperature ?? registryDefault.temperature,
    max_tokens: overrides?.max_tokens ?? versionShape?.max_tokens ?? registryDefault.max_tokens,
  };
  // Assigned conditionally, not spread with `?? undefined`: an explicit
  // `repeat_penalty: undefined` key would serialise into
  // `ModelJudgment.samplingParams` as a null and read as "configured to
  // nothing" rather than "not configured".
  const repeatPenalty = overrides?.repeat_penalty ?? versionShape?.repeat_penalty;
  if (repeatPenalty !== undefined) resolved.repeat_penalty = repeatPenalty;
  const frequencyPenalty = overrides?.frequency_penalty ?? versionShape?.frequency_penalty;
  if (frequencyPenalty !== undefined) resolved.frequency_penalty = frequencyPenalty;
  return resolved;
```

- [ ] **Step 5: Send them to the provider**

`src/lib/llm/openai-compatible.ts`, after the `params` literal (which ends at line 208):

```ts
  // Ollama maps `repeat_penalty` through its OpenAI-compatible shim;
  // `frequency_penalty` is the native OpenAI dialect. Both are omitted unless
  // set, so an unconfigured judge sends a byte-identical request to today's.
  if (opts.samplingParams.repeat_penalty !== undefined) {
    params.repeat_penalty = opts.samplingParams.repeat_penalty;
  }
  if (opts.samplingParams.frequency_penalty !== undefined) {
    params.frequency_penalty = opts.samplingParams.frequency_penalty;
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/lib/sampling.test.ts tests/lib/pairwise-execution.test.ts`
Expected: PASS, no pre-existing test changed.

- [ ] **Step 7: Commit**

```bash
git add src/lib/llm/sampling.ts src/lib/llm/openai-compatible.ts tests/lib/sampling.test.ts
git commit -m "feat(llm): SamplingParams carries repeat_penalty and frequency_penalty

effectiveSamplingParams rebuilt a literal two-key object, so a penalty set in
a JudgeModelVersion's samplingDefaults was silently dropped at three points
and never reached the provider. granite4.2:3b's documented repetition loop was
therefore not addressable by configuration at all.

Both fields are optional and OMITTED when unset, so an unconfigured judge
sends a byte-identical request and stores byte-identical samplingParams."
```

---

### Task 2: A shared `PairOrder` type

Today `PairOrder` exists only in `readings.ts` (the READ layer) and no writer imports it, so nothing stops a writer emitting `'ba'`; the only defence fires at score time, after inference is paid for.

**Files:**
- Create: `src/lib/pair-order.ts`
- Modify: `src/lib/calibration/readings.ts:56-57` (re-export instead of declare)
- Test: `tests/lib/pair-order.test.ts`

**Interfaces:**
- Produces: `type PairOrder = 'AB' | 'BA'`, `PAIR_ORDERS: readonly PairOrder[]`, `isPairOrder(v: unknown): v is PairOrder`, `oppositeOrder(o: PairOrder): PairOrder`.

- [ ] **Step 1: Write the failing test**

`tests/lib/pair-order.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PAIR_ORDERS, isPairOrder, oppositeOrder } from '@/lib/pair-order';

describe('pair-order', () => {
  it('accepts only the two canonical spellings', () => {
    expect(isPairOrder('AB')).toBe(true);
    expect(isPairOrder('BA')).toBe(true);
    expect(isPairOrder('ba')).toBe(false);
    expect(isPairOrder('')).toBe(false);
    expect(isPairOrder(null)).toBe(false);
    expect(isPairOrder(undefined)).toBe(false);
  });

  it('lists both orders, AB first', () => {
    expect(PAIR_ORDERS).toEqual(['AB', 'BA']);
  });

  it('maps each order to the other', () => {
    expect(oppositeOrder('AB')).toBe('BA');
    expect(oppositeOrder('BA')).toBe('AB');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/pair-order.test.ts`
Expected: FAIL — cannot resolve `@/lib/pair-order`.

- [ ] **Step 3: Create the module**

`src/lib/pair-order.ts`:

```ts
/**
 * ─── Which order the two candidates were rendered in ────────────────────────
 *
 * Lives HERE, not in `calibration/readings.ts`, because it is needed by both
 * sides and the read layer is the wrong place for a writer to import from.
 * `ModelJudgment.pairOrder` is a nullable `String` in Prisma
 * (`schema.prisma:490`) — NOT a Prisma enum — so nothing at the database layer
 * rejects `'ba'` or `'Ab'`. Before this module the only typed form was in the
 * read layer, which meant a bad value was caught at SCORE time, after the
 * inference for a whole run had been paid for.
 */
export type PairOrder = 'AB' | 'BA';

/** Both orders, AB first — the order a paired sweep dispatches them in. */
export const PAIR_ORDERS: readonly PairOrder[] = ['AB', 'BA'] as const;

export function isPairOrder(value: unknown): value is PairOrder {
  return value === 'AB' || value === 'BA';
}

/** The other order. Used by the paired-launch path to derive the second
 *  judgment from the first rather than repeating the literal. */
export function oppositeOrder(order: PairOrder): PairOrder {
  return order === 'AB' ? 'BA' : 'AB';
}
```

- [ ] **Step 4: Re-export from readings.ts**

`src/lib/calibration/readings.ts`, replacing the local declaration at line 57:

```ts
// Re-exported rather than declared, so the read layer and the write layer
// cannot drift. See src/lib/pair-order.ts for why it moved.
export type { PairOrder } from '@/lib/pair-order';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/lib/pair-order.test.ts tests/lib/calibration-readings.test.ts`
Expected: PASS both.

- [ ] **Step 6: Commit**

```bash
git add src/lib/pair-order.ts src/lib/calibration/readings.ts tests/lib/pair-order.test.ts
git commit -m "refactor(pair-order): promote PairOrder to a type both layers share"
```

---

### Task 3: `scoreCalibrationRun` partitions by `pairOrder` — inert today

The load-bearing safety step. It must land and be verified **before any BA row can exist**.

Three parts. Part (c) is the one an implementer will miss.

**Files:**
- Modify: `src/lib/calibration/score.ts:246-315`
- Test: `tests/lib/calibration-score.test.ts`

**Interfaces:**
- Consumes: `PairOrder` from Task 2.
- Produces: an internal `partitionByPairOrder(runs)` returning `Map<string, { rows, context, unjudgedItems, dispatchedItemCount }>`; `scoreCalibrationRun`'s public return type is UNCHANGED.

- [ ] **Step 1: Write the failing tests**

In `tests/lib/calibration-score.test.ts`:

```ts
it('scores the AB partition when a BA judgment is also present', async () => {
  // Two judgments per run, opposite orders, same judge. Before the partition
  // this threw duplicate-reading from groundTruthReadings.
  const client = fakeClientWithRuns([
    { itemId: 'i1', index: 0, expected: 'A>B', judgments: [
      { pairOrder: 'AB', verdict: 'A', status: 'completed' },
      { pairOrder: 'BA', verdict: 'B', status: 'completed' },
    ] },
  ]);
  const score = await scoreCalibrationRun('cal1', client);
  // AB only: one item, one verdict, correct.
  expect(score.verdictCount).toBe(1);
  expect(score.accuracy).toBe(1);
});

it('counts an item whose AB errored but whose BA completed as MISSING for AB', async () => {
  const client = fakeClientWithRuns([
    { itemId: 'i1', index: 0, expected: 'A>B', judgments: [
      { pairOrder: 'AB', verdict: null, status: 'error' },
      { pairOrder: 'BA', verdict: 'B', status: 'completed' },
    ] },
  ]);
  const score = await scoreCalibrationRun('cal1', client);
  // The run arrives with modelJudgments.length === 1, so the old
  // `length === 0` test misses it and missingVerdicts silently reads 0.
  expect(score.missingVerdicts).toBe(1);
  expect(score.verdictCount).toBe(0);
  expect(score.noVerdictRate).toBe(1);
});

it('keeps the disagreement list aligned to its own item after a BA row', async () => {
  const client = fakeClientWithRuns([
    { itemId: 'i1', index: 0, expected: 'A>B', judgments: [
      { pairOrder: 'AB', verdict: 'B', status: 'completed' },
      { pairOrder: 'BA', verdict: 'A', status: 'completed' },
    ] },
    { itemId: 'i2', index: 1, expected: 'A>B', judgments: [
      { pairOrder: 'AB', verdict: 'B', status: 'completed' },
    ] },
  ]);
  const score = await scoreCalibrationRun('cal1', client);
  // Grouping `rows` without `context` slides i2's disagreement onto i1's runId.
  expect(score.disagreements.map((d) => d.itemIndex)).toEqual([0, 1]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/lib/calibration-score.test.ts -t partition`
Expected: FAIL — the first throws `duplicate-reading`; the second reports `missingVerdicts 0`.

- [ ] **Step 3: Select status, not just completed**

`src/lib/calibration/score.ts`, in the `findMany` at line 252-255 — remove the `where` filter so a launched-but-undrained order stays visible, and select `status`:

```ts
      modelJudgments: {
        // NO `where: { status: 'completed' }` any more. With two judgments per
        // run, filtering here made a run whose AB errored and whose BA
        // completed arrive with `length === 1` — escaping the `length === 0`
        // unjudged test, contributing no AB row, and reporting
        // `missingVerdicts 0` over a short denominator. That is the 2026-08-31
        // failure this file's comment below memorialises, in the direction
        // that HIDES loss. The status gate moved into the partition.
        select: { verdict: true, pairOrder: true, judgeModelVersionId: true, status: true },
      },
```

- [ ] **Step 4: Partition, carrying `context` with the rows**

`src/lib/calibration/score.ts`, replacing the accumulation loop (lines 265-312):

```ts
type Partition = {
  rows: CalibrationVerdictRow[];
  /** Parallel to `rows` WITHIN this partition. It must travel with the rows,
   * not beside the whole set: `rows` is indexed positionally at the
   * disagreement push below, so grouping rows alone slides every disagreement
   * past the first BA row onto another item's runId. */
  context: Array<{ runId: string; itemIndex: number }>;
  unjudgedItems: number;
  dispatchedItemCount: number;
};

/** Key for a partition. Pointwise judgments carry `pairOrder: null` and all
 *  belong to one partition; the empty string cannot collide with 'AB'/'BA'. */
const partitionKey = (pairOrder: string | null): string => pairOrder ?? '';

const partitions = new Map<string, Partition>();
const ensure = (key: string): Partition => {
  let p = partitions.get(key);
  if (!p) {
    p = { rows: [], context: [], unjudgedItems: 0, dispatchedItemCount: 0 };
    partitions.set(key, p);
  }
  return p;
};

for (const run of runs) {
  if (run.goldenItem === null) continue;

  // Which orders were ASKED of this item — derived from the judgment rows that
  // exist at all, regardless of status, which is exactly why the query no
  // longer filters on `completed`.
  const askedKeys = new Set(run.modelJudgments.map((j) => partitionKey(j.pairOrder)));
  // A run with NO judgment rows at all is an unjudged item in every partition
  // the calibration has. Attributed to '' so it is counted exactly once when
  // the run is pointwise, and re-attributed below for pairwise calibrations.
  if (askedKeys.size === 0) askedKeys.add('');

  for (const key of askedKeys) {
    const partition = ensure(key);
    partition.dispatchedItemCount += 1;
    const completed = run.modelJudgments.filter(
      (j) => partitionKey(j.pairOrder) === key && j.status === 'completed'
    );
    if (completed.length === 0) {
      partition.unjudgedItems += 1;
      continue;
    }
    for (const judgment of completed) {
      partition.rows.push({
        itemId: run.goldenItem.id,
        expected: run.goldenItem.expected,
        raterId: judgment.judgeModelVersionId ?? 'model',
        verdict: judgment.verdict,
        pairOrder: judgment.pairOrder,
      });
      partition.context.push({ runId: run.id, itemIndex: run.goldenItem.index });
    }
  }
}

// THE PARTITION THAT FEEDS THE STORED COLUMNS. 'AB' when a pairwise
// calibration ran, otherwise the single partition a pointwise one produced.
// Per the spec's D2 the stored rawAgreement/kappa/verdictCount stay AB-only,
// so every one of the 22 historical rows scores bit-identically.
const primaryKey = partitions.has('AB') ? 'AB' : [...partitions.keys()][0] ?? '';
const primary = ensure(primaryKey);
const { rows, context } = primary;
const unjudgedItems = primary.unjudgedItems;
const dispatchedItemCount = primary.dispatchedItemCount;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/lib/calibration-score.test.ts`
Expected: PASS — including every pre-existing assertion, unchanged.

- [ ] **Step 6: Prove inertness on fixtures**

Run: `npx vitest run tests/lib/calibration-score.test.ts tests/lib/calibration-baseline.test.ts tests/lib/calibration-readings.test.ts`
Expected: PASS with zero pre-existing expectations edited. **Do not re-score a production row to check this.**

- [ ] **Step 7: Commit**

```bash
git add src/lib/calibration/score.ts tests/lib/calibration-score.test.ts
git commit -m "feat(calibration): partition judgments by pairOrder before scoring

Inert today: all 4200 production judgments are AB, so every stored number is
unchanged. Three parts, and the third is the subtle one:

(a) group rows by pairOrder so groundTruthReadings receives one order per
    call, which is the contract its duplicate-reading guard states;
(b) context travels INSIDE the partition, because rows is indexed positionally
    by the disagreement push and grouping rows alone reattributes them;
(c) the query no longer filters status:'completed'. It had to move into the
    partition: a run whose AB errored while its BA completed arrived with
    length === 1, escaped the length === 0 unjudged test entirely, and
    reported missingVerdicts 0 over a shortened denominator."
```

---

### Task 4: The renderer takes an order

**Files:**
- Modify: `src/lib/llm/render.ts:585` (signature + sort use), `:626-638` (`renderJudgmentPrompt`)
- Modify: `src/lib/llm/registry.ts:1019` (`renderJudgmentPromptOrThrow`), `:916-924` (`RunProviderJudgmentInput`), `:1098` (`prepareJudgmentCall`)
- Modify: `src/worker/judgment-consumer.ts:487-506` (the `registryInput` literal)
- Test: `tests/lib/render-pairwise.test.ts`, `tests/lib/judgment-consumer-escalation.test.ts`

**Interfaces:**
- Consumes: `PairOrder` from Task 2.
- Produces: `buildPairwiseUserPrompt(submission, order: PairOrder = 'AB')`; `renderJudgmentPrompt(template, rubric, submission, order?)`; `RunProviderJudgmentInput.pairOrder?: PairOrder`.

- [ ] **Step 1: Write the failing test**

In `tests/lib/render-pairwise.test.ts`:

```ts
it('renders position 1 as Response A under BA', () => {
  const submission = {
    inputText: 'Q',
    candidates: [
      { position: 0, responseText: 'ZERO', promptText: null, label: null },
      { position: 1, responseText: 'ONE', promptText: null, label: null },
    ],
  };
  const ab = buildPairwiseUserPrompt(submission, 'AB');
  const ba = buildPairwiseUserPrompt(submission, 'BA');

  expect(ab.indexOf('ZERO')).toBeLessThan(ab.indexOf('ONE'));
  expect(ba.indexOf('ONE')).toBeLessThan(ba.indexOf('ZERO'));
  // The bytes must actually differ — this is the assertion that catches a
  // swap that silently did nothing.
  expect(ba).not.toBe(ab);
});

it('defaults to AB so every existing caller is unchanged', () => {
  const submission = {
    inputText: 'Q',
    candidates: [
      { position: 0, responseText: 'ZERO', promptText: null, label: null },
      { position: 1, responseText: 'ONE', promptText: null, label: null },
    ],
  };
  expect(buildPairwiseUserPrompt(submission)).toBe(buildPairwiseUserPrompt(submission, 'AB'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/render-pairwise.test.ts -t 'position 1 as Response A'`
Expected: FAIL — `buildPairwiseUserPrompt` takes one argument; `ba` equals `ab`.

- [ ] **Step 3: Widen the renderer**

`src/lib/llm/render.ts`, replacing the signature at line 585 and the two `candidateText` calls at 598-599:

```ts
export function buildPairwiseUserPrompt(
  submission: RenderSubmission,
  order: PairOrder = 'AB'
): string {
  // The sort STAYS ascending: `position` is candidate identity
  // (golden-sets.ts:48, "position IS the identity (0 = A, 1 = B)"), and
  // `GoldenItem.expected` is stated against it. What the order changes is
  // which sorted candidate is PRESENTED as Response A — the screen slot —
  // never which candidate the stored `expected` refers to. Reordering
  // `position` instead would make `expected` ambiguous and force
  // `preferenceFromVerdict` to stop inverting, which is the no-symptom bug.
  const candidates = [...(submission.candidates ?? [])].sort((a, b) => a.position - b.position);
  if (candidates.length !== 2) {
    throw new Error(
      `Cannot build a pairwise judgment prompt: exactly 2 candidates are required, got ${candidates.length}`
    );
  }

  const question = submission.inputText?.trim() || submission.promptText?.trim();
  if (!question) {
    throw new Error('Cannot build a pairwise judgment prompt: no inputText or promptText provided');
  }

  const [first, second] = order === 'AB' ? candidates : [candidates[1], candidates[0]];
  const responseA = candidateText(first);
  const responseB = candidateText(second);
```

Add the import at the top of `render.ts`:

```ts
import type { PairOrder } from '@/lib/pair-order';
```

- [ ] **Step 4: Thread it through the remaining four hops**

`src/lib/llm/render.ts`, `renderJudgmentPrompt` (line 626):

```ts
export function renderJudgmentPrompt(
  template: RenderTemplate,
  rubric: RenderRubric,
  submission: RenderSubmission,
  order: PairOrder = 'AB'
): { systemPrompt: string; userPrompt: string } {
  return {
    systemPrompt: renderJudgmentSystemPrompt(template, rubric),
    userPrompt:
      template.protocol === 'pairwise'
        ? buildPairwiseUserPrompt(submission, order)
        : buildJudgmentUserPrompt(submission),
  };
}
```

`src/lib/llm/registry.ts`, `renderJudgmentPromptOrThrow` (line 1019) — widen the wrapper, never bypass it (`:1009-1017` explains that bypassing reclassifies a deterministic render failure as retryable):

```ts
function renderJudgmentPromptOrThrow(
  descriptorId: ServingBackend,
  template: RenderTemplate,
  rubric: RenderRubric,
  submission: RenderSubmission,
  order: PairOrder = 'AB'
): { systemPrompt: string; userPrompt: string } {
  try {
    return renderJudgmentPrompt(template, rubric, submission, order);
```

`src/lib/llm/registry.ts`, `RunProviderJudgmentInput` (line 916):

```ts
export interface RunProviderJudgmentInput {
  judgeVersion: JudgeVersionForExecution;
  endpoint: EndpointCredentials;
  template: RenderTemplate;
  rubric: RenderRubric;
  submission: RenderSubmission;
  /** Which order to PRESENT the pair in. Read from
   * `ModelJudgment.pairOrder` by the worker. Defaults to 'AB' so every
   * pointwise and pre-BA caller is unchanged. */
  pairOrder?: PairOrder;
  samplingOverrides?: Partial<SamplingParams>;
  escalation?: TimeoutEscalationContext;
}
```

`src/lib/llm/registry.ts`, `prepareJudgmentCall` (line 1104):

```ts
  const { systemPrompt, userPrompt } = renderJudgmentPromptOrThrow(
    descriptor.id,
    input.template,
    input.rubric,
    input.submission,
    input.pairOrder ?? 'AB'
  );
```

`src/worker/judgment-consumer.ts`, in the `registryInput` literal (after line 494, `template:`):

```ts
    // The judgment row has always carried `pairOrder`; until now NOTHING in
    // src/ read it, so writing 'BA' produced a row that lied about the prompt
    // it was shown. `isPairOrder` rather than a cast: the column is a nullable
    // String in Prisma, not an enum, so 'ba' is storable and must not silently
    // fall through to a BA render.
    pairOrder: isPairOrder(judgment.pairOrder) ? judgment.pairOrder : 'AB',
```

Add to `judgment-consumer.ts` imports: `import { isPairOrder } from '@/lib/pair-order';`

**Also correct the now-false comment at `judgment-consumer.ts:221-224`** — it claims the presented order "is a property of the QUERY". Replace with:

```ts
    // Ordered by `position` here so the candidate identity is stable and not
    // whatever order Postgres happened to return. The PRESENTED order is no
    // longer a property of this query — it is `ModelJudgment.pairOrder`,
    // applied in render.ts's buildPairwiseUserPrompt.
```

- [ ] **Step 5: Add the unit test for the threading**

`tests/integration/**` has no coverage instrumentation, so this must be a unit test. In `tests/lib/judgment-consumer-escalation.test.ts`:

```ts
it('passes the judgment pairOrder into the registry input', async () => {
  const captured: RegistryJudgmentInput[] = [];
  await defaultRunProviderPairwise({
    ...basePairwiseInput(),
    judgment: { ...baseJudgment(), pairOrder: 'BA' },
  }, { executePairwise: async (i) => { captured.push(i); return fakePairwiseResult(); } });
  expect(captured[0].pairOrder).toBe('BA');
});

it('falls back to AB for an unrecognised pairOrder rather than rendering BA', async () => {
  const captured: RegistryJudgmentInput[] = [];
  await defaultRunProviderPairwise({
    ...basePairwiseInput(),
    judgment: { ...baseJudgment(), pairOrder: 'ba' },
  }, { executePairwise: async (i) => { captured.push(i); return fakePairwiseResult(); } });
  expect(captured[0].pairOrder).toBe('AB');
});
```

- [ ] **Step 6: THE LOAD-BEARING TEST — assert the persisted prompt bytes**

Spec trap 4.1: a sign error here has no symptom, so an accuracy assertion cannot
catch it. Only the bytes can. `tests/lib/pairwise-execution.test.ts:275` and
`tests/lib/llm-truncation.test.ts:434-449` already pin `userPromptSha256` against
real render output under an OpenAI mock — extend that harness rather than
inventing one. In `tests/lib/pairwise-execution.test.ts`:

```ts
it('persists a DIFFERENT userPrompt and sha256 for BA than for AB', async () => {
  const ab = await executePairwise({ ...basePairwiseInput(), pairOrder: 'AB' });
  const ba = await executePairwise({ ...basePairwiseInput(), pairOrder: 'BA' });

  // The bytes actually changed. If this passes while the two are equal, the
  // swap silently did nothing and every BA row would be mislabelled.
  expect(ba.userPrompt).not.toBe(ab.userPrompt);
  expect(ba.userPromptSha256).not.toBe(ab.userPromptSha256);

  // And it changed in the RIGHT direction: position 1's text is presented
  // first under BA.
  const zero = 'CANDIDATE_AT_POSITION_ZERO';
  const one = 'CANDIDATE_AT_POSITION_ONE';
  expect(ab.userPrompt.indexOf(zero)).toBeLessThan(ab.userPrompt.indexOf(one));
  expect(ba.userPrompt.indexOf(one)).toBeLessThan(ba.userPrompt.indexOf(zero));
});

it('inverts in exactly ONE layer — a BA verdict of A means B>A', () => {
  // Guards the double-inversion in trap 4.2: the renderer swaps what is SHOWN,
  // preferenceFromVerdict swaps what it MEANS. Both together return to AB.
  expect(preferenceFromVerdict('A', 'BA')).toBe('B>A');
  expect(preferenceFromVerdict('A', 'AB')).toBe('A>B');
});
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/lib/render-pairwise.test.ts tests/lib/judgment-consumer-escalation.test.ts tests/lib/pairwise-execution.test.ts tests/lib/llm-truncation.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/llm/render.ts src/lib/llm/registry.ts src/worker/judgment-consumer.ts tests/lib/render-pairwise.test.ts tests/lib/judgment-consumer-escalation.test.ts tests/lib/pairwise-execution.test.ts
git commit -m "feat(render): buildPairwiseUserPrompt takes a PairOrder

ModelJudgment.pairOrder has existed since v2b and was read NOWHERE in src/.
The presented order was fixed in the worker's query, so writing 'BA' produced
a row that lied about the prompt the model saw — and readings.ts would then
have inverted it, which is the no-symptom sign error that file exists to
prevent.

Threaded five hops. The position sort is unchanged: position stays candidate
identity and expected stays stated against it; only the screen slot moves."
```

---

### Task 5: `position-bias.ts` — the two estimators

**Files:**
- Create: `src/lib/calibration/position-bias.ts`
- Test: `tests/lib/calibration-position-bias.test.ts`

**Interfaces:**
- Consumes: `PairOrder`, `isPairOrder` from Task 2.
- Produces:
  ```ts
  type PairedVerdictRow = { itemId: string; verdict: string | null; pairOrder: string | null };
  type Interval = { low: number; high: number };
  type PositionBiasResult = {
    positionBias: number | null;
    orderFlipRate: number | null;
    pairedDecisiveCount: number;
    tieExcludedCount: number;
    unpairedCount: number;
    positionBiasInterval: Interval | null;
    orderFlipRateInterval: Interval | null;
  };
  function positionBiasFromPairs(rows: PairedVerdictRow[]): PositionBiasResult;
  ```

- [ ] **Step 1: Write the failing tests — the three archetypes**

`tests/lib/calibration-position-bias.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { positionBiasFromPairs } from '@/lib/calibration/position-bias';

/** n items, each with an AB and a BA judgment. `ab`/`ba` pick the raw letter. */
const pairs = (n: number, ab: (i: number) => string | null, ba: (i: number) => string | null) =>
  Array.from({ length: n }, (_, i) => [
    { itemId: `i${i}`, verdict: ab(i), pairOrder: 'AB' },
    { itemId: `i${i}`, verdict: ba(i), pairOrder: 'BA' },
  ]).flat();

describe('positionBiasFromPairs', () => {
  it('scores a pure first-slot stamper 0.5 / 1.0', () => {
    // Always names slot A. Maximally position-driven.
    const r = positionBiasFromPairs(pairs(100, () => 'A', () => 'A'));
    expect(r.positionBias).toBeCloseTo(0.5, 10);
    expect(r.orderFlipRate).toBeCloseTo(1.0, 10);
    expect(r.pairedDecisiveCount).toBe(100);
  });

  it('scores a symmetric flipper 0.0 / 1.0 — the case marginal alone misses', () => {
    // Names the same slot in both orders, but no net side: half A, half B.
    const r = positionBiasFromPairs(pairs(100, (i) => (i % 2 ? 'A' : 'B'), (i) => (i % 2 ? 'A' : 'B')));
    expect(r.positionBias).toBeCloseTo(0.0, 10);
    expect(r.orderFlipRate).toBeCloseTo(1.0, 10);
  });

  it('scores a PERFECT CONTENT JUDGE 0.0 / 0.0 on a LOPSIDED key', () => {
    // THE LOAD-BEARING ARM. 62 of 100 items keyed A>B, mirroring the real
    // 336/284 set. A correct judge names slot A on the A>B items in AB and on
    // the B>A items in BA, so its pooled slot-A rate is exactly 0.5.
    // Computing this from PREFERENCES instead returns 0.12 here — a real
    // effect where there is none, and anticorrelated with position bias.
    const keyIsAB = (i: number) => i < 62;
    const r = positionBiasFromPairs(
      pairs(100, (i) => (keyIsAB(i) ? 'A' : 'B'), (i) => (keyIsAB(i) ? 'B' : 'A'))
    );
    expect(r.positionBias).toBeCloseTo(0.0, 10);
    expect(r.orderFlipRate).toBeCloseTo(0.0, 10);
  });

  it('excludes an item that tied in either order, and counts the exclusion', () => {
    const rows = [
      { itemId: 'i1', verdict: 'A', pairOrder: 'AB' },
      { itemId: 'i1', verdict: 'tie', pairOrder: 'BA' },
      { itemId: 'i2', verdict: 'A', pairOrder: 'AB' },
      { itemId: 'i2', verdict: 'A', pairOrder: 'BA' },
    ];
    const r = positionBiasFromPairs(rows);
    expect(r.pairedDecisiveCount).toBe(1);
    expect(r.tieExcludedCount).toBe(1);
  });

  it('returns nulls, not zeros, when nothing is decisive', () => {
    const r = positionBiasFromPairs(pairs(10, () => 'tie', () => 'tie'));
    expect(r.positionBias).toBeNull();
    expect(r.orderFlipRate).toBeNull();
    expect(r.pairedDecisiveCount).toBe(0);
  });

  it('does not pair an item that only ran in one order', () => {
    const r = positionBiasFromPairs([{ itemId: 'i1', verdict: 'A', pairOrder: 'AB' }]);
    expect(r.pairedDecisiveCount).toBe(0);
    expect(r.unpairedCount).toBe(1);
    expect(r.positionBias).toBeNull();
  });

  it('gives a flip-rate interval that narrows with n', () => {
    const small = positionBiasFromPairs(pairs(20, () => 'A', () => 'A'));
    const large = positionBiasFromPairs(pairs(620, () => 'A', () => 'A'));
    const width = (i: { low: number; high: number } | null) => (i ? i.high - i.low : Infinity);
    expect(width(large.orderFlipRateInterval)).toBeLessThan(width(small.orderFlipRateInterval));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/lib/calibration-position-bias.test.ts`
Expected: FAIL — cannot resolve `@/lib/calibration/position-bias`.

- [ ] **Step 3: Implement the module**

`src/lib/calibration/position-bias.ts`:

```ts
/**
 * ─── Position bias: how much of a verdict is the slot, not the content ──────
 *
 * TWO numbers, because one cannot separate the judges in this corpus.
 *
 *   positionBias  = |(verdicts naming slot A, both orders) / 2n − 0.5|
 *   orderFlipRate = fraction of paired items whose PREFERENCE changes on swap
 *
 * ── positionBias IS COMPUTED ON THE RAW VERDICT LETTER ──────────────────────
 *
 * Before `preferenceFromVerdict`, and that is the whole point. A verdict letter
 * names a SLOT ON THE SCREEN. Pooling the letters over both orders measures how
 * often the judge picked the first slot, which is exactly position bias, and it
 * is INDEPENDENT of the answer key's class balance: a correct judge names slot A
 * on the 'A>B' items in AB and on the 'B>A' items in BA, so its pooled rate is
 * 0.5 however lopsided the key.
 *
 * Computing it from PREFERENCES instead yields |p_AB − p_BA| / 2 — the
 * DIFFERENCE of the slot rates, which is a content-discrimination statistic
 * whose null is |keyBalance − 0.5|, and which is ANTICORRELATED with position
 * bias: a pure first-slot stamper scores 0.0 and a perfect judge scores 0.042.
 * Every value in range, matrix square, no symptom. An earlier draft of the
 * design specified exactly that; the test file's third archetype is the arm
 * that catches it.
 *
 * ── WHY BOTH ────────────────────────────────────────────────────────────────
 *
 *   always first slot    0.5 / 1.0     symmetric flipper   0.0 / 1.0
 *   perfect content      0.0 / 0.0     uniformly random    0.0 / 0.5
 *
 * The symmetric flipper is entirely position-driven and `positionBias` alone
 * certifies it clean. `orderFlipRate` alone cannot say WHICH slot, and its
 * no-information point is 0.5, not 0.
 *
 * ── TIES ────────────────────────────────────────────────────────────────────
 *
 * 'tie' is order-invariant by construction (readings.ts:103) and is this
 * product's sanctioned no-answer channel, so an item that tied in EITHER order
 * is excluded from both estimators — and the exclusion is COUNTED. Without
 * `tieExcludedCount` beside them, an abstaining judge scores a flawless 0.0
 * position bias on n = 3.
 */
import { isPairOrder } from '@/lib/pair-order';

export type PairedVerdictRow = {
  itemId: string;
  /** `ModelJudgment.verdict`, RAW — 'A' | 'B' | 'tie' | null. */
  verdict: string | null;
  /** `ModelJudgment.pairOrder`. */
  pairOrder: string | null;
};

export type Interval = { low: number; high: number };

export type PositionBiasResult = {
  positionBias: number | null;
  orderFlipRate: number | null;
  /** The denominator BOTH estimators share. Never render either without it. */
  pairedDecisiveCount: number;
  /** Items that paired but tied in at least one order. */
  tieExcludedCount: number;
  /** Items that did not produce a usable verdict in both orders. */
  unpairedCount: number;
  positionBiasInterval: Interval | null;
  orderFlipRateInterval: Interval | null;
};

const Z = 1.959963984540054;

/** Wilson score interval. Correct for `orderFlipRate`: one Bernoulli per item. */
function wilson(successes: number, n: number): Interval {
  const p = successes / n;
  const d = 1 + (Z * Z) / n;
  const centre = p + (Z * Z) / (2 * n);
  const spread = Z * Math.sqrt((p * (1 - p)) / n + (Z * Z) / (4 * n * n));
  return { low: Math.max(0, (centre - spread) / d), high: Math.min(1, (centre + spread) / d) };
}

export function positionBiasFromPairs(rows: PairedVerdictRow[]): PositionBiasResult {
  const byItem = new Map<string, { AB?: string; BA?: string }>();
  for (const row of rows) {
    if (!isPairOrder(row.pairOrder) || row.verdict === null) continue;
    const entry = byItem.get(row.itemId) ?? {};
    entry[row.pairOrder] = row.verdict;
    byItem.set(row.itemId, entry);
  }

  let unpairedCount = 0;
  let tieExcludedCount = 0;
  let flips = 0;
  /** Per-item count of verdicts naming slot A, in {0, 1, 2}. */
  const slotACounts: number[] = [];

  for (const { AB, BA } of byItem.values()) {
    if (AB === undefined || BA === undefined) {
      unpairedCount += 1;
      continue;
    }
    if (AB === 'tie' || BA === 'tie') {
      tieExcludedCount += 1;
      continue;
    }
    slotACounts.push((AB === 'A' ? 1 : 0) + (BA === 'A' ? 1 : 0));
    // The preference flips exactly when the SAME slot is named twice: under
    // BA, verdict 'A' means 'B>A'. So AB === BA <=> the judge followed the
    // slot rather than the candidate.
    if (AB === BA) flips += 1;
  }

  const n = slotACounts.length;
  if (n === 0) {
    return {
      positionBias: null, orderFlipRate: null, pairedDecisiveCount: 0,
      tieExcludedCount, unpairedCount,
      positionBiasInterval: null, orderFlipRateInterval: null,
    };
  }

  const slotATotal = slotACounts.reduce((a, b) => a + b, 0);
  const pA = slotATotal / (2 * n);
  const positionBias = Math.abs(pA - 0.5);
  const orderFlipRate = flips / n;

  // PAIRED interval, not Wilson. Each item contributes TWO clustered draws and
  // |·| folds the scale at 0.5, so a Wilson on pA shifted by 0.5 can exclude
  // its own point estimate. The variance is taken BETWEEN items, over the
  // per-item counts in {0,1,2}. This reduces to the closed form
  // 1.96*sqrt(f/4n) in the symmetric case, which is where the design's
  // resolution table comes from.
  const mean = slotATotal / n;
  const variance =
    n < 2 ? 0 : slotACounts.reduce((acc, c) => acc + (c - mean) * (c - mean), 0) / (n - 1);
  const halfWidth = (Z * Math.sqrt(variance / n)) / 2;

  return {
    positionBias,
    orderFlipRate,
    pairedDecisiveCount: n,
    tieExcludedCount,
    unpairedCount,
    positionBiasInterval: {
      low: Math.max(0, positionBias - halfWidth),
      high: Math.min(0.5, positionBias + halfWidth),
    },
    orderFlipRateInterval: wilson(flips, n),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/lib/calibration-position-bias.test.ts`
Expected: PASS, all seven.

- [ ] **Step 5: Commit**

```bash
git add src/lib/calibration/position-bias.ts tests/lib/calibration-position-bias.test.ts
git commit -m "feat(calibration): positionBias and orderFlipRate over paired verdicts

positionBias is computed on the RAW verdict letter, before
preferenceFromVerdict — that is what makes it independent of the answer key's
class balance. Computing it from preferences yields the DIFFERENCE of the two
slot rates, which is anticorrelated with position bias: a pure first-slot
stamper scores 0.0 and a perfect judge scores 0.042 on this corpus.

Three archetype fixtures pin it, including a perfect content judge on a
lopsided 62/38 key — the only arm that catches that confound."
```

---

### Task 6: Migration `v2o` and the generation-3 bump

**Files:**
- Create: `prisma/migrations/20260907120000_v2o_calibration_position_bias/migration.sql`
- Modify: `prisma/schema.prisma` (CalibrationRun, around lines 1001-1004)
- Modify: `src/lib/calibration/scoring-version.ts:59` and the changelog
- Test: `tests/lib/calibration-scoring-version.test.ts`, `tests/db/calibration-link.test.ts`

**Interfaces:**
- Produces: `CalibrationRun.orderFlipRate Float?`, `.pairedDecisiveCount Int?`, `.ordersRequested String?`; `SCORING_RULES_VERSION = 3`.

- [ ] **Step 1: Write the migration**

`prisma/migrations/20260907120000_v2o_calibration_position_bias/migration.sql`:

```sql
-- v2o. The BA sweep: a second ModelJudgment per item at pairOrder 'BA', and
-- the two estimators computed from the pair.
--
-- NO BACKFILL. All 22 pre-existing CalibrationRun rows measured one order and
-- genuinely did not measure position bias; NULL is the honest state and
-- `ordersRequested` is what makes that NULL unambiguous.
--
-- positionBias already exists (v2_meta_eval, 2026-07-25) and was never
-- written by any code path. It is documented here for the first time.
ALTER TABLE "CalibrationRun" ADD COLUMN "orderFlipRate" DOUBLE PRECISION;
ALTER TABLE "CalibrationRun" ADD COLUMN "pairedDecisiveCount" INTEGER;
ALTER TABLE "CalibrationRun" ADD COLUMN "ordersRequested" TEXT;
```

- [ ] **Step 2: Document the columns in the schema**

`prisma/schema.prisma`, replacing the bare `positionBias Float?` line and adding the three:

```prisma
  /// v2o. |(verdicts naming slot A across BOTH orders) / 2n - 0.5|, computed
  /// on the RAW verdict letter BEFORE preferenceFromVerdict — which is what
  /// makes it independent of the answer key's class balance. 0.5 = every
  /// verdict named the first slot; 0.0 = no net side. NULL means no paired
  /// decisive item existed; read `ordersRequested` to tell "never paired"
  /// from "paired but undecisive".
  positionBias        Float?
  /// v2o. Fraction of paired decisive items whose PREFERENCE changed under
  /// swap. Its no-information point is 0.5, not 0: any order-independent
  /// judge flips at least half the time. Stored beside positionBias because
  /// a symmetric flipper scores 0.0 there and 1.0 here.
  orderFlipRate       Float?
  /// v2o. The denominator BOTH estimators share — items decisive in both
  /// orders. Never render either rate without it.
  pairedDecisiveCount Int?
  /// v2o. Which orders this run ASKED for, e.g. 'AB' or 'AB,BA'. Without it a
  /// BA half that launched and never drained would store identically to a run
  /// that never had one, and a NULL estimator would be ambiguous.
  ordersRequested     String?
```

- [ ] **Step 3: Bump the generation and add the changelog entry in the SAME commit**

`src/lib/calibration/scoring-version.ts`:

```ts
export const SCORING_RULES_VERSION = 3;
```

and append to `SCORING_RULES_CHANGELOG`:

```ts
  {
    version: 3,
    migration: 'v2o',
    rules:
      "The BA sweep. rawAgreement, kappa, verdictCount, committedCount and " +
      "selectiveAccuracy are UNCHANGED in definition and are computed over the " +
      "'AB' partition only, so a generation-3 number is directly comparable to a " +
      "generation-2 one. What is new is that a pairwise run may now carry a " +
      "SECOND ModelJudgment per item at pairOrder 'BA', from which positionBias " +
      "and orderFlipRate are computed over items decisive in both orders. The " +
      "bump is required by this file's own UNLESS carve-out and not by a changed " +
      "definition: without it a NULL positionBias would mean both 'scored under " +
      "rules that could not produce it' and 'a real measurement with a zero " +
      "denominator'. ordersRequested disambiguates the second reading, exactly " +
      "as committedCount does for selectiveAccuracy at generation 2 — which was " +
      "bumped anyway, and this follows that precedent.",
  },
```

- [ ] **Step 4: Run the migration against the test database and regenerate**

Run: `npx prisma generate && npm run test:db -- tests/db/calibration-link.test.ts`
Expected: PASS. Run alone — the db suite is not concurrency-safe.

- [ ] **Step 5: Run the version test**

Run: `npx vitest run tests/lib/calibration-scoring-version.test.ts`
Expected: PASS — the test pins constant↔changelog consistency and `/^v2[a-z]$/` on `migration`.

- [ ] **Step 6: Commit**

```bash
git add prisma/ src/lib/calibration/scoring-version.ts
git commit -m "feat(calibration): v2o — orderFlipRate, pairedDecisiveCount, ordersRequested

Bumps SCORING_RULES_VERSION to 3. The stored rawAgreement/kappa/verdictCount
keep their definitions and stay AB-only, so generation 3 and generation 2 rows
remain directly comparable — the bump is a provenance stamp.

It is required by scoring-version.ts's own UNLESS carve-out: a NULL
positionBias would otherwise mean both 'these rules could not produce it' and
'a real measurement with a zero denominator'. ordersRequested resolves the
second reading, and generation 2 was bumped for exactly this shape."
```

---

### Task 7: Launch emits both orders

**Files:**
- Modify: `src/lib/run-launch.ts:324-355` (params), `:540-556` (the nested create)
- Modify: `src/lib/calibration/launch.ts:116-125` (params), `:114` (the clamp), `:460-472` (the call), `:377` (the CalibrationRun create)
- Modify: `scripts/calibration/run.ts:162-165` (the `--orders` flag)
- Modify: `tests/integration/finalization.test.ts:628` (the orders factor)
- Test: `tests/db/calibration-link.test.ts`, `tests/integration/pairwise-run.test.ts`

**Interfaces:**
- Consumes: `PairOrder`, `PAIR_ORDERS` from Task 2.
- Produces: `LaunchSingleRunParams.orders?: PairOrder[]` (default `['AB']`); `LaunchCalibrationRunParams.orders?: PairOrder[]`; `MAX_PAIRED_CALIBRATION_ITEMS`.

- [ ] **Step 1: Write the failing test**

In `tests/db/calibration-link.test.ts`:

```ts
it('creates one judgment per requested order, in one transaction', async () => {
  const launch = await launchSingleRun({
    evaluationId: evaluation.id,
    triggeredById: user.id,
    judgeModelVersionIds: [version.id],
    protocol: 'pairwise',
    candidates: twoCandidates(),
    orders: ['AB', 'BA'],
  }, deps);

  const judgments = await prisma.modelJudgment.findMany({
    where: { runId: launch.runIds[0] },
    orderBy: { pairOrder: 'asc' },
  });
  expect(judgments).toHaveLength(2);
  expect(judgments.map((j) => j.pairOrder)).toEqual(['AB', 'BA']);
  // Both must exist before the run is claimable: claim.ts stamps deadlineAt
  // once from judgmentCount, so a late insert inherits an expired deadline.
  expect(judgments.every((j) => j.status === 'pending')).toBe(true);
});

it('still creates exactly one AB judgment when orders is omitted', async () => {
  const launch = await launchSingleRun({
    evaluationId: evaluation.id,
    triggeredById: user.id,
    judgeModelVersionIds: [version.id],
    protocol: 'pairwise',
    candidates: twoCandidates(),
  }, deps);
  const judgments = await prisma.modelJudgment.findMany({ where: { runId: launch.runIds[0] } });
  expect(judgments).toHaveLength(1);
  expect(judgments[0].pairOrder).toBe('AB');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:db -- tests/db/calibration-link.test.ts`
Expected: FAIL — `orders` is not a parameter; one judgment created.

- [ ] **Step 3: Add the parameter and emit both judgments**

`src/lib/run-launch.ts`, adding to `LaunchSingleRunParams`:

```ts
  /** A2: which candidate orders to present. One `ModelJudgment` per order per
   * selected judge version, ALL created in this transaction. Defaults to
   * `['AB']` so every existing caller is unchanged. Ignored for pointwise,
   * where `pairOrder` is NULL.
   *
   * They must be created together: `claim.ts:198-202` asserts a run's judgment
   * rows are "fixed at creation", and `claim.ts:239-241` stamps `deadlineAt`
   * once from `judgmentCount` — a judgment inserted later inherits an expired
   * deadline and is reaped. */
  orders?: PairOrder[];
```

and replacing the `modelJudgments.create` block (lines 540-556):

```ts
        modelJudgments: {
          create: selectedVersionIds.flatMap((judgeModelVersionId) =>
            protocol === 'pairwise'
              ? (params.orders ?? ['AB']).map((pairOrder) => ({
                  judgeModelVersionId,
                  promptTemplateId,
                  pairOrder,
                  status: 'pending' as const,
                }))
              : [{
                  judgeModelVersionId,
                  promptTemplateId,
                  // Pointwise has no order. NULL, and the
                  // @@unique([runId, judgeModelVersionId, pairOrder]) is
                  // NULLS NOT DISTINCT, so this stays one row per version.
                  pairOrder: null,
                  status: 'pending' as const,
                }]
          ),
        },
```

- [ ] **Step 4: Thread it through the calibration launcher and add the clamp**

`src/lib/calibration/launch.ts`, adding to `LaunchCalibrationRunParams`:

```ts
  /** Which candidate orders each item is judged in. Defaults to `['AB']`. */
  orders?: PairOrder[];
```

Near `MAX_CALIBRATION_ITEMS` (line 114):

```ts
/**
 * The item ceiling for a PAIRED run. The reaper's never-started net gives a
 * launched judgment 45 days (NEVER_STARTED_TIMEOUT_MS = 3.888e9 ms), and the
 * legal worst case is
 *
 *     items x orders x MAX_ATTEMPTS(3) x resolveTimeoutBudgets().hardCapMs
 *
 * At the resolved default cap of 900_000 ms that admits 720 items at two
 * orders; 719 keeps it strictly inside. MAX_CALIBRATION_ITEMS itself stays
 * 1000 — it is the one-order ceiling and tests/db/calibration-link.test.ts:488
 * pins it.
 *
 * CAVEAT the finalization test must encode: at the legal ceiling
 * MAX_HARD_CAP_MS = 1_170_000 (timeout-policy.ts:94) even 620 paired items is
 * 4.352e9 and exceeds the net. Resolve the cap, never assume the default.
 */
export const MAX_PAIRED_CALIBRATION_ITEMS = 719;
```

and in the body, before the item loop:

```ts
  const orders = params.orders ?? ['AB'];
  const itemCeiling = orders.length > 1 ? MAX_PAIRED_CALIBRATION_ITEMS : MAX_CALIBRATION_ITEMS;
  if (items.length > itemCeiling) {
    throw new Error(
      `Calibration would launch ${items.length} items x ${orders.length} orders, over the ` +
        `${itemCeiling}-item ceiling for ${orders.length}-order runs. See MAX_PAIRED_CALIBRATION_ITEMS.`
    );
  }
```

Pass it at the `launchSingleRun` call (line 460):

```ts
          calibrationRunId: calibrationRun.id,
          orders,
```

And record it on the header, at the `calibrationRun.create` (line 377):

```ts
      ordersRequested: orders.join(','),
```

- [ ] **Step 5: Add the CLI flag**

`scripts/calibration/run.ts`, after line 165:

```ts
  const ordersArg = arg('orders');
  const orders = (ordersArg ? ordersArg.split(',') : ['AB']).map((o) => o.trim());
  if (!orders.every(isPairOrder) || orders.length === 0) {
    throw new Error(`--orders must be a comma-separated list of AB and/or BA; got ${JSON.stringify(ordersArg)}`);
  }
```

and pass `orders` into `launchCalibrationRun`.

- [ ] **Step 6: Fix the silent hole in the finalization test**

`tests/integration/finalization.test.ts`, replacing line 628:

```ts
  // The orders factor was missing, so this assertion stayed GREEN while the
  // real bound doubled. Resolve the cap rather than assuming the default:
  // at MAX_HARD_CAP_MS even 620 paired items exceeds the 45-day net.
  const ORDERS_PER_ITEM = 2;
  const legalWorstCaseMs =
    MAX_PAIRED_CALIBRATION_ITEMS * ORDERS_PER_ITEM * 3 * resolveTimeoutBudgets().hardCapMs;
  expect(legalWorstCaseMs).toBeLessThan(NEVER_STARTED_TIMEOUT_MS);
```

- [ ] **Step 7: Make `pairwise-run.test.ts` order-explicit**

`tests/integration/pairwise-run.test.ts` uses `findFirstOrThrow` at lines 297, 302 and 329. With two judgments that becomes nondeterministic — flaky, not red, which is worse. Add `where: { pairOrder: 'AB' }` to each.

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm run test:db -- tests/db/calibration-link.test.ts` then `npx vitest run --config vitest.integration.config.ts`
Expected: PASS both. Serialize; do not run the db suite concurrently.

- [ ] **Step 9: Commit**

```bash
git add src/lib/run-launch.ts src/lib/calibration/launch.ts scripts/calibration/run.ts tests/
git commit -m "feat(launch): emit one judgment per requested pair order

Both orders are created in the SAME transaction, because claim.ts stamps
deadlineAt once from judgmentCount and a judgment inserted afterwards inherits
an expired deadline and is reaped.

Also closes a silent hole: finalization.test.ts's legalWorstCaseMs had no
orders factor, so it stayed green while the real bound doubled. At the default
900s cap a paired run admits 719 items, not 1000."
```

---

### Task 8: Wire the estimators in, and report them

**Files:**
- Modify: `src/lib/calibration/score.ts` (compute + store)
- Modify: `src/lib/calibration/baseline.ts` (the formatter)
- Modify: `scripts/calibration/run.ts` (one call site only)
- Test: `tests/lib/calibration-score.test.ts`, `tests/lib/calibration-baseline.test.ts`

**Interfaces:**
- Consumes: `positionBiasFromPairs` (Task 5), the partitions (Task 3), the v2o columns (Task 6).
- Produces: `formatPositionBiasLines(result: PositionBiasResult): string[]`; `CalibrationScore` gains the five position-bias fields.

- [ ] **Step 1: Write the failing tests**

In `tests/lib/calibration-score.test.ts`:

```ts
it('computes position bias from both partitions and stores it', async () => {
  const client = fakeClientWithRuns([
    { itemId: 'i1', index: 0, expected: 'A>B', judgments: [
      { pairOrder: 'AB', verdict: 'A', status: 'completed' },
      { pairOrder: 'BA', verdict: 'A', status: 'completed' },
    ] },
  ]);
  const score = await scoreCalibrationRun('cal1', client);
  expect(score.positionBias).toBeCloseTo(0.5, 10);
  expect(score.orderFlipRate).toBeCloseTo(1.0, 10);
  expect(score.pairedDecisiveCount).toBe(1);
  expect(client.calibrationRun.update).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ positionBias: 0.5 }) })
  );
});

it('stores NULL estimators for an AB-only run', async () => {
  const client = fakeClientWithRuns([
    { itemId: 'i1', index: 0, expected: 'A>B', judgments: [{ pairOrder: 'AB', verdict: 'A', status: 'completed' }] },
  ]);
  const score = await scoreCalibrationRun('cal1', client);
  expect(score.positionBias).toBeNull();
  expect(score.pairedDecisiveCount).toBe(0);
});
```

In `tests/lib/calibration-baseline.test.ts`:

```ts
it('never prints a rate without its denominator', () => {
  const lines = formatPositionBiasLines({
    positionBias: 0.1786, orderFlipRate: 0.42, pairedDecisiveCount: 610,
    tieExcludedCount: 7, unpairedCount: 3,
    positionBiasInterval: { low: 0.15, high: 0.21 },
    orderFlipRateInterval: { low: 0.38, high: 0.46 },
  }).join('\n');
  expect(lines).toContain('610');
  expect(lines).toContain('0.1786');
  expect(lines).toContain('7');
});

it('warns below 20 paired decisive items', () => {
  const lines = formatPositionBiasLines({
    positionBias: 0.5, orderFlipRate: 1, pairedDecisiveCount: 5,
    tieExcludedCount: 0, unpairedCount: 0,
    positionBiasInterval: { low: 0.2, high: 0.5 },
    orderFlipRateInterval: { low: 0.5, high: 1 },
  }).join('\n');
  expect(lines).toMatch(/n<20|rests on 5/);
});

it('prints nothing at all for an unpaired run', () => {
  expect(formatPositionBiasLines({
    positionBias: null, orderFlipRate: null, pairedDecisiveCount: 0,
    tieExcludedCount: 0, unpairedCount: 0,
    positionBiasInterval: null, orderFlipRateInterval: null,
  })).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/lib/calibration-score.test.ts tests/lib/calibration-baseline.test.ts -t position`
Expected: FAIL — `score.positionBias` undefined; `formatPositionBiasLines` not exported.

- [ ] **Step 3: Compute in score.ts**

After the partition block from Task 3:

```ts
// Both orders, pooled — this is the ONE place the raw verdict letters from
// BOTH partitions are read together. Everything else is AB-only (D2).
const bias = positionBiasFromPairs(
  [...partitions.entries()]
    .filter(([key]) => key === 'AB' || key === 'BA')
    .flatMap(([, p]) => p.rows.map((r) => ({ itemId: r.itemId, verdict: r.verdict, pairOrder: r.pairOrder })))
);
```

Add to the `CalibrationScore` object and to the `calibrationRun.update` `data`:

```ts
      positionBias: bias.positionBias,
      orderFlipRate: bias.orderFlipRate,
      pairedDecisiveCount: bias.pairedDecisiveCount,
```

- [ ] **Step 4: Format in baseline.ts**

`src/lib/calibration/baseline.ts`:

```ts
/** Both estimators, never either alone, and never a rate without its
 *  denominator. Lives HERE and not in scripts/calibration/run.ts because that
 *  file is in no coverage include — logic placed there is untested by
 *  construction. */
export function formatPositionBiasLines(result: PositionBiasResult): string[] {
  if (result.pairedDecisiveCount === 0 || result.positionBias === null || result.orderFlipRate === null) {
    return [];
  }
  const n = result.pairedDecisiveCount;
  const pb = result.positionBiasInterval;
  const fr = result.orderFlipRateInterval;
  const lines = [
    `  POSITION BIAS  ${result.positionBias.toFixed(4)}` +
      (pb ? ` [${pb.low.toFixed(4)}-${pb.high.toFixed(4)}]` : '') +
      `   over ${n} item(s) decisive in BOTH orders` +
      `   (0.5 = every verdict named the first slot; 0.0 = no net side)`,
    `  ORDER FLIP     ${result.orderFlipRate.toFixed(4)}` +
      (fr ? ` [${fr.low.toFixed(4)}-${fr.high.toFixed(4)}]` : '') +
      `   over the same ${n}   (no-information point is 0.5, NOT 0)`,
    `  excluded       ${result.tieExcludedCount} tied in at least one order, ${result.unpairedCount} not paired`,
  ];
  if (n < 20) {
    lines.push(`  ⚠ both figures rest on ${n} paired item(s) — too few to separate a judge from a stamp.`);
  }
  if (result.positionBias >= 0.10) {
    lines.push(`  ⚑ position bias is at or above the 0.10 threshold recorded in the judge-model inventory.`);
  }
  return lines;
}
```

- [ ] **Step 5: Add exactly one call site in the CLI**

`scripts/calibration/run.ts`, beside the existing `formatSelectiveAccuracyLines` call. **One call only** — `tests/lib/calibration-baseline.test.ts:389,400` pin exactly one call site each of the neighbouring formatters, and a second would go red.

- [ ] **Step 6: Run the full gate suite**

```bash
npx vitest run                                   # unit
npm run test:db                                  # serialized, alone
npm run test:integration
npm run lint && npm run build
```
Expected: all green, coverage floors unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/lib/calibration/ scripts/calibration/run.ts tests/
git commit -m "feat(calibration): store and report positionBias and orderFlipRate

Rendered in baseline.ts, not scripts/calibration/run.ts, which is in no
coverage include. Neither rate is ever printed without pairedDecisiveCount and
the tie-exclusion count beside it: without them an abstaining judge scores a
flawless 0.0 position bias on n=3."
```

---

### Task 9: Stop the two orders pooling silently in the reports

Spec traps 4.4 and §8's sampling residual. Neither throws; both quietly average
AB and BA together, which is the failure mode this whole design exists to
prevent, one layer up.

**Files:**
- Modify: `src/lib/calibration/latency.ts:550-566` (the tuple key)
- Modify: `src/lib/calibration/sampling-drift.ts` (per-order grouping)
- Test: `tests/lib/calibration-latency.test.ts`, `tests/lib/calibration-sampling-drift.test.ts`

**Interfaces:**
- Consumes: `PairOrder` from Task 2.
- Produces: `timeToComputeByTuple` keys gain a `pairOrder` component; `describeSamplingSnapshot` output gains a per-order split.

- [ ] **Step 1: Write the failing test**

In `tests/lib/calibration-latency.test.ts`:

```ts
it('does not pool the two orders into one per-tuple mean', () => {
  const tuples = timeToComputeByTuple([
    { datasetId: 'd', itemId: 'i1', judgeModelVersionId: 'v1', pairOrder: 'AB', latencyMs: 1000, status: 'completed' },
    { datasetId: 'd', itemId: 'i1', judgeModelVersionId: 'v1', pairOrder: 'BA', latencyMs: 9000, status: 'completed' },
  ]);
  // Two tuples, not one averaged to 5000 — an order that is systematically
  // slower is a real finding and pooling hides it.
  expect(tuples).toHaveLength(2);
  expect(tuples.map((t) => t.meanMs).sort((a, b) => a - b)).toEqual([1000, 9000]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/calibration-latency.test.ts -t pool`
Expected: FAIL — one tuple with `meanMs` 5000.

- [ ] **Step 3: Add pairOrder to the tuple key**

`src/lib/calibration/latency.ts`, at the key construction (line 566):

```ts
    // pairOrder is part of the tuple identity. Without it the two orders of one
    // item average into a single mean — and an order that is systematically
    // slower (a longer prompt, a model that reasons harder when the better
    // answer is second) is exactly the kind of asymmetry a position-bias run is
    // trying to see. It does not throw; it just quietly reports the mean of two
    // different things.
    const key = `${datasetId}|${item.id}|${judgeModelVersionId}|${pairOrder ?? ''}`;
```

- [ ] **Step 4: Split the drift report by order**

`src/lib/calibration/sampling-drift.ts` — `detectSamplingDrift` groups per RUN, not per ORDER. It correctly reports `moved_mid_run`, but a position-bias reader needs to know *which orders ran under which config*, because a config that moved between the AB half and the BA half would present as position bias. Add the breakdown to `describeSamplingSnapshot`'s output:

```ts
  // Per-order, because a samplingDefaults edit that lands between the AB and
  // BA halves of a paired run is indistinguishable from position bias in the
  // final number. The drift itself is already detected; this says WHERE.
  const byOrder = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = row.pairOrder ?? '(pointwise)';
    const set = byOrder.get(key) ?? new Set<string>();
    set.add(canonicalJson(row.samplingParams));
    byOrder.set(key, set);
  }
  const split = [...byOrder.entries()].map(
    ([order, configs]) => `    ${order}: ${configs.size} distinct config(s)`
  );
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/lib/calibration-latency.test.ts tests/lib/calibration-sampling-drift.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/calibration/latency.ts src/lib/calibration/sampling-drift.ts tests/
git commit -m "fix(calibration): stop the two orders pooling in latency and drift

Neither throws. timeToComputeByTuple keyed on (dataset, item, version) with no
order component, so the two orders of one item averaged into one mean. And
detectSamplingDrift groups per run, not per order — a samplingDefaults edit
landing between the AB and BA halves is indistinguishable from position bias
in the final number, so the report now says which orders ran under which
config."
```

---

## Execution order after the code lands

| # | action | lane | cost | gate |
|---|---|---|---|---|
| 1 | Full gate suite green, image built and promoted | — | — | migrations run via the Helm pre-upgrade hook; never hand-apply |
| 2 | `smollm2:1.7b` × 620, `--orders=AB,BA` | 3 (idle) | ~18 min | first estimators in the product |
| 3 | `granite4.2:3b` v2 (new ordinal, penalty set) × 30 sample, `--orders=AB,BA` | 0 | ~2 min | harness check only — v1 swung 15/30 vs 5/30 failures on the same config, so a clean sample is NOT evidence about granite |
| 4 | `granite4.2:3b` v2 × 620, `--orders=AB,BA` | 0 | measure from step 3 | requires lane 0 drained |
| 5 | `Qwen3.6-35B-A3B v2` × 620, `--orders=AB,BA` | 1 (idle) | ~17.1 h | the decision-relevant number |

## Accepted risks carried into implementation

- **`src/lib/export.ts:129` emits one row per judgment with no order column**, so a
  paired run exports and displays as two indistinguishable rows for one item.
  Named in the spec §5 as an accepted risk. Closing it means adding
  `model_pair_order` (both export routes' `include` already loads it); it is
  deliberately NOT in this plan's scope. `/api/leaderboard/route.ts:88-92` is
  unaffected because it filters `overallScore: { not: null }`, which pairwise
  judgments never carry.
- **`docs/calibration-scoreboard-2026-09-06.md` is untracked**, so the spec's
  citations to it dangle on a clean checkout. Commit it or inline the numbers
  before this branch merges.

---

Warm the target model immediately before each run — a model evicted by a neighbour costs ~153 s to reload, and on `192.168.1.9` `qwen3.5:9b` and `granite4.2:3b` evict each other.
