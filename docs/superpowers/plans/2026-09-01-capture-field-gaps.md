# Capture Field Gaps (#10 `reasoningTokens`, #11 pairwise `parseMode`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close handoff §7 items 10 and 11 — stop reporting `reasoningTokens` as a capture failure on backends that never emit it (document + de-list, no derivation, no drop), and give `ModelJudgment.parseMode` a real pairwise meaning that mirrors the pointwise rule, so a leniently-repaired pairwise verdict is distinguishable from a clean one in the data.

**Architecture:** #10 is report-and-comment only: a pure `summarizeReasoningLength` helper under `src/lib/calibration/` feeds a new `reasoningContent chars` line in the CLI capture report (the chars-of-thinking signal handoff §5.2 used to detect the repetition loop), `reasoningTokens` becomes a labelled usage-reported line, and the schema comment states every NULL case. #11 threads one boolean through the existing single pairwise parse path: `tryParsePairwiseJudgment` reports `lenient` (fence stripped OR verdict repaired), `executePairwiseCall` turns that plus `raw.structuredOutputRequested` into `parseMode`, and `persistPairwiseSuccess` writes it — no migration (column exists, `TEXT NULL`), no backfill (270 existing pairwise rows stay NULL = pre-change).

**Tech Stack:** TypeScript, Prisma (comment-only schema edits, zero migrations), vitest (unit + integration), the existing `openai`-SDK-mock pattern in `tests/lib/pairwise-execution.test.ts`.

**Spec:**
- Handoff §7 items 10–11: `/root/judge-arena/docs/superpowers/plans/2026-09-01-scoreboard-handoff.md:374-377`; §5.2 (the chars-based loop signal): `:211-244`.
- Register §5.5 items 1–2 and §5.6 item 9: `/root/judge-arena/docs/superpowers/plans/2026-08-30-state-and-next-steps.md:387-395`, `:444-448`.
- Provenance (NOT required to execute, and NOT authoritative over this document): verified map `/tmp/ja-plan-inputs/capture-field-gaps.json` (`verify.corrections`, `decisionsMade`) and cross-item critique `/tmp/ja-plan-inputs/critique.json` (`q2_missingInfoPerMap.capture-field-gaps` — exact edits; the last `q4_wrongApproach` entry — the semantic caveat the schema comment MUST carry). These are session-local scratch files and **are absent on this machine** (verified 2026-09-02: `/tmp/ja-plan-inputs/` does not exist). Every correction and exact edit they carry is reproduced verbatim in the tasks below; nothing here depends on reading them.

**Priority / wave:** Wave 2 / #7 (S)

