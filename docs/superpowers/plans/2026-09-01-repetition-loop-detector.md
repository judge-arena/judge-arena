# Repetition Loop Detector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the truncation guard in `execute()` say "this is a degenerate repetition loop — raising `max_tokens` buys a longer loop" when the failing output deflates like a loop, instead of unconditionally advising an operator to raise `max_tokens`.

**Architecture:** One new pure module `src/lib/llm/degeneration.ts` measures the deflate ratio of each output channel (reasoning, content) independently and returns a `RepetitionMeasure` when a channel that clears an 8,000-char floor compresses ≥ 5×. `assertUsableContent` in `src/lib/llm/registry.ts` — the single chokepoint every seam inherits — consults it only after it has already decided to fail the call, swaps the advice sentence, and stamps the measure on the `ProviderError` as `repetition` (same auditable-flag pattern as `timeout`/`attempt`/`callResult`). No schema, queue or consumer change: `markJudgmentError` already persists the message and the reasoning channel.

**Tech Stack:** TypeScript, Node ≥ 22 `zlib.deflateSync` (bare builtin import, repo convention), vitest, existing client-level SDK mocks in `tests/lib/llm-truncation.test.ts`.

**Spec:**
- Handoff §5.2 and §7 item 3: `/root/judge-arena/docs/superpowers/plans/2026-09-01-scoreboard-handoff.md:211-244, 346-347` (re-anchored on `33b7be4`; §7 item 3 was `:334-335` before wave 2)
- Scoreboard spec §5.4.2: `/root/judge-arena/docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md:459-520` (heading `:459`, next `###` at `:521`; was `:438-499` before wave 2)
- Verified map + corrections: recorded inline in this plan's **Owner decisions needed**, Task 2 Step 4 and the **Self-review**. The originating `/tmp/ja-plan-inputs/loop-vs-truncation.json` and `/tmp/ja-plan-inputs/critique.json` were scratch files, are not part of the repo, and are gone as of 2026-09-02 — every correction they carried is already folded into this plan. Do not block on them.

**Priority / wave:** Wave 2 / #8 (S). The in-repo cross-references use **#8** (`capture-field-gaps` **Doc-range ownership**, line 20); it was dispatched fifth in wave 2. Same item — #8 is the authoritative label because other plans in the tree cite it.

**Depends on:**
- `calibration-sampling-snapshot` — **LANDED** as `a96cf94` + `33b7be4` (wave 2 v2k).
- `capture-field-gaps` — reframes `scripts/calibration/run.ts`'s failure report around reasoning-chars. This plan does not touch `run.ts`; the dependency is only so the runbook text written in Task 4 describes the report as it will print. **Not landed as of `33b7be4`** — if it lands before this plan runs it shifts the runbook above §8.2 and `README.md:578`; every doc edit below matches on quoted text, so re-anchor with `grep -n` and do not trust a printed number.

