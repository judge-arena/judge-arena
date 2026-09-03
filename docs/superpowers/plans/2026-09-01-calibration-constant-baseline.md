# Calibration Constant-Verdict Baseline (v2l) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every calibration score carries the constant-verdict (degenerate) floor — max(answer-key class)/verdictCount over the SCORED subset — beside its accuracy, computed per run, stored on the row, and printed by the CLI with a margin and a below-floor warning.

**Architecture:** A new pure module `src/lib/calibration/baseline.ts` (`constantVerdictBaseline(keyCounts)`) is the single source of truth; `score.ts` feeds it a `keyCounts` accumulator incremented past the same null-verdict gate as `verdictCount`, returns `constantBaseline` + `marginOverConstant` on `CalibrationScore`, and writes `constantBaselineAccuracy` (one additive `Float?` column, migration v2l) in the same full-overwrite `calibrationRun.update` as `rawAgreement`, so the §8 scoreboard SQL can read the floor beside the number it floors and re-scoring after a drain moves both together. `scripts/calibration/run.ts` prints one `constant` line (subset floor only — never the whole set's) and a `⚠` when accuracy ≤ floor — but it does not BUILD those strings: they come from `formatConstantBaselineLines` in the same `baseline.ts`, because `scripts/**` is outside every coverage include and has no harness, and the `<=` boundary is exactly the thing that must stay tested. Docs get CORRECTION notes for the `15/25` ratio error and DONE notes for the register/handoff items.

**Tech Stack:** Next.js 15.5.22 / TypeScript / Prisma 6.19.2 on Postgres (`Float?` → `DOUBLE PRECISION`) / vitest (unit + db configs) / tsx for the CLI.

**Spec:** `docs/superpowers/plans/2026-09-01-scoreboard-handoff.md` §2 (:76-93, "the floor moves with the denominator") and §7 #2 (:331-333 on HEAD 5e48187 — Wave 1's CORRECTION notes pushed it down from :301-303); `docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md` §1 (:33-66, reference lines + per-denominator argument) and §4.2 (:238-247); register `docs/superpowers/plans/2026-08-30-state-and-next-steps.md` §5.6 #7 (:425-430); verified map `/tmp/ja-plan-inputs/degenerate-baseline.json` (its `verify.contradictions` / `verify.corrections` override the map); cross-item critique `/tmp/ja-plan-inputs/critique.json` (`q2_missingInfoPerMap.degenerate-baseline`, `q3`, and `q4[2]` — the binding "STORE IT TOO" ruling).

**Priority / wave:** Wave 2 / #5 (S).

**Depends on:** `calibration-sampling-snapshot` (v2k) — it shares `scripts/calibration/run.ts`'s Result print block and the handoff §8 SQL block, and it owns the migration letter before this one. **That dependency is SATISFIED: v2k is `33b7be4`, HEAD, and `20260901180000_v2k_calibration_sampling_snapshot` is applied to the local test DB.** Every line number below was therefore re-verified against HEAD `33b7be4` on 2026-09-02, after both waves, and the ones that moved are already corrected here: `run.ts`'s ACCURACY line is **:277** and kappa **:278** (itemCount :279, the `missingVerdicts` block :280-282), `fmt` is **:69-71**, the `scoreCalibrationRun` import is still **:53** (v2k's `sampling-drift` import went in after it, at :54); the handoff §7 #2 item is **:343-345**, its §8 `SELECT` line is **:398** (not :382 — v2k's rewritten comment block ends at :396 and the `kubectl` line is :397), and the register §5.6 #7 item is **:431-436**. `score.ts`, `tests/lib/calibration-score.test.ts`, `tests/db/meta-eval.test.ts`, the runbook and the spec anchors were unchanged by both waves; `prisma/schema.prisma`'s `CalibrationRun` grew to :903-952 but `rawAgreement        Float?` is still :910 and still occurs exactly once. **Anchor every edit on the quoted text, not the number.**

**Owner decisions needed:** none for the code. One post-landing operator decision is recorded in Task 3: the 9 existing production rows will hold `constantBaselineAccuracy = NULL` until each is re-scored with `--score-only` on an image carrying v2l (a write against production — not done by this plan).

## Global Constraints

- Repo: /root/judge-arena (Next.js 15.5.22, TypeScript, Prisma on Postgres — Json maps to JSONB —, amqplib 2.0.1, vitest). Node >= 22. Always use `git -C /root/judge-arena` (handoff trap 2: a stale `cd` once hard-reset the wrong repo).
- Gates, in this order, all must be clean before every commit: `npm run lint` (0 warnings) → `npx tsc --noEmit` → `npm run test:coverage` (unit; per-glob floors in vitest.config.ts:187-220 — NEVER lower a floor; if a new test import drags a module into a denominator, mock the seam as tests/lib/judgment-consumer-escalation.test.ts:41-69 does) → `npm run test:db:coverage` (RESETS the database at .env.test — verified today to be localhost:5432, the local podman `judge-arena-pg`, NOT the k8s `judge-arena-pg-1`; re-confirm with `grep DATABASE_URL /root/judge-arena/.env.test` before the first run) → `npm run test:integration` → `npm run build`. **Baseline measured on HEAD `33b7be4` (v2k landed) on 2026-09-02: 888 unit / 57 files; 674 db / 46 files; 82 integration / 11 files.** This supersedes BOTH this plan's original `869 / 670 / 80` on fc9e936 and the intermediate `877 / 670 / 82` on 5e48187: Wave 1's nine commits took unit 869 → 877 (7e769c1 added tests to tests/lib/llm-index.test.ts, 80fc4ab/20fc4fc took tests/lib/worker-health.test.ts 30 → 35) and integration 80 → 82 (the new tests/integration/consumer-loss-epoch.test.ts, an 11th file), and Wave 2's v2k then took unit 877 → 888 and db 670 → 674. The v2k step is **+11, not the +10 its own plan predicted** — `npx vitest run tests/lib/sampling.test.ts tests/lib/calibration-sampling-drift.test.ts` prints `Tests 11 passed (11)` (sampling 2, drift 9, not 8). Every number below is derived from the measured 888/674/82, not from a plan's prediction. Executors still substitute the printed actuals into the commit body, and treat any unexplained delta from the Expected line as a finding (failure mode 15) rather than as noise.
- Before EVERY db or integration gate: `pgrep -af "[v]itest"` must print nothing (the bracket keeps pgrep from matching its own command line). The local `judge_arena_test` database is shared and the db suite is NOT concurrency-safe — a sibling run makes tests/db/calibration-link.test.ts fail 7/13 with `40P01 deadlock detected`, which is a fixture collision, not a defect in this change.
- TDD with an INJECTION step (CONTRIBUTING.md:210-234): every behaviour test must be shown to go RED by a deliberate breakage of the implementation and GREEN again after; a test that stays green after injection is a finding. Each task's steps must include the injection.
- One concern per commit/PR (CONTRIBUTING.md:1639 — PR guideline 1; Wave 1's CONTRIBUTING rewrite moved it from :1560). Wrong statements in docs get an explicit CORRECTION note, never a silent overwrite (CONTRIBUTING.md:1653-1656 — PR guideline 8; moved from :1571-1574, which is now the coverage-thresholds paragraph).
- Commit subject: `type(scope): lowercase summary` (feat/fix/docs/ci; scopes seen: worker, llm, queue, calibration, ci, docker). Body: narrative, then a `Gates: lint 0, tsc 0, <n> unit / <n> db / <n> integration, coverage 0.` line, then EXACTLY these trailers:
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
- Commit LOCALLY only. Never push, never promote; the operator does that (push-to-main fires CI and builds an image; promotion is a separate homelab-setup PR).
- Migration naming: `prisma/migrations/<YYYYMMDDHHMMSS>_v2<letter>_<snake>/migration.sql`, timestamp must sort after **20260901180000 (v2k, which is landed AND applied to the local test DB)** — the letter after v2k is **v2l**, and any timestamp ≤ 20260901180000 collides; narrative `-- v2x — ...` header in the v2i/v2j style; ZERO hand edits (content must equal what `prisma migrate diff` emits), then `npx prisma generate`. The chosen `20260901190000_v2l_calibration_constant_baseline` satisfies both.
- Doc CORRECTION / DONE notes carry the date they LAND, not the date this plan was written. They are written `2026-09-02` below; if execution slips to another day, stamp that day instead. (Back-dating a note is the one thing the convention exists to prevent.)
- GREP TRAP live in HEAD: /root/judge-arena/src/lib/calibration/readings.ts:164 and /root/judge-arena/scripts/importer/reconcile.ts:547 contain a deliberate NUL byte; plain grep returns nothing for those files. Use `grep -a`. NEVER remove the NUL.
- Production is sha-d21f31d47c35; main is `33b7be4`, fifteen commits ahead of it — the original 4 docs-only ones, plus Wave 1's nine (below) and Wave 2's two (`a96cf94` extracting `src/lib/llm/sampling.ts`, `33b7be4` landing v2k), which are NOT docs-only: 7e769c1 (timeout ProviderError escapes withRetry — `src/lib/llm/index.ts`, and `src/lib/llm/resilience.ts` now EXPORTS `defaultIsRetryable`), five CI commits (new `scripts/ci/assert-harbor-tag.sh`, `scripts/ci/ci-status.sh`), and the consumer-loss fail-fast trio 80fc4ab/20fc4fc/5e48187 (`src/worker/health.ts` +143, `src/worker/main.ts`). Do not touch homelab-setup from a judge-arena task except where the plan explicitly says "separate PR in /root/homelab-setup".
- Any cluster/DB access in a plan step is READ-ONLY (psql SELECT, kubectl get/logs, rabbitmqctl list_queues). No requeue-peeks of judge.dlq (quorum delivery_limit 20 — every peek burns one).

---

## Facts verified against HEAD fc9e936 on 2026-09-01, RE-VERIFIED line by line against HEAD `33b7be4` on 2026-09-02 — after Wave 1's nine commits AND Wave 2's `a96cf94`/`33b7be4` (re-verify before editing; they drift)

| fact | where |
|---|---|
| `score.ts` accumulators are :214-223 (`verdictDistribution` :214, `confusion` init :215-219, `disagreements`/`correctCount`/`verdictCount` :221-223); the scoring loop is :225-257 with the null-verdict gate at :236, `const expected = row.expected as Preference;` at :241, `confusion[expected][actual] += 1;` at :242; `accuracy` :259; `agreement()` :260; result object :262-283; `calibrationRun.update` :285-310 with `verdictCount,` at :293 | `cat -n src/lib/calibration/score.ts` |
| `CalibrationScore` is :93-124; its last field is `method: AgreementMethod;` at :123 | same |
| `readings.ts` exports `type Preference = 'A>B' \| 'B>A' \| 'tie'` at :64 and `PREFERENCES: readonly Preference[] = ['A>B', 'B>A', 'tie']` at :70; its ONLY import is `import type { Reading } from '@/lib/agreement';` at :48 (type-only, erased) — so a module importing only from it drags nothing into any coverage denominator | `grep -a -n 'import\|PREFERENCES\|type Preference' src/lib/calibration/readings.ts` |
| `groundTruthReadings` (:156-253) THROWS on a null key (:191-201) and on a key outside PREFERENCES (:203-218) — `'tie'` passes. So `keyCounts` in `score.ts` can be typed `Record<Preference, number>` with no existence check: every `expected` reaching the loop is one of the three | read |
| No test anywhere exercises a `'tie'` answer KEY (`grep -rn "expected: 'tie'" tests src` → nothing). `tests/lib/calibration-score.test.ts` has 19 `it(` blocks; `GROUND_TRUTH` (:22-25) is `'A>B'` at indices 0-16 and `'B>A'` at 17-29; `calibration()` (:114-136) takes `{ order, missingAt, pendingAt }`; `fakeClient()` (:68-110) captures every `update` `data` in `updates` and merges it into `row`; `withFlips(3)` (:141-155) flips indices 0,1,2 and 17,18,19 | read |
| `pendingAt` rows are filtered OUT by the fake's `status: 'completed'` filter (never reach the loop); `missingAt` rows REACH the loop with `verdict: null` and are stopped by the :236 gate. The two shapes discriminate different injections (Task 2 Step 5) | fakeClient :90-96, calibration :129-132 |
| The only caller of `scoreCalibrationRun` outside tests is `scripts/calibration/run.ts:274`; the only print of `score.accuracy` is **:277** (kappa :278, itemCount :279, the `missingVerdicts` warning :280-282); `fmt(n: number \| null, digits = 4)` is **:69-71**; the script's header bullet list is :13-27 and the accuracy bullet is :14-15; `--score-only`'s "no such run" guard is **:169** (`throw new Error(\`No CalibrationRun ${id}.\`)`, v2k) | `grep -n 'ACCURACY\|fmt\|No CalibrationRun' scripts/calibration/run.ts` |
| `scripts/calibration/**` is outside every coverage `include` (vitest.config.ts:37) and has no test harness; `src/lib/calibration/**` has NO per-glob floor (vitest.config.ts:187-220) — only the aggregate 43/63/87/43 applies to the new module, which the Task 1 tests cover fully | read |
| `prisma/schema.prisma` `CalibrationRun` is :903-952 (v2k appended a 17-line doc block plus `samplingParams Json?` at :937, so it is 17 lines longer than this plan first recorded); `rawAgreement        Float?` is still :910 and `grep -c` returns 1, so Step 3's replace is unambiguous. **`samplingParams` already EXISTS — do not re-add it, and read run config from this header rather than joining to `JudgeModelVersion.samplingDefaults`.** Prisma renders `Float?` as `DOUBLE PRECISION` (`20260725012218_v2_meta_eval/migration.sql:47-48` for `kappa`/`rawAgreement`) | grep |
| `tests/db/meta-eval.test.ts:262-273` is the CalibrationRun-defaults test (`verdictCount` 0, `passed` null, `finishedAt` null); fixtures `mkGoldenSet()` and `mkJudgeModelVersion()` are file-local (`mkJudgeModelVersion` :13-31, `mkGoldenSet` :58-70). No `tests/db/**` file calls `scoreCalibrationRun`, so the stored value is pinned by the unit suite (the fake captures `update.data`) and the column's existence/type by the db suite | read |
| `.env.test` DATABASE_URL == TEST_DATABASE_URL == `postgresql://judge_arena:***@localhost:5432/judge_arena_test`; podman `judge-arena-pg` is the target of `npm run test:db`'s reset | grep |
| The docs' "verdicts"/"n" column is inconsistent: handoff :83 and spec :49 show `15/25` for run 9 (= correct/verdictCount) where every other row is verdictCount/items (spec :41 `26/30`, :47 `15/30`). Under the table's own convention run 9 is `25/30` | read |
| Runbook §7.1 block (:284-288) prints `method {"variant":"cohen","weighting":"none"}` but `run.ts:262` prints `JSON.stringify(score.method)` whose shape is `{statistic, weighting, annotatorCount, itemCount, categories}` (`score.ts:276-282`, `agreement.ts:60-68`); `categories` is the lexicographically sorted union of both raters' categories (`agreement.ts:88-95`) | read |
| Commit precedent `cb2fc37` quotes real CLI output, states the cause, gives the injection result `(1 failed / 18 passed)` and a `Gates:` line | `git show cb2fc37` |
| v2k IS landed. Its unit contribution is **+11, not the +10 its plan predicted**: `tests/lib/sampling.test.ts` is 2 and `tests/lib/calibration-sampling-drift.test.ts` is **9** (not 8). Its db contribution is +4 (`tests/db/calibration-link.test.ts` 13 → 17) and integration +0. **Measured start for this plan: 888 unit / 57 files, 674 db / 46 files, 82 integration / 11 files**; test DB at `20260901180000_v2k_calibration_sampling_snapshot` | `npx vitest run tests/lib/sampling.test.ts tests/lib/calibration-sampling-drift.test.ts` → `Tests 11 passed (11)`; full suites measured 2026-09-02 |
| Wave 2's `a96cf94` moved `SamplingParams` / `effectiveSamplingParams` / the two default constants OUT of `src/lib/llm/registry.ts` into the leaf `src/lib/llm/sampling.ts` (registry imports at :94 and re-exports at :422-423). Nothing in THIS plan imports any of them — but if a step is ever added that does, import from `@/lib/llm/sampling`, never the registry or the barrel, or `scripts/calibration/run.ts`'s esbuild bundle regains the Anthropic SDK and redis | `grep -a -n 'sampling' src/lib/llm/registry.ts` |

---

### Task 1: The pure floor — `src/lib/calibration/baseline.ts`

**Files:**
- Create: `src/lib/calibration/baseline.ts`
- Test: `tests/lib/calibration-baseline.test.ts` (new, DB-free, no mocks)

**Interfaces:**
- Consumes: `PREFERENCES` and `type Preference` from `'@/lib/calibration/readings'` (readings.ts:64, :70) — nothing else.
- Produces (Task 2 imports these from `'@/lib/calibration/baseline'`):
  - `export type ConstantBaseline = { accuracy: number; preferences: Preference[]; keyCounts: Record<Preference, number>; denominator: number }`
  - `export function constantVerdictBaseline(keyCounts: Readonly<Record<Preference, number>>): ConstantBaseline | null` — `null` when the denominator is 0; throws `RangeError` on a negative, fractional, `NaN` or missing count; top-class ties are ALL reported, in `PREFERENCES` order, never broken.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/calibration-baseline.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { constantVerdictBaseline } from '@/lib/calibration/baseline';

/**
 * The constant-verdict floor: what a judge that stamps the key's plurality
 * class on EVERY scored item would score. Every oracle below is worked by
 * hand from the counts — the function is a division, and the value of the
 * test is in the cases where a wrong division looks plausible (a partial
 * run, a tie among top classes, a key that is all ties).
 */
describe('constantVerdictBaseline — the floor is max(key class) / denominator', () => {
  it('the target set (17/13/0) floors at A>B = 17/30 = 0.5667, fully populated, over a COPY of the input', () => {
    const input = { 'A>B': 17, 'B>A': 13, tie: 0 };
    const floor = constantVerdictBaseline(input);
    expect(floor).toEqual({
      accuracy: 17 / 30,
      preferences: ['A>B'],
      keyCounts: { 'A>B': 17, 'B>A': 13, tie: 0 },
      denominator: 30,
    });
    expect(floor?.accuracy).toBeCloseTo(0.5667, 4);
    // The docblock promises a copy, so pin it: returning the caller's live
    // accumulator would make the score object alias score.ts's loop state.
    expect(floor?.keyCounts).not.toBe(input);
  });

  it("run 9's scored subset (14/11/0) floors at 14/25 = 0.5600 — NOT the full set's 0.5667", () => {
    // The floor moves with the denominator. granite4.2:3b scored 25 of 30
    // (five lost to a repetition loop); the 25 it scored were keyed 14/11.
    const floor = constantVerdictBaseline({ 'A>B': 14, 'B>A': 11, tie: 0 });
    expect(floor?.accuracy).toBeCloseTo(0.56, 10);
    expect(floor?.denominator).toBe(25);
    expect(Math.abs((floor?.accuracy ?? 0) - 17 / 30)).toBeGreaterThan(0.005);
  });

  it('a two-way tie among top classes (12/12/6) reports BOTH, in PREFERENCES order, at 12/30', () => {
    // A tie-containing key is reachable through PATCH /api/golden-sets/[id]/items
    // (no vocabulary check on an unfrozen set). Picking the first class would
    // report the right number under a misleading label.
    const floor = constantVerdictBaseline({ 'A>B': 12, 'B>A': 12, tie: 6 });
    expect(floor?.preferences).toEqual(['A>B', 'B>A']);
    expect(floor?.accuracy).toBeCloseTo(0.4, 10);
  });

  it('the order is PREFERENCES order, not the input object\'s key order (12 tie / 12 B>A / 6 A>B)', () => {
    // Every other fixture in this file is already written in PREFERENCES order,
    // and so is score.ts's accumulator literal — so an implementation reading
    // `Object.keys(keyCounts)` would pass all of them. This one is deliberately
    // out of order: insertion order would report ['tie', 'B>A'].
    const floor = constantVerdictBaseline({ tie: 12, 'B>A': 12, 'A>B': 6 });
    expect(floor?.preferences).toEqual(['B>A', 'tie']);
    expect(floor?.keyCounts).toEqual({ 'A>B': 6, 'B>A': 12, tie: 12 });
    expect(floor?.accuracy).toBeCloseTo(0.4, 10);
  });

  it('a three-way tie (10/10/10) reports all three at 1/3', () => {
    const floor = constantVerdictBaseline({ 'A>B': 10, 'B>A': 10, tie: 10 });
    expect(floor?.preferences).toEqual(['A>B', 'B>A', 'tie']);
    expect(floor?.accuracy).toBeCloseTo(1 / 3, 10);
  });

  it('when ties are the plurality (5/5/20) the stamp is tie at 20/30 — nothing assumes A>B', () => {
    const floor = constantVerdictBaseline({ 'A>B': 5, 'B>A': 5, tie: 20 });
    expect(floor?.preferences).toEqual(['tie']);
    expect(floor?.accuracy).toBeCloseTo(20 / 30, 10);
  });

  it('a one-class key (30/0/0) floors at 1.0 — the case no judge can beat', () => {
    const floor = constantVerdictBaseline({ 'A>B': 30, 'B>A': 0, tie: 0 });
    expect(floor?.accuracy).toBe(1);
    expect(floor?.preferences).toEqual(['A>B']);
  });

  it('an empty key returns null, not 0 — nothing scored is not a floor of zero', () => {
    expect(constantVerdictBaseline({ 'A>B': 0, 'B>A': 0, tie: 0 })).toBeNull();
  });

  it('a negative count throws — a count is never negative, and clamping would hide the caller bug', () => {
    expect(() => constantVerdictBaseline({ 'A>B': -1, 'B>A': 13, tie: 0 })).toThrow(
      /non-negative integer/
    );
  });

  it('a fractional or missing count throws for the same reason', () => {
    expect(() => constantVerdictBaseline({ 'A>B': 16.5, 'B>A': 13, tie: 0 })).toThrow(
      /non-negative integer/
    );
    expect(() =>
      constantVerdictBaseline({ 'A>B': 17, 'B>A': 13 } as unknown as Record<'A>B' | 'B>A' | 'tie', number>)
    ).toThrow(/non-negative integer/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/judge-arena && npx vitest run tests/lib/calibration-baseline.test.ts`
Expected: FAIL — the whole file errors at import with `Failed to resolve import "@/lib/calibration/baseline"` (or `Failed to load url @/lib/calibration/baseline`); 0 tests run.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/calibration/baseline.ts`:

```ts
/**
 * ─── A2.1: the constant-verdict floor, per denominator ──────────────────────
 *
 * WHAT A STAMP SCORES. A judge that answers the same preference on every item
 * is right exactly as often as that preference appears in the answer key. On
 * the target set (17 'A>B' / 13 'B>A') that is 0.5667 — a number that reads
 * as "a bit better than a coin flip" and is nothing of the kind. Until
 * v2l that figure lived only in prose (score.ts's header, the runbook,
 * the spec), and granite4.1:3b's 0.5000 was read as a faint signal when it
 * was WORSE than not thinking. Nothing on screen said so because nothing
 * computed the floor. This module does, and score.ts stores it beside the
 * accuracy it floors.
 *
 * THE FLOOR MOVES WITH THE DENOMINATOR. A partial run's scored subset has its
 * own key marginal: run 9 scored 25 of 30 items, keyed 14/11, so its floor is
 * 0.5600 rather than 0.5667. Comparing a partial run against the whole set's
 * floor flatters it — which is why the input here is the key counted OVER THE
 * SCORED ITEMS ONLY (score.ts accumulates it past the same null-verdict gate
 * as `verdictCount`), and why a leaderboard cannot compute this once and cache
 * it. Only the subset floor is ever reported; two floors on one line get the
 * wrong one quoted.
 *
 * TIES AMONG TOP CLASSES ARE REPORTED, NEVER BROKEN. A 12/12/6 key has two
 * best stamps at the same hit rate; naming only the first would print the
 * right number under a misleading label. `preferences` carries every class
 * that achieves the maximum, in PREFERENCES order. 'tie' is a class like the
 * other two: the import path rejects it, but PATCH /api/golden-sets/[id]/items
 * writes `expected` with no vocabulary check and readings.ts accepts it, so a
 * tie-keyed set is reachable and a 'tie' verdict against it is a hit.
 *
 * PURE, AND IMPORT-FREE BY DESIGN. Only the preference vocabulary comes from
 * readings.ts (whose sole import is type-only), so this runs in the DB-free
 * unit suite with no mock and drags nothing into any coverage denominator.
 */

import { PREFERENCES, type Preference } from '@/lib/calibration/readings';

export type ConstantBaseline = {
  /** Hit rate of the best constant verdict over the SCORED subset:
   *  max(keyCounts) / denominator. */
  accuracy: number;
  /** The constant(s) that achieve it, in PREFERENCES order. Length > 1 when the
   *  key's top classes tie; the accuracy is the same number either way. */
  preferences: Preference[];
  /** The answer key's marginal over the scored subset, fully populated over
   *  PREFERENCES (zeros included) — a copy, not the caller's object. */
  keyCounts: Record<Preference, number>;
  /** Sum of keyCounts. Must equal `CalibrationScore.verdictCount`. */
  denominator: number;
};

/**
 * The floor for a key with these class counts, or `null` when nothing has
 * been scored (mirrors `accuracy`'s null-not-0 rule in score.ts: 0 would read
 * as "the stamp was never right", which is a measurement, and "nothing has
 * been scored" is not).
 *
 * Throws on a negative, fractional, NaN or missing count. A count is never
 * any of those; a defensive clamp would turn a caller bug into a plausible
 * number.
 */
export function constantVerdictBaseline(
  keyCounts: Readonly<Record<Preference, number>>
): ConstantBaseline | null {
  let denominator = 0;
  let best = 0;
  for (const preference of PREFERENCES) {
    const n = keyCounts[preference];
    if (!Number.isInteger(n) || n < 0) {
      throw new RangeError(
        `constantVerdictBaseline: keyCounts[${JSON.stringify(preference)}] is ${String(n)}; ` +
          `a class count is a non-negative integer`
      );
    }
    denominator += n;
    if (n > best) best = n;
  }
  if (denominator === 0) return null;

  return {
    accuracy: best / denominator,
    preferences: PREFERENCES.filter((preference) => keyCounts[preference] === best),
    keyCounts: Object.fromEntries(
      PREFERENCES.map((preference) => [preference, keyCounts[preference]])
    ) as Record<Preference, number>,
    denominator,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /root/judge-arena && npx vitest run tests/lib/calibration-baseline.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5: Injection — five breakages, each must go red, then restore**

(a) Break the tie rule. In `baseline.ts` replace
```ts
    preferences: PREFERENCES.filter((preference) => keyCounts[preference] === best),
```
with
```ts
    preferences: [PREFERENCES.find((preference) => keyCounts[preference] === best) as Preference],
```
Run: `npx vitest run tests/lib/calibration-baseline.test.ts`
Expected: FAIL — 3 failed / 7 passed (`a two-way tie …`, `the order is PREFERENCES order …` and `a three-way tie …`: `expected [ 'A>B' ] to deeply equal [ 'A>B', 'B>A' ]` and, for the out-of-order case, `expected [ 'B>A' ] to deeply equal [ 'B>A', 'tie' ]`). Restore.

(b) Break the null rule. Replace `if (denominator === 0) return null;` with `if (denominator === 0) denominator = 1;`
Run: same command.
Expected: FAIL — 1 failed / 9 passed (`an empty key returns null …`: `expected { accuracy: 0, … } to be null`). Restore.

(c) Break the guard. Replace `if (!Number.isInteger(n) || n < 0) {` with `if (false) {`
Run: same command.
Expected: FAIL — 2 failed / 8 passed (the two `throws` cases: `expected [Function] to throw error matching /non-negative integer/`). Restore.

(d) Break the copy. Replace
```ts
    keyCounts: Object.fromEntries(
      PREFERENCES.map((preference) => [preference, keyCounts[preference]])
    ) as Record<Preference, number>,
```
with `keyCounts: keyCounts as Record<Preference, number>,` (this compiles — `readonly` modifiers do not affect assignability — which is exactly why the assertion, not tsc, is the guard).
Run: same command.
Expected: FAIL — 1 failed / 9 passed (`the target set (17/13/0) floors …`: `expected { 'A>B': 17, … } not to be { 'A>B': 17, … }` — same reference). Restore.

(e) Break the ORDER without breaking the tie rule. Replace
```ts
    preferences: PREFERENCES.filter((preference) => keyCounts[preference] === best),
```
with
```ts
    preferences: (Object.keys(keyCounts) as Preference[]).filter((p) => keyCounts[p] === best),
```
Run: same command.
Expected: FAIL — 1 failed / 9 passed (`the order is PREFERENCES order …`: `expected [ 'tie', 'B>A' ] to deeply equal [ 'B>A', 'tie' ]`). Every other fixture is already written in PREFERENCES order, which is exactly why that one case exists — without it this injection leaves the suite green while the docblock's "in PREFERENCES order, never broken" becomes false. Restore.

After restoring: `npx vitest run tests/lib/calibration-baseline.test.ts` → 10 passed.

- [ ] **Step 6: Gates**

```bash
pgrep -af "[v]itest"   # must print NOTHING before the db/integration gates
grep DATABASE_URL /root/judge-arena/.env.test     # localhost:5432/judge_arena_test
cd /root/judge-arena && npm run lint && npx tsc --noEmit && npm run test:coverage && npm run test:db:coverage && npm run test:integration && npm run build
```
Expected: lint 0; tsc 0; unit **898 tests / 58 files** (the measured 888 + this task's 10); db **674**; integration **82**; build OK; the unit aggregate floors 43/63/87/43 hold (no per-glob entry for `src/lib/calibration/**`, so only the aggregate applies).

**Read the printed coverage tables; do not predict them.** Two things here are measurements, not arithmetic:

1. `src/lib/calibration/baseline.ts`'s own row in the UNIT run. Record what the table prints; do not write "100%" into the commit body unless it says so. (The caveat bites hardest in Task 3, whose formatter guard is a three-operand `||` that short-circuits on its only null fixture — whether v8 scores every operand's outcome is a fact about the tool, not about the plan.)
2. The `All files` row of the FIRST `npm run test:db:coverage`. Write it down; Task 2 Step 11 and Task 3 Step 13 compare against THAT row, not against the actuals in the comment at vitest.db.config.ts:141 — those were recorded on 2026-08-13 at "444 tests, 35 files" and the suite is now 674 tests / 46 files, so the buffers computed from them (2.55pp statements/lines, 3.19pp functions, 2.59pp branches under the floors 47/60/77/47 at vitest.db.config.ts:149-153) are a ~230-test-stale point estimate.

The db aggregate WILL tick down: `coverage.all` defaults to true and the db config's `src/lib/**` include counts `baseline.ts` at 0% because no db test imports it. Measured denominators in today's `coverage-db/lcov.info` are **1286 branches and 420 functions**, so this module is worth roughly **0.5-1.1pp on branches/functions** — an order of magnitude more than "a fraction of a percentage point", and it lands twice (here, and again when Task 3 grows the file). The floors still hold with >1.5pp to spare; expect ~1pp and do not read it as a regression. **NEVER lower a floor.** If one is ever genuinely threatened, the remedy is a `tests/db/**` test that calls `scoreCalibrationRun` against the live client — NOT the unit-config mock at tests/lib/judgment-consumer-escalation.test.ts:41-69, which cannot move a number produced by `coverage.all` counting an unimported file.

Why the whole chain runs for a commit that adds one pure module: the commit body carries a `Gates:` line with db and integration counts and the Global Constraints forbid writing a number that was not measured. Of the four, `npm run test:db:coverage` is the load-bearing one (it is the only run that can prove no db floor broke). `npm run test:integration` and `npm run build` are convention here and nothing more — `vitest.integration.config.ts` has no `coverage` block at all (27 lines, `include: ['tests/integration/**/*.test.ts']`), so there is no integration denominator a new `src/lib` file could move. Keep them for the `Gates:` line; do not "optimise" the db run away instead.

- [ ] **Step 7: Commit**

```bash
git -C /root/judge-arena add src/lib/calibration/baseline.ts tests/lib/calibration-baseline.test.ts
git -C /root/judge-arena status --short
```
Expected: exactly the two new paths staged (`A`).

```bash
git -C /root/judge-arena commit -F - <<'EOF'
feat(calibration): the constant-verdict floor as a pure function, per denominator

A judge that stamps the key's plurality class on every item scores
max(class count)/n. On the target set that is 17/30 = 0.5667, and the
number lived only in prose — score.ts's header, the runbook, the spec —
so granite4.1:3b's 0.5000 read as a faint signal when it was worse than
a stamp. Nothing on screen said so because nothing computed the floor.

src/lib/calibration/baseline.ts computes it from the key's class counts
OVER THE SCORED SUBSET, because the floor moves with the denominator:
run 9 scored 25 of 30 items keyed 14/11, a floor of 0.5600, not 0.5667.
Ties among top classes are reported in PREFERENCES order and never
broken (12/12/6 names both), 'tie' is a class like the other two (a
tie key is reachable through PATCH /api/golden-sets/[id]/items), an
empty key returns null rather than 0, and a negative or fractional
count throws rather than being clamped into a plausible number.

The module imports only the preference vocabulary from readings.ts
(whose sole import is type-only), so it runs in the DB-free suite with
no mock and enters only the aggregate coverage denominator. (Substitute
the module's actual row from the printed unit coverage table here — a
predicted percentage is not a measurement.)

Injections, per the house rule: breaking the tie rule to "first class"
turns 3 red (the two tie cases and the out-of-order one); clamping the
empty key to 1 turns 1 red; removing the guard turns 2 red; returning
the caller's object instead of a copy turns 1 red while tsc stays
green; and reading Object.keys(keyCounts) instead of PREFERENCES turns
exactly 1 red — the deliberately out-of-order fixture, the only one
that can tell insertion order from PREFERENCES order. Restored clean,
10 passed.

Not wired into score.ts yet — that is the next commit, with the column.

Gates: lint 0, tsc 0, 898 unit / 674 db / 82 integration, coverage 0.
No schema change.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
EOF
```

---

### Task 2: v2l column, `score.ts` wiring, unit + db tests

**HARD PRECONDITION — v2k must have landed.** It HAS (`33b7be4`), so this is a re-check, not a gate you expect to fail. Check the ARTIFACT, not a log message:

```bash
ls -d /root/judge-arena/prisma/migrations/20260901180000_v2k_calibration_sampling_snapshot
git -C /root/judge-arena log --oneline -1 -- prisma/migrations/20260901180000_v2k_calibration_sampling_snapshot
```
Expected: the directory path, then one commit line (`33b7be4 feat(calibration): v2k — the run snapshots the sampling config it ran under`). If the `ls` fails, STOP: the migration letter, the `prisma migrate diff` baseline in Step 4 and Task 3 Step 8's `--score-only` guard all assume v2k is in the tree, and there is no defined fallback.

> **Do NOT use `git log --oneline | grep v2k_calibration_sampling_snapshot`** — an earlier revision of this plan did, and it is a check that cannot pass on ANY tree. `--oneline` prints SHA + subject only, and the migration directory name never appears in a commit subject (v2k's subject is `feat(calibration): v2k — the run snapshots the sampling config it ran under`). Run on the correct tree it exits 1 with no output, so it reports "v2k missing" for both the present and the absent case and would have halted Task 2 on fully correct work. Step 3's `_prisma_migrations` query stays as the second, independent confirmation — that one is about the test DATABASE, which is a different fact.

**Files:**
- Modify: `prisma/schema.prisma:910` (insert the column after `rawAgreement        Float?`)
- Create: `prisma/migrations/20260901190000_v2l_calibration_constant_baseline/migration.sql`
- Modify: `src/lib/calibration/score.ts:27-41` (header prose), `:61` (import), `:123` (type), `:219` (accumulator), `:241-242` (increment), `:260` (compute), `:275` (result), `:293` (update data)
- Test: `tests/lib/calibration-score.test.ts` (new describe block inserted after :299); `tests/db/meta-eval.test.ts` (new `it` after :273)

**Interfaces:**
- Consumes: `constantVerdictBaseline`, `type ConstantBaseline` from `'@/lib/calibration/baseline'` (Task 1); `type Preference` (already imported in score.ts:68).
- Produces:
  - `CalibrationScore.constantBaseline: ConstantBaseline | null` and `CalibrationScore.marginOverConstant: number | null` (both `null` exactly when `accuracy` is) — read by Task 3.
  - Prisma: `CalibrationRun.constantBaselineAccuracy: Float?` (client type `number | null`), written by `scoreCalibrationRun` in the same update as `rawAgreement`.

- [ ] **Step 1: Write the failing unit tests**

In `tests/lib/calibration-score.test.ts`, find the block closing at lines 296-299 —

```ts
    expect(client.row.rawAgreement).toBeNull();
    expect(client.row.kappa).toBeNull();
  });
});
```

— and insert IMMEDIATELY AFTER it (before `describe('scoreCalibrationRun — what lands on the CalibrationRun row'`):

```ts

describe('scoreCalibrationRun — the constant-verdict floor, per denominator', () => {
  /** Minimal stand-in for hand-built rows — the `calibration()` builder cannot
   *  express a 'tie' KEY or a hand-picked key balance. It ENFORCES the two
   *  filters the query relies on (`where.calibrationRunId` and the nested
   *  `status: 'completed'` on modelJudgments) for the same reason `fakeClient`
   *  above does (its docblock, :54-67): enforcing them here means a scorer that
   *  drops one fails a BEHAVIOUR test, where a fake that ignored them would let
   *  these three cases pass a shape test. `orderBy` is deliberately NOT honoured
   *  — every fixture below is handed in index order, and the ordering clause is
   *  already pinned by `fakeClient`'s own test. Captures every update's data. */
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/judge-arena && npx vitest run tests/lib/calibration-score.test.ts`
Expected: FAIL — **11 failed / 19 passed** (all eleven new cases; the 19 pre-existing ones stay green). The first new case fails with `expected undefined to deeply equal { accuracy: 0.5666…, … }` (no `constantBaseline` on the score yet); `the row carries the floor …` fails with `expected undefined to be closeTo 0.56` (nothing writes `constantBaselineAccuracy` yet); `nothing scored → …` fails because `expect(undefined).toBeNull()` fails (only `toBeNull` discriminates `undefined` — `toEqual(undefined)` and `toBe(undefined)` both PASS, which is why the pairOrder-BA case carries an absolute oracle rather than only comparing itself to the AB run). `npx tsc --noEmit` also fails on `score.constantBaseline` — the type has no such property — which is the same red.

- [ ] **Step 3: Confirm the test database is at v2k, then edit the schema**

The migration SQL must be generated by diffing the schema against a database that already carries v2k, or the diff will emit v2k's column too. Confirm, and if the test DB is behind, replay the chain once first:

```bash
grep DATABASE_URL /root/judge-arena/.env.test     # must be localhost:5432/judge_arena_test
cd /root/judge-arena && sh -c 'set -a; . ./.env.test; set +a; psql "$TEST_DATABASE_URL" -Atc "select migration_name from _prisma_migrations order by finished_at desc limit 1"'
```
Expected: `20260901180000_v2k_calibration_sampling_snapshot`. If it prints `20260901000000_v2j_queue_lanes`, run `npm run test:db` once (it resets the local test DB through every committed migration, v2k included) and re-check. If `psql` is not on PATH, `sh -c 'set -a; . ./.env.test; set +a; npx prisma migrate status'` lists the applied migrations instead — the last name must be v2k and the output must say the database schema is up to date.

Then in `prisma/schema.prisma`, replace line 910 —

```prisma
  rawAgreement        Float?
```

— with:

```prisma
  rawAgreement        Float?
  /// The constant-verdict floor beside the number it floors (v2l): the hit
  /// rate of a judge stamping the answer key's plurality class on every
  /// SCORED item — max(key class)/verdictCount over the scored subset, never
  /// over the whole set (run 9 scored 25 of 30 keyed 14/11: 0.5600, not the
  /// full key's 0.5667). Written by score.ts in the same full-overwrite update
  /// as rawAgreement so re-scoring after a drain moves both together; the pure
  /// function in src/lib/calibration/baseline.ts is the source of truth and
  /// this is its stored copy for readers that never load the module (the
  /// handoff §8 scoreboard SQL). NULL means "not scored since v2l" — the 9
  /// production rows stay NULL until each is re-scored with --score-only.
  constantBaselineAccuracy Float?
```

(`rawAgreement        Float?` appears once in the file — the replace is unambiguous.) The new field name is 24 characters, wider than this block's alignment column, so the pasted line will not line up with its siblings. Leave it as written and do NOT run `npx prisma format`: it would re-align every field in `CalibrationRun` and put an unrelated whitespace diff in this commit, breaking one concern per commit. Only `npx prisma generate` (Step 4) is run.

- [ ] **Step 4: Generate the migration SQL — zero hand edits**

```bash
cd /root/judge-arena && sh -c 'set -a; . ./.env.test; set +a; npx prisma migrate diff --from-url "$TEST_DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script' | tee /tmp/v2l-diff.sql
```
Expected output, exactly:
```sql
-- AlterTable
ALTER TABLE "CalibrationRun" ADD COLUMN     "constantBaselineAccuracy" DOUBLE PRECISION;
```
If anything else appears (a `samplingParams` line means the test DB was not at v2k — go back to Step 3), stop. Assert that rather than eyeballing it, because the diff two commands below cannot see it:

```bash
[ "$(grep -c 'ADD COLUMN' /tmp/v2l-diff.sql)" = 1 ] && ! grep -q samplingParams /tmp/v2l-diff.sql && echo "one additive column, no v2k residue"
```
Expected: `one additive column, no v2k residue`. (This is the check that discriminates. If the test DB were at v2j, `/tmp/v2l-diff.sql` would carry BOTH `ADD COLUMN "samplingParams"` and `ADD COLUMN "constantBaselineAccuracy"` and the byte-identity diff below would still print `SQL identical to migrate diff`, because that diff compares the migration file against the file it was just `cat`-ed from — it is guaranteed to pass by construction. Its only real job is catching a stray non-comment line typed into the heredoc header. `npm run test:db` in Step 9 would eventually catch the v2j case too, by replaying v2k then v2l and having Postgres reject the duplicate column — but two steps later and with a confusing error.)

Create the migration from the header plus the diff verbatim:

```bash
cd /root/judge-arena && mkdir -p prisma/migrations/20260901190000_v2l_calibration_constant_baseline && cat > prisma/migrations/20260901190000_v2l_calibration_constant_baseline/migration.sql <<'EOF'
-- v2l — CalibrationRun stores the constant-verdict floor beside rawAgreement
--
-- rawAgreement IS accuracy (the column predates A2.1 and the name is inherited).
-- Read on its own it cannot tell a judge that learned something from a judge
-- that stamps the same preference on every item: on the target set that stamp
-- scores 17/30 = 0.5667, and granite4.1:3b's 0.5000 was read as a faint signal
-- when it was WORSE than not thinking. The floor was stated in prose (score.ts,
-- the runbook, the scoreboard spec) and computed nowhere.
--
-- WHY A COLUMN AND NOT A PROJECTION. The floor's inputs are immutable once a
-- run drains (the key is frozen with the set; a completed verdict is never
-- rewritten), so it IS reconstructible on read — but so are rawAgreement and
-- kappa, and both are stored here because this header is what the board reads.
-- The only scoreboard that exists today is SQL against this table (handoff §8
-- step 3), and without a column that query cannot put the floor beside the
-- number it floors, which is the entire point. score.ts writes it in the SAME
-- full-overwrite update as rawAgreement/verdictCount, so re-scoring after a
-- drain moves all three together; src/lib/calibration/baseline.ts stays the
-- source of truth.
--
-- PER DENOMINATOR, NOT PER SET. max(key class)/verdictCount over the SCORED
-- subset: run 9 scored 25 of 30 items keyed 14/11 — a floor of 0.5600, not the
-- full key's 0.5667. A value computed once per set and cached would flatter
-- every partial run.
--
-- ZERO HAND EDITS: what follows is byte-for-byte what `prisma migrate diff`
-- emitted (diffed against the test database at v2k). CONTRIBUTING's
-- pseudo-drift table stays at EIGHT rows.
--
-- ENTIRELY ADDITIVE: one nullable DOUBLE PRECISION column, no DROP, no DELETE,
-- no default, no backfill. NULL means "not scored since v2l": the 9 production
-- rows stay NULL until each is re-scored with --score-only on an image that
-- carries this migration — a deliberate operator action, never a migration
-- step, because scoring writes rawAgreement/kappa/finishedAt as well.

EOF
cat /tmp/v2l-diff.sql >> prisma/migrations/20260901190000_v2l_calibration_constant_baseline/migration.sql
diff <(grep -v '^--' prisma/migrations/20260901190000_v2l_calibration_constant_baseline/migration.sql | sed '/^$/d') <(grep -v '^--' /tmp/v2l-diff.sql | sed '/^$/d') && echo "SQL identical to migrate diff"
# The payload itself, asserted rather than compared to its own source:
diff <(grep -v '^--' prisma/migrations/20260901190000_v2l_calibration_constant_baseline/migration.sql | sed '/^$/d') - <<'EOF' && echo "payload is exactly the one ALTER"
ALTER TABLE "CalibrationRun" ADD COLUMN     "constantBaselineAccuracy" DOUBLE PRECISION;
EOF
npx prisma generate
```
Expected: `SQL identical to migrate diff`; `payload is exactly the one ALTER`; `prisma generate` succeeds. Re-run BOTH diffs after any later edit to the migration file — the first one is only meaningful at a moment other than immediately after the `cat`. (Note the doubled space in `ADD COLUMN     "constantBaselineAccuracy"`: that is what Prisma emits and what the file must contain byte for byte.)

- [ ] **Step 5: Wire `score.ts`**

Eight edits (a)-(h), nine string replacements — (g) is two — each anchored on unique text in `src/lib/calibration/score.ts`. All eight must be applied: stopping early leaves (h) or the result-object half of (g) undone, which is exactly injection (c) below (tsc stays green, two unit tests go red).

(a) Header prose. Replace lines 27-33 —
```ts
 * SO WHY COMPUTE IT AT ALL? Because accuracy alone cannot tell a judge that
 * learned something from a judge that answers 'A>B' every time. On the target
 * set that degenerate judge scores 0.5667 — comfortably "better than chance"
 * to the naked eye — and kappa scores it 0.0000, which is exactly right. The
 * two numbers fail in opposite directions, so both are stored, and
 * `kappaVariant`/`kappaWeighting` record what produced the second one. A
 * kappa with no stated method is a number nobody can check a year from now.
```
— with:
```ts
 * SO WHY COMPUTE IT AT ALL? Because accuracy alone cannot tell a judge that
 * learned something from a judge that answers 'A>B' every time. Kappa scores
 * that judge 0.0000, which is exactly right; the two numbers fail in opposite
 * directions, so both are stored, and `kappaVariant`/`kappaWeighting` record
 * what produced the second one. A kappa with no stated method is a number
 * nobody can check a year from now.
 *
 * ── THE CONSTANT FLOOR IS COMPUTED, NOT RECITED ────────────────────────────
 *
 * Until v2l this header SAID that the always-'A>B' judge scores 0.5667
 * on the target set, and nothing computed it — so granite4.1:3b's 0.5000 was
 * read as a weak signal when it was worse than a stamp. `constantBaseline`
 * (src/lib/calibration/baseline.ts) is now emitted beside `accuracy`, with
 * `marginOverConstant` = accuracy − floor, and the floor's accuracy is stored
 * as `CalibrationRun.constantBaselineAccuracy` (v2l) in the same overwrite as
 * `rawAgreement`, so the scoreboard SQL reads both from one row.
 *
 * THE FLOOR MOVES WITH THE DENOMINATOR. It is max(key class)/verdictCount over
 * the SCORED subset, not over the set: the full key is 17/13 (0.5667), but
 * run 9 scored 25 of 30 items whose key was 14/11 — a floor of 0.5600.
 * Comparing a partial run against the whole set's floor flatters it, which is
 * why `keyCounts` below is accumulated past the same null-verdict gate as
 * `verdictCount`, and why a leaderboard cannot compute this number once and
 * cache it.
```

(b) Tie paragraph. Replace lines 37-41 —
```ts
 * A 'tie' IS A MISS. The corpus has no ties (`GoldenItem.expected` is 'A>B'
 * or 'B>A' — golden-sets.ts rejects anything else at import), so there is no
 * item a tie could be right about. Crediting it as a partial hit, or dropping
 * it from the denominator, would both let a judge raise its score by refusing
 * to answer.
```
— with:
```ts
 * A 'tie' IS A MISS ON THIS CORPUS. The target set has no ties
 * (`GoldenItem.expected` is 'A>B' or 'B>A' — golden-sets.ts rejects anything
 * else at import), so there is no item a tie could be right about. Crediting
 * it as a partial hit, or dropping it from the denominator, would both let a
 * judge raise its score by refusing to answer. A tie KEY is nonetheless
 * reachable — PATCH /api/golden-sets/[id]/items writes `expected` with no
 * vocabulary check on an unfrozen set, and readings.ts accepts 'tie' — and
 * against such an item a 'tie' verdict is a hit by the same `actual ===
 * expected` rule below. The constant floor treats 'tie' as a class like the
 * other two for the same reason; do not "fix" either.
```

(c) Import. Replace line 61 —
```ts
import { agreement, type AgreementMethod } from '@/lib/agreement';
```
— with:
```ts
import { agreement, type AgreementMethod } from '@/lib/agreement';
import { constantVerdictBaseline, type ConstantBaseline } from '@/lib/calibration/baseline';
```

(d) Type. Replace lines 120-124 —
```ts
  /** What produced `kappa`. A kappa with no stated method cannot be checked
   *  later, and this is what gets mirrored onto the row's `kappaVariant` /
   *  `kappaWeighting`. */
  method: AgreementMethod;
};
```
— with:
```ts
  /** What produced `kappa`. A kappa with no stated method cannot be checked
   *  later, and this is what gets mirrored onto the row's `kappaVariant` /
   *  `kappaWeighting`. */
  method: AgreementMethod;
  /** The best constant verdict's hit rate over the SAME denominator as
   *  `accuracy` — max(key class)/verdictCount over the scored subset. `null`
   *  exactly when `accuracy` is. Computed per scoring because the floor moves
   *  with the denominator (17/30 = 0.5667 on the full set; 14/25 = 0.5600 on
   *  run 9's scored subset). Its `accuracy` is mirrored onto the row's
   *  `constantBaselineAccuracy`. */
  constantBaseline: ConstantBaseline | null;
  /** accuracy − constantBaseline.accuracy. Negative means the judge did worse
   *  than stamping. `null` when either side is. */
  marginOverConstant: number | null;
};
```

(e) Accumulator. Replace lines 216-219 —
```ts
  for (const expected of PREFERENCES) {
    confusion[expected] = {};
    for (const judged of PREFERENCES) confusion[expected][judged] = 0;
  }
```
— with:
```ts
  for (const expected of PREFERENCES) {
    confusion[expected] = {};
    for (const judged of PREFERENCES) confusion[expected][judged] = 0;
  }
  // The answer key's marginal over the SCORED subset — incremented past the
  // same null-verdict gate as `verdictCount`, so its sum IS `verdictCount`.
  // A separate accumulator rather than the confusion row sums, in this file's
  // own style (see the loop comment below): the test pins the two equal, and
  // a regression in either is a failure rather than one shared wrong answer.
  const keyCounts: Record<Preference, number> = { 'A>B': 0, 'B>A': 0, tie: 0 };
```

(f) Increment. Replace lines 241-242 —
```ts
    const expected = row.expected as Preference;
    confusion[expected][actual] += 1;
```
— with:
```ts
    const expected = row.expected as Preference;
    keyCounts[expected] += 1;
    confusion[expected][actual] += 1;
```

(g) Compute and return. Replace lines 259-260 —
```ts
  const accuracy = verdictCount === 0 ? null : correctCount / verdictCount;
  const result = agreement(projection.readings);
```
— with:
```ts
  const accuracy = verdictCount === 0 ? null : correctCount / verdictCount;
  const result = agreement(projection.readings);
  // Null exactly when `accuracy` is: both share the denominator.
  const constantBaseline = constantVerdictBaseline(keyCounts);
  const marginOverConstant =
    accuracy !== null && constantBaseline !== null ? accuracy - constantBaseline.accuracy : null;
```
and replace lines 273-275 —
```ts
    verdictDistribution,
    confusion,
    disagreements,
```
— with:
```ts
    verdictDistribution,
    confusion,
    disagreements,
    constantBaseline,
    marginOverConstant,
```

(h) Persist. Replace lines 291-293 —
```ts
      rawAgreement: accuracy,
      kappa: result.value,
      verdictCount,
```
— with:
```ts
      rawAgreement: accuracy,
      kappa: result.value,
      verdictCount,
      // The floor beside the number it floors, on the row the §8 scoreboard
      // SQL reads. Same full-overwrite rule as everything here: re-scoring
      // after a drain moves verdictCount and this moves with it. baseline.ts
      // is the source of truth; this is its stored copy.
      constantBaselineAccuracy: constantBaseline === null ? null : constantBaseline.accuracy,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd /root/judge-arena && npx tsc --noEmit && npx vitest run tests/lib/calibration-score.test.ts tests/lib/calibration-baseline.test.ts`
Expected: tsc 0; PASS — 30 + 10 = 40 tests (calibration-score.test.ts goes 19 → 30; the pre-existing 19, including the idempotence `toEqual(first)` at :343, stay green: the two new fields are deterministic).

- [ ] **Step 7: Injection — four breakages, each must go red, then restore**

(a) Count the key BEFORE the gate. In `score.ts`, remove the line `keyCounts[expected] += 1;` (added in 5f) and insert `keyCounts[row.expected as Preference] += 1;` immediately BEFORE `if (row.verdict === null) return;` (line 236).
Run: `npx vitest run tests/lib/calibration-score.test.ts`
Expected: FAIL — 2 failed / 28 passed: `a COMPLETED judgment with a null verdict is outside the floor's denominator too` (`keyCounts` 17/13, denominator 30 ≠ 25) and `keyCounts agree with the confusion matrix row sums …`. The `pendingAt` case stays GREEN under this injection — pending rows never reach the loop — which is exactly why the `missingAt` twin exists. Restore.

(b) Break the tie rule at the seam. In `baseline.ts` replace `preferences: PREFERENCES.filter((preference) => keyCounts[preference] === best),` with `preferences: ['A>B'],`.
Run: same command.
Expected: FAIL — 2 failed / 28 passed (`a tie-containing KEY …` expects `['tie']`; `a two-way tie …` expects `['A>B', 'B>A']`). Restore.

(c) Drop the column write. In `score.ts` delete the `constantBaselineAccuracy: …` line from the update data.
Run: same command.
Expected: FAIL — 2 failed / 28 passed (`nothing scored → … NULL (not 0) lands on the row`: `expected undefined to be null`; `the row carries the floor …`: `expected undefined to be 0.56`). `npx tsc --noEmit` stays clean under this injection (the field is optional in Prisma's update input), which is why the unit test exists. Restore.

(d) Swap the subtraction. In `score.ts` (5g) replace
```ts
    accuracy !== null && constantBaseline !== null ? accuracy - constantBaseline.accuracy : null;
```
with
```ts
    accuracy !== null && constantBaseline !== null ? constantBaseline.accuracy - accuracy : null;
```
Run: same command.
Expected: FAIL — 2 failed / 28 passed (`a judge that matches the key on all 30 clears the floor by 13/30 …`: `expected -0.4333… to be close to 0.4333…`; `a judge BELOW the floor reports a NEGATIVE margin …`: `expected 0.3333… to be close to -0.3333…` — the `toBeCloseTo` on the signed margin fails FIRST, so the `toBeLessThan(0)` line two below it never runs). Every OTHER margin in the file is exactly 0 and symmetric under the swap — which is why those two signed cases exist, and why lint, tsc and the `⚠` guard (which compares accuracies, not the margin) would all have stayed green without them. Restore.

After restoring: `npx vitest run tests/lib/calibration-score.test.ts` → 30 passed.

- [ ] **Step 8: Write the failing db test**

In `tests/db/meta-eval.test.ts`, find lines 262-273 —

```ts
  it('GoldenSet.visibility defaults to private; CalibrationRun.verdictCount defaults to 0', async () => {
    const goldenSet = await mkGoldenSet();
    expect(goldenSet.visibility).toBe('private');

    const judgeModelVersion = await mkJudgeModelVersion();
    const run = await db.calibrationRun.create({
      data: { judgeModelVersionId: judgeModelVersion.id, goldenSetId: goldenSet.id },
    });
    expect(run.verdictCount).toBe(0);
    expect(run.passed).toBeNull();
    expect(run.finishedAt).toBeNull();
  });
```

— and insert IMMEDIATELY AFTER it:

```ts

  it('CalibrationRun.constantBaselineAccuracy (v2l) defaults to NULL and round-trips a double', async () => {
    // NULL means "not scored since v2l" — never 0, which would read as "the
    // stamp was never right". No tests/db fixture drives scoreCalibrationRun
    // against a real Postgres (the unit suite pins the write through the fake
    // client's captured update data); this pins the column and its type.
    const goldenSet = await mkGoldenSet();
    const judgeModelVersion = await mkJudgeModelVersion();
    const run = await db.calibrationRun.create({
      data: { judgeModelVersionId: judgeModelVersion.id, goldenSetId: goldenSet.id },
    });
    expect(run.constantBaselineAccuracy).toBeNull();

    const scored = await db.calibrationRun.update({
      where: { id: run.id },
      data: { constantBaselineAccuracy: 14 / 25 },
    });
    expect(scored.constantBaselineAccuracy).toBeCloseTo(0.56, 12);
  });
```

- [ ] **Step 9: Run the full DB suite — this replays the migration chain including v2l (the real test of the migration file, CONTRIBUTING.md:726-730)**

```bash
pgrep -af "[v]itest"   # must print NOTHING — a concurrent run fakes deadlock failures in tests/db/calibration-link.test.ts
grep DATABASE_URL /root/judge-arena/.env.test     # localhost:5432/judge_arena_test — NOT judge-arena-pg-1
cd /root/judge-arena && npm run test:db
```
Expected: `prisma migrate reset` applies 22 migrations ending in `20260901190000_v2l_calibration_constant_baseline`; **675 tests pass** (674 + 1). Every pre-existing direct `db.calibrationRun.create` seed (golden-set-freeze, meta-eval, golden-sets, config-golden-sets, account-deletion, calibration-link) stays green — the column is nullable and none asserts a whole row.

- [ ] **Step 10: Injection for the db test — drop the column on the LOCAL test database only, then let the suite rebuild it**

This touches only `localhost:5432/judge_arena_test`, which `npm run test:db` recreates from scratch on every run. Never run this against `judge-arena-pg-1`.

```bash
cd /root/judge-arena && sh -c 'set -a; . ./.env.test; set +a; psql "$TEST_DATABASE_URL" -c "ALTER TABLE \"CalibrationRun\" DROP COLUMN \"constantBaselineAccuracy\";" && npx vitest run --config vitest.db.config.ts tests/db/meta-eval.test.ts'
```
Expected: FAIL — the new test errors with Prisma `P2022` (`The column \`CalibrationRun.constantBaselineAccuracy\` does not exist in the current database`) on the `create`'s returned select; the other meta-eval tests that create a CalibrationRun fail the same way, which is fine — the point is the new test is not decoration. Then:

```bash
cd /root/judge-arena && npm run test:db
```
Expected: reset re-applies all 22 migrations; 675 pass.

- [ ] **Step 11: Gates**

```bash
pgrep -af "[v]itest"   # must print NOTHING
grep DATABASE_URL /root/judge-arena/.env.test     # localhost:5432/judge_arena_test — NOT judge-arena-pg-1
cd /root/judge-arena && npm run lint && npx tsc --noEmit && npm run test:coverage && npm run test:db:coverage && npm run test:integration && npm run build
```
(The `.env.test` re-check is not redundant with Step 3's. This is a separate shell invocation and `test:db:coverage` runs `prisma migrate reset --force`; the whole point of handoff trap 1 — `judge-arena-pg` vs `judge-arena-pg-1`, one character apart — is that the earlier confirmation does not carry.)

Expected: lint 0; tsc 0; unit **909 tests / 58 files** (898 + 11); db **675**; integration **82**; build OK; every unit coverage floor holds (`src/lib/calibration/**` has no per-glob entry, so only the aggregate 43/63/87/43 applies).

The db run's aggregate (vitest.db.config.ts:149-153 — 47/60/77/47 over the same `src/lib/**` include, `coverage.all` defaulting to true) absorbs `baseline.ts` as an unimported file at 0%. **Compare the printed `All files` row against the one recorded in Task 1 Step 6, not against the 2026-08-13 comment at vitest.db.config.ts:141** (49.55 / 79.59 / 63.19 / 49.55 in that file's stmts/branch/funcs/lines order, measured at 444 tests / 35 files against today's 674 / 46). Against the measured denominators in `coverage-db/lcov.info` — 1286 branches, 420 functions — this module is worth roughly 0.5-1.1pp on branches and functions, not "a fraction of a percentage point"; vitest.db.config.ts:46-52 says as much in its own words ("one modestly-sized untested file moves the number by more than" a rounding tripwire). The floors hold with >1.5pp to spare. No floor moves; **never lower one.** If one is ever genuinely threatened the remedy is a `tests/db/**` test that calls `scoreCalibrationRun` against the live client — a unit-config mock like tests/lib/judgment-consumer-escalation.test.ts:41-69 cannot move a number produced by `coverage.all` counting a file no db test imports.

- [ ] **Step 12: Commit**

```bash
git -C /root/judge-arena add prisma/schema.prisma prisma/migrations/20260901190000_v2l_calibration_constant_baseline/migration.sql src/lib/calibration/score.ts tests/lib/calibration-score.test.ts tests/db/meta-eval.test.ts
git -C /root/judge-arena status --short
```
Expected: five paths staged (`A` for the migration, `M` for the rest), nothing else modified.

```bash
git -C /root/judge-arena commit -F - <<'EOF'
feat(calibration): v2l — score emits and stores the constant floor beside accuracy

scoreCalibrationRun now returns `constantBaseline` (the best constant
verdict's hit rate over the SAME denominator as accuracy, with the
class(es) that achieve it and the key's marginal over the scored
subset) and `marginOverConstant` = accuracy − floor, and writes the
floor's accuracy to CalibrationRun.constantBaselineAccuracy in the same
full-overwrite update as rawAgreement/verdictCount.

PER DENOMINATOR, because the floor moves with it. The key is counted by
a separate `keyCounts` accumulator incremented past the same
null-verdict gate as verdictCount — not read back out of the confusion
matrix — so a partial run's floor is over what it scored: 25 of 30
keyed 14/11 gives 0.5600, and the full set's 0.5667 would have
flattered it. The test that discriminates is the COMPLETED-but-null
verdict case: those rows reach the loop, and counting the key before
the gate turns it red while the pending case stays green.

STORED, not only computed, on the critique's ruling: the floor's inputs
are immutable once a run drains, but so are rawAgreement and kappa and
both live on this row because the header is what the board reads. The
only scoreboard that exists is SQL against CalibrationRun (handoff §8
step 3), and without the column that query cannot show the floor
beside the number it floors. Migration
20260901190000_v2l_calibration_constant_baseline is one nullable
DOUBLE PRECISION column, byte-identical to `prisma migrate diff`
against the test database at v2k; zero hand edits, pseudo-drift table
stays at eight rows. NULL means "not scored since v2l" — the 9
production rows stay NULL until each is re-scored with --score-only,
an operator action because scoring also rewrites rawAgreement/kappa.

First test in the repo of a 'tie' answer KEY: reachable through
PATCH /api/golden-sets/[id]/items (no vocabulary check on an unfrozen
set; readings.ts accepts 'tie'), a 'tie' verdict against it is a hit by
the existing `actual === expected` rule, and the floor can be 'tie'.
score.ts's header no longer claims a tie key is unreachable.

Injections: counting the key before the null-verdict gate → 2 red;
hard-coding preferences to ['A>B'] → 2 red (tie key, two-way tie);
deleting the column write → 2 red while tsc stays green (the field is
optional in the update input — which is why the unit test exists);
swapping the margin's subtraction to floor − accuracy → 2 red (the
perfect judge and the below-floor judge; every other margin here is 0
and symmetric, so those two signed cases are the only guard against a
CLI that prints every margin backwards); dropping the column on the
local test database → the db test dies on P2022. All restored clean:
30 + 10 unit, 675 db.

Gates: lint 0, tsc 0, 909 unit / 675 db / 82 integration, coverage 0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
EOF
```

---

### Task 3: CLI line, below-floor warning, and the docs that become true

**Why the strings live in `src/lib` and not in the script.** `scripts/calibration/**` is outside every coverage `include` (vitest.config.ts:37) and has no harness, so a `console.log` template built inside `run.ts` ships with no permanent test at all — the load-bearing part being the `<=` boundary, whose relaxation to `<` silences the warning on precisely the stamping judge it exists for. A throwaway smoke script cannot guard that: it is deleted in the same step that runs it. So the two rendered lines are a pure exported formatter in Task 1's module, unit-tested beside the floor itself, and `run.ts` only loops over what it returns. This is the shape the sibling v2k plan already uses for the same problem (`describeSamplingSnapshot` in `src/lib/calibration/sampling-drift.ts`, unit-tested in `tests/lib/calibration-sampling-drift.test.ts`, with `run.ts` print-only).

**Files:**
- Modify: `src/lib/calibration/baseline.ts` (append `formatConstantBaselineLines` + its local `fmt4`)
- Modify: `tests/lib/calibration-baseline.test.ts` (append one describe block, 5 cases; extend the import line)
- Modify: `scripts/calibration/run.ts:14-15` (the accuracy bullet, inside the `:13-27` header list; `:13` is the `WHAT IT PRINTS…` lead-in and is NOT replaced), the import block after `:53`, and `:277-278` (the ACCURACY/kappa lines, measured on `33b7be4`; anchor on text)
- Modify: `docs/runbooks/scoring-a-judge-against-a-golden-set.md:284-299` (§7.1 block + bullets), `:310-313` (§7.2 prose)
- Modify: `docs/superpowers/plans/2026-09-01-scoreboard-handoff.md`: after `:18` (the §0 "never computed" CORRECTION — see Step 10(a), this is the claim that becomes FALSE), `:83` (table ratio), after `:84` (the ratio CORRECTION, under the table), `:343-345` (§7 #2, measured on `33b7be4`), the §8 step-3 `SELECT` line (**:398**; v2k's rewritten comment block is :391-396 and the `kubectl` line is :397)
- Modify: `docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md:49` (table ratio), after `:49` (the ratio CORRECTION), after `:66` (the "landed" note under the floor paragraph)
- Modify: `docs/superpowers/plans/2026-08-30-state-and-next-steps.md`: after `:33` (the §0 headline's "the floor is never computed" — the second claim that becomes FALSE, Step 12(a)) and after `:436` (§5.6 #7, measured on `33b7be4`)

**Interfaces:**
- Consumes: `CalibrationScore.constantBaseline: ConstantBaseline | null`, `CalibrationScore.marginOverConstant: number | null`, `CalibrationScore.accuracy: number | null` (Task 2); `fmt(n: number | null, digits = 4): string` (run.ts:69-71, unchanged — it still renders ACCURACY and kappa).
- Produces: `export function formatConstantBaselineLines(score: { accuracy: number | null; constantBaseline: ConstantBaseline | null; marginOverConstant: number | null }): string[]` in `src/lib/calibration/baseline.ts` — the `constant` line, plus the `⚠` line when `accuracy <= floor.accuracy`; `[]` when nothing was scored. The parameter is a structural literal rather than `Pick<CalibrationScore, …>` on purpose: `score.ts` imports THIS module, so a type import back would close an import cycle. It is nonetheless satisfied by a whole `CalibrationScore`, which is how `run.ts` calls it.
- The CLI prints those lines on both the launch path and `--score-only` (same block).

- [ ] **Step 1: Read-only confirmation of run 9's stored numbers and scored-subset key (production, SELECT only)**

The docs below quote "run 9 scored 25 of 30, keyed 14/11, 0.6000 vs a 0.5600 floor". The 14/11 composition is a doc claim not re-verified in the mapping pass. Confirm it before quoting it in a commit body:

```bash
kubectl -n tenant-public exec judge-arena-pg-1 -c postgres -- psql -U postgres -d judge_arena -c "
  SELECT cr.id, cr.\"rawAgreement\" AS acc, cr.\"verdictCount\", gi.expected, count(mj.id) AS scored
    FROM \"CalibrationRun\" cr
    JOIN \"EvaluationRun\" er ON er.\"calibrationRunId\" = cr.id
    JOIN \"GoldenItem\" gi ON gi.id = er.\"goldenItemId\"
    JOIN \"ModelJudgment\" mj ON mj.\"runId\" = er.id AND mj.status = 'completed' AND mj.verdict IS NOT NULL
   WHERE cr.id LIKE 'cmtircx0x%'
   GROUP BY cr.id, cr.\"rawAgreement\", cr.\"verdictCount\", gi.expected
   ORDER BY gi.expected;"
kubectl -n tenant-public exec judge-arena-pg-1 -c postgres -- psql -U postgres -d judge_arena -c "
  SELECT mj.verdict, count(*)
    FROM \"CalibrationRun\" cr
    JOIN \"EvaluationRun\" er ON er.\"calibrationRunId\" = cr.id
    JOIN \"ModelJudgment\" mj ON mj.\"runId\" = er.id AND mj.status = 'completed'
   WHERE cr.id LIKE 'cmtircx0x%'
   GROUP BY mj.verdict ORDER BY mj.verdict;"
```
Expected: first query — two rows, `A>B | 14` and `B>A | 11`, with `acc 0.6` and `verdictCount 25`. Second query — the raw verdict distribution; note whether any `tie` row appears (it decides the `categories` array in Step 9's block: `["A>B","B>A"]` when no verdict is `tie`, `["A>B","B>A","tie"]` when one is — the sorted union of key and derived-preference classes, agreement.ts:88-95). If the first query does NOT give 14/11, the docs below must carry the numbers the query gave, and the commit body must say the doc claim was wrong — do not paper over it.

- [ ] **Step 2: Write the failing formatter tests**

In `tests/lib/calibration-baseline.test.ts`, extend the import line —
```ts
import { constantVerdictBaseline } from '@/lib/calibration/baseline';
```
— to:
```ts
import { constantVerdictBaseline, formatConstantBaselineLines } from '@/lib/calibration/baseline';
```

— and append, after the closing `});` of the existing describe block (end of file):

```ts

describe('formatConstantBaselineLines — the two CLI lines, pinned where a test can reach them', () => {
  /** scripts/calibration/** is outside every coverage include (vitest.config.ts:37)
   *  and has no harness, so a template literal built inside run.ts would ship
   *  with no permanent guard. These are the exact strings run.ts prints. */
  it('AT the floor: margin +0.0000 AND the ⚠ — equality is precisely the stamping judge', () => {
    const constantBaseline = constantVerdictBaseline({ 'A>B': 14, 'B>A': 11, tie: 0 });
    const lines = formatConstantBaselineLines({
      accuracy: 14 / 25,
      constantBaseline,
      marginOverConstant: 0,
    });
    expect(lines).toEqual([
      "  constant   0.5600   (a judge stamping 'A>B' on every SCORED item: 14/25)   margin +0.0000",
      '  ⚠ accuracy is at or below the constant floor — on this subset the judge is not distinguishable from a stamp.',
    ]);
  });

  it('ABOVE the floor: one line, a signed + margin, no warning — run 9 as it will actually print', () => {
    const constantBaseline = constantVerdictBaseline({ 'A>B': 14, 'B>A': 11, tie: 0 });
    const lines = formatConstantBaselineLines({
      accuracy: 0.6,
      constantBaseline,
      marginOverConstant: 0.6 - 14 / 25,
    });
    expect(lines).toEqual([
      "  constant   0.5600   (a judge stamping 'A>B' on every SCORED item: 14/25)   margin +0.0400",
    ]);
  });

  it("BELOW the floor: `sign` stays empty, the minus comes from toFixed, and the ⚠ is there — granite4.1:3b's case", () => {
    const constantBaseline = constantVerdictBaseline({ 'A>B': 2, 'B>A': 1, tie: 0 });
    const lines = formatConstantBaselineLines({
      accuracy: 1 / 3,
      constantBaseline,
      marginOverConstant: 1 / 3 - 2 / 3,
    });
    expect(lines).toEqual([
      "  constant   0.6667   (a judge stamping 'A>B' on every SCORED item: 2/3)   margin -0.3333",
      '  ⚠ accuracy is at or below the constant floor — on this subset the judge is not distinguishable from a stamp.',
    ]);
  });

  it('a two-way tie names BOTH classes and counts the FIRST one, so stamped/denominator stays honest', () => {
    const constantBaseline = constantVerdictBaseline({ 'A>B': 12, 'B>A': 12, tie: 6 });
    const lines = formatConstantBaselineLines({
      accuracy: 0.5,
      constantBaseline,
      marginOverConstant: 0.5 - 0.4,
    });
    expect(lines).toEqual([
      "  constant   0.4000   (a judge stamping 'A>B/B>A' on every SCORED item: 12/30)   margin +0.1000",
    ]);
  });

  it('nothing scored → no lines at all, rather than a line reading n/a', () => {
    expect(
      formatConstantBaselineLines({ accuracy: null, constantBaseline: null, marginOverConstant: null })
    ).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd /root/judge-arena && npx vitest run tests/lib/calibration-baseline.test.ts`
Expected: FAIL — the whole file errors at import, so **0 tests run, not 5 failures** (a missing named export is a load-time error, not a runtime one). vitest 3.2.4 loads through vite-node's `ssrTransform`, so the wording is a `SyntaxError` along the lines of `The requested module '/src/lib/calibration/baseline.ts' does not provide an export named 'formatConstantBaselineLines'` rather than Rollup's build-time `"formatConstantBaselineLines" is not exported by …`. Do not gate on the exact sentence — gate on "the file failed to load and ran 0 tests". `npx tsc --noEmit` fails on the same line, which is the same red.

- [ ] **Step 4: Implement the formatter**

Append to `src/lib/calibration/baseline.ts`, after `constantVerdictBaseline`:

```ts

/** Four decimals, the same rendering as `fmt` in scripts/calibration/run.ts.
 *  Local and null-free: the guard in the formatter has already excluded null,
 *  and run.ts keeps its own `fmt` for the ACCURACY and kappa lines, which do
 *  print `n/a`. */
const fmt4 = (n: number): string => n.toFixed(4);

/**
 * The lines the CLI prints for the floor: the `constant` line, and the `⚠`
 * when the judge is AT OR BELOW it. `[]` when nothing was scored — a line
 * reading `n/a` would suggest a floor exists and could not be rendered.
 *
 * WHY THE RENDERING IS HERE AND NOT IN THE SCRIPT. `scripts/calibration/**` is
 * outside every coverage include (vitest.config.ts:37) and has no test harness,
 * so a template literal built there is permanently unguarded — and the
 * load-bearing part is the `<=`: relaxing it to `<` silences the warning on
 * exactly the judge it exists for, the one that lands ON the floor by stamping.
 * Here `tests/lib/calibration-baseline.test.ts` pins it. Same reasoning, and
 * the same shape, as `describeSamplingSnapshot` in sampling-drift.ts (v2k).
 *
 * The parameter is a structural literal rather than `Pick<CalibrationScore,
 * …>` because score.ts imports THIS module; a type import back would close an
 * import cycle. A whole `CalibrationScore` satisfies it, which is how run.ts
 * calls it.
 *
 * The guard names all three fields even though, coming from `score.ts`, they
 * are null TOGETHER (`accuracy` is null iff verdictCount is 0; the floor is
 * null iff its denominator is, and `keyCounts[expected] += 1` sits past the
 * same gate as `verdictCount += 1`). It names them because the parameter is
 * structural, so TypeScript narrows each field independently and the two
 * arithmetic uses below would otherwise be `number | null`. That is a type
 * requirement, not a defensive clamp — and it does mean the `||` chain
 * short-circuits on the one null fixture, so operands two and three never
 * reach their TRUE outcome in any test. Do not claim "100% branches" for this
 * file from that shape; read the printed coverage row (Task 3 Step 13).
 */
export function formatConstantBaselineLines(score: {
  accuracy: number | null;
  constantBaseline: ConstantBaseline | null;
  marginOverConstant: number | null;
}): string[] {
  const floor = score.constantBaseline;
  if (floor === null || score.accuracy === null || score.marginOverConstant === null) return [];

  // `preferences` lists EVERY top class when the key ties; the count printed is
  // the first one's, and they are equal by construction (that is what a tie
  // among top classes means), so the pair stays honest under either label.
  const stamped = floor.keyCounts[floor.preferences[0]];
  const sign = score.marginOverConstant >= 0 ? '+' : '';
  const lines = [
    `  constant   ${fmt4(floor.accuracy)}   (a judge stamping '${floor.preferences.join('/')}' on every SCORED item: ` +
      `${stamped}/${floor.denominator})   margin ${sign}${fmt4(score.marginOverConstant)}`,
  ];
  if (score.accuracy <= floor.accuracy) {
    lines.push(
      '  ⚠ accuracy is at or below the constant floor — on this subset the judge is not distinguishable from a stamp.'
    );
  }
  return lines;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /root/judge-arena && npx tsc --noEmit && npx vitest run tests/lib/calibration-baseline.test.ts`
Expected: tsc 0; PASS — 15 tests (Task 1's 10 plus these 5).

- [ ] **Step 6: Injection — two breakages, each must go red, then restore**

(a) Relax the boundary. In `baseline.ts` replace `if (score.accuracy <= floor.accuracy) {` with `if (score.accuracy < floor.accuracy) {`
Run: `npx vitest run tests/lib/calibration-baseline.test.ts`
Expected: FAIL — 1 failed / 14 passed (`AT the floor: margin +0.0000 AND the ⚠ …`: the second array element is missing — `expected [ '  constant   0.5600 …' ] to deeply equal [ '  constant   0.5600 …', '  ⚠ accuracy is at or below …' ]`). The below-floor case stays GREEN (`<` is still true there), which is why the equality case is a separate test: it is the only one that can see this. Restore.

(b) Force the sign. Replace `const sign = score.marginOverConstant >= 0 ? '+' : '';` with `const sign = '+';`
Run: same command.
Expected: FAIL — 1 failed / 14 passed (`BELOW the floor …`: `margin +-0.3333` where `margin -0.3333` was expected). Restore.

After restoring: `npx vitest run tests/lib/calibration-baseline.test.ts` → 15 passed.

- [ ] **Step 7: Wire the CLI**

In `scripts/calibration/run.ts`:

(a) Header. Replace lines 14-15 —
```ts
 *   - accuracy first, WITH its denominator, because a number over 14 of 30
 *     items and a number over 30 are different claims;
```
— with:
```ts
 *   - accuracy first, WITH its denominator, because a number over 14 of 30
 *     items and a number over 30 are different claims;
 *   - the CONSTANT FLOOR beside it, over the SAME denominator: what a judge
 *     stamping the key's plurality class on every scored item would score, and
 *     the margin above it. It moves with the denominator (17/30 = 0.5667 on
 *     the full set, 14/25 = 0.5600 on run 9's scored subset), so it is
 *     computed per run and never cached — and only the subset floor is
 *     printed, because two floors on one screen get the wrong one quoted;
```

(b) Import. Replace line 53 (unmoved by v2k, whose own import goes AFTER it) —
```ts
import { scoreCalibrationRun } from '@/lib/calibration/score';
```
— with:
```ts
import { formatConstantBaselineLines } from '@/lib/calibration/baseline';
import { scoreCalibrationRun } from '@/lib/calibration/score';
```

(c) The print block. Replace the two lines (**:277-278**, measured on `33b7be4` — anchor on the text) —
```ts
  console.log(`  ACCURACY   ${fmt(score.accuracy)}   (${score.correctCount}/${score.verdictCount} items with a verdict)`);
  console.log(`  kappa      ${fmt(score.kappa)}   method ${JSON.stringify(score.method)}`);
```
— with:
```ts
  console.log(`  ACCURACY   ${fmt(score.accuracy)}   (${score.correctCount}/${score.verdictCount} items with a verdict)`);
  // The floor over the SAME denominator as the line above — never the whole
  // set's. Zero lines when nothing was scored. The rendering (including the
  // `<=` that decides the ⚠) is in src/lib/calibration/baseline.ts, where the
  // unit suite pins it: this file is outside every coverage include and has no
  // harness, so a template built here would ship untested.
  for (const line of formatConstantBaselineLines(score)) console.log(line);
  console.log(`  kappa      ${fmt(score.kappa)}   method ${JSON.stringify(score.method)}`);
```

- [ ] **Step 8: Drive the whole path end-to-end (the script itself has no harness; the formatter's permanent guard is Step 2)**

The strings and the `<=` are pinned by `tests/lib/calibration-baseline.test.ts` and stay pinned after this task — that is Step 6's job, and it is what makes the feature tested rather than smoke-tested. What is left unguarded is the *plumbing*, and it is TWO facts, not one:

- **(P1) `run.ts` calls the formatter at all, in the right place.** The smoke script below **cannot see this** — it re-declares its own `fmt` and its own `report()` and never imports or executes `scripts/calibration/run.ts`, so deleting the loop from `run.ts` changes nothing it prints. Concrete wrong implementation that would otherwise survive every gate in this task: edit (c) is applied to the smoke script and NOT to `run.ts` (or is applied and then reverted), or the loop is placed after the `itemCount … missingVerdicts …` line at :279 or inside the `if (score.missingVerdicts > 0)` block at :280-282. lint 0, tsc 0, all 914 unit tests green, smoke output byte-identical — and a CLI that prints the constant line late, or never. The only accidental net is `npm run lint` (`eslint src/ prisma/ scripts/ tests/`) flagging an unused import if the import lands but the call does not; placement is caught by nothing. So P1 is checked directly, against the file that actually ships, by the greps below.
- **(P2) the formatter, handed a real `CalibrationScore` from the real `scoreCalibrationRun`, renders what the unit tests say it renders.** That is what the smoke script legitimately shows, because it imports both real functions.

Type-check and lint, then do P1 first:

```bash
cd /root/judge-arena && npx tsc --noEmit && npm run lint
# P1a — run.ts names the formatter TWICE: the import and the call. Not the
# string it prints (a paraphrase would still count 0 and pass), the identifier.
grep -c formatConstantBaselineLines /root/judge-arena/scripts/calibration/run.ts     # must be 2
# P1b — and the call sits BETWEEN the ACCURACY line and the kappa line, which is
# the whole point of the feature: the floor beside the number it floors. This is
# also what the runbook §7.1 block committed in Step 9 shows, so a mismatch here
# means the doc is committed describing output the CLI does not produce.
grep -n -A7 'ACCURACY   ' /root/judge-arena/scripts/calibration/run.ts
```
Expected: `2`, then an 8-line window that starts at `277:` with the ACCURACY console.log, carries edit (c)'s five comment lines at 278-282, has `283-  for (const line of formatConstantBaselineLines(score)) console.log(line);`, and ends at `284-` with the kappa console.log. `ACCURACY` in capitals occurs **exactly once** in the file (`grep -c ACCURACY scripts/calibration/run.ts` → 1; the header bullet at :14 spells it lowercase), so this grep has one match and cannot be satisfied by a window somewhere else. If the count is 1 the call is missing; if it is 2 but the loop is not inside this window, the placement is wrong. Either way, STOP and fix `run.ts` before going further.

Then P2:

```bash
mkdir -p /root/judge-arena/scripts/tmp-smoke && cat > /root/judge-arena/scripts/tmp-smoke/constant-line.ts <<'EOF'
import {
  scoreCalibrationRun,
  type CalibrationScore,
  type CalibrationScoreClient,
} from '@/lib/calibration/score';
// score.ts:71 imports the shared client, so this process holds an open pool
// whether or not it queries; run.ts disconnects in a `finally` for exactly
// that reason (its header: an undisconnected client prints the whole report
// and then never exits). Mirror it.
import { prisma } from '@/lib/db';
import { formatConstantBaselineLines } from '@/lib/calibration/baseline';

const fmt = (n: number | null, digits = 4) => (n === null ? 'n/a' : n.toFixed(digits));

const clientFor = (runs: unknown[]) =>
  ({
    evaluationRun: { findMany: async () => runs },
    calibrationRun: { update: async () => ({}) },
  }) as unknown as CalibrationScoreClient;

// A COPY of run.ts's two statements, not run.ts itself — this file cannot and
// does not verify that run.ts calls anything (that is P1's greps, above). The
// ACCURACY template here IS a hand-copy and can drift; the `constant`/`⚠`
// strings are not, because the formatter is imported rather than re-typed.
// What this proves is P2: the real formatter, handed a real CalibrationScore
// produced by the real scoreCalibrationRun, renders these exact lines.
function report(score: CalibrationScore): void {
  console.log(`  ACCURACY   ${fmt(score.accuracy)}   (${score.correctCount}/${score.verdictCount} items with a verdict)`);
  for (const line of formatConstantBaselineLines(score)) console.log(line);
}

async function main() {
  // (1) AT the floor: 25 scored items keyed 14/11; the judge stamps 'A' on all
  //     of them -> accuracy 14/25 == floor, margin +0.0000, ⚠ on the equality.
  const stamp = Array.from({ length: 25 }, (_, i) => ({
    id: `r${i}`,
    goldenItem: { id: `i${i}`, index: i, expected: i < 14 ? 'A>B' : 'B>A' },
    modelJudgments: [{ verdict: 'A', pairOrder: 'AB', judgeModelVersionId: 'v1' }],
  }));
  report(await scoreCalibrationRun('smoke-stamp', clientFor(stamp)));

  // (2) BELOW the floor: 3 items keyed 2 'A>B' / 1 'B>A', judged 'B' every
  //     time -> accuracy 1/3 against a floor of 2/3. This is the only path
  //     that exercises the NEGATIVE margin (`sign` stays empty and the minus
  //     comes from fmt) — granite4.1:3b's shape, the reason the ⚠ exists.
  const below = [0, 1, 2].map((i) => ({
    id: `b${i}`,
    goldenItem: { id: `b${i}`, index: i, expected: i < 2 ? 'A>B' : 'B>A' },
    modelJudgments: [{ verdict: 'B', pairOrder: 'AB', judgeModelVersionId: 'v1' }],
  }));
  report(await scoreCalibrationRun('smoke-below', clientFor(below)));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
EOF
cd /root/judge-arena && sh -c 'set -a; . ./.env.test; set +a; npx tsx scripts/tmp-smoke/constant-line.ts'
```
(The script lives under the repo root so `tsx` picks up `tsconfig.json`'s `@/*` alias the same way `npm run calibration:run` does; it is deleted two commands below and is never staged.)
Expected output, exactly:
```
  ACCURACY   0.5600   (14/25 items with a verdict)
  constant   0.5600   (a judge stamping 'A>B' on every SCORED item: 14/25)   margin +0.0000
  ⚠ accuracy is at or below the constant floor — on this subset the judge is not distinguishable from a stamp.
  ACCURACY   0.3333   (1/3 items with a verdict)
  constant   0.6667   (a judge stamping 'A>B' on every SCORED item: 2/3)   margin -0.3333
  ⚠ accuracy is at or below the constant floor — on this subset the judge is not distinguishable from a stamp.
```

Then the INJECTION for the plumbing (the formatter's own two injections are Step 6, and unlike these they leave a permanent guard behind):

(i-P1) Drop the loop from **`scripts/calibration/run.ts` ONLY** — delete `for (const line of formatConstantBaselineLines(score)) console.log(line);` and leave the smoke script untouched.
Run:
```bash
grep -c formatConstantBaselineLines /root/judge-arena/scripts/calibration/run.ts
cd /root/judge-arena && npm run lint
cd /root/judge-arena && sh -c 'set -a; . ./.env.test; set +a; npx tsx scripts/tmp-smoke/constant-line.ts'
```
Expected: the grep drops **2 → 1** (this is the assertion that discriminates); `npm run lint` fails on the now-unused import (`'formatConstantBaselineLines' is defined but never used`); **and the smoke output is UNCHANGED — all six lines still print.** That last part is the point of running it: it demonstrates in the executor's own terminal that the smoke script cannot see this failure, so the grep — not the smoke run — is what guards P1. Restore `run.ts` and re-confirm the grep prints 2 and lint is 0.

(i-P2) Drop the loop from **`scripts/tmp-smoke/constant-line.ts` only**.
Run: `cd /root/judge-arena && sh -c 'set -a; . ./.env.test; set +a; npx tsx scripts/tmp-smoke/constant-line.ts'`
Expected: only the two `ACCURACY` lines print — the `constant` and `⚠` lines are gone from both blocks. That proves the lines come from the formatter rather than from anything the fixture pre-baked. Restore.

(ii) Break the per-denominator rule, in the smoke fixture only: change `length: 25` to `length: 30` and `expected: i < 14 ? 'A>B' : 'B>A'` to `expected: i < 17 ? 'A>B' : 'B>A'`.
Run: same command.
Expected: block (1) becomes `  ACCURACY   0.5667   (17/30 items with a verdict)` / `  constant   0.5667   (a judge stamping 'A>B' on every SCORED item: 17/30)   margin +0.0000` — the printed floor tracks the denominator it was handed and is not a constant. Restore.

After restoring: re-run the smoke script → the six lines above, byte for byte.
Then confirm the real script still refuses an unknown id cleanly (the `--score-only` branch runs its query before the print block — this exercises the file, not the new lines):
```bash
cd /root/judge-arena && sh -c 'set -a; . ./.env.test; set +a; npx tsx scripts/calibration/run.ts --score-only=does-not-exist --poll-timeout=1'; echo "exit=$?"
```
Expected: `Scoring existing calibration run does-not-exist (no launch).`, then `sampling  …`, then `Error: No CalibrationRun does-not-exist.` and `exit=1`. That guard is **`scripts/calibration/run.ts:169`** (`if (!header) throw new Error(...)`), landed with v2k and verified present on `33b7be4`. Keep `--poll-timeout=1` anyway: `pollTimeoutSec` defaults to 3600 (:155), so any future path that reaches the poll loop without the guard would sleep in a 5 s circle for an hour. **Never run this without `--poll-timeout`.**

Then re-assert P1 (the smoke script is about to be deleted; the greps are what survives) and remove the script:
```bash
cd /root/judge-arena
grep -c formatConstantBaselineLines scripts/calibration/run.ts     # 2 — import + call
grep -c 'console.log(`  constant' scripts/calibration/run.ts       # 0 — run.ts builds no line itself
grep -c 'on every SCORED item' src/lib/calibration/baseline.ts     # 1 — one copy, in the covered module
rm -r /root/judge-arena/scripts/tmp-smoke && git -C /root/judge-arena status --short scripts/ src/ tests/
```
Expected: `2`, `0`, `1`; after the `rm`, `status` shows ` M scripts/calibration/run.ts`, ` M src/lib/calibration/baseline.ts` and ` M tests/lib/calibration-baseline.test.ts` and nothing else.

An earlier revision ran `grep -c "on every SCORED item"` across all three files expecting `0/0/1` and called that the check. It is not: it counts a SUBSTRING of the floor line's text, so it is equally satisfied by a `run.ts` that never calls the formatter, and a reworded hand-copy (`on every scored item`) also scores 0 — the `grep -c "name"` vs `nameX` trap. The positive assertions above are what discriminate. **What is NOT permanently guarded after this step:** the call site itself, and the line's position between ACCURACY and kappa. Both are pinned only by the greps in this step plus the runbook §7.1 block; that is accepted deliberately (the ordering is cosmetic and documented), and it is the honest reading of the self-review's "no behaviour is left guarded only by a deleted script".

- [ ] **Step 9: Runbook §7.1 and §7.2**

In `docs/runbooks/scoring-a-judge-against-a-golden-set.md`:

(a) Replace lines 284-299 —
````markdown
```
ACCURACY   0.8333   (25/30 items with a verdict)
kappa      0.6575   method {"variant":"cohen","weighting":"none"}
itemCount 30   missingVerdicts 0
```

- **`(25/30)` is part of the number.** A score over a partial set is a claim about a different, and
  self-selected, population. Never quote the left-hand figure without the parenthesis.
- **`missingVerdicts > 0` prints its own warning line** — `the accuracy above is over the rest, not
  the set`. Believe the field over arithmetic you have to do yourself; it exists because the first
  version of this report printed `missingVerdicts 0` under a denominator of 26 (fixed in `cb2fc37`).
- **Kappa is a labelled secondary, not a second opinion.** Ground truth is an answer key, not a peer
  rater, so chance-correcting on its marginal is a category error — and kappa is not comparable
  across sets, which is the one thing a leaderboard needs. Rank on accuracy. Full argument: the spec,
  §1.4.
- **`passed` NULL means no threshold is set**, so nothing has passed or failed. It is not a failure.
````
— with the block below. **`"categories"` is the one value in this plan that is not fixed at write time — set it from Step 1's second query before pasting.** As written it reads `["A>B","B>A"]`, which is correct when no completed judgment's verdict was `tie`. If that query returned a `tie` row, the `kappa` line must instead read `…,"categories":["A>B","B>A","tie"]}` — `agreement.ts:88-95` emits the lexicographically sorted union of both raters' classes and the judge is one of the raters. Paste the value the query gave; do not paste this block unedited.

````markdown
```
# Reconstructed from the stored row for run 9 — re-paste this block verbatim
# from a real --score-only on an image carrying v2l.
ACCURACY   0.6000   (15/25 items with a verdict)
constant   0.5600   (a judge stamping 'A>B' on every SCORED item: 14/25)   margin +0.0400
kappa      0.2355   method {"statistic":"cohen","weighting":"none","annotatorCount":2,"itemCount":25,"categories":["A>B","B>A"]}
itemCount 25   missingVerdicts 5
⚠ 5 item(s) produced no verdict — the accuracy above is over the rest, not the set.
```

> **CORRECTION (2026-09-02, v2l).** The block above used to show run 2 (`0.8333 (25/30)`) with a
> `method {"variant":"cohen","weighting":"none"}` line that the script has never printed — `method`
> is `JSON.stringify(score.method)`, whose shape is `{statistic, weighting, annotatorCount, itemCount,
> categories}`. It now shows run 9 (`cmtircx0x`, granite4.2:3b at `max_tokens` 12288), the run whose
> partial denominator is the reason the `constant` line exists. **It is a RECONSTRUCTION, not a
> capture** — no image in existence can print it yet, because production's `constantBaselineAccuracy`
> is NULL until each row is re-scored on a v2l image. The numbers are the stored row and the scored
> subset's key, confirmed read-only against production before this note was written (14 `A>B` /
> 11 `B>A` over 25 completed non-null verdicts; `rawAgreement` 0.6, `verdictCount` 25), with
> `categories` taken from a query rather than from output; the block is the print template applied to
> them, in the order `run.ts:277-282` prints. Re-paste it verbatim — and drop the two `#` label lines
> at the top of the fence — after the first `--score-only` on an image carrying v2l.

- **The parenthesis is part of the number, and it is `correct/verdicts` — not `verdicts/items`.**
  `(15/25)` says 15 of the 25 items that produced a verdict were right. The fact that this run is
  over a PARTIAL, self-selected population is the *next* line down — `itemCount 25 missingVerdicts 5`
  — and the `⚠` under it. Read the two together; never quote `0.6000` without both.
- **`constant` is the floor, over the SAME denominator.** It is what a judge stamping the key's
  plurality class on every *scored* item would score — `max(key class) / verdictCount` — and it
  moves with the denominator: 17/30 = 0.5667 on the full set, 14/25 = 0.5600 on run 9's 25 scored
  items. Only the subset floor is printed, on purpose; the full-set floor would flatter a partial
  run. `margin` is accuracy minus floor. **A `⚠ accuracy is at or below the constant floor` line
  means the judge is not distinguishable from a stamp on this subset** — that is granite4.1:3b's
  0.5000 against 0.5667, and until v2l nothing on screen said so. The floor is also stored as
  `CalibrationRun.constantBaselineAccuracy` (NULL on runs not scored since v2l), so the handoff §8
  scoreboard query shows it beside `rawAgreement`. When the key's top classes tie the line names all
  of them (`'A>B/B>A'`).
- **`missingVerdicts > 0` prints its own warning line** — `the accuracy above is over the rest, not
  the set`. Believe the field over arithmetic you have to do yourself; it exists because the first
  version of this report printed `missingVerdicts 0` under a denominator of 26 (fixed in `cb2fc37`).
- **Kappa is a labelled secondary, not a second opinion.** Ground truth is an answer key, not a peer
  rater, so chance-correcting on its marginal is a category error — and kappa is not comparable
  across sets, which is the one thing a leaderboard needs. Rank on accuracy. Full argument: the spec,
  §1.4.
- **`passed` NULL means no threshold is set**, so nothing has passed or failed. It is not a failure.
````

(b) Replace lines 310-313 (now lower by the insertion above — anchor on the text) —
```markdown
Read it **against the key's own marginal**, which is a property of the set (17 `A>B` / 13 `B>A` on
the 30-item set). A judge that answers `A>B` every time scores **0.5667** accuracy on that set —
"better than chance" to the naked eye — and **0.0000** kappa. **A distribution far more skewed than
the key's is the cheapest possible warning that you are looking at position bias rather than skill.**
```
— with:
```markdown
Read it **against the key's own marginal**, which is a property of the set (17 `A>B` / 13 `B>A` on
the 30-item set). A judge that answers `A>B` every time scores the `constant` line's number — **0.5667**
on the full set, **0.5600** on run 9's 25-item subset — and **0.0000** kappa; since v2l that floor is
printed beside the accuracy rather than recited here. **A distribution far more skewed than the key's
is the cheapest possible warning that you are looking at position bias rather than skill.**
```

- [ ] **Step 10: Handoff — the §0 claim that becomes FALSE, the ratio CORRECTION, the "landed" note, the §8 query**

First find every sibling claim, because the two that MATTER are phrased differently from each other and one of them wraps across a line break:

```bash
grep -rn 'never computed' /root/judge-arena/docs /root/judge-arena/README.md /root/judge-arena/src
grep -rn -B1 'computed\.' /root/judge-arena/docs/superpowers/plans/2026-09-01-scoreboard-handoff.md
```
Expected: the first grep finds ONLY `docs/superpowers/plans/2026-08-30-state-and-next-steps.md:31`. That is the trap (failure mode A/2): the handoff's copy of the same claim is split across `:17` ("… because the degenerate baseline is never") and `:18` ("computed."), so a one-line pattern cannot see it and a rollout that trusted the first grep would reach 1 of the 2 claims this change falsifies. The second grep surfaces it. Both get a note, in this commit; §5.6 #7's DONE note is Step 12.

The other siblings state **0.5667 as a fact** and stay TRUE after this change — `README.md:411`, `docs/superpowers/specs/2026-08-31-calibration-baseline-and-footprint.md:115`, `docs/superpowers/specs/2026-09-01-…-envelopes.md:16`, `docs/superpowers/plans/2026-08-30-state-and-next-steps.md:640`, `docs/superpowers/specs/2026-08-17-integration-release-and-a2-roadmap.md:775`. **Leave them, and say so in the commit body** so the omission reads as deliberate rather than missed.

(a) After line 18 — the §0 "If you read one thing" paragraph, whose last clause is now false —
```markdown
Three judges have been scored against a frozen golden set. **The best is 0.8667; the worst is worse
than a rubber stamp**, and the report does not say so because the degenerate baseline is never
computed.
```
— insert:
```markdown

> **CORRECTION (2026-09-02, v2l).** "the report does not say so because the degenerate baseline is
> never computed" was true when this was written and is no longer: `scripts/calibration/run.ts` now
> prints `constant <floor> … margin <±m>` beside ACCURACY and a `⚠ accuracy is at or below the
> constant floor` line when it is, the floor is computed per SCORED subset by
> `src/lib/calibration/baseline.ts`, and it is stored as `CalibrationRun.constantBaselineAccuracy`
> (v2l). The headline itself stands: the worst judge is still worse than a rubber stamp. Rows scored
> before v2l hold NULL for the column until re-scored with `--score-only`.
```

**(a) inserts 8 lines and (c) below inserts more, so line numbers keep shifting through this step — do not compute post-shift numbers. (b) and (c) are keyed to the pre-(a) numbering shown in their own blocks; (d) and (e) are keyed to `33b7be4` and are text-anchored. Anchor every edit on the quoted text, as everywhere else in this plan.**

(b) Replace line 83 (pre-(a) numbering) —
```markdown
| granite4.2:3b (Ollama) | 12288 | 0.6000 | 0.2355 | **15/25** | **+0.04** |
```
— with:
```markdown
| granite4.2:3b (Ollama) | 12288 | 0.6000 | 0.2355 | **25/30** | **+0.04** |
```

(c) After line 84 —
```markdown
| granite4.1:3b (Ollama) | 4096 | 0.5000 | 0.1296 | 30/30 | **−0.07** |
```
— insert:
```markdown

> **CORRECTION (2026-09-02).** The granite4.2 row read `15/25` under *verdicts* until v2l landed.
> That is correct/verdictCount (0.6000 × 25 = 15); every other row is verdictCount/items, under which
> run 9 is **25/30**. The spec's §1 ledger carried the same slip and is corrected there. The
> *vs. constant stamp* column is now computed and stored, not hand-worked: `scripts/calibration/run.ts`
> prints `constant <floor> … margin <±m>` (per scored subset) and `CalibrationRun.constantBaselineAccuracy`
> holds the floor; the values here were produced by hand before that existed and agree with it.
```

(d) After the §7 #2 item (**:343-345** on `33b7be4`, below v2k's own blockquote — text-anchored, re-locate before editing) —
```markdown
2. **Emit the degenerate baseline beside the accuracy.** It is computable from the answer key,
   `score.ts` already derives it in prose, and nothing displays it. Without it a leaderboard cannot
   distinguish "learned a little" from "stamps A". Must be computed **per denominator** (§2).
```
— insert:
```markdown

   > **DONE (v2l, 2026-09-02).** `src/lib/calibration/baseline.ts` computes it per scored subset;
   > `scoreCalibrationRun` returns `constantBaseline` + `marginOverConstant` and stores the floor as
   > `CalibrationRun.constantBaselineAccuracy` in the same overwrite as `rawAgreement`; the CLI prints
   > `constant … margin` and a `⚠` when accuracy ≤ floor. The 9 existing rows hold NULL until re-scored
   > with `--score-only` on an image carrying v2l — an operator write, not a migration step. "Computable
   > from the answer key" above was only half right: from the key **restricted to the scored rows**.
```

(e) In the §8 step-3 SQL block (as rewritten by v2k), replace the `SELECT` line (**:398**) —
```sh
  SELECT jm.name, cr.\"rawAgreement\" AS acc, cr.kappa, cr.\"verdictCount\",
```
— with:
```sh
  SELECT jm.name, cr.\"rawAgreement\" AS acc, cr.\"constantBaselineAccuracy\" AS floor, cr.kappa, cr.\"verdictCount\",
```
and, in the comment block directly above that `kubectl` line, append one line after its LAST comment line — as rewritten by v2k that is `#    run whose config moved mid-run, which is the right outcome.)`, and the new line goes immediately before `kubectl -n tenant-public exec judge-arena-pg-1 …`. Do NOT anchor on `#    joining to JudgeModelVersion.samplingDefaults for the config.`: v2k turns that line into `… for the config. (open #1,` and continues the parenthetical over four more `#` lines, so inserting after it splits an open paren. (Verified on `33b7be4`: the comment block is :391-396, its last line is :396, the `kubectl` line is :397 and the `SELECT` is :398.)
```sh
#    floor = CalibrationRun.constantBaselineAccuracy (v2l): NULL until a row is re-scored on a v2l image.
```

- [ ] **Step 11: Spec §1 — the ratio CORRECTION and the floor note**

In `docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md`:

(a) Replace line 49 —
```markdown
| 9 | `cmtircx0x` | granite4.2:3b | ollama | **12288** | 0.6000 | 0.2355 | **15/25** | **5** | ⛔ 5 items lost to a REPETITION LOOP — §5.4.2 |
```
— with:
```markdown
| 9 | `cmtircx0x` | granite4.2:3b | ollama | **12288** | 0.6000 | 0.2355 | **25/30** | **5** | ⛔ 5 items lost to a REPETITION LOOP — §5.4.2 |
```

(b) After line 49 (before the blank line and `**Reference lines for reading that column:**`), insert:
```markdown

> **CORRECTION (2026-09-02).** Row 9's *n* read `15/25` until v2l — correct/verdictCount, where every
> other row is verdictCount/items. Under the table's own convention it is **25/30** (`verdictCount` 25).
```

(c) After line 66 (the paragraph ending `… cannot compute this number once and cache it.`), insert:
```markdown

> **Landed (v2l, 2026-09-02).** The floor is no longer hand-worked: `src/lib/calibration/baseline.ts`
> computes `max(key class) / verdictCount` over the scored subset, `scoreCalibrationRun` returns it as
> `constantBaseline` (with every top class named when the key ties) and stores it as
> `CalibrationRun.constantBaselineAccuracy` beside `rawAgreement`, and `scripts/calibration/run.ts`
> prints `constant <floor> (… 14/25) margin +0.0400` with a `⚠` when accuracy is at or below it. Rows
> not re-scored since v2l hold NULL. Only the subset floor is ever printed or stored.
```

- [ ] **Step 12: Register — the §0 headline claim that becomes FALSE, then §5.6 #7 DONE**

In `docs/superpowers/plans/2026-08-30-state-and-next-steps.md`:

(a) After line 33 — the end of the §0 headline paragraph, which at `:31` says the floor "is never computed" and points at §5.6/7 as the open item. Marking §5.6 #7 DONE in (b) without this leaves the file contradicting itself.
```markdown
the constant. An accuracy that reads as a weak-but-real signal was in fact worse than a stamp, and
nothing in the report says so, because the floor is never computed. That is now follow-up §5.6/7 and
it is a display bug with real consequence: the leaderboard's whole job is to rank, and it currently
cannot tell "learned a little" from "learned nothing and guesses A".
```
— insert:
```markdown

> **CORRECTION (2026-09-02, v2l).** "the floor is never computed" and "it currently cannot tell" were
> true when written. The floor is now computed per SCORED subset (`src/lib/calibration/baseline.ts`),
> stored (`CalibrationRun.constantBaselineAccuracy`) and printed beside the accuracy with a `⚠` when
> the judge is at or below it; §5.6 #7 is marked DONE below. The headline stands — `granite4.1:3b`'s
> 0.5000 really is below the 0.5667 stamp — and one detail is refined there: the floor belongs to the
> answer key **over the rows a run actually scored**, so a partial run gets its own.
```

(b) After the §5.6 #7 item (**:431-436** on `33b7be4`, so **:438-443** after (a)'s 7-line insertion — anchor on the text) —
```markdown
7. **`granite4.1:3b` scores BELOW the degenerate baseline and nothing on screen says so.** It scored
   0.5000 where a judge that stamps `A>B` on every item scores **0.5667** on this set. The floor is a
   property of the answer key (17/13) and is computable at score time, but it is not computed or
   displayed anywhere — so a reader compares 0.5000 against an imagined 0.50 coin flip and concludes
   "weak but real". `score.ts`'s header already derives the 0.5667 figure in prose. **Emit it beside
   the accuracy.**
```
— insert:
```markdown

   > **DONE (v2l, 2026-09-02).** Emitted, stored and printed — `constantBaseline` on the score,
   > `CalibrationRun.constantBaselineAccuracy` on the row, a `constant … margin` line and a `⚠` in the
   > CLI. One refinement to the text above: the floor is a property of the answer key **over the scored
   > subset**, not of the set — run 9's 25 scored items were keyed 14/11 (0.5600), not 17/13.
```

- [ ] **Step 13: Gates, then commit**

```bash
pgrep -af "[v]itest"   # must print NOTHING
grep DATABASE_URL /root/judge-arena/.env.test     # localhost:5432/judge_arena_test
cd /root/judge-arena && npm run lint && npx tsc --noEmit && npm run test:coverage && npm run test:db:coverage && npm run test:integration && npm run build
git -C /root/judge-arena add src/lib/calibration/baseline.ts tests/lib/calibration-baseline.test.ts scripts/calibration/run.ts docs/runbooks/scoring-a-judge-against-a-golden-set.md docs/superpowers/plans/2026-09-01-scoreboard-handoff.md docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md docs/superpowers/plans/2026-08-30-state-and-next-steps.md
git -C /root/judge-arena status --short
```
Expected: lint 0; tsc 0; unit **914 / 58** (909 + the 5 formatter cases); db **675**; integration **82**; build OK; exactly seven `M` paths staged, nothing unstaged (the untracked sibling plan files under `docs/superpowers/plans/` are not this commit's — leave them).

Coverage, measured rather than predicted: read `src/lib/calibration/baseline.ts`'s row in the unit table and put THAT number in the commit body — the formatter's guard is a three-operand `||` that short-circuits on the only null fixture, so "fully covered" is a claim about v8's accounting, not about the test list. The db aggregate ticks down again for the same reason as Task 1 Step 6 (`baseline.ts` grew and no db test imports it); compare the printed `All files` row against the one recorded in Task 1 Step 6 and expect roughly another 0.5-1pp on branches/functions against >1.5pp of headroom. **Never lower a floor for it.**

```bash
git -C /root/judge-arena commit -F - <<'EOF'
feat(calibration): print the constant floor and margin beside accuracy

The Result block now reads, for run 9 (granite4.2:3b, max_tokens 12288):

    ACCURACY   0.6000   (15/25 items with a verdict)
    constant   0.5600   (a judge stamping 'A>B' on every SCORED item: 14/25)   margin +0.0400
    kappa      0.2355   method {...}

and prints "⚠ accuracy is at or below the constant floor" when it is —
which is granite4.1:3b's 0.5000 against 0.5667, the number the handoff
called worse than not thinking and nothing on screen said so.

ONE floor, the subset's. The line reads `constantBaseline` off the score
object (v2l, previous commit), whose key marginal is counted past the
same null-verdict gate as verdictCount, so a partial run is measured
against what it scored: 14/25 = 0.5600 here, not the full key's 17/30.
The full-set floor is deliberately not printed beside it — two floors on
one screen get the wrong one quoted. When the key's top classes tie the
line names all of them ('A>B/B>A').

Run 9's 14/11 subset composition was a doc claim; confirmed read-only
against production before quoting it (14 'A>B' / 11 'B>A' over the 25
completed, non-null verdicts; rawAgreement 0.6, verdictCount 25).

The two rendered lines are NOT in the script. scripts/calibration/** is
outside every coverage include and has no harness, so a template built
there ships permanently unguarded — and the load-bearing part is the
`<=`, whose relaxation to `<` silences the warning on exactly the judge
it exists for. They are formatConstantBaselineLines() in
src/lib/calibration/baseline.ts, five unit cases in
tests/lib/calibration-baseline.test.ts (at the floor, above it, below
it, a two-way tie, and nothing scored), and run.ts loops over what it
returns. Same shape as describeSamplingSnapshot in sampling-drift.ts.

Injections: relaxing `<=` to `<` turns exactly the at-the-floor case
red — the below-floor case stays green, which is why equality is its
own test; forcing the margin's sign to '+' turns the below-floor case
red (`margin +-0.3333`). Both leave a permanent guard behind.

The plumbing is two separate facts and was checked two separate ways.
That the real formatter, handed a real CalibrationScore from the real
scoreCalibrationRun, renders these lines: driven with a throwaway tsx
script importing both — the 14/11 stamp printed 0.5600 / 0.5600 /
margin +0.0000 with the ⚠, a judge below its floor printed 0.3333 /
0.6667 / margin -0.3333 with the ⚠, deleting the loop there drops both
lines, and widening the fixture to 30 items keyed 17/13 moves the
printed floor to 0.5667 — it tracks the denominator it was handed.
That run.ts CALLS it, in the right place: that script cannot show it
(it never executes run.ts; it holds its own copy of the ACCURACY
template), so it is asserted on the shipping file instead —
`grep -c formatConstantBaselineLines scripts/calibration/run.ts` is 2
(import + call) and the call sits between the ACCURACY and kappa
console.logs. Deleting the loop from run.ts alone takes that grep to 1
and reddens lint on the orphan import while the smoke output does not
change by a byte, which is why the grep and not the script is the
guard. The line's POSITION is guarded only by that grep and the
runbook block — accepted: it is cosmetic and documented.

Docs made true by this: runbook §7.1 re-pasted for run 9 with the method
shape the script actually prints (the old block's {"variant":...} was
never real — CORRECTION noted), and a bullet for the constant line;
§7.2 points at the printed floor. Handoff §2 and spec §1 both showed
run 9 as 15/25 under a column that is verdictCount/items everywhere
else — corrected to 25/30 with notes; handoff §7 #2 and register
§5.6 #7 marked DONE; the §8 scoreboard SQL selects the stored floor.
Two prose claims went from true to FALSE with this commit and carry
CORRECTION notes rather than a silent edit: the handoff's §0 "the
report does not say so because the degenerate baseline is never
computed" (split across two lines, so a one-line grep finds only the
other one) and the register's §0 "the floor is never computed", which
also pointed at §5.6/7 as open and would otherwise contradict the DONE
note eight sections below it. Deliberately NOT touched: README.md:411,
spec 2026-08-31:115, spec 2026-09-01:16, register:640 and spec
2026-08-17:775 all state 0.5667 as a fact about the answer key and
remain true. The 9 production rows hold NULL for the new column until
re-scored with --score-only on a v2l image — an operator write, not
done here.

Carried in this commit rather than split out: the §7.1 method-shape
CORRECTION is a pre-existing defect unrelated to the floor, but the
block is re-pasted whole for the constant line, and re-pasting it while
leaving a `method` shape the script never printed would have written a
known-false line by hand.

Gates: lint 0, tsc 0, 914 unit / 675 db / 82 integration, coverage 0.
No schema change in this commit.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
EOF
```

---

## Self-review

**Spec coverage.** (1) Pure module with the exact signature, null on 0, throws on bad counts, ties reported in PREFERENCES order — Task 1. (2) `keyCounts` accumulator beside `verdictDistribution`, incremented right after `const expected = …`; `CalibrationScore` extended with `constantBaseline` and `marginOverConstant`; populated in the result — Task 2 (5e-5g). (3) Stored: v2l migration `20260901190000_v2l_calibration_constant_baseline`, `constantBaselineAccuracy Float?` written in the same update as `rawAgreement`, pure function remains the source of truth — Task 2 (5h). (4) CLI `constant` line after ACCURACY with the exact wording, and the `⚠` warning when accuracy ≤ floor — rendered by `formatConstantBaselineLines` in `src/lib/calibration/baseline.ts` (Task 3 Steps 2-6, five unit cases) and printed by a one-line loop in `run.ts` (Task 3 Step 7), so the strings and the `<=` boundary carry a permanent test rather than only a deleted smoke script. (5) Unit tests: 17/13 → 0.5667 'A>B'; 25-of-30 with `pendingAt [0,1,2,17,18]` → 14/11 → 0.5600 (plus the `missingAt` twin that actually discriminates the gate); tie-containing key (first in repo); two-way tie → length 2; zero scored → null; keyCounts = confusion row sums; a SIGNED margin in both directions (the perfect judge at +13/30 and a below-floor judge at −1/3, the only guard against a swapped subtraction, which lint/tsc/the ⚠ branch all miss); the pairOrder-BA case carries an absolute oracle because two absent fields compare equal in the red state; idempotence test untouched and green; update data carries `constantBaselineAccuracy` — Task 2 Step 1 (eleven new cases, 19 → 30 in the file). DB test asserting the default NULL (no db-level scoring fixture exists, so default + round-trip only) — Task 2 Step 8. (6) Docs: handoff :83 and spec :49 `15/25` → `25/30` with CORRECTION notes; runbook §7.1 re-pasted for a real run with the real method shape and a CORRECTION, and labelled as a reconstruction until a v2l image can produce it; handoff §7 #2 and register §5.6 #7 DONE; **and the two §0 prose claims this change makes FALSE — handoff :17-18 and register :31, "the degenerate baseline / the floor is never computed" — each get a CORRECTION in the same commit** (the handoff's wraps a line break, so `grep 'never computed'` finds only the register: 1 of 2, the partial-rollout shape); score.ts header prose rewritten; read-only psql confirmation of 14/11 before the commit body quotes it — Task 3. (7) The docblock claim that `preferences` is in PREFERENCES order is itself testable: Task 1's deliberately out-of-order fixture (`{ tie: 12, 'B>A': 12, 'A>B': 6 }`) is the only case that can tell PREFERENCES order from the input object's insertion order, and injection (e) proves it.

**Injection coverage.** Every task carries one. Task 1 five against the unit suite (tie rule, null rule, count guard, keyCounts copy, and PREFERENCES order vs. `Object.keys`). Task 2 four against the unit suite (key counted before the null-verdict gate, hard-coded preferences, dropped column write, swapped margin subtraction) plus the local-DB column drop for the db test. Task 3 two against the unit suite (`<=` relaxed to `<`, which silences the ⚠ on exactly the stamping judge it exists for, and a forced `+` sign, which mangles the only negative margin), plus three for the plumbing: deleting the loop from `run.ts` ALONE (observed on `grep -c formatConstantBaselineLines run.ts`, 2 → 1, and on lint's orphan-import error — deliberately NOT on the smoke output, which does not move), deleting it from the smoke script alone, and a widened smoke fixture that moves the printed floor with its denominator. No step ends on a breakage that leaves the suite green.

**What the deleted smoke script guards, honestly.** The formatter's strings and the `<=` boundary are pinned permanently by `tests/lib/calibration-baseline.test.ts` and survive the script's deletion. Two things do NOT get a permanent test: that `run.ts` calls the formatter at all, and that the call sits between the ACCURACY and kappa lines. Those are pinned by Task 3 Step 8's greps at execution time, by lint's unused-import error for the "import but never call" half, and by the runbook §7.1 block a reader would compare against — not by a test. That is accepted rather than papered over. The stronger option, and the one to reach for if this ever regresses, is a `tests/db/**` fixture that seeds a CalibrationRun + EvaluationRun + completed ModelJudgment into `judge_arena_test` and runs `npx tsx scripts/calibration/run.ts --score-only=<id> --poll-timeout=1`, asserting the Result block's line ORDER; it is not in this plan because no such CLI-level fixture exists in the repo yet and building one is its own concern.

**Baseline drift.** Every count is now anchored on a MEASURED post-v2k baseline rather than on a chain of plan predictions: **888 unit / 57 files, 674 db / 46 files, 82 integration / 11 files** on HEAD `33b7be4`, measured 2026-09-02. Two earlier revisions of this paragraph were wrong in the same way and both were caught by measuring rather than by arithmetic — first `+3` instead of `+4` for v2k's db tests (every db number downstream one low), then `+10` instead of **`+11`** for v2k's unit tests, because the v2k plan predicted 8 tests for `tests/lib/calibration-sampling-drift.test.ts` and it shipped 9 (`npx vitest run tests/lib/sampling.test.ts tests/lib/calibration-sampling-drift.test.ts` → `Tests 11 passed (11)`). That is failure mode 15 twice over in one paragraph, which is the argument for the rule that follows it. This plan adds +26 unit (Task 1's 10, Task 2's 11, Task 3's 5) and +1 db: **Task 1 → 898 / 674 / 82, Task 2 → 909 / 675 / 82, Task 3 → 914 / 675 / 82.** Executors substitute the printed actuals into the commit body and treat any unexplained delta as a finding; the gate, not this table, is the record.

**Coverage claims are measurements, not predictions.** This plan no longer asserts that `baseline.ts` is 100% anything, and no longer sizes the db-run impact off the 2026-08-13 comment at vitest.db.config.ts:141 (recorded at 444 tests / 35 files; the suite is now 674 / 46). Task 1 Step 6 records the printed `All files` row and Tasks 2 and 3 compare against THAT. The expected direction and rough size are stated — down ~0.5-1.1pp on branches and functions per commit, twice, against measured denominators of 1286 branches / 420 functions in `coverage-db/lcov.info` and >1.5pp of headroom under 47/60/77/47 — so an executor neither panics at a 1pp drop nor mistakes it for the "fraction of a percentage point" an earlier revision predicted. No floor is lowered anywhere in this plan, and the stated remedy if one were ever threatened is a db test that imports the module, not a unit-config mock (which cannot move a number `coverage.all` produces from an unimported file).

**Line-number anchors, re-verified on `33b7be4` after both waves.** Byte-exact and unchanged: `score.ts` :27-33, :37-41, :61, :120-124, :216-219, :236, :241-242, :259-260, :273-275, :291-293; `schema.prisma`:910 (`grep -c` → 1); `run.ts` :14-15, :53; `tests/db/meta-eval.test.ts` :262-273; `tests/lib/calibration-score.test.ts` :296-299 (19 `it(` blocks); handoff :83, :84, :343-345; spec :49, :66; runbook :284-299, :310-313; register :431-436. Corrected in this revision because they had drifted: `run.ts`'s print block :261-262 → **:277-278** (and `fmt` :68-70 → **:69-71**), the handoff §8 `SELECT` :382 → **:398**, `schema.prisma`'s `CalibrationRun` :903-935 → **:903-952**, and the migration floor "after 20260901000000 (v2j)" → **after 20260901180000 (v2k, applied)**. Every edit still anchors on quoted text; the numbers are navigation aids.

**Placeholder scan.** No TBD/TODO/"similar to"; every code step shows the code; the one value not knowable from the tree (`categories` in the runbook §7.1 block) is determined by an explicit query in Task 3 Step 1, and the rule for both outcomes is restated immediately above the block that gets pasted (Step 9), not only at the query 300 lines earlier.

**Type consistency.** `ConstantBaseline { accuracy; preferences: Preference[]; keyCounts: Record<Preference, number>; denominator }` and `constantVerdictBaseline(keyCounts: Readonly<Record<Preference, number>>): ConstantBaseline | null` are identical in Task 1's module, Task 2's import/usage, and Task 3's CLI reads (`floor.keyCounts[floor.preferences[0]]`, `floor.denominator`, `floor.accuracy`, `floor.preferences.join('/')`). Task 3 adds `formatConstantBaselineLines(score: { accuracy: number | null; constantBaseline: ConstantBaseline | null; marginOverConstant: number | null }): string[]` to the same module — a structural parameter, NOT `Pick<CalibrationScore, …>`, because `score.ts` imports `baseline.ts` and a type import back would close a cycle; a whole `CalibrationScore` satisfies it structurally, which is how both `run.ts` and the smoke script call it. Task 3's smoke script types its `report()` helper with the exported `CalibrationScore` (score.ts:93) and imports `prisma` from `@/lib/db` only to disconnect it — score.ts:71 already constructs that client, so the process would otherwise be at the mercy of an open pool, exactly as run.ts's own tail explains. `CalibrationScore.constantBaseline` / `.marginOverConstant` and the column `constantBaselineAccuracy` are spelled the same in score.ts, both test files, schema.prisma, the migration SQL and every doc note.