**Depends on:** `calibration-sampling-snapshot` — **LANDED** as `a96cf94` + `33b7be4` (v2k). It extracted the sampling resolver into the new leaf `src/lib/llm/sampling.ts`; `registry.ts` now only imports it at `:94` and re-exports at `:422-423`, so **every registry.ts line at/after ~460 shifted by −36** (NOT the ~46 this plan originally predicted), while `:94-411` shifted by +1. It also edited `scripts/calibration/run.ts` (the report's select is now `:294`, the checklist `:331`, the field loop `:341`, the one-judgment dump `:410`) and added `CalibrationRun.samplingParams` via migration `20260901180000_v2k_calibration_sampling_snapshot`.

**All line numbers below were re-measured against HEAD `33b7be4` on 2026-09-02** and every `old_string` block was re-verified verbatim at its stated position — including the eight doc anchors, which Wave 1 and Wave 2 both edited. Nothing below is unexecutable. Every task still starts with a re-anchor step that greps for the symbol; **the `old_string` blocks are what an executor matches on, not the line numbers** — a number that misses is orientation drift, not a failed re-anchor, and is never a reason to stop.

**Doc-range ownership (critique q3: one owner per range):** `README.md:594-622` (§"Truncation is now a HARD FAILURE", including the stale `assertUsableContent` `:507-580` reference at `:598`) is owned by `repetition-loop-detector` (Wave 2 / #8) — do not touch it here. The handoff §7 item 11 lines (`:376-377`) are owned by THIS plan; `finalizer-error-to-needs-human` (Wave 3 / #9) inserts `### Closed since` below them and must re-anchor after this plan lands (note on Task 4 Edit 3e). The measured-table rows at register `:668-669` and baseline spec `docs/superpowers/specs/2026-08-31-calibration-baseline-and-footprint.md:341-342` are owned by this plan (no other 2026-09-01 plan cites them; `finalizer-error-to-needs-human` touches that spec at `:170-171` only).

**Owner decisions needed:** none. (Backfill of the 270 pre-change pairwise rows from `rawResponse` is declined: NULL = "written before this change", documented in the schema comment. The post-promote granite4.1:3b regression re-run is the operator's job — §"Post-promote checklist", not a plan step.)

## Global Constraints

- Repo: /root/judge-arena (Next.js 15.5.22, TypeScript, Prisma on Postgres — Json maps to JSONB —, amqplib 2.0.1, vitest). Node >= 22. Always use `git -C /root/judge-arena` (handoff trap 2: a stale `cd` once hard-reset the wrong repo).
- Gates, in this order, all must be clean before every commit: `npm run lint` (0 warnings) → `npx tsc --noEmit` → `npm run test:coverage` (unit; per-glob floors in vitest.config.ts:187-220 — NEVER lower a floor; if a new test import drags a module into a denominator, mock the seam as tests/lib/judgment-consumer-escalation.test.ts:41-69 does) → `npm run test:db:coverage` (RESETS the database at .env.test — verified today to be localhost:5432, the local podman `judge-arena-pg`, NOT the k8s `judge-arena-pg-1`; re-confirm with `grep DATABASE_URL /root/judge-arena/.env.test` before the first run) → `npm run test:integration` → `npm run build` — with one documented carve-out: Task 1 Step 9 stops after `test:coverage` (plus the DB-free `npx prisma validate`) because commit A reaches no `tests/db/**` file, no `tests/integration/**` file and no Next build, and Task 4 Step 4 runs the full chain ONCE for the branch (CONTRIBUTING.md:1640-1645 is a per-PR rule — and every extra `npm run test:db:coverage` is another `prisma migrate reset --force` of the single shared `judge_arena_test`, whose suite is NOT concurrency-safe). Baseline **measured on HEAD `33b7be4` (Wave 1 + Wave 2/v2k landed), 2026-09-02: 888 unit / 57 files; 674 db / 46 files; 82 integration / 11 files.** (Every earlier number this plan quoted — 869/870 pre-Wave-1, 877/55 and 670 post-Wave-1 — is stale. Wave 1 added 8 unit tests (`llm-index`, `worker-health`) and 2 integration tests (`tests/integration/consumer-loss-epoch.test.ts`); Wave 2 added 11 unit tests in two NEW files (`tests/lib/sampling.test.ts`, `tests/lib/calibration-sampling-drift.test.ts`) and 4 db tests in `tests/db/calibration-link.test.ts`.) **Every predicted count below is arithmetic on this measurement, not a measurement** (failure mode 15): if `test:coverage` prints something else, the printed number is the truth — put IT in the `Gates:` line, and treat an unexplained delta as a finding to diagnose, not as a number to overwrite silently.
- TDD with an INJECTION step (CONTRIBUTING.md:210-234): every behaviour test must be shown to go RED by a deliberate breakage of the implementation and GREEN again after; a test that stays green after injection is a finding. Each task's steps must include the injection.
- One concern per commit/PR (CONTRIBUTING.md:1639). Wrong statements in docs get an explicit CORRECTION note, never a silent overwrite (CONTRIBUTING.md:1653-1656). (Both refs re-verified on `33b7be4`, 2026-09-02 — CONTRIBUTING.md was last touched by Wave 1's `5e48187` and Wave 2 did not move it; `:1639` is "One concern per PR", `:1640-1645` the gate order, `:1653-1656` the CORRECTION convention, `:210-234` the TDD/injection rule.)
- Commit subject: `type(scope): lowercase summary` (feat/fix/docs/ci; scopes seen: worker, llm, queue, calibration, ci, docker). Body: narrative, then a `Gates: lint 0, tsc 0, <n> unit / <n> db / <n> integration, coverage 0.` line — EVERY slot present; a slot deliberately not measured for a commit reads `n-a` with the reason in the parenthetical that follows (a named absence is auditable, a missing slot is not) — then EXACTLY these trailers:
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
- Commit LOCALLY only. Never push, never promote; the operator does that (push-to-main fires CI and builds an image; promotion is a separate homelab-setup PR).
- Migration naming (**inert for this plan — it adds ZERO migrations; both schema edits are `//` comments only**, so `prisma migrate diff` must emit `-- This is an empty migration.`): `prisma/migrations/<YYYYMMDDHHMMSS>_v2<letter>_<snake>/migration.sql`. **`20260901180000_v2k_calibration_sampling_snapshot` is on disk and APPLIED to `judge_arena_test`, so the next free letter is `v2l` and any timestamp `<= 20260901180000` collides.** (Corrected 2026-09-02: this bullet previously said "after 20260901000000 (v2j)".) Narrative `-- v2x — ...` header in the v2i/v2j style; ZERO hand edits (content must equal what `prisma migrate diff` emits), then `npx prisma generate`.
- GREP TRAP live in HEAD: /root/judge-arena/src/lib/calibration/readings.ts:164 and /root/judge-arena/scripts/importer/reconcile.ts:294 contain a deliberate NUL byte; plain grep returns nothing for those files. Use `grep -a`. NEVER remove the NUL.
- Production is sha-d21f31d47c35; main is now `33b7be4`, eleven commits ahead of `fc9e936`, and they are NOT docs-only — five touch code (Wave 1: `src/lib/llm/index.ts` + `resilience.ts`, `src/worker/health.ts` + `main.ts`; Wave 2/v2k: the new `src/lib/llm/sampling.ts` + `src/lib/calibration/sampling-drift.ts`, `registry.ts`, `launch.ts`, `scripts/calibration/run.ts`, `prisma/schema.prisma`). Re-verify any anchor you did not personally grep. Do not touch homelab-setup from a judge-arena task except where the plan explicitly says "separate PR in /root/homelab-setup".
- Any cluster/DB access in a plan step is READ-ONLY (psql SELECT, kubectl get/logs, rabbitmqctl list_queues). No requeue-peeks of judge.dlq (quorum delivery_limit 20 — every peek burns one).

---

## Commit shape (binding)

Exactly **two** commits land from this plan:

| commit | tasks | subject |
|---|---|---|
| A | Task 1 | `feat(calibration): reasoningTokens is usage-reported — report reasoning length instead` |
| B | Tasks 2 → 3 → 4 | `feat(llm): record parseMode on pairwise judgments — structured only when guided decoding needed no repair` |

Tasks 2 and 3 therefore end at a **checkpoint** (lint + tsc + the targeted test files green, working tree left dirty) rather than a commit; Task 4 runs the full gate chain and makes commit B. This is a deliberate deviation from "one commit per task": Tasks 2–4 are one concern (#11) and are committed together in Task 4. (Task 2 alone is inert — an unread `lenient` field — so splitting it out would not be a broken intermediate state, just a commit with no meaning of its own.) Under subagent-driven-development each of Tasks 3 and 4 starts from a dirty tree; their Step 0 expectations list exactly which files are expected modified.

## Facts every task relies on (re-verified against HEAD `33b7be4`, 2026-09-02)

- `reasoningTokens` is set in exactly one place, `src/lib/llm/openai-compatible.ts:263` (`response.usage?.completion_tokens_details?.reasoning_tokens`); `src/lib/llm/anthropic.ts:49-58` never sets it; the llamacpp/ollama descriptor modules contain only `structuredRequestFields`. Measured NULL on 30/30 llama.cpp (README.md:578) and on every Ollama granite run (register `:444-448`). It is therefore NULL on **all three** production backends. No tokenizer dependency exists; exact derivation is impossible; an estimate would be a fabricated number in a column documented as usage-reported (register `:393` — "Do not fix this by defaulting to 0").
- **The report already prints per-FAILURE reasoning length.** `scripts/calibration/run.ts:422` prints `reasoning=${cap(f.reasoningContent)}` for each of the first ten `status === 'error'` judgments, and `cap` (`:73-75`) returns `` `${v.length} chars` ``. So a granite4.2-shaped run already shows `reasoning=44287 chars` on each failing item. What is MISSING is the population each of those is compared against — the completed-row baseline (§5.2's `n=25 mean=13,138`) — which is why Task 1's new line is emitted **split by status** and not pooled. A single pooled line over all 30 rows would print `n=30 mean=18330 max=56004` and separate nothing: `18,330` is neither 13,138 nor 44,287, and it is exactly what "one judge that simply writes long" also prints.
- `parseMode` is produced only by the two pointwise parsers (`provider.ts:480` `'fallback'`, `:547` `'structured'`), chosen at `registry.ts:1133` (`parseJudgmentText`, defined at `:1097`; strict attempted only when `raw.structuredOutputRequested`), and written only by `persistSuccess` (`judgment-consumer.ts:771`). `structuredOutputRequested` is set by `openai-compatible.ts:210-214` for every `mode: 'judgment'` call to a descriptor whose `caps.structuredOutput !== 'none'`: llamacpp (`registry.ts:233`, `json_schema`) and ollama (`:289`, `json_schema`) qualify, openai (`:180`) and openrouter (`:201`) are `'none'`, vllm (`:215`) is `'guided'`, and anthropic (`:161`, `tool_use`) dispatches through `callAnthropic` which never sets the flag. So pairwise `'structured'` is reachable on both self-hosted production backends and never on Anthropic/openai/openrouter — identical to the pointwise rule pinned by `tests/lib/backends.test.ts:224-363` (the whole `describe('Structured-output parse seam: parseMode "structured" vs "fallback"')` — `:303-362` is only its last two cases) and `tests/lib/registry.test.ts:299`. Anthropic pairwise is the case that DISCRIMINATES the rule from a plausible wrong implementation, so Task 3 pins it DIRECTLY. It dispatches through `callAnthropic` (registry's `execute`: `descriptor.id === 'anthropic' ? callAnthropic : callOpenAICompatible` — cited by symbol), whose return object (`anthropic.ts:49-58`) simply omits `structuredOutputRequested`, so the new ternary lands on `'fallback'` via `undefined && …`. But its descriptor **caps are `tool_use`, NOT `'none'`** (`registry.ts:161`). So `prepared.descriptor.caps.structuredOutput !== 'none' && !parsed.lenient` is INDISTINGUISHABLE from the correct `raw.structuredOutputRequested && !parsed.lenient` on llamacpp (`json_schema`) and on openai (`'none'`), and would write `'structured'` for an Anthropic request that never carried a schema. **Therefore no comment this plan writes may define the rule as "descriptor caps not 'none'"** — that phrasing is the mis-implementation, and a comment stating it while also asserting "anthropic is never structured" is self-contradicting on its face. Every comment states the MECHANISM instead: `raw.structuredOutputRequested`, set only by `callOpenAICompatible`. Without an anthropic case every test in this plan stays green on the caps version while four documents this plan edits (schema comment, `PairwiseResult` docblock, README `:579`, runbook `parseMode` row) assert the opposite as fact. Hence Task 3 Step 3 Edit 3b adds an `@anthropic-ai/sdk` client mock and one assertion, and Step 7 Injection E is the caps-based swap. The mock precedent is `tests/lib/reasoning-capture.test.ts:33-37` (five lines, `messages: { create: … }`) — **NOT** `tests/lib/backends.test.ts`, which mocks only `openai` and `@/lib/llm/breaker-redis` (verified 2026-09-02: its only `anthropic` strings are an OpenRouter-routed model id at `:403` and a breaker key at `:406`).
- Seam count for #11 (grep-verified on `33b7be4`): `tryParsePairwiseJudgment` has ONE caller (`registry.ts:1217`); `defaultRunProviderPairwise` (`judgment-consumer.ts:476-501`) does `const result: RegistryPairwiseResult = await executePairwise(registryInput); return result;` — the registry object **unchanged** — and `src/lib/llm/index.ts` `executePairwise` passes it through, so a new `PairwiseResult.parseMode` reaches the consumer with no seam edit. The places that can silently drop it are the seam type (`judgment-consumer.ts:463-466`), `persistPairwiseSuccess` (`:817-832`), and — **not pinned by anything on HEAD** — that unchanged-passthrough itself: because `PairwiseJudgmentResult.parseMode` is optional, a later edit that maps fields explicitly there (the shape the pointwise/respond siblings have elsewhere) drops `parseMode` with tsc green, the unit tests green (they assert on the registry result, UPSTREAM of this function) and the integration test green (its fake REPLACES this function entirely). That is failure mode 14 with the fake sitting on the seam that would break, so Task 3 Step 3 Edit 3c adds one assertion in `tests/lib/judgment-consumer-escalation.test.ts` — which already imports the real `defaultRunProviderPairwise` with `@/lib/llm` mocked (`:41-45`, `executePairwiseMock` resolved at `:101`) — and Step 7 Injection F verifies it red. Because the seam field is optional, deleting the persist line ALSO type-checks green: **the integration assertion in Task 3 Step 1 is the only thing that catches that. Write it first.**
- `tests/lib/pairwise-execution.test.ts` already imports `@/worker/judgment-consumer` (line 35) with only `openai` and `@/lib/llm/breaker-redis` mocked, and only calls `commonSuccessUpdateData`, which never touches the realtime bus. Extending THAT file adds no coverage-denominator exposure. Do NOT create a second consumer-importing unit file.
- `scripts/calibration/run.ts` is outside every coverage `include` (`vitest.config.ts:37`) and no test references it; it IS lint-gated (`npm run lint` = `eslint src/ prisma/ scripts/ tests/`) and tsc-gated (`tsconfig.json:22` includes `**/*.ts`). The Docker image bundles it with esbuild (`Dockerfile:150-154`); `.dockerignore:72` promises it "pulls in `src/lib/calibration/**` and `@/lib/db` only" — the Task 1 helper lives under `src/lib/calibration/` and imports nothing, so that promise stays true.
- Prisma `//` comments generate no migration. Verify with `npx prisma validate` and an empty `migrate diff` (Task 1 Step 9; Task 4 Step 5).
- The pairwise integration fake (`tests/integration/pairwise-run.test.ts:113-124`) returns `{verdict, reasoning, rawResponse, latencyMs, tokenCount}` and its judge version is `servingBackend: 'openai'` (`:180`). `parseMode?` optional on `PairwiseJudgmentResult` keeps it compiling; giving it a value pins the persist write — `'fallback'`, because a single-value fake cannot distinguish a passthrough from a hardcoded/defaulted `'structured'`.
- Baseline of the three unit files touched by #11, MEASURED on `33b7be4` 2026-09-02: `npx vitest run tests/lib/judgment-schema-pairwise.test.ts tests/lib/pairwise-execution.test.ts tests/lib/judgment-consumer-escalation.test.ts` → 3 files, **45 tests** (25 + 14 + 6), all passing. (v2k did not touch any of them.)

---

### Task 1: #10 — `reasoningTokens` is usage-reported: document it, de-list it, report reasoning length instead

**Files:**
- Create: `src/lib/calibration/reasoning-length.ts`
- Create: `tests/lib/calibration-reasoning-length.test.ts`
- Modify: `scripts/calibration/run.ts:42-53` (import), `:331` (checklist entry), `:341-343` (the field loop, after which the new lines go), `:410` (one-judgment dump) — all measured on `33b7be4`
- Modify: `prisma/schema.prisma:520` (comment only)
- Modify: `README.md:578` (NOT `:594-622` — owned by `repetition-loop-detector`, see **Doc-range ownership**)
- Modify: `docs/runbooks/scoring-a-judge-against-a-golden-set.md:336-342` (sample block), `:348` (row)
- Modify: `docs/superpowers/plans/2026-09-01-scoreboard-handoff.md:374-375`
- Modify: `docs/superpowers/plans/2026-08-30-state-and-next-steps.md:392-395`, `:444-448`, `:668` (measured table row)
- Modify: `docs/superpowers/specs/2026-08-31-calibration-baseline-and-footprint.md:341` (measured table row)

**Interfaces:**
- Consumes: nothing new. `judgments[i].reasoningContent: string | null` AND `judgments[i].status` (`'pending' | 'running' | 'completed' | 'error'`), both already in the select at `run.ts:294`.
- Produces, all in `src/lib/calibration/reasoning-length.ts`: `export interface ReasoningLengthSummary { n: number; meanChars: number; maxChars: number }`, `export function summarizeReasoningLength(contents: readonly (string | null | undefined)[]): ReasoningLengthSummary | null`, and `export function formatReasoningLengthLine(summary: ReasoningLengthSummary | null, label: string): string`. The report LINE is formatted in the tested module, not in `scripts/calibration/run.ts` — that script is outside every vitest `include`, so a template written there has nothing behind it (see Step 6's **VERIFICATION LIMIT**).
- **Why `label` and why TWO lines.** §5.2's evidence is a SPLIT, not a pool: completed `n=25 mean=13,138` against failed `n=5 mean=44,287` (handoff `:231-235`). A single pooled line over the same run prints `n=30 mean=18330 max=56004`, which is neither number and cannot separate "five repetition loops" from "one judge that writes long" — the exact discrimination the feature exists to provide. So the report emits one line per terminal status (`completed`, `error`), and one unit fixture reproduces the 25/5 shape to prove the two lines differ where the pooled one does not. `pending`/`running` rows are deliberately not printed: the checklist line directly above already gives the total `n`, and a still-draining run has no length fact to compare. (Handoff open item #3, the loop-vs-truncation guard, may reuse the chars framing; nothing in this plan depends on it.)

- [ ] **Step 0: Re-anchor**

Run:
```bash
git -C /root/judge-arena status --short --untracked-files=no
grep -an "reasoningTokens" /root/judge-arena/scripts/calibration/run.ts
grep -an "for (const \[label, get\] of fields)" /root/judge-arena/scripts/calibration/run.ts
grep -an "reasoningTokens  Int?" /root/judge-arena/prisma/schema.prisma
```
Expected: no output from `status` (no tracked modifications; untracked `docs/superpowers/plans/2026-09-01-*.md` are expected and are never added by this plan, which is why every status check here uses `--untracked-files=no`); **three** run.ts hits — the select (`reasoningTokens: true`) at `:294`, the checklist entry `['reasoningTokens', (j) => j.reasoningTokens],` at `:331`, the dump line `reasoning=${first.reasoningTokens}` at `:410` — the field loop at `:341`, and one schema hit at `:520`. (Those are the post-v2k numbers, measured 2026-09-02; the pre-v2k `:278/:298/:377` this plan first quoted are dead. A number that misses is orientation drift — match on the `old_string` blocks below, which were re-verified verbatim.)

- [ ] **Step 1: Write the failing test**

Create `/root/judge-arena/tests/lib/calibration-reasoning-length.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatReasoningLengthLine, summarizeReasoningLength } from '@/lib/calibration/reasoning-length';

/**
 * #10 (handoff 2026-09-01 §7). `reasoningTokens` is usage-reported and NULL on
 * every backend this fleet runs, so the capture report stops counting it as a
 * capture failure and prints the length of the thinking channel instead.
 *
 * §5.2's signal was a SPLIT, not a pool: failed n=5 mean 44,287 chars against
 * completed n=25 mean 13,138 on the same run. Pooling those 30 rows gives
 * 18,330 — neither number, and indistinguishable from one judge that simply
 * writes long. So the report prints one line PER TERMINAL STATUS and the last
 * fixture below pins that the two lines differ where a pooled one would not.
 * (Per-FAILURE chars were already printed by `cap()` in the Failures block of
 * scripts/calibration/run.ts; what was missing is the completed-population
 * baseline to read them against.)
 *
 * Same null-not-zero contract as `summarizeLatencies`: an absent measurement
 * is `null`, never a row of zeros that reads as "the judge thought for 0
 * characters".
 */
describe('summarizeReasoningLength', () => {
  it('returns null, not zeros, when no judgment carried a reasoning channel', () => {
    expect(summarizeReasoningLength([])).toBeNull();
    expect(summarizeReasoningLength([null, undefined, null])).toBeNull();
  });

  it('ignores rows with no reasoningContent and summarises the rest', () => {
    // The maximum is deliberately FIRST, not last: with the longest row last,
    // `maxChars: lengths[lengths.length - 1]` (and `Math.max` over an
    // unfiltered map) give the right answer for the wrong reason, and no
    // injection here would catch it.
    const summary = summarizeReasoningLength(['abcdefghij', null, 'abcd', undefined, 'ab']);
    expect(summary).toEqual({ n: 3, meanChars: 5, maxChars: 10 });
  });

  it('counts an EMPTY reasoning channel as present with 0 chars (captured-but-empty is a fact, absent is another)', () => {
    expect(summarizeReasoningLength(['', 'abc'])).toEqual({ n: 2, meanChars: 2, maxChars: 3 });
  });

  it('rounds the mean to whole characters (7 + 8 -> 7.5 -> 8)', () => {
    expect(summarizeReasoningLength(['1234567', '12345678'])).toEqual({ n: 2, meanChars: 8, maxChars: 8 });
  });
});

/**
 * The report LINE is formatted here and NOT in scripts/calibration/run.ts,
 * which is outside every vitest `include` and therefore untestable: a swapped
 * mean/max, a dropped label or a dropped null branch written there would be
 * caught by nothing except an operator reading the output after a promote.
 * Keeping the template here shrinks that zero-verification surface to an
 * import, two filter/map expressions and two `console.log`s (Step 6
 * VERIFICATION LIMIT). What remains outside it — which status each line is
 * computed over — is the one thing no test in this file can see.
 */
describe('formatReasoningLengthLine', () => {
  it('prints the status label, then n, then mean, then max — in that order', () => {
    expect(formatReasoningLengthLine({ n: 25, meanChars: 13138, maxChars: 26549 }, 'completed')).toBe(
      '  reasoningContent chars   completed  n=25  mean=13138  max=26549'
    );
  });

  it('prints "none captured" for the null summary, never a row of zeros — and still carries the label', () => {
    expect(formatReasoningLengthLine(null, 'error')).toBe('  reasoningContent chars   error  none captured');
  });

  it('the STATUS SPLIT is what makes a repetition loop visible; a pooled line hides it (handoff §5.2)', () => {
    // The measured granite4.2 shape: 25 completed at ~13,138 chars, 5 failed
    // at ~44,287 (handoff §5.2's pg_column_size table). Uniform lengths so the
    // arithmetic is checkable by hand.
    const completed = Array.from({ length: 25 }, () => 'x'.repeat(13138));
    const failed = Array.from({ length: 5 }, () => 'x'.repeat(44287));

    expect(formatReasoningLengthLine(summarizeReasoningLength(completed), 'completed')).toBe(
      '  reasoningContent chars   completed  n=25  mean=13138  max=13138'
    );
    expect(formatReasoningLengthLine(summarizeReasoningLength(failed), 'error')).toBe(
      '  reasoningContent chars   error  n=5  mean=44287  max=44287'
    );

    // What the FIRST draft of this plan specified — one pooled line over all
    // 30 rows. 549,885 / 30 = 18,329.5 -> 18,330: neither population's mean,
    // and exactly what "one judge that writes long" also prints. This
    // assertion exists so that a future "simplification" back to a single
    // pooled line is red, not silently green.
    expect(formatReasoningLengthLine(summarizeReasoningLength([...completed, ...failed]), 'all')).toBe(
      '  reasoningContent chars   all  n=30  mean=18330  max=44287'
    );
  });
});
```

Arithmetic worked by hand (CONTRIBUTING.md:227-230): `['abcdefghij', 'abcd', 'ab']` → lengths 10, 4, 2 → n 3, sum 16, mean 5.33 → 5, max 10 (the max is the FIRST element, so a last-element implementation returns 2 and fails). `['', 'abc']` → 0, 3 → mean 1.5 → `Math.round` gives 2, max 3. `[7, 8]` → 7.5 → 8. The empty-string case is the one that discriminates `c == null` from a truthiness check — a `filter(Boolean)` implementation returns `{n:1, meanChars:3, maxChars:3}` and fails it. The split fixture: 25 × 13138 = 328,450 and 5 × 44,287 = 221,435; pooled sum 549,885 / 30 = 18,329.5, and `Math.round` rounds half UP to **18330** (JS rounds `.5` toward `+∞`, so this is 18330 and not 18329).

That last case is 7 tests in this file, not 6.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/judge-arena && npx vitest run tests/lib/calibration-reasoning-length.test.ts`
Expected: FAIL — `Failed Suites 1`, 0 tests run. With `@` aliased to a filesystem path in `vitest.config.ts`'s `resolve.alias`, vitest 3.2.4 prints EITHER `Error: Cannot find module '@/lib/calibration/reasoning-length' imported from '/root/judge-arena/tests/lib/calibration-reasoning-length.test.ts'` OR `Error: Failed to load url /root/judge-arena/src/lib/calibration/reasoning-length (resolved id: …). Does the file exist?` — this repo's own plan docs record both shapes (2026-08-17-a1 the former, 2026-08-12-a0 the latter). Both are the same missing-module red; do not hold out for one wording.

- [ ] **Step 3: Write minimal implementation**

Create `/root/judge-arena/src/lib/calibration/reasoning-length.ts`:

```ts
/**
 * Length of the captured thinking channel, summarised for the calibration
 * report (scripts/calibration/run.ts).
 *
 * WHY CHARS AND NOT TOKENS. `ModelJudgment.reasoningTokens` is usage-reported
 * (`usage.completion_tokens_details.reasoning_tokens`, read at
 * src/lib/llm/openai-compatible.ts) and is NULL on every backend this fleet
 * runs — llama.cpp and Ollama emit no `completion_tokens_details`, and the
 * Anthropic adapter never sets it. An exact derivation needs the served
 * model's tokenizer, which this process does not have; an estimate would be a
 * fabricated number under a column documented as measured. The character
 * length of `reasoningContent` IS available. §5.2's signal was the CONTRAST
 * between two populations of it — failed judgments at mean 44,287 chars with
 * empty content, against completed ones at mean 13,138 — so the report calls
 * this once per terminal status rather than once over the whole run: a single
 * pooled figure (18,330 on that run) is neither number and separates nothing.
 *
 * NULL-NOT-ZERO, same contract as `summarizeLatencies` (./latency.ts): no
 * judgment carried a reasoning channel → `null`, never `{n: 0, mean: 0}`,
 * which would read as "the judge thought for zero characters". An EMPTY
 * string is a present-but-empty channel and counts as 0 chars.
 */
export interface ReasoningLengthSummary {
  /** Judgments whose `reasoningContent` was captured (non-null). */
  n: number;
  /** Whole characters — the report prints this beside token counts. */
  meanChars: number;
  maxChars: number;
}

export function summarizeReasoningLength(
  contents: readonly (string | null | undefined)[]
): ReasoningLengthSummary | null {
  const lengths = contents.flatMap((c) => (c == null ? [] : [c.length]));
  if (lengths.length === 0) return null;

  const total = lengths.reduce((sum, n) => sum + n, 0);
  return {
    n: lengths.length,
    meanChars: Math.round(total / lengths.length),
    maxChars: Math.max(...lengths),
  };
}

/**
 * One capture-report line for one POPULATION of judgments, formatted HERE
 * rather than in `scripts/calibration/run.ts`: that script is outside every
 * vitest `include`, so a template written there has no test and no injection
 * behind it. Both arms are pinned by
 * tests/lib/calibration-reasoning-length.test.ts.
 *
 * `label` is the judgment status the summary was computed over. It is
 * REQUIRED, not defaulted: the whole value of this line is the comparison
 * between `completed` and `error`, and an unlabelled line is the pooled line
 * that §5.2 shows cannot separate a loop from a verbose judge.
 */
export function formatReasoningLengthLine(
  summary: ReasoningLengthSummary | null,
  label: string
): string {
  return summary
    ? `  reasoningContent chars   ${label}  n=${summary.n}  mean=${summary.meanChars}  max=${summary.maxChars}`
    : `  reasoningContent chars   ${label}  none captured`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /root/judge-arena && npx vitest run tests/lib/calibration-reasoning-length.test.ts`
Expected: PASS — 7 tests (4 `summarizeReasoningLength` + 3 `formatReasoningLengthLine`).

- [ ] **Step 5: Injection**

Break: in `src/lib/calibration/reasoning-length.ts` change `(c == null ? [] : [c.length])` to `(!c ? [] : [c.length])`.
Run: `cd /root/judge-arena && npx vitest run tests/lib/calibration-reasoning-length.test.ts`
Expected: FAIL — exactly one test, `counts an EMPTY reasoning channel as present…`, with `expected { n: 1, meanChars: 3, maxChars: 3 } to deeply equal { n: 2, meanChars: 2, maxChars: 3 }`.
Second injection: restore, then change `if (lengths.length === 0) return null;` to `if (lengths.length === 0) return { n: 0, meanChars: 0, maxChars: 0 };`.
Expected: FAIL — `returns null, not zeros…` with `expected { n: +0, meanChars: +0, maxChars: +0 } to be null` (vitest prints zero as `+0`).
Restore. Third injection (the max arm — the reason the second fixture puts its maximum FIRST): change `maxChars: Math.max(...lengths),` to `maxChars: lengths[lengths.length - 1],`.
Expected: FAIL — exactly one test, `ignores rows with no reasoningContent and summarises the rest`, with `expected { n: 3, meanChars: 5, maxChars: 2 } to deeply equal { n: 3, meanChars: 5, maxChars: 10 }`. (Every other fixture has its maximum last — including all three arrays in the split case — so they stay green, which is precisely why the second one was reordered.)
Restore the original line. Fourth injection (the formatter — the reason the template lives in this module and not in the untestable script): change `mean=${summary.meanChars}  max=${summary.maxChars}` to `mean=${summary.maxChars}  max=${summary.meanChars}`.
Expected: FAIL — exactly **2** tests: `prints the status label, then n, then mean, then max — in that order` (`expected '  reasoningContent chars   completed  n=25  mean=26549  max=13138' to be '… mean=13138  max=26549'`) and the split case, on its POOLED assertion (`mean=44287  max=18330` instead of `mean=18330  max=44287`). The split case's `completed` and `error` lines are uniform-length, so mean == max and the swap is invisible there — the pooled line is the one that catches it. The `none captured` arm interpolates neither number and stays green, which is why there are three formatter cases and not one.
Restore the original line. Fifth injection (the label — the whole point of the two-line design): change both template arms' `${label}` to `''` (i.e. delete the interpolation, leaving the double space).
Expected: FAIL — all **3** formatter cases, each `expected '  reasoningContent chars     n=25  …' to be '  reasoningContent chars   completed  n=25  …'`. A formatter that silently drops the label is the pooled line wearing two hats: both status lines would print identically and the report would look like it discriminates when it does not.
Restore the original lines. Re-run: PASS 7/7.

- [ ] **Step 6: Wire the report — `scripts/calibration/run.ts`**

**VERIFICATION LIMIT — read before editing.** `scripts/calibration/run.ts` is outside every vitest
`include` (`vitest.config.ts:37`) and is referenced by no test, so Edits 6a–6d have NO test and NO
injection. They are **lint-gated and tsc-gated only** (`tsconfig.json:22` includes `**/*.ts`).
The surface is deliberately made as small as it can be: the `reasoningContent chars` TEMPLATE, its
null branch and its label live in `formatReasoningLengthLine` (Step 3), which IS tested and IS
injected (Step 5, fourth and fifth injections), and the two-population DESIGN is pinned by the split
fixture (Step 1's third formatter case). What is left unverified here is an import, two
`.filter(...).map(...)` expressions, two `console.log`s, one checklist LABEL string and one
interpolation in the dump line. tsc catches a type error but not a mis-labelled line, a status
predicate written `!== 'completed'` instead of `=== 'error'`, or a dropped
`.map(j => j.reasoningContent)`; the sole behavioural verification of what remains is item 2 of the
**Post-promote checklist** — i.e. after the operator has pushed and promoted. Re-read each
replacement against the `old_string` character by character; there is no safety net behind it.

Edit 6a — import. Match:
```ts
import { scoreCalibrationRun } from '@/lib/calibration/score';
```
Replace with:
```ts
import { formatReasoningLengthLine, summarizeReasoningLength } from '@/lib/calibration/reasoning-length';
import { scoreCalibrationRun } from '@/lib/calibration/score';
```

Edit 6b — the checklist entry. Match:
```ts
    ['reasoningContent', (j) => j.reasoningContent],
    ['reasoningTokens', (j) => j.reasoningTokens],
    ['inputTokens', (j) => j.inputTokens],
```
Replace with:
```ts
    ['reasoningContent', (j) => j.reasoningContent],
    // #10 (handoff 2026-09-01 §7): usage-reported, and NULL on every backend
    // this fleet runs — llama.cpp and Ollama send no completion_tokens_details,
    // the Anthropic adapter never sets it. Kept as a LABELLED line rather than
    // deleted so a backend that does emit the split (vLLM, OpenAI-shaped)
    // still shows a regression here; 0/n on the self-hosted fleet is expected,
    // not a capture failure. Reasoning LENGTH is printed after this loop.
    ['reasoningTokens (usage-reported; expected 0/n on llama.cpp/Ollama)', (j) => j.reasoningTokens],
    ['inputTokens', (j) => j.inputTokens],
```

Edit 6c — the chars line after the loop. Match:
```ts
  for (const [label, get] of fields) {
    console.log(`  ${label.padEnd(18)} ${judgments.filter((j) => get(j) != null).length}/${judgments.length}`);
  }
```
Replace with:
```ts
  for (const [label, get] of fields) {
    console.log(`  ${label.padEnd(18)} ${judgments.filter((j) => get(j) != null).length}/${judgments.length}`);
  }

  // The signal that IS available on every backend: how much the judge wrote
  // in its thinking channel. SPLIT BY STATUS, because §5.2 of the 2026-09-01
  // handoff read a CONTRAST, not a total — failed n=5 mean 44,287 chars with
  // empty content against completed n=25 mean 13,138. Pooled, that same run
  // prints n=30 mean=18330, which is neither figure and is exactly what a
  // judge that merely writes long also prints. The Failures block below
  // already shows each failing item's chars via cap(); these two lines give
  // the completed-population baseline to read them against, in the report
  // rather than only in a psql session. Template, label and null branch are
  // in the TESTED module, not in this untestable file.
  for (const status of ['completed', 'error'] as const) {
    console.log(
      formatReasoningLengthLine(
        summarizeReasoningLength(judgments.filter((j) => j.status === status).map((j) => j.reasoningContent)),
        status
      )
    );
  }
```
(`status` is already in the `findMany` select at `run.ts:294`, and `judgments.filter((j) => j.status === 'error')` is already used further down for the Failures block — so this adds no query and no new column. `pending`/`running` rows are intentionally not printed; the checklist line above already reports the total `n`.)

Edit 6d — the one-judgment dump. Match:
```ts
    console.log(`  tokens in=${first.inputTokens} out=${first.outputTokens} reasoning=${first.reasoningTokens}   latency ${first.latencyMs}ms`);
```
Replace with:
```ts
    console.log(`  tokens in=${first.inputTokens} out=${first.outputTokens} reasoning=${first.reasoningTokens} reasoningChars=${first.reasoningContent?.length ?? 'n/a'}   latency ${first.latencyMs}ms`);
```

- [ ] **Step 7: Schema comment (comment-only, no migration) — `prisma/schema.prisma:520`**

Match:
```prisma
  reasoningContent String?
  reasoningTokens  Int? // usage.completion_tokens_details.reasoning_tokens
  reasoningSource  String? // 'reasoning_content' | 'reasoning' | 'think_tag' | 'anthropic_thinking'
```
Replace with:
```prisma
  reasoningContent String?
  // usage.completion_tokens_details.reasoning_tokens — USAGE-REPORTED, read in
  // src/lib/llm/openai-compatible.ts only. Populated solely when the server
  // emits the OpenAI usage split. NULL on llama.cpp and on Ollama (measured
  // 2026-08-31 / 2026-09-01, 0/n on every run) and never set by the Anthropic
  // adapter — i.e. NULL on every backend this fleet runs today. Do NOT default
  // it to 0: a real zero and an absent measurement are different facts. For a
  // size signal use `length(reasoningContent)`, and compare the completed
  // rows against the error rows rather than pooling them — that contrast is
  // what identified the 2026-09-01 repetition loop (handoff §5.2: failed mean
  // 44,287 chars vs completed 13,138). scripts/calibration/run.ts prints both
  // populations under "Capture completeness".
  reasoningTokens  Int?
  reasoningSource  String? // 'reasoning_content' | 'reasoning' | 'think_tag' | 'anthropic_thinking'
```

- [ ] **Step 8: Docs with CORRECTION notes (#10 rows only — the `parseMode` rows belong to Task 4)**

Edit 8a — `README.md:578`. Match the whole table row:
```markdown
| `reasoningTokens` | **NULL, 30/30** | Read from `usage.completion_tokens_details.reasoning_tokens` (`src/lib/llm/openai-compatible.ts:263`). llama.cpp does not emit `completion_tokens_details` in its usage payload at all, so there is nothing to read. It is not dropped on the floor — it was never sent. |
```
Replace with:
```markdown
| `reasoningTokens` | **NULL, 30/30** | Read from `usage.completion_tokens_details.reasoning_tokens` (`src/lib/llm/openai-compatible.ts`). llama.cpp does not emit `completion_tokens_details` in its usage payload at all, so there is nothing to read. It is not dropped on the floor — it was never sent. **CORRECTION (2026-09-01):** this row read as a llama.cpp-only gap. Ollama sends nothing either (NULL on every granite run) and the Anthropic adapter never sets the field, so it is NULL on **every** backend this fleet runs. Decision: keep the column (it is a real measurement wherever the split is emitted), never default it to 0, and stop counting it as a capture failure — the calibration report now labels it usage-reported and instead prints `reasoningContent` length (n / mean / max chars) **for the completed rows and the error rows as two separate lines**. That contrast is what §5.2 of the 2026-09-01 handoff read to identify the repetition loop (failed mean 44,287 vs completed 13,138); a pooled figure over the same run is 18,330 and identifies nothing. |
```

Edit 8b — (removed 2026-09-01 on review: the stale `assertUsableContent` `:507-580` reference at `README.md:598` sits inside §"Truncation is now a HARD FAILURE", `README.md:594-622`, which is owned by the `repetition-loop-detector` plan. Do NOT touch it here — see **Doc-range ownership**.)

Edit 8c — runbook `docs/runbooks/scoring-a-judge-against-a-golden-set.md:336-348`. Match the sample block and the `reasoningTokens` row (leave the `parseMode` row at `:349` alone — Task 4 owns it). The inner ``` lines ARE part of the `old_string`/`new_string` (the block is 7 lines, opening ``` through closing ```); the outer four-backtick fences are plan formatting only:
````markdown
```
── Capture completeness (30 judgments) ──
  systemPrompt       30/30
  userPrompt         30/30
  ...
  reasoningTokens     0/30
```
````
Replace with:
````markdown
```
── Capture completeness (30 judgments) ──
  systemPrompt       30/30
  userPrompt         30/30
  ...
  reasoningTokens (usage-reported; expected 0/n on llama.cpp/Ollama) 0/30
  ...
  reasoningContent chars   completed  n=25  mean=13138  max=26549
  reasoningContent chars   error  n=5  mean=44287  max=56004
```
````
(One space before `0/30`: the template is `${label.padEnd(18)} ${count}/${n}` and the new label is 66 chars, so `padEnd(18)` is a no-op. The two chars lines show the granite4.2 run of handoff §5.2 — a clean run prints an `error` line reading `none captured`.)
And match:
```markdown
| `reasoningTokens` | **0/n on llama.cpp** | its `usage` payload carries no `completion_tokens_details`. Nothing was dropped; the field was never sent. **Do not "fix" it by defaulting to 0** — a real 0 and an absent measurement are different facts |
```
Replace with:
```markdown
| `reasoningTokens` | **0/n on llama.cpp AND Ollama** (and never set for Anthropic) | its `usage` payload carries no `completion_tokens_details`. Nothing was dropped; the field was never sent. **Do not "fix" it by defaulting to 0** — a real 0 and an absent measurement are different facts. **CORRECTION (2026-09-01):** this row said llama.cpp only; Ollama sends nothing either and the Anthropic adapter never sets it. The line is now labelled usage-reported in the report, and the two `reasoningContent chars` lines beneath the checklist — one for `completed` rows, one for `error` rows — are the size signal to read. **Compare the two lines, do not read either alone:** an `error` mean several times the `completed` mean, with `content length 0` failures, is the repetition-loop signature (handoff 2026-09-01 §5.2 measured 44,287 vs 13,138), not a `max_tokens` problem. Pooling the two hides it — the same run pools to 18,330 |
```

Edit 8d — handoff `docs/superpowers/plans/2026-09-01-scoreboard-handoff.md:374-375`. Match:
```markdown
10. **`reasoningTokens` is NULL on every self-hosted backend** — llama.cpp and Ollama both. It is
    dead weight in the capture report rather than a per-backend gap. Derive it or drop it.
```
Replace with:
```markdown
10. **`reasoningTokens` is NULL on every self-hosted backend** — llama.cpp and Ollama both. It is
    dead weight in the capture report rather than a per-backend gap. Derive it or drop it.
    **CLOSED 2026-09-01 — neither.** It is NULL on the Anthropic adapter too, so "self-hosted" was an
    understatement. Derivation is impossible without the served model's tokenizer and an estimate
    would be a fabricated number under a usage-reported column; dropping touches four seams and
    eleven test assertions to remove a real measurement on any OpenAI-shaped server. Documented on
    the schema, de-listed as a capture failure in the report (labelled usage-reported), and the
    report now prints `reasoningContent` length beside it as TWO lines — `completed` and `error`.
    The contrast between them is §5.2's loop signal (44,287 vs 13,138); a pooled line would print
    18,330 and show nothing. Per-failure chars were already printed by `cap()` in the Failures
    block; what was missing was the completed-population baseline.
```

Edit 8e — register `docs/superpowers/plans/2026-08-30-state-and-next-steps.md:392-395`. Match:
```markdown
2. **`reasoningTokens` is unavailable from llama.cpp.** 0/30 on the baseline run, because its `usage`
   payload has no `completion_tokens_details`. **Do not "fix" this by defaulting to 0** — a real zero
   and an absent measurement are different facts, and the field will populate on backends that emit
   it. Worth confirming what Ollama sends before the next run reads the same column.
```
Replace with:
```markdown
2. **`reasoningTokens` is unavailable from llama.cpp.** 0/30 on the baseline run, because its `usage`
   payload has no `completion_tokens_details`. **Do not "fix" this by defaulting to 0** — a real zero
   and an absent measurement are different facts, and the field will populate on backends that emit
   it. Worth confirming what Ollama sends before the next run reads the same column.
   **CLOSED 2026-09-01** (with §5.6 item 9): documented on the schema as usage-reported and NULL on
   llama.cpp, Ollama and Anthropic; de-listed as a capture failure in the report; not defaulted, not
   derived, not dropped. See the 2026-09-01 handoff §7 item 10.
```
And match `:444-448`:
```markdown
9. **`reasoningTokens` from Ollama — now answerable.** Item 2 above asked what Ollama sends. It sends
   nothing either: the column is NULL across all granite runs, same as llama.cpp. So the field is
   currently unpopulated on *every* self-hosted backend, which makes it dead weight in the capture
   completeness report rather than a gap in one backend. Decide whether to derive it or drop it from
   the checklist.
```
Replace with:
```markdown
9. **`reasoningTokens` from Ollama — now answerable.** Item 2 above asked what Ollama sends. It sends
   nothing either: the column is NULL across all granite runs, same as llama.cpp. So the field is
   currently unpopulated on *every* self-hosted backend, which makes it dead weight in the capture
   completeness report rather than a gap in one backend. Decide whether to derive it or drop it from
   the checklist.
   **CLOSED 2026-09-01 — kept, labelled.** Not derived (no tokenizer; an estimate is a fabricated
   measurement) and not dropped (real on OpenAI-shaped servers; four seams and eleven assertions to
   remove). The checklist line is now labelled usage-reported with the expected 0/n, and the report
   prints `reasoningContent` chars (n/mean/max) as two lines, `completed` and `error`. It is the
   CONTRAST between those two that separated the granite4.2 loop from truncation (§5.2: 44,287 vs
   13,138); one pooled line over the same run reads 18,330 and separates nothing.
```

Edit 8f — the two measured-table rows that still state the #10 claim (the `parseMode` rows directly beneath each belong to Task 4 Edit 3h). Register `docs/superpowers/plans/2026-08-30-state-and-next-steps.md:668`. Match the whole row:
```markdown
| `reasoningTokens` | **NULL on 30/30** | Read from `usage.completion_tokens_details.reasoning_tokens`. llama.cpp does not emit `completion_tokens_details` at all — nothing was dropped, nothing was sent |
```
Replace with:
```markdown
| `reasoningTokens` | **NULL on 30/30** | Read from `usage.completion_tokens_details.reasoning_tokens`. llama.cpp does not emit `completion_tokens_details` at all — nothing was dropped, nothing was sent. **CORRECTION (2026-09-01):** also NULL on Ollama and never set by the Anthropic adapter — usage-reported, kept, labelled in the report; see handoff 2026-09-01 §7 item 10 |
```
Baseline spec `docs/superpowers/specs/2026-08-31-calibration-baseline-and-footprint.md:341`. Match the whole row:
```markdown
| `reasoningTokens` | **NULL on 30/30** | Read from `usage.completion_tokens_details.reasoning_tokens`. **llama.cpp does not emit `completion_tokens_details` at all** — nothing was dropped and nothing was mis-parsed; the field was never sent. Expect it to be non-null on backends that do emit it, so do not "fix" this by defaulting it to 0: a real 0 and an absent measurement are different facts |
```
Replace with:
```markdown
| `reasoningTokens` | **NULL on 30/30** | Read from `usage.completion_tokens_details.reasoning_tokens`. **llama.cpp does not emit `completion_tokens_details` at all** — nothing was dropped and nothing was mis-parsed; the field was never sent. Expect it to be non-null on backends that do emit it, so do not "fix" this by defaulting it to 0: a real 0 and an absent measurement are different facts. **CORRECTION (2026-09-01):** also NULL on Ollama and never set by the Anthropic adapter — usage-reported, kept, labelled in the report; see handoff 2026-09-01 §7 item 10 |
```

- [ ] **Step 9: Gates**

```bash
cd /root/judge-arena
npm run lint                     # 0 problems, 0 warnings
npx tsc --noEmit                 # 0
npx prisma validate              # "The schema at prisma/schema.prisma is valid" — needs no database
# The comment-only schema edit must produce NO migration. That check is a `prisma migrate diff`
# against the LOCAL podman DB, and it is only meaningful once judge_arena_test sits at the migration
# chain state — which `npm run test:db:coverage` guarantees. It is therefore made ONCE, in Task 4
# Step 4, immediately AFTER that run. You MAY run it here as well (it is read-only) if the local DB
# happens to be migrated already. This is the FIRST command in the plan that points a prisma CLI at
# whatever DATABASE_URL is in .env.test, so the Global Constraint's check comes first even though
# `migrate diff` is read-only:
grep DATABASE_URL /root/judge-arena/.env.test   # must be localhost:5432 (podman judge-arena-pg), NOT the k8s judge-arena-pg-1
sh -c 'set -a; . ./.env.test; set +a; npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script'
#   Expected: "-- This is an empty migration."
#   If it errors because the local DB was never migrated in this checkout, SKIP it — do NOT run
#   `npm run test:db` to seed one. That is an extra `prisma migrate reset --force` of the single
#   shared, NOT concurrency-safe judge_arena_test, for a check Task 4 Step 4 makes anyway.
npm run test:coverage            # PREDICTED 895 unit / 58 files (888 measured + 7 new; one new file), floors green
#   The 888/57 is a measurement (33b7be4, 2026-09-02); the 895/58 is arithmetic on it. If the printed
#   number differs, the printed number is the truth — investigate the delta, then use the real one.
# NOTE: do NOT use a `':!docs/superpowers/plans/2026-09-01-*.md'` exclude pathspec here.
# `2026-09-01-scoreboard-handoff.md` is a TRACKED file that this task modifies and commits
# (the nine capture-field-gaps-era plan docs are the UNTRACKED ones), so that pathspec would
# hide a file under review. Two commands instead:
git -C /root/judge-arena status --short --untracked-files=no
#   exactly 7: M scripts/calibration/run.ts, M prisma/schema.prisma, M README.md,
#   M docs/runbooks/scoring-a-judge-against-a-golden-set.md,
#   M docs/superpowers/plans/2026-09-01-scoreboard-handoff.md,
#   M docs/superpowers/plans/2026-08-30-state-and-next-steps.md,
#   M docs/superpowers/specs/2026-08-31-calibration-baseline-and-footprint.md
git -C /root/judge-arena status --short -- src/lib/calibration/reasoning-length.ts tests/lib/calibration-reasoning-length.test.ts
#   exactly 2: ?? the new module, ?? its test

# A FILE COUNT CANNOT PROVE THE EDITS LANDED. Two of Step 8's edits (8e's two register blocks, and
# 8f's register row) live in ONE already-modified file, so applying 8e and silently skipping 8f
# still leaves exactly 7 modified files and a clean-looking status — and the register would then
# carry a CLOSED note in §5.6 while its own measured table still asserts the corrected-away claim.
# Count per FILE, expected count stated. The BASELINE column is what each file already had on
# 33b7be4 (Wave 1 and Wave 2 both wrote 2026-09-01 CORRECTION notes into these files), measured
# 2026-09-02 — so the check is "baseline + this task's delta", never "> 0".
#                                                                             baseline -> after A
grep -acE 'CORRECTION \(?2026-09-01' README.md                                                              #  0 -> 1  (8a)
grep -acE 'CORRECTION \(?2026-09-01' docs/runbooks/scoring-a-judge-against-a-golden-set.md                   #  1 -> 2  (8c row)
grep -acE 'CORRECTION \(?2026-09-01' docs/superpowers/plans/2026-08-30-state-and-next-steps.md               #  1 -> 2  (8f register row)
grep -acE 'CORRECTION \(?2026-09-01' docs/superpowers/specs/2026-08-31-calibration-baseline-and-footprint.md #  0 -> 1  (8f baseline row)
grep -ac 'CLOSED 2026-09-01' docs/superpowers/plans/2026-09-01-scoreboard-handoff.md                         #  0 -> 1  (8d)
grep -ac 'CLOSED 2026-09-01' docs/superpowers/plans/2026-08-30-state-and-next-steps.md                       #  0 -> 2  (8e §5.5/2 AND §5.6/9 — the pair a file count cannot separate)
grep -acF 'reasoningContent chars   completed' docs/runbooks/scoring-a-judge-against-a-golden-set.md         #  0 -> 1  (8c sample block)
grep -acF "['reasoningTokens (usage-reported; expected 0/n on llama.cpp/Ollama)'" scripts/calibration/run.ts #  0 -> 1  (6b)
grep -acF 'formatReasoningLengthLine' scripts/calibration/run.ts                                             #  0 -> 2  (6a import + 6c call)
grep -acF 'reasoningChars=' scripts/calibration/run.ts                                                       #  0 -> 1  (6d)
```
(`-E` rather than a fixed string because Task 4 Edit 3c writes `CORRECTION 2026-09-01:` without
parentheses while the others use `CORRECTION (2026-09-01):` — a fixed-string `-c` would silently
undercount it, which is the same substring trap as failure mode 3. Every baseline above was measured
on `33b7be4`. `grep -a` is habit, not necessity, on these files: the NUL-byte files are
`src/lib/calibration/readings.ts` and `scripts/importer/reconcile.ts`, neither of which this task
touches — never remove those NULs.)
**Do NOT run `npm run test:db:coverage`, `npm run test:integration` or `npm run build` here.**
CONTRIBUTING.md:1640-1645 requires the full chain per PR, not per commit, and Task 4 Step 4 runs it
once for the branch. Commit A reaches no `tests/db/**` file, no `tests/integration/**` file
(`vitest.integration.config.ts` has no coverage block at all) and no Next build —
`scripts/calibration/run.ts` is outside it, and `npx tsc --noEmit` above already type-checks it.

The one db-side effect worth naming, so that skipping the run is a decision and not an oversight:
the new `src/lib/calibration/reasoning-length.ts` enters `vitest.db.config.ts`'s `src/lib/**/*.ts`
coverage denominator uncovered (that run does not import it), moving the db aggregate down by
roughly 0.02pp. Against the db-run floors — statements 47, branches 77, functions 60, lines 47
(`vitest.db.config.ts:150-153`) — on actuals statements 49.55 / branches 79.59 / functions 63.19 /
lines 49.55, that is a ~2.5pp margin. A 0.02pp move cannot change that gate's outcome under any
circumstance, so buying it here costs one `prisma migrate reset --force` plus 674 tests for zero
decision value; and `judge_arena_test` is a single shared database whose suite is NOT
concurrency-safe, so every extra reset is another window in which a concurrent run is clobbered.
Task 4 Step 4 measures the real number once, for the branch.

- [ ] **Step 10: Commit A**

```bash
cd /root/judge-arena
git -C /root/judge-arena add src/lib/calibration/reasoning-length.ts tests/lib/calibration-reasoning-length.test.ts scripts/calibration/run.ts prisma/schema.prisma README.md docs/runbooks/scoring-a-judge-against-a-golden-set.md docs/superpowers/plans/2026-09-01-scoreboard-handoff.md docs/superpowers/plans/2026-08-30-state-and-next-steps.md docs/superpowers/specs/2026-08-31-calibration-baseline-and-footprint.md
git -C /root/judge-arena commit -F - <<'EOF'
feat(calibration): reasoningTokens is usage-reported — report reasoning length instead

Handoff 2026-09-01 §7 item 10 asked to derive or drop `reasoningTokens`,
which is NULL on llama.cpp and Ollama. Neither, and the framing was an
understatement: the only writer is openai-compatible.ts reading
`usage.completion_tokens_details.reasoning_tokens`, the Anthropic adapter
never sets it, so the column is NULL on every backend this fleet runs.

Derivation is impossible without the served model's tokenizer (none in the
tree; Qwen and granite tokenize differently), and an estimate from
outputTokens × chars ratio would be a fabricated number under a column
documented as measured — the register's own "do not default to 0" rule.
Dropping removes a real measurement on any OpenAI-shaped server and touches
four seams plus eleven test assertions to save one NULL.

So: the schema comment now states every NULL case and the do-not-default
rule; the calibration report labels the checklist line as usage-reported
with the expected 0/n instead of counting it as a capture failure; and two
new `reasoningContent chars` lines (n / mean / max, one for the completed
rows and one for the error rows, via a pure summarizeReasoningLength with
the same null-not-zeros contract as summarizeLatencies, and a
formatReasoningLengthLine that keeps the template and its label inside the
tested module rather than in the untestable CLI script) print the CONTRAST
§5.2 actually read: failed n=5 mean 44,287 chars with empty content against
completed n=25 mean 13,138. Two lines and not one, because a pooled figure
over that run is 18,330 — neither population, and identical to what a judge
that merely writes long prints. Per-failure chars were already shown by
cap() in the Failures block; the completed-population baseline to compare
them against is what was missing. The one-judgment dump prints
reasoningChars beside the token counts.

Docs: README, runbook, register and baseline-spec rows carried CORRECTION
notes rather than being rewritten — they said llama.cpp only. Handoff #10
and register §5.5/2 and §5.6/9 are marked closed with the decision.

Gates: lint 0, tsc 0, 895 unit / n-a db / n-a integration, coverage 0.
(test:db:coverage, test:integration and npm run build are run once for the
branch in Task 4 Step 4 — nothing in this commit reaches tests/db/**,
tests/integration/** or the Next build, and CONTRIBUTING.md's gate rule is
per-PR, not per-commit. Named absences, not omitted slots.)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
EOF
git -C /root/judge-arena log -1 --stat
```
(The `895` above is the PREDICTION from Step 9, not a measurement. If `npm run test:coverage` reported a different unit count, put the real number in the `Gates:` line — never the predicted one — and say in one line why it differed.)

---

### Task 2: #11a — `tryParsePairwiseJudgment` reports whether it had to be lenient

**Files:**
- Modify: `src/lib/llm/judgment-schema.ts:112-118` (type), `:134-149` (doc), `:150-172` (parser)
- Test: `tests/lib/judgment-schema-pairwise.test.ts:32-83`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `ParsedPairwiseJudgment` gains `lenient: boolean` — `true` when a markdown fence was stripped OR `normalizeVerdict` changed the verdict string (case/whitespace); `false` when the trimmed text parsed as-is with a canonical verdict. Task 3 reads `parsed.lenient`.

- [ ] **Step 0: Re-anchor**

Run: `grep -an "export interface ParsedPairwiseJudgment\|export function tryParsePairwiseJudgment\|return { verdict, reasoning: record.reasoning }" /root/judge-arena/src/lib/llm/judgment-schema.ts`
Expected: three hits (HEAD: 115, 150, 171). `git -C /root/judge-arena status --short --untracked-files=no` → no output (Task 1 committed; the untracked plan docs are expected).

- [ ] **Step 1: Write the failing tests**

In `/root/judge-arena/tests/lib/judgment-schema-pairwise.test.ts`, update the seven whole-shape `toEqual` calls and add a `lenient` block. Replace the entire `describe('tryParsePairwiseJudgment: conforming responses', …)` block (HEAD lines 32-83) with:

```ts
describe('tryParsePairwiseJudgment: conforming responses', () => {
  it('parses a bare JSON object', () => {
    expect(tryParsePairwiseJudgment('{"verdict":"A","reasoning":"A is more accurate"}')).toEqual({
      verdict: 'A',
      reasoning: 'A is more accurate',
      lenient: false,
    });
  });

  it('parses B', () => {
    expect(tryParsePairwiseJudgment('{"verdict":"B","reasoning":"B is complete"}')).toEqual({
      verdict: 'B',
      reasoning: 'B is complete',
      lenient: false,
    });
  });

  it('parses tie', () => {
    expect(tryParsePairwiseJudgment('{"verdict":"tie","reasoning":"neither wins"}')).toEqual({
      verdict: 'tie',
      reasoning: 'neither wins',
      lenient: false,
    });
  });

  it('strips a ```json markdown fence, like parseJudgmentResponse does — and reports it as lenient', () => {
    const raw = 'Here you go:\n```json\n{"verdict":"B","reasoning":"clearer"}\n```\n';
    expect(tryParsePairwiseJudgment(raw)).toEqual({ verdict: 'B', reasoning: 'clearer', lenient: true });
  });

  it('strips a bare ``` fence too — lenient', () => {
    const raw = '```\n{"verdict":"A","reasoning":"r"}\n```';
    expect(tryParsePairwiseJudgment(raw)).toEqual({ verdict: 'A', reasoning: 'r', lenient: true });
  });

  it('normalizes verdict casing and surrounding whitespace', () => {
    expect(tryParsePairwiseJudgment('{"verdict":" a ","reasoning":"r"}')?.verdict).toBe('A');
    expect(tryParsePairwiseJudgment('{"verdict":"b","reasoning":"r"}')?.verdict).toBe('B');
    expect(tryParsePairwiseJudgment('{"verdict":"TIE","reasoning":"r"}')?.verdict).toBe('tie');
    expect(tryParsePairwiseJudgment('{"verdict":"Tie","reasoning":"r"}')?.verdict).toBe('tie');
  });

  it('accepts an empty-string reasoning (present and a string is the contract)', () => {
    expect(tryParsePairwiseJudgment('{"verdict":"A","reasoning":""}')).toEqual({
      verdict: 'A',
      reasoning: '',
      lenient: false,
    });
  });

  it('ignores extra properties the model volunteers — and does NOT count them as lenient (extra keys are not repair)', () => {
    expect(
      tryParsePairwiseJudgment('{"verdict":"A","reasoning":"r","confidence":0.9}')
    ).toEqual({ verdict: 'A', reasoning: 'r', lenient: false });
  });
});

/**
 * #11 (handoff 2026-09-01 §7). `lenient` is the pairwise mirror of the
 * pointwise strict-then-lenient demotion: TRUE whenever the parser had to
 * REPAIR the text to read it — a fence was stripped, or the verdict needed
 * case/whitespace normalisation. registry.ts turns this into
 * `parseMode: 'structured' | 'fallback'`. The whole point is that a
 * guided-decoding backend whose output needed no repair is distinguishable,
 * afterwards, from one that wrapped its JSON in ``` or wrote "a".
 */
describe('tryParsePairwiseJudgment: the lenient flag', () => {
  it('is false for bare JSON with a canonical verdict', () => {
    expect(tryParsePairwiseJudgment('{"verdict":"tie","reasoning":"r"}')?.lenient).toBe(false);
  });

  it('is true when a ```json fence had to be stripped, even with a canonical verdict', () => {
    expect(tryParsePairwiseJudgment('```json\n{"verdict":"A","reasoning":"r"}\n```')?.lenient).toBe(true);
  });

  it('is true when the verdict needed case repair ("a", "TIE", "Tie")', () => {
    expect(tryParsePairwiseJudgment('{"verdict":"a","reasoning":"r"}')?.lenient).toBe(true);
    expect(tryParsePairwiseJudgment('{"verdict":"TIE","reasoning":"r"}')?.lenient).toBe(true);
    expect(tryParsePairwiseJudgment('{"verdict":"Tie","reasoning":"r"}')?.lenient).toBe(true);
  });

  it('is true when the verdict needed whitespace repair (" A ")', () => {
    expect(tryParsePairwiseJudgment('{"verdict":" A ","reasoning":"r"}')?.lenient).toBe(true);
  });

  it('is false when only the OUTER text had surrounding whitespace (trim is not repair of the verdict)', () => {
    expect(tryParsePairwiseJudgment('  \n{"verdict":"B","reasoning":"r"}\n  ')?.lenient).toBe(false);
  });
});
```

Leave the `PAIRWISE_JUDGMENT_JSON_SCHEMA` block (HEAD 8-30) and the non-conforming block (HEAD 85-108) untouched — `toBeNull()` assertions do not change shape.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/judge-arena && npx vitest run tests/lib/judgment-schema-pairwise.test.ts`
**Do NOT run `npx tsc --noEmit` here** — `lenient` does not exist on `ParsedPairwiseJudgment` until Step 3, so tsc reports ~5 `Property 'lenient' does not exist on type 'ParsedPairwiseJudgment'` errors in this test file. That is EXPECTED red, not a broken plan; tsc is next run at Step 6, after Edit 3a adds the field. (Same carve-out, same reason, as Task 3 Step 4.)
Expected: FAIL — 7 `toEqual` cases fail with `expected { verdict: 'A', reasoning: '…' } to deeply equal { verdict: 'A', reasoning: '…', lenient: false }` (or `lenient: true` for the two fence cases), and the 5 new `lenient` cases fail with `expected undefined to be false` / `expected undefined to be true`. The schema block, the `normalizes verdict casing and surrounding whitespace` case (it asserts `?.verdict` only, so its shape is unchanged) and the 13 null cases stay green — **18 green / 12 red of 30**.

- [ ] **Step 3: Write minimal implementation**

In `/root/judge-arena/src/lib/llm/judgment-schema.ts`:

Edit 3a — the type. Match:
```ts
/** A parsed pairwise verdict — the output of `tryParsePairwiseJudgment`,
 * before call metadata is merged in by `registry.ts`'s
 * `executePairwiseCall`. */
export interface ParsedPairwiseJudgment {
  verdict: 'A' | 'B' | 'tie';
  reasoning: string;
}
```
Replace with:
```ts
/** A parsed pairwise verdict — the output of `tryParsePairwiseJudgment`,
 * before call metadata is merged in by `registry.ts`'s
 * `executePairwiseCall`. */
export interface ParsedPairwiseJudgment {
  verdict: 'A' | 'B' | 'tie';
  reasoning: string;
  /** TRUE when the parser had to REPAIR the text to read it: a markdown fence
   * was stripped, or the verdict string needed case/whitespace normalisation
   * (`"a"`, `" TIE "`). FALSE when the trimmed text parsed as-is with a
   * canonical verdict. Extra keys the model volunteers are ignored and do NOT
   * count as repair. `registry.ts`'s `executePairwiseCall` combines this with
   * whether a schema was attached to the request to record
   * `ModelJudgment.parseMode` — the pairwise mirror of the pointwise
   * strict-then-lenient demotion. */
  lenient: boolean;
}
```

Edit 3b — the doc comment. Match:
```ts
/**
 * Parse a pairwise judge response into `{verdict, reasoning}`, or `null`.
 *
 * ONE parse path, unlike the pointwise pair (`tryParseStructuredJudgment`
 * strict, `parseJudgmentResponse` lenient — see provider.ts). This function
 * is deliberately fence-tolerant on its own (a model that wraps its JSON in
 * ```json despite guided decoding is still conforming enough), so there is
 * no strict-then-lenient demotion to record and no `parseMode` to persist
 * for a pairwise judgment.
 *
```
Replace with:
```ts
/**
 * Parse a pairwise judge response into `{verdict, reasoning, lenient}`, or
 * `null`.
 *
 * ONE parse path, unlike the pointwise pair (`tryParseStructuredJudgment`
 * strict, `parseJudgmentResponse` lenient — see provider.ts). This function
 * is deliberately fence-tolerant on its own (a model that wraps its JSON in
 * ```json despite guided decoding is still conforming enough). Until
 * 2026-09-01 that meant "no strict-then-lenient demotion to record and no
 * `parseMode` to persist" — CORRECTED: the demotion IS observable from
 * inside this one path (did a fence have to go? did the verdict need
 * normalising?), and `lenient` reports it so `executePairwiseCall` can
 * record `parseMode` with the same meaning pointwise gives it. The parse
 * RESULT is unchanged by this: a fenced or lower-cased verdict is still
 * accepted, it is merely no longer indistinguishable afterwards from one
 * that needed nothing.
 *
```

Edit 3c — the parser body. Match:
```ts
export function tryParsePairwiseJudgment(raw: string): ParsedPairwiseJudgment | null {
  let jsonStr = raw.trim();
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  }
```
Replace with:
```ts
export function tryParsePairwiseJudgment(raw: string): ParsedPairwiseJudgment | null {
  let jsonStr = raw.trim();
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  const fenced = codeBlockMatch !== null;
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  }
```
And match:
```ts
  const record = parsed as Record<string, unknown>;
  const verdict = normalizeVerdict(record.verdict);
  if (!verdict) return null;
  if (typeof record.reasoning !== 'string') return null;

  return { verdict, reasoning: record.reasoning };
}
```
Replace with:
```ts
  const record = parsed as Record<string, unknown>;
  const verdict = normalizeVerdict(record.verdict);
  if (!verdict) return null;
  if (typeof record.reasoning !== 'string') return null;

  // `record.verdict` is a string here (normalizeVerdict returned non-null);
  // any difference from the canonical value is case/whitespace repair.
  const lenient = fenced || record.verdict !== verdict;
  return { verdict, reasoning: record.reasoning, lenient };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /root/judge-arena && npx vitest run tests/lib/judgment-schema-pairwise.test.ts`
Expected: PASS — 30 tests (4 schema + 8 conforming + 5 lenient + 13 null).

- [ ] **Step 5: Injection**

Break 1: change `const lenient = fenced || record.verdict !== verdict;` to `const lenient = false;`.
Run: `cd /root/judge-arena && npx vitest run tests/lib/judgment-schema-pairwise.test.ts`
Expected: FAIL — 5 tests: the two fence `toEqual` cases (`… lenient: false … to deeply equal … lenient: true`) and the three `is true …` lenient cases (`expected false to be true`).
Restore. Break 2: change it to `const lenient = fenced;` (drop the verdict-repair arm).
Expected: FAIL — exactly 2 tests: `is true when the verdict needed case repair` and `is true when the verdict needed whitespace repair`. (If only one fails, the case block's three sub-assertions are not all discriminating — investigate before restoring.)
Restore. Re-run: PASS 30/30.

- [ ] **Step 6: Checkpoint (no commit — commit B lands in Task 4)**

**Gates:** deferred to Task 4 Step 4, which runs the full chain once for the branch — see **Commit shape (binding)** above. **Commit:** none; commit B is Task 4 Step 5.

```bash
cd /root/judge-arena
npm run lint            # 0
npx tsc --noEmit        # 0 — nothing else consumes ParsedPairwiseJudgment's shape (verified: one caller, registry.ts, which ignores the extra key until Task 3)
npx vitest run tests/lib/judgment-schema-pairwise.test.ts tests/lib/pairwise-execution.test.ts   # 30 + 14 green (pairwise-execution is untouched until Task 3; it has 14 tests on HEAD)
git -C /root/judge-arena status --short --untracked-files=no   # exactly: M src/lib/llm/judgment-schema.ts, M tests/lib/judgment-schema-pairwise.test.ts
```

---

### Task 3: #11b — `parseMode` on `PairwiseResult`, through the seam, into the row

**Files:**
- Test (write FIRST): `tests/integration/pairwise-run.test.ts:113-124` (fake), after `:324` (assertion)
- Test: `tests/lib/pairwise-execution.test.ts` (add an `@anthropic-ai/sdk` client mock to the hoisted block at `:16-30` and a `mockReset` in `beforeEach` at `:82-84`; append a `describe`; extend the `:234-264` case)
- Test: `tests/lib/judgment-consumer-escalation.test.ts` (one new `it` pinning that `defaultRunProviderPairwise` returns the registry object UNCHANGED — the passthrough no other test in this plan covers)
- Modify: `src/lib/llm/registry.ts:1172-1182` (`PairwiseResult`), `:1184-1203` (doc), `:1225-1237` (return) — measured on `33b7be4`; the pre-v2k `:1208/:1232/:1261` numbers this plan first quoted are −36 stale
- Modify: `src/worker/judgment-consumer.ts:459-466` (`PairwiseJudgmentResult`), `:817-832` (`persistPairwiseSuccess`)

**Interfaces:**
- Consumes: `ParsedPairwiseJudgment.lenient: boolean` (Task 2); `ProviderCallResult.structuredOutputRequested?: boolean` (existing, `provider.ts:164`).
- Produces: `PairwiseResult.parseMode: 'structured' | 'fallback'` (required, registry); `PairwiseJudgmentResult.parseMode?: 'structured' | 'fallback'` (optional, worker seam); `ModelJudgment.parseMode` written on the pairwise success path. Rule: `parseMode = raw.structuredOutputRequested && !parsed.lenient ? 'structured' : 'fallback'`.

- [ ] **Step 0: Re-anchor**

Run:
```bash
grep -an "export interface PairwiseResult\|export async function executePairwiseCall\|ONE parse path. \`tryParsePairwiseJudgment\`" /root/judge-arena/src/lib/llm/registry.ts
grep -an "export interface PairwiseJudgmentResult\|async function persistPairwiseSuccess" /root/judge-arena/src/worker/judgment-consumer.ts
grep -an "function fakePairwiseProvider\|expect(persisted.latencyMs).toBe(42)" /root/judge-arena/tests/integration/pairwise-run.test.ts
grep -an "executePairwiseMock.mockResolvedValue" /root/judge-arena/tests/lib/judgment-consumer-escalation.test.ts
grep DATABASE_URL /root/judge-arena/.env.test     # must be localhost:5432 (podman judge-arena-pg)
podman ps --format '{{.Names}} {{.Status}}' | grep judge-arena   # pg, redis, rabbitmq all Up
```
Expected, MEASURED on `33b7be4` (2026-09-02): registry **1172 / 1196 / 1204** — `grep` prints them in LINE order (`PairwiseResult`, then the `ONE parse path` doc bullet, then `executePairwiseCall`), not in the order the alternation lists them — plus consumer **463 / 817**, integration **113 / 324**, escalation-test **101**. (The `1208 / 1232 / 1240` this plan originally predicted were HEAD-`5e48187` numbers, and the predicted "~46 lower after the sampling extraction" was wrong twice over: the dependency has LANDED and the shift is **−36**. All three `old_string` blocks in Step 5 were re-verified byte-for-byte at 1172-1182 / 1184-1203 / 1225-1237 — including `samplingParamsUsed: SamplingParams;`, which is unchanged because registry still imports `SamplingParams` from the new leaf at `:94` and re-exports it. Anchor on the quoted text; a number that misses is orientation drift, not a failed re-anchor.)

- [ ] **Step 1: Write the failing INTEGRATION test first (the only thing that catches a missing persist line)**

In `/root/judge-arena/tests/integration/pairwise-run.test.ts`:

Edit 1a — the fake. Match:
```ts
function fakePairwiseProvider(callLog: RunProviderPairwiseInput[]): PairwiseProviderFn {
  return async (input) => {
    callLog.push(input);
    return {
      verdict: 'B',
      reasoning: 'fixture pairwise reasoning',
      rawResponse: '{"verdict":"B","reasoning":"fixture pairwise reasoning"}',
      latencyMs: 42,
      tokenCount: 100,
    };
  };
}
```
Replace with:
```ts
function fakePairwiseProvider(callLog: RunProviderPairwiseInput[]): PairwiseProviderFn {
  return async (input) => {
    callLog.push(input);
    return {
      verdict: 'B',
      reasoning: 'fixture pairwise reasoning',
      rawResponse: '{"verdict":"B","reasoning":"fixture pairwise reasoning"}',
      latencyMs: 42,
      tokenCount: 100,
      // #11: 'fallback' on purpose. The fake bypasses the registry, so the
      // value is arbitrary — but a single-value fake cannot tell a passthrough
      // from a constant, and 'fallback' is the value a hardcoded 'structured'
      // or a `?? 'structured'` default would NOT produce. NULL here means
      // persistPairwiseSuccess dropped it — the optional seam field makes that
      // deletion type-check green, so this assertion is the only guard
      // (handoff §5.1 shape). Remaining blind spot, recorded in the plan's
      // Self-review "Accepted verification gaps" (ii): a `?? 'fallback'`
      // default would pass here, because this fake is single-valued.
      parseMode: 'fallback' as const,
    };
  };
}
```

Edit 1b — the assertion. Match:
```ts
    expect(persisted.rawResponse).toBe('{"verdict":"B","reasoning":"fixture pairwise reasoning"}');
    expect(persisted.latencyMs).toBe(42);
```
Replace with:
```ts
    expect(persisted.rawResponse).toBe('{"verdict":"B","reasoning":"fixture pairwise reasoning"}');
    expect(persisted.latencyMs).toBe(42);
    // #11: pairwise parseMode is written by persistPairwiseSuccess; before
    // 2026-09-01 this column was NULL by construction on every pairwise row.
    // 'fallback' (not 'structured') so a hardcoded/defaulted 'structured' fails too.
    expect(persisted.parseMode).toBe('fallback');
```

- [ ] **Step 2: Run the integration file to verify it fails**

Run: `cd /root/judge-arena && sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.integration.config.ts tests/integration/pairwise-run.test.ts'`
Expected: FAIL — one test (`… completes a pairwise run …`, the one containing the `persisted` block) with `expected null to be 'fallback'`; the file's other tests green. (vitest does not type-check, so the extra key on the fake is accepted at runtime even though `tsc` would currently reject it — that is why `npx tsc --noEmit` is NOT run until Step 5.)

- [ ] **Step 3: Write the failing UNIT tests**

In `/root/judge-arena/tests/lib/pairwise-execution.test.ts`:

Edit 3a — extend the existing persist-mapping case. Match:
```ts
    expect(data.reasoningTokens).toBe(4);
    expect(result.reasoning).toBe('r');
  });
});
```
Replace with:
```ts
    expect(data.reasoningTokens).toBe(4);
    expect(result.reasoning).toBe('r');
    // #11: vllm (caps 'guided') requested a schema and the bare JSON needed no
    // repair — the registry result carries 'structured' into the seam. The
    // column write itself is pinned by tests/integration/pairwise-run.test.ts,
    // because persistPairwiseSuccess (not commonSuccessUpdateData) writes it.
    expect(result.parseMode).toBe('structured');
  });
});

/**
 * #11 (handoff 2026-09-01 §7): pairwise `parseMode`, mirroring the pointwise
 * rule pinned in tests/lib/backends.test.ts (describe 'Structured-output
 * parse seam: parseMode "structured" vs "fallback"') — 'structured' is only
 * possible when a schema was ATTACHED TO THE REQUEST, i.e. when
 * `raw.structuredOutputRequested` is true, which only `callOpenAICompatible`
 * ever sets (for `mode: 'judgment'` on a descriptor whose caps are not
 * 'none'), and then only when the text needed no repair (no fence stripped,
 * no verdict normalisation). Everything else is 'fallback'. Runs the REAL
 * callOpenAICompatible / execute / prepareJudgmentCall / executePairwiseCall
 * against the mocked SDK client, so the request-shaping and the parse seam
 * are both the production code.
 *
 * The anthropic case below is the one that DISCRIMINATES the rule. Its
 * descriptor caps are `tool_use`, NOT 'none', so an implementation keyed on
 * `descriptor.caps.structuredOutput !== 'none'` rather than on
 * `raw.structuredOutputRequested` is indistinguishable from the correct one
 * on llamacpp ('json_schema') and on openai ('none') — every other case in
 * this file stays green on it — while writing 'structured' for a request
 * that never carried a schema. Anthropic never reaches
 * callOpenAICompatible: registry's `execute` sends
 * `descriptor.id === 'anthropic'` to callAnthropic, whose result omits
 * `structuredOutputRequested`, so the correct rule lands on 'fallback'
 * through the `undefined && …` arm. Its SDK client is mocked at the same
 * constructor level as `openai` (tests/lib/reasoning-capture.test.ts mocks
 * both packages this way).
 */
describe('pairwise parseMode: "structured" only when a schema was requested AND the text needed no repair', () => {
  const llamacppInput: RunProviderJudgmentInput = {
    ...pairwiseInput,
    judgeVersion: {
      servingBackend: 'llamacpp' as const,
      samplingDefaults: null,
      judgeModel: { baseModel: 'Qwen3.6-35B-A3B', slug: 'qwen-llamacpp-judge' },
    },
    // An explicit endpoint URL, so LLAMACPP_BASE_URL is not consulted.
    endpoint: { apiKeyEnc: 'sk-llamacpp-test', endpoint: 'http://llamacpp.internal:8001/v1' },
  };

  const openaiInput: RunProviderJudgmentInput = {
    ...pairwiseInput,
    judgeVersion: {
      servingBackend: 'openai' as const,
      samplingDefaults: null,
      judgeModel: { baseModel: 'gpt-4o', slug: 'gpt4o-openai-judge' },
    },
    endpoint: { apiKeyEnc: 'sk-openai-test', endpoint: null },
  };

  const anthropicInput: RunProviderJudgmentInput = {
    ...pairwiseInput,
    judgeVersion: {
      servingBackend: 'anthropic' as const,
      samplingDefaults: null,
      judgeModel: { baseModel: 'claude-3-5-sonnet-20241022', slug: 'claude-anthropic-judge' },
    },
    // apiKeyEnc set, endpoint null: the anthropic descriptor is `kind: 'api'`
    // with no defaultBaseUrl, so callAnthropic gets `baseURL: undefined`.
    endpoint: { apiKeyEnc: 'sk-anthropic-test', endpoint: null },
  };

  it('llamacpp (caps json_schema) + bare canonical JSON -> "structured", and the schema was really on the request', async () => {
    openaiCreateMock.mockResolvedValue(okChatResponse('{"verdict":"A","reasoning":"r"}'));

    const result = await executePairwiseCall(prepareJudgmentCall(llamacppInput));

    const [params] = openaiCreateMock.mock.calls[0];
    expect(params.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: JUDGMENT_JSON_SCHEMA_NAME, schema: PAIRWISE_JUDGMENT_JSON_SCHEMA, strict: true },
    });
    expect(result.verdict).toBe('A');
    expect(result.parseMode).toBe('structured');
  });

  it('llamacpp + ```json-fenced JSON -> "fallback": the verdict is still accepted, but a fence had to be stripped', async () => {
    openaiCreateMock.mockResolvedValue(okChatResponse('```json\n{"verdict":"A","reasoning":"r"}\n```'));

    const result = await executePairwiseCall(prepareJudgmentCall(llamacppInput));

    expect(result.verdict).toBe('A');
    expect(result.parseMode).toBe('fallback');
  });

  it('llamacpp + lower-case verdict -> "fallback": the verdict was repaired, not read', async () => {
    openaiCreateMock.mockResolvedValue(okChatResponse('{"verdict":"a","reasoning":"r"}'));

    const result = await executePairwiseCall(prepareJudgmentCall(llamacppInput));

    expect(result.verdict).toBe('A');
    expect(result.parseMode).toBe('fallback');
  });

  it('openai (caps none) + bare canonical JSON -> "fallback": no schema was requested, so nothing was "structured" (the pointwise rule, backends.test.ts "Structured-output parse seam" describe)', async () => {
    openaiCreateMock.mockResolvedValue(okChatResponse('{"verdict":"B","reasoning":"r"}', 'gpt-4o'));

    const result = await executePairwiseCall(prepareJudgmentCall(openaiInput));

    const [params] = openaiCreateMock.mock.calls[0];
    expect(params.response_format).toBeUndefined();
    expect(params.guided_json).toBeUndefined();
    expect(result.verdict).toBe('B');
    expect(result.parseMode).toBe('fallback');
  });

  it('anthropic (caps tool_use — NOT "none") + bare canonical JSON -> "fallback": an ATTACHED schema is the rule, descriptor caps are not', async () => {
    anthropicCreateMock.mockResolvedValue({
      model: 'claude-3-5-sonnet-20241022',
      content: [{ type: 'text', text: '{"verdict":"A","reasoning":"r"}' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 11, output_tokens: 7 },
    });

    const result = await executePairwiseCall(prepareJudgmentCall(anthropicInput));

    // callAnthropic ran and callOpenAICompatible did not — which is exactly
    // why no request carried a schema and `structuredOutputRequested` is
    // undefined on the raw result.
    expect(anthropicCreateMock).toHaveBeenCalledTimes(1);
    expect(openaiCreateMock).not.toHaveBeenCalled();
    expect(result.verdict).toBe('A');
    // THE discriminating assertion: caps here are `tool_use`, so a rule
    // written as `caps.structuredOutput !== 'none'` says 'structured' and a
    // rule written as `raw.structuredOutputRequested` says 'fallback'.
    expect(result.parseMode).toBe('fallback');
  });
});
```

Edit 3b — the `@anthropic-ai/sdk` client mock. The file hoists only `openai` today; the anthropic
case above needs `callAnthropic`'s SDK client intercepted at the same constructor level. Precedent:
`tests/lib/reasoning-capture.test.ts:23-37`, which mocks BOTH packages exactly this way — **not**
`tests/lib/backends.test.ts`, whose only `vi.mock` targets are `openai` and
`@/lib/llm/breaker-redis`. Match:
```ts
const { openaiCreateMock, OpenAIConstructorMock, getBreakerMock, allowMock, onSuccessMock, onFailureMock } =
  vi.hoisted(() => ({
    openaiCreateMock: vi.fn(),
    OpenAIConstructorMock: vi.fn(),
    getBreakerMock: vi.fn(),
    allowMock: vi.fn(),
    onSuccessMock: vi.fn(),
    onFailureMock: vi.fn(),
  }));

vi.mock('openai', () => ({
  default: OpenAIConstructorMock.mockImplementation(() => ({
    chat: { completions: { create: openaiCreateMock } },
  })),
}));
```
Replace with:
```ts
const {
  openaiCreateMock,
  OpenAIConstructorMock,
  anthropicCreateMock,
  getBreakerMock,
  allowMock,
  onSuccessMock,
  onFailureMock,
} = vi.hoisted(() => ({
  openaiCreateMock: vi.fn(),
  OpenAIConstructorMock: vi.fn(),
  anthropicCreateMock: vi.fn(),
  getBreakerMock: vi.fn(),
  allowMock: vi.fn(),
  onSuccessMock: vi.fn(),
  onFailureMock: vi.fn(),
}));

vi.mock('openai', () => ({
  default: OpenAIConstructorMock.mockImplementation(() => ({
    chat: { completions: { create: openaiCreateMock } },
  })),
}));
// #11: anthropic pairwise is the case that separates "a schema was attached
// to THIS request" (`raw.structuredOutputRequested`) from "this descriptor's
// caps are not 'none'" — its caps are `tool_use`. Same constructor-level
// interception as tests/lib/reasoning-capture.test.ts, so the REAL
// callAnthropic runs.
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: anthropicCreateMock },
  })),
}));
```
And match:
```ts
beforeEach(() => {
  OpenAIConstructorMock.mockClear();
  openaiCreateMock.mockReset();
```
Replace with:
```ts
beforeEach(() => {
  OpenAIConstructorMock.mockClear();
  openaiCreateMock.mockReset();
  anthropicCreateMock.mockReset();
```

Edit 3c — pin the SEAM PASSTHROUGH, in `/root/judge-arena/tests/lib/judgment-consumer-escalation.test.ts`.
`defaultRunProviderPairwise` returns the registry object unchanged today, which is why no seam edit is
needed — but nothing PINS that. Because `PairwiseJudgmentResult.parseMode` is optional, a later edit
that maps fields explicitly there drops `parseMode` with tsc green, the Step 3 unit cases green (they
assert on the registry result, UPSTREAM of this function) and the Step 1 integration test green (its
fake REPLACES this function). That is failure mode 14 with the fake sitting on the seam that would
break. This file already mocks `@/lib/llm` (`:41-45`) and imports the real consumer, so the addition
is one `it` at the end of the existing `describe('every provider seam carries the timeout escalation', …)`.

**This assertion is GREEN the moment it is written** — the passthrough already exists on HEAD, so
there is no red-first run for it and none is claimed. Its evidence is Injection F in Step 7, and
only that: an assertion with no injection behind it is unguarded (failure mode 5). Do not skip F.

Match the last three lines of the file (`:175-177` — the file ends here, so this is unique):
```ts
    expect(executePairwiseMock.mock.calls[0][0].escalation.attempt).toBe(1);
  });
});
```
Replace with:
```ts
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
});
```
(`input`, `executePairwiseMock` and the `beforeEach` that resolves it are all already in scope —
`:101` sets the default resolved value and this `it` overrides it locally, so the other three seam
cases are untouched. `'structured'` here, not `'fallback'`: the integration fake carries `'fallback'`,
so the two guards disagree on value and no single constant satisfies both.)

- [ ] **Step 4: Run the unit files to verify they fail**

Run: `cd /root/judge-arena && npx vitest run tests/lib/pairwise-execution.test.ts`
**Do NOT run `npx tsc --noEmit` here** — same reason as Step 2. At this point `parseMode` does not
exist on `PairwiseResult`, so tsc would report ~6 errors in `tests/lib/pairwise-execution.test.ts`
(`Property 'parseMode' does not exist on type 'PairwiseResult'`). That is EXPECTED red, not a broken
plan; tsc is not run again until Step 6, after Edit 5a adds the field.
Expected: FAIL — 6 tests: the extended persist-mapping case and all five new cases (llamacpp clean / llamacpp fenced / llamacpp lower-case / openai clean / anthropic clean), each with `expected undefined to be 'structured'` / `'fallback'`. The other 13 stay green (14 on HEAD, one of which is the extended case).

Then run: `cd /root/judge-arena && npx vitest run tests/lib/judgment-consumer-escalation.test.ts`
Expected: **PASS — 7 tests**, including the new Edit 3c case. This one is green from the moment it is written, as Edit 3c says: it pins an existing passthrough rather than driving a new behaviour, and Injection F in Step 7 is its only evidence. Record the green here so it is not later mistaken for a red-then-green.

- [ ] **Step 5: Write minimal implementation**

Edit 5a — `/root/judge-arena/src/lib/llm/registry.ts`, the result type. Match:
```ts
export interface PairwiseResult extends CallCaptureFields {
  verdict: 'A' | 'B' | 'tie';
  reasoning: string;
  rawResponse: string;
  servedModelId?: string;
  finishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  samplingParamsUsed: SamplingParams;
}
```
Replace with:
```ts
export interface PairwiseResult extends CallCaptureFields {
  verdict: 'A' | 'B' | 'tie';
  reasoning: string;
  rawResponse: string;
  servedModelId?: string;
  finishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  /** #11 (2026-09-01). `'structured'` iff this request ACTUALLY CARRIED a
   * schema — `raw.structuredOutputRequested`, which only
   * `callOpenAICompatible` sets, for `mode: 'judgment'` on a descriptor whose
   * `caps.structuredOutput !== 'none'` (llamacpp, ollama, vllm) — AND
   * `tryParsePairwiseJudgment` needed no repair (no fence stripped, no verdict
   * normalisation). Otherwise `'fallback'`.
   *
   * Read the flag, NOT the caps. Anthropic's caps are `tool_use`, which is not
   * `'none'`, but it dispatches through `callAnthropic`, which never attaches
   * a schema and never sets the flag — so anthropic is always `'fallback'`.
   * `caps.structuredOutput !== 'none'` agrees with the flag on llamacpp and on
   * openai and disagrees only there, which is why
   * tests/lib/pairwise-execution.test.ts pins the anthropic case directly.
   *
   * Mirrors pointwise's rule with one
   * documented difference: pointwise `'structured'` means the strict schema
   * parse SUCCEEDED; pairwise `'structured'` means "no repair was needed" —
   * extra keys are ignored, so a response carrying junk fields still reads
   * `'structured'` here. See the `ModelJudgment.parseMode` schema comment. */
  parseMode: 'structured' | 'fallback';
  samplingParamsUsed: SamplingParams;
}
```

Edit 5b — the doc bullet. Match:
```ts
 * - ONE parse path. `tryParsePairwiseJudgment` is already fence-tolerant,
 *   so there is no strict-then-lenient demotion and no `parseMode` to
 *   persist. A response carrying no usable verdict is `non_retryable`:
 *   re-asking the same model the same question is not a provider-health
 *   signal, and classifying it retryable would burn the 3-attempt budget,
 *   DLQ the judgment, and count three failures against a breaker shared
 *   with every other correctly-behaving call on the same endpoint+model.
 */