> **CORRECTION (2026-09-02).** Earlier revisions of this plan said "main is `5e48187`", that
> `calibration-sampling-snapshot` "WILL move" the registry.ts numbers, that the extraction was of
> `registry.ts:412-459`, and that the resulting shift would be "roughly −45". All four are now
> wrong and are recorded here rather than silently overwritten (CONTRIBUTING.md:1653-1656).
> What actually happened: wave 2 landed `a96cf94` (extracts the sampling resolver into the new leaf
> `src/lib/llm/sampling.ts`; `registry.ts` now imports it at `:94` and re-exports at `:422-423` and
> **defines none of it**) and `33b7be4` (v2k `CalibrationRun.samplingParams`, migration
> `20260901180000_v2k_calibration_sampling_snapshot`, APPLIED). The measured shift for every
> `registry.ts` line at or after the old `:460` is **−36**, not −45. Concretely, re-verified on
> `33b7be4`: `import { ProviderError } from './errors';` is still `:75` (above the extraction point,
> unshifted); `assertUsableContent`'s doc comment is `:574-605` (this plan used to say `:610-641`);
> the function body is `:606-647` (used to say `:642-683`); `ExecuteRequest.mode` is `:440` (used to
> say `:476`). Wave 2 also shifted the docs: spec §5.4.2 heading `:438 → :459`, the chess clause
> `:450 → :471`, "Recorded as a follow-up" `:489 → :510`; handoff §7 item 3 `:334 → :346` (wave 2
> inserted a "Landed (v2k) — with a CORRECTION" block at spec `:238-256`, +21 below it, on top of
> wave 1's +10). **Every `old_string` block in this plan was re-verified byte-for-byte against
> `33b7be4` and still matches exactly** — this was anchor rot in the prose, not a broken edit.
> Nothing else in this plan's dependency story changed: `errors.ts` (`:37`/`:100`/`:114`/`:125`) and
> `provider.ts` were not touched by either wave.

**Owner decisions needed:**
1. **Threshold 5 has a thin margin on granite4.2 itself.** Measured today (read-only, production, deflate on `reasoningContent`): run 9's five failures = 5.23× / 6.26× / 7.07× / 10.79× / 29.27×; its five sampled completions = 3.00–4.09×. So 5 separates run 9's own rows. But across ALL 18 completed granite4.2 judgments with ≥ 8k reasoning chars the max is **5.38×** (32,899 chars, no repeated 80-char shingle — verbose, not looping), and the 5.23× failed row likewise has no repeated shingle. The detector never runs on a completed row, so 5.38× is not a production false positive; it does mean a verbose-but-genuine granite4.2 truncation at 30k+ chars could be told "loop". Default in this plan: **keep 5 (binding decision)**, record the numbers in the commit body, and name the alternative (6 — clears 5.38, drops the ambiguous 5.23 row to the old advice) in the same body. Changing it later is a one-constant edit; the fixtures hold at either value (legit ≤ 3.4×, loops ≥ 14×).
2. The message says "ordinary prose compresses ~2-4x". The binding decision text said "~2-3x"; measured granite4.2 prose is 3.0–4.1× (run 9's five completed rows: 3.00 / 3.19 / 3.14 / 3.93 / 4.09×) and Qwen's 2.6–3.8×, so "~2-3x" would be false for the very judge the message was written about. **Default in this plan: ship "~2-4x"** (the literal is the plan's own measurement). If the owner wants the binding string instead, say so before Task 3 starts and the executor reverts the one literal in all three places it appears — the `advice` template in Task 3 Step 4(c), the loop message in Task 3's Interfaces block, and the quoted loop message in the runbook text of Task 4 Step 1. No other change.

## Global Constraints

- Repo: /root/judge-arena (Next.js 15.5.22, TypeScript, Prisma on Postgres — Json maps to JSONB —, amqplib 2.0.1, vitest). Node >= 22. Always use `git -C /root/judge-arena` for git (handoff trap 2: a stale `cd` once hard-reset the wrong repo). The `cd /root/judge-arena && …` prefixes below are npm/npx only and NEVER precede a git command.
- Gates, in this order, all must be clean before every commit that touches code (for a MARKDOWN-ONLY commit the precedent is lint + tsc and a `Gates:` line that says the rest was not rerun — `5e48187` is the only markdown-only commit that did this; see Task 4 Step 6 for the corrected precedent list): `npm run lint` (0 warnings) → `npx tsc --noEmit` → `npm run test:coverage` (unit; per-glob floors in vitest.config.ts:187-220 — NEVER lower a floor; if a new test import drags a module into a denominator, mock the seam as tests/lib/judgment-consumer-escalation.test.ts:41-69 does) → `npm run test:db:coverage` (RESETS the database at .env.test — verified today to be localhost:5432, the local podman `judge-arena-pg`, NOT the k8s `judge-arena-pg-1`; re-confirm with `grep DATABASE_URL /root/judge-arena/.env.test` before the first run) → `npm run test:integration` → `npm run build`. **Baseline measured on `33b7be4` (2026-09-02): 888 unit / 57 files; 674 db / 46 files; 82 integration / 11 files.** Re-measure before using any count; an unexplained delta against these figures is itself a finding, not a number to copy.
  - **Every earlier figure in circulation is stale.** 869 / 872 / 877 / 879 unit, 670 db, 80 integration are all pre-wave-2. Wave 2 added `tests/lib/sampling.test.ts` + `tests/lib/calibration-sampling-drift.test.ts` (+11 unit, +2 files) and 4 tests to `tests/db/calibration-link.test.ts`; wave 1 had already moved unit 872 → 877 and integration 80 → 82. If a step below quotes an illustrative absolute, it is derived from **888 / 57 / 674 / 46 / 82 / 11** and is still only an illustration — the printed number wins.
- TDD with an INJECTION step (CONTRIBUTING.md:210-234): every behaviour test must be shown to go RED by a deliberate breakage of the implementation and GREEN again after; a test that stays green after injection is a finding. Each task's steps must include the injection.
- One concern per commit/PR (CONTRIBUTING.md:1639). Wrong statements in docs get an explicit CORRECTION note, never a silent overwrite (CONTRIBUTING.md:1653-1656 — PR guideline 8). **Both citations re-verified on `33b7be4`** — wave 1 rewrote CONTRIBUTING.md:1221-1247 and shifted everything below by ~+79, and wave 2 did not touch the file, so these two numbers are current.
- Commit subject: `type(scope): lowercase summary` (feat/fix/docs/ci; scopes seen: worker, llm, queue, calibration, ci, docker). Body: narrative, then a `Gates: lint 0, tsc 0, <n> unit / <n> files, <n> db / <n> files, <n> integration / <n> files, coverage 0.` line, then EXACTLY these trailers. **Both forms of the Gates line are in use and the two most recent commits omit the file counts** (`a96cf94` and `33b7be4` both read `Gates: lint 0, tsc 0, <n> unit / <n> db / <n> integration, coverage 0.`, as does `270dc50`; `e103d43` and `20fc4fc` carry file counts). This plan keeps the file counts, because they are the cheaper thing to compare against a re-measure — but do not justify that by claiming "the last four commits all carry them", which was true before wave 2 and is not true now. For a markdown-only commit use `5e48187`'s skip form instead — see Task 4 Step 6:
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
- Commit LOCALLY only. Never push, never promote; the operator does that (push-to-main fires CI and builds an image; promotion is a separate homelab-setup PR).
- Migration naming (**inert for this plan — it touches no schema; kept only so a mid-flight decision to add one does not collide**): `prisma/migrations/<YYYYMMDDHHMMSS>_v2<letter>_<snake>/migration.sql`. The next free letter is **v2l**; `20260901180000_v2k_calibration_sampling_snapshot` is taken and APPLIED to the test database, so a timestamp must sort after **20260901180000**. Narrative `-- v2x — ...` header in the v2i/v2j style; ZERO hand edits (content must equal what `prisma migrate diff` emits), then `npx prisma generate`. `CalibrationRun.samplingParams` already exists (v2k) — do not re-add it, and read run config from the run header rather than joining to `JudgeModelVersion.samplingDefaults`.
- GREP TRAP live in HEAD: /root/judge-arena/src/lib/calibration/readings.ts:164 and /root/judge-arena/scripts/importer/reconcile.ts:294 contain a deliberate NUL byte; plain grep returns nothing for those files. Use `grep -a`. NEVER remove the NUL.
- main is **`33b7be4`** (2026-09-02). This plan was written against `fc9e936`; TWO waves have landed since and neither is docs-only. Wave 1 (`fc9e936..5e48187`, nine commits) touched `src/lib/llm/index.ts`, `src/lib/llm/resilience.ts`, `src/worker/health.ts`, `src/worker/main.ts`. Wave 2 (`a96cf94`, `33b7be4`) created `src/lib/llm/sampling.ts` and `src/lib/calibration/sampling-drift.ts`, edited `src/lib/llm/registry.ts`, `prisma/schema.prisma`, `src/lib/calibration/launch.ts`, `scripts/calibration/run.ts`, and applied migration v2k. Re-measure every count and re-anchor every cited line number before using it. Production is sha-d21f31d47c35 and is behind main; promotion is the operator's. Do not touch homelab-setup from a judge-arena task except where the plan explicitly says "separate PR in /root/homelab-setup".
- **Import the leaf, not the barrel.** `SamplingParams` / `effectiveSamplingParams` now live in `src/lib/llm/sampling.ts`; `registry.ts:422-423` only re-exports them. This plan imports neither, but if a step ever needs them, import from `@/lib/llm/sampling` — pulling `@/lib/llm` or `@/lib/llm/registry` re-bundles `@anthropic-ai/sdk` and `redis` into `scripts/calibration/run.ts`'s esbuild output, which is exactly what wave 2 Task 1 existed to prevent.
- Any cluster/DB access in a plan step is READ-ONLY (psql SELECT, kubectl get/logs, rabbitmqctl list_queues). No requeue-peeks of judge.dlq (quorum delivery_limit 20 — every peek burns one).

---

## What was measured before this plan was written (2026-09-01, read-only)

The executor re-runs all of this in Task 1; these are the numbers to compare against. Deflate = Node `zlib.deflateSync` at the default level over the UTF-8 bytes of `ModelJudgment.reasoningContent`; ratio = bytes / compressed bytes.

Calibration run 9 is `CalibrationRun.id = cmtircx0x00012b5zasyrbgpl` (granite4.2:3b, startedAt 2026-09-01 14:24, verdictCount 25, 5 errors). Every one of its rows carries `reasoningSource = 'reasoning'` (Ollama's key), so the production-faithful unit case is the `message.reasoning` shape.

| status | finish | outputTokens | reasoning chars | content chars | deflate ratio |
|---|---|---|---|---|---|
| completed | stop | 1527 | 6,228 | 199 | 3.14× |
| completed | stop | 1620 | 6,312 | 215 | 3.19× |
| completed | stop | 2684 | 9,191 | 336 | 3.00× |
| completed | stop | 3179 | 13,707 | 279 | 3.93× |
| completed | stop | 5062 | 20,137 | 341 | 4.09× |
| error | length | 12288 | 52,702 | 0 | **5.23×** |
| error | length | 12288 | 40,391 | 0 | **29.27×** |
| error | length | 12288 | 45,790 | 0 | **6.26×** |
| error | length | 12288 | 56,004 | 0 | **10.79×** |
| error | length | 12288 | 26,549 | 0 | **7.07×** |

Population scan (every judgment with ≥ 8,000 reasoning chars): completed granite4.2 n=18, max 5.38× (32,899 chars); completed Qwen3.6 n=74, max 3.83×; failed granite4.2 across runs 8+9 n=20, range 3.38–29.27× (run 8's 4096-budget failures include an 11,680-char row at 15.74× — a loop that the old advice told the operator to raise the budget on, which is exactly what run 9 then did). A repeated-80-char-shingle scan finds verbatim cycling in the 29.27×/10.79×/7.07×/6.26× rows and in none of the 5.23× and 5.38× rows.

Synthetic fixture arithmetic (the exact code in Task 2, run through node): `loopPure(44_000)` 140.1×, `loopAfterPrefix()` 14.4×, `loopNumbered()` 31.8×, `legitLong(13_138)` 3.08×, `legitLong(20_000)` 3.18×, `legitLong(44_287)` 3.35×, `legitLong(56_004)` 3.39×, `'x'.repeat(8_000)` 285.7×, `'x'.repeat(1_164)` 64.7×, `'漢字の判定'.repeat(2_000)` 297× (10,000 chars / 30,000 bytes). Injection value 1_000 sits above every loop fixture; 100 would NOT (pure clause 140×).

---

## File map

| file | action | responsibility |
|---|---|---|
| `src/lib/llm/degeneration.ts` | create | pure detector: constants, `RepetitionMeasure`, `isLoopRatio`, `measureRepetition`, `detectRepetitionLoop` |
| `src/lib/llm/errors.ts` | modify | optional `repetition?: RepetitionMeasure` on `ProviderErrorOptions` and `ProviderError` |
| `src/lib/llm/registry.ts` | modify | `assertUsableContent`: consult the detector, swap the advice, attach `repetition`; CORRECTION in its doc comment; import |
| `tests/lib/reasoning-fixtures.ts` | create | deterministic fixture generators (not collected as a test) |
| `tests/lib/degeneration.test.ts` | create | pure detector suite, imports only `@/lib/llm/degeneration` + the fixtures |
| `tests/lib/llm-truncation.test.ts` | modify | execute()-level loop cases (this file already imports the consumer with `@/lib/db` mocked — do not create a second consumer-importing file) |
| `docs/runbooks/scoring-a-judge-against-a-golden-set.md` §8.2 | modify | both messages + CORRECTION |
| `README.md` §"Truncation is now a HARD FAILURE" | modify | loop paragraph + CORRECTION |
| `docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md` §5.4.2 | modify | "shipped in" + CORRECTION on "all five cycling verbatim" |
| `docs/superpowers/plans/2026-09-01-scoreboard-handoff.md` §7 item 3 | modify | "shipped in" line |

Commits: Task 3 makes the single `feat(llm)` commit (Task 2's files are staged into it — the module alone has no product effect and the binding decision is one feat commit); Task 4 makes the `docs(llm)` commit, which needs the feat sha.

---

### Task 1: Measure the real rows before pinning anything (read-only, no commit)

**Files:**
- Create: none
- Modify: none
- Test: none (this task produces the numbers that go into Task 3's commit body)

**Interfaces:**
- Consumes: production Postgres `judge-arena-pg-1` via `kubectl exec … psql` (SELECT only)
- Produces: a ten-row ratio table + population maxima + shingle verdict, kept in the executor's notes and pasted verbatim into the Task 3 commit body

- [ ] **Step 1: Confirm which CalibrationRun is run 9**

Run:
```bash
kubectl -n tenant-public exec judge-arena-pg-1 -c postgres -- psql -U postgres -d judge_arena -At -c "SELECT cr.id, jm.name, cr.\"startedAt\", cr.\"verdictCount\" FROM \"CalibrationRun\" cr JOIN \"JudgeModelVersion\" jmv ON jmv.id = cr.\"judgeModelVersionId\" JOIN \"JudgeModel\" jm ON jm.id = jmv.\"judgeModelId\" ORDER BY cr.\"startedAt\";"
```
Expected: the last row is `cmtircx0x00012b5zasyrbgpl|granite4.2:3b (Ollama, local)|2026-09-01 14:24:01.33|25`. If the id differs, substitute it in Steps 2–3.

- [ ] **Step 2: Deflate ratio of the 5 failed + 5 completed rows (the ten numbers)**

Run (one command; psql emits a JSON array, node computes the ratios):
```bash
kubectl -n tenant-public exec judge-arena-pg-1 -c postgres -- psql -U postgres -d judge_arena -At -c "SELECT json_agg(row_to_json(t)) FROM (SELECT mj.id, mj.status, mj.\"finishReason\" AS fr, mj.\"reasoningSource\" AS src, mj.\"outputTokens\" AS out, length(mj.\"reasoningContent\") AS chars, length(mj.\"rawResponse\") AS content_chars, mj.\"reasoningContent\" AS r FROM \"ModelJudgment\" mj JOIN \"EvaluationRun\" er ON er.id = mj.\"runId\" WHERE er.\"calibrationRunId\" = 'cmtircx0x00012b5zasyrbgpl' AND (mj.status = 'error' OR mj.id IN (SELECT mj2.id FROM \"ModelJudgment\" mj2 JOIN \"EvaluationRun\" er2 ON er2.id = mj2.\"runId\" WHERE er2.\"calibrationRunId\" = 'cmtircx0x00012b5zasyrbgpl' AND mj2.status = 'completed' ORDER BY mj2.\"createdAt\" LIMIT 5)) ORDER BY mj.status, mj.id) t;" 2>/dev/null | node -e '
const { deflateSync } = require("zlib");
let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
  for (const r of JSON.parse(s.trim())) {
    const b = Buffer.from(r.r ?? "", "utf8");
    const c = deflateSync(b).length;
    console.log([r.status, r.fr, r.src, r.out, r.chars, r.content_chars, b.length, c, (b.length / c).toFixed(2) + "x"].join("\t"));
  }
});'
```
Expected: 10 lines; `src` is `reasoning` on all ten; the five `error` lines read 5.23x / 29.27x / 6.26x / 10.79x / 7.07x (order by id), the five `completed` lines 3.00–4.09x. Every `error` ratio must be ≥ 5 and every `completed` ratio < 5, or STOP and take the numbers to the owner before Task 2 (decision 1 in the header).

- [ ] **Step 3: Population maxima and the verbatim-shingle check**

Run:
```bash
kubectl -n tenant-public exec judge-arena-pg-1 -c postgres -- psql -U postgres -d judge_arena -At -c "SELECT json_agg(row_to_json(t)) FROM (SELECT mj.id, mj.status, jm.name AS judge, length(mj.\"reasoningContent\") AS chars, mj.\"reasoningContent\" AS r FROM \"ModelJudgment\" mj JOIN \"EvaluationRun\" er ON er.id = mj.\"runId\" JOIN \"CalibrationRun\" cr ON cr.id = er.\"calibrationRunId\" JOIN \"JudgeModelVersion\" jmv ON jmv.id = cr.\"judgeModelVersionId\" JOIN \"JudgeModel\" jm ON jm.id = jmv.\"judgeModelId\" WHERE length(mj.\"reasoningContent\") >= 8000) t;" 2>/dev/null | node -e '
const { deflateSync } = require("zlib");
const ratio = (t) => { const b = Buffer.from(t, "utf8"); return b.length / deflateSync(b).length; };
const shingles = (t) => { const c = new Map(); for (let i = 0; i + 80 <= t.length; i += 40) { const k = t.slice(i, i + 80); c.set(k, (c.get(k) || 0) + 1); } return Math.max(...c.values()); };
let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
  const by = {};
  for (const r of JSON.parse(s.trim())) (by[r.status + "/" + r.judge.split(" ")[0]] ||= []).push({ id: r.id, chars: r.chars, ratio: ratio(r.r), rep: shingles(r.r) });
  for (const [k, v] of Object.entries(by)) {
    v.sort((a, b) => b.ratio - a.ratio);
    console.log(k, "n=" + v.length, "max", v[0].ratio.toFixed(2) + "x@" + v[0].chars, "min", v[v.length - 1].ratio.toFixed(2) + "x");
    for (const x of v.filter((x) => x.ratio >= 5)) console.log("   ", x.id, x.chars, x.ratio.toFixed(2) + "x", "max-shingle-repeat", x.rep);
  }
});'
```
Expected: `completed/granite4.2:3b n=18 max 5.38x@32899` with `max-shingle-repeat 1` on that row; `completed/Qwen3.6-35B-A3B n=74 max 3.83x`; `error/granite4.2:3b n=20 max 29.27x@40391`; the run-9 rows at 29.27/10.79/7.07/6.26× show `max-shingle-repeat` ≥ 3 and the 5.23× row shows 1.

**Then run the SAME scan over the CONTENT channel**, because the content channel is the one gate in this plan that can invert the advice for a real caller and — until this step — its safety rested entirely on a synthetic fixture (`judgmentJson`). Two minutes; it converts the docblock's "A PRECAUTION WITH NO MEASURED PRODUCTION INSTANCE BEHIND IT" from an assumption into the same class of evidence the reasoning channel already has:
```bash
kubectl -n tenant-public exec judge-arena-pg-1 -c postgres -- psql -U postgres -d judge_arena -At -c "SELECT json_agg(row_to_json(t)) FROM (SELECT mj.id, mj.status, jm.name AS judge, length(mj.\"rawResponse\") AS chars, mj.\"rawResponse\" AS r FROM \"ModelJudgment\" mj JOIN \"EvaluationRun\" er ON er.id = mj.\"runId\" JOIN \"CalibrationRun\" cr ON cr.id = er.\"calibrationRunId\" JOIN \"JudgeModelVersion\" jmv ON jmv.id = cr.\"judgeModelVersionId\" JOIN \"JudgeModel\" jm ON jm.id = jmv.\"judgeModelId\" WHERE length(mj.\"rawResponse\") >= 8000) t;" 2>/dev/null | node -e '
const { deflateSync } = require("zlib");
let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
  const rows = JSON.parse(s.trim() || "null");
  if (!rows) { console.log("no ModelJudgment has >= 8000 rawResponse chars"); return; }
  for (const r of rows) { const b = Buffer.from(r.r, "utf8"); console.log(r.status, r.judge.split(" ")[0], r.chars, (b.length / deflateSync(b).length).toFixed(2) + "x"); }
});'
```
and the rubric size that drives that ratio:
```bash
kubectl -n tenant-public exec judge-arena-pg-1 -c postgres -- psql -U postgres -d judge_arena -At -c "SELECT r.id, r.name, count(c.id) AS criteria FROM \"Rubric\" r LEFT JOIN \"RubricCriterion\" c ON c.\"rubricId\" = r.id GROUP BY r.id, r.name ORDER BY criteria DESC;"
```
Expected: the rubric scan shows the seed catalog's **5** criteria as the maximum. **If any shipping rubric has 60 or more criteria, do not ship the content channel** — that is the docblock's own prescribed remedy (drop the channel; never raise the threshold), and it is a STOP for the owner, not an executor judgement call. Record whatever the content scan prints (including "no row clears 8,000 chars", which is the expected outcome and is itself the finding: the channel is a precaution) and paste it into Task 3 Step 12's commit body next to the reasoning figures. (Column note: `rawResponse` is the DB's spelling of the content channel — see `registry.ts`'s capture-field block.)

- [ ] **Step 4: Record**

Write the ten-row table, the three maxima, the shingle verdicts and the two content-channel scans into your notes exactly as printed. They are pasted into Task 3 Step 12's commit body.

Also record the starting unit-test count, because the two dependency plans add test files and this plan's later expectations are stated relative to it:
```bash
cd /root/judge-arena && npx vitest run 2>&1 | grep -E '^ +(Test Files|Tests) '
```
Note the two numbers as **F** (test files) and **N** (tests). Measured on `33b7be4` they are **F = 57, N = 888** (57 = `tests/lib` 54 + `tests/admin` 2 + `tests/importer/cli.test.ts` 1; `src/**` carries no test file). Wave 1 took these from 55/872 to 55/877 and integration from 10/80 to 11/82; wave 2 added `tests/lib/sampling.test.ts` and `tests/lib/calibration-sampling-drift.test.ts` (+2 files, +11 tests). Any Gates figure quoting 869, 872, 877 or 879 unit, 670 db, or 80 integration is stale. If `capture-field-gaps` lands first these grow again, and that is expected — **use the printed numbers, never the illustrations below.**

Record the coverage rows for this module at the same time — every later coverage expectation in this plan is stated as "not below what the SAME command printed on the commit this work starts from", never as a fixed number:
```bash
cd /root/judge-arena && npm run test:coverage 2>&1 | grep -E '^ *(src/lib/llm|registry\.ts|degeneration\.ts|errors\.ts) '
```
Note the `src/lib/llm` directory row **and the per-file `registry.ts` and `errors.ts` rows** (statements / branches / functions / lines) as **C**. `degeneration.ts` does not exist yet, so it prints nothing here — that is expected.

**Record the per-file rows, not only the aggregate, and compare the per-file rows later.** The `src/lib/llm` aggregate CANNOT detect a coverage drop in `registry.ts` caused by this change, because the change also adds `degeneration.ts` at 100/100/100/100 to the same denominator: the new file's contribution masks an uncovered new branch in `registry.ts` and the aggregate still rises. An earlier revision of this plan said "the glob can only move up" and treated that as reassurance; it is the opposite — it is the reason the aggregate is not a discriminating comparator (failure mode A). The expectation to state in review is **"`registry.ts`'s OWN row did not fall, and `degeneration.ts` reads 100/100/100/100"**, with the aggregate as a secondary sanity check only.

The pre-wave-1 figure (95.79 / 89.44 / 98.05 / 95.79 on `fc9e936`) is NOT a valid comparator: `7e769c1` changed `src/lib/llm/index.ts` (+44 lines) and `src/lib/llm/resilience.ts` and added tests, and `a96cf94` moved a whole block out of `registry.ts` into the new `sampling.ts`, so the actuals have moved twice. Note also that the `src/lib/llm/**` GLOB is a different denominator from the `src/lib/llm` table row — the glob includes `backends/**`, and `vitest.config.ts:202-203` records its actual as 94.62/86.72/97.64/94.62 against floors 91/83/94/91 (`:202` is the `// Actual:` comment, `:203` the floor entry itself — re-verified on `33b7be4`).

**SKIP the pre-change db run — this is now the default, and the arithmetic is why.** An earlier revision made it optional-but-encouraged. Quantified: `vitest.db.config.ts:149-153` gates aggregates at lines 47 / functions 60 / branches 77 / statements 47, and the config's own ten-run note at `:113-121` records the all-files actuals as **49.17 statements / 79.28-79.47 branches / 62.58 functions / 49.17 lines** — margins of 2.28pp (branches) and 2.58pp (functions), the two tightest. (A review draft of this plan quoted those actuals as 49.55 / 63.19 / 79.59 / 49.55; that is not what the config says — the numbers above are what `sed -n '113,121p' vitest.db.config.ts` prints. Re-read it rather than trusting either quote.) `degeneration.ts` adds roughly 14 uncovered lines, 6 uncovered branches and 2 uncovered functions to denominators in the thousands: worst case a few tenths of a point on branches, an order of magnitude inside the margin. A second 15-minute run that also `prisma migrate reset --force`s `.env.test` cannot discriminate anything the config already records. So: **do not run it here.** Take the floors and the config's recorded actuals as **D**, and compare Task 3 Step 11's single db run against them. Record in review that D is the config's recorded actual rather than a same-day measurement, and that the reason is the arithmetic above. (Context for that later run: `vitest.db.config.ts:35` sets `coverage.include: ['src/lib/**/*.ts', …]`, and `degeneration.ts` WILL be loaded there — `registry.ts` imports it as a value and `tests/db/model-endpoint-crud.test.ts:7` reaches `registry.ts` through the verify route — while none of its functions execute, so it lands in the db denominator as dead weight.) If any db aggregate dips below its floor, the fix is a test-side one — **never** a floor edit.

No file in the repo changes in this task: `git -C /root/judge-arena status --short --untracked-files=no` must print nothing. (Plain `git status --short` shows several untracked `?? docs/superpowers/plans/2026-09-01-*.md` sibling plans, this one included — they are expected, they are not this plan's concern, and you never `git clean`.)

---

### Task 2: The pure detector, its fixtures, and its import-free test suite

**Files:**
- Create: `src/lib/llm/degeneration.ts`
- Create: `tests/lib/reasoning-fixtures.ts`
- Test: `tests/lib/degeneration.test.ts`

**Interfaces:**
- Consumes: `ProviderCallResult` (type only) from `src/lib/llm/provider.ts:143-209` — fields `text: string`, `reasoningText?: string`
- Produces (Task 3 relies on these exact names):
  ```ts
  export const REPETITION_MIN_CHARS = 8_000;
  export const REPETITION_RATIO_THRESHOLD = 5;
  export interface RepetitionMeasure { chars: number; bytes: number; compressedBytes: number; ratio: number; channel: 'reasoning' | 'content' }
  export function isLoopRatio(ratio: number): boolean
  export function measureRepetition(text: string, channel: RepetitionMeasure['channel']): RepetitionMeasure
  export function detectRepetitionLoop(result: Pick<ProviderCallResult, 'text' | 'reasoningText'>, mode?: 'judgment' | 'respond'): RepetitionMeasure | undefined
  ```
  and from the fixtures: `LOOP_CLAUSE: string`, `legitLong(chars: number, seed?: number): string`, `loopPure(chars?: number): string`, `loopAfterPrefix(prefixChars?: number, total?: number): string`, `loopNumbered(total?: number): string`, `judgmentJson(criteria?: number, reasoningChars?: number, seed?: number): string`

- [ ] **Step 1: Write the fixture module**

The `LOOP_CLAUSE` docblock below cites the spec **symbolically — `§5.4.2`, the fenced excerpt beginning "the person who likes chess" — with NO line range**, because that string is COMMITTED into the tree and a range there is permanent. This is the same rule Task 4 Step 2 applies to `README.md:598`, and this plan used to break it in this one place: the citation was `:440-442`, then `:450-452`, and is `:471-473` today — stale twice before a line of code was written. Do not re-introduce a number here.

Confirm the section is still where the docblock says it is (freshness check on the HEADING and the quoted text, not on a number):
```bash
grep -n '^### 5.4.2 \|the person who likes chess' /root/judge-arena/docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md
```
Expected: two hits — the `### 5.4.2 IT WAS NOT TRUNCATION. IT WAS A REPETITION LOOP` heading, then the clause inside the fenced block below it. On `33b7be4` they print `459:` and `471:` (the fence runs `:470-474`, the three text lines `:471-473`); on `5e48187` they printed `438:`/`450:`. **Use the heading, not the numbers** — the numbers are recorded here only so a reader can tell whether the section moved again.

Create `/root/judge-arena/tests/lib/reasoning-fixtures.ts`:

```ts
/**
 * Deterministic reasoning-channel fixtures for the repetition-loop detector
 * (src/lib/llm/degeneration.ts).
 *
 * NOT a test file: vitest's include is the three-glob array
 * ['src/**\/*.test.ts', 'src/**\/*.test.tsx', 'tests/**\/*.test.ts']
 * (vitest.config.ts:8) and this file matches none of them, so it is never
 * collected; it is imported by
 * tests/lib/degeneration.test.ts and tests/lib/llm-truncation.test.ts.
 *
 * WHY GENERATORS AND NOT CHECKED-IN MODEL OUTPUT: the honest fixture would be
 * a real granite4.2 `reasoningContent` row, but that is ~50 KB of model output
 * quoting JudgeBench candidate text. These are synthetic, seeded and
 * length-pinned instead, and the numbers below were measured with node zlib
 * (default level) on 2026-09-01 so a future reader can tell whether the
 * detector or the fixture moved:
 *
 *   loopPure(44_000)        140.1x   the spec §5.4.2 clause, verbatim, forever
 *   loopAfterPrefix()        14.4x   8k of prose, then the clause (the measured
 *                                    shape: a judgment reasons, then cycles)
 *   loopNumbered()           31.8x   a NON-verbatim loop (counter increments)
 *   legitLong(13_138)         3.08x  seeded prose at the completed-mean length
 *   legitLong(44_287)         3.35x  seeded prose at the failed-mean length
 *   legitLong(56_004)         3.39x  seeded prose at the longest failed length
 *   judgmentJson()            3.21x  20,814 chars — the CONTENT channel in the
 *                                    shape a pointwise judge is actually asked
 *                                    for (see below)
 *
 * THE CONTENT-CHANNEL NEGATIVE IS NOT PROSE. A judgment's `text` never carries
 * a word stream; it carries the JSON of src/lib/llm/judgment-schema.ts. TWO
 * seams set `mode: 'judgment'` — `executeJudgmentCall` (pointwise,
 * `JUDGMENT_JSON_SCHEMA`) and `executePairwiseCall`
 * (`PAIRWISE_JUDGMENT_JSON_SCHEMA` = `{verdict, reasoning}`) — so the channel
 * holds TWO shapes, not one. `judgmentJson` models the pointwise one, which is
 * the harder case; the pairwise one is measured inline in
 * tests/lib/degeneration.test.ts (20,158 chars at 3.17x) because it is nearly
 * pure prose with less boilerplate, hence a LOWER ratio. The pointwise shape is
 * `overallScore` / `reasoning` / `criteriaScores[]`, where the array entries
 * carry criterionId/criterionName/score/maxScore and NO prose, so all the
 * entropy sits in the single top-level `reasoning` string and the array is
 * pure boilerplate. That shape's ratio is therefore driven by the RUBRIC SIZE,
 * and it was measured across the range before the content channel was kept
 * (node zlib, default level, 2026-09-02):
 *
 *   judgmentJson(5,   8_500)   9,241 chars   3.02x   the seed catalog's rubric
 *   judgmentJson(5,  20_000)  20,814 chars   3.21x   (prisma/seed-core.ts:300
 *   judgmentJson(5,  56_000)  57,042 chars   3.42x    — "1 Rubric with 5
 *   judgmentJson(10, 20_000)  21,425 chars   3.28x    criteria")
 *   judgmentJson(20,  8_000)  10,604 chars   3.45x
 *   judgmentJson(40,  4_000)   9,067 chars   4.41x   still under the threshold
 *   judgmentJson(60,  2_000)   9,558 chars   6.10x   FLAGGED — the boundary
 *   judgmentJson(100, 1_000)  13,547 chars   8.15x   FLAGGED
 *   judgmentJson(200, 0)      25,103 chars  10.46x   FLAGGED
 *
 * So the content channel is safe at every rubric size that ships today, and
 * the false positive it can produce needs a rubric of roughly 60+ criteria
 * scored with a terse rationale. degeneration.ts's docblock records that as
 * the accepted trade and names the remedy (drop the channel, do not raise the
 * threshold).
 *
 * Production for comparison (deflate on real rows, same day): completed
 * granite4.2 3.00-4.09x on run 9's sample (5.38x population max at 33k
 * chars); run 9's five loops 5.23-29.27x. The tests assert DETECTED / NOT
 * DETECTED, never a ratio band — the ratio is a property of the literal text
 * and rises with length even for prose.
 *
 * `legitLong` MUST NOT be a tiled paragraph: tiling compresses like a loop and
 * would make the negative case meaningless. It is a seeded word stream with a
 * pseudo-random number every ninth token, which is what keeps it under 3.5x
 * at 56k chars.
 */

/** The clause granite4.2 cycled verbatim on run 9. Source: the scoreboard
 * spec, §5.4.2 ("IT WAS NOT TRUNCATION. IT WAS A REPETITION LOOP"), the fenced
 * excerpt beginning "the person who likes chess". Section heading, no line
 * range — the range has already gone stale twice. */
export const LOOP_CLAUSE =
  '"the person who likes chess" refers to the person whose hobby is chess; ' +
  '"the person who likes rock-climbing" refers to the person whose hobby is rock-climbing; ' +
  '"the person who likes collecting" refers to the person whose hobby is collecting; ' +
  '"the person who likes traveling" refers to the person whose hobby is traveling; ';

const VOCAB = (
  'the response candidate rubric criterion answer because however evidence claims verifies step ' +
  'assume contradiction constraint earlier later therefore weigh accuracy clarity omits includes ' +
  'correct incorrect partial hobby chess travel collecting climbing person house clue position ' +
  'ordering fifth second third first fourth conclude recheck note also but so if then which that ' +
  'this each only both neither either one two three four five given implies unless whereas ' +
  'otherwise consistent inconsistent violates satisfies premise deduce eliminate remaining option ' +
  'list swap adjacent between leftmost rightmost middle count total remainder alternative ' +
  'hypothesis reject accept confirm mention explicit implicit detail summary format length tone ' +
  'helpful harmful concise verbose accurate vague specific general cites source quotes number ' +
  'date name place'
).split(' ');

/** xorshift32 — tiny, dependency-free, and identical on every platform. */
function xorshift32(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
}

/** Genuinely non-repeating prose-shaped text of exactly `chars` characters. */
export function legitLong(chars: number, seed = 42): string {
  const next = xorshift32(seed);
  let out = '';
  let i = 0;
  while (out.length < chars) {
    const w = VOCAB[next() % VOCAB.length];
    out += i % 9 === 8 ? `${w} (${(next() % 9000) + 1000}) ` : i % 17 === 16 ? `${w}.\n` : `${w} `;
    i += 1;
  }
  return out.slice(0, chars);
}

/** The clause repeated to exactly `chars` characters. */
export function loopPure(chars = 44_000): string {
  return LOOP_CLAUSE.repeat(Math.ceil(chars / LOOP_CLAUSE.length)).slice(0, chars);
}

/** Prose for `prefixChars`, then the clause, cut to exactly `total`. 44,287 is
 * run 9's mean failed length (spec §5.4.2 table). */
export function loopAfterPrefix(prefixChars = 8_000, total = 44_287): string {
  return (legitLong(prefixChars) + loopPure(total)).slice(0, total);
}

/** A loop that is NOT verbatim — the step counter changes every cycle. */
export function loopNumbered(total = 44_000): string {
  let out = '';
  for (let n = 1; out.length < total; n += 1) {
    out += `Step ${n}: Let me re-check whether response A addresses the constraint better than response B. `;
  }
  return out.slice(0, total);
}

/**
 * A pointwise judgment's CONTENT channel, in the shape the judge is actually
 * asked for (`JUDGMENT_JSON_SCHEMA` in src/lib/llm/judgment-schema.ts — symbol,
 * not a line range, because this comment is committed and ranges go stale).
 * The per-criterion entries
 * carry no prose — criterionId/criterionName/score/maxScore only — so the
 * array is boilerplate and the entropy is the one `reasoning` string; that is
 * why the ratio climbs with the CRITERIA count, not with the length. Defaults
 * are the seed catalog's rubric size (5) and a long-but-plausible rationale:
 * 20,814 chars at 3.21x, i.e. over the detector's floor and under its
 * threshold, which is exactly the case the content channel's negative test
 * needs. See this file's header for the measured range.
 */
export function judgmentJson(criteria = 5, reasoningChars = 20_000, seed = 7): string {
  const next = xorshift32(seed);
  const criteriaScores = Array.from({ length: criteria }, (_, i) => ({
    criterionId: `crit-${i + 1}`,
    criterionName: `${VOCAB[next() % VOCAB.length]} ${VOCAB[next() % VOCAB.length]}`,
    score: next() % 11,
    maxScore: 10,
  }));
  return JSON.stringify({ overallScore: 7.5, reasoning: legitLong(reasoningChars, seed), criteriaScores }, null, 2);
}
```

- [ ] **Step 2: Write the failing pure test suite**

Create `/root/judge-arena/tests/lib/degeneration.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

/**
 * The repetition-loop detector, in isolation.
 *
 * THE FAILURE THIS EXISTS TO PREVENT (handoff 2026-09-01 §5.2): granite4.2:3b
 * failed 5 of 30 calibration items with finish_reason 'length' at
 * max_tokens 12288, and the guard's message told the operator to raise
 * max_tokens. All five were degenerate repetition — 26k-56k chars of one
 * clause cycling — and a larger budget buys a longer loop. Those five
 * consumed 41 of the run's 82 minutes for zero verdicts.
 *
 * Imports ONLY the pure module and the fixture generators, on purpose: this
 * file must never pull the consumer (or anything with a DB/queue/realtime
 * import) into the unit coverage denominator — see
 * tests/lib/judgment-consumer-escalation.test.ts:51-60 for what that does to
 * the src/lib/realtime/** floor. Execute()-level cases live in
 * tests/lib/llm-truncation.test.ts, which already carries that import.
 *
 * Every assertion is DETECTED / NOT DETECTED, never a ratio band: the ratio is
 * a property of the literal fixture text (the same "numbered loop" idea
 * measured 8.96x in one draft and 31.9x in another) and rises with length
 * even for prose. The fixture module's header records the measured ratios.
 */
import {
  REPETITION_MIN_CHARS,
  REPETITION_RATIO_THRESHOLD,
  detectRepetitionLoop,
  isLoopRatio,
  measureRepetition,
} from '@/lib/llm/degeneration';
import { LOOP_CLAUSE, judgmentJson, legitLong, loopAfterPrefix, loopNumbered, loopPure } from './reasoning-fixtures';

describe('the fixtures are what their names say', () => {
  it('generators are deterministic and length-exact', () => {
    expect(legitLong(20_000)).toBe(legitLong(20_000));
    expect(legitLong(20_000)).toHaveLength(20_000);
    expect(loopPure()).toHaveLength(44_000);
    expect(loopAfterPrefix()).toHaveLength(44_287);
    expect(loopNumbered()).toHaveLength(44_000);
    expect(loopPure()).toContain(LOOP_CLAUSE);
    // The content-channel negative must clear the detector's floor, or the
    // case below would pass for the wrong reason (too short to measure).
    expect(judgmentJson()).toBe(judgmentJson());
    expect(judgmentJson().length).toBeGreaterThan(8_000);
    expect(JSON.parse(judgmentJson()).criteriaScores).toHaveLength(5);
  });

  it('the constants are the documented ones, and the ratio comparison is INCLUSIVE (a change here is a policy change, not a refactor)', () => {
    expect(REPETITION_MIN_CHARS).toBe(8_000);
    expect(REPETITION_RATIO_THRESHOLD).toBe(5);
    // The `>=` vs `>` boundary was previously UNPINNED and this plan said so
    // in the module docblock: no fixture and no production row lands at
    // exactly 5.00, so a `>` implementation passed every other case in this
    // file. That mutant is not cosmetic — it drops run 9's 52,702-char
    // failure at 5.23x only when the ratio happens to land on 5.00, but more
    // importantly it silently converts the binding decision (threshold 5)
    // into the alternative that was explicitly rejected. `isLoopRatio` exists
    // so the operator can be pinned by two literals; Injection E breaks it.
    expect(isLoopRatio(5)).toBe(true);
    expect(isLoopRatio(4.999)).toBe(false);
  });
});

describe('measureRepetition', () => {
  it('measures BYTES, reports CHARS, and echoes the channel', () => {
    // 3-byte characters: 10,000 chars is 30,000 bytes. The ratio must be a
    // bytes/bytes figure or a CJK reasoner would read three times too
    // compressible.
    const m = measureRepetition('漢字の判定'.repeat(2_000), 'reasoning');
    expect(m.chars).toBe(10_000);
    expect(m.bytes).toBe(30_000);
    expect(m.compressedBytes).toBeGreaterThan(0);
    expect(m.ratio).toBe(m.bytes / m.compressedBytes);
    expect(m.channel).toBe('reasoning');
  });

  it('a content-channel measure says so', () => {
    expect(measureRepetition('abc', 'content').channel).toBe('content');
  });
});

describe('detectRepetitionLoop: the reasoning channel', () => {
  it('detects the spec §5.4.2 clause cycling verbatim', () => {
    const hit = detectRepetitionLoop({ text: '', reasoningText: loopPure() }, 'judgment');
    expect(hit).toBeDefined();
    expect(hit!.channel).toBe('reasoning');
    expect(hit!.chars).toBe(44_000);
  });

  it('detects the measured production shape: 8k of prose, then the loop', () => {
    expect(detectRepetitionLoop({ text: '', reasoningText: loopAfterPrefix() }, 'judgment')).toBeDefined();
  });

  it('detects a NON-verbatim loop (an incrementing counter inside the cycle)', () => {
    expect(detectRepetitionLoop({ text: '', reasoningText: loopNumbered() }, 'judgment')).toBeDefined();
  });

  it('does NOT flag genuinely long reasoning at the loop fixtures\' own lengths', () => {
    // Tested at 44k and 56k, not 13k: the deflate ratio of prose RISES with
    // length (more back-references), so a negative case at 13k chars proves
    // nothing about a 56k truncation.
    expect(detectRepetitionLoop({ text: '', reasoningText: legitLong(44_287) }, 'judgment')).toBeUndefined();
    expect(detectRepetitionLoop({ text: '', reasoningText: legitLong(56_004) }, 'judgment')).toBeUndefined();
  });

  it('does NOT flag a short truncation, however compressible — the length floor is the whole point', () => {
    // tests/lib/llm-truncation.test.ts pins 'x'.repeat(1164) as a GENUINE
    // truncation whose message must still name samplingDefaults.max_tokens.
    // That string deflates at 64x; without the floor it would read as a loop.
    expect(detectRepetitionLoop({ text: '', reasoningText: 'x'.repeat(1_164) }, 'judgment')).toBeUndefined();
    expect(detectRepetitionLoop({ text: '', reasoningText: legitLong(1_164) }, 'judgment')).toBeUndefined();
  });

  it('the floor is inclusive at exactly 8,000 chars', () => {
    // LITERALS, not `REPETITION_MIN_CHARS ± 1`. Interpolating the constant
    // makes the case self-referential: it would still pass at any floor, and
    // Injection B (floor -> 0) would turn the inputs into 'x'.repeat(0) and
    // 'x'.repeat(-1) — the second a RangeError — so the injection would go
    // red for a reason that is not the defect. Measured: 'x'.repeat(8_000)
    // deflates 285.71x, 'x'.repeat(7_999) 266.63x; both are far above the 5x
    // threshold, so ONLY the floor decides these two lines. The separate
    // constants test above is the policy pin.
    expect(detectRepetitionLoop({ text: '', reasoningText: 'x'.repeat(8_000) })).toBeDefined();
    expect(detectRepetitionLoop({ text: '', reasoningText: 'x'.repeat(7_999) })).toBeUndefined();
    // And the floor is CHARS, not BYTES. Every other probe here is ASCII, so
    // `Buffer.byteLength(reasoning) >= REPETITION_MIN_CHARS` would pass them
    // all. 7,500 CJK chars are 22,500 UTF-8 bytes and deflate at 258.6x: a
    // bytes-floor implementation measures them and flags them, a chars-floor
    // one does not. The consequence is real — a CJK judge looping inside
    // 3,000 chars would otherwise be flagged below the documented floor.
    expect(detectRepetitionLoop({ text: '', reasoningText: '漢字の判定'.repeat(1_500) })).toBeUndefined();
  });

  it('measures the reasoning channel regardless of mode', () => {
    expect(detectRepetitionLoop({ text: '', reasoningText: loopPure() }, 'respond')).toBeDefined();
    expect(detectRepetitionLoop({ text: '', reasoningText: loopPure() }, undefined)).toBeDefined();
  });
});

describe('detectRepetitionLoop: the content channel', () => {
  it('measures CONTENT only in judgment mode — a judgment\'s content is a small JSON object, so 8k+ of it at the budget is itself anomalous', () => {
    const hit = detectRepetitionLoop({ text: loopPure() }, 'judgment');
    expect(hit).toBeDefined();
    expect(hit!.channel).toBe('content');
    expect(hit!.chars).toBe(44_000);
  });

  it('never measures CONTENT in respond mode or with no mode: long structured answers (big JSON arrays, long markdown tables) deflate like loops legitimately, because they are mostly repeated delimiters and field names', () => {
    expect(detectRepetitionLoop({ text: loopPure() }, 'respond')).toBeUndefined();
    expect(detectRepetitionLoop({ text: loopPure() }, undefined)).toBeUndefined();
  });

  it('does NOT flag a REAL judgment payload in judgment mode, pointwise OR pairwise — clearing the floor is not the same as looping', () => {
    // The content channel has its own ratio comparison; this is the case
    // where it is measured (judgment mode, over the floor) and does NOT read
    // as a loop. Without it the false arm of that comparison is never
    // executed.
    //
    // The fixture is judgmentJson, not legitLong: a judgment's `text` never
    // carries a word stream, it carries a JSON object, and the pointwise
    // shape is half boilerplate (criteriaScores entries have no prose).
    // A prose negative would prove nothing about the shapes this channel
    // actually holds. Measured 3.21x at the seed catalog's 5-criterion rubric,
    // 3.02-3.45x from 9k to 57k chars and up to 20 criteria; the fixture
    // header records where it does cross 5x (~60 criteria with a terse
    // rationale, 6.10x) and degeneration.ts's docblock records the remedy.
    expect(detectRepetitionLoop({ text: judgmentJson() }, 'judgment')).toBeUndefined();
    expect(detectRepetitionLoop({ text: judgmentJson(20, 8_000) }, 'judgment')).toBeUndefined();
    // TWO seams set mode 'judgment', not one: executeJudgmentCall (pointwise,
    // JUDGMENT_JSON_SCHEMA) and executePairwiseCall (PAIRWISE_JUDGMENT_JSON_-
    // SCHEMA = `{verdict, reasoning}`, src/lib/llm/judgment-schema.ts:95-110).
    // The pairwise payload is near-pure prose with LESS boilerplate than the
    // pointwise one, so its ratio should sit below it — but "should" is what
    // this plan exists to stop doing, so it is measured and asserted:
    // 20,158 chars at 3.17x (node zlib, default level, 2026-09-02), i.e. over
    // the floor and under the threshold, which is the arm that must execute.
    expect(
      detectRepetitionLoop({ text: JSON.stringify({ verdict: 'A', reasoning: legitLong(20_000) }) }, 'judgment')
    ).toBeUndefined();
  });

  it('the CONTENT floor is inclusive at exactly 8,000 chars too — the second gate is not decoration', () => {
    // Without this case the whole content-channel length gate is unpinned:
    // `mode === 'judgment' && result.text.length > 0` passes every other test
    // in this file AND every case in tests/lib/llm-truncation.test.ts,
    // because no fixture anywhere lands in (0, 8_000) chars with a ratio
    // >= 5. Coverage does not catch it either — the gate's false arm is
    // executed by the reasoning-channel cases (where `text` is ''), so
    // degeneration.ts still reads 100/100/100/100 with the mutant in place.
    //
    // LITERALS, for the same reason as the reasoning floor above: measured
    // 285.71x for 'x'.repeat(8_000) and 266.63x for 'x'.repeat(7_999), so
    // only the floor decides these two lines.
    expect(detectRepetitionLoop({ text: 'x'.repeat(8_000) }, 'judgment')).toMatchObject({ channel: 'content' });
    expect(detectRepetitionLoop({ text: 'x'.repeat(7_999) }, 'judgment')).toBeUndefined();
  });

  it('measures each channel INDEPENDENTLY — a loop confined to the shorter channel is still found', () => {
    // 20k of legitimate reasoning plus 10k of looping content. A "pick the
    // longer channel" implementation measures the reasoning (~3x) and misses
    // the loop.
    const hit = detectRepetitionLoop({ text: loopPure(10_000), reasoningText: legitLong(20_000) }, 'judgment');
    expect(hit).toBeDefined();
    expect(hit!.channel).toBe('content');
  });

  it('never CONCATENATES the channels: a think_tag response carries the reasoning inside text too', () => {
    // openai-compatible.ts's extractReasoningChannel is additive — for
    // `<think>` responses, reasoningText is a substring of text. Summing the
    // two would double-count the loop and report a chars figure that matches
    // no channel an operator can look at.
    const thinking = loopPure();
    const hit = detectRepetitionLoop({ text: `<think>${thinking}</think>`, reasoningText: thinking }, 'judgment');
    expect(hit).toBeDefined();
    expect(hit!.channel).toBe('reasoning');
    expect(hit!.chars).toBe(thinking.length);
  });

  it('returns undefined, and does not throw, on an empty result', () => {
    expect(detectRepetitionLoop({ text: '' }, 'judgment')).toBeUndefined();
    expect(detectRepetitionLoop({ text: '', reasoningText: undefined }, 'judgment')).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the suite to verify it fails for the right reason**

Run: `cd /root/judge-arena && npx vitest run tests/lib/degeneration.test.ts`
Expected: FAIL at collection — `Error: Failed to load url /root/judge-arena/src/lib/llm/degeneration (resolved id: /root/judge-arena/src/lib/llm/degeneration) in /root/judge-arena/tests/lib/degeneration.test.ts. Does the file exist?` — vite 7.3.1's resolver, which vitest 3.2.4 bundles, reports an unresolvable ALIASED path in this shape, **not** node's `Cannot find module` (the template `` `Failed to load url ${url} (resolved id: ${id})${importer ? ` in ${importer}` : ''}. ${msg}` `` lives in `node_modules/vite/dist/node/chunks/config.js`; `grep -rlo "Cannot find module" node_modules/vitest/dist/*.js node_modules/vite-node/dist/*.js` returns nothing). The `@` → `./src` alias rewrites the specifier before node ever sees it. Treat the exact wording as indicative and confirm it when the step runs; what must be true is that the FIXTURES module resolves and the detector does not exist yet. `Tests  no tests` — 0 tests run.

**Read the scope of this red honestly: it is a COLLECTION failure, not a behaviour failure.** Zero tests executed, so it is evidence for exactly one thing — the fixture module resolves and `@/lib/llm/degeneration` does not exist — and evidence for no assertion in the file. Steps 6-10 are the discriminators; do not cite this step as TDD red for any behaviour (CONTRIBUTING.md:226-234: "a failure message that does not describe the defect is not evidence").

- [ ] **Step 4: Write the detector**

Create `/root/judge-arena/src/lib/llm/degeneration.ts`:

```ts
/**
 * ─── Degenerate-repetition detector ───────────────────────────────────────
 *
 * Distinguishes "the model needed more room" from "the model is never going
 * to stop" when a call ends at the token budget. `finish_reason: 'length'`
 * is genuinely ambiguous between the two, and the guard in `registry.ts`'s
 * `assertUsableContent` used to assume the first — its advice ("raise
 * samplingDefaults.max_tokens") is correct for a truncation and actively
 * harmful for a loop, where a larger budget buys a longer loop at more
 * wall-clock. Handoff 2026-09-01 §5.2: granite4.2:3b looped on 5 of 30 items
 * at 12288 tokens and those five consumed half the run's compute for zero
 * verdicts.
 *
 * THE SIGNAL: repetitive text compresses far better than prose. Measured
 * with node zlib (default level) on production `reasoningContent`, 2026-09-01:
 * granite4.2 judgments that finished deflate at 3.0-4.1x (population max
 * 5.38x at 33k chars, verbose but not cycling); the five run-9 loops deflate
 * at 5.23x, 6.26x, 7.07x, 10.79x and 29.27x. Qwen3.6 prose: 2.6-3.8x.
 *
 * TWO GATES, both deliberate:
 * - A LENGTH FLOOR (`REPETITION_MIN_CHARS`). Short strings compress
 *   pathologically ('x'.repeat(1164) reads 64x) and a loop under ~2k tokens
 *   is indistinguishable from a short truncation; there the max_tokens
 *   advice is harmless — one raise surfaces a longer loop that this module
 *   will then name.
 * - PER-CHANNEL measurement, NEVER concatenated. For a `think_tag` model the
 *   reasoning text is a substring of `text` (openai-compatible.ts:252 keeps
 *   `choice.message.content` WHOLE — the `<think>` block is not stripped from
 *   it — and :253 additionally extracts the reasoning from it), so a
 *   concatenated measure would double-count. Each channel that clears the
 *   floor is measured on its own; either exceeding the threshold is a loop.
 *   One consequence, stated so nobody rediscovers it as a bug: for a
 *   `think_tag` JUDGMENT whose reasoning is under the floor but whose `text`
 *   (think block included) is over it, the content channel re-measures the
 *   same reasoning bytes and the message reports them as "N content chars".
 *   That is not a double-count and not a false positive — the loop is real —
 *   but the channel LABEL points at `rawResponse` where the operator will
 *   find the reasoning too.
 *
 * THE CONTENT CHANNEL IS ONLY MEASURED IN JUDGMENT MODE. A judgment's
 * content is a small JSON object, so 8k+ chars of it at the budget is
 * anomalous in itself. A respond-mode answer can legitimately be a long
 * structured list, and structure alone compresses well above the 5x
 * threshold — a large JSON array or a long markdown table is mostly repeated
 * delimiters and field names. (No specific ratio is quoted here on purpose:
 * an earlier revision pinned "a 400-object JSON array 13.9x, a 300-row
 * markdown table 8.3x" in this docblock and in the commit body, with no
 * generator, seed or shape recorded anywhere, so nobody could re-derive it.
 * Every other number in this module reproduces from
 * tests/lib/reasoning-fixtures.ts; those two did not, and an unreproducible
 * number in a docblock that exists to correct unmeasured claims is the
 * failure this whole change is about.) Telling that caller "raising
 * max_tokens buys a longer loop" would be the same wrong advice in the other
 * direction.
 *
 * THE CONTENT CHANNEL IS A PRECAUTION WITH NO MEASURED PRODUCTION INSTANCE
 * BEHIND IT. All five production loops were in the REASONING channel. Task 1
 * of the plan scans `rawResponse` as well as `reasoningContent` (and the
 * shipping rubric sizes), so if a production content-channel instance exists
 * it is on the record; the expected outcome is that none clears 8,000 chars.
 * The judgment-mode gate is what makes it safe for respond mode; what makes
 * it safe for judgments was measured before shipping. TWO seams set that
 * mode — `executeJudgmentCall` (pointwise, `JUDGMENT_JSON_SCHEMA`) and
 * `executePairwiseCall` (`PAIRWISE_JUDGMENT_JSON_SCHEMA` = `{verdict,
 * reasoning}`) — so the channel holds two shapes. The measurement below is
 * the POINTWISE one (one top-level `reasoning` string plus a prose-free
 * `criteriaScores` array, so the ratio tracks the RUBRIC SIZE and not the
 * length), which is the harder of the two; the pairwise payload is nearly
 * pure prose with less boilerplate and measures 3.17x at 20,158 chars, below
 * the pointwise figure, and is pinned as its own assertion in
 * tests/lib/degeneration.test.ts. Over the seed
 * catalog's 5-criterion rubric it reads 3.02x at 9,241 chars and 3.42x at
 * 57,042; 20 criteria with an 8k rationale reads 3.45x; 40 criteria reads
 * 4.41x. It first crosses 5x at roughly 60 criteria scored with a terse
 * (2k-char) rationale — 9,558 chars, 6.10x — and reaches 10.5x at 200. So
 * the false positive is not demonstrated at any rubric that ships today, but
 * a very large rubric with a terse rationale WOULD be told the opposite of
 * what it needs. If that appears, DROP THE CONTENT CHANNEL rather than
 * raising the threshold: raising it would also stop catching the 5.23x
 * reasoning row this module exists for.
 * (tests/lib/reasoning-fixtures.ts's `judgmentJson` is that measurement, kept
 * runnable; tests/lib/degeneration.test.ts pins the 5-criterion and
 * 20-criterion cases as negatives.)
 *
 * Pure and synchronous. `deflateSync` costs ~0.07 ms on a 44k loop and
 * ~1 ms on 56k of incompressible prose — the real worst case (measured on
 * node 22.23.1, 50 iterations) — and runs only on the failure path (after
 * the guard has decided to throw).
 * Bare `'zlib'` import: src/lib's convention for node builtins
 * (registry.ts imports `'crypto'` the same way).
 */

import { deflateSync } from 'zlib';
import type { ProviderCallResult } from './provider';

/** Below this many characters a loop cannot be told from a short truncation,
 * and the max_tokens advice is harmless. Keeps the 1,164/762-char fixtures in
 * tests/lib/llm-truncation.test.ts (64x/51x) on the truncation message. */
export const REPETITION_MIN_CHARS = 8_000;

/** bytes / deflated bytes. Prose measures 2.6-4.1x on the two self-hosted
 * judges; run 9's loops measured 5.23x and up. The comparison is INCLUSIVE
 * (`>=`) and it is load-bearing for exactly one row: run 9's 52,702-char
 * failure at 5.23x, which clears the bar by 0.23 and is the row that decides
 * threshold 5 over the rejected alternative 6. */
export const REPETITION_RATIO_THRESHOLD = 5;

/**
 * The ratio gate, extracted so the `>=` boundary can be PINNED by two
 * literals rather than left to review.
 *
 * No fixture and no production row lands at exactly 5.00, so an
 * implementation using `>` passes every detect/undetect case in
 * tests/lib/degeneration.test.ts and every execute()-level case in
 * tests/lib/llm-truncation.test.ts — an earlier revision of this module
 * documented that gap and accepted it ("a REVIEW-ENFORCED property, not a
 * pinned one"). That is failure mode 5 (an assertion with no injection behind
 * it): the surviving mutant silently converts the binding decision into the
 * alternative it rejected, with the suite green. `expect(isLoopRatio(5))` and
 * `expect(isLoopRatio(4.999))` are the pin; Injection E is the red.
 *
 * Both ratio gates below call this — never inline the comparison, or the pin
 * stops guarding the gate it was written for.
 */
export function isLoopRatio(ratio: number): boolean {
  return ratio >= REPETITION_RATIO_THRESHOLD;
}

export interface RepetitionMeasure {
  /** UTF-16 code units, i.e. what `.length` and `ModelJudgment` column
   * lengths report. */
  chars: number;
  /** UTF-8 bytes actually compressed. */
  bytes: number;
  compressedBytes: number;
  /** `bytes / compressedBytes`. */
  ratio: number;
  channel: 'reasoning' | 'content';
}

export function measureRepetition(text: string, channel: RepetitionMeasure['channel']): RepetitionMeasure {
  const buf = Buffer.from(text, 'utf8');
  // deflateSync never returns an empty buffer (2-byte header + 4-byte
  // adler32 at minimum), so the division is safe without a guard.
  const compressedBytes = deflateSync(buf).length;
  return { chars: text.length, bytes: buf.byteLength, compressedBytes, ratio: buf.byteLength / compressedBytes, channel };
}

/**
 * Returns the measure of the first channel that reads as a loop — reasoning
 * first (the channel the loops were found in), then content — or `undefined`
 * when neither does.
 */
export function detectRepetitionLoop(
  result: Pick<ProviderCallResult, 'text' | 'reasoningText'>,
  mode?: 'judgment' | 'respond'
): RepetitionMeasure | undefined {
  const reasoning = result.reasoningText ?? '';
  if (reasoning.length >= REPETITION_MIN_CHARS) {
    const measure = measureRepetition(reasoning, 'reasoning');
    if (isLoopRatio(measure.ratio)) return measure;
  }

  if (mode === 'judgment' && result.text.length >= REPETITION_MIN_CHARS) {
    const measure = measureRepetition(result.text, 'content');
    if (isLoopRatio(measure.ratio)) return measure;
  }

  return undefined;
}
```

- [ ] **Step 5: Run the suite to verify it passes**

Run: `cd /root/judge-arena && npx vitest run tests/lib/degeneration.test.ts`
Expected: PASS, 18 tests. (The `isLoopRatio` boundary and the pairwise-payload negative are extra ASSERTIONS inside two existing cases, deliberately — they add discriminating power without moving any of this plan's test-count arithmetic.)

- [ ] **Step 6: Injection A — the threshold**

Break: in `src/lib/llm/degeneration.ts` change `export const REPETITION_RATIO_THRESHOLD = 5;` to `export const REPETITION_RATIO_THRESHOLD = 1_000;` (NOT 100: the pure clause deflates at 140× and would stay green).
Run: `cd /root/judge-arena && npx vitest run tests/lib/degeneration.test.ts`
Expected: FAIL — **10 red, 8 green.** Red: the constants test (both on `REPETITION_RATIO_THRESHOLD` and on `isLoopRatio(5)`, which now reads `5 >= 1_000` → false), the three "detects …" cases, "the floor is inclusive at exactly 8,000 chars" (`'x'.repeat(8_000)` reads 285.7×, under 1_000 — its first assertion fails), "the CONTENT floor is inclusive at exactly 8,000 chars too" (same, 285.7× < 1_000 — `expected undefined to match object { channel: 'content' }`), "measures the reasoning channel regardless of mode" (loopPure at 140×), "measures CONTENT only in judgment mode", "INDEPENDENTLY" and "never CONCATENATES" — all but the constants test and the content-floor test with `expected undefined to be defined` (that is vitest 3.2.4's wording for a failed `toBeDefined()`: `@vitest/expect/dist/index.js:1246` is `"expected #{this} to be defined"`). Green: the fixture-determinism test, both `measureRepetition` cases, the two "does NOT flag" reasoning cases, the pointwise-payload case, "never measures CONTENT in respond mode" and the empty-result case.
Restore `= 5;`.

- [ ] **Step 7: Injection B — the floor**

Break: change `export const REPETITION_MIN_CHARS = 8_000;` to `= 0;`.
Run: the same command.
Expected: FAIL — exactly **four** red, on the three assertions the floor owns plus the policy pin: "does NOT flag a short truncation, however compressible" (`'x'.repeat(1_164)` at 64.7× is now detected: `expected { chars: 1164, … } to be undefined`), "the floor is inclusive at exactly 8,000 chars" (its SECOND assertion — `'x'.repeat(7_999)` at 266.63× is now detected — while the first stays green; the CJK assertion goes with it, 7,500 chars at 258.6×), "the CONTENT floor is inclusive at exactly 8,000 chars too" (its second assertion, same 266.63× string on the content channel), and "the constants are the documented ones, and the ratio comparison is INCLUSIVE" (on its FIRST assertion, `REPETITION_MIN_CHARS`; the two `isLoopRatio` assertions in that same case are untouched by a floor change and would still pass). Nothing else — in particular the empty-result case stays green, because `deflateSync('')` still returns 8 bytes for 0 input bytes and a ratio of 0 never clears 5. Because the case uses literals, 7,999 is really probed; with `REPETITION_MIN_CHARS - 1` it would have been `'x'.repeat(-1)`, a `RangeError`, and the injection's evidence would have described a defect that cannot occur (CONTRIBUTING.md:228-234).
Restore `= 8_000;`.

- [ ] **Step 8: Injection C — pick-the-longer-channel instead of per-channel**

Break: replace the body of `detectRepetitionLoop` with
```ts
  const reasoning = result.reasoningText ?? '';
  const [text, channel] = reasoning.length >= result.text.length ? [reasoning, 'reasoning' as const] : [result.text, 'content' as const];
  if (text.length < REPETITION_MIN_CHARS) return undefined;
  const measure = measureRepetition(text, channel);
  return measure.ratio >= REPETITION_RATIO_THRESHOLD ? measure : undefined;
```
Run: the same command.
Expected: FAIL — **exactly three red.** "measures each channel INDEPENDENTLY" goes red (`expected undefined to be defined`), "never measures CONTENT in respond mode" goes red (content now measured without the mode gate), and "never CONCATENATES" goes red (text `<think>…</think>` is longer than reasoning, so channel reads `content`). The new content-floor case stays GREEN under this injection — with `text` the only non-empty channel, longest-channel and per-channel agree — which is exactly why it is not a substitute for Injection C. Restore the Step 4 body.

- [ ] **Step 9: Injection D — report BYTES where the contract says CHARS**

The `measureRepetition` chars/bytes contract is the only thing standing between a CJK judge and a figure an operator cannot compare against `length(ModelJudgment."reasoningContent")`, and until this step it was asserted with no injection behind it — both `measureRepetition` cases stay green under Injections A, B and C, so the mutants those assertions exist to catch are never run (failure mode 5).

Break: in `measureRepetition` change `chars: text.length` to `chars: buf.byteLength`.
Run: `cd /root/judge-arena && npx vitest run tests/lib/degeneration.test.ts`
Expected: FAIL — **exactly one red**: "measures BYTES, reports CHARS, and echoes the channel", on `expect(m.chars).toBe(10_000)` (`expected 30000 to be 10000`).

**Why exactly one, and not more — work this before running it.** A review draft of this plan predicted a second red, "the floor is inclusive at exactly 8,000 chars", on the reasoning that 7,500 CJK chars would now "measure as 22,500 and get flagged". That is wrong for THIS implementation: the floor gate in `detectRepetitionLoop` reads `reasoning.length` / `result.text.length` — the raw string — and never `measure.chars`, so mutating the returned `chars` field cannot move any floor decision. The CJK assertion stays green. Every other fixture in the file is ASCII, where `chars === bytes`, so nothing else can move either. If a second test goes red, the implementation is not the one in Step 4 — stop and read it. Restore `chars: text.length`.

Optional second form, if you want the `ratio` field pinned the same way: change `ratio: buf.byteLength / compressedBytes` to `ratio: text.length / compressedBytes`. Predicted red is again exactly one — the same CJK `measureRepetition` case, on `expect(m.ratio).toBe(m.bytes / m.compressedBytes)` — and that single red IS the evidence that the CJK case is the sole guard for the whole bytes/chars contract at this level.

- [ ] **Step 10: Injection E — the ratio boundary is EXCLUSIVE**

Break: in `isLoopRatio` change `return ratio >= REPETITION_RATIO_THRESHOLD;` to `return ratio > REPETITION_RATIO_THRESHOLD;`.
Run: the same command.
Expected: FAIL — **exactly one red**: "the constants are the documented ones, and the ratio comparison is INCLUSIVE", on `expect(isLoopRatio(5)).toBe(true)` (`expected false to be true`). Nothing else moves, and that is the point: every loop fixture in the file measures 14.4x or above and every negative 4.41x or below, so no detect/undetect case lands on the boundary. Before `isLoopRatio` existed this mutant was invisible — it survived all 18 cases here and all 11 in `tests/lib/llm-truncation.test.ts` while quietly converting the binding decision (threshold 5, chosen so run 9's 52,702-char 5.23x row is caught) into the alternative the owner rejected. Restore `>=`.

Do NOT extend this injection to the two LENGTH gates (`reasoning.length >= REPETITION_MIN_CHARS`): those are already pinned by the two "the floor is inclusive at exactly 8,000 chars" cases, which is why this injection is scoped to the ratio comparison alone.

- [ ] **Step 11: Gates for this task (unit-level; the full set runs in Task 3)**

Run:
```bash
cd /root/judge-arena && npm run lint && npx tsc --noEmit && npm run test:coverage 2>&1 | tail -40
```
Expected: lint 0 problems; tsc 0; **N + 18** unit tests across **F + 1** files (N and F from Task 1 Step 4; on `33b7be4` that is **906 across 58** — an illustration, not the expectation: the expectation is the offset from the numbers Task 1 Step 4 actually printed, and an unexplained delta is a finding). Coverage: **`registry.ts`'s own per-file row is unchanged** (this task does not touch it) and **`degeneration.ts` reads 100/100/100/100** — the `??`, both length gates, both `isLoopRatio` calls and both of `isLoopRatio`'s outcomes are each a named case above. Compare those per-file rows against **C** from Task 1 Step 4; the `src/lib/llm` aggregate is a secondary sanity check only, because a new file at 100/100/100/100 can only push the aggregate up and therefore cannot detect a drop anywhere else in the directory. Do NOT compare against the pre-wave-1 95.79 / 89.44 / 98.05 / 95.79, which was measured on a tree that no longer exists. The command exits 0.

- [ ] **Step 12: Stage, do not commit**

```bash
git -C /root/judge-arena add src/lib/llm/degeneration.ts tests/lib/reasoning-fixtures.ts tests/lib/degeneration.test.ts
git -C /root/judge-arena status --short --untracked-files=no
```
Expected: exactly three `A` lines. The single `feat(llm)` commit is made at the end of Task 3 — a detector nothing calls is not a product change, and the binding decision for this item is one feat commit plus docs.

---

### Task 3: Wire the detector into the guard, carry the measure on the error, and pin it at the execute() level

**Files:**
- Modify: `src/lib/llm/errors.ts:37` (import), `:100` (after `callResult` on `ProviderErrorOptions`), `:114` (class field), `:125` (constructor)
- Modify: `src/lib/llm/registry.ts:75` (import), `:574-605` (doc comment), `:606-647` (`assertUsableContent`) — **`33b7be4` numbers, measured 2026-09-02**. These were `:610-641` / `:642-683` in earlier revisions of this plan; wave 2's sampling extraction moved everything at or after the old `:460` by **−36** (`:75` is above the extraction point and did not move). Re-anchor before editing:
  ```bash
  grep -n "^function assertUsableContent\|^import { ProviderError } from './errors'\|Refuse to hand a truncated or empty response" /root/judge-arena/src/lib/llm/registry.ts
  ```
  Expected on `33b7be4`: `75:` / `575:` / `606:` — i.e. the import, the first line of the doc comment body (the comment opens at `:574`), and the function signature. Use whatever prints; every `old_string` below matches on text.
- Test: `tests/lib/llm-truncation.test.ts` (extend; imports the consumer already at :62 with `@/lib/db` mocked at :57 — both re-verified on `33b7be4`; the file is 530 lines with 22 tests)

**Interfaces:**
- Consumes: `detectRepetitionLoop`, `RepetitionMeasure` from Task 2 (exact signatures above); `ProviderError` / `ProviderErrorOptions` (`errors.ts:41-127` — unmoved by either wave); `ExecuteRequest.mode?: 'judgment' | 'respond'` (`registry.ts:440`, was `:476`). Re-anchor that one too, since it has no text-match edit behind it: `grep -n "mode?: 'judgment' | 'respond'" /root/judge-arena/src/lib/llm/registry.ts`
- Produces: `ProviderError.repetition?: RepetitionMeasure` (read by nothing in-tree yet — a future `run.ts` "N of M failures were loops" line or a scoreboard column reads it); the two message shapes quoted verbatim in Task 4:
  - loop: `Provider call to "<id>" (<model>) <what>: <facts>. The output looks like DEGENERATE REPETITION (deflate ratio N.Nx over M <channel> chars; ordinary prose compresses ~2-4x) — raising samplingDefaults.max_tokens buys a longer loop, not a verdict. Try a repetition/frequency penalty, a different temperature, or a different judge.`
  - non-loop: `Provider call to "<id>" (<model>) <what>: <facts>. <why> — raise samplingDefaults.max_tokens on a NEW ordinal of the JudgeModelVersion for this judge (never edit samplingDefaults mid-run: a version is an immutable provenance pin, prisma/seed-core.ts:223-229).`
  `facts` stays byte-identical (`max_tokens N, completion_tokens N|unknown, reasoning_tokens N|unknown, content length N chars`).

- [ ] **Step 1: Write the failing execute()-level tests**

Edit `/root/judge-arena/tests/lib/llm-truncation.test.ts`. Three edits.

(a) Add the fixture import directly under line 2 (`import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';`):

```ts
import { legitLong, loopAfterPrefix, loopPure } from './reasoning-fixtures';
```

(b) Replace the fixture comment at :105-106
```ts
/** The live-proven truncated shape: content EMPTY, 1164 chars of
 * reasoning_content, finish_reason 'length', at max_tokens 300. */
```
with
```ts
/** The live-proven truncated shape: content EMPTY, 1164 chars of
 * reasoning_content, finish_reason 'length', at max_tokens 300.
 *
 * 1164 chars of 'x' deflates at 64x — far above the loop detector's 5x — and
 * this fixture is what keeps the detector's 8,000-char FLOOR honest: the
 * assertions below that the message names `samplingDefaults.max_tokens` are
 * the floor's regression guard. Lengthening this fixture past 8,000 chars
 * would flip them (tests/lib/degeneration.test.ts pins the boundary). */
```

(c) Append at the end of the file (after the closing `});` of the `markJudgmentError records the runtime` block — line 530 on `33b7be4`, the last line of the file):

```ts

// ─── a repetition loop at the budget is named as a loop ─────────────────────

/**
 * Handoff 2026-09-01 §5.2. granite4.2:3b failed 5 of 30 calibration items
 * with finish_reason 'length' at max_tokens 12288; the guard's message said
 * "raise samplingDefaults.max_tokens". All five were degenerate repetition
 * (26k-56k reasoning chars, one clause cycling; deflate 5.2-29x against
 * 3.0-4.1x for the judgments that finished), and a larger budget buys a
 * longer loop. The advice is inverted here, and the measure rides on the
 * error so the decision is auditable — the same reason `timeout` and
 * `attempt` are on it.
 *
 * Every case below goes through the REAL execute() → callOpenAICompatible /
 * callAnthropic → assertUsableContent path under the client-level SDK mocks
 * this file already installs.
 */
describe('execute(): a repetition loop at the token budget is named as a loop, not as a max_tokens problem', () => {
  const at12288 = { ...baseVllmCall, samplingParams: { temperature: 0.3, max_tokens: 12288 } };

  const loopResponse = (message: Record<string, unknown>, finish_reason = 'length') => ({
    model: 'qwen3-32b',
    choices: [{ message: { role: 'assistant', content: '', ...message }, finish_reason }],
    usage: { prompt_tokens: 900, completion_tokens: 12288 },
  });

  it('PRODUCTION SHAPE — Ollama `reasoning` key, empty content, finish_reason "length": names the loop and does not say raise max_tokens', async () => {
    // Every one of run 9's five failed rows carries reasoningSource
    // 'reasoning' (verified on judge-arena-pg-1, 2026-09-01).
    const reasoning = loopAfterPrefix();
    openaiCreateMock.mockResolvedValue(loopResponse({ reasoning }));

    const error = await execute(getDescriptor('ollama'), { ...at12288, baseUrl: 'http://ollama.internal:11434/v1', modelId: 'granite4.2:3b' }).catch((e) => e);

    expect(error).toMatchObject({ name: 'ProviderError', kind: 'non_retryable' });
    expect(error.message).toContain('was CUT OFF at the token budget');
    // `facts` is byte-identical to the truncation message — the numbers an
    // operator sizes anything by must not move.
    expect(error.message).toContain('max_tokens 12288');
    expect(error.message).toContain('completion_tokens 12288');
    expect(error.message).toContain('reasoning_tokens unknown');
    expect(error.message).toContain('content length 0 chars');
    expect(error.message).toContain('DEGENERATE REPETITION');
    expect(error.message).toContain('deflate ratio');
    expect(error.message).toContain(`over ${reasoning.length} reasoning chars`);
    expect(error.message).not.toContain('raise samplingDefaults.max_tokens');
    expect(error.message).not.toContain('NEW ordinal');
    expect(error.repetition).toMatchObject({ channel: 'reasoning', chars: reasoning.length });
    expect(error.repetition.ratio).toBeGreaterThanOrEqual(5);
    expect(error.callResult).toMatchObject({ reasoningSource: 'reasoning', finishReason: 'length', text: '' });
    expect(error.callResult.reasoningText).toBe(reasoning);
  });

  it('vLLM/llama.cpp `reasoning_content` key: same', async () => {
    openaiCreateMock.mockResolvedValue(loopResponse({ reasoning_content: loopAfterPrefix() }));

    const error = await execute(getDescriptor('vllm'), at12288).catch((e) => e);

    expect(error.message).toContain('DEGENERATE REPETITION');
    expect(error.repetition.channel).toBe('reasoning');
    expect(error.callResult.reasoningSource).toBe('reasoning_content');
  });

  it('Anthropic thinking block at stop_reason "max_tokens": same', async () => {
    const thinking = loopAfterPrefix();
    anthropicCreateMock.mockResolvedValue({
      model: 'claude-sonnet-4-5',
      content: [{ type: 'thinking', thinking, signature: 'sig' }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 10, output_tokens: 12288 },
    });

    const error = await execute(getDescriptor('anthropic'), { ...at12288, baseUrl: undefined, modelId: 'claude-sonnet-4-5' }).catch((e) => e);

    expect(error).toMatchObject({ kind: 'non_retryable' });
    expect(error.message).toContain('finish_reason "max_tokens"');
    expect(error.message).toContain('DEGENERATE REPETITION');
    expect(error.repetition).toMatchObject({ channel: 'reasoning', chars: thinking.length });
    expect(error.callResult.reasoningSource).toBe('anthropic_thinking');
  });

  it('a MULTI-BYTE reasoning channel reports CHARS in the message, never bytes', async () => {
    // Every other fixture in this file is pure ASCII, so chars === bytes and
    // an implementation that rendered `${loop.bytes} ${loop.channel} chars`
    // — both fields are on the same object, and the module deliberately
    // measures BYTES — would pass all of them. 10,000 CJK chars are 30,000
    // UTF-8 bytes (297x). The message must name the figure an operator can
    // compare against `length(ModelJudgment."reasoningContent")`.
    const reasoning = '漢字の判定'.repeat(2_000);
    openaiCreateMock.mockResolvedValue(loopResponse({ reasoning_content: reasoning }));

    const error = await execute(getDescriptor('vllm'), at12288).catch((e) => e);

    expect(error.message).toContain('DEGENERATE REPETITION');
    expect(error.message).toContain('over 10000 reasoning chars');
    expect(error.message).not.toContain('over 30000');
    expect(error.repetition).toMatchObject({ channel: 'reasoning', chars: 10_000, bytes: 30_000 });
  });

  it('a non-reasoning judge looping in CONTENT at "length" is caught on the content channel', async () => {
    const content = loopPure();
    openaiCreateMock.mockResolvedValue(loopResponse({ content }));

    const error = await execute(getDescriptor('vllm'), at12288).catch((e) => e);

    expect(error.message).toContain('DEGENERATE REPETITION');
    expect(error.message).toContain(`over ${content.length} content chars`);
    expect(error.repetition.channel).toBe('content');
    expect(error.callResult.text).toBe(content);
  });

  it('RESPOND mode never measures content: a long structured answer cut at the budget keeps the raise-max_tokens advice', async () => {
    openaiCreateMock.mockResolvedValue(loopResponse({ content: loopPure() }));

    const error = await executeRespondCall(
      prepareRespondCall({
        judgeVersion: { ...judgeVersion, samplingDefaults: { temperature: 0.3, max_tokens: 12288 } },
        endpoint,
        submission: { promptText: 'list every step' },
      })
    ).catch((e) => e);

    expect(error).toMatchObject({ kind: 'non_retryable' });
    expect(error.message).not.toContain('DEGENERATE REPETITION');
    expect(error.message).toContain('raise samplingDefaults.max_tokens');
    expect(error.repetition).toBeUndefined();
  });

  it('the EMPTY branch (finish_reason "stop", looping reasoning) drops the max_tokens advice too', async () => {
    openaiCreateMock.mockResolvedValue(loopResponse({ reasoning_content: loopAfterPrefix() }, 'stop'));

    const error = await execute(getDescriptor('vllm'), at12288).catch((e) => e);

    expect(error.message).toContain('returned an EMPTY content channel');
    expect(error.message).toContain('DEGENERATE REPETITION');
    expect(error.message).not.toContain('raise samplingDefaults.max_tokens');
  });

  it('REGRESSION: long-but-legitimate reasoning at "length" keeps the raise-max_tokens advice, now pointing at a NEW ordinal', async () => {
    openaiCreateMock.mockResolvedValue(loopResponse({ reasoning_content: legitLong(20_000) }));

    const error = await execute(getDescriptor('vllm'), at12288).catch((e) => e);

    expect(error).toMatchObject({ kind: 'non_retryable' });
    expect(error.message).not.toContain('DEGENERATE REPETITION');
    expect(error.message).toContain('A response cut off mid-reasoning is not a completed judgment');
    expect(error.message).toContain('raise samplingDefaults.max_tokens on a NEW ordinal of the JudgeModelVersion');
    expect(error.message).toContain('never edit samplingDefaults mid-run');
    expect(error.repetition).toBeUndefined();
  });

  it('never runs on a healthy call: 44k of compressible CONTENT at finish_reason "stop" is returned, not failed', async () => {
    // The detector is consulted ONLY after the guard has decided to fail.
    // The existing "leaves a healthy call completely alone" case uses 31
    // chars of content — under the floor — so it would not notice an
    // implementation that measures every call and throws on a hit.
    const content = loopPure();
    openaiCreateMock.mockResolvedValue(loopResponse({ content }, 'stop'));

    const result = await execute(getDescriptor('vllm'), at12288);

    expect(result.text).toBe(content);
  });

  it('classify() returns the loop error untouched, repetition intact', async () => {
    openaiCreateMock.mockResolvedValue(loopResponse({ reasoning_content: loopAfterPrefix() }));

    const error = await execute(getDescriptor('vllm'), at12288).catch((e) => e);
    const classified = classify(error, 'vllm');

    expect(classified).toBe(error);
    expect(classified.kind).toBe('non_retryable');
    expect((classified as typeof error).repetition.channel).toBe('reasoning');
  });

  it('markJudgmentError persists the tagged message and the loop verbatim, so the row stays inspectable', async () => {
    const reasoning = loopAfterPrefix();
    openaiCreateMock.mockResolvedValue(loopResponse({ reasoning_content: reasoning }));

    const error = await execute(getDescriptor('vllm'), at12288).catch((e) => e);
    await markJudgmentError('judgment-loop', error.message, error.callResult);

    const { data } = judgmentUpdateMock.mock.calls[0][0];
    expect(data.status).toBe('error');
    expect(data.error).toContain('DEGENERATE REPETITION');
    expect(data.finishReason).toBe('length');
    expect(data.rawResponse).toBe('');
    expect(data.reasoningContent).toBe(reasoning);
    expect(data.reasoningSource).toBe('reasoning_content');
  });
});
```

- [ ] **Step 2: Run the file to verify the new cases fail for the right reason**

Run: `cd /root/judge-arena && npx vitest run tests/lib/llm-truncation.test.ts`
Expected: **9 of the 11 new tests FAIL, 24 pass** (the pre-existing 22 plus two new ones). Red: Ollama, vLLM, Anthropic, multi-byte reasoning, content-channel, EMPTY branch, REGRESSION, classify passthrough (a `TypeError` on `undefined.channel`) and markJudgmentError — e.g. `expected 'Provider call to "ollama" (granite4.2:3b) was CUT OFF …' to contain 'DEGENERATE REPETITION'` and, for the regression case, `… to contain 'raise samplingDefaults.max_tokens on a NEW ordinal of the JudgeModelVersion'`. Green already: the RESPOND-mode case (it asserts today's behaviour — today's message contains `raise samplingDefaults.max_tokens` and `repetition` is undefined — and is the discriminator for Injection B below) and the healthy-call case (today's guard returns early on `stop` + non-empty content; it is the discriminator for Injection D below).

- [ ] **Step 3: Carry the measure on ProviderError**

Edit `/root/judge-arena/src/lib/llm/errors.ts`.

(a) After line 37 (`import type { ProviderCallResult } from './provider';`) add:
```ts
import type { RepetitionMeasure } from './degeneration';
```

(b) In `ProviderErrorOptions`, replace
```ts
  callResult?: ProviderCallResult;
  /** The original error, preserved via the standard `Error.cause` chain. */
  cause?: unknown;
}
```
with
```ts
  callResult?: ProviderCallResult;
  /**
   * Set by `registry.ts`'s `assertUsableContent` when the output that
   * caused a truncation/empty-content failure measured as a DEGENERATE
   * REPETITION LOOP (`./degeneration.ts`: a channel over 8,000 chars that
   * deflates ≥ 5x). Carried so the decision is AUDITABLE — the message says
   * "loop" and this says by how much, over which channel, in numbers a later
   * policy (a per-judge loop count, a retry-with-penalty) can branch on
   * without parsing text. Never set by `classify()`; only by the code that
   * had the output in hand. Absent on every ordinary truncation.
   */
  repetition?: RepetitionMeasure;
  /** The original error, preserved via the standard `Error.cause` chain. */
  cause?: unknown;
}
```

(c) In the class, replace
```ts
  readonly callResult?: ProviderCallResult;

  constructor(message: string, opts: ProviderErrorOptions) {
```
with
```ts
  readonly callResult?: ProviderCallResult;
  readonly repetition?: RepetitionMeasure;

  constructor(message: string, opts: ProviderErrorOptions) {
```
and replace
```ts
    this.callResult = opts.callResult;
  }
}
```
with
```ts
    this.callResult = opts.callResult;
    this.repetition = opts.repetition;
  }
}
```

- [ ] **Step 4: Consult the detector in the guard**

Edit `/root/judge-arena/src/lib/llm/registry.ts`.

(a) After line 75 (`import { ProviderError } from './errors';`) add:
```ts
import { detectRepetitionLoop } from './degeneration';
```

(b) Replace the tail of the doc comment (`:602-605` on `33b7be4`; was `:638-641` before wave 2 — match on the text)
```ts
 * FAILS ON 'length' UNCONDITIONALLY, even when the content happens to parse:
 * a model cut off mid-reasoning is not a completed judgment for a
 * calibration corpus, however well-formed the prefix it managed to emit.
 */
```
with
```ts
 * FAILS ON 'length' UNCONDITIONALLY, even when the content happens to parse:
 * a model cut off mid-reasoning is not a completed judgment for a
 * calibration corpus, however well-formed the prefix it managed to emit.
 *
 * ── CORRECTED 2026-09-01 ────────────────────────────────────────────────
 * This guard used to end EVERY message with "raise samplingDefaults.max_tokens
 * on the JudgeModelVersion for this judge", with total confidence. That advice
 * was given in writing, before measuring, on calibration run 9
 * (granite4.2:3b, max_tokens 12288) — and it was wrong for all five failures:
 * they were a DEGENERATE REPETITION LOOP (26k-56k reasoning chars of one
 * clause cycling, deflate 5.2-29x against 3.0-4.1x for the judgments that
 * finished), and a larger budget buys a longer loop. Those five consumed 41
 * of the run's 82 minutes for zero verdicts. Run 8 (max_tokens 4096) had
 * already shown an 11,680-char loop at 15.7x; raising the budget, as the
 * message said to, is what produced run 9. `finish_reason: 'length'` is
 * ambiguous between "ran out of room" and "never going to stop"; the guard
 * now asks `./degeneration.ts` which, and only then chooses the advice.
 *
 * Also corrected: the surviving advice names a NEW ordinal. A version's
 * `samplingDefaults` is an immutable provenance pin (prisma/seed-core.ts:
 * 223-229 — "no update code path may exist"); editing it mid-run rewrites
 * what every earlier judgment of the run claims to have been produced by.
 */
```

(c) Replace the body of `assertUsableContent` from
```ts
  const truncated = result.finishReason !== undefined && TRUNCATED_FINISH_REASONS.has(result.finishReason);
  const empty = result.text.trim() === '';
  if (!truncated && !empty) return;

  // Every number an operator needs to size the fix, in the message itself:
```
through the end of the function
```ts
      callResult: result,
    }
  );
}
```
with
```ts
  const truncated = result.finishReason !== undefined && TRUNCATED_FINISH_REASONS.has(result.finishReason);
  const empty = result.text.trim() === '';
  if (!truncated && !empty) return;

  // Only on the failure path — deflate over <= ~60k chars (~0.07 ms on a
  // loop, ~1 ms on incompressible prose) is paid once per failed call and
  // never on a healthy one. The mode gates the content channel: see
  // degeneration.ts.
  const loop = detectRepetitionLoop(result, request.mode);

  // Every number an operator needs to size the fix, in the message itself:
  // the ceiling that was hit, how the spend split between thinking and
  // answering (an empty answer at a healthy finish reason is almost always
  // "it thought until the budget ran out"), and how much answer survived.
  const facts =
    `max_tokens ${request.samplingParams.max_tokens}, ` +
    `completion_tokens ${result.outputTokens ?? 'unknown'}, ` +
    `reasoning_tokens ${result.reasoningTokens ?? 'unknown'}, ` +
    `content length ${result.text.length} chars`;

  const what = truncated
    ? `was CUT OFF at the token budget (finish_reason "${result.finishReason}")`
    : `returned an EMPTY content channel (finish_reason "${result.finishReason ?? 'unset'}")`;

  const why = truncated
    ? 'A response cut off mid-reasoning is not a completed judgment'
    : 'The model spent its output budget on the reasoning channel and never emitted an answer';

  // The advice is the part that was wrong (see the CORRECTED block above):
  // for a loop, the one lever the old message named makes it worse.
  const advice = loop
    ? `The output looks like DEGENERATE REPETITION (deflate ratio ${loop.ratio.toFixed(1)}x over ` +
      `${loop.chars} ${loop.channel} chars; ordinary prose compresses ~2-4x) — raising ` +
      `samplingDefaults.max_tokens buys a longer loop, not a verdict. Try a repetition/frequency ` +
      `penalty, a different temperature, or a different judge.`
    : `${why} — raise samplingDefaults.max_tokens on a NEW ordinal of the JudgeModelVersion for this ` +
      `judge (never edit samplingDefaults mid-run: a version is an immutable provenance pin, ` +
      `prisma/seed-core.ts:223-229).`;

  throw new ProviderError(`Provider call to "${descriptor.id}" (${request.modelId}) ${what}: ${facts}. ${advice}`, {
    // Still non_retryable for a loop: the kind is a property of the request
    // (same budget, same sampling → same trajectory), a retry would burn a
    // second hard-cap attempt for the same nothing, and the consumer's
    // non_retryable branch already persists the reasoning channel so the
    // loop stays inspectable. `repetition` is on the error precisely so a
    // later policy can branch on it without re-deciding this here.
    kind: 'non_retryable',
    provider: descriptor.id,
    // Carries the reasoning channel, the token split and the rendered
    // prompt onto the failure itself, so `markJudgmentError` can persist
    // the evidence instead of only the message.
    callResult: result,
    ...(loop !== undefined ? { repetition: loop } : {}),
  });
}
```

- [ ] **Step 5: Run the file to verify it passes**

Run: `cd /root/judge-arena && npx vitest run tests/lib/llm-truncation.test.ts tests/lib/degeneration.test.ts tests/lib/llm-errors.test.ts`
Expected: PASS — 33 in llm-truncation (22 + 11), 18 in degeneration, llm-errors unchanged. The pre-existing assertions at llm-truncation :140-141 (`samplingDefaults.max_tokens`, `JudgeModelVersion`) and :294 are green because the non-loop advice still contains both substrings.

- [ ] **Step 6: Injection A — remove the detector from the guard**

Break: in `assertUsableContent` change `const loop = detectRepetitionLoop(result, request.mode);` to `const loop = undefined;` (leave the import; this is a runtime injection, tsc noise is expected and irrelevant).
Run: `cd /root/judge-arena && npx vitest run tests/lib/llm-truncation.test.ts`
Expected: FAIL — exactly the seven loop cases (Ollama, vLLM, Anthropic, multi-byte reasoning, content-channel, EMPTY branch, classify passthrough) and the markJudgmentError-persists case go red (**8 red**) with `… to contain 'DEGENERATE REPETITION'` / `Cannot read properties of undefined (reading 'channel')`; the RESPOND-mode case, the REGRESSION case and the healthy-call case stay green — which is what proves the detector discriminates rather than decorates. Restore.

- [ ] **Step 7: Injection B — drop the mode gate**

Break: in `assertUsableContent` change `detectRepetitionLoop(result, request.mode)` to `detectRepetitionLoop(result, 'judgment')`.
Run: the same command.
Expected: FAIL — only "RESPOND mode never measures content" goes red (`expected … not to contain 'DEGENERATE REPETITION'`). Restore.

- [ ] **Step 8: Injection C — drop the measure from the error**

Break: delete the line `...(loop !== undefined ? { repetition: loop } : {}),`.
Run: the same command.
Expected: FAIL — **6 red**: the Ollama, vLLM, Anthropic, multi-byte-reasoning, content-channel and classify cases go red on `error.repetition` (`Cannot read properties of undefined` for the vLLM, content-channel and classify cases, which reach for `.channel` directly, and `expected undefined to match object` for the three `toMatchObject` assertions — Ollama, Anthropic, multi-byte); every message assertion stays green, which is what proves the flag is carried independently of the text. Restore.

- [ ] **Step 9: Injection D — "a loop is a failure even at finish_reason stop"**

Break: in `assertUsableContent` move the line `const loop = detectRepetitionLoop(result, request.mode);` to directly ABOVE the early return, and change that return to
```ts
  if (!truncated && !empty && !loop) return;
```
Run: **the WHOLE unit suite this time, not the single file** — `cd /root/judge-arena && npm test 2>&1 | tail -20`. This is the one injection whose blast radius is not confined to `tests/lib/llm-truncation.test.ts`: it changes the early-return condition on the chokepoint EVERY seam inherits, so any unit test anywhere that mocks a large, compressible successful response would flip from returning to throwing. Record the tree-wide failed/passed counts.
Expected: FAIL — **exactly one red across the whole unit suite**: "never runs on a healthy call" in `tests/lib/llm-truncation.test.ts` (the call now throws `ProviderError: Provider call to "vllm" (…) returned an EMPTY content channel (finish_reason "stop") … DEGENERATE REPETITION …` where a result was expected). Every failure-path case stays green — `truncated`/`empty` still decide those.

**The collision set that was checked, so "exactly one" is a claim and not a hope.** The other large fixtures in `tests/lib` are all on the PROMPT side, not the response side: `llm-truncation.test.ts:325` (`'a'.repeat(40_000)` as `userPrompt`) and `:344` (`'漢'.repeat(20_000)` as `userPrompt`) both mock the response content as the two-character string `'ok'`, which is under the 8,000-char floor and also has no `finish_reason`, so `loop` is `undefined` and the early return still fires. Every other healthy-call case in `llm-truncation.test.ts` has content of 31 characters or less. If the full run shows a second red, that is a fixture this analysis missed — read it before restoring. Restore the Step 4 body.

This is the mistake someone would actually make: a degenerate loop looks like a failure, so why not fail it wherever it appears? The answer is that it is not this guard's call — a model that repeats itself and then STOPS produced a complete response, `execute()` has no policy for "bad but complete", and failing it here would turn a returned judgment into a DLQ'd one on a heuristic. That is what the case pins, and it is the assertion the case owns: 44k of compressible content at `finish_reason: 'stop'` is RETURNED, not thrown.

**Read the scope of this injection honestly.** It proves the placement of the *failure decision*, not the placement of the *detector call*. The second is a cost decision — hoisting `const loop = detectRepetitionLoop(result, request.mode);` above the early return while changing nothing else leaves the whole suite GREEN, because the detector is pure and side-effect-free, so it costs ~0.07-1 ms of wall-clock per healthy call and nothing else. That one is enforced by review, on the comment in Step 4(c) that says "Only on the failure path", not by a test. Say exactly that in review; do not claim this injection proves more than it does.

- [ ] **Step 10: Injection E — render BYTES where the message says CHARS**

The multi-byte case's own comment names the wrong implementation (`${loop.bytes} ${loop.channel} chars` — both fields sit on the same object and the module deliberately measures bytes), but until this step nothing demonstrated that the test reddens against it: Injection A reddens that case for an unrelated reason (the whole DEGENERATE REPETITION clause disappears), so the file's ability to catch a bytes/chars swap in the RENDERING was asserted and never shown. Task 2's Injection D pins the same contract one level down, on the measure; this pins it at the message the operator actually reads.

Break: in the `advice` template in `assertUsableContent`, change `${loop.chars} ${loop.channel} chars` to `${loop.bytes} ${loop.channel} chars`.
Run: `cd /root/judge-arena && npx vitest run tests/lib/llm-truncation.test.ts`
Expected: FAIL — **exactly one red**: "a MULTI-BYTE reasoning channel reports CHARS in the message, never bytes", failing on `expected '… over 30000 reasoning chars …' to contain 'over 10000 reasoning chars'` (and, on a second assertion of the same case, `expected '… over 30000 …' not to contain 'over 30000'`). All ten other new cases stay green, and that is the evidence: every other fixture in the file is ASCII, so `chars === bytes` and the rendered message is byte-identical under the mutant — the CJK case is the sole guard. Restore `${loop.chars}`.

- [ ] **Step 11: Full gates, in CI order**

```bash
grep DATABASE_URL /root/judge-arena/.env.test     # must be localhost:5432/judge_arena_test — the podman judge-arena-pg
cd /root/judge-arena && npm run lint && npx tsc --noEmit && npm run test:coverage 2>&1 | tail -40
cd /root/judge-arena && npm run test:db:coverage 2>&1 | tail -15
cd /root/judge-arena && npm run test:integration 2>&1 | tail -8
cd /root/judge-arena && npm run build 2>&1 | tail -5
```
Expected: lint 0; tsc 0; unit **N + 29** (18 pure + 11 execute-level) across **F + 1** files, with exit 0 — N and F from Task 1 Step 4; on `33b7be4` that renders **917 across 58**, which is an ILLUSTRATION of the offset and not the expectation. **The db and integration figures are "unchanged from what Task 1 Step 4 printed", never a literal:** this plan adds no db test and no integration test, so whatever those suites read before they must read after (`674 / 46 files` and `82 / 11 files` on `33b7be4`). An earlier revision stated `db 670 / 46 files` as a flat expected result; on the current tree that would have shown a phantom +4 regression, or been copied into the `Gates:` line as a number nobody measured — failure mode 15, in both directions. If either suite moves, that IS a finding: stop and explain it before committing.

Coverage: **compare the per-file `registry.ts` and `degeneration.ts` rows against C**, not only the `src/lib/llm` aggregate — the aggregate cannot detect a drop in `registry.ts`, because `degeneration.ts` enters the same denominator at 100/100/100/100 and pushes it up regardless. `registry.ts` gains two branches (`loop ?` and `loop !== undefined ?`); the two length gates, the two `isLoopRatio` call sites and `isLoopRatio`'s own two outcomes are counted against `degeneration.ts`. All of them are exercised by the cases above, so `registry.ts`'s own row must not fall and `degeneration.ts` must read 100/100/100/100; the `src/lib/llm/**` GLOB branches figure (floor 83; `vitest.config.ts:202-203` records the glob actual as **86.72**, a different denominator from the `src/lib/llm` table row because the glob includes `backends/**`) does not fall. Build succeeds.

The db and integration runs are justified HERE and only here, and for these reasons specifically:
- **db:** `tests/db/model-endpoint-crud.test.ts:7` imports `@/app/api/models/[id]/verify/route`, which imports `@/lib/llm/verify`, which imports `./registry` — so the db suite exercises `registry.ts` TRANSITIVELY, through the verify route handler. (No `tests/db` file imports `registry.ts` directly; an earlier draft of this step claimed `models-llamacpp.test.ts` and `seed-catalog.test.ts` do, and both are wrong — `models-llamacpp.test.ts:4` imports `@/app/api/models/route`, which reaches `@/lib/model-catalog` and never `@/lib/llm`, and `seed-catalog.test.ts` imports only `prisma/seed-core`.)
- **db coverage:** that run has its OWN denominator and floors (`vitest.db.config.ts:35` includes `src/lib/**/*.ts`; `:149-153` gates aggregates at lines 47 / functions 60 / branches 77 / statements 47). `degeneration.ts` is LOADED there (registry imports it as a value) but none of its functions execute, and `assertUsableContent` gains ~8 statements that the db run never reaches — all of it dead weight in that denominator. Compare the `All files` / `src/lib` row against **D** from Task 1 Step 4, and say in review that D is the config's own recorded ten-run actual (`:113-121`: 49.17 statements / 79.28-79.47 branches / 62.58 functions / 49.17 lines) rather than a same-day measurement, because Task 1's pre-change db run was deliberately skipped for the arithmetic given there. Headroom on the tightest column is 2.28pp against a worst-case cost of a few tenths; if any aggregate dips anyway, the fix is test-side — **never** a floor edit.
- **integration:** `tests/integration/worker-claims.test.ts:13` imports `ProviderError` from `@/lib/llm/errors`, which Step 3 edits — so this is a real, if small, check on an edited file, not belt-and-braces. The edit is strictly additive (one optional readonly field plus a type-only import that is erased at compile time), so nothing under `tests/integration/` should move; say exactly that in review. (`tests/integration/breaker.test.ts:2` imports `@/lib/llm/breaker-redis`, which this plan does not touch.)

Note for the record: `tests/lib/llm-truncation.test.ts` already imported the consumer before this task, so no module enters the UNIT coverage denominator that was not in it on HEAD.

- [ ] **Step 12: The single feat commit**

**Why this is ONE commit and not two.** It carries two visible changes — the loop detector, and the rewording of the NON-loop advice from "on the JudgeModelVersion" to "on a NEW ordinal … never edit samplingDefaults mid-run" — and the second has its own red test and its own CORRECTION note. They are one concern because they are one string: `assertUsableContent` emits a single `advice` expression whose two arms are the two halves of the same sentence, and the correction being made is "this guard gave one piece of advice with total confidence and both of its parts were wrong". Splitting them would produce an intermediate commit whose CORRECTION block describes a message the code does not yet emit, and would require touching the same six lines twice. If a reviewer disagrees, the clean split is `feat(llm)` for the detector and `fix(llm)` for the new-ordinal wording, in that order, with Task 4's docs commit last — say which you did and why (CONTRIBUTING.md:1639).

Paste the Task 1 numbers where marked: replace the `<PASTE the ten Task 1 Step 2 lines here, verbatim>` marker with the ten lines Task 1 Step 2 printed, and replace every `<x>` / `<chars>` with the corresponding figure Task 1 Step 3 printed (completed granite4.2 max ratio and its char count; completed Qwen3.6 max ratio; failed granite4.2 min and max ratios), and `<content-scan>` with what Task 1 Step 3's content-channel scan printed. Re-read the body and confirm **no `<` remains** before running `git commit`. `<n>` values come from Step 11 — on `33b7be4` the line would render `Gates: lint 0, tsc 0, 917 unit / 58 files, 674 db / 46 files, 82 integration / 11 files, coverage 0.`, but **use the printed numbers**, not that illustration.

```bash
git -C /root/judge-arena add src/lib/llm/degeneration.ts src/lib/llm/errors.ts src/lib/llm/registry.ts tests/lib/reasoning-fixtures.ts tests/lib/degeneration.test.ts tests/lib/llm-truncation.test.ts
git -C /root/judge-arena status --short --untracked-files=no
git -C /root/judge-arena commit -F - <<'EOF'
feat(llm): name a repetition loop as a loop — finish_reason length is not a max_tokens problem

The truncation guard (assertUsableContent, the one chokepoint every seam
inherits) ended every message with "raise samplingDefaults.max_tokens on
the JudgeModelVersion for this judge". On calibration run 9 (granite4.2:3b,
max_tokens 12288) that advice was given in writing before measuring, and it
was wrong for all five failures: they were DEGENERATE REPETITION, not
truncation. A larger budget buys a longer loop; those five consumed 41 of
the run's 82 minutes for zero verdicts. Run 8 (4096) had already produced
an 11,680-char loop at 15.7x that the same message told the operator to
raise the budget on — which is how run 9 happened.

New pure module src/lib/llm/degeneration.ts: deflate ratio (bytes /
deflateSync bytes) of each output channel that clears an 8,000-char floor,
measured INDEPENDENTLY (never concatenated — think_tag reasoning is a
substring of content). Reasoning channel always; content channel only in
judgment mode (a judgment's content is a small JSON object, and structure
alone — repeated delimiters and field names — compresses well above 5x, so
a long structured respond-mode answer would be told the opposite of what it
needs). Two seams set that mode, pointwise and pairwise, and both payload
shapes were measured on the real schema before the channel was kept: the
pointwise shape over the seed catalog's 5-criterion rubric reads 3.02-3.42x
from 9k to 57k chars and only crosses 5x at ~60 criteria with a terse
rationale (6.10x); the pairwise {verdict, reasoning} shape reads 3.17x at
20k chars. Production content-channel scan (rows with >= 8k rawResponse
chars): <content-scan>.
Threshold 5x, INCLUSIVE — pinned by isLoopRatio(5)/isLoopRatio(4.999)
rather than left to review, because a `>` implementation passed every
detect/undetect case in both suites while silently swapping the binding
decision for the alternative it rejected.
The guard consults it after deciding to fail, swaps the advice,
keeps `facts` byte-identical, keeps kind non_retryable, and stamps the
measure on ProviderError.repetition (auditable, like timeout/attempt;
never set by classify()). No schema, queue or consumer change — the
consumer already persists the message and the reasoning channel.

The surviving (non-loop) advice now names a NEW ordinal: samplingDefaults
is an immutable provenance pin (prisma/seed-core.ts:223-229) and editing it
mid-run rewrites what earlier judgments of the run claim to be.

MEASURED on judge-arena-pg-1 (read-only, node zlib default level) before
pinning the constants — CalibrationRun cmtircx0x00012b5zasyrbgpl:
  <PASTE the ten Task 1 Step 2 lines here, verbatim>
Population (all rows with >= 8k reasoning chars): completed granite4.2
n=18 max <x>x @ <chars> chars (no repeated 80-char shingle — verbose, not
cycling); completed Qwen3.6 n=74 max <x>x; failed granite4.2 n=20 range
<x>-<x>x. 5 separates run 9's own rows (4.09 vs 5.23) but sits BELOW the
completed-population max (5.38); the detector never runs on a completed
row, so that is not a production false positive, and the alternative (6:
clears 5.38, drops the ambiguous 5.23 row — which shows no verbatim
repetition — back to the max_tokens advice) is a one-constant change.

The 8,000 floor is what keeps the existing 1,164/762-char fixtures
(deflate 64x/51x) on the truncation message. Injections run: threshold to
1_000 (NOT 100 — the pure clause deflates at 140x), floor to 0, longer-
channel-only, bytes-reported-as-chars in the measure, `>` instead of `>=`
in the ratio gate, detector removed from the guard, mode gate removed,
measure dropped from the error, bytes rendered where the message says
chars, and "fail on a loop even at finish_reason stop" (run against the
WHOLE unit suite, since it changes the chokepoint every seam inherits) —
each went red on the named cases only. What is NOT pinned by a test, and
is left to review: hoisting the detector call above the early return
changes nothing observable (it is pure), so where it SITS is a cost
decision — ~0.07-1 ms of deflate per healthy call — enforced by the
comment on it.

Gates: lint 0, tsc 0, <n> unit / <n> files, <n> db / <n> files, <n> integration / <n> files, coverage 0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
EOF
git -C /root/judge-arena log -1 --format='%h %s'
```
Expected: one commit; `git -C /root/judge-arena status --short --untracked-files=no` prints nothing afterwards (the `??` sibling plan files are still there under plain `status --short`; leave them). Note the short sha — Task 4 quotes it.

---

### Task 4: Correct the four documents that quote or paraphrase the old advice

**Files:**
- Modify: `docs/runbooks/scoring-a-judge-against-a-golden-set.md:380-403` (§8.2) — **still correct on `33b7be4`**, re-verified: `grep -n '^### 8.2 '` prints `380`, `headroom for the thinking channel` prints `403`, `Check the clock before you raise` prints `405`. Neither wave moved §8.2 (wave 1 edited §8.7, below it; wave 2 did not touch this file). Do not "fix" this range.
- Modify: `README.md:618-622` (§"Truncation is now a HARD FAILURE", heading at `:594` — the closing paragraph only). The stale `registry.ts:507-580` reference at `:598` is in the SAME section and IS this task's, see Step 2.
- Modify: `docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md:510-511` (§5.4.2, heading at `:459`, section `:459-520`) — was `:489-490` / heading `:438` before wave 2
- Modify: `docs/superpowers/plans/2026-09-01-scoreboard-handoff.md:346-347` (§7 item 3) — was `:334-335` before wave 2
- Test: none (docs); the deliverable is verified by the grep in Step 5
- **All doc line numbers above are `33b7be4` numbers, re-measured 2026-09-02.** TWO waves have shifted them, by different amounts in different regions of the same file — which is the whole reason every edit below matches on quoted text. Wave 1: README +9, the spec +10 below §5.2 (§5.4.2 heading 428 → 438; `Recorded as a follow-up` 479 → 489), the handoff §5.2 +11 (200 → 211) but §7 item 3 +30 (304 → 334), the runbook +9 below §8.2 (§8.2 itself did not move). Wave 2 then added a "Landed (v2k) — with a CORRECTION" block at spec `:238-256` and moved the spec a further +21 (§5.4.2 heading 438 → **459**, the chess clause 450 → **471**, `Recorded as a follow-up` 489 → **510**) and the handoff §7 a further +12 (334 → **346**); it did NOT touch README or the runbook, so those two are unchanged since wave 1. `capture-field-gaps`, if it lands first, will shift the runbook above §8.2 (`:336-348`) and README `:578` again. **Every `old_string` block below was re-verified byte-for-byte against `33b7be4` and still matches exactly** — README `:598` and `:618-622`, runbook `:380`/`:400`/`:403`/`:405`, spec `:510-511`, handoff `:346-347`. **Match on the quoted text in each step, never on the line number.**

**Interfaces:**
- Consumes: the Task 3 commit sha (`git -C /root/judge-arena log -1 --format=%h` before starting), the two message shapes from Task 3's Interfaces block, the Task 1 numbers
- Produces: nothing code-facing

- [ ] **Step 1: Runbook §8.2**

In `/root/judge-arena/docs/runbooks/scoring-a-judge-against-a-golden-set.md`, **anchor on text, not on line numbers** — this is the only edit in the plan expressed as a range, and `capture-field-gaps` edits the same file ABOVE it (at `:336-348`), which shifts it. Confirm the boundaries first:
```bash
grep -n '^### 8.2 \|headroom for the thinking channel\|Check the clock before you raise' /root/judge-arena/docs/runbooks/scoring-a-judge-against-a-golden-set.md
```
On `33b7be4` that prints `380` / `403` / `405`, and neither wave moved any of them (`§8.2` is at `:380` on `fc9e936` too). Delete from the line beginning `### 8.2 A truncated response is a **hard, non-retryable** failure` through and including the line `headroom for the thinking channel *plus* the answer.` — i.e. the whole section down to the blank line that precedes the `> **Check the clock before you raise the budget — see §8.6.**` blockquote, which STAYS — and insert in its place:

````markdown
### 8.2 A truncated response is a **hard, non-retryable** failure — and the message says whether it was a loop

`finish_reason: 'length'` / `stop_reason: 'max_tokens'`, or an empty content channel, throws
`non_retryable` in `registry.ts`'s `execute()` — **one chokepoint, before any parse**, so pointwise,
pairwise and respond all inherit it. The message carries every number needed to size the fix, and
since `<FEAT_SHA>` it ends with one of TWO pieces of advice, chosen by measuring the output:

```
Provider call to "<backend>" (<model>) was CUT OFF at the token budget (finish_reason "length"):
max_tokens 8192, completion_tokens 8192, reasoning_tokens unknown, content length 0 chars.
A response cut off mid-reasoning is not a completed judgment — raise samplingDefaults.max_tokens
on a NEW ordinal of the JudgeModelVersion for this judge (never edit samplingDefaults mid-run:
a version is an immutable provenance pin, prisma/seed-core.ts:223-229).
```

```
Provider call to "ollama" (granite4.2:3b) was CUT OFF at the token budget (finish_reason "length"):
max_tokens 12288, completion_tokens 12288, reasoning_tokens unknown, content length 0 chars.
The output looks like DEGENERATE REPETITION (deflate ratio 10.8x over 56004 reasoning chars;
ordinary prose compresses ~2-4x) — raising samplingDefaults.max_tokens buys a longer loop, not a
verdict. Try a repetition/frequency penalty, a different temperature, or a different judge.
```

**How it decides.** `src/lib/llm/degeneration.ts` deflates each output channel that is at least
8,000 characters long — reasoning always, content only for judgment calls — and calls it a loop at
a ratio of 5× or more. Measured on production rows: granite4.2 judgments that finished deflate at
3.0–4.1×; run 9's five loops at 5.2–29×. Under 8,000 characters a loop cannot be told from a short
truncation and the `max_tokens` advice is harmless — one raise surfaces a longer loop, which the
message will then name. The measure also rides on the error as `ProviderError.repetition`, and the
failure row keeps the whole reasoning channel (`ModelJudgment.reasoningContent`), so
`SELECT … WHERE error LIKE '%DEGENERATE REPETITION%'` finds every loop after the fact.

**If you suspect the message called a loop wrongly, here is how to check.** Threshold 5× sits
slightly *below* the most compressible genuine granite4.2 completion ever measured (5.38× at 32,899
characters, verbose but not cycling), so a very long, very verbose *real* truncation can in
principle be labelled a loop — and if it is, you would stop raising a budget that would have
worked. The detector never runs on a completed row, so this has no production instance; the
after-the-fact test is whether the text actually *cycles*, which compression alone cannot tell you:

```bash
kubectl -n tenant-public exec judge-arena-pg-1 -c postgres -- psql -U postgres -d judge_arena -At \
  -c "SELECT \"reasoningContent\" FROM \"ModelJudgment\" WHERE id = '<judgment-id>';" \
| node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=new Map();for(let i=0;i+80<=s.length;i+=40){const k=s.slice(i,i+80);c.set(k,(c.get(k)||0)+1);}console.log("max repeated 80-char window:",Math.max(...c.values()));});'
```

A genuine loop repeats an 80-character window three or more times; verbose-but-real reasoning
prints `1`. A `1` on a row the message called a loop means raise the budget after all — and it
means the threshold wants revisiting, so say so rather than working around it.

**Non-retryable is deliberate, in both cases.** The token budget is a property of the *request*,
not of provider health: the identical call truncates identically every time, so retrying burns the
attempt budget, DLQs the judgment, and charges three failures to a circuit breaker shared with
healthy calls. A loop at the same sampling settings re-loops.

**The failure it prevents:** respond mode used to persist truncated output as `status: 'completed'`,
making a generation chopped in half indistinguishable in the corpus from a finished one.

**For a genuine truncation the fix is one field, on a NEW ordinal:** register a new
`JudgeModelVersion` ordinal with a larger `samplingDefaults.max_tokens` (`--max-tokens=` at
registration) and calibrate that. An **empty** content channel at a healthy finish reason is almost
always "it thought until the budget ran out" — a reasoning model needs headroom for the thinking
channel *plus* the answer. **For a loop, a bigger budget is the wrong lever**: run 9's five loops
consumed 41 of the run's 82 minutes for zero verdicts, and 16k would have pushed that toward an
hour for the same nothing.

> **CORRECTION (2026-09-01).** Until `<FEAT_SHA>` this section quoted a single message ending
> "raise `samplingDefaults.max_tokens` on the `JudgeModelVersion` for this judge" and said "the fix
> is yours to make, and it is one field". That was wrong twice. (1) On calibration run 9 the five
> `finish_reason: length` failures were a degenerate repetition loop, and raising the budget — the
> advice this section and the message both gave — is what turned run 8's 11,680-char loop at 4096
> tokens into run 9's 56,004-char loop at 12288. (2) "Raise it on the version" invited editing
> `samplingDefaults` in place, which §8.8 already forbids mid-run; the field is a provenance pin and
> the fix is a new ordinal.
````

Then replace every `<FEAT_SHA>` in that block with the Task 3 short sha.

- [ ] **Step 2: README**

**This task owns the stale reference.** `capture-field-gaps` REMOVED its Edit 8b on review and assigned `README.md:594-622` — including the stale `assertUsableContent` `:507-580` reference — to THIS plan (`docs/superpowers/plans/2026-09-01-capture-field-gaps.md:20`, `:72` and `:347`; an earlier revision of this plan cited `:313`, which is that plan's "Step 7: Schema comment" step and has nothing to do with the README — the removed Edit 8b is at `:347`). An earlier draft of this step told the executor to grep for the reference and STOP if it printed; that was a deadlock — neither plan would ever have fixed it. `assertUsableContent` is at `registry.ts:606-647` on `33b7be4` (this plan used to say `:642-683`, a pre-wave-2 number). Re-anchor and fix it here:
```bash
grep -n 'registry.ts:507-580' /root/judge-arena/README.md      # 33b7be4: :598
```
Replace
```markdown
pairwise and respond all inherit it (`assertUsableContent`, `src/lib/llm/registry.ts:507-580`).
```
with
```markdown
pairwise and respond all inherit it (`assertUsableContent` in `src/lib/llm/registry.ts`).
```
Symbol only, no line range — a range goes stale on the next edit to this file, which is how `:507-580` got there. (`README.md` is already in the Step 6 `git add`.)

Then, in the same file, replace `:618-622` (`33b7be4`; match on the quoted text, not the number)
```markdown
It **fails on `'length'` unconditionally, even when the content happens to parse**: a model cut off
mid-reasoning is not a completed judgment for a calibration corpus, however well-formed the prefix
it managed to emit. The error message carries every number needed to size the fix (`max_tokens`,
`completion_tokens`, `reasoning_tokens`, surviving content length) and names the lever —
`samplingDefaults.max_tokens` on the `JudgeModelVersion`.
```
with
```markdown
It **fails on `'length'` unconditionally, even when the content happens to parse**: a model cut off
mid-reasoning is not a completed judgment for a calibration corpus, however well-formed the prefix
it managed to emit. The error message carries every number needed to size the fix (`max_tokens`,
`completion_tokens`, `reasoning_tokens`, surviving content length) and then **says which of two
things happened**. `src/lib/llm/degeneration.ts` deflates each output channel over 8,000 characters
(reasoning always; content only for judgment calls) and, at a ratio of 5× or more, names the
output a **DEGENERATE REPETITION** loop — for which the advice is a repetition penalty, a different
temperature or a different judge, because a larger budget buys a longer loop. Otherwise the lever
is `samplingDefaults.max_tokens` on a **new ordinal** of the `JudgeModelVersion` (the field is a
provenance pin; it is never edited in place). The measure rides on the error as
`ProviderError.repetition`.

> **CORRECTION (2026-09-01).** This section used to end "names the lever —
> `samplingDefaults.max_tokens` on the `JudgeModelVersion`", and the message said exactly that,
> unconditionally. On calibration run 9 (granite4.2:3b) all five `'length'` failures were a
> repetition loop — 26k–56k reasoning characters deflating at 5.2–29× against 3.0–4.1× for the
> judgments that finished — and that advice would have made them worse. The distinction is now
> measured, not assumed.
```

- [ ] **Step 3: Spec §5.4.2**

In `/root/judge-arena/docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md`, replace `:510-511` (`33b7be4`; was `:489-490` before wave 2 — match on the quoted text, not the number)
```markdown
Recorded as a follow-up rather than fixed here: it is a guard change on the `execute()` chokepoint
and wants its own test, not a drive-by edit during a calibration.
```
with
```markdown
~~Recorded as a follow-up rather than fixed here: it is a guard change on the `execute()` chokepoint
and wants its own test, not a drive-by edit during a calibration.~~ **Shipped in `<FEAT_SHA>` (2026-09-01):**
`src/lib/llm/degeneration.ts` measures the deflate ratio of each output channel over 8,000 chars
(reasoning always; content only for judgment calls) and `assertUsableContent` swaps the advice at
≥ 5×, keeping `non_retryable` and stamping the measure on `ProviderError.repetition`. Plan:
`docs/superpowers/plans/2026-09-01-repetition-loop-detector.md`.

> **CORRECTION (2026-09-01).** Two statements above were checked with node `zlib.deflateSync` on
> the same five rows before the threshold was pinned. (1) "It is cycling one clause verbatim … and
> it is all five of them" — four of the five show verbatim cycling (deflate 6.3×, 7.1×, 10.8×,
> 29.3×; repeated 80-char shingles throughout); the fifth (52,702 chars) deflates at 5.23× with **no
> repeated 80-character window** — long-range redundancy, not a verbatim loop. It clears the 5×
> threshold, but only just. (2) "8.23× vs 2.63×" is pglz, not deflate; deflate on the same rows
> reads 5.2–29× (failed) against 3.0–4.1× (five completed rows of the same run) and a population
> max of 5.38× over all 18 completed granite4.2 judgments with ≥ 8k reasoning chars. The
> separation holds for run 9's own rows; the margin between the loosest loop and the most verbose
> completion is thinner than the pglz numbers suggested.
```
Replace `<FEAT_SHA>` with the Task 3 short sha. **Substitute, do not trust, the five measured numbers in that CORRECTION block** — `52,702`, `5.23×`, `5.2–29×`, `3.0–4.1×`, `5.38× over all 18` — with what Task 1 Step 2 and Step 3 actually printed, the same way Task 3 Step 12's commit body is marked. A document whose whole point is correcting wrong claims must not ship a number nobody re-measured. (The values above are the 2026-09-01 measurement and are expected to reproduce; if any of them does not, that is the STOP in Task 1 Step 2, not a silent edit here.)

- [ ] **Step 4: Handoff §7 item 3**

In `/root/judge-arena/docs/superpowers/plans/2026-09-01-scoreboard-handoff.md`, replace `:346-347` (`33b7be4`; was `:334-335` before wave 2 — match on the quoted text, not the number: §5.2 has moved +11 and §7 item 3 +42 across the two waves, so the two cited regions did NOT move by the same amount)
```markdown
3. **Distinguish a repetition loop from a genuine truncation** (§5.2). The guard's advice is
   actively harmful in the loop case.
```
with
```markdown
3. **Distinguish a repetition loop from a genuine truncation** (§5.2). The guard's advice is
   actively harmful in the loop case. **Shipped in `<FEAT_SHA>`** — `src/lib/llm/degeneration.ts`,
   deflate ≥ 5× over ≥ 8,000 chars per channel; see the CORRECTION in spec §5.4.2 for what the
   deflate re-measurement changed about "all five".
```
Replace `<FEAT_SHA>` with the Task 3 short sha.

- [ ] **Step 5: Injection (docs have one too)**

> **CORRECTION (2026-09-02) — the previous version of this step could not fail.** It used a single
> `grep -rn` with three alternatives, one of which was the old MESSAGE BODY:
> `raise samplingDefaults.max_tokens on the JudgeModelVersion for this judge`. That is a PER-LINE
> match, and the sentence is line-WRAPPED in every file that carries it — runbook `:389-390`
> (`… — raise samplingDefaults.max_tokens` / `on the JudgeModelVersion for this judge.`), spec
> `:494-495`, handoff `:235-236`. Run on `33b7be4`, that alternative contributes **zero hits**,
> before OR after the edit. The other two patterns (`names the lever`, `it is one field`) are
> strings the plan itself writes into its new CORRECTION blockquotes, so the step was verifying
> its own new prose, not the removal of the old claim (failure mode A2). The exact surviving wrong
> implementation: the executor rewrites §8.2's prose and adds the CORRECTION but leaves the fenced
> example block at runbook `:386-391` — which shows the old unconditional message as the *current*
> one — in place, or adds the loop example beside it. The grep still prints exactly two hits, both
> on `>` lines, and the step passes green on a runbook that still lies. Fixed below: a whole-file
> multi-line check is now the primary assertion, and there are POSITIVE checks for the new text.

(a) **PRIMARY — the old message body is gone, checked across line breaks.** `grep` cannot do this; the sentence spans two lines in every file that carries it.
```bash
perl -0777 -ne 'print "HIT: $ARGV\n" if /raise samplingDefaults\.max_tokens\s+on the (`)?JudgeModelVersion(`)? for this judge/' \
  /root/judge-arena/README.md /root/judge-arena/docs/runbooks/scoring-a-judge-against-a-golden-set.md
```
Expected AFTER the edit: **no output.** Expected BEFORE the edit (run it first, so you have the red): exactly `HIT: …/scoring-a-judge-against-a-golden-set.md` — verified on `33b7be4`; the README never carried the message body verbatim. The backticked optionals are there so the pattern also catches a re-wrapped variant; note that the plain-text form deliberately does NOT match the runbook's new CORRECTION blockquote, which quotes the old advice as ``raise `samplingDefaults.max_tokens` on the `JudgeModelVersion` for this judge`` — with a backtick immediately after `raise `, so `raise samplingDefaults` never matches there. If this prints a HIT after the edit, a fenced example or a paragraph still presents the old message as current. That is the finding.

(b) **POSITIVE — the new text is actually present in both files.** A deletion that forgot to insert would pass (a) trivially.
```bash
grep -ci 'new ordinal' /root/judge-arena/README.md /root/judge-arena/docs/runbooks/scoring-a-judge-against-a-golden-set.md
grep -c 'DEGENERATE REPETITION' /root/judge-arena/README.md /root/judge-arena/docs/runbooks/scoring-a-judge-against-a-golden-set.md
```
Expected: every count ≥ 1. **`-i` is load-bearing on the first one** — the README writes "**new ordinal**" in lower case and the runbook writes "a NEW ordinal" in upper case, so a case-sensitive `grep -c 'NEW ordinal'` reads 0 for the README and the check would fail on a correct edit. If you reword either document, reword this check with it.

(c) **SECONDARY — the two paraphrases now sit inside CORRECTION blockquotes.** This is the old check, demoted:
```bash
grep -rn "names the lever\|it is one field" /root/judge-arena/README.md /root/judge-arena/docs/runbooks/scoring-a-judge-against-a-golden-set.md
```
Expected: exactly two hits, both on lines starting with `>` — README one (`names the lever`) and the runbook one (`it is one field`, on the `> is yours to make, and it is one field` line). On `33b7be4` before this task the same grep hits **README `:621` and runbook `:400`**, both on non-`>` lines, both inside the ranges Steps 1-2 replace. Any hit on a line not starting with `>` is an un-corrected claim — fix it before committing.

Historical quotes that STAY as they are, because they are logs of what the message said at the time: `docs/superpowers/plans/2026-09-01-scoreboard-handoff.md:235-236` (the two lines inside the fence at `:234-237`, in §5.2) and the spec's occurrences of `raise samplingDefaults`. **Do not trust a number for those** — an earlier revision of this step listed the spec's as `:185/:187/:379/:473`, and on `33b7be4` `grep -n 'raise samplingDefaults' <spec>` returns only **`187` and `494`**. Re-run that grep instead of reading the list.

- [ ] **Step 6: Gates and commit**

**Run `lint` and `tsc` only.** This commit touches five markdown files and nothing else.

```bash
cd /root/judge-arena && npm run lint && npx tsc --noEmit
```
Expected: lint 0 problems, tsc 0.

> **CORRECTION (2026-09-02) — two of the three precedents were misattributed.** An earlier draft of
> this step ran the whole chain and justified it with `60be6f6`'s `Gates: tsc 0, lint 0, 869 unit /
> 670 db / 80 integration, coverage 0.`; a later draft reversed that and cited `5e48187`, `e103d43`
> and `270dc50` as three markdown-only commits carrying a skip note. Checked on `33b7be4`: only
> `5e48187` is both markdown-only (`CONTRIBUTING.md` + `README.md`) and carries a skip note.
> `e103d43` IS markdown-only (three `docs/**` files) but carries a full `Gates: lint 0, tsc 0, 872
> unit / 55 files, 670 db / 46 files, 80 integration / 10 files, coverage 0.` with **no** skip note.
> `270dc50` is **not** markdown-only (it touches `scripts/ci/ci-status.sh`) and also carries full
> counts with no skip note. The two skip notes the earlier draft quoted — "(db and integration not
> run — this change does not touch either suite)" and "(db not run — this change does not touch the
> db suite)" — belong to `80fc4ab` and `20fc4fc`, which are `src/worker` CODE commits that skipped
> suites they could not reach.

**The conclusion is unchanged and now rests on the one commit that actually supports it, plus the arithmetic.** `5e48187` is the markdown-only precedent for `lint` + `tsc` + a skip note. `80fc4ab` and `20fc4fc` are the precedent for skipping a suite a change cannot touch. Re-running `test:db:coverage` to prove that markdown cannot move it costs ~15 minutes, RESETS the database at `.env.test`, and yields zero information. Task 3 Step 11 is where the full chain runs, and it is the run this commit's numbers would have duplicated. This matters more than usual here because **this step `git add`s the plan file itself**, so a wrong precedent claim in it lands in the tree. Then:

```bash
git -C /root/judge-arena add README.md docs/runbooks/scoring-a-judge-against-a-golden-set.md docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md docs/superpowers/plans/2026-09-01-scoreboard-handoff.md docs/superpowers/plans/2026-09-01-repetition-loop-detector.md
git -C /root/judge-arena commit -F - <<'EOF'
docs(llm): the truncation message has two endings now — say so where the old one was quoted

Runbook §8.2, README §"Truncation is now a HARD FAILURE", spec §5.4.2 and
handoff §7 item 3 all quoted or paraphrased the unconditional "raise
samplingDefaults.max_tokens on the JudgeModelVersion" advice as current
fact. Each now shows both messages (loop / genuine truncation), the
8,000-char floor and 5x threshold, the new-ordinal rule, and a CORRECTION
note saying what the old text claimed and why it was wrong — including
the deflate re-measurement finding that one of run 9's five "verbatim"
loops has no repeated 80-char window and clears 5x by 0.23.

Docs only; no code. Refers to <FEAT_SHA>.

Gates: lint 0, tsc 0 (unit/db/integration unchanged by a markdown-only
change; not rerun here — see <FEAT_SHA> for the full chain).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
EOF
git -C /root/judge-arena log -2 --format='%h %s'
git -C /root/judge-arena status --short --untracked-files=no
```
(Replace both `<FEAT_SHA>` before running; this body carries no `<n>`.) Expected: two commits on top of `33b7be4` (or on top of whatever `capture-field-gaps` landed, if it went first); `status --short --untracked-files=no` prints nothing. This plan file is untracked on HEAD, so the `git add` above is what first tracks it and it enters the tree in this docs commit; the other untracked `??` sibling plans stay untracked and are not this plan's concern. Do not push.

---

## Self-review

**Spec coverage.** Handoff §5.2 / §7 #3 asks for the loop-vs-truncation distinction at the `execute()` chokepoint with its own test → Tasks 2–3. Binding decision (1) measurement first → Task 1. (2) module shape, constants, per-channel, never-concatenate, content only in judgment mode → Task 2 Step 4 and the INDEPENDENTLY / CONCATENATES / respond-mode cases. (3) `repetition` on `ProviderErrorOptions`/`ProviderError`, type-only import, never set by classify → Task 3 Step 3 and the classify-passthrough case. (4) `facts` byte-identical, advice swap, kind unchanged, measure attached, new-ordinal wording → Task 3 Step 4 and the PRODUCTION SHAPE / REGRESSION cases. (5) fixtures module not collected, LOOP_CLAUSE from spec §5.4.2 (cited by heading, no line range), numbered variant, seeded negative at 44–56k, detect/undetect assertions only, loop cases in llm-truncation.test.ts, pure cases import-free, injection 1_000 → Task 2 Steps 1–2 and 6. (6) runbook §8.2, README, spec §5.4.2, handoff §7 #3 with CORRECTION notes → Task 4. Not cited anywhere: the granite4.1 bit-identical result. Not done, on purpose (from the `verify.corrections` / `q4_wrongApproach[5]` inputs, now folded in here because the scratch files are gone — see the **Spec** bullet): no barrel export, no schema column, no run.ts change, no success-path detection (the healthy-call case in Task 3 Step 1(c) owns one assertion — 44k of compressible content at `finish_reason: 'stop'` is RETURNED, not thrown — and Injection D in Task 3 Step 9 is now a plausible wrong implementation that makes it red, `if (!truncated && !empty && !loop) return;`, run against the WHOLE unit suite with its collision set stated; the PLACEMENT of the detector call remains a cost decision enforced by review, not by a test, and that step says so), and no `failureShape` discriminant. **Changed in revision round 2:** the content-channel negative case IS now built from structured JSON. The earlier draft declined it on the grounds that an 8k+ JSON criteria array "would be flagged anyway"; that was an untested inference, and declining to write the test that might fail is the anti-pattern CONTRIBUTING.md:210-234 exists for. It was measured instead, on the real shape (`JUDGMENT_JSON_SCHEMA`: prose lives in one top-level `reasoning` string, `criteriaScores` entries carry none) — 3.02-3.45x from 9k to 57k chars at 5-20 criteria, i.e. safely under the threshold at every rubric that ships (`prisma/seed-core.ts:300`: one rubric, five criteria) — so the channel is KEPT and `judgmentJson()` is the negative fixture. The ratio does cross 5x at ~60 criteria with a terse rationale (6.10x); that boundary is recorded in the fixture header, in the `degeneration.ts` docblock, and in the commit body, together with the remedy the docblock already prescribed (drop the channel, do not raise the threshold). The content channel's LENGTH FLOOR is now pinned as well (Task 2 Step 2, "the CONTENT floor is inclusive at exactly 8,000 chars too") — without it `mode === 'judgment' && result.text.length > 0` passed every test in both suites and coverage still read 100/100/100/100. README `:598` — the stale `assertUsableContent` `registry.ts:507-580` reference — IS edited here: `capture-field-gaps` removed its Edit 8b on review and assigned `README.md:594-622` to this plan (that plan's `:20`, `:72`, `:347`), so Task 4 Step 2 fixes it to a symbol-only citation instead of grepping and stopping.

**Changed in revision round 3 (2026-09-02), after two waves landed.** (a) Every baseline and Gates number was pre-wave-2 and one was an ABSOLUTE ("db 670 / 46 files") that would have read as a 4-test regression on a correct run, or been copied into a commit as a number nobody measured; all of them are now stated against the measured **888 / 57, 674 / 46, 82 / 11** and every db/integration expectation is "unchanged from Task 1 Step 4", never a literal. (b) The `Depends on` header claimed `calibration-sampling-snapshot` had not landed and predicted a −45 shift; it landed as `a96cf94` + `33b7be4` and the shift is **−36** — a CORRECTION note records that rather than overwriting it, and all four registry.ts numbers plus the four doc anchors are re-measured. Every `old_string` in the plan was re-checked byte-for-byte against `33b7be4` and still matches, so this was anchor rot in the prose only. (c) Task 4 Step 5's docs injection could not fail: its only pattern aimed at the old message was a per-line `grep` for a sentence that is line-wrapped in every file carrying it, and the two patterns that could fire matched the plan's own new prose. It is now a whole-file `perl -0777` check plus positive checks for the new text, with the old two-hit grep demoted to a secondary. (d) Three assertions had no injection behind them (failure mode 5) and now do: `measureRepetition`'s chars/bytes contract (Task 2 Injection D), the `>=` ratio boundary — extracted into `isLoopRatio` so it is pinnable at all (Task 2 Injection E), and the chars-not-bytes RENDERING of the advice (Task 3 Injection E). (e) The coverage comparator was the `src/lib/llm` aggregate, which cannot detect a drop in `registry.ts` when a new file joins the same denominator at 100/100/100/100 — it is now the per-file `registry.ts` and `degeneration.ts` rows. (f) The content channel's judgment-mode gate has TWO seams, not one (`registry.ts:1129` pointwise and `:1212` pairwise); the pairwise shape is now measured (3.17x at 20,158 chars) and asserted, and Task 1 Step 3 scans production `rawResponse` and rubric sizes so the channel stops resting on a synthetic fixture. (g) Two numbers in the module docblock and the commit body ("a 400-object JSON array 13.9x, a 300-row markdown table 8.3x") were asserted with no generator, seed or shape recorded and could not be re-derived; every other number in the plan reproduces exactly (re-run 2026-09-02: all 23 fixture ratios to two decimals), so those two are removed rather than pinned. (h) Task 4 Step 6 misattributed two of three markdown-only precedents; corrected with the evidence. (i) The `LOOP_CLAUSE` docblock committed a spec line range that had already gone stale twice; it now cites the section heading, which is the rule this plan already applies to `README.md:598`.

**Placeholder scan.** The only bracketed values are `<FEAT_SHA>`, `<n>`, `<x>`, `<chars>`, `<content-scan>`, `<judgment-id>` (in the runbook's after-the-fact query, which is a template for the operator and stays as a placeholder) and the `<PASTE the ten Task 1 Step 2 lines here, verbatim>` marker in Task 3 Step 12's commit body, each with an explicit instruction to substitute a value produced by an earlier step of the same plan; **N** / **F** / **C** / **D** (unit test count, test-file count, per-file `registry.ts` + `degeneration.ts` unit-coverage rows, db-run aggregate coverage row) are recorded in Task 1 Step 4 and every later count is stated as an offset from them, with the `33b7be4` value alongside as an illustration only. Every code block is complete and was executed (the detector and fixture bodies through node, byte-for-byte modulo type annotations — including `judgmentJson`, whose ten measured rows are in the fixture header) before being written here. The Task 2 Step 3 failure text is **vite 7.3.1's** `Failed to load url … Does the file exist?` shape, not node's `Cannot find module` (template in `node_modules/vite/dist/node/chunks/config.js`; vitest 3.2.4 bundles vite 7.3.1 and neither `vitest/dist` nor `vite-node/dist` contains the string `Cannot find module`); treat the wording as indicative and confirm the exact text when the step runs. The failure texts quoted for `toBeDefined()` / `toBeUndefined()` / `toMatchObject()` are `@vitest/expect/dist/index.js`'s own templates (`:1246`, `:1148`).

**Type consistency.** `RepetitionMeasure { chars; bytes; compressedBytes; ratio; channel: 'reasoning' | 'content' }` is identical in Task 2 Interfaces, Task 2 Step 4, Task 3 Step 3 and Task 3 Step 4 (`loop.ratio`, `loop.chars`, `loop.channel`). `isLoopRatio(ratio: number): boolean` appears in Task 2 Interfaces, in Task 2 Step 4 (declaration and both call sites), in the Step 2 test import and in Task 2 Injection E. `detectRepetitionLoop(result, mode?)` takes `ExecuteRequest['mode']` exactly (`'judgment' | 'respond' | undefined`). Fixture names `legitLong` / `loopPure` / `loopAfterPrefix` / `loopNumbered` / `judgmentJson` / `LOOP_CLAUSE` match between the module, degeneration.test.ts and the llm-truncation import (`judgmentJson` is used by degeneration.test.ts only; llm-truncation imports `legitLong` / `loopAfterPrefix` / `loopPure`).

**Counts (all illustrations; the printed number wins).** Test counts: 18 pure + 11 execute-level = **29 new**. `degeneration.test.ts` holds 18 `it` blocks — the `isLoopRatio` boundary and the pairwise-payload negative are extra ASSERTIONS inside two existing cases, deliberately, so no arithmetic below moves. On the measured `33b7be4` baseline (888 unit / 57 files) that renders **917 across 58** after Task 3 and **906 across 58** after Task 2; `llm-truncation.test.ts` has 22 tests today (verified: 530 lines, 22 `it` blocks) so it reads 33 after Task 3, of which 9 of the 11 new cases are red on HEAD and the RESPOND-mode and healthy-call cases are green by design — they are the Injection B and Injection D discriminators. **db (674 / 46 files) and integration (82 / 11 files) are unchanged by this plan and are to be reported as "unchanged from Task 1 Step 4", never as literals.** Injection tallies: Task 2 A 10 red / 8 green, B 4 red, C 3 red, D 1 red, E 1 red; Task 3 A 8 red, B 1 red, C 6 red, D 1 red (whole-suite), E 1 red. Every `git status` expectation uses `--untracked-files=no` because the 2026-09-01 sibling plans (this one included) are untracked on HEAD.

**What is still NOT pinned by a test, stated so review must state it too.** (1) The PLACEMENT of the `detectRepetitionLoop` call above vs. below the early return — pure and side-effect-free, so hoisting it leaves the suite green; it is a cost decision enforced by the comment on it (Task 3 Injection D says this explicitly). (2) Threshold 5 sits below the completed-population max of 5.38×, so a verbose-but-genuine truncation at 30k+ characters with the same compressibility profile could be told "loop". The detector never runs on a completed row, so there is no production instance, and the runbook §8.2 text written in Task 4 Step 1 now carries the one query that distinguishes the two after the fact (a repeated 80-character window). If the owner prefers to close this in code rather than in the runbook, the shingle scan Task 1 Step 3 already computes is the second gate to add — that is a scope change, not a fix to slip in.