```
Replace with:
```ts
 * - ONE parse path. `tryParsePairwiseJudgment` is already fence-tolerant.
 *   Until 2026-09-01 this bullet concluded "so there is no strict-then-
 *   lenient demotion and no `parseMode` to persist" — CORRECTED: the parser
 *   now reports `lenient`, and `parseMode` is derived from it plus whether
 *   the request carried a schema (`raw.structuredOutputRequested`), giving
 *   the column the same meaning pointwise's `parseJudgmentText` gives it.
 *   A response carrying no usable verdict is still `non_retryable`:
 *   re-asking the same model the same question is not a provider-health
 *   signal, and classifying it retryable would burn the 3-attempt budget,
 *   DLQ the judgment, and count three failures against a breaker shared
 *   with every other correctly-behaving call on the same endpoint+model.
 */
```

Edit 5c — the return. Match:
```ts
  return {
    verdict: parsed.verdict,
    reasoning: parsed.reasoning,
    rawResponse: raw.text,
    servedModelId: raw.servedModelId,
    finishReason: raw.finishReason,
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    latencyMs: raw.latencyMs,
    samplingParamsUsed: prepared.samplingParamsUsed,
    ...callCaptureFields(raw),
  };
}
```
Replace with:
```ts
  return {
    verdict: parsed.verdict,
    reasoning: parsed.reasoning,
    rawResponse: raw.text,
    servedModelId: raw.servedModelId,
    finishReason: raw.finishReason,
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    latencyMs: raw.latencyMs,
    parseMode: raw.structuredOutputRequested && !parsed.lenient ? 'structured' : 'fallback',
    samplingParamsUsed: prepared.samplingParamsUsed,
    ...callCaptureFields(raw),
  };
}
```
(`raw.structuredOutputRequested` is `boolean | undefined` — `undefined && …` is falsy, so an Anthropic pairwise call, which never sets it, lands on `'fallback'`.)

Edit 5d — `/root/judge-arena/src/worker/judgment-consumer.ts`, the seam type. Match:
```ts
/** Pairwise mirror of `JudgmentResult`/`RespondResult` — same "looser local
 * type, strict registry type is a subtype" rationale. A pairwise judge
 * emits a preference, so there is no `overallScore` and no
 * `criteriaScores`. */
export interface PairwiseJudgmentResult extends CommonResultFields {
  verdict: 'A' | 'B' | 'tie';
  reasoning: string;
}
```
Replace with:
```ts
/** Pairwise mirror of `JudgmentResult`/`RespondResult` — same "looser local
 * type, strict registry type is a subtype" rationale. A pairwise judge
 * emits a preference, so there is no `overallScore` and no
 * `criteriaScores`. `parseMode` is OPTIONAL here for SYMMETRY with
 * `JudgmentResult` above (judgment-consumer.ts:305), which is optional for a
 * reason that does NOT apply on this seam: there is exactly one
 * `PairwiseProviderFn` fake in the tree (tests/integration/pairwise-run.test.ts:113,
 * the only `providerPairwise:` call site) and it is updated in the same commit,
 * so nothing here is kept compiling by the `?`. The registry's `PairwiseResult`
 * always carries the field. The cost of optional is that forgetting the write in
 * `persistPairwiseSuccess` type-checks green — tests/integration/pairwise-run.test.ts
 * pins it. */
export interface PairwiseJudgmentResult extends CommonResultFields {
  verdict: 'A' | 'B' | 'tie';
  reasoning: string;
  parseMode?: 'structured' | 'fallback';
}
```

Edit 5e — the persist. Match:
```ts
  await prisma.modelJudgment.update({
    where: { id: judgmentId },
    data: {
      ...commonSuccessUpdateData(result, version),
      overallScore: null,
      reasoning: result.reasoning,
      criteriaScores: Prisma.DbNull,
      verdict: result.verdict,
    },
  });
}
```
Replace with:
```ts
  await prisma.modelJudgment.update({
    where: { id: judgmentId },
    data: {
      ...commonSuccessUpdateData(result, version),
      overallScore: null,
      reasoning: result.reasoning,
      criteriaScores: Prisma.DbNull,
      verdict: result.verdict,
      // #11 (2026-09-01): 'structured' = schema attached AND no fence/verdict
      // repair; 'fallback' otherwise. Rows written before this line are NULL.
      parseMode: result.parseMode,
    },
  });
}
```

- [ ] **Step 6: Run unit and integration to verify they pass**

Run: `cd /root/judge-arena && npx vitest run tests/lib/pairwise-execution.test.ts tests/lib/judgment-schema-pairwise.test.ts tests/lib/judgment-consumer-escalation.test.ts`
Expected: PASS — 19 + 30 + 7 = **56** (14 + 5 new; 25 + 5 new; 6 + 1 new). HEAD was 14 + 25 + 6 = 45, measured 2026-09-02.
Run: `cd /root/judge-arena && sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.integration.config.ts tests/integration/pairwise-run.test.ts'`
Expected: PASS.
Run: `cd /root/judge-arena && npx tsc --noEmit`
Expected: 0 (the fake's `parseMode` key now has a home on the seam type).

- [ ] **Step 7: Injection (six — A/B/E on the rule, C/D on the persist, F on the seam passthrough — plus one DOCUMENTED NON-injection)**

Injection A — the rule, structured arm. In `registry.ts` change the new line to `parseMode: 'fallback',`.
Run: `npx vitest run tests/lib/pairwise-execution.test.ts`
Expected: FAIL — exactly 2 tests: `llamacpp (caps json_schema) + bare canonical JSON -> "structured"…` and the extended persist-mapping case, both `expected 'fallback' to be 'structured'`. Restore.

Injection B — the rule, fallback arm. Change it to `parseMode: 'structured',`.
Expected: FAIL — exactly **4** tests: llamacpp fenced, llamacpp lower-case, openai clean AND **anthropic clean** — i.e. every case in the file that asserts `'fallback'` — each `expected 'structured' to be 'fallback'`. (Corrected 2026-09-02: this step previously said "exactly 3", counting the file before Step 3 added the anthropic case in the same commit. Seeing a 4th red here is the plan being right, not a phantom failure to diagnose. Note that anthropic reddens here for a DIFFERENT reason than in Injection E — a constant, versus a wrong predicate — so the two are not the same evidence and neither substitutes for the other.) Restore.

Injection C — the persist line (the §5.1 shape). In `judgment-consumer.ts` delete the line `parseMode: result.parseMode,` from `persistPairwiseSuccess`.
Run: `npx tsc --noEmit` → **0 errors** (this is the point: the type system does not notice).
Run: `sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.integration.config.ts tests/integration/pairwise-run.test.ts'`
Expected: FAIL — `expected null to be 'fallback'`. Restore.
Injection D — the persist line, wrong-constant shape. Change it to `parseMode: 'structured',` — a HARDCODED constant. Do NOT use `result.parseMode ?? 'structured'`: the fake supplies `'fallback'`, so the `??` never fires, the assertion passes, and the suite stays GREEN — which is a non-injection, not an injection (CONTRIBUTING.md:210-234). `npx tsc --noEmit` → 0. Re-run the integration file.
Expected: FAIL — `expected 'structured' to be 'fallback'` (this is why the fake carries `'fallback'`). Restore.

**Documented NON-injection D′ (run it, observe the green, write the green down).** Change the persist
line to `parseMode: result.parseMode ?? 'fallback',` and re-run the integration file.
Expected: **PASS.** This is the accepted gap in Self-review (ii) made auditable instead of asserted:
the fake is single-valued (`'fallback'`), so the `??` never fires and no assertion can see the
default. A demonstrated non-injection is evidence; a claimed one is not (CONTRIBUTING.md:210-234).
Restore, and record the observed green in the executor's notes — it is the reason the plan does NOT
claim the persist write is defended against defaulting.

Injection E — the rule, wrong PREDICATE. This is the mis-implementation a reader reaches for when "a schema was attached" is (wrongly) glossed as "descriptor caps not 'none'", and it is the reason the anthropic case exists. As of the 2026-09-02 revision no comment in this plan uses that gloss — every one states the flag and names anthropic's `tool_use` caps as the counterexample — but the gloss is still the obvious "simplification" for the next editor, so the injection stays. In `registry.ts` change the ternary's left operand from `raw.structuredOutputRequested` to `prepared.descriptor.caps.structuredOutput !== 'none'`.
Run: `npx vitest run tests/lib/pairwise-execution.test.ts`
Expected: FAIL — **exactly one** test, `anthropic (caps tool_use — NOT "none") + bare canonical JSON -> "fallback"…`, with `expected 'structured' to be 'fallback'`. Every other case stays GREEN: llamacpp is `json_schema` and openai is `'none'`, so the two predicates agree there and Injection A would not catch this. (Injection B reddens the anthropic case too, but as a side effect of a blanket constant — it says nothing about which predicate is right.) Four documents this plan edits assert the behaviour this one assertion protects. Restore.

Injection F — the SEAM PASSTHROUGH (the failure-mode-14 shape). In `judgment-consumer.ts`, replace
`defaultRunProviderPairwise`'s final `return result;` with an explicit field map that omits the new
field: `return { verdict: result.verdict, reasoning: result.reasoning, rawResponse: result.rawResponse, latencyMs: result.latencyMs };`
Run: `npx tsc --noEmit` → **0 errors** (the seam field is optional; the type system does not notice).
Run: `sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.integration.config.ts tests/integration/pairwise-run.test.ts'` → **PASS** (the fake REPLACES this function, so the integration guard is blind to it — that is the point).
Run: `npx vitest run tests/lib/pairwise-execution.test.ts` → **PASS** (those cases assert on the registry result, upstream of this function).
Run: `npx vitest run tests/lib/judgment-consumer-escalation.test.ts`
Expected: FAIL — exactly one test, `PAIRWISE returns the registry result UNCHANGED — parseMode survives the seam`, with `expected undefined to be 'structured'`. Three of the four gates stayed green on a real drop; this is the only one that did not. Restore.

Re-run tsc + all three unit files + the integration file: PASS.

- [ ] **Step 8: Checkpoint (no commit — commit B lands in Task 4)**

**Gates:** deferred to Task 4 Step 4, which runs the full chain once for the branch — see **Commit shape (binding)** above. **Commit:** none; commit B is Task 4 Step 5.

```bash
cd /root/judge-arena
npm run lint && npx tsc --noEmit
npx vitest run tests/lib/pairwise-execution.test.ts tests/lib/judgment-schema-pairwise.test.ts tests/lib/judgment-consumer-escalation.test.ts   # 56 green (19 + 30 + 7)
git -C /root/judge-arena status --short --untracked-files=no
# exactly: M src/lib/llm/judgment-schema.ts, M src/lib/llm/registry.ts, M src/worker/judgment-consumer.ts,
#          M tests/lib/judgment-schema-pairwise.test.ts, M tests/lib/pairwise-execution.test.ts,
#          M tests/lib/judgment-consumer-escalation.test.ts, M tests/integration/pairwise-run.test.ts
# and the per-edit content checks a file count cannot give (expected count after the arrow):
grep -acF 'parseMode: raw.structuredOutputRequested' src/lib/llm/registry.ts        # 0 -> 1  (5c)
grep -acF 'parseMode: result.parseMode,' src/worker/judgment-consumer.ts            # 1 -> 2  (5e; the pointwise persistSuccess already has one at :771)
grep -acF "parseMode?: 'structured' | 'fallback';" src/worker/judgment-consumer.ts  # 1 -> 2  (5d; JudgmentResult already has one at :305)
grep -acF "expect(result.parseMode)" tests/lib/pairwise-execution.test.ts           # 0 -> 6
grep -acF "expect(persisted.parseMode)" tests/integration/pairwise-run.test.ts      # 0 -> 1
grep -acF 'parseMode survives the seam' tests/lib/judgment-consumer-escalation.test.ts  # 0 -> 1
```

---

### Task 4: #11c — schema comment, doc CORRECTIONs, full gates, commit B

**Files:** — all numbers MEASURED on `33b7be4`, 2026-09-02. **Three of them MOVE by the time this task runs, because commit A's own doc edits shift them**; the shifted value is given after `=>`. Every `old_string` in Step 3 is anchored on unique quoted TEXT and was re-verified verbatim on `33b7be4` — the numbers are orientation only. Do not read a miss as a failed re-anchor.
- Modify: `prisma/schema.prisma:505` (comment only)
- Modify: `src/lib/llm/provider.ts:234-243` (doc comment on `ParsedJudgment.parseMode`; the `parseMode:` declaration itself is `:242`)
- Modify: `README.md:574`, `:579` (unmoved — Task 1 Edit 8a replaced one table row with one table row)
- Modify: `docs/runbooks/scoring-a-judge-against-a-golden-set.md:344 => :347`, `:349 => :352` (Task 1 Edit 8c grew the 7-line sample block to 10)
- Modify: `docs/superpowers/plans/2026-09-01-scoreboard-handoff.md:376-377 => :385-386` (Task 1 Edit 8d grew item 10 from 2 lines to 11)
- Modify: `docs/superpowers/plans/2026-08-30-state-and-next-steps.md:387-391` (unmoved — it sits above Task 1's edits), `:669 => :678` (measured table row; Task 1 Edit 8e added 3 lines at `:392-395` and 6 at `:444-448`)
- Modify: `docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md:671-672`
- Modify: `docs/superpowers/specs/2026-08-31-calibration-baseline-and-footprint.md:342` (unmoved — Task 1 Edit 8f replaced one row with one row)

(The `=>` values are arithmetic on commit A's own added lines and are therefore the least reliable numbers in this plan. They are given so a reader can orient, not so an executor can verify: **match on the quoted text.** The originals this plan first carried — `:344 => :346`, `:364-365 => :370-371`, `:663 => :671`, spec `:650-651` — were wrong twice over, being arithmetic on pre-v2k bases.)

**Interfaces:**
- Consumes: the Task 3 rule, restated verbatim in every comment: `'structured'` = schema attached AND no fence/verdict repair; `'fallback'` otherwise; NULL = respond mode, v1 import, error rows, pre-2026-09-01 pairwise rows.
- Produces: commit B.

**No injection step.** Task 4 changes only comments and prose (the schema comment, the `provider.ts`
doc comment, eight doc CORRECTIONs). There is no behaviour to break. The #11 behaviour injections are
Task 3 Step 7 A–D, and Step 4 below re-verifies them green through the full gate chain.

- [ ] **Step 0: Re-anchor**

Run: `grep -an 'parseMode      String?' /root/judge-arena/prisma/schema.prisma; grep -an "parseMode: 'structured' | 'fallback';" /root/judge-arena/src/lib/llm/provider.ts; git -C /root/judge-arena status --short --untracked-files=no | wc -l   # 7`
Expected: schema hit at 505; provider hit at 242; **7** modified files from Tasks 2–3 (untracked plan docs excluded) — the `wc -l` comment in the command above reads `# 7`, not `# 6`: Task 3 Edit 3c adds `tests/lib/judgment-consumer-escalation.test.ts` to the dirty set.
This re-anchor deliberately covers only the two CODE anchors. The three doc anchors marked `=>` in **Files** above moved when commit A landed and will NOT be found at their pre-commit-A numbers — that is expected, not a miss. Match on the Step 3 `old_string` blocks, never on the numbers.

- [ ] **Step 1: Schema comment — every NULL case and the semantic caveat**

Two things this comment deliberately does NOT say. (1) It does not define the rule as "descriptor
caps not 'none'": that phrasing is the mis-implementation Injection E exists to catch, and stating it
alongside "anthropic is never structured" would be self-contradicting, since anthropic's caps are
`tool_use` (`registry.ts:161`, verified). (2) It does not give a ROW COUNT for the pre-2026-09-01
pairwise rows. The "270" this plan originally carried came from the handoff's production table
(`:60`, "evaluation runs / model judgments | 270 / 270`") — a TOTAL judgment count, not a pairwise
count, and probably but not verifiably equal to it (9 calibration runs × 30 items). Nothing in this
plan measures it, so it must not be frozen into a permanent schema comment; "any pairwise row written
before 2026-09-01" is both what the comment needs to say and what is known. The number is measured
read-only in post-promote checklist item 3 instead.

Match:
```prisma
  finishReason   String?
  parseMode      String? // how the raw response was parsed into structured scores
```
Replace with:
```prisma
  finishReason   String?
  // 'structured' | 'fallback' | NULL.
  // POINTWISE (src/lib/llm/provider.ts): 'structured' = the strict schema parse
  //   SUCCEEDED on a request that attached a schema; 'fallback' = the lenient
  //   JSON-in-markdown parse (always, when no schema was attached).
  // PAIRWISE (from 2026-09-01, src/lib/llm/registry.ts executePairwiseCall):
  //   'structured' = this request ACTUALLY CARRIED a schema AND
  //   tryParsePairwiseJudgment needed no repair — no markdown fence stripped,
  //   no verdict case/whitespace normalisation; 'fallback' otherwise.
  //   "Carried a schema" is the flag `structuredOutputRequested`, which only
  //   callOpenAICompatible sets, for mode:'judgment' on a descriptor whose
  //   caps.structuredOutput is not 'none' — llamacpp, ollama, vllm. READ THE
  //   FLAG, NOT THE CAPS: anthropic's caps are 'tool_use' (not 'none'), but it
  //   dispatches through callAnthropic, which never attaches a schema and
  //   never sets the flag, so anthropic is always 'fallback' — as are openai
  //   and openrouter, whose caps are 'none'.
  //   CAVEAT when grouping across protocols: pairwise 'structured' is WEAKER
  //   than pointwise 'structured' — extra keys are ignored, so a response with
  //   junk fields that otherwise needed no repair still reads 'structured'.
  // NULL means one of: respond mode (never written); v1 import
  //   (scripts/importer/runs.ts writes null); any error-status row of any
  //   protocol (markJudgmentError never writes it); any pairwise row written
  //   before 2026-09-01, none of which are backfilled — rawResponse is
  //   retained if that is ever wanted. NULL is NOT 'fallback'.
  parseMode      String?
```

- [ ] **Step 2: `provider.ts` doc note on the pointwise type**

Match:
```ts
   * via `tryParseStructuredJudgment` below — see `registry.ts`'s
   * `executeJudgmentCall` for the strict-then-lenient decision. */
  parseMode: 'structured' | 'fallback';
}
```
Replace with:
```ts
   * via `tryParseStructuredJudgment` below — see `registry.ts`'s
   * `executeJudgmentCall` for the strict-then-lenient decision.
   *
   * The PAIRWISE path records the same two values with a documented weaker
   * meaning (`registry.ts`'s `executePairwiseCall`: schema attached AND no
   * fence/verdict repair, extra keys ignored) — see the
   * `ModelJudgment.parseMode` comment in prisma/schema.prisma before grouping
   * on this column across protocols. */
  parseMode: 'structured' | 'fallback';
}
```

- [ ] **Step 3: Docs with CORRECTION notes**

Edit 3a — `README.md:574`. Match:
```markdown
Two fields are null on this data, and both are gaps rather than bugs:
```
Replace with:
```markdown
Two fields are null on this data, and both are gaps rather than bugs. **CORRECTION (2026-09-01):**
"gaps rather than bugs" was written when both were treated as by-construction; only the first still
is. The `parseMode` row below describes the pre-2026-09-01 state, and its note says what changed:
```

Edit 3b — `README.md:579`. Match:
```markdown
| `parseMode` | **NULL, 30/30** | The pairwise path has **one** parse path. `tryParsePairwiseJudgment` is already fence-tolerant, so there is no strict-then-lenient demotion and therefore no `parseMode` to persist (`src/lib/llm/registry.ts:1005-1007`). The column is meaningful only on the pointwise path. |
```
Replace with:
```markdown
| `parseMode` | **NULL, 30/30** (on rows written before 2026-09-01) | The pairwise path has **one** parse path. `tryParsePairwiseJudgment` is already fence-tolerant, so — this row used to say — there is no strict-then-lenient demotion and therefore no `parseMode` to persist; the column was meaningful only pointwise. **CORRECTION (2026-09-01):** the demotion *is* observable inside that one path, and pairwise now records it: `'structured'` = a schema was attached to the request (llamacpp/ollama/vllm) **and** the text needed no repair (no fence stripped, no verdict normalisation); `'fallback'` otherwise, including every Anthropic/openai/openrouter pairwise call. Pairwise `'structured'` is weaker than pointwise `'structured'` (extra keys are ignored) — see the schema comment before grouping across protocols. Existing pairwise rows stay NULL (= pre-change, not "fallback"); no backfill. The line reference this row carried (`registry.ts:1005-1007`) was stale; the rule lives in `executePairwiseCall`'s doc comment, cited by symbol. |
```

Edit 3c — runbook `:344 => :347` (post-commit-A). Match:
```markdown
Every field should be `n/n` where n is the judgment count. Two **known, honest** exceptions:
```
Replace with:
```markdown
Every field should be `n/n` where n is the judgment count. Two **known, honest** exceptions
(**CORRECTION 2026-09-01:** one exception now; the `parseMode` row records what changed):
```

Edit 3d — runbook `:349 => :352` (post-commit-A). Match:
```markdown
| `parseMode` | **NULL on the pairwise path** | one parse path, so no strict→lenient demotion to record. Meaningful only pointwise |
```
Replace with:
```markdown
| `parseMode` | **NULL on pairwise rows written before 2026-09-01; `structured`/`fallback` after** | one parse path, so — this row used to say — no strict→lenient demotion to record, meaningful only pointwise. **CORRECTION (2026-09-01):** pairwise now writes it. `structured` = schema attached (llamacpp/ollama/vllm) **and** no fence/verdict repair; `fallback` otherwise (always, on Anthropic/openai/openrouter). The capture-completeness checklist does NOT count this column — only the "One judgment in full" dump prints it (the `── One judgment in full ──` block in `scripts/calibration/run.ts`) — so group on it in psql. A self-hosted judge with a large `fallback` share is one that ignores `response_format` or answers in prose; read the raw responses. NULL on a pre-change row is NOT `fallback` |
```

Edit 3e — handoff `:376-377 => :385-386` (post-commit-A). Match:
```markdown
11. **`parseMode` is NULL on pairwise.** One fence-tolerant parse path, so no strict→lenient
    demotion to record. Document as pointwise-only or give it a pairwise meaning.
```
Replace with:
```markdown
11. **`parseMode` is NULL on pairwise.** One fence-tolerant parse path, so no strict→lenient
    demotion to record. Document as pointwise-only or give it a pairwise meaning.
    **CLOSED 2026-09-01 — given a meaning.** `tryParsePairwiseJudgment` now reports `lenient`
    (fence stripped OR verdict repaired); `executePairwiseCall` records `'structured'` iff a schema
    was attached AND nothing was lenient, else `'fallback'` — the pointwise rule, with the caveat
    (on the schema comment) that extra keys are ignored so pairwise `'structured'` is weaker. No
    migration, no backfill: every pairwise row written before this change stays NULL = pre-change
    (the production ledger held 270 model judgments on 2026-09-01, all pairwise as far as §1's table
    shows, but the count was not measured for this claim and the schema comment states none). Parse OUTPUT is
    unchanged, so the §2 granite4.1 regression check must stay bit-identical — operator re-run after
    promotion.
```
NOTE for the Wave 3 plan `finalizer-error-to-needs-human` Task 2 Step 2: its handoff `old_string` (`:376-381` on `33b7be4`, item 11's two lines followed by `---` and `## 8. Starting the next session`) will no longer match once this edit has landed. After this plan, that step must anchor on the line `## 8. Starting the next session` and insert `### Closed since` immediately above the `---` that precedes it, not on item 11's text. (The reverse order is safe: this edit's two-line match still works with `### Closed since` below it.)

Edit 3f — register `:387-391` (unmoved by commit A). Match:
```markdown
1. **`parseMode` is NULL on the pairwise path.** One parse path (`tryParsePairwiseJudgment`,
   fence-tolerant) means no strict→lenient demotion and no mode to persist; the column is meaningful
   only pointwise. **It is not a capture bug, but the gap is real:** on pairwise a leniently-parsed
   verdict and a strictly-parsed one are indistinguishable afterwards. Decide whether to write a
   pairwise-meaningful value or to document the column as pointwise-only.
```
Replace with:
```markdown
1. **`parseMode` is NULL on the pairwise path.** One parse path (`tryParsePairwiseJudgment`,
   fence-tolerant) means no strict→lenient demotion and no mode to persist; the column is meaningful
   only pointwise. **It is not a capture bug, but the gap is real:** on pairwise a leniently-parsed
   verdict and a strictly-parsed one are indistinguishable afterwards. Decide whether to write a
   pairwise-meaningful value or to document the column as pointwise-only.
   **CLOSED 2026-09-01 — written.** The gap named here is exactly what is now recorded: `lenient`
   on the parse, `parseMode` on the row (`structured` = schema attached and no repair). See the
   2026-09-01 handoff §7 item 11 and the `ModelJudgment.parseMode` schema comment for the NULL cases.
```

Edit 3g — spec `:671-672`. Match:
```markdown
- **Reasoning-token capture is still partial.** `reasoningTokens` is NULL for llama.cpp, and
  `parseMode` is NULL on pairwise; both are open and recorded in the baseline spec §5.
```
Replace with:
```markdown
- **Reasoning-token capture is still partial.** `reasoningTokens` is NULL for llama.cpp, and
  `parseMode` is NULL on pairwise; both are open and recorded in the baseline spec §5.
  **CORRECTION (2026-09-01):** `reasoningTokens` is NULL on Ollama and Anthropic too and is now
  documented as usage-reported rather than derived or dropped; `parseMode` is written on pairwise
  from 2026-09-01 (rows in this ledger predate that and stay NULL). Handoff §7 items 10–11.
```

Edit 3h — the two measured-table `parseMode` rows (the `reasoningTokens` rows directly above each were corrected in Task 1 Edit 8f). Register `docs/superpowers/plans/2026-08-30-state-and-next-steps.md:669 => :678` (post-commit-A). Match the whole row:
```markdown
| `parseMode` | **NULL on 30/30** | The pairwise path has one parse path (`tryParsePairwiseJudgment` is fence-tolerant), so there is no strict→lenient demotion and no mode to persist. The column is meaningful only pointwise |
```
Replace with:
```markdown
| `parseMode` | **NULL on 30/30** | The pairwise path has one parse path (`tryParsePairwiseJudgment` is fence-tolerant), so there is no strict→lenient demotion and no mode to persist. The column is meaningful only pointwise. **CORRECTION (2026-09-01):** pairwise now writes it — `structured` = schema attached AND no fence/verdict repair, else `fallback`; rows in this table predate that and stay NULL (= pre-change, not `fallback`). See the `ModelJudgment.parseMode` schema comment |
```
Baseline spec `docs/superpowers/specs/2026-08-31-calibration-baseline-and-footprint.md:342`. Match the whole row:
```markdown
| `parseMode` | **NULL on 30/30** | The pairwise path has exactly one parse path (`tryParsePairwiseJudgment`, fence-tolerant), so there is no strict→lenient demotion and no mode to persist. **The column is meaningful only pointwise.** It reads as a capture bug and is not one — but it does mean pairwise loses the "this response needed the lenient parser" signal entirely, which is a real gap on a path where a leniently-parsed verdict and a strictly-parsed one are indistinguishable afterwards |
```
Replace with:
```markdown
| `parseMode` | **NULL on 30/30** | The pairwise path has exactly one parse path (`tryParsePairwiseJudgment`, fence-tolerant), so there is no strict→lenient demotion and no mode to persist. **The column is meaningful only pointwise.** It reads as a capture bug and is not one — but it does mean pairwise loses the "this response needed the lenient parser" signal entirely, which is a real gap on a path where a leniently-parsed verdict and a strictly-parsed one are indistinguishable afterwards. **CORRECTION (2026-09-01):** pairwise now writes it — `structured` = schema attached AND no fence/verdict repair, else `fallback`; rows in this table predate that and stay NULL (= pre-change, not `fallback`). See the `ModelJudgment.parseMode` schema comment |
```

- [ ] **Step 4: Full gates**

```bash
cd /root/judge-arena
npm run lint                     # 0 problems, 0 warnings
npx tsc --noEmit                 # 0
npx prisma validate              # needs no database
npm run test:coverage
#   PREDICTED: 906 unit / 58 files (895 after Task 1 + 5 new in judgment-schema-pairwise + 5 new in
#   pairwise-execution + 1 new in judgment-consumer-escalation). Arithmetic on the 888/57 measured on
#   33b7be4 — if the printed number differs, the printed number wins; diagnose the delta, do not
#   paste the prediction.
#   src/lib/llm/** floors (statements 91 / functions 94 / branches 83 / lines 91, vitest.config.ts:203)
#   hold. Do NOT expect a visible upward move: src/lib/llm/anthropic.ts is ALREADY executed by
#   tests/lib/reasoning-capture.test.ts (:40 imports callAnthropic and :186-248 call it under the same
#   @anthropic-ai/sdk constructor mock), so the anthropic pairwise case adds no newly-covered file —
#   only the two arms of the new ternary and the two arms of `lenient`, i.e. barely anything. A flat
#   number here is the expected outcome; **any DOWNWARD move is the finding.**
#   src/worker/** is expected UNCHANGED — the new persist line is a property inside an existing object
#   literal, not a new statement and not a new branch, so v8 has nothing extra to count, and Edit 3c
#   adds a test to a file already in the suite. If any src/worker/** number DOES move, diff its
#   "Uncovered" list against HEAD before proceeding rather than accepting the move as expected. If any
#   floor FAILS, the cause is a new import dragging a denominator — diff the "Uncovered" lists against
#   HEAD; NEVER edit vitest.config.ts thresholds (the block is :187-220; the tightest in the repo is
#   src/lib/queue branches at 80).
grep DATABASE_URL .env.test      # localhost:5432 — podman judge-arena-pg. STOP if it is anything else: the next line resets that database.
npm run test:db:coverage         # 674 db (the 33b7be4 measurement) — no schema/migration change, so identical to baseline
# The comment-only schema edits (Task 1 Step 7 and Step 1 above) must produce NO migration. The diff
# runs HERE, after test:db:coverage, and not before it: that run has just done
# `prisma migrate reset --force`, so judge_arena_test is guaranteed to sit exactly at the migration
# chain state and this read-only diff answers precisely "does schema.prisma differ from the
# migrations?". Run before it, an un-migrated local DB makes it error or lie.
sh -c 'set -a; . ./.env.test; set +a; npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script'
#   Expected: "-- This is an empty migration."
npm run test:integration         # 82 — pairwise-run.test.ts now asserts persisted.parseMode
npm run build
git -C /root/judge-arena diff --stat
#   exactly 15 files: judgment-schema.ts, registry.ts, judgment-consumer.ts, provider.ts, schema.prisma,
#   4 test files (judgment-schema-pairwise, pairwise-execution, judgment-consumer-escalation,
#   integration/pairwise-run), README.md, runbook, handoff, register, scoreboard spec, baseline spec
#   (all tracked modifications — no new files in Tasks 2–4, so diff --stat is complete here)
#
# A FILE COUNT CANNOT PROVE THE EIGHT DOC EDITS LANDED: 3c and 3d share the runbook, 3f and 3h share
# the register. Applying 3f and silently skipping 3h leaves exactly 15 files and a green diff --stat
# while the register carries a CLOSED note in §5.5 and its own measured table still asserts the
# corrected-away claim — the self-contradicting document this plan exists to fix. Count per FILE
# (baseline -> after commit A -> after commit B; all baselines measured on 33b7be4):
grep -acE 'CORRECTION \(?2026-09-01' README.md                                                              # 0 -> 1 -> 3  (3a, 3b)
grep -acE 'CORRECTION \(?2026-09-01' docs/runbooks/scoring-a-judge-against-a-golden-set.md                   # 1 -> 2 -> 4  (3c paren-LESS, 3d parenthesised)
grep -acE 'CORRECTION \(?2026-09-01' docs/superpowers/plans/2026-08-30-state-and-next-steps.md               # 1 -> 2 -> 3  (3h register row)
grep -acE 'CORRECTION \(?2026-09-01' docs/superpowers/specs/2026-08-31-calibration-baseline-and-footprint.md # 0 -> 1 -> 2  (3h baseline row)
grep -acE 'CORRECTION \(?2026-09-01' docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md # 2 -> 2 -> 3  (3g)
grep -ac  'CLOSED 2026-09-01' docs/superpowers/plans/2026-09-01-scoreboard-handoff.md                        # 0 -> 1 -> 2  (3e)
grep -ac  'CLOSED 2026-09-01' docs/superpowers/plans/2026-08-30-state-and-next-steps.md                      # 0 -> 2 -> 3  (3f)
grep -acF 'The PAIRWISE path records the same two values' src/lib/llm/provider.ts                            # 0 -> 0 -> 1  (Step 2)
grep -acF 'READ THE' prisma/schema.prisma                                                                    # 0 -> 0 -> 1  (Step 1, the flag-not-caps rule)
```

- [ ] **Step 5: Commit B**

```bash
cd /root/judge-arena
git -C /root/judge-arena add src/lib/llm/judgment-schema.ts src/lib/llm/registry.ts src/lib/llm/provider.ts src/worker/judgment-consumer.ts prisma/schema.prisma tests/lib/judgment-schema-pairwise.test.ts tests/lib/pairwise-execution.test.ts tests/lib/judgment-consumer-escalation.test.ts tests/integration/pairwise-run.test.ts README.md docs/runbooks/scoring-a-judge-against-a-golden-set.md docs/superpowers/plans/2026-09-01-scoreboard-handoff.md docs/superpowers/plans/2026-08-30-state-and-next-steps.md docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md docs/superpowers/specs/2026-08-31-calibration-baseline-and-footprint.md
git -C /root/judge-arena commit -F - <<'EOF'
feat(llm): record parseMode on pairwise judgments — structured only when guided decoding needed no repair

Handoff 2026-09-01 §7 item 11: `parseMode` was NULL on every pairwise row
because `tryParsePairwiseJudgment` is one fence-tolerant path with, the
docs said, "no strict-then-lenient demotion to record". That was the
wrong conclusion from a true premise. The demotion is observable inside
the one path — did a ```json fence have to be stripped, did "a" have to
become "A" — and it is the exact thing register §5.5/1 said was missing:
a leniently-repaired verdict and a clean one were indistinguishable
afterwards, on the only protocol this product has exercised in production
(all 270 model judgments in the 2026-09-01 ledger).

The parser now returns `lenient` (fence stripped OR verdict normalised).
`executePairwiseCall` records `parseMode = structuredOutputRequested &&
!lenient ? 'structured' : 'fallback'` — the pointwise rule: 'structured'
is only possible when the request attached a schema (llamacpp, ollama,
vllm), never on anthropic/openai/openrouter, and then only when the
constrained decoder's output needed nothing done to it. One documented
difference, on the schema comment: pointwise 'structured' means the strict
parse succeeded; pairwise 'structured' means no repair was needed, and
extra keys are ignored — weaker, and anything grouping on this column
across protocols must know it.

The parse OUTPUT is unchanged. A fenced or lower-cased verdict is accepted
exactly as before; it is merely no longer indistinguishable. No migration
(TEXT NULL column exists), no backfill: every pre-change pairwise row stays
NULL, and the schema comment lists every NULL case — respond mode, v1
import, error rows of any protocol, pre-change pairwise — so NULL is never
read as 'fallback'. The comment states no row COUNT: the 270 in the
handoff's §1 table is a total judgment count, not a measured pairwise count,
and the post-promote checklist measures the real one read-only.

Seam count, per §5.1: the registry object crosses defaultRunProviderPairwise
and index.ts unchanged, so the places that could drop the value are the seam
type, persistPairwiseSuccess, and that unchanged passthrough itself. The
seam field is optional for symmetry with JudgmentResult (there is one
pairwise fake and it is updated here, so nothing is kept compiling by the ?)
— which means both deleting the persist line AND rewriting the passthrough
into an explicit field map type-check green.
tests/integration/pairwise-run.test.ts pins the column write and was
verified red with that deletion; tests/lib/judgment-consumer-escalation.test.ts
pins the passthrough and was verified red with that field map, while tsc,
the registry unit tests and the integration test all stayed green on it —
that assertion is green from the moment it was written and the injection is
its only evidence. tests/lib/pairwise-execution.test.ts pins both arms of
the rule against the real callOpenAICompatible on llamacpp (structured;
fenced → fallback; "a" → fallback) and openai (caps none → fallback with no
response_format sent). It also pins ANTHROPIC, whose caps are `tool_use` and
not 'none': that is the only case that separates "a schema was attached to
this request" from "this descriptor could have attached one", and a
caps-keyed implementation is red on it alone. Every comment this commit
writes states the flag, never the caps, for the same reason. Each verified
red by injection; the one known NON-injection (`?? 'fallback'` on the
persist line, invisible to a single-valued fake) was run, observed green,
and is recorded as a limit rather than claimed as coverage.

README and runbook rows carried CORRECTION notes ("gaps rather than bugs"
now describes only reasoningTokens; the registry.ts:1005-1007 reference was
stale and is cited by symbol). Handoff #11, register §5.5/1 and the
scoreboard spec §7 are marked closed with the decision; the measured-table
rows in the register and the 2026-08-31 baseline spec carry the same note.

Regression check for the operator after promotion: re-run the granite4.1:3b
30-item calibration; verdicts must stay bit-identical (handoff §2).

Gates: lint 0, tsc 0, 906 unit / 674 db / 82 integration, coverage 0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
EOF
git -C /root/judge-arena log -2 --oneline
```
(The `906 / 674 / 82` above is the PREDICTION from Step 4. Put the real counts Step 4 printed in the `Gates:` line, never the predicted ones — a `Gates:` line no later reader can distinguish from a measurement is worse than no line at all.)

---

## Post-promote checklist (OPERATOR, not a plan step)

After the operator pushes, confirms the Harbor tag (`skopeo inspect --no-tags docker://harbor.cluster.asethi.com/homelab/judge-arena:sha-$(git -C /root/judge-arena rev-parse main | cut -c1-12)`), and promotes via a separate homelab-setup PR:

1. **CLUSTER MUTATION — operator only, after the preflight-mutation-review skill; never run from a plan-execution session.** (It creates EvaluationRuns/ModelJudgments and publishes to `judge.dispatch`.) **The §2 regression check** — 108 s of granite4.1:3b. Parse output is unchanged by this plan, so the verdicts MUST be bit-identical to the two earlier runs:
   ```sh
   kubectl -n tenant-public exec deploy/judge-arena-web -- node /app/calibration-run.js \
     --golden-set=cmt057hd001g17y01lhjzgfuj --judge-version=<granite4.1:3b JudgeModelVersion id>
   ```
   (Do not launch while another calibration drains on the same Ollama host — handoff trap 9. If the poll expires, wait for the drain and `--score-only=<calibrationRunId>` — trap 8.) A differing verdict on any of the 30 items has a real cause and is a stop-the-line finding.
2. In the same report, read the three new lines: `reasoningTokens (usage-reported; expected 0/n on llama.cpp/Ollama) 0/30`, `reasoningContent chars   completed  n=…  mean=…  max=…` and `reasoningContent chars   error  …`. On a clean granite4.1 run expect `completed  n=30` with a small mean (it reasons ~109 tokens) and `error  none captured`. **What the lines can and cannot show:** they are a size summary of two populations, nothing more. They diagnose a repetition loop only by CONTRAST — an `error` mean several times the `completed` mean — which is the shape §5.2 measured (44,287 vs 13,138) and the shape a run with no failures cannot exhibit. A single high `completed` mean is a verbose judge, not a finding. Per-item chars for each failure were already printed by `cap()` in the Failures block before this change; the new contribution is the completed-population baseline they are read against.
3. Confirm the new column value, read-only. First the count the schema comment deliberately does not state:
   ```sh
   kubectl -n tenant-public exec judge-arena-pg-1 -c postgres -- psql -U postgres -d judge_arena -c "
     SELECT count(*) FROM \"ModelJudgment\" WHERE \"pairOrder\" IS NOT NULL AND \"parseMode\" IS NULL;"
   ```
   That is the real number of pre-change pairwise rows (the plan's "270" was the handoff's TOTAL judgment count, never measured as a pairwise count). Error-status pairwise rows are NULL for a different listed reason and are included in it, so read it as "rows that will stay NULL", not as "rows the change missed". Then the distribution:
   ```sh
   kubectl -n tenant-public exec judge-arena-pg-1 -c postgres -- psql -U postgres -d judge_arena -c "
     SELECT mj.\"parseMode\", count(*) FROM \"ModelJudgment\" mj
       JOIN \"EvaluationRun\" er ON er.id = mj.\"runId\"
      WHERE er.\"calibrationRunId\" = '<new calibrationRunId>' GROUP BY 1;"
   ```
   Expected on Ollama (caps `json_schema`, honours `response_format`): `structured` on the completed rows, NULL on any error rows. A large `fallback` share on a self-hosted judge means it is fencing or lower-casing despite guided decoding — a finding about the judge, not about this change.

---

## Self-review

**1. Spec coverage.**
- #10 document (schema :520, README :578, runbook :348) — Task 1 Steps 7–8. De-list from the checklist as a labelled line (run.ts :331) — Step 6b. Two `reasoningContent chars` lines after the loop, split `completed` / `error` — Step 6c, with the template, its label and its null branch in `formatReasoningLengthLine` so all three are tested and injected rather than stranded in the untestable script (+ helper, Steps 1–5). `reasoningChars=` in the dump — Step 6d. No derivation, no drop, no default — stated in every comment. Handoff #10 + register §5.5/2 + §5.6/9 closed — Step 8d/8e. Register measured-table row :668 + baseline spec :341 — Step 8f. README :598 stale ref is NOT touched (owned by `repetition-loop-detector`; former Edit 8b removed on review).
- **Revision 2026-09-02, on review.** The line was originally specified POOLED (`judgments.map(...)`, one line over all 30 rows) and four documents claimed it was "the signal §5.2 used to detect the repetition loop". It was not: §5.2's evidence is a 25/5 SPLIT (13,138 vs 44,287) and the pooled line prints 18,330 on that exact run, which no assertion in the plan could have falsified — six passing tests over a correct pure function, plus a post-promote step that reads the line without being able to check the claim attached to it. The helper is now fed a status-split input, a fixture reproduces the 25/5 shape and pins that the pooled line does not discriminate, and every doc claim is narrowed to what the two lines actually show. The plan also failed to mention that per-failure chars were ALREADY printed (`cap()` at `run.ts:422`), which over-stated what the new line adds; that is now stated in the Facts block, the docs and the commit body.
- #11 `lenient` on `ParsedPairwiseJudgment` set in `tryParsePairwiseJudgment` — Task 2. `PairwiseResult.parseMode` set in `executePairwiseCall` by the exact rule — Task 3 Step 5a/5c. `PairwiseJudgmentResult.parseMode?` optional + `persistPairwiseSuccess` writes it — Step 5d/5e. Schema comment listing respond / v1 import / error rows / pre-change pairwise AND the semantic caveat — Task 4 Step 1. 7 `toEqual` updates + lenient cases (fenced → true, lowercase → true, clean → false) — Task 2 Step 1. llamacpp clean → structured; llamacpp fenced → fallback; openai clean → fallback mirroring backends.test.ts:224-363 — Task 3 Step 3 (plus a lowercase-verdict case, plus the anthropic case that discriminates `raw.structuredOutputRequested` from `descriptor.caps.structuredOutput !== 'none'`, with its own `@anthropic-ai/sdk` mock in Edit 3b and Injection E in Step 7). Integration: fake gets `parseMode`, `persisted.parseMode` asserted after :324 — Task 3 Step 1. Seam PASSTHROUGH pinned in `tests/lib/judgment-consumer-escalation.test.ts` — Task 3 Step 3 Edit 3c, evidence = Injection F. README :574-579, runbook :344-349, handoff :376-377 (with the re-anchor note for `finalizer-error-to-needs-human`), register :387-391 and :669, baseline spec :342, scoreboard spec :671-672 CORRECTIONs — Task 4 Step 3 (3a–3h). Those are `33b7be4` numbers; three of them shift when commit A lands and Task 4's **Files** list gives the shifted value — every `old_string` is anchored on quoted text and was re-verified verbatim. Integration fake carries `'fallback'` so a hardcoded/defaulted `'structured'` in `persistPairwiseSuccess` is red (Injection D), not only the deleted line (Injection C). Two commits, `feat(calibration)` / `feat(llm)` — Task 1 Step 10, Task 4 Step 5. Regression re-run as an operator checklist item — above.
- **Revision 2026-09-02, on review (#11).** Three defects fixed. (a) The `PairwiseResult` docblock and the `ModelJudgment.parseMode` schema comment both DEFINED the rule as "descriptor caps not 'none'" and then asserted "anthropic never" in the same sentence — a self-contradiction, because anthropic's caps are `tool_use` (`registry.ts:161`), and it is precisely the mis-implementation Injection E exists to catch. Both now state the MECHANISM (`raw.structuredOutputRequested`, set only by `callOpenAICompatible`) and name the anthropic case explicitly as the reason. (b) Injection B's predicted blast radius was 3 tests; it is 4 — the anthropic case, added by this same plan, also asserts `'fallback'`. Under the plan's own "if only one fails, investigate" convention that would have sent an executor hunting a phantom. (c) The `defaultRunProviderPairwise` passthrough was named as safe and pinned by nothing; Edit 3c and Injection F close it, and Injection F's expectation records that tsc, the registry unit tests AND the integration test all stay green on a real drop.
- One deliberate divergence from the orchestrator's test list: "commonSuccessUpdateData persists parseMode" cannot be literally true under the critique's binding exact edit (the write goes in `persistPairwiseSuccess`, not the shared mapping — critique `q2 … capture-field-gaps.exactEdits`), so the unit test asserts the value on the registry result inside the existing persist-mapping case, and the column write is pinned by the integration test, which is the only place `persistPairwiseSuccess` is reachable. Recorded in `decisionsMade`.

- **Accepted verification gaps, stated so they are not mistaken for coverage.** (i) The four
  `scripts/calibration/run.ts` edits (Task 1 Step 6a–6d) have no test and no injection — that file is
  outside every vitest `include` — so they are lint- and tsc-gated only, with post-promote checklist
  item 2 as their sole behavioural check. The gap is now as small as it can be made: the report
  TEMPLATE, its status LABEL and its null branch were moved into `formatReasoningLengthLine`, which
  is tested (3 cases, including the 25/5 split fixture that pins the two-population design) and
  injected twice (Step 5, fourth and fifth injections), leaving an import, two
  `.filter(...).map(...)` expressions, two `console.log`s, one checklist label string and one
  dump-line interpolation unverified. In particular **nothing in the suite can catch a wrong status
  predicate in run.ts** (`!== 'completed'` where `=== 'error'` was meant) — only checklist item 2
  reading the printed lines can. The limit is written into Step 6 itself.
  (ii) The integration guard on the persist write is SINGLE-VALUED. The fake
  (`tests/integration/pairwise-run.test.ts:113`) always supplies `'fallback'`, so
  EITHER `parseMode: result.parseMode ?? 'fallback'` OR `?? 'structured'` in
  `persistPairwiseSuccess` would type-check green AND pass: `result.parseMode` is always
  `'fallback'`, so the `??` never fires either way. What the single value DOES catch is the deleted
  line (Injection C, row reads NULL) and a hardcoded `'structured'` constant (Injection D) — the
  latter only because the fake carries `'fallback'` rather than `'structured'`; Step 7 D says
  explicitly that `?? 'structured'` is a NON-injection and must not be used as one. **Revised
  2026-09-02: this gap is now DEMONSTRATED rather than asserted** — Step 7 adds non-injection D′,
  which applies `?? 'fallback'`, runs the integration file, observes GREEN and records that green.
  A demonstrated non-injection is auditable evidence; a claimed one is not
  (CONTRIBUTING.md:210-234). Closing the hole properly still needs a second `it` in that describe
  driving the same launch → dispatch → handle flow with a `'structured'`-valued fake (two distinct
  values across one seam kill every constant and every default at once); that remains judged too
  expensive for this commit — a fully duplicated fixture flow plus an 83rd integration test and
  three more count updates — and is recorded HERE rather than only in the fake's code comment.
  Partial mitigation: Edit 3c's seam test carries `'structured'` while the integration fake carries
  `'fallback'`, so no single constant satisfies both guards, even though neither alone sees a `??`.
  (Former gap (ii), "anthropic pairwise is untested", is CLOSED: Task 3 Step 3 pins it directly and
  Injection E is the caps-based mis-implementation. Former gap "the passthrough is unpinned" is
  CLOSED by Edit 3c + Injection F.)

**2. Placeholder scan.** No TBD/TODO/"similar to"/"handle edge cases". The only executor-substituted values are the two `<…>` ids in the OPERATOR checklist (not plan steps) and the real gate counts in the `Gates:` lines, which are explicitly told to be measured, not predicted.

**3. Type consistency.** `formatReasoningLengthLine(summary: ReasoningLengthSummary | null, label: string): string` (Task 1 Step 3) ← called with `summarizeReasoningLength(...)`, whose return type is exactly `ReasoningLengthSummary | null`, and with `status` from `['completed', 'error'] as const`, which is assignable to `string` (Step 6c). `judgments[i].status` is Prisma's `JudgmentStatus` union `'pending' | 'running' | 'completed' | 'error'` (`prisma/schema.prisma:74-79`), so `j.status === status` narrows legally. `lenient: boolean` (Task 2) ← read as `parsed.lenient` (Task 3 5c). `parseMode: 'structured' | 'fallback'` required on `PairwiseResult` (5a), optional on `PairwiseJudgmentResult` (5d), written as `result.parseMode` (5e), asserted as `'fallback'` in the fake/round-trip (Task 3 Step 1 — the non-default value) and as `'structured'`/`'fallback'` on `result.parseMode` in the unit cases. `summarizeReasoningLength(contents: readonly (string | null | undefined)[]): ReasoningLengthSummary | null` (Task 1 Step 3) ← called with `judgments.filter((j) => j.status === status).map((j) => j.reasoningContent)` where `reasoningContent: string | null` (Step 6c). Edit 3c's `executePairwiseMock.mockResolvedValue({… parseMode: 'structured'})` is untyped (`vi.fn()`), and the call goes through `(mod as any)`, so it type-checks both before and after Edit 5d — it is a runtime pin, not a type pin. Injection F's replacement object supplies exactly the four fields `PairwiseJudgmentResult` requires (`verdict`, `reasoning`, and `CommonResultFields`' `rawResponse` + `latencyMs`, `judgment-consumer.ts:696-719`), which is why tsc stays at 0 on it. `anthropicCreateMock` resolves the shape `callAnthropic` actually reads — `{ model, content: [{type:'text', text}], stop_reason, usage: {input_tokens, output_tokens} }` (`anthropic.ts:40-58`) — and `servingBackend: 'anthropic' as const` is a legal `ServingBackend` on `RunProviderJudgmentInput` (Task 3 Step 3). `okChatResponse`, `pairwiseInput`, `prepareJudgmentCall`, `executePairwiseCall`, `JUDGMENT_JSON_SCHEMA_NAME`, `PAIRWISE_JUDGMENT_JSON_SCHEMA`, `RunProviderJudgmentInput` all already exist in `tests/lib/pairwise-execution.test.ts:33-81`.
