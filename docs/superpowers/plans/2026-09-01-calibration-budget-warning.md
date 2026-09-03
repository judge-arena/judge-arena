# Calibration Budget Warning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At calibration launch, warn (never refuse) when the effective `max_tokens` cannot be produced inside the hard cap at the judge's measured throughput — the "two stacked limits" check of runbook §8.6, as code.

**Architecture:** Two pure additions to `src/lib/calibration/latency.ts` — `judgeThroughputEstimate` (pooled `Σ accountTokens(row).estimatedGeneratedTokens / Σ (latencyMs / 1000)` over a judge's *completed* judgments, via `accountTokens` from `@/lib/calibration/token-accounting` — **never** raw `Σ outputTokens / Σ latencyMs`, because `ModelJudgment.outputTokens` (`usage.completion_tokens` verbatim) omits the reasoning channel on some models when the request carried `response_format: json_schema`, which the judge path always does (token-accounting.ts's module doc) — `null` when there are none, following `judgeLatencyBaseline`'s null-not-zero contract) and `budgetWarningFor` (the rule `max_tokens / tok_per_s > hardCap` rendered as one operator sentence that states the estimate is a LOWER bound). `launchCalibrationRun` calls them on either side of its header transaction: the QUERY runs BEFORE the freeze (it needs nothing from the header, and no advisory check may add a way to throw between the irreversible header commit and the item loop — launch.ts:33-37), the pure RULE runs after, because it reads the RESOLVED `samplingParams` snapshot v2k added. It logs a `logger.warn` (asserted by a spy in the db test — that log is the feature's only durable record) and returns `budgetWarning: string | null` on `CalibrationLaunchResult`; `scripts/calibration/run.ts` prints it under the launch line. Scope, stated because a partial rollout looks live: calibration launch only — not `--score-only`, not the API's single/bulk run launches. The rule lives in `src/lib` (not in `launch.ts`) so it is unit-testable without importing the DB-dependent launch module into the unit coverage denominator.

**Tech Stack:** TypeScript, Prisma (`ModelJudgment.outputTokens` / `latencyMs`, both `Int?`; `reasoningContent String?`), vitest (unit: `tests/lib`, db: `tests/db`), the existing `resolveTimeoutBudgets()` from `src/lib/llm/timeout-policy.ts`, and `accountTokens` from `src/lib/calibration/token-accounting.ts` (already landed — see the new Depends-on line below).

**Spec:**
- Handoff: `/root/judge-arena/docs/superpowers/plans/2026-09-01-scoreboard-handoff.md` §8 ("`max_tokens / tok_per_s` must fit under the 900 s hard cap … treat the linear estimate as a lower bound", lines **421-424**; RE-VERIFIED 2026-09-02 on `33b7be4` (post-v2k) — §8 itself begins at **:381**. **CORRECTION:** the round-1 figures `403-406` / `§8 begins at :369` were measured on `5e48187`; v2k's a96cf94/33b7be4 added CORRECTION notes to the handoff and pushed §8 down by 12 lines. The pre-Wave-1 figure 364-367 is stale twice over.).
- Register item: `/root/judge-arena/docs/superpowers/plans/2026-08-30-state-and-next-steps.md` §5.6/8, lines **438-442** ("the check wants to be code"; `432-436` was the pre-v2k figure — the register gained a CORRECTION note in v2k. Task 4 anchors on the quoted text, not the number).
- Runbook: `/root/judge-arena/docs/runbooks/scoring-a-judge-against-a-golden-set.md` §8.6, lines 461-492 (the manual arithmetic this automates).
- Scoreboard spec §2.1 / §5.4.1 (`docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md`, lines 109-131 and **419-431**; RE-VERIFIED 2026-09-02 on `33b7be4` — §5.4.1's heading is at **:419** and its per-length table at **:423-426**. **CORRECTION:** round 1 said `398-414` / heading `:398` / table `:402-405`; those were `5e48187` figures and v2k's CORRECTION note to the spec moved them ~21 lines down. §2.1's table at :115-120 has NOT moved): the envelopes and the decay-with-length finding.
- Verified map / cross-item corrections (q1 U1 is the binding shape; q3 orders this after #1): these were `/tmp/ja-plan-inputs/product-health-facts.json` and `/tmp/ja-plan-inputs/critique.json`, which are **authoring scratch and no longer on disk** (`ls /tmp/ja-plan-inputs` → no such directory, 2026-09-02). Nothing here depends on reading them: the binding U1 shape is restated verbatim in Task 1 **Interfaces** and in Self-review #1.

**Priority / wave:** Wave 2 / #6 (S).

**Depends on:** `calibration-sampling-snapshot` (this plan consumes `CalibrationLaunchResult.samplingParams: SamplingParams` and the `samplingParams` value returned from the header `$transaction` in `launchCalibrationRun`, plus the `samplingDefaults` option on `tests/db/calibration-link.test.ts`'s `mkWorld`/`mkJudgeVersionWithEndpoint`). Task 3 opens with a pre-flight that refuses to proceed if those are not in the tree. **Also `token-accounting` (commits `e438da2`, `0bd6b6b`, `db5bff9` — already landed on `main` as of this revision), and this plan MUST execute after it, not before.** Round 3 of this plan (below) shipped `judgeThroughputEstimate` specified as pooled `Σ outputTokens / Σ latencyMs`. That is the exact defect `token-accounting` fixed hours later: `ModelJudgment.outputTokens` is `usage.completion_tokens` verbatim, and under `response_format: json_schema` — the path the judge always runs — some models (measured: qwen3.5:9b) omit the reasoning channel from that count entirely, so the raw formula understates their throughput by roughly 20x. `src/lib/calibration/token-accounting.ts` already exports the fix as `accountTokens()`, `CHARS_PER_TOKEN`, `REASONING_EXCLUDED_RATIO` and the `TokenAccounting` type; Round 4 (below, and Tasks 1-4) re-specifies this plan to consume it rather than to reintroduce the bug it fixes. Task 1 Step 0 (new) is a pre-flight that refuses to proceed if `token-accounting.ts` is not in the tree, mirroring Task 3 Step 0's existing pre-flight for the sampling-snapshot dependency.

**Owner decisions needed:** ONE — see the db-coverage fact below (Facts, last bullet). Task 3 makes the db run **LOAD** `src/lib/calibration/latency.ts` for the first time — the file is ALREADY in the db denominator, but only as v8's `1/1` not-imported artifact (Facts, last bullet) — which replaces that artifact with ~67 real branches at ~18 hit and drops the all-files BRANCHES aggregate from a **measured 77.84% (1001/1286 on `33b7be4`, aggregated from `coverage-db/lcov.info`)** to ~**75.30% (1018/1352)**, below the `branches: 77` floor at `vitest.db.config.ts:152`. The floor must NOT be lowered to make it green. The owner picks one BEFORE Task 3 runs:

- **(a) Exclude the file from the db run's coverage.** Add `'src/lib/calibration/latency.ts'` to `vitest.db.config.ts`'s `coverage.exclude` array (`vitest.db.config.ts:36-41`) — the same class of entry as the existing `src/lib/db.ts` / `src/lib/env.ts` / `src/lib/logger.ts`, justified because the db run only LOADS this module transitively (via `launch.ts`) and never exercises it, while the unit run covers it `130/130` lines, `50/50` branches, `7/7` functions (`coverage/lcov.info`, measured 2026-09-02 on `33b7be4`). This weakens nothing: the module's real gate is the unit run, where it is at 100%. **(a) has been ARITHMETICALLY CHECKED against the real `coverage-db/lcov.info`, so it is not a guess:** excluding the file leaves branches **1000/1285 = 77.82%** (floor 77), functions **269/419 = 64.20%** (floor 60) and lines **4745/9165 = 51.77%** (floor 47, and it RISES) — all four db floors stay green. See the db-coverage bullet in Facts.
  **If (a) is chosen, the entry does NOT go in bare.** `vitest.db.config.ts`'s four existing entries carry no comment (they are self-evident infrastructure: `db.ts`, `*.test.ts`, `env.ts`, `logger.ts`), but this one is not — a fully DB-relevant module excluded from the DB gate with no reason recorded is a trap for the next reader. Write it in the style the SIBLING config uses for exactly this situation (`vitest.config.ts:41-44`, the block comment above `src/lib/auth.ts` … `src/lib/audit.ts`): a comment stating (i) that the db run only LOADS the module transitively via `launch.ts` and never exercises it, (ii) that its real gate is the unit run, where it measures `130/130` lines and `50/50` branches, and (iii) the date and SHA of that measurement (`2026-09-02`, `33b7be4` — NOT `5e48187`, which is what an earlier draft of this plan said; the lcov on disk was produced after v2k landed). Task 3's commit body must carry the same sentence.
- **(b) Re-baseline the db floors** by `vitest.db.config.ts`'s own documented procedure (three runs, take the lowest, apply the 2pp aggregate buffer). That is a floor MOVE and therefore an owner decision, never an executor's.
- **(c) Restructure so the db run does not load the whole module:** put `judgeThroughputEstimate` / `budgetWarningFor` / `summarizeThroughput` in their own leaf file (e.g. `src/lib/calibration/throughput.ts`, importing `formatDurationMs` from `latency.ts` — which would still drag `latency.ts` in, so this only works if `formatDurationMs` moves too or is duplicated). Costs more churn than (a) and changes every file path in Tasks 1-2; listed for completeness.

Task 3 does NOT proceed until this is decided.

**CAVEAT added in round 4, and it does not change the decision above, only its inputs.** Every branch/line/function count in this section (and in the "Db coverage direction" Facts bullet below) was measured against the round-3 shape of `judgeThroughputEstimate`/`summarizeThroughput` — pooled raw `outputTokens`, no `accountTokens` call, no `reasoningContent` column. Round 4 adds an `accountTokens(...)` call, an extra `select` column and an extra guard branch to `summarizeThroughput`, so `latency.ts`'s real branch/function/line totals are now a few units HIGHER than every number quoted below (the unit-run `50/50` branches, `130/130` lines, `7/7` functions; the ~67-branch/~18-hit estimate for the db aggregate). The DIRECTION of the conclusion (option (a) passes, do-nothing fails by ~1.7pp) is not sensitive to a few extra always-covered lines, but the exact figures are now a lower bound, not a measurement. This was already Task 3 Step 6's own policy ("Task 3 Step 6 still re-measures for real before anything is committed") — round 4 does not change that policy, it just means the pre-measurement below is one revision further from ground truth than round 3's was. Do not hand-recompute these lcov numbers from the diff; run the coverage command and read what it prints.

## Global Constraints

- Repo: /root/judge-arena (Next.js 15.5.22, TypeScript, Prisma on Postgres — Json maps to JSONB —, amqplib 2.0.1, vitest). Node >= 22. Always use `git -C /root/judge-arena` (handoff trap 2: a stale `cd` once hard-reset the wrong repo).
- Gates, in this order, all must be clean before every commit: `npm run lint` (0 warnings) → `npx tsc --noEmit` → `npm run test:coverage` (unit; per-glob floors in vitest.config.ts:187-220 — NEVER lower a floor; if a new test import drags a module into a denominator, mock the seam as tests/lib/judgment-consumer-escalation.test.ts:41-69 does) → `npm run test:db:coverage` (RESETS the database at .env.test — verified today to be localhost:5432, the local podman `judge-arena-pg`, NOT the k8s `judge-arena-pg-1`; re-confirm with `grep DATABASE_URL /root/judge-arena/.env.test` before the first run) → `npm run test:integration` → `npm run build`. Baseline **measured 2026-09-02 on `5e48187`**: **877 unit / 55 files; 670 db / 46 files; 82 integration / 11 files.** The pre-Wave-1 figures this plan was written against (869 unit / 80 integration on `fc9e936`) are STALE — Wave 1 landed nine commits after this plan was authored: `7e769c1` added tests to `tests/lib/llm-index.test.ts`, and `80fc4ab`/`20fc4fc` raised `tests/lib/worker-health.test.ts` 30 → 35 and added `tests/integration/consumer-loss-epoch.test.ts`. This plan runs AFTER `calibration-sampling-snapshot`, which adds **+10 unit / +4 db** (its FINAL gate line reads **887 unit / 674 db** — its own `:1421`, and its count arithmetic at `:1450` spells it out: `877 + 2 + 8` unit and `670 + 4` db, both already Wave-1-corrected. Its Task-1 gate line `879 unit / 670 db` (`:339`) is that plan's FIRST commit, not its end state; the figure **673 appears nowhere in it**). **CORRECTION (round 3, and it is a MEASUREMENT, not arithmetic — failure mode 15):** that derivation (877 + "+10") is wrong by one. `calibration-sampling-snapshot` landed as `a96cf94` + `33b7be4` (v2k) and contributed **+11 unit**, not +10 — it added `tests/lib/sampling.test.ts` AND `tests/lib/calibration-sampling-drift.test.ts`, two new files, not one. Measured on `33b7be4` with the full chain: **888 unit / 57 files; 674 db / 46 files; 82 integration / 11 files.** So the baseline this plan starts from is **888 unit / 57 files, 674 db / 46 files, 82 integration / 11 files** — the db and integration halves of the round-2 figure were right; only the unit count was not. Every `Gates:` line below is filled from the printed counts, never copied from here. **And the converse rule, because a guide number that is off by one manufactures a phantom regression:** if a printed count is not the number the step predicts, STOP and explain the delta before writing anything into a commit body — do not copy the prediction, and do not copy the print without accounting for the difference. **Three tasks deviate from the six-gate chain and each says so at its own Step 6, with the reason and the re-check that must hold first:** Tasks 1 and 2 (pure additive exports to a module `tests/db/**` provably cannot reach) and Task 4 (docs only). Task 3 runs the full chain. CONTRIBUTING.md:1639 states the chain as a rule to run before **pushing**; the operator's pre-push run is the backstop, and nothing here weakens it.
- The local test DB is SHARED with anything else running vitest on this workstation (sibling plan's facts table, reproduced 2026-09-01 21:15): a concurrent vitest process turns `tests/db/calibration-link.test.ts` into `40P01 deadlock detected` / `Unique constraint failed on (slug)` failures with nothing wrong. Before EVERY db or integration run, `pgrep -af "[v]itest"` must print NOTHING (the bracket stops pgrep matching its own command line).
- TDD with an INJECTION step (CONTRIBUTING.md:210-234): every behaviour test must be shown to go RED by a deliberate breakage of the implementation and GREEN again after; a test that stays green after injection is a finding. Each task's steps must include the injection.
- One concern per commit/PR (CONTRIBUTING.md:1639 — re-verified 2026-09-02; Wave 1's CONTRIBUTING.md rewrite at :1221-1247 shifted everything below, so the pre-Wave-1 citation :1560 now lands in a `prisma db push --schema` trap). Wrong statements in docs get an explicit CORRECTION note, never a silent overwrite (CONTRIBUTING.md:1653-1656, "say that it was wrong and what it said" — the pre-Wave-1 citation :1571-1574 now lands in the coverage-thresholds paragraph). CONTRIBUTING.md:210-234 (the TDD/injection rule cited below) is UNSHIFTED and still correct — verified.
- Commit subject: `type(scope): lowercase summary` (feat/fix/docs/ci; scopes seen: worker, llm, queue, calibration, ci, docker). Body: narrative, then a `Gates: lint 0, tsc 0, <n> unit / <n> db / <n> integration, coverage 0.` line, then EXACTLY these trailers:
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
- Commit LOCALLY only. Never push, never promote; the operator does that (push-to-main fires CI and builds an image; promotion is a separate homelab-setup PR).
- Migration naming: `prisma/migrations/<YYYYMMDDHHMMSS>_v2<letter>_<snake>/migration.sql`, timestamp must sort after **20260901180000** (v2k, `20260901180000_v2k_calibration_sampling_snapshot`, APPLIED to the test DB — the next free letter is **v2l**; the round-2 text said "after 20260901000000 (v2j)", which would have collided); narrative `-- v2x — ...` header in the v2i/v2j style; ZERO hand edits (content must equal what `prisma migrate diff` emits), then `npx prisma generate`. **This plan requires NO migration and must not create one.** `CalibrationRun.samplingParams Json?` already exists (`prisma/schema.prisma:937`, v2k) — do not re-add it — and the launch reads the header snapshot it returns, never a join to `JudgeModelVersion.samplingDefaults`.
- GREP TRAP live in HEAD: /root/judge-arena/src/lib/calibration/readings.ts:164 and /root/judge-arena/scripts/importer/reconcile.ts:294 contain a deliberate NUL byte; plain grep returns nothing for those files. Use `grep -a`. NEVER remove the NUL.
- Production is sha-d21f31d47c35; main is now **`5e48187`** — Wave 1 put nine commits on top of `fc9e936`, and they are NOT docs-only: they change `src/lib/llm/index.ts`, `src/lib/llm/resilience.ts` (`defaultIsRetryable` is now exported), `src/worker/health.ts`, `src/worker/main.ts`, and add `scripts/ci/assert-harbor-tag.sh` / `scripts/ci/ci-status.sh`. None of them touch `src/lib/calibration/**`, `scripts/calibration/**` or the two test files this plan edits — verified with `git -C /root/judge-arena diff --stat fc9e936..5e48187`. Do not touch homelab-setup from a judge-arena task except where the plan explicitly says "separate PR in /root/homelab-setup".
- Any cluster/DB access in a plan step is READ-ONLY (psql SELECT, kubectl get/logs, rabbitmqctl list_queues). No requeue-peeks of judge.dlq (quorum delivery_limit 20 — every peek burns one).

---

## Facts this plan is built on (verified 2026-09-01 against `fc9e936`; RE-VERIFIED 2026-09-02 against `5e48187`, and again against `33b7be4` after v2k)

> **Anchors, re-opened on `33b7be4` (post-v2k).** **CORRECTION to the round-2 header, which claimed "every code anchor below was re-opened on `5e48187` and still holds":** that was true when written and is now false for `launch.ts`, `run.ts` and `tests/db/calibration-link.test.ts`, because v2k (`a96cf94` + `33b7be4`) rewrote all three. Every task step below anchors on QUOTED TEXT, so nothing breaks — but navigate by the text, never by these numbers.
>
> UNCHANGED and re-verified: `latency.ts:145 / :162-177 / :179 / :204-209`, `schema.prisma:499` (`latencyMs`) / `:502` (`outputTokens`), `tests/lib/calibration-latency.test.ts:47 / :49-58 / :65-69 / :95 / :316` (27 `it(` blocks), `env.ts:111`, `timeout-policy.ts:94` (`MAX_HARD_CAP_MS = 1_170_000`) / `:149-154`, `seed-core.ts:223-229`, `vitest.db.config.ts:36-41` (`coverage.exclude`) and `:149-156` (floors, `branches: 77` at `:152`), `vitest.config.ts:37 / :41-44 / :187-220 / :188-191 / :196-199`, runbook `§8.6 :461-492` with the "Get `tok_per_s`…" paragraph at `:485-487` and `**Recognising which limit you hit:**` at `:489` and §8.7 at `:494`, and — exactly as this plan predicted it would be — `registry.ts:637` for the "raise samplingDefaults.max_tokens" advice.
>
> MOVED by v2k, corrected here: `launch.ts` `CalibrationLaunchResult` **:88-110** (was :81-96; `frozeGoldenSet` is :102, `samplingParams` :109), `launchCalibrationRun` **:157-462** (was :143-420), `requireOwnedActiveEndpoints` **:241** (was :227), the batch deadline **:312-314** (was :298-300), the `// ── The irreversible write` banner **:316**, the header `$transaction` **:330-371** (was :316-331), the post-freeze `logger.info` **:373-379**, the `// ── One item, one launch` banner **:381** (was :340), the return literal **:455-461** (was :414-419); `run.ts` the sole `launchCalibrationRun` call **:219** (was :205), the per-item failure loop **:231** and the `Nothing was accepted` throw **:232** (was :215-216); `tests/db/calibration-link.test.ts` is **604** lines with **17** `it(` blocks, `mkWorld` **:153-168** (was :134-147), `noopPublish` **:173** (was :152), `launchParamsFrom` **:175-183** (was :154-162), the describe title now `'v2i calibration ⇄ golden item link + v2k sampling snapshot (DB)'` and the two `src/worker/reaper.ts` comments at **:30** and **:339**; register item 8 at **:438-442** (was :432-436 — the plan predicted this move and Task 4 anchors on text). Wave 1's and v2k's inserts into the runbook landed BELOW the anchors Task 4 edits, so Task 4's runbook anchors did not move.

- `verify.ts` probes with `samplingParams { temperature: 0, max_tokens: 1 }`, so tok/s can NOT come from endpoint verification; one token is not a rate. The only source is `ModelJudgment.outputTokens` / `latencyMs` / `reasoningContent` history (schema.prisma:502, :499 and :519 respectively — `outputTokens`/`latencyMs` are `Int?`, `reasoningContent` is `String?`). **CORRECTION (round 4): `outputTokens` / `latencyMs` alone is NOT enough.** `outputTokens` is `usage.completion_tokens` verbatim (`src/lib/llm/openai-compatible.ts:260`), and on some models it does not count the reasoning channel at all when the request carries `response_format: json_schema` — which the judge path always sends (`openai-compatible.ts:210-212`, `ollamaStructuredRequestFields`/`llamacppStructuredRequestFields`). `src/lib/calibration/token-accounting.ts` (already landed — `e438da2`/`0bd6b6b`/`db5bff9`) is the primitive that tells the two cases apart per row and derives the true generated-token count; `judgeThroughputEstimate` reads `reasoningContent` too and pools through `accountTokens()`, never raw `outputTokens`.
- `judgeLatencyBaseline` (`src/lib/calibration/latency.ts:162-177`) selects `latencyMs` over `status: 'completed'` only and returns `null` for an empty sample (the null-not-zero contract, module doc :17-27). The new estimate copies that shape exactly.
- `launchCalibrationRun` (`src/lib/calibration/launch.ts:157-462`): pre-flight ends at `requireOwnedActiveEndpoints` (:241); the batch deadline (:312-314) already reads `resolveTimeoutBudgets().hardCapMs` (`src/lib/llm/timeout-policy.ts:149-154`, default 900 000 ms, `Math.max(hardCap, initialBudget)`); the `// ── The irreversible write` banner is :316; the header `$transaction` is :330-371, followed by the post-freeze `logger.info` at :373-379; the item loop starts at the `// ── One item, one launch` comment (:381); the return literal is :455-461.
- **The module's own ordering discipline, quoted, because Task 3 obeys it:** `launch.ts:33-37` — "EVERYTHING KNOWABLE UP FRONT IS CHECKED BEFORE THE FREEZE … The `CalibrationRun` header is written LAST, after every refusal that does not require touching an item, because writing it is irreversible." A new `await` placed BETWEEN the header commit and the item loop is a new way to launch zero items against a frozen set and a committed header, which is why Task 3 puts the throughput QUERY before the transaction and only the pure rule after it.
- Post-`calibration-sampling-snapshot`, the transaction returns `samplingParams` (the value of `effectiveSamplingParams(version.samplingDefaults)`, type `SamplingParams = { temperature: number; max_tokens: number }` from `src/lib/llm/sampling.ts`), `CalibrationLaunchResult` carries `samplingParams: SamplingParams`, and the return literal includes `samplingParams`. This plan reads `samplingParams.max_tokens` — the EFFECTIVE budget, never the raw nullable `samplingDefaults`.
- `formatDurationMs` (`latency.ts:204-209`) renders `1_024_000` as `17m4s` (it rounds to whole seconds first: `Math.round(1024.0) = 1024`, and `1024 = 17×60 + 4`), `900_000` as `15m0s`, `60_000` as `1m0s` and `0` as `0ms` — the four strings the tests pin. It has no hours unit, which is why the 6 144 000 ms db fixture renders `102m24s`. **CORRECTION (round 4):** round 3 quoted `1_032_605` → `17m13s`, from the pre-`token-accounting` "qwen3.5:9b measured at 11.9 tok/s" figure. That figure is superseded — see the Facts bullet below and Revision round 4 — and no test in this plan asserts `17m13s` any more.
- `tests/lib/calibration-latency.test.ts` mocks `@/lib/db` at :47 (`vi.hoisted` at :42); its `fakeJudgeClient` (:82-100) honours `where.judgeModelVersionId` and `where.status` behaviourally and maps rows to `{ latencyMs }` at :95 — Task 1 widens that map to carry `outputTokens`. Baseline: 27 tests in this file.
- `tests/db/calibration-link.test.ts` drives the real `launchCalibrationRun` with `{ publish: noopPublish }` (**:173**) against Postgres; `mkWorld` is **:153-168** and already accepts `samplingDefaults` (v2k landed it); `launchParamsFrom` **:175-183**; the file is **604** lines and its last test (`a PARTIAL samplingDefaults is resolved field-by-field …`) starts at **:585**. It already imports `resolveTimeoutBudgets` (:7) and `effectiveSamplingParams` (:6), but NOT `vi` and NOT `logger` — Task 3 Step 1 adds both. It holds **17** `it(` blocks on HEAD (`grep -c "^\s*it(" tests/db/calibration-link.test.ts`, measured on `33b7be4`): the 13 that predate v2k plus the **4** (its block "(4) The sampling snapshot" holds four `it(` blocks — that plan's `:484`, `:498`, `:521`, `:531`; its Task 3 step at `:802` states it verbatim: "674 tests pass (670 + 4), including all 17 in `tests/db/calibration-link.test.ts`"), so this plan starts from **17** and ends at **21**. Read the count vitest prints rather than trusting these numbers.
- Doc-line drift from the dependency: `calibration-sampling-snapshot` inserts lines after `2026-08-30-state-and-next-steps.md:423` (register §5.6 #6) and edits the runbook at :534-537 (§8.8), and `calibration-constant-baseline` (Wave 2 #5) appends a DONE note to register §5.6 **#7** (`:425-430` on HEAD — its own Task 3 Step 7 and its Files list at `:1059`), also ABOVE item 8, so item 8 can move TWICE, not once. Register item 8 (":432-436" on HEAD) will therefore sit a few lines lower when Task 4 runs; the runbook §8.6 paragraph (:485-487) is ABOVE §8.8 and does not move. Task 4 anchors on text, not numbers.
- `scripts/calibration/run.ts` prints the launch block at :219-232 post-v2k; the line after the per-item failure loop (**:231**) and before the `Nothing was accepted` throw (**:232**) is where the warning goes. This script is outside every coverage `include` (vitest.config.ts:37) and has no tests.
- **`scripts/calibration/run.ts` has a SECOND operator entry point, and this plan deliberately does not reach it.** `--score-only=<id>` (`:154`, `:162-171`) skips the launch entirely, reads `CalibrationRun.samplingParams` off the header (`select: { samplingParams: true }`, :165-168) and prints `sampling ${describeSamplingSnapshot(headerSampling)}` before dropping into the same poll loop. That is the path an operator uses on a run that has ALREADY stalled at the cap — the moment the warning would be most useful — and it will print the snapshot with no budget check beside it. Scope decision, recorded rather than left implicit: `--score-only` is OUT OF SCOPE for this plan (the run it scores is already launched; the warning is a launch-time gate, and adding it here would need a second column on that `findUnique` and a second surface to test). Task 3 Step 5 states it as a bound so no reader takes "one production caller" to mean "every operator surface is covered".
- Throughput envelopes to size fixtures from (spec §2): Qwen 2869 tokens / 49.0 s = 58.5 tok/s; granite4.2 35.9 tok/s at 4.5k tokens, 23.2 tok/s at 12k (spec §5.4.1, the per-length table at **:423-426** post-v2k — round 2's `:402-405` was a `5e48187` figure; §2.1's table at :115-120 uses a flat 35.0 — :111-113 is the closing fence of the formula block, not the table) — the decay that makes the linear figure a LOWER bound.
- **The judge this warning is actually for**, and the case the unit fixture is built from: **qwen3.5:9b**. **CORRECTION (round 4), replacing round 3's figure, which was the exact defect `token-accounting` fixed hours later.** Round 3 said "measured at 11.9 tok/s" and used the RAW `Σ outputTokens / Σ latencyMs` formula this plan originally specified. That formula is wrong for this judge: its judge path always sends `response_format: json_schema`, and on qwen3.5:9b `outputTokens` (`usage.completion_tokens`) EXCLUDES the reasoning channel entirely — measured against `judge-arena-pg-1` (read-only psql, 2026-09-02), `length(reasoningContent) / outputTokens` over its completed judgments ranges **36.7 … 156.7**, all classified `excludes_reasoning` by `token-accounting.ts`'s `REASONING_EXCLUDED_RATIO` (= 8). The raw formula computes **~0.54 tok/s** for the currently-registered version (`cmtkqwen35ord2v20000001`, ordinal 2: Σ outputTokens 2069 / Σ latencyMs 3 856 364 ms) — nonsense for a model that is not stalled. The CORRECT, pooled, `accountTokens`-derived figure over the SAME 15 completed judgments (`Σ estimatedGeneratedTokens 46 401` — i.e. `Σ (outputTokens + round(reasoningChars / 3.64))` per row — `/ Σ (latencyMs / 1000)`) is **12.032 tok/s**, which this plan's fixtures round to **12.0 tok/s** (`toFixed(1)`, the same precision every other measured envelope in this plan uses — 58.5, 35.9, 23.2). With `max_tokens: 12288` (an illustrative registered budget kept from round 3; the two ACTUAL registered versions carry 6144 and 8192, not 12288 — chosen so the boundary math stays close, see below): 12288 / 12.0 = **1024.0 s exactly** against the 900 s hard cap — the rule fires (1 024 000 ms > 900 000), and `formatDurationMs` rounds it to **17m4s**. This is still the nearest-to-boundary case in the whole plan, at 1.14x over (vs. 1.15x in round 3) — the db fixtures remain 2 tok/s / 6.8x over. See "Revision round 4" in Self-review for the full derivation and every place this figure appears.
- **The case this warning is NOT for, stated because three artefacts used to claim otherwise.** granite4.2's 2026-09-01 stall (runbook §8.6 :461-492) was the **300 s provider timeout**: 35 tok/s × 12288 ≈ **351 s**, which overran 300 s and fits the 900 s hard cap with room. Runbook §8.7 (:494-503) then made 300 s an alert that "warns and keeps waiting", leaving `EVALUATION_MODEL_HARD_CAP_MS` as the only abort. So this rule compares against the right number for today's image AND is correctly silent on granite — but the sentence "the failure granite4.2 hit when its budget was raised 4096 → 12288 without the clock being checked" was FALSE about this rule and, in round 2, was going to land verbatim in `latency.ts`'s JSDoc, in `tests/db/calibration-link.test.ts` and in two commit bodies. Corrected in all four places in round 3.
- `.env.test` sets no `EVALUATION_MODEL_*` variable, so the db suite sees the 900 000 ms default. The over-cap db fixtures (2 tok/s against 12288 → 6144 s; against 4096 → 2048 s) are chosen far above the 900 s default AND above `MAX_HARD_CAP_MS` (1 170 000 ms, `timeout-policy.ts:94`), so no hard cap this deployment can legally run under makes them fit. Precisely: `MAX_HARD_CAP_MS` is a boot-time refusal in `src/lib/env.ts:111` (`.max(MAX_HARD_CAP_MS)`), NOT a clamp inside `resolveTimeoutBudgets` (`timeout-policy.ts:149-154` only does `Math.max(rawHardCap, initialBudget)`) — a shell that exported `EVALUATION_MODEL_HARD_CAP_MS=7000000` straight into the test process would still turn the test green. The fixtures guard against every legal configuration, not against an illegal one.
- Deviation from the U1 filter, deliberate: U1 says "both non-null and latencyMs > 0"; the pooled estimate ALSO drops rows with `outputTokens <= 0`. A completed judgment that emitted nothing is not a speed measurement, and keeping it could only LOWER the pooled rate (more seconds, no tokens), i.e. make the warning fire more readily — excluding it errs toward silence, never toward a false warning. **CORRECTION (round 4):** this exclusion is no longer `summarizeThroughput`'s own decision — `accountTokens` (`@/lib/calibration/token-accounting`, already landed) already returns `estimatedGeneratedTokens: null` for an absent, zero or negative `outputTokens`, and `summarizeThroughput` only propagates that `null` into its own drop. Documented in both modules' JSDoc and pinned by the 'excludes a row with no outputTokens — or none' unit test (Task 1), whose injection now breaks the PROPAGATION (coalescing the `null` to a measured `0`) rather than a guard clause that no longer exists in this file.
- **Db coverage direction — CORRECTED 2026-09-02, and it is the Owner decision at the top of this plan.** The earlier version of this bullet said the BRANCHES aggregate would move "~-0.1pp … expected to pass". That was wrong in magnitude, because it named the not-imported artifact and then reasoned as if the artifact contributed **0** branches. It does not.
  - **What the artifact actually is.** `vitest.config.ts:196-199` documents it, and `coverage/lcov.info` (unit run, measured 2026-09-02 on `5e48187`) shows it: a file inside the `include` glob that is never loaded reports `FNF:1 FNH:1 LF:<real> LH:0 BRF:1 BRH:1` — functions and branches at **1/1 = 100%**, not 0. `src/lib/calibration/launch.ts` in the unit lcov is exactly this: `FNF:1 FNH:1 LF:158 LH:0 BRF:1 BRH:1` (**CORRECTION:** round 2 quoted `LF:148`; the real figure on `33b7be4` is 158 — v2k grew the file).
  - **So today** `src/lib/calibration/latency.ts` contributes **1 of 1** branches to the db aggregate, not 0 of 50. Nothing under `tests/db` imports it: the only value-importers in the tree are `src/worker/judgment-consumer.ts:185` and `scripts/calibration/run.ts:52` (`src/lib/llm/timeout-policy.ts:46` is `import type`, erased), and `launch.ts` does not yet.
  - **What the file really holds.** In the unit run the same file is `FNF:7 FNH:7 LF:130 LH:130 BRF:50 BRH:50` — **50 real branches**, all covered there. Their `BRDA` lines, counted: `nearestRank` + `summarizeLatencies` 8 (`:111`, `:123-128`), `judgeLatencyBaseline` 2 (`:162`, `:176`), `describeBaseline` 3 (`:187-190`), `formatDurationMs` 5 (`:204-206`), `timeToComputeByTuple` 23 (`:262-344`), `selectOverdue` 9 (`:393-414`). **45 of the 50 live in functions the four db tests never enter.**
  - **The arithmetic.** Task 3 makes `launch.ts` import it, replacing the `1/1` artifact with ~**67 total** branches (50 existing + ~17 added by Tasks 1-2), of which the db tests reach only ~**18**: they execute `summarizeThroughput`, `judgeThroughputEstimate`, `budgetWarningFor` and `formatDurationMs` and nothing else in the file. Using the db aggregate **measured on `33b7be4`** (see the bullet below): branches **1001/1286 = 77.84%**, i.e. **0.84pp** of headroom over the `branches: 77` floor at `vitest.db.config.ts:152`. `(1001 - 1 + 18) / (1286 - 1 + 67)` = **1018/1352 = 75.30%** — the gate FAILS by ~1.7pp. Even with `BRH_new = 0` it is `1000/1352 = 73.9%`; even at a generous 30-of-67 hit it is `1030/1352 = 76.2%`. No plausible hit count passes (it would take ~41 of 67). Statements and lines rise; branches is the binding key.
  - **The functions floor moves the same way and the earlier bullet never mentioned it.** `functions: 60` at `vitest.db.config.ts:151`. latency.ts goes from the artifact's `1/1` to roughly `4/10` (7 functions today + 3 from Tasks 1-2; the db tests execute four of them). Smaller effect than branches on a large denominator, but read the printed row, do not assume.
  - **MEASURED, not estimated — CORRECTION to round 2, which said "`coverage-db/lcov.info` does not exist in the tree today" and reasoned from the HEAD-era estimate 992/1274 = 77.86%.** The file DOES exist (`/root/judge-arena/coverage-db/lcov.info`, written 2026-09-02 21:00 by the v2k db-coverage run, 90 files) and was aggregated on `33b7be4`: branches **1001/1286 = 77.84%**, functions **270/420 = 64.29%**, lines **4745/9295 = 51.05%**. `src/lib/calibration/latency.ts` appears in it as exactly the artifact described above — `FNF:1 FNH:1 LF:130 LH:0 BRF:1 BRH:1` — and `src/lib/calibration/launch.ts` as `FNF:3 FNH:3 LF:158 LH:151 BRF:31 BRH:23`. The conclusion is unchanged; only the inputs are now measurements.
  - **Option (a) was measured too, so the owner decides on numbers rather than on a prediction.** Dropping `src/lib/calibration/latency.ts` from the db `coverage.exclude` denominator removes only the `1/1` artifact and its 130 unhit lines: branches **1000/1285 = 77.82%** (floor 77 — PASSES), functions **269/419 = 64.20%** (floor 60 — passes), lines **4745/9165 = 51.77%** (floor 47 — RISES, because the 130 uncovered lines leave the denominator), statements likewise. All four db floors stay green under (a). Task 3 Step 6 still re-measures for real before anything is committed — these figures are pre-Task-1/2 and the Task-3 code adds lines to `launch.ts` — but option (a) is no longer a leap.

---

### Task 1: Pooled throughput per judge — `summarizeThroughput` + `judgeThroughputEstimate`

**Files:**
- Modify: `/root/judge-arena/src/lib/calibration/latency.ts` (module doc :9-57; insert new section after `judgeLatencyBaseline`, i.e. after line 177 and before the `describeBaseline` doc comment at :179; add one import line beside the existing `import { prisma } from '@/lib/db';` at :84)
- Test: `/root/judge-arena/tests/lib/calibration-latency.test.ts` (fake at :65-100; import block :49-58; insert new describes after the `judgeLatencyBaseline` describe closes at :314, before the `// ─── the (dataset, item, model) projection` banner at :316)
- Reads, does not modify: `/root/judge-arena/src/lib/calibration/token-accounting.ts` (already landed — `e438da2`/`0bd6b6b`/`db5bff9`) and its test file `tests/lib/calibration-token-accounting.test.ts`, whose `Q35_MIN_RATIO`/`Q35_THE_INCIDENT` fixture constants this task's new counter-test reuses so the two files' numbers cross-check.

**Interfaces:**
- Consumes: `JudgeLatencyClient = Pick<PrismaClient, 'modelJudgment'>` (latency.ts:145), `prisma` from `@/lib/db`, `accountTokens` from `@/lib/calibration/token-accounting` (its `TokenAccounting.estimatedGeneratedTokens: number | null` field is the value pooled below — NOT `outputTokens`).
- Produces:
  - `export interface ThroughputEstimate { tokPerSec: number; n: number }`
  - `export interface ThroughputRow { outputTokens: number | null; latencyMs: number | null; reasoningContent: string | null }`
  - `export function summarizeThroughput(rows: readonly ThroughputRow[]): ThroughputEstimate | null`
  - `export async function judgeThroughputEstimate(judgeModelVersionId: string, client: JudgeLatencyClient = prisma): Promise<ThroughputEstimate | null>`

- [ ] **Step 0: Pre-flight — confirm `token-accounting` has landed**

```bash
cd /root/judge-arena && test -f src/lib/calibration/token-accounting.ts && grep -n -a "export function accountTokens\|export const CHARS_PER_TOKEN\|export const REASONING_EXCLUDED_RATIO" src/lib/calibration/token-accounting.ts
```
Expected: the file exists and all three greps hit. If not, STOP — execute `2026-09-02-token-accounting-and-truncation-proximity.md` (or whichever plan landed `e438da2`/`0bd6b6b`/`db5bff9`) first. This task consumes `accountTokens` directly; improvising an inline reimplementation here would duplicate a primitive that already has its own tested, measured constants (`CHARS_PER_TOKEN = 3.64`, `REASONING_EXCLUDED_RATIO = 8`) and violate one-concern-per-commit.

- [ ] **Step 1: Write the failing tests**

In `/root/judge-arena/tests/lib/calibration-latency.test.ts`, extend the import block (currently :49-58) — add the two new names, keeping alphabetical order:

```ts
import {
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
```

Widen the fake's row type (:65-69) so it can carry token counts AND the reasoning-channel column — replace the whole `type FakeJudgment = { ... };` with:

```ts
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
```

A minimal helper the new fixtures below use, matching `tests/lib/calibration-token-accounting.test.ts`'s own (only the LENGTH of `reasoningContent` is ever read, so a `repeat()` string is the whole fixture):

```ts
const chars = (n: number): string => 'x'.repeat(n);
```

And change the fake's row projection (:95) from

```ts
          .map((r) => ({ latencyMs: r.latencyMs }));
```

to

```ts
          .map((r) => ({
            latencyMs: r.latencyMs,
            outputTokens: r.outputTokens ?? null,
            reasoningContent: r.reasoningContent ?? null,
          }));
```

(The existing `judgeLatencyBaseline` tests assert on summarised results and on `calls[0]` with `toMatchObject`, so the extra keys are invisible to them.)

Then insert the following two describes immediately BEFORE the line `// ─── the (dataset, item, model) projection ──────────────────────────────────` (currently :316):

```ts
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
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `cd /root/judge-arena && npx vitest run tests/lib/calibration-latency.test.ts`
Expected: FAIL — 8 new tests red with `TypeError: summarizeThroughput is not a function` / `TypeError: judgeThroughputEstimate is not a function` (vite-node resolves a missing named export to `undefined`; if your vitest reports `does not provide an export named 'summarizeThroughput'` instead, that is the same failure). The 27 pre-existing tests stay green.

- [ ] **Step 3: Write the implementation**

In `/root/judge-arena/src/lib/calibration/latency.ts`, first extend the PUBLIC SURFACE block of the module doc. After the `describeBaseline(baseline) -> string` entry (currently :29-34, ending with the line ` *     state with two different sentences.`) and before ` *   timeToComputeByTuple(scope, client?) -> Promise<TimeToCompute[]>` (:36), insert:

```ts
 *
 *   judgeThroughputEstimate(judgeModelVersionId, client?)
 *       -> Promise<ThroughputEstimate | null>
 *
 *     `{ tokPerSec, n }` POOLED over the COMPLETED judgments of one judge
 *     (`Σ accountTokens(row).estimatedGeneratedTokens / Σ (latencyMs / 1000)`,
 *     via `accountTokens` from `@/lib/calibration/token-accounting` —
 *     **never** raw `Σ outputTokens / Σ latencyMs`: `outputTokens` is
 *     `usage.completion_tokens` verbatim and OMITS the reasoning channel on
 *     some models when the request carries `response_format: json_schema`,
 *     which the judge path always sends — see token-accounting.ts's module
 *     doc), or **`null` when none carried a usable estimate** — the same
 *     null-not-zero contract as the baseline, for the same reason: zero
 *     tok/s reads as "emits nothing" and a caller dividing max_tokens by it
 *     gets Infinity. It cannot come from the endpoint verify probe, which
 *     sends `max_tokens: 1`. This is the input to the stacked-limits check
 *     (runbook §8.6) that `launchCalibrationRun` runs.
```

Then insert the following section immediately AFTER the closing `}` of `judgeLatencyBaseline` (currently line 177) and BEFORE the `/**` that opens `describeBaseline`'s doc (currently :179). It reads `accountTokens` from `@/lib/calibration/token-accounting` — add that import beside the existing `import { prisma } from '@/lib/db';` at :84 first:

```ts
import { accountTokens } from '@/lib/calibration/token-accounting';
```

```ts

// ─── Throughput: the input to the stacked-limits check ──────────────────────

/** A judge's measured output throughput, pooled over its COMPLETED judgments.
 *  Only ever produced for a NON-EMPTY sample — the empty case is `null`, for
 *  the same reason `LatencyBaseline`'s is (module doc): a zero here would read
 *  as "this judge produces nothing", and `max_tokens / 0` is Infinity. */
export interface ThroughputEstimate {
  /** Σ `accountTokens(row).estimatedGeneratedTokens` / Σ (latencyMs / 1000)
   *  over the rows that carried both. POOLED, not a mean of per-judgment
   *  rates: a mean of rates weights a 109-token verdict the same as a
   *  7,000-token one, and the number a budget is sized against is "how fast
   *  does this judge emit tokens", not "what is the average of its per-call
   *  speeds". NEVER raw `outputTokens` — see `summarizeThroughput`'s doc for
   *  why. */
  tokPerSec: number;
  /** How many completed judgments carried a usable estimate — the
   *  denominator, stated, because a rate over 1 judgment and over 30 are
   *  different claims. */
  n: number;
}

/** The columns the estimate reads, as a plain shape so the arithmetic is a
 *  pure function of rows the caller chose (the `RunningJudgmentRow` /
 *  `selectOverdue` pattern below). `reasoningContent` is read by
 *  `accountTokens`, not by this module, to tell whether `outputTokens`
 *  already counted it. */
export interface ThroughputRow {
  outputTokens: number | null;
  latencyMs: number | null;
  reasoningContent: string | null;
}

/**
 * Pool DERIVED generated-token counts over wall-clock seconds.
 *
 * Reads `estimatedGeneratedTokens` from `accountTokens()`
 * (`@/lib/calibration/token-accounting`), NOT the raw `outputTokens` column.
 * `ModelJudgment.outputTokens` is `usage.completion_tokens` verbatim, and on
 * some models it does not count the reasoning channel at all when the
 * request carried `response_format: json_schema` — which the judge path
 * always does. `accountTokens` is the already-landed, already-tested
 * primitive that tells the two cases apart per row
 * (`REASONING_EXCLUDED_RATIO`); this function's own job is only to pool what
 * `accountTokens` already classified, and to guard `latencyMs`, which
 * `accountTokens` does not touch at all.
 *
 * Drops any row whose `latencyMs` is missing, non-positive or non-finite (0
 * would divide by zero), and any row whose `accountTokens(row)
 * .estimatedGeneratedTokens` is not a finite number. That already covers a
 * v1-imported judgment (`outputTokens: null`, scripts/importer/runs.ts:494)
 * and a completed judgment that emitted nothing (`outputTokens <= 0`):
 * `accountTokens` returns `estimatedGeneratedTokens: null` for both, per its
 * own "an absent or non-positive provider count is an ABSENCE" contract —
 * `summarizeThroughput` does not reimplement that decision, only propagates
 * it. `ThroughputRow` is exported, so a caller can still hand in a NaN
 * `outputTokens` with no reasoning channel: `accountTokens` does NOT reject
 * that value (`NaN <= 0` is `false`, so its own early-return guard does not
 * fire, and with no reasoning channel it returns the NaN straight back as
 * `estimatedGeneratedTokens`) — caught here by `Number.isFinite`, not by
 * `accountTokens`. Returns `null` when nothing survives — the same contract
 * as `summarizeLatencies`.
 * Pure, so the arithmetic is testable without a database anywhere near it —
 * `accountTokens` is a leaf module (zero imports) for the same reason.
 */
export function summarizeThroughput(rows: readonly ThroughputRow[]): ThroughputEstimate | null {
  let tokens = 0;
  let ms = 0;
  let n = 0;
  for (const row of rows) {
    if (typeof row.latencyMs !== 'number' || !Number.isFinite(row.latencyMs) || row.latencyMs <= 0) continue;
    const estimatedGeneratedTokens = accountTokens(row).estimatedGeneratedTokens;
    if (typeof estimatedGeneratedTokens !== 'number' || !Number.isFinite(estimatedGeneratedTokens)) continue;
    tokens += estimatedGeneratedTokens;
    ms += row.latencyMs;
    n += 1;
  }
  if (n === 0) return null;
  return { tokPerSec: tokens / (ms / 1000), n };
}

/**
 * How fast this judge has historically emitted output tokens, DERIVED via
 * `accountTokens` (never the raw `outputTokens` column — see
 * `summarizeThroughput`'s doc), or `null` if it has never completed a
 * judgment that produced a usable estimate.
 *
 * Same scope and same status filter as `judgeLatencyBaseline`, for the same
 * reason: a call that timed out is evidence that the judge did not answer,
 * not evidence about its speed. And it cannot come from the endpoint verify
 * probe — `src/lib/llm/verify.ts` sends `max_tokens: 1`, and one token is
 * not a rate.
 *
 * Consumed by `launchCalibrationRun` (src/lib/calibration/launch.ts) for the
 * stacked-limits warning: `max_tokens / tokPerSec` must fit under the hard
 * cap, or a judgment that needs its whole budget is aborted rather than
 * truncated (runbook §8.6; register §5.6/8).
 */
export async function judgeThroughputEstimate(
  judgeModelVersionId: string,
  client: JudgeLatencyClient = prisma
): Promise<ThroughputEstimate | null> {
  const rows = await client.modelJudgment.findMany({
    // Same WHERE as the baseline, served by the same index
    // (ModelJudgment_judgeModelVersionId_idx). Runs once per launch.
    where: { judgeModelVersionId, status: 'completed' },
    // `reasoningContent` alongside the two columns the raw formula used —
    // `accountTokens` needs it to tell whether `outputTokens` already
    // counted the reasoning channel. There is deliberately no stored
    // "reasoningChars" column (token-accounting.ts's module doc): the
    // character count is derived at read time from the column already here.
    select: { outputTokens: true, latencyMs: true, reasoningContent: true },
  });

  // The null/zero/non-finite filter lives in `summarizeThroughput`, NOT in
  // the WHERE above, so it is exercised by the unit suite instead of by
  // Postgres.
  return summarizeThroughput(rows);
}
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `cd /root/judge-arena && npx vitest run tests/lib/calibration-latency.test.ts`
Expected: PASS — 35 tests (27 + 8).

- [ ] **Step 5: Injection**

Break (1) — the pooling: in `summarizeThroughput`, replace the return line with a mean of per-row rates:
```ts
  return { tokPerSec: rows.filter((r) => typeof r.latencyMs === 'number' && Number.isFinite(r.latencyMs) && r.latencyMs > 0 && typeof accountTokens(r).estimatedGeneratedTokens === 'number' && Number.isFinite(accountTokens(r).estimatedGeneratedTokens as number)).reduce((s, r) => s + (accountTokens(r).estimatedGeneratedTokens as number) / (r.latencyMs! / 1000), 0) / n, n };
```
Run: `cd /root/judge-arena && npx vitest run tests/lib/calibration-latency.test.ts -t "POOLS tokens"`
Expected: FAIL with `expected 75 to be close to 57.14`. Restore the original return line.

Break (2) — the zero-latency guard: change `row.latencyMs <= 0` to `row.latencyMs < 0`.
Run: `cd /root/judge-arena && npx vitest run tests/lib/calibration-latency.test.ts -t "latencyMs instead of dividing by it"`
Expected: FAIL with `expected { tokPerSec: Infinity, n: 1 } to be null` (the `latencyMs: 0` row is admitted; the `null` and `Infinity` rows are still rejected by the other two arms). Restore.

Break (3) — the zero/absent-token exclusion, now that it lives one layer down (the deliberate deviation from the U1 filter, Facts bullet above — a conscious decision, so it still gets an injection, just not the same one round 3 had). `accountTokens` already returns `estimatedGeneratedTokens: null` for `outputTokens` that is absent, zero or negative (its own tested contract) — `summarizeThroughput` no longer decides that, it only PROPAGATES it. The injection therefore breaks the propagation, not the classification: in `summarizeThroughput`, change
```ts
    const estimatedGeneratedTokens = accountTokens(row).estimatedGeneratedTokens;
```
to coalesce the null into a measured zero:
```ts
    const estimatedGeneratedTokens = accountTokens(row).estimatedGeneratedTokens ?? 0;
```
Run: `cd /root/judge-arena && npx vitest run tests/lib/calibration-latency.test.ts -t "excludes a row with no outputTokens"`
Expected: FAIL with `expected { tokPerSec: 33.333…, n: 3 } to deeply equal { tokPerSec: 100, n: 1 }` — the `outputTokens: null` and `outputTokens: 0` rows (both `accountTokens`-classified `unmeasurable`, both now coalesced to `0`) join the pool as zero-token, 10 s measurements: `n` goes 1 → 3, `ms` triples, `tokens` stays 1000, and the rate falls to 1000/30 = 33.33 (the NaN row stays excluded regardless — `NaN ?? 0` does NOT trigger, nullish coalescing only replaces `null`/`undefined`, so it is still caught by the `Number.isFinite` guard next to this one, Break (5) below). (That direction is the reason the exclusion is safe: keeping a row as zero-token could only LOWER the rate and make the warning fire more readily.) Restore.

Break (4) — the status filter: in `judgeThroughputEstimate` remove `status: 'completed'` from the `where`.
Run: `cd /root/judge-arena && npx vitest run tests/lib/calibration-latency.test.ts -t "judgeThroughputEstimate"`
Expected: 3 of the 4 tests in this describe FAIL — `returns null when this judge has never completed a judgment` (`expected { tokPerSec: 13.653…, n: 1 } to be null`: the errored 12288-token / 900 s row, `reasoningContent: null`, became a rate), `pools only the COMPLETED judgments of THIS judge` (`expected 3 to be 2`: the same errored row joined the pool), and the query-shape test (`where` no longer matches). The new `pools via accountTokens…` test stays GREEN under this break — its fixture has no non-`completed` rows to admit, so removing the status filter changes nothing for it; that is expected, not a gap, because this break is about the status filter, not the reasoning-channel arithmetic. Restore.

Break (5) — the two `Number.isFinite` arms (they are the ONLY clause that rejects a non-finite count: `typeof NaN === 'number'` and `NaN <= 0` is `false`, so without them a NaN slips past every other arm): in `summarizeThroughput` delete ` || !Number.isFinite(row.latencyMs)` from the first guard (the one that runs before `accountTokens` is even called) and delete ` || !Number.isFinite(estimatedGeneratedTokens)` from the second guard (the one that runs after).
Run: `cd /root/judge-arena && npx vitest run tests/lib/calibration-latency.test.ts -t "excludes a"`
Expected: 2 FAIL — `excludes a row with no outputTokens …` with `expected { tokPerSec: NaN, n: 2 } to deeply equal { tokPerSec: 100, n: 1 }` (the `outputTokens: NaN` row — `accountTokens` returns `estimatedGeneratedTokens: NaN` for it, since `NaN <= 0` does not trip `accountTokens`'s OWN early return either, and with no reasoning channel it hands the NaN straight back — joined the pool and poisoned the sum), and `excludes a zero, missing or non-finite latencyMs …` with `expected { tokPerSec: 0, n: 1 } to be null` (the `Infinity` latency row joined, so the denominator is infinite and the rate collapses to 0 instead of the sample being empty). Restore.

Break (6) — the per-judge scope: the `OTHER_JUDGE` row (5000 tokens in 1 s) exists in the `pools only the COMPLETED judgments of THIS judge` fixture for exactly one reason, and until this injection ran it was an assertion with no injection behind it (failure mode 5). In `judgeThroughputEstimate` remove `judgeModelVersionId` from the `where`, leaving `where: { status: 'completed' }`.
Run: `npx vitest run tests/lib/calibration-latency.test.ts -t "judgeThroughputEstimate"`
Expected: 2 of the 4 tests in this describe FAIL — `pools only the COMPLETED judgments of THIS judge` with `expected 3 to be 2` (the 1-second/5000-token row of a DIFFERENT judge joined the pool: 10738 tokens over 99 s = 108.5 tok/s, not 58.55), and the query-shape test, whose `toMatchObject` on `where` no longer matches. The other two (`returns null…`, `pools via accountTokens…`) stay GREEN — neither fixture contains an `OTHER_JUDGE` row, so dropping the `judgeModelVersionId` filter admits nothing new for them. Restore.

Break (7) — the `select` projection: in `judgeThroughputEstimate` add a fourth column, `select: { outputTokens: true, latencyMs: true, reasoningContent: true, rawResponse: true }`.
Run: `cd /root/judge-arena && npx vitest run tests/lib/calibration-latency.test.ts -t "ONLY those three columns"`
Expected: FAIL on the `toEqual` with an extra `rawResponse: true` key. Every other test in the file stays GREEN — the fake ignores `select` — which is why that one assertion is `toEqual` and not part of the `toMatchObject`. Restore.

Break (8) — the reasoning-channel defect itself, reintroduced (the defect this task exists to prevent shipping, so it gets its own dedicated injection, per CONTRIBUTING.md:210-234, rather than relying on Break (1)-(7) to catch it — they do not, because every OTHER fixture in this file uses `reasoningContent: null`): in `summarizeThroughput`, revert the derived-token line to the raw column — this is byte-for-byte round 3's formula, `Σ outputTokens / Σ latencyMs`:
```ts
    const estimatedGeneratedTokens = row.outputTokens;
```
(deleting the `accountTokens(row).estimatedGeneratedTokens` call entirely.)
Run: `cd /root/judge-arena && npx vitest run tests/lib/calibration-latency.test.ts -t "pools via accountTokens"`
Expected: FAIL with `expected 0.4781818181818182 to be close to 12.27` — (148 + 115) / (200 + 350) = 263 / 550 = 0.478 tok/s, ~26x too slow: the exact defect `token-accounting` (`e438da2`/`0bd6b6b`/`db5bff9`) fixed elsewhere in this codebase, shipping again here undetected by every other test in the file. This is the injection item 2 of the correctness-fix task required — "without this the defect can silently return" — and it is the only one of the eight that goes red on this specific test. Restore.

Confirm the file is back to green: `npx vitest run tests/lib/calibration-latency.test.ts` → 35 passed.

- [ ] **Step 6: Gates (stated deviation — no db, no integration)**

```bash
cd /root/judge-arena && npm run lint && npx tsc --noEmit && npm run test:coverage && npm run build
```

**Deviation from Global Constraints, stated.** The Gates bullet lists six gates; this commit runs four. Justification, and it is provable rather than hopeful: this commit only ADDS exports to `src/lib/calibration/latency.ts` and touches no existing symbol, and **nothing under `tests/db/**` can reach that module** — `grep -a -rn 'calibration/latency' src scripts tests` returns exactly three importers (`src/worker/judgment-consumer.ts:185` value, `scripts/calibration/run.ts:52` value, `src/lib/llm/timeout-policy.ts:46` `import type`, erased) plus the two test files, and no file under `tests/db/**` imports `src/worker/**` at all (the two `src/worker/reaper.ts` strings in `tests/db/calibration-link.test.ts` are comments, at **:30** and **:339** post-v2k — `:28`/`:318` were the `5e48187` positions; re-verified with `grep -rn -a "src/worker/" tests/db`, which returns only those two lines). So both the db test COUNT and the db coverage report have a provably fixed answer here, and `npm run test:db:coverage` would fire `prisma migrate reset` on the shared, non-concurrency-safe test DB for nothing. CONTRIBUTING.md:1639 states the six-gate chain as a rule to run **before pushing**, not once per local commit, and Task 4 already carries the same stated-deviation pattern. Label the commit's `Gates:` line accordingly (Step 7). If `git status --short` shows anything beyond `src/lib/calibration/latency.ts` and `tests/lib/calibration-latency.test.ts`, this deviation does not apply: run the full `&&`-guarded chain from Task 3 Step 6 instead.

Expected: lint 0 warnings; tsc 0 — the `select` assertion in Step 1's third test casts `client.calls[0]` (typed `unknown` by `fakeJudgeClient`'s own signature) through `{ select?: unknown }` before reading `.select`, which is why it type-checks without loosening back to `toMatchObject`; unit suite green — latency.ts is in the unit coverage `include` (`vitest.config.ts:37`) and carries **no per-glob override** (the overrides are `src/lib/queue/**`, `src/worker/**`, `src/lib/llm/**`, `src/lib/auth-guard.ts`, `scripts/importer/**`, `src/lib/realtime/**` — there is no `src/lib/**` entry), so it counts against the GLOBAL thresholds at `vitest.config.ts:188-191`, and the new functions are exercised by the tests above, so the aggregate moves UP, not down; build exits 0. Note the printed unit count for the commit body. The db and integration numbers for the `Gates:` line are the ones last measured — see Step 7.

- [ ] **Step 7: Commit**

```bash
git -C /root/judge-arena add src/lib/calibration/latency.ts tests/lib/calibration-latency.test.ts
git -C /root/judge-arena commit -F - <<'EOF'
feat(calibration): pooled output throughput per judge, via accountTokens

The input to the stacked-limits check (runbook §8.6, register §5.6/8):
`judgeThroughputEstimate(judgeModelVersionId)` returns { tokPerSec, n }
POOLED over the judge's COMPLETED judgments — Σ accountTokens(row)
.estimatedGeneratedTokens / Σ (latencyMs / 1000), via `accountTokens` from
`@/lib/calibration/token-accounting` (already landed: e438da2/0bd6b6b/
db5bff9) — or null when none carried a usable estimate. Same scope, same
status filter and same null-not-zero contract as `judgeLatencyBaseline`, and
for the same reasons: a timed-out call says the judge did not answer, not
how fast it answers, and zero tok/s reads as "emits nothing" (max_tokens /
0 = Infinity).

NEVER raw `Σ outputTokens / Σ latencyMs`. `ModelJudgment.outputTokens` is
`usage.completion_tokens` verbatim, and the judge path always sends
`response_format: json_schema` — under which some models (measured:
qwen3.5:9b) omit the reasoning channel from that count entirely. The raw
formula understates such a judge's throughput by roughly 20-26x; the
dedicated counter-test below (rows shaped like qwen3.5:9b: small
outputTokens, large reasoningContent) pins the correct ~12 tok/s and its own
injection proves the raw formula, reintroduced, goes red on exactly that
test and only that test — every OTHER fixture in this file uses
`reasoningContent: null`, where the two formulas agree by construction.

Pooled rather than a mean of per-judgment rates: a mean weights a 109-token
verdict the same as a 7,000-token one. The unit fixture is asymmetric
(100 tok/s and 50 tok/s over unequal spans) so the two answers differ —
57.14 vs 75 — and the injection that swaps pooling for a mean goes red on
exactly that number.

It cannot come from the endpoint verify step: verify.ts probes with
max_tokens 1, and one token is not a rate. Nothing consumes this yet; the
launch-time warning is the next commit.

Injections run and restored: mean-of-rates (red, 75 ≠ 57.14); latencyMs 0
admitted (red, Infinity); the null-to-zero coalescing that would let
`accountTokens`'s own unmeasurable rows join the pool as zero-token
measurements (red, {33.33, n:3} ≠ {100, n:1}); status filter dropped (red,
the errored 12288-token timeout became a rate); both Number.isFinite arms
deleted (red on the two exclusion cases — NaN poisons the sum, Infinity
collapses the rate to 0); judgeModelVersionId dropped from the where (red,
3 ≠ 2 — a different judge's 5000-token/1 s row joined the pool, which is
the only reason that fixture row exists); a fourth column added to the
select (red on the toEqual, and only there); and — the defect this commit
exists to prevent — the derived-token line reverted to the raw
`outputTokens` column, i.e. round 3's formula byte-for-byte (red only on
the qwen3.5:9b-shaped test: 0.478 tok/s ≠ 12.27, ~26x too slow, and green
everywhere else in the file, which is exactly why that test needed its own
dedicated fixture).

Gates: lint 0, tsc 0, <N> unit, coverage 0, build 0. Db and integration not
re-run for this commit and not claimable from it: nothing under tests/db/**
imports src/lib/calibration/latency.ts, and this commit only adds exports.
Last green at <BASE>: <M> db / 82 integration.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
EOF
```
Replace `<N>` with the count `npm run test:coverage` printed (post-v2k baseline **888** + 8 = **896** if nothing else has landed — note this task now adds 8 tests, not 7: round 4 added the dedicated `accountTokens`-shaped counter-test, see the header's Depends-on line and Self-review "Revision round 4"). **CORRECTION history:** round 2 predicted **894** from `877 + 10`; round 3 corrected it to **895** (`888 + 7`, since v2k added 11 unit tests, not 10 — two new files: `tests/lib/sampling.test.ts` and `tests/lib/calibration-sampling-drift.test.ts`); round 4 corrects it again to **896** for the reason above. If the print is not 896, STOP and account for the delta before writing it into the body. `<BASE>` is the SHA of the dependency's last commit — `git -C /root/judge-arena log -1 --format=%h` before this commit is written — and `<M>` is the db count that commit printed (the post-snapshot baseline **674**, NOT the pre-Wave-1 figure 670 and not the 673 an earlier draft of this plan carried). **Use the printed numbers**, never the plan's.

---

### Task 2: The rule — `budgetWarningFor`

**Files:**
- Modify: `/root/judge-arena/src/lib/calibration/latency.ts` (append to the Throughput section created in Task 1, directly after `judgeThroughputEstimate`'s closing `}`; module doc PUBLIC SURFACE block)
- Test: `/root/judge-arena/tests/lib/calibration-latency.test.ts` (import block; new describe after the `judgeThroughputEstimate` describe from Task 1)

**Interfaces:**
- Consumes: `ThroughputEstimate` (Task 1), `formatDurationMs` (latency.ts:204-209, existing).
- Produces:
  - `export interface BudgetWarningInput { maxTokens: number; throughput: ThroughputEstimate | null; hardCapMs: number }`
  - `export function budgetWarningFor(input: BudgetWarningInput): string | null`

- [ ] **Step 1: Write the failing tests**

Add `budgetWarningFor` to the import block in `/root/judge-arena/tests/lib/calibration-latency.test.ts` (alphabetical, so it goes first):

```ts
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
```

Insert this describe immediately after the closing `});` of `describe('judgeThroughputEstimate', …)` (added in Task 1) and before the `// ─── the (dataset, item, model) projection` banner:

```ts
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
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `cd /root/judge-arena && npx vitest run tests/lib/calibration-latency.test.ts -t "budgetWarningFor"`
Expected: FAIL — 6 tests red with `TypeError: budgetWarningFor is not a function` (vite-node resolves a missing named export to `undefined`; if your vitest instead reports `does not provide an export named 'budgetWarningFor'` and the whole FILE fails to collect — 0 passed rather than 35 passed / 6 failed — that is the same failure, not a wrong red).

- [ ] **Step 3: Write the implementation**

In the module doc PUBLIC SURFACE block of `/root/judge-arena/src/lib/calibration/latency.ts`, directly after the `judgeThroughputEstimate` entry added in Task 1 (its last line is ` *     stacked-limits check (runbook §8.6) that \`launchCalibrationRun\` runs.`), insert:

```ts
 *
 *   budgetWarningFor({ maxTokens, throughput, hardCapMs }) -> string | null
 *
 *     The stacked-limits rule as one operator sentence: `max_tokens /
 *     tokPerSec` strictly over the hard cap yields a warning naming the
 *     budget, the rate, the sample size, both durations and the fact that
 *     the figure is a LOWER bound; `null` otherwise — including when
 *     `throughput` is null, because a first-ever judge must still launch.
 *     Pure. WARNS, NEVER REFUSES; the caller decides where it goes.
```

Then append the following directly after the closing `}` of `judgeThroughputEstimate` (added in Task 1), still inside the Throughput section:

```ts

export interface BudgetWarningInput {
  /** The EFFECTIVE `max_tokens` the run will execute under — the resolved
   *  snapshot on the CalibrationRun header (`effectiveSamplingParams`), never
   *  the raw, nullable `JudgeModelVersion.samplingDefaults`. */
  maxTokens: number;
  /** `judgeThroughputEstimate(...)`. `null` = no history, which is NOT a
   *  warning: a first-ever judge has nothing to be measured against. */
  throughput: ThroughputEstimate | null;
  /** `resolveTimeoutBudgets().hardCapMs` — the abort, not the alert. */
  hardCapMs: number;
}

/**
 * The stacked-limits rule (runbook §8.6), as one sentence an operator reads:
 * `max_tokens / tok_per_s` must fit under the HARD CAP, or a judgment that
 * needs its whole budget is ABORTED rather than truncated.
 *
 * WHICH WALL, PRECISELY — because the obvious one-line history is wrong and
 * a wrong motivation would mis-set every reader's expectation. granite4.2's
 * 2026-09-01 stall (runbook §8.6) was the 300 s PROVIDER timeout: 35 tok/s
 * against a 12288 budget is ~351 s, which overran 300 s and fits 900 s
 * comfortably. This rule would have been SILENT on granite, correctly, and
 * it is not the check that would have caught it. What it guards is the wall
 * that is still an abort: as of `sha-414e826a3ba3` (runbook §8.7) the 300 s
 * `EVALUATION_MODEL_TIMEOUT_MS` only WARNS and keeps waiting, and
 * `EVALUATION_MODEL_HARD_CAP_MS` (900 000 ms) is the only value that aborts.
 * The live case this exists for is qwen3.5:9b: its judge path always sends
 * response_format: json_schema, and outputTokens EXCLUDES the reasoning
 * channel on this model, so the rate below is `judgeThroughputEstimate`'s
 * `accountTokens`-derived pooled figure, never a raw outputTokens count —
 * measured against judge-arena-pg-1 (read-only psql, 2026-09-02) at
 * 12.0 tok/s (Σ estimatedGeneratedTokens / Σ latencyMs over its 15 completed
 * judgments): 12288 / 12.0 = 1024 s against a 900 s cap.
 *
 * WHOSE CAP. `hardCapMs` is the LAUNCHER's `resolveTimeoutBudgets().hardCapMs`
 * — the env of the process that runs the CLI — while the abort happens in the
 * WORKER pod, which reads its own `EVALUATION_MODEL_HARD_CAP_MS`. If the two
 * differ the check silently uses the wrong ceiling (a worker configured at
 * 600 000 aborts a run the launcher called fine). This adds no new coupling:
 * `launch.ts`'s batch deadline (:312-314) already assumes the same equality.
 * It is stated so an operator knows to confirm it before trusting silence.
 *
 * SCOPE — one of four launch paths, deliberately. This runs at CALIBRATION
 * launch only. `launchSingleRun` / `launchBulkRunCreates` are also reached
 * from `src/app/api/evaluations/[id]/runs/route.ts:84` and
 * `src/app/api/evaluations/route.ts:303 / :494 / :605`; those ordinary and
 * bulk launches execute under the same `samplingDefaults` and the same hard
 * cap and get NO warning. That is a scope decision, not an oversight, and it
 * is recorded rather than left to be discovered (handoff §5.1: the escalating
 * timeout shipped into ONE of three seams and looked live).
 *
 * WHAT SILENCE DOES NOT MEAN. The rule fires only when the OPTIMISTIC,
 * flat-rate estimate already exceeds the cap, and the flat model understates
 * the tail by ~51% at 12k tokens (spec §5.4.1): granite4.2's flat-rate
 * estimate at 12288 tokens is 351 s (35 tok/s) but the real run took 529 s,
 * ~1.51x the flat estimate. So a judge whose flat-rate estimate lands
 * anywhere in roughly 0.65x-1.0x of the cap (900 s / 1.51 ≈ 597 s and up)
 * can still abort at it with no warning. Deliberate — a second, softer band
 * would need its own sentence, its own test and its own injection, and this
 * commit does one thing — but it means "no warning" is not a clean bill. The
 * runbook paragraph says so.
 *
 * WARNS, NEVER REFUSES. `null` means "nothing to say", covering both "it
 * fits" and "no history yet" — deliberately one value, because the caller's
 * action is identical (launch) and the two states are told apart by the
 * launch log, not by a refusal.
 *
 * The estimate is a LOWER BOUND on duration and the text says so: throughput
 * DECAYS with output length (granite4.2 ran 35.9 tok/s at 4.5k tokens and
 * 23.2 tok/s at 12k — scoreboard spec §5.4.1), so a budget that "just fits"
 * at the pooled rate does not fit.
 *
 * Strictly `>`: exhausting exactly at the cap is the boundary of the abort
 * and nothing here is precise to the millisecond. The `!( … > …)` form also
 * swallows a NaN estimate rather than rendering it — that is load-bearing,
 * not incidental: the equivalent-looking `estimatedMs <= hardCapMs` would
 * print "max_tokens NaN cannot be produced …" at an operator, because
 * `NaN <= cap` is false. Pinned by the 'a NaN estimate is silence' test.
 *
 * The advice deliberately does NOT say "raise samplingDefaults.max_tokens"
 * (registry.ts's truncation advice): raising it is what produces this
 * condition, and `samplingDefaults` is meant to be immutable under a
 * judgment (prisma/seed-core.ts:223-229 — a different value is a new
 * ordinal). The other lever it names is bounded: `src/lib/env.ts:111`
 * clamps EVALUATION_MODEL_HARD_CAP_MS with `.max(MAX_HARD_CAP_MS)` and
 * MAX_HARD_CAP_MS is 1_170_000 ms (src/lib/llm/timeout-policy.ts:94), so
 * the sentence says so rather than offering an unreachable remedy.
 */
export function budgetWarningFor(input: BudgetWarningInput): string | null {
  const { maxTokens, throughput, hardCapMs } = input;
  if (throughput === null) return null;
  const estimatedMs = (maxTokens / throughput.tokPerSec) * 1000;
  if (!(estimatedMs > hardCapMs)) return null;
  return (
    `max_tokens ${maxTokens} cannot be produced inside the ${formatDurationMs(hardCapMs)} hard cap ` +
    `at this judge's measured ${throughput.tokPerSec.toFixed(1)} tok/s ` +
    `(n=${throughput.n} completed judgment(s)): exhausting the budget takes ~${formatDurationMs(estimatedMs)}, ` +
    `and a judgment that needs its full budget will be ABORTED at the cap, not truncated. ` +
    `Throughput decays with output length, so that figure is a LOWER bound on the duration, not an estimate. ` +
    `Register a new ordinal with a smaller max_tokens (never edit samplingDefaults mid-run), ` +
    `or raise EVALUATION_MODEL_HARD_CAP_MS (bounded: env.ts refuses anything above MAX_HARD_CAP_MS, 1170000 ms).`
  );
}
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `cd /root/judge-arena && npx vitest run tests/lib/calibration-latency.test.ts`
Expected: PASS — 41 tests (35 + 6).

- [ ] **Step 5: Injection**

Break (1) — the boundary: change `if (!(estimatedMs > hardCapMs)) return null;` to `if (!(estimatedMs >= hardCapMs)) return null;`.
Run: `cd /root/judge-arena && npx vitest run tests/lib/calibration-latency.test.ts -t "EXACTLY at the cap"`
Expected: FAIL with `expected 'max_tokens 900 cannot be produced …' to be null`. Restore.

Break (2) — the caveat: delete the sentence `Throughput decays with output length, so that figure is a LOWER bound on the duration, not an estimate. ` from the returned string.
Run: `cd /root/judge-arena && npx vitest run tests/lib/calibration-latency.test.ts -t "LOWER-bound caveat"`
Expected: FAIL with `expected '…' to match /LOWER bound/`. Restore.

Break (3) — the two durations, swapped: exchange the two `formatDurationMs` arguments in the returned template, so it reads `cannot be produced inside the ${formatDurationMs(estimatedMs)} hard cap …` and `exhausting the budget takes ~${formatDurationMs(hardCapMs)}`. Both `17m4s` and `15m0s` are still somewhere in the string, so this is exactly the implementation a pair of bare `toContain` assertions could not catch — the operator would read "cannot be produced inside the 17m4s hard cap … takes ~15m0s", which inverts the sentence.
Run: `cd /root/judge-arena && npx vitest run tests/lib/calibration-latency.test.ts -t "LOWER-bound caveat"`
Expected: FAIL on `expect(warning).toContain('inside the 15m0s hard cap')`. The new `uses the hardCapMs it was GIVEN` case goes red under this break too (its `inside the 1m0s hard cap` becomes `inside the 15m0s hard cap`) — two fixtures whose cap and estimate are swapped relative to each other, so no single argument order can satisfy both. Restore.

Break (4) — the warn-never-refuse contract (the whole point of the feature, so it gets an injection): change `if (throughput === null) return null;` to `if (throughput === null) return 'no throughput history';`.
Run: `cd /root/judge-arena && npx vitest run tests/lib/calibration-latency.test.ts -t "no history"`
Expected: FAIL with `expected 'no throughput history' to be null` — a judge with no history would now be told something, and the CLI would print `⚠ BUDGET no throughput history` on every first-ever launch. Restore.

Break (5) — the `!( … > …)` form itself (the JSDoc calls the NaN-swallowing property out, so it gets an injection): rewrite the guard as the equivalent-looking `if (estimatedMs <= hardCapMs) return null;`.
Run: `cd /root/judge-arena && npx vitest run tests/lib/calibration-latency.test.ts -t "NaN estimate"`
Expected: FAIL with `expected 'max_tokens NaN cannot be produced inside the 15m0s hard cap …' to be null` — `NaN <= cap` is false, so the rewritten guard falls through and renders NaN at the operator. Note that the other five `budgetWarningFor` tests stay GREEN under this break (210051 ≤ 900000, 900000 ≤ 900000, 1024000 > 900000, 900000 > 60000, and the no-history case returns early), which is exactly why the NaN case has to exist as its own test. Restore.

Break (6) — the cap is READ, not assumed. `hardCapMs` is the one input this function takes as a parameter and therefore the one an implementation can silently ignore, and the five original cases all passed `900_000`, which is byte-identical to `DEFAULT_HARD_CAP_MS` (`src/lib/llm/timeout-policy.ts:55`). Change the comparison to the literal, leaving the rendered text on the parameter: `if (!(estimatedMs > 900_000)) return null;`.
Run: `npx vitest run tests/lib/calibration-latency.test.ts -t "budgetWarningFor"`
Expected: exactly ONE FAIL — `uses the hardCapMs it was GIVEN, not the 900 s default`, with `TypeError: .toContain() expects to receive a string, but got null` (the 900 000 ms estimate is not `> 900_000`, so the function returns null instead of a sentence). The other five stay GREEN, because each passes `hardCapMs: 900_000` and the literal is that same number — which is precisely why a sixth fixture with a DIFFERENT cap had to be added. Restore. If this injection leaves the file GREEN, that is a finding (CONTRIBUTING.md:210-234), not a formality: it would mean nothing here discriminates the parameter.

Confirm green: `npx vitest run tests/lib/calibration-latency.test.ts` → 41 passed.

- [ ] **Step 6: Gates (stated deviation — no db, no integration)**

```bash
cd /root/judge-arena && npm run lint && npx tsc --noEmit && npm run test:coverage && npm run build
```
**Same stated deviation as Task 1 Step 6, for the same provable reason:** this commit again only ADDS exports to `src/lib/calibration/latency.ts`, and nothing under `tests/db/**` can reach that module, so the db count and db coverage report have a fixed answer and `prisma migrate reset` on the shared test DB buys nothing. Re-check the premise before relying on it: `git status --short` must show only `src/lib/calibration/latency.ts` and `tests/lib/calibration-latency.test.ts`; anything else and you run the full `&&`-guarded chain from Task 3 Step 6 instead.
Expected: lint 0; tsc 0; unit green, floors met (still only the GLOBAL thresholds, `vitest.config.ts:188-191` — latency.ts has no per-glob override); build exits 0. Note the printed unit count.

- [ ] **Step 7: Commit**

```bash
git -C /root/judge-arena add src/lib/calibration/latency.ts tests/lib/calibration-latency.test.ts
git -C /root/judge-arena commit -F - <<'EOF'
feat(calibration): the stacked-limits rule — max_tokens against the hard cap

`budgetWarningFor({ maxTokens, throughput, hardCapMs })` is runbook §8.6's
"two numbers and one division" as a pure function: when
max_tokens / tokPerSec is STRICTLY over the hard cap it returns one operator
sentence naming the budget, the rate, the sample size, both durations and
the caveat that the figure is a LOWER bound — throughput decays with output
length (granite4.2: 35.9 tok/s at 4.5k tokens, 23.2 at 12k), so a budget
that "just fits" at the pooled rate does not fit. Otherwise null, and null
ALSO when there is no throughput at all: a first-ever judge has no history
and must still launch. Warns, never refuses.

The wall it guards is stated precisely, because the obvious history is
wrong: granite4.2's 2026-09-01 stall was the 300 s PROVIDER timeout, and at
35 tok/s a 12288 budget is ~351 s — over 300 s, comfortably under 900 s — so
this rule would have been correctly SILENT on granite and is not the check
that would have caught it. Runbook §8.7 made 300 s an alert that keeps
waiting; the hard cap is now the only wall that aborts, and that is what this
compares against. The live case is qwen3.5:9b: its judge path always sends
response_format: json_schema, and outputTokens excludes the reasoning
channel on this model, so the rate has to be Task 1's accountTokens-derived
pooled figure, never raw outputTokens. Measured against judge-arena-pg-1 on
2026-09-02 at 12.0 tok/s (pooled over its 15 completed judgments): 12288 /
12.0 = 1024 s against 900 s, which is the unit fixture.

Three boundaries are written into the JSDoc rather than left to be
discovered: the cap read is the LAUNCHER's env, assumed equal to the
worker's (launch.ts's batch deadline already assumes that); the check runs at
calibration launch only, not on the API's single/bulk run launches; and
silence is not a clean bill, because the flat-rate estimate understates the
tail ~51% at 12k tokens, so an estimate in ~0.65x-1.0x of the cap can still
abort unwarned.

Lives in src/lib/calibration/latency.ts beside its input rather than in
launch.ts so it is unit-tested where launch.ts cannot be (launch.ts is
DB-bound and outside the unit run; importing it would only widen the
coverage denominator). The wording deliberately never says "raise
samplingDefaults.max_tokens": raising it is what produces this condition.

Injections run and restored: `>` → `>=` (red on the exact-boundary case);
LOWER-bound sentence removed (red); the two formatDurationMs arguments
swapped (red — each duration is pinned to its role, "inside the 15m0s hard
cap" / "takes ~17m4s", not merely to its presence); the no-history early
return made to emit a string (red — warn-never-refuse); the `!( … > …)`
guard rewritten as `estimatedMs <= hardCapMs` (red only on the NaN case —
the other five survive it, which is why that case is a test); the comparison
pointed at the literal 900_000 instead of the hardCapMs parameter (red only
on the new 60 s-cap case — the five 900 s fixtures cannot tell the parameter
from DEFAULT_HARD_CAP_MS, which is why that sixth fixture exists).

Gates: lint 0, tsc 0, <N> unit, coverage 0, build 0. Db and integration not
re-run for this commit and not claimable from it: nothing under tests/db/**
imports src/lib/calibration/latency.ts, and this commit only adds exports.
Last green at <BASE>: <M> db / 82 integration.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
EOF
```
Replace `<N>` with the count `npm run test:coverage` printed (Task 1's number + 6 — ≈ **902** if nothing else has landed: 888 baseline + 8 + 6). **CORRECTION history:** round 2 predicted ≈ 899 from the stale 887 baseline and a 5-test Task 2; round 3 corrected it to 901 (`895 + 6`); round 4 corrects it again to 902, because Task 1 now adds 8 tests, not 7 (see Task 1's own `<N>` note). If the print is not 902, STOP and account for the delta. `<BASE>` and `<M>` are the same pair Task 1 Step 7 used (the dependency's last commit and the db count it printed — **674** if nothing else has landed). Use the printed numbers.

---

### Task 3: Wire it into `launchCalibrationRun`, surface it on the result and in the CLI

**Files:**
- Modify: `/root/judge-arena/src/lib/calibration/launch.ts` — post-v2k positions, measured on `33b7be4`: imports :39-59; `CalibrationLaunchResult` :88-110 (`frozeGoldenSet` :102, `samplingParams` :109); the `// ── The irreversible write` banner :316 (the QUERY goes above it); the header `$transaction` :330-371; the `// ── One item, one launch` banner :381 (the RULE goes above it); return literal :455-461. Anchor on the quoted text, not on these numbers.
- Modify: `/root/judge-arena/scripts/calibration/run.ts` — post-v2k the per-item failure loop is at **:231** and the `Nothing was accepted` throw at **:232**; the print goes between them. Anchor on the `for (const f of launched.failed)` text. (`--score-only`, the file's other operator entry point at :162-171, is out of scope — see Step 5.)
- Test: `/root/judge-arena/tests/db/calibration-link.test.ts` (604 lines, 17 `it(` blocks; helper after `launchParamsFrom`, **:175-183**; new tests appended at the END of the top-level `describe` — AFTER v2k's block (4) and before the file's final `});`, so the section markers stay (1)(2)(3)(4)(5)). Its import line 1 gains `vi`, and a `import { logger } from '@/lib/logger';` is added beside the existing `@/lib/db` import — neither is present today.
- Possibly modify: `/root/judge-arena/vitest.db.config.ts` (`coverage.exclude`, :36-41) — **only if** the owner chose option (a) of the Owner decision at the top of this plan. See Step 6.

**Interfaces:**
- Consumes: `judgeThroughputEstimate`, `budgetWarningFor` (Tasks 1-2); `resolveTimeoutBudgets` (already imported in launch.ts:43, and already called at :313 for the batch deadline); from `calibration-sampling-snapshot`: the `samplingParams: SamplingParams` value destructured from the header `$transaction` in `launchCalibrationRun`, and `mkWorld({ samplingDefaults })` in the db test file.
- Produces: `CalibrationLaunchResult.budgetWarning: string | null`.

- [ ] **Step 0: Pre-flight — confirm the dependency has landed**

```bash
cd /root/judge-arena && grep -n -a "samplingParams" src/lib/calibration/launch.ts && grep -n -a "samplingDefaults" tests/db/calibration-link.test.ts && grep -n -a "samplingParams" prisma/schema.prisma && ls prisma/migrations | grep v2k_calibration_sampling_snapshot
```
Expected: launch.ts shows (at least) `samplingParams: SamplingParams;` in the result interface, `const { calibrationRun, wasAlreadyFrozen, samplingParams } = await prisma.$transaction(` and a `samplingParams,` in the return literal; calibration-link.test.ts shows `samplingDefaults` in `mkJudgeVersionWithEndpoint` and `mkWorld`; schema.prisma shows a **`samplingParams      Json?` member on `CalibrationRun`** under its `///` doclines (as well as the pre-existing `ModelJudgment.samplingParams`); and the migration directory `20260901180000_v2k_calibration_sampling_snapshot` exists. If ANY of the four is empty, STOP — execute `2026-09-01-calibration-sampling-snapshot.md` first. Do not improvise the snapshot here (one concern per commit).
(The third grep deliberately searches for `samplingParams`, not `samplingDefaults`: `JudgeModelVersion.samplingDefaults` already exists on `5e48187` at `schema.prisma:277`, so grepping for it passes whether or not the dependency landed and proves nothing. The v2k column and its migration are what actually gate the db tests below; catching their absence here rather than as a `P2022` at Step 2 keeps a STOP ahead of the first db write.)

Also re-confirm the test database target before the first db run:
```bash
grep DATABASE_URL /root/judge-arena/.env.test
```
Expected: six lines (two URL assignments, three comment lines, one more assignment). `DATABASE_URL` and `TEST_DATABASE_URL` are both `postgresql://judge_arena:…@localhost:5432/judge_arena_test` (the podman `judge-arena-pg`, NOT `judge-arena-pg-1`). `V1_DATABASE_URL` → `judge_arena_v1` on the same host is the importer's scratch DB and is expected; nothing in this plan touches it. Any other host or port on the first two lines is the wrong-cluster trap: STOP.

- [ ] **Step 1: Write the failing db tests**

In `/root/judge-arena/tests/db/calibration-link.test.ts`, insert this helper immediately after the closing `}` of `launchParamsFrom` (**:175-183** on `33b7be4` — round 2's `:154-162` was the pre-v2k position) and before the top-level `describe`, whose title is now `'v2i calibration ⇄ golden item link + v2k sampling snapshot (DB)'` (**:185**) — v2k renamed it, so do not search for the old `'v2i calibration ⇄ golden item link (DB)'` string:

```ts
/**
 * One judgment in this judge's HISTORY, carrying the two columns the
 * throughput estimate reads. Hung off its own ordinary Evaluation/Run so it
 * is history, not part of the calibration under test. `status` defaults to
 * completed; pass 'error' to plant a row that must NOT count.
 *
 * Deliberately does NOT set `reasoningContent` (defaults to `null`). Since
 * `token-accounting`, `judgeThroughputEstimate` reads it too and pools
 * `accountTokens(row).estimatedGeneratedTokens`, not raw `outputTokens` —
 * but with `reasoningContent: null`, `accountTokens` classifies every row
 * here `no_reasoning_channel` and returns `estimatedGeneratedTokens ===
 * outputTokens` exactly. So the four fixtures below (2 tok/s against
 * 6144/300000, etc.) are UNCHANGED by that plan: this file tests the WIRING
 * (does `launchCalibrationRun` call the right functions with the right
 * values), and Task 1's own unit test is what pins the reasoning-channel
 * arithmetic — duplicating it here would only be a slower copy of that test.
 */
async function mkHistoryJudgment(
  world: Awaited<ReturnType<typeof mkWorld>>,
  measure: { outputTokens: number | null; latencyMs: number | null; status?: 'completed' | 'error' }
) {
  const evaluation = await db.evaluation.create({
    data: { projectId: world.project.id, userId: world.user.id, inputText: 'history' },
  });
  const run = await db.evaluationRun.create({ data: { evaluationId: evaluation.id } });
  return db.modelJudgment.create({
    data: {
      runId: run.id,
      judgeModelVersionId: world.version.id,
      status: measure.status ?? 'completed',
      outputTokens: measure.outputTokens,
      latencyMs: measure.latencyMs,
    },
  });
}
```

Then append the following block INSIDE the top-level `describe`, at the very **END** — after the closing `});` of the LAST test of the dependency's block **(4)**, which on `33b7be4` starts at **:585** and is `it('a PARTIAL samplingDefaults is resolved field-by-field before it is stored — the header is never a copy of the raw JSON', …)` — and before the file's final `});`.

Section markers must stay monotonic: **(5) goes BELOW (4), never above it.** Do NOT anchor on `refuses a golden set with no live items`: that is the last test only on `5e48187`, and the dependency plan explicitly appends its (4) block after that same test (its `:467`: "Insert a new block at the END of the top-level `describe`, so the section markers stay monotonic … Do NOT insert after :426 — that would put a '(4)' block above the '(3)' one"). Anchoring on it here would invert (4) and (5). The body-end line `expect(await db.$transaction((tx) => isGoldenSetFrozen(tx, world.goldenSet.id))).toBe(false);` is also NOT unique — on HEAD it occurs at both `:490` and `:500` — so it is not usable as an anchor either way.

```ts

  // ── (5) The stacked-limits warning (runbook §8.6; register §5.6/8) ───────
  // (Block (4) is the v2k sampling snapshot, added by calibration-sampling-snapshot.)
  //
  // `max_tokens / tok_per_s` must fit under the HARD CAP, or a judgment that
  // needs its whole budget is ABORTED rather than truncated. Which wall,
  // precisely: NOT the 300 s provider timeout granite4.2 stalled on in
  // runbook §8.6 — 35 tok/s × 12288 is ~351 s, over 300 s but well under
  // 900 s, so this rule is correctly SILENT on granite and is not the check
  // that would have caught it. §8.7 made 300 s an alert that keeps waiting;
  // the hard cap is now the only wall that aborts. The live case is
  // qwen3.5:9b: its judge path always sends response_format: json_schema,
  // and outputTokens excludes the reasoning channel on this model, so the
  // rate has to be `judgeThroughputEstimate`'s accountTokens-derived pooled
  // figure, never raw outputTokens — measured against judge-arena-pg-1 on
  // 2026-09-02 at 12.0 tok/s (pooled over its 15 completed judgments):
  // 12288 / 12.0 = 1024 s against 900 s. (The db fixtures below use plainer
  // round numbers — 2 tok/s against 6144/300000 — chosen for the wiring
  // this task tests, not to reproduce that live figure; Task 1's own
  // `pools via accountTokens` unit test is what pins this arithmetic.) The
  // launch computes it from the judge's COMPLETED history and the RESOLVED
  // snapshot (`samplingParams`, v2k) and WARNS. It never refuses: the first
  // calibration of any judge has no history to measure.

  it('warns when the effective max_tokens cannot be produced inside the hard cap — and still launches', async () => {
    // `logger` is a plain object (`src/lib/logger.ts:104`), so a spy needs no
    // `vi.mock` and no hoisting — the same shape `tests/lib/backends.test.ts`
    // :263 / :294 uses. `vitest.db.config.ts` sets no `restoreMocks`, which is
    // why Step 3(f) adds `vi.restoreAllMocks()` to this file's `beforeEach`
    // (:186-191): a spy left installed by a mid-test failure would otherwise
    // swallow every later warn in the file and turn one red into a cascade.
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const world = await mkWorld({ items: 1, samplingDefaults: { temperature: 0.3, max_tokens: 12288 } });
    // 600 tokens in 300 s = 2.0 tok/s, so 12288 tokens take 6144 s, which
    // formatDurationMs renders `102m24s` (it has no hours unit).
    // Chosen far above the 900 s default and above MAX_HARD_CAP_MS (1170 s,
    // the value env.ts refuses at boot), so no hard cap this deployment can
    // legally run under makes 12288 tokens fit.
    await mkHistoryJudgment(world, { outputTokens: 600, latencyMs: 300_000 });

    const result = await launchCalibrationRun(launchParamsFrom(world), { publish: noopPublish });

    // NOT `.not.toBeNull()`: before the property exists, `budgetWarning` is
    // `undefined`, and `expect(undefined).not.toBeNull()` PASSES — an
    // assertion that cannot fail for the case it is guarding (CONTRIBUTING.md
    // :227-230, "a green test can be impossible to fail"). `typeof` goes red
    // for both `null` and `undefined`.
    expect(typeof result.budgetWarning).toBe('string');
    // The EFFECTIVE budget from the snapshot, not the registry default 4096.
    expect(result.budgetWarning).toMatch(/max_tokens 12288/);
    expect(result.budgetWarning).toMatch(/2\.0 tok\/s/);
    // `/n=1/` alone would also match `n=10`, `n=12`, `n=100` (failure mode 3,
    // the substring class). Pin the rendered CLAUSE so the sample size is
    // asserted in its role.
    expect(result.budgetWarning).toMatch(/n=1 completed judgment/);
    expect(result.budgetWarning).toMatch(/LOWER bound/);
    // A warning, not a refusal: the run launched.
    expect(result.accepted).toEqual([world.items[0].id]);
    expect(result.failed).toEqual([]);

    // ── The LOG, which is the only DURABLE record of this warning ─────────
    // The CLI print is transient stdout; `CalibrationLaunchResult` is gone
    // the moment the caller returns. Without this assertion the wrong
    // implementation that survives every other gate is: delete the whole
    // `if (budgetWarning !== null) { logger.warn(...) }` block, or ship it
    // with a mis-keyed payload. Three docs (the Architecture paragraph, the
    // runbook and the register DONE marker) claim this log exists, so it
    // gets an assertion and an injection like any other behaviour.
    // `toHaveBeenCalledTimes(1)`, and it is NOT brittle — the other three
    // `logger.warn` calls reachable from this path are all provably silent
    // here: launch.ts:212 fires only over MAX_CALIBRATION_ITEMS (this world
    // has 1 item), launch.ts:447 only when `failed` is non-empty (asserted
    // empty above), and run-launch.ts:661 only when `publish()` throws
    // (`noopPublish` cannot). If this count ever reads 2, something new is
    // warning on the happy path and that is worth knowing, not worth
    // loosening the assertion for.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [msg, payload] = warnSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toMatch(/cannot be produced inside the hard cap/);
    expect(payload).toMatchObject({
      calibrationRunId: result.calibrationRunId,
      judgeModelVersionId: world.version.id,
      maxTokens: 12288,
      warning: result.budgetWarning,
    });
    warnSpy.mockRestore();
  });

  it('a judge with no COMPLETED judgment gets no warning — first-ever judges must launch', async () => {
    const world = await mkWorld({ items: 1, samplingDefaults: { temperature: 0.3, max_tokens: 12288 } });
    // An ERRORED judgment with terrible numbers is present and must NOT
    // count: a call that timed out says the judge did not answer, not how
    // fast it answers.
    await mkHistoryJudgment(world, { outputTokens: 600, latencyMs: 300_000, status: 'error' });

    const result = await launchCalibrationRun(launchParamsFrom(world), { publish: noopPublish });

    expect(result.budgetWarning).toBeNull();
    expect(result.accepted).toEqual([world.items[0].id]);
  });

  it('a judge fast enough for its budget gets no warning', async () => {
    // Kept deliberately, though it looks redundant beside the errored-history
    // test: it is the ONLY test here that would go red if `hardCapMs` were
    // mis-wired (e.g. a hard-coded 0, or `resolveTimeoutBudgets()` dropped).
    // With hardCapMs = 0 the over-cap and RESOLVED-budget tests still warn
    // and the errored-history test still returns null — only a judge that
    // genuinely FITS discriminates. It is also the only end-to-end guard
    // against a false-positive warning on a healthy judge, which is the
    // failure mode an operator would actually notice.
    //
    // Qwen's measured envelope: 2869 output tokens in 49.0 s = 58.5 tok/s;
    // the registry-default 4096 budget exhausts in ~70 s against the cap
    // (900 s by default — this assumes the cap is not configured below 70 s).
    const world = await mkWorld({ items: 1 });
    await mkHistoryJudgment(world, { outputTokens: 2869, latencyMs: 49_000 });

    const result = await launchCalibrationRun(launchParamsFrom(world), { publish: noopPublish });

    expect(result.budgetWarning).toBeNull();
    expect(result.accepted).toEqual([world.items[0].id]);
  });

  it('reads the RESOLVED budget: a version pinning only temperature inherits max_tokens 4096 and is warned on it', async () => {
    // The raw samplingDefaults has NO max_tokens here. Only the resolver
    // (effectiveSamplingParams, per-field merge with the registry default
    // { temperature: 0.3, max_tokens: 4096 }) produces a number; a raw read
    // of `samplingDefaults.max_tokens` is `undefined`, the division is NaN,
    // and `!(NaN > cap)` is silence. 4096 / 2.0 tok/s = 2048 s, over any
    // cap this deployment can legally run under (MAX_HARD_CAP_MS is 1170 s).
    const world = await mkWorld({ items: 1, samplingDefaults: { temperature: 0.3 } });
    await mkHistoryJudgment(world, { outputTokens: 600, latencyMs: 300_000 });

    const result = await launchCalibrationRun(launchParamsFrom(world), { publish: noopPublish });

    expect(result.budgetWarning).toMatch(/max_tokens 4096/);
    expect(result.accepted).toEqual([world.items[0].id]);
  });
```

(The three fixtures above cannot tell a raw read from the resolved one: the first sets full defaults, so raw == resolved; the second expects null either way; the third sets no defaults, so a raw read with a hand-written `?? 4096` fallback also lands on 4096. The fourth pins the per-field merge — the one case where the header snapshot and the raw column disagree.)

- [ ] **Step 2: Run the db test file to verify it fails**

The migration chain is already applied to the test database by the last full `npm run test:db` (which `calibration-sampling-snapshot` ran). Run just this file, sourcing `.env.test` the way `package.json:18` does:

```bash
cd /root/judge-arena && ! pgrep -f '[v]itest' && sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/calibration-link.test.ts'
```
ONE `&&` chain, not an advisory `;`: this step does not fire `prisma migrate reset`, but it does run `beforeEach(truncateAll)` against the shared DB, which is what produces the `40P01 deadlock` / unique-slug noise documented in Global Constraints — and a red run from THAT during the TDD red step is indistinguishable from the red this step is trying to observe. If the line exits immediately with no output, a concurrent `vitest` is live: `pgrep -af "[v]itest"` to see it. If the run reports `column "samplingParams" does not exist` (Prisma `P2022`), the test database is not at v2k: run `npm run test:db` once to replay the migration chain, then repeat this step.

Expected: vitest does not type-check, so the file executes: the FOUR new tests FAIL. `result.budgetWarning` is `undefined` (the property does not exist yet). The over-cap test fails on its FIRST assertion, `expect(typeof result.budgetWarning).toBe('string')`, with `expected 'undefined' to be 'string'`. (This is why that assertion is not `.not.toBeNull()`: `toBeNull` is a strict `=== null` check — `@vitest/expect/dist/index.js:1240` — and `.not` inverts it, so `expect(undefined).not.toBeNull()` would PASS and the test would only fail one line later.) The RESOLVED-budget test fails at `toMatch(/max_tokens 4096/)` with `TypeError: .toMatch() expects to receive a string, but got undefined` (`@vitest/expect/dist/index.js:1165`); the two null-expecting tests fail with `expected undefined to be null`. All 17 pre-existing tests (13 on `5e48187` + 4 from the snapshot plan) stay green: **4 failed / 17 passed**.

Also confirm the type gap: `cd /root/judge-arena && npx tsc --noEmit` → errors in `tests/db/calibration-link.test.ts` of the form `Property 'budgetWarning' does not exist on type 'CalibrationLaunchResult'`.

- [ ] **Step 3: Write the implementation**

(a) `/root/judge-arena/src/lib/calibration/launch.ts` — imports. After the line

```ts
import { goldenItemLifecycleWhere, isGoldenSetFrozen } from '@/lib/golden-sets';
```

add:

```ts
import { budgetWarningFor, judgeThroughputEstimate } from '@/lib/calibration/latency';
```

(b) `CalibrationLaunchResult` — after the existing member

```ts
  frozeGoldenSet: boolean;
```

add (leave the `samplingParams: SamplingParams;` member the snapshot plan added wherever it is):

```ts
  /**
   * The stacked-limits warning (runbook §8.6), or `null` when the effective
   * `max_tokens` fits under the hard cap at this judge's measured throughput
   * — OR when the judge has no completed judgment to measure. A WARNING,
   * never a refusal: the run has launched either way. Callers fronting a
   * human should print it; the launch has already logged it. The figure in
   * it is a LOWER bound on duration (throughput decays with output length).
   */
  budgetWarning: string | null;
```

(c1) The QUERY — and it goes BEFORE the freeze, not after. Insert immediately BEFORE the line `  // ── The irreversible write ───────────────────────────────────────────────` (currently :316, i.e. after the `const deadlineAt = new Date(…)` statement that ends at :314):

```ts
  // ── The stacked-limits check, part 1 of 2: the measurement ────────────────
  // BEFORE the header write, and the placement is load-bearing. This module's
  // rule is stated at :33-37 — "EVERYTHING KNOWABLE UP FRONT IS CHECKED BEFORE
  // THE FREEZE … writing it is irreversible". Every `await` between the header
  // commit and the item loop is a new way for the function to throw with the
  // golden set frozen, the CalibrationRun header committed and ZERO items
  // launched; a purely ADVISORY warning must never be able to do that. This
  // query needs nothing from the transaction (only `judgeModelVersionId`), so
  // it belongs here, where a connection blip fails the launch exactly the way
  // the `$transaction` a few lines below would have failed it anyway — before
  // anything irreversible exists.
  //
  // `resolveTimeoutBudgets()` is called a second time here (the batch deadline
  // at :312-314 is the first). Deliberate and cheap: it reads `env` and does
  // arithmetic, and hoisting one shared const across the deadline comment
  // block would put an unrelated edit in the middle of THE REAPER FIX.
  //
  // The rate cannot come from the endpoint verify probe (verify.ts sends
  // max_tokens 1, and one token is not a rate) — only from this judge's own
  // completed history.
  const throughput = await judgeThroughputEstimate(judgeModelVersionId);
  const hardCapMs = resolveTimeoutBudgets().hardCapMs;

```

(c2) The RULE. `budgetWarningFor` is pure and needs the RESOLVED snapshot, so it — and only it — goes after the transaction. Insert immediately BEFORE the line `  // ── One item, one launch ─────────────────────────────────────────────────` (currently :381, after the `logger.info('launchCalibrationRun: golden set is now frozen (irreversible)', …)` call at :373-379):

```ts
  // ── The stacked-limits check, part 2 of 2: the rule (runbook §8.6) ────────
  // Pure, so it adds no failure point past the freeze. It reads the RESOLVED
  // `samplingParams` the transaction just snapshotted — the effective
  // max_tokens every judgment of this run will execute under — not the raw,
  // nullable samplingDefaults. A warning and never a refusal: a first-ever
  // judge has no completed judgment to measure, and refusing would make the
  // first calibration of every judge impossible.
  const budgetWarning = budgetWarningFor({ maxTokens: samplingParams.max_tokens, throughput, hardCapMs });
  if (budgetWarning !== null) {
    logger.warn("launchCalibrationRun: max_tokens cannot be produced inside the hard cap at this judge's measured throughput", {
      goldenSetId,
      calibrationRunId: calibrationRun.id,
      judgeModelVersionId,
      maxTokens: samplingParams.max_tokens,
      // The WHOLE estimate as one key, NOT `tokPerSec: throughput?.tokPerSec`
      // / `n: throughput?.n`. `budgetWarning !== null` already implies
      // `throughput !== null` — `budgetWarningFor` returns null on its first
      // line when the throughput is null — so each `?.` would contribute a
      // branch arm that NO test can ever make the deciding clause. launch.ts
      // is in the db coverage denominator (BRF:31 today), so those two dead
      // arms would be permanently-uncovered branches in the one task whose
      // coverage gate is knife-edge, and they are exactly the "unreachable
      // guard" class this plan invokes in Task 1 to justify its NaN row.
      throughput,
      hardCapMs,
      warning: budgetWarning,
    });
  }

```

(d) The return literal. Add `budgetWarning,` as the last property of the object returned at the end of `launchCalibrationRun`. Post-snapshot it reads:

```ts
  return {
    calibrationRunId: calibrationRun.id,
    accepted,
    failed,
    frozeGoldenSet: !wasAlreadyFrozen,
    samplingParams,
    budgetWarning,
  };
```
(If the snapshot plan placed `samplingParams` elsewhere in the literal, keep its position and still append `budgetWarning,` last.)

(e) `/root/judge-arena/scripts/calibration/run.ts` — after the line

```ts
    for (const f of launched.failed) console.log(`    ✗ ${f.goldenItemId}: ${f.reason}`);
```

and before `    if (launched.accepted.length === 0) throw new Error('Nothing was accepted — stopping before the poll.');`, add:

```ts
    // The stacked-limits warning (runbook §8.6). Printed under the launch
    // line, where the operator is looking: a warning that exists only in the
    // worker log is one nobody reads until the run has already stalled.
    if (launched.budgetWarning) console.log(`  ⚠ BUDGET  ${launched.budgetWarning}`);
```

(f) The test file's two new imports and one hook line — write these in Step 1, before the implementation, since they are part of the failing test. Line 1 becomes

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
```

add beside the existing `import { prisma } from '@/lib/db';` (:4):

```ts
import { logger } from '@/lib/logger';
```

and add one line to the top of the existing `beforeEach` (:186-191), above `await truncateAll();`:

```ts
    // No `restoreMocks` in vitest.db.config.ts. The budget-warning test spies
    // on logger.warn; a spy that survived a mid-test failure would silence
    // every later warn in this file.
    vi.restoreAllMocks();
```

- [ ] **Step 4: Run the db test file to verify it passes**

```bash
cd /root/judge-arena && ! pgrep -f '[v]itest' && npx tsc --noEmit && sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/calibration-link.test.ts'
```
Expected: tsc 0; PASS — 21 tests in the file (17 + 4).

- [ ] **Step 5: Injection**

Every run below is `&&`-guarded on `! pgrep -f '[v]itest'` for the same reason as Step 2: this file truncates the shared DB in `beforeEach`, and a red from a concurrent run would be mistaken for the injection's red.

Break (1) — the seam to the snapshot: in launch.ts change `maxTokens: samplingParams.max_tokens` to `maxTokens: 1`.
Run: `cd /root/judge-arena && ! pgrep -f '[v]itest' && sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/calibration-link.test.ts -t "cannot be produced"'`
Expected: FAIL on the first assertion with `expected 'object' to be 'string'` (`typeof null === 'object'` — 1 token at 2 tok/s fits any cap, so `budgetWarningFor` returned `null` and the effective budget is what the check must read). Restore.

Break (2) — the status filter, end to end: in `judgeThroughputEstimate` (latency.ts) remove `status: 'completed'` from the `where`.
Run: `cd /root/judge-arena && ! pgrep -f '[v]itest' && sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/calibration-link.test.ts -t "no COMPLETED judgment"'`
Expected: FAIL with `expected 'max_tokens 12288 cannot be produced …' to be null` — the errored row became a rate. Restore. (The unit suite catches this too; running it here proves the db wiring reads the same query.)

Break (3) — resolved vs raw, at the SOURCE of the value: injection (1) proves the seam exists, not which value flows through it (`maxTokens: 1` goes red for every implementation). Inside the header `$transaction` in launch.ts, the snapshot plan's callback ends with `return { calibrationRun: created, wasAlreadyFrozen: alreadyFrozen, samplingParams: resolved };`. Temporarily change that return to hand the check the RAW column with a fallback that is not the registry's:
```ts
    return {
      calibrationRun: created,
      wasAlreadyFrozen: alreadyFrozen,
      samplingParams: { ...resolved, max_tokens: (version.samplingDefaults as { max_tokens?: number } | null)?.max_tokens ?? 12288 },
    };
```
(`version` is the row the transaction already selected `samplingDefaults` from; the DB write on the line above still stores `resolved`, so only the value the check reads moves.)
Run: `cd /root/judge-arena && ! pgrep -f '[v]itest' && sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/calibration-link.test.ts -t "reads the RESOLVED budget"'`
Expected: FAIL with `expected 'max_tokens 12288 cannot be produced …' to match /max_tokens 4096/` — the raw column has no `max_tokens`, so the fallback, not the resolver, chose the budget. Restore.

Break (4) — the hard cap itself. This is the THIRD seam this task wires (`samplingParams.max_tokens`, `judgeThroughputEstimate(...)`, `resolveTimeoutBudgets().hardCapMs`) and injections (1)-(3) only cover the first two. The `a judge fast enough for its budget gets no warning` test exists for exactly this and must be SHOWN to discriminate, or it is the decoration CONTRIBUTING.md:210-234 is written against. In launch.ts change `const hardCapMs = resolveTimeoutBudgets().hardCapMs;` to `const hardCapMs = 0;`.
Run: `cd /root/judge-arena && ! pgrep -f '[v]itest' && sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/calibration-link.test.ts -t "fast enough for its budget"'`
Expected: FAIL with `expected 'max_tokens 4096 cannot be produced inside the 0ms hard cap …' to be null` — 4096 tokens at 58.55 tok/s is ~70 s, which fits the real 900 s cap and does not fit a zero one (`formatDurationMs(0)` is `0ms`). Run the whole file under this break to see the point: the other three new tests stay GREEN (the over-cap and RESOLVED-budget tests warn under any cap and assert nothing about the cap's rendering; the errored-history test returns null because there is no throughput at all), so **only a judge that genuinely FITS discriminates the cap**. Restore.

Break (5) — the LOG. Three documents claim this warning is logged (the Architecture paragraph, the runbook paragraph Task 4 writes, and the register DONE marker), and the log is its only durable record — the CLI print is transient stdout and `CalibrationLaunchResult` is gone when the caller returns. Delete the entire `if (budgetWarning !== null) { logger.warn(…) }` block from launch.ts.
Run: `! pgrep -f '[v]itest' && sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/calibration-link.test.ts -t "cannot be produced"'`
Expected: FAIL with `expected "spy" to be called 1 times, but got 0 times`, while `result.budgetWarning` is still the correct sentence — which is the whole point: every OTHER assertion in this task, all six unit describes, lint, tsc, coverage and build stay green under this break. Restore, then re-run and confirm the payload assertion also discriminates: change `warning: budgetWarning` to `warning: String(throughput)` and expect `toMatchObject` to fail on the `warning` key. Restore.

Confirm green: re-run the file → 21 passed.

Then verify the CLI print, and verify it as an ORDERING, not as a substring. A bare `grep -n -a "budgetWarning" scripts/calibration/run.ts` cannot prove what it claims: it passes if the line is commented out, if the condition is inverted to `if (!launched.budgetWarning)`, if the print is placed after the poll loop (by which time the run has already stalled — the exact case the warning exists for), or if it is placed inside the `if (scoreOnly)` branch where `launched` does not exist. That is the substring-match class (failure mode 3). Instead:

```bash
cd /root/judge-arena && grep -n -a "for (const f of launched.failed)\|launched.budgetWarning\|Nothing was accepted" scripts/calibration/run.ts
```
Expected: exactly THREE lines, with STRICTLY INCREASING line numbers in that order — the failed loop (currently :231), the new print, then the `Nothing was accepted` throw (currently :232, so the print lands between them). Then read the region back and check the condition is not negated and the line is a real `console.log`, not a comment:
```bash
cd /root/judge-arena && sed -n '228,240p' scripts/calibration/run.ts
```
Expected: `if (launched.budgetWarning) console.log(...)` — positive condition, no leading `//`.

**STATED GAP, in two parts.** (i) `scripts/calibration/run.ts` has no test file anywhere in the tree and is outside every coverage `include` (`vitest.config.ts:37`), so the CLI print is verified by the ordering check above and by running `npm run calibration:run` by hand, never by an injection. What bounds that gap: `launchCalibrationRun` has exactly one production caller — `scripts/calibration/run.ts:219`, verified with `grep -rn -a "launchCalibrationRun" src scripts tests` (the only other hits are `src/lib/run-launch.ts:331`, a comment, and the db test file). (ii) That bound is about MISSING SURFACES, and it is narrower than it looks: `run.ts`'s OTHER operator entry point, `--score-only` (:162-171), skips the launch entirely, reads the header's `samplingParams` and prints the snapshot with NO budget check beside it — and that is the path an operator uses on a run that has already stalled. `--score-only` is deliberately OUT OF SCOPE here (the run it scores is already launched; extending it needs `judgeModelVersionId` added to that `findUnique` select plus a second untested surface, which is a second concern). Do not read "exactly one production caller" as "every operator surface is covered". Also out of scope, and for the same reason: the API's own launch paths (`src/app/api/evaluations/[id]/runs/route.ts:84`, `src/app/api/evaluations/route.ts:303 / :494 / :605`) run under the same sampling defaults and the same cap and get no warning.

- [ ] **Step 6: Gates (full)**

```bash
cd /root/judge-arena && grep -q 'localhost:5432/judge_arena_test' .env.test && ! pgrep -f '[v]itest' && npm run lint && npx tsc --noEmit && npm run test:coverage && npm run test:db:coverage && npm run test:integration && npm run build
```
One `&&` chain: a wrong `.env.test` target or a live concurrent `vitest` aborts before `prisma migrate reset` fires (shared, non-concurrency-safe test DB — Global Constraints).
This is the FULL six-gate chain, without the Task 1/2 deviation: this is the commit that actually enters the db run (it makes `launch.ts` import `latency.ts`), so it is where the db count moves and where the Owner coverage decision is measured for real.
Expected: lint 0; tsc 0; unit green (count unchanged from Task 2); db green with 4 more tests than the post-snapshot baseline (674 + 4 = **678** if nothing else has landed); integration 82; build exits 0. Note the printed unit and db counts.

**On db coverage — this is the Owner decision, already taken.** The floors are `lines 47 / functions 60 / branches 77 / statements 47` at `vitest.db.config.ts:149-156`. `launch.ts` is measured here, AND this task loads `latency.ts` into the db run for the first time. Per the Facts bullet, that swaps a `1/1` not-imported artifact for ~67 real branches at ~18 hit and takes the all-files BRANCHES aggregate from a MEASURED **1001/1286 = 77.84%** (`coverage-db/lcov.info` on `33b7be4`) to ~**1018/1352 = 75.30%** against the 77 floor — a FAIL of ~1.7pp, not the "~-0.1pp, expected to pass" an earlier draft of this plan claimed. Option (a) has been checked against the same file and keeps all four floors green (branches 1000/1285 = 77.82%, functions 269/419 = 64.20%, lines 4745/9165 = 51.77%). So:

1. **Do not start Task 3 until the Owner decision at the top of this plan has been made** — (a) exclude `src/lib/calibration/latency.ts` from `vitest.db.config.ts`'s `coverage.exclude`, (b) re-baseline the db floors by the config's own procedure, or (c) restructure. If (a) was chosen, that config change is part of THIS task's commit (it is the same concern: making the db run's coverage report honest about a module it only loads); it must carry the explanatory comment described in option (a) at the top of this plan — never a bare path string — and the commit body must repeat the reason.
2. **Then measure, before writing any commit:** run `npm run test:db:coverage` and read the printed all-files BRANCHES and FUNCTIONS rows and the `latency.ts` row.
3. If the printed all-files branches is **< 77** (or functions < 60) after the chosen option: **STOP.** Do not lower a floor, do not add filler tests to push the number; report the printed numerator/denominator to the owner. The re-baseline procedure documented in `vitest.db.config.ts` (three runs, lowest value, policy buffer) is an owner decision, never an executor's.

- [ ] **Step 7: Commit**

```bash
git -C /root/judge-arena add src/lib/calibration/launch.ts scripts/calibration/run.ts tests/db/calibration-link.test.ts
# …and `vitest.db.config.ts` ONLY if the owner chose option (a) in Step 6.
git -C /root/judge-arena commit -F - <<'EOF'
feat(calibration): warn at launch when max_tokens cannot fit the hard cap

Register §5.6/8: "two limits are stacked and only one is visible … the check
wants to be code." `launchCalibrationRun` now runs it, in two halves and the
split is deliberate. The QUERY (`judgeThroughputEstimate`) runs BEFORE the
header transaction: this module's rule is "everything knowable up front is
checked before the freeze" (launch.ts:33-37), and an await placed past the
irreversible header commit is a new way to end with a frozen golden set, a
committed CalibrationRun and zero launched items — which an advisory warning
must never be able to cause. The RULE (`budgetWarningFor`) is pure and runs
after, because it reads the RESOLVED `samplingParams` snapshot the
transaction produced (the effective max_tokens every judgment of this run
executes under), never the raw samplingDefaults. When max_tokens / tok_per_s
is over `resolveTimeoutBudgets().hardCapMs` it logs `logger.warn` — asserted
by a spy in the db test, because that log is the only durable record — and
returns the sentence as `CalibrationLaunchResult.budgetWarning`. The CLI
prints it as `⚠ BUDGET …` directly under the launch line.

Which wall, precisely: NOT granite4.2's 300 s provider stall (35 tok/s ×
12288 ≈ 351 s, over 300 s and well under 900 s), on which this rule is
correctly silent. Runbook §8.7 made 300 s an alert that keeps waiting, so
the hard cap is the only wall that aborts, and that is what is compared
against. The live case is qwen3.5:9b: outputTokens excludes the reasoning
channel on this model (the judge path always sends response_format:
json_schema), so the rate is judgeThroughputEstimate's accountTokens-derived
pooled figure, never raw outputTokens — measured at 12.0 tok/s against
judge-arena-pg-1 on 2026-09-02: 12288 / 12.0 = 1024 s.

Scope, recorded rather than implied: calibration launch only. `--score-only`
and the API's single/bulk run launches are not covered, and silence is not a
clean bill — the flat-rate estimate understates the tail ~51% at 12k tokens.

WARNS, NEVER REFUSES. A first-ever judge has no completed judgment to
measure, so null covers both "fits" and "no history"; the db test plants an
ERRORED judgment with terrible numbers and asserts it does not count. The
check is at launch, not at endpoint verify, because verify.ts probes with
max_tokens 1 and one token is not a rate. The text states the figure is a
LOWER bound: throughput decays with output length (handoff §8).

Four db tests: over-cap warns and still launches; errored history only →
null; fast judge → null; a version pinning only temperature is warned on
the INHERITED max_tokens 4096 — the one fixture where the raw column and
the resolved snapshot disagree. The over-cap fixture is 2 tok/s against
12288 (6144 s, rendered 102m24s), far above the 900 s default and above MAX_HARD_CAP_MS
(1170 s, the value env.ts refuses at boot), so no hard cap this deployment
can legally run under makes it fit. Injections run and restored: maxTokens
hard-wired to 1 (red — the seam exists); the transaction handed the check
the raw column with a 12288 fallback (red on the partial-defaults test —
the resolver, not a fallback, chooses the budget); status filter dropped
(red — the errored row became a rate); hardCapMs forced to 0 (red on the
fast-judge case, and ONLY on it — the cap is read from
resolveTimeoutBudgets, not assumed); the whole logger.warn block deleted
(red on the spy, and green everywhere else — which is exactly why the spy
had to be added). The CLI print has no injection and cannot have one: the
script has no test file and is outside every coverage include. It is
verified as an ORDERING instead — failure loop, then the print, then the
"Nothing was accepted" throw, with the condition read back unnegated.

Gates: lint 0, tsc 0, <N> unit / <M> db / 82 integration, coverage 0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
EOF
```
Replace `<N>` / `<M>` with the printed unit and db counts.

---

### Task 4: Docs — runbook §8.6 says the launch now warns; register §5.6/8 marked done with a CORRECTION

**Files:**
- Modify: `/root/judge-arena/docs/runbooks/scoring-a-judge-against-a-golden-set.md:485-487` (insert a paragraph after the "Get `tok_per_s` from a single scored item …" paragraph, before `**Recognising which limit you hit:**` at :489)
- Modify: `/root/judge-arena/docs/superpowers/plans/2026-08-30-state-and-next-steps.md:438-442` on `33b7be4` (append to item 8; `calibration-sampling-snapshot` inserts lines after :423, so locate item 8 with `grep -n "Two limits are stacked" docs/superpowers/plans/2026-08-30-state-and-next-steps.md` and anchor on the quoted text below, not on the line numbers)

**Interfaces:**
- Consumes: the short SHA of Task 3's commit — `git -C /root/judge-arena log -1 --format=%h --grep='warn at launch when max_tokens cannot fit the hard cap'`.
- Produces: nothing code-facing.

- [ ] **Step 1: Capture the commit SHA**

```bash
git -C /root/judge-arena log -1 --format=%h --grep='warn at launch when max_tokens cannot fit the hard cap'
```
Expected: one 7-char SHA. Use it as `<SHA>` below.

- [ ] **Step 2: Runbook §8.6**

> **ANCHOR RE-BASED (2026-09-02, `db5bff9`).** This step originally anchored on a three-line
> paragraph at `:485-487` beginning "Get `tok_per_s` from a single scored item". The
> token-accounting plan (`2026-09-02-token-accounting-and-truncation-proximity.md`) **rewrote that
> paragraph**, because deriving `tok_per_s` from `outputTokens` is the very defect it fixes:
> `outputTokens` omits the reasoning channel on some models, so that formula returned ~0.54 tok/s
> for `qwen3.5:9b` where the pooled `accountTokens`-derived rate is **12.0 tok/s** (12.032 measured
> over ordinal 2's 15 completed judgments; see the round-4 CORRECTION in the Facts block, which is
> the authoritative derivation — an earlier draft of this note said "~11.1", carried over from a raw
> Ollama probe rather than the pooled production figure).
>
> **DO NOT anchor on the old sentence.** It still occurs exactly once in the file — *quoted inside
> that plan's CORRECTION note* — so a text match on it would insert this paragraph inside a
> correction block, in the wrong section. Confirm before editing:
> `grep -n "from a single scored item" docs/runbooks/scoring-a-judge-against-a-golden-set.md`
> must return exactly ONE line, and that line must be inside the `> **CORRECTION` block. If it
> returns two or zero, stop and re-read §8.6 before touching anything.

In `/root/judge-arena/docs/runbooks/scoring-a-judge-against-a-golden-set.md`, §8.6 now ends its
first paragraph with the text below (currently `:534-545`; locate it by this text, not the number):

```markdown
`estimatedGeneratedTokens` is `accountTokens()` in `src/lib/calibration/token-accounting.ts`, and
`npm run calibration:run` prints it in the **Token accounting** block of every report, beside the
raw `outputTokens` and character counts it was derived from. The recorded envelopes for every judge
scored so far are in
[`docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md`](../superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md) §2.
```

Insert directly after it (blank line before and after), i.e. between the end of that paragraph and
the `> **CORRECTION (2026-09-02, ...` block that follows:

```markdown
**As of `<SHA>` the launch runs the FIRST of the two formulas above for you — and it runs the same
`accountTokens()`-derived version this section already describes, not a raw `outputTokens` count.**
`launchCalibrationRun` pools the judge's throughput over its *completed* judgments
(`Σ accountTokens(row).estimatedGeneratedTokens / Σ (latencyMs / 1000)`, via `accountTokens` —
`judgeThroughputEstimate` in `src/lib/calibration/latency.ts`) and,
when `time_to_exhaust_budget` exceeds the hard cap, logs a warning and returns it as
`CalibrationLaunchResult.budgetWarning`; `npm run calibration:run` prints it as `⚠ BUDGET …` directly
under the launch line. **It warns and never refuses.** The second formula (`max_safe_tokens =
timeout_s × tok_per_s`) is deliberately NOT automated: per §8.7 the 300 s initial budget now warns
and keeps waiting rather than aborting, so it is no longer a ceiling a launch can fail against.

**Four things "no warning" does not mean.** (1) A first-ever judge has no completed judgment, so it
gets silence by construction — do the arithmetic above by hand for a judge's first run. (2) The rule
compares the *optimistic* flat-rate estimate, and §5.4.1 of the scoreboard spec measures that model
as ~51% optimistic at 12k tokens; a judge whose estimate lands above roughly two-thirds of the cap
can still abort at it unwarned, so treat anything over ~600 s of estimate as needing the manual
check. The figure the warning prints is a **lower bound** on duration, never an estimate. (3) The
cap it compares against is the **launcher's** `EVALUATION_MODEL_HARD_CAP_MS` — the environment of
the process running `npm run calibration:run` — while the abort happens in the *worker* pod, which
reads its own. Confirm the two match before trusting a silent result (the launch's batch deadline
already makes the same assumption). (4) It runs at **calibration launch only**: `--score-only`
re-scores an already-launched run and does not check, and ordinary or bulk runs launched through the
API are not covered at all.

It is measured at launch, not at endpoint verification — the verify probe sends `max_tokens: 1`,
which cannot yield a rate.

> **CORRECTION (added with `<SHA>`).** The narrative at the top of this §8.6 records granite4.2
> stalling on the **300 s provider timeout** at 12288 tokens. That wall no longer aborts (§8.7), and
> the automated check above would have been *silent* on granite: 35 tok/s × 12288 ≈ 351 s, which
> fits the 900 s hard cap. The check guards the hard cap, which is the only remaining abort. The
> case it does catch is qwen3.5:9b — the judge whose `outputTokens` excludes the reasoning channel
> entirely, per this section's `accountTokens()` discussion above — measured against
> `judge-arena-pg-1` on 2026-09-02 at 12.0 tok/s (pooled over its completed judgments):
> 12288 / 12.0 ≈ 1024 s.
```

- [ ] **Step 3: Register §5.6/8**

In `/root/judge-arena/docs/superpowers/plans/2026-08-30-state-and-next-steps.md`, item 8 currently reads (**:438-442** measured on `33b7be4` — it has ALREADY moved down from the :432-436 an earlier draft cited, exactly as this plan predicted; it may move again, so match on the text):

```markdown
8. **Two limits are stacked and only one is visible.** Fixing truncation by raising `max_tokens`
   exposed a timeout ceiling underneath it (`max_tokens / tok_per_s` must fit the hard cap). Nothing
   validates that relationship at registration, though both inputs are known: the endpoint verify step
   could measure `tok_per_s` on its probe call and refuse — or warn on — a budget the timeout cannot
   afford. Runbook §8.6 documents the manual check; **the check wants to be code.**
```

`<DATE>` below is the COMMIT date, read from the commit itself — `git -C /root/judge-arena log -1 --format=%cs <SHA>` — and never hard-coded. (This plan was authored 2026-09-01 and re-verified 2026-09-02 with the dependency still unlanded, so the commit this note cites cannot be dated 2026-09-01; a wrong date inside a DONE marker is exactly the class of doc claim CONTRIBUTING.md:1653-1656 exists to prevent.)

Append directly after the line ending `**the check wants to be code.**` (same 3-space indent, no blank line, before `9. **\`reasoningTokens\` from Ollama`):

```markdown
   **DONE `<DATE>`, `<SHA>`** — `launchCalibrationRun` pools the judge's throughput over its
   completed judgments (`judgeThroughputEstimate`, `src/lib/calibration/latency.ts`) and, when
   `max_tokens / tok_per_s` exceeds `EVALUATION_MODEL_HARD_CAP_MS`, logs a warning and returns it as
   `CalibrationLaunchResult.budgetWarning`; `npm run calibration:run` prints it under the launch line.
   Warns, never refuses (a first-ever judge has no history). **CORRECTION** to the sentence above:
   the endpoint verify step can NOT measure `tok_per_s` on its probe call — `verify.ts` probes with
   `max_tokens: 1`, and one token is not a rate — so the check lives at launch over
   `ModelJudgment.outputTokens` / `latencyMs` / `reasoningContent` history, read through
   `accountTokens()` (`src/lib/calibration/token-accounting.ts`) rather than off raw `outputTokens` —
   which does not count the reasoning channel on every model — and the linear figure is stated as a
   LOWER bound on duration (spec §5.4.1: throughput decays with output length). **Scope, so this DONE
   marker is not read wider than it is:** it guards the 900 s HARD CAP — the only wall that still
   aborts after §8.7 made the 300 s budget an alert — and it runs at calibration launch only. It would
   have been silent on the granite4.2 case that prompted this item (35 tok/s × 12288 ≈ 351 s, inside
   900 s); the case it catches is qwen3.5:9b, whose `outputTokens` excludes the reasoning channel
   entirely, at 12.0 tok/s (≈ 1024 s). `--score-only` and the API's single/bulk run launches are NOT
   covered, and an estimate under but near the cap is silent because the flat-rate model understates
   the tail. Runbook §8.6 states all four limits.
```

- [ ] **Step 4: Verify the docs edits are the only change and read them back**

```bash
git -C /root/judge-arena status --short && git -C /root/judge-arena diff --stat && grep -n -a "DONE \`<SHA>\`" docs/superpowers/plans/2026-08-30-state-and-next-steps.md && grep -n -a "the launch runs the FIRST of the two formulas" docs/runbooks/scoring-a-judge-against-a-golden-set.md
```
(Substitute the real SHA into the first grep — the literal `<SHA>` will not be in the file.)
Expected: exactly the two `.md` files modified; both greps return one line each, and the `<SHA>` in each matches Step 1's output (`grep -c "<SHA>"` on each file → 1). Also confirm the `<DATE>` in the register note equals `git -C /root/judge-arena log -1 --format=%cs <SHA>` and is NOT `2026-09-01`.

- [ ] **Step 5: Injection (docs)**

Not applicable to prose — there is no test to go red. The verification is Step 4's grep plus reading the rendered diff once: `git -C /root/judge-arena diff` must show the runbook paragraphs inserted between the "Get `tok_per_s`…" paragraph and `**Recognising which limit you hit:**` (currently :489), and the register block inside item 8 (before item 9's `9. **\`reasoningTokens\` from Ollama`). Read the inserted runbook CORRECTION block back once and check it against §8.7 (:494-503) rather than against memory: the claim it makes — that 300 s warns and only the hard cap aborts — is §8.7's, and if §8.7 has since changed, this paragraph is wrong the moment it lands.

- [ ] **Step 6: Gates**

```bash
cd /root/judge-arena && npm run lint
```
Expected: 0 (docs-only change; the full suite was green at Task 3's commit and no source file moved).

**Deviation from Global Constraints, stated:** the Gates bullet says all six gates run before every commit. This docs-only commit runs `npm run lint` alone. Justification: no source file, test file or config moved since Task 3's green full run, so `tsc`/`test:coverage`/`test:db:coverage`/`test:integration`/`build` cannot produce a different answer — and the `Gates:` line in Step 7 is explicitly labelled *last measured at `<SHA>`* rather than presented as re-measured. If anything other than the two `.md` files shows in Step 4's `git status --short`, this deviation does not apply: run the full chain.

- [ ] **Step 7: Commit**

```bash
git -C /root/judge-arena add docs/runbooks/scoring-a-judge-against-a-golden-set.md docs/superpowers/plans/2026-08-30-state-and-next-steps.md
git -C /root/judge-arena commit -F - <<'EOF'
docs(calibration): register §5.6/8 done — the stacked-limits check is code

Runbook §8.6 now says the launch runs the FIRST of its two formulas
(<SHA>): warns, never refuses, prints under the launch line, lower bound on
duration. It also states the four things silence does NOT mean — no history,
an estimate near but under the cap, the launcher's env vs the worker's, and
calibration launch only — and carries a CORRECTION recording that the check
would have been silent on the granite4.2 stall this section narrates, because
that was the 300 s provider wall and §8.7 made 300 s an alert. The second
formula (max_safe_tokens vs the initial budget) is deliberately not automated
for the same reason.

Register item 8 is marked DONE with a CORRECTION: its proposal to measure
tok_per_s "on the verify probe" cannot work, because verify.ts sends
max_tokens 1 — the rate has to come from ModelJudgment.outputTokens /
latencyMs history, which is where the code reads it.

Gates: lint 0 (docs only; full chain last green at <SHA>: lint 0, tsc 0,
<N> unit / <M> db / 82 integration, coverage 0).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
EOF
```
Replace `<SHA>`, `<N>`, `<M>` with Step 1's SHA and Task 3's counts.

---

## Self-review

1. **Spec coverage.** Register §5.6/8 "the check wants to be code" → Tasks 1-3. Binding U1 shape: `judgeThroughputEstimate(judgeModelVersionId, client = prisma): Promise<{ tokPerSec; n } | null>` in latency.ts following :162-177 (Task 1, exact signature); check AFTER the transaction using the resolved `samplingParams` (Task 3c); `budgetWarning: string | null` on `CalibrationLaunchResult` (Task 3b); warn never refuse (Tasks 2-3, tested by the errored-history and first-ever cases); LOWER-bound statement (Task 2 text + test; runbook + register wording in Task 4); CLI prints after the launch line (Task 3e); unit tests in `tests/lib/calibration-latency.test.ts` for null-on-no-rows, correct tok/s on two rows, null-/zero-/non-finite-`outputTokens` excluded (Task 1) plus the rule, including the NaN-is-silence case (Task 2); db tests in `tests/db/calibration-link.test.ts` for over-cap → non-null and fast judge → null (Task 3); runbook §8.6 line and register §5.6/8 marked done with the commit (Task 4).
2. **Placeholder scan.** No TBD/TODO; every code step shows the code. Re-scanned in revision round 2: the placeholders are exactly `<N>` (printed unit count), `<M>` (printed db count), `<BASE>` (the SHA the db/integration numbers were last green at, for Tasks 1-2's stated deviation), `<SHA>` (Task 3's commit, read by `git log --grep` in Task 4 Step 1) and `<DATE>` (`git log -1 --format=%cs <SHA>`, new in round 2 — it replaces a hard-coded `2026-09-01` in the register DONE marker that no step told the executor to substitute). Each has the command that produces it at the step that consumes it. The only other literal is `82 integration` in each `Gates:` template, which Task 1 Step 7 instructs the executor to overwrite with the printed value if it differs.
2b. **Injection coverage (re-checked 2026-09-02, extended in revision round 2).** Every behaviour this plan calls a decision now has an injection, and every seam this plan wires has one:
   - Task 1 — pooling vs. mean-of-rates; the `latencyMs <= 0` guard; the null/zero/absent-token exclusion (the deliberate U1 deviation — **redesigned in round 4**, see below); the `status: 'completed'` filter; **(5)** both `Number.isFinite` arms deleted; **(6, round 3)** `judgeModelVersionId` dropped from the WHERE — the `OTHER_JUDGE` fixture row existed for that scope and had no injection behind it; **(7, round 3)** a third (now fourth) column added to the `select`, which is red only because that assertion was tightened from `toMatchObject` to `toEqual` (the fake ignores `select` entirely, so a subset match could not discriminate the full-table read the test claims to prevent). (5) closes an unreachable-guard gap: the old fixtures held only `null`, `0` and positive integers, so `typeof x !== 'number'` short-circuited first and the isFinite arms were never the deciding clause — yet `ThroughputRow` is exported public surface and `NaN <= 0` is `false`, so those arms are not redundant. Two rows (`outputTokens: NaN`, `latencyMs: Infinity`) were added to the two exclusion tests; their expected results are unchanged. **(3, redesigned in round 4):** once `summarizeThroughput` delegated token classification to `accountTokens` (round 4), the `outputTokens <= 0` guard it used to own no longer exists in this file — `accountTokens` already returns `estimatedGeneratedTokens: null` for such a row, tested in `tests/lib/calibration-token-accounting.test.ts`. The injection here now breaks the PROPAGATION instead (coalescing `accountTokens(row).estimatedGeneratedTokens ?? 0`, which lets an unmeasurable row join the pool as a zero-token measurement — the same direction and the same safety argument as before, red at `{33.33, n:3}` vs `{100, n:1}`). **(8, round 4, new):** the defect this whole task exists to prevent — reverting the derived-token line to raw `row.outputTokens` — gets its OWN dedicated injection against the new `pools via accountTokens…` test (rows shaped like qwen3.5:9b: small `outputTokens`, large `reasoningContent`), because every other fixture in the file uses `reasoningContent: null`, where the two formulas agree by construction and would stay green under this exact regression. Red at 0.478 tok/s vs the expected ~12.27.
   - Task 2 — the strict `>` boundary; the LOWER-bound sentence; the two `formatDurationMs` arguments swapped (which is why the two duration assertions pin phrases, not bare substrings); the `throughput === null` warn-never-refuse early return; **(5)** the guard rewritten as `estimatedMs <= hardCapMs`; **(6, round 3)** the comparison pointed at the literal `900_000` instead of the `hardCapMs` parameter. (6) closes a parameter that no test varied: all five original fixtures passed `900_000`, which is byte-identical to `DEFAULT_HARD_CAP_MS` (`timeout-policy.ts:55`), so an implementation reading the constant instead of the argument passed every one of them and rendered the identical string. A sixth fixture at a 60 s cap was added for it. (5) closes a documented-decision-with-no-test gap: the JSDoc calls the `!( … > …)` form's NaN-swallowing load-bearing and Task 3's RESOLVED-budget test comment rests on it, but the four original cases all pass under `<=` (210051 ≤ 900000, 900000 ≤ 900000, 1024000 > 900000, no-history returns early) while rendering `max_tokens NaN …` to the operator. Hence the fifth unit test.
   - Task 3 — `maxTokens` hard-wired to 1 (the first seam); the raw column with a non-registry fallback (resolved-vs-raw at the source); the status filter end to end; **(4)** `hardCapMs` forced to 0; **(5, round 3)** the whole `logger.warn` block deleted. (5) closes a behaviour four documents assert and no test did: the log is the feature's ONLY durable record (the CLI print is transient stdout, the result object is gone when the caller returns), and deleting the block left every db assertion, all six unit describes, lint, tsc, coverage and build green. A `vi.spyOn(logger, 'warn')` — the shape `tests/lib/backends.test.ts:263` uses, and it needs no `vi.mock` because `logger` is a plain object — was added to the over-cap db test, with `vi.restoreAllMocks()` in the file's `beforeEach` so a mid-test failure cannot leak the spy. (4) closes the plan's own admission: the `fast enough for its budget` test was argued at length as the ONLY case that discriminates a mis-wired `hardCapMs` — the third seam, and the one input `budgetWarningFor` cannot self-test because it takes it as a parameter — and was then never shown to go red.
   - Task 4 is prose and has none; its verification is the Step 4 grep plus reading the diff. The CLI print in `scripts/calibration/run.ts` has none either, and that is a STATED GAP at the end of Task 3 Step 5 rather than an aside: no test file exists for that script anywhere in the tree and it is outside every coverage `include`. **Round 3 replaced the gap's verification and narrowed its bound.** The old `grep -n -a "budgetWarning" scripts/calibration/run.ts` could not prove what it claimed — it passes on a commented-out line, an inverted condition, a print placed after the poll loop, or one placed in the `--score-only` branch (failure mode 3) — so it is now an ORDERING check (failed loop :231 → the print → the `Nothing was accepted` throw :232, strictly increasing) plus a `sed -n` read-back of the condition. And "exactly one production caller" (`run.ts:219`, re-verified) bounds MISSING SURFACES, not correctness: `run.ts`'s `--score-only` entry point (:162-171) prints the sampling snapshot with no budget check, which is now recorded as an explicit out-of-scope decision rather than left to read as full coverage.
3. **Type consistency.** `ThroughputEstimate { tokPerSec: number; n: number }`, `ThroughputRow { outputTokens: number | null; latencyMs: number | null; reasoningContent: string | null }` (round 4 adds `reasoningContent`, spelled identically everywhere it appears — the interface declaration, every literal fixture in Task 1's tests, the `FakeJudgment` type and the `fakeJudgeClient` projection), `summarizeThroughput`, `judgeThroughputEstimate(judgeModelVersionId: string, client: JudgeLatencyClient = prisma)`, `BudgetWarningInput { maxTokens; throughput; hardCapMs }`, `budgetWarningFor(input): string | null`, `accountTokens` (consumed, not produced, by this plan — its shape is `{ outputTokens?: number | null; reasoningContent?: string | null } -> TokenAccounting`, and `ThroughputRow`'s structural superset of that input type-checks without an excess-property error because `row` is passed as a typed variable, not an object literal), and `CalibrationLaunchResult.budgetWarning: string | null` are spelled identically in Tasks 1-4 and in the test code. `mkHistoryJudgment` is defined in Task 3 Step 1 and used only there. The rule reads `samplingParams.max_tokens` — the `SamplingParams` shape from `src/lib/llm/sampling.ts` (`{ temperature: number; max_tokens: number }`, verbatim from `registry.ts:414-417` today) that the snapshot plan moves. Re-checked 2026-09-02 against the dependency plan as it stands on disk — the line numbers below were re-measured in revision round 2, because the dependency plan has itself been revised and every number an earlier draft cited (`:667`/`:727`/`:748`/`:768`/`:421`/`:458`) had drifted; the quoted SHAPES were all correct: its **`:690`** declares `samplingParams: SamplingParams;` on `CalibrationLaunchResult`, its **`:750`** returns `{ calibrationRun: created, wasAlreadyFrozen: alreadyFrozen, samplingParams: resolved }` from the header `$transaction` (the exact line Task 3 injection (3) rewrites), its **`:771`**/**`:791`** add `samplingParams` to the logger payload and the return literal, and its **`:423`**/**`:460`** add `samplingDefaults?: Prisma.InputJsonValue` to `mkJudgeVersionWithEndpoint`/`mkWorld`. Every one of those edits is anchored on the quoted text, not the number, so the drift changed nothing operationally. `src/lib/llm/sampling.ts` does not exist on `5e48187` — the dependency's Task 1 creates it — which is why Task 3 Step 0 is a hard pre-flight and not a courtesy check.
4. **The null-not-zero contract matches the existing shape.** `judgeLatencyBaseline` (`latency.ts:162-177`) selects over `status: 'completed'` only and returns `summarizeLatencies(...)`, which is `null` for an empty or all-null sample (module doc `:17-27`). `judgeThroughputEstimate` is the same three lines with a second column, and `summarizeThroughput` returns `null` — never `{ tokPerSec: 0 }` — for the same stated reason (`max_tokens / 0` is `Infinity`). `budgetWarningFor` maps that `null` to `null`, so a first-ever judge with no history WARNS NOTHING and launches; the four db tests and the `says nothing when there is no history` unit test pin it, and Task 2 injection (4) proves the pin discriminates.
5. **The estimate is a LOWER bound and every layer says so.** The unit test asserts `/LOWER bound/` on the rendered sentence (Task 2), the injection that deletes the caveat goes red, the JSDoc and the module PUBLIC SURFACE entry state it, the db test asserts `/LOWER bound/` end to end (Task 3), and both doc edits repeat it with the spec citation (Task 4). The underlying measurement is spec §5.4.1's per-length table at `:423-426` (post-v2k; `:402-405` was the round-2 figure): granite4.2 ran 35.9 tok/s at 4,567 tokens and 23.2 tok/s at 12,288, so a flat-rate `max_tokens / tok_per_s` predicted 351 s where the real answer was 529 s — off by 51%. A budget that "just fits" at the pooled rate does not fit.
6. **Revision round 1 (2026-09-02, against `5e48187`).** Corrected: the suite baselines (869/80 → 877/82, and the post-dependency start point 887/673/82 — **CORRECTION, round 2: the db figure in that round-1 sentence was itself wrong; it is 674, not 673. See #7**); the handoff (`364-367` → `403-406`) and spec (`388-403` → `398-414`, table `:394` → `:402-405`) citations; the two `CONTRIBUTING.md` citations (`:1560` → `:1639`, `:1571-1574` → `:1653-1656`); the "main is 4 docs-only commits ahead" claim; the false `scripts/importer/runs.ts:491` claim in a JSDoc that would have landed in source (`latencyMs` IS carried across at `:491`; it is `outputTokens` that is nulled, at `:494`); the `src/lib/**` per-glob claim (there is no such override); the advisory `;` in the db safety guard (now one `&&` chain); the two bare duration `toContain`s (now phrase-pinned) and the `.not.toBeNull()` that could not fail; the unbounded `EVALUATION_MODEL_HARD_CAP_MS` advice; and — the big one — the db branch-coverage estimate, which was off by ~2.5pp because it treated the v8 not-imported artifact as contributing 0 branches when it contributes 1/1. That last one is now an Owner decision at the top of this plan, not a discovery at Task 3 Step 6. Anchors that reviewers flagged but which were re-verified as STILL CORRECT and therefore left alone: runbook `§8.6 :461-492` / `:485-487` / `:489`, register item 8 at `:432-436`, `CONTRIBUTING.md:210-234`, and every `latency.ts` / `launch.ts` / `run.ts` / `schema.prisma` / test-file line number in the Facts block.
7. **Revision round 2 (2026-09-02, against `5e48187`).** Corrected, each verified by opening the file first:
   - **The dependency delta, everywhere.** `calibration-sampling-snapshot` adds **+4** db tests, not +3 — four `it(` blocks in its "(4) The sampling snapshot" (its `:484`, `:498`, `:521`, `:531`), its Task-3 step at `:802` ("674 tests pass (670 + 4), including all 17 in `tests/db/calibration-link.test.ts`"), its count arithmetic at `:1450` and its final Gates line at `:1421` (`887 unit / 674 db / 82 integration`). The figure **673 appears nowhere in that plan**; round 1 had misread its Task-1 line (`879 unit / 670 db`, `:339`) as its end state. Propagated to `:33`, the Facts `it(`-count bullet (16→17 start, 19→21 end), Task 1 Step 6/7, Task 3 Step 2 (`4 failed / 16 passed` → `4 failed / 17 passed`), Step 4 (20 → 21 tests), Step 5, Step 6 (`673 + 4` → `674 + 4 = 678`). The UNIT side (877 → 887) was already right and is unchanged.
   - **Three missing injections**, all added: Task 3's `hardCapMs` (the third seam, and the one the plan itself said only the `fast enough` test could catch); Task 2's `!( … > …)` NaN-swallowing form (a documented decision the four original cases could not discriminate — a fifth unit test was added for it — and round 3 added a sixth, so Task 2 is 6 tests / 40 in the file, not 4 / 38); Task 1's two `Number.isFinite` arms (with two fixture rows added so the arms are reachable at all).
   - **The (5)/(4) block-order inversion** in Task 3 Step 1: the old anchor (`refuses a golden set with no live items`) is the last test only on `5e48187`; the dependency appends its (4) block after that same test (its `:467` says so explicitly), so anchoring there would have put (5) above (4). The anchor is now the dependency's LAST test, and the note records that the old body-end quote was not unique either (`:490` and `:500` on HEAD).
   - **Gate scope for Tasks 1-2:** both commits only ADD exports to `latency.ts`, and nothing under `tests/db/**` can reach that module (three importers in the whole tree; no `tests/db` file imports `src/worker/**` — the two `src/worker/reaper.ts` strings in `tests/db/calibration-link.test.ts` are comments at `:30` and `:339` post-v2k). They now run lint → tsc → test:coverage → build with the deviation stated, per CONTRIBUTING.md:1639's "run the gates before **pushing**", and their `Gates:` lines say db/integration were last green at `<BASE>` rather than claiming a re-measurement. Task 3 keeps the full `&&`-guarded six-gate chain — it is the commit that enters the db run.
   - **Smaller, all verified:** the Owner-decision summary at the top no longer restates the very error the Facts bullet corrects (latency.ts is already in the db denominator as a `1/1` artifact — it is LOADED for the first time, not added); option (a) now requires an explanatory comment in the style of `vitest.config.ts:41-44` rather than a bare path; Task 3 Step 0's third pre-flight grep now looks for the v2k `samplingParams` column and its migration directory instead of `samplingDefaults`, which already exists at `schema.prisma:277` and proved nothing; Steps 2, 4 and 5 of Task 3 now use `! pgrep -f '[v]itest' &&` instead of an advisory `;`; the reversed `schema.prisma:499/:502` mapping (`latencyMs` is :499, `outputTokens` is :502); spec §2.1's table is `:115-120` (`:111-113` is the formula fence); the over-cap fixture comment's "1h42m" (`formatDurationMs` has no hours unit — 6 144 000 ms renders `102m24s`); the drift bullet now names `calibration-constant-baseline`'s DONE note on register §5.6 **#7**, so item 8 can move twice; the register DONE marker's hard-coded `2026-09-01` became `<DATE>` with the `git log -1 --format=%cs` command; Self-review #3's citations into the dependency plan were re-measured (`:690`/`:750`/`:771`/`:791`/`:423`/`:460`); and the CLI print's absence of any test is now a STATED GAP.
   - **Reviewer claims checked and REJECTED, with evidence, so the plan was left alone:**
     (i) "CONTRIBUTING.md's 'say that it was wrong and what it said' is `:1652-1655`" — it is **`:1653-1656`**, as the plan already says (`grep -n` puts "Update this guide" at 1653 and "repo's convention…" at 1656).
     (ii) "the 'A green test can be impossible to fail' bullet spans `:227-231`" — it spans **`:227-230`**; `:231` is the FIRST line of the next bullet ("A failure message that does not describe the defect…"). The plan's `:227-230` stands.
     (iii) "`judgeThroughputEstimate`'s `client = prisma` default-parameter branch will be uncovered because every unit test injects a client, so latency.ts falls to ~66/67 branches" — the evidence the reviewer cited refutes it. `judgeLatencyBaseline` has the IDENTICAL `client: JudgeLatencyClient = prisma` default, all **five** of its unit-test call sites pass an explicit client (`tests/lib/calibration-latency.test.ts:259, :266, :276, :293, :308`), and `coverage/lcov.info` nonetheless reports `BRDA:162,8,0,5` — taken 5 times, not 0 — with the file at `BRF:50 BRH:50`. The new function has the same shape and will report the same way, so "the aggregate moves UP, not down" stands.
     (iv) "add a db test with an EMPTY judgment history, because the errored-history test only proves the status filter" — the two are the same code path. The `status: 'completed'` WHERE means an errored-only history makes `findMany` return `[]`, so that test already drives `summarizeThroughput([]) → null` end to end against real Postgres, which is the null-not-zero contract it claims to pin; its title already says "no COMPLETED judgment". A fourth-and-a-half fixture would add a db test that cannot fail differently.
8. **Revision round 3 (2026-09-02, against `33b7be4` — the tree moved TWICE after round 2: Wave 1's nine commits, then v2k's `a96cf94` + `33b7be4`).** Every finding below was confirmed by opening the cited file before it was applied.
   - **A new failure point past the irreversible freeze — the one genuine correctness defect.** Round 2 put `const throughput = await judgeThroughputEstimate(judgeModelVersionId)` AFTER the header `$transaction`. That is an unguarded `await` between the irreversible header commit and the item loop: a connection blip, statement timeout or pool exhaustion there throws out of `launchCalibrationRun` with the golden set FROZEN, the `CalibrationRun` header COMMITTED and ZERO items launched — i.e. a purely advisory warning able to refuse a launch, which is the one contract this feature must never break, and a direct violation of the module's own rule at `launch.ts:33-37` ("EVERYTHING KNOWABLE UP FRONT IS CHECKED BEFORE THE FREEZE … writing it is irreversible"). No test or injection in Tasks 1-3 covered a throwing throughput query, so the defect would have shipped green. Fixed by SPLITTING the check: the query (which needs nothing from the header) now runs before the `// ── The irreversible write` banner at :316, and only the PURE `budgetWarningFor` call runs after the transaction. Chosen over a try/catch deliberately — a catch would add an arm nothing in `tests/db` can reach, in the file whose coverage gate is knife-edge.
   - **Two dead branch arms in the log payload.** `tokPerSec: throughput?.tokPerSec` / `n: throughput?.n` sat inside `if (budgetWarning !== null)`, and `budgetWarningFor` returns `null` whenever `throughput === null` — so the `null` arm of each `?.` is unreachable by construction: two permanently-uncovered branches landing in `launch.ts`, which IS in the db denominator (`BRF:31 BRH:23` measured in `coverage-db/lcov.info`). Exactly the "unreachable guard" class this plan invokes in Task 1 to justify its NaN fixture row. Replaced by logging `throughput` whole — same information, no branch, and the implication is now stated in the code comment.
   - **A behaviour four documents asserted and no test did:** the `logger.warn`. Deleting the whole block left every db assertion, all six unit describes, lint, tsc, coverage and build green, while the feature's only DURABLE record (the CLI print is transient stdout) silently ceased to exist. A `vi.spyOn(logger, 'warn')` assertion was added to the over-cap db test — no `vi.mock` needed, `logger` is a plain object (`src/lib/logger.ts:104`), the shape `tests/lib/backends.test.ts:263` already uses — with `vi.restoreAllMocks()` in the file's `beforeEach` so a mid-test failure cannot leak the spy, plus Task 3 injection (5).
   - **A parameter no test varied:** `hardCapMs`. All five round-2 `budgetWarningFor` cases passed `900_000`, which is byte-identical to `DEFAULT_HARD_CAP_MS` (`timeout-policy.ts:55`), so an implementation that destructured `hardCapMs` for the TEXT and compared against the imported constant passed all five, rendered the identical string, and stayed lint-clean. A sixth unit case at a 60 s cap and Task 2 injection (6) close it.
   - **The motivation was false, in four places.** Round 2's sentence — "the failure granite4.2 hit when its budget was raised 4096 → 12288 without the clock being checked" — was going into `latency.ts`'s JSDoc, `tests/db/calibration-link.test.ts` and two commit bodies. Checked against runbook §8.6 (:461-492) and §8.7 (:494-503): granite's stall was the **300 s provider timeout**, 35 tok/s × 12288 ≈ 351 s fits the 900 s hard cap, and §8.7 made 300 s an alert that keeps waiting. So this rule would have been correctly SILENT on granite. Rewritten in all four places to name the wall it actually guards and the case it actually catches, and the Task 4 runbook insert now scopes its claim to §8.6's FIRST formula (the second, `max_safe_tokens = timeout_s × tok_per_s`, is deliberately not automated for the same §8.7 reason) and carries a CORRECTION note rather than a silent reframing.
   - **Fixtures moved to the real measurement.** The warn fixture is now qwen3.5:9b's measured **11.9 tok/s** against `max_tokens: 12288` — 1 032 605 ms vs a 900 000 ms cap, rendered `17m13s` — replacing round 2's round-number 12 tok/s. It is the nearest-to-boundary case in the plan (1.15x over) and therefore the one that can discriminate a seconds↔milliseconds error the db fixtures (2 tok/s, 6.8x over) cannot. **CORRECTION (round 4): this "11.9 tok/s" figure is itself the exact defect `token-accounting` (`e438da2`/`0bd6b6b`/`db5bff9`) fixed hours later**, and it was computed with the same broken `Σ outputTokens / Σ latencyMs` formula this round shipped. See "Revision round 4" below: the reconciled figure is **12.0 tok/s**, sourced against `judge-arena-pg-1` through `accountTokens`, giving `12288 / 12.0 = 1024.0 s` = `17m4s` (still the nearest-to-boundary case, now at 1.14x over). Every place that quoted 11.9/1033/17m13s was updated; this bullet is left as a record of what round 3 said, not silently overwritten.
   - **Three verification steps that could not prove what they claimed.** (i) `grep -n -a "budgetWarning" scripts/calibration/run.ts` passes on a commented-out line, an inverted condition, a print after the poll loop, or one inside the `--score-only` branch — replaced with an ordering assertion plus a `sed -n` read-back. (ii) `expect(client.calls[0]).toMatchObject({ select: … })` is a SUBSET match and `fakeJudgeClient` ignores `select` entirely, so the full-table read it exists to prevent would have passed — tightened to `toEqual` with its own injection. (iii) `toMatch(/n=1/)` also matches `n=10`/`n=12`/`n=100` — pinned to the rendered clause `n=1 completed judgment`.
   - **Seam count.** `budgetWarningFor` reaches 1 of 4 launch paths and 1 of 2 CLI entry points. The API's `src/app/api/evaluations/[id]/runs/route.ts:84` and `src/app/api/evaluations/route.ts:303 / :494 / :605` run under the same sampling defaults and the same cap with no warning, and `run.ts --score-only` (:162-171) prints the sampling snapshot with no budget check beside it — the very path an operator uses on a run that has ALREADY stalled. All four are now recorded as explicit out-of-scope decisions in the JSDoc, in Task 3 Step 5 and in both doc edits (handoff §5.1's trap: the escalating timeout shipped into ONE of three seams and looked live).
   - **Two boundaries the silence hides,** now stated in the JSDoc and the runbook: the cap read is the LAUNCHER's `resolveTimeoutBudgets().hardCapMs`, not the worker's (they are assumed equal; `launch.ts:313`'s batch deadline already assumes it, so this adds no coupling — but a worker at 600 000 aborts runs the launcher called fine, and `.env.test` sets no `EVALUATION_MODEL_*` so the suite can never see the mismatch); and the rule fires only when the OPTIMISTIC flat-rate estimate already exceeds the cap, while §5.4.1 measures that model ~51% optimistic at 12k tokens, so an estimate in roughly 0.65x-1.0x of the cap is silent and still aborts. Recorded as a stated gap rather than fixed with a second band — that would need its own sentence, test and injection, and this commit does one thing.
   - **Numbers re-measured, not re-derived.** The baseline is **888 unit / 57 files, 674 db / 46 files, 82 integration / 11 files** on `33b7be4`; round 2's **887** was `877 + "+10"`, and v2k contributed **+11** (two new unit files). Task 1's guide becomes 895 and Task 2's 901 (7 + 6 new tests). The db coverage bullet ran on the HEAD-era estimate `992/1274` and on the false premise that `coverage-db/lcov.info` does not exist; it does (2026-09-02 21:00, 90 files) and aggregates to **BR 1001/1286 = 77.84%, FN 270/420 = 64.29%, LN 4745/9295 = 51.05%**, with `latency.ts` present as exactly the `FNF:1 FNH:1 LF:130 LH:0 BRF:1 BRH:1` artifact described and `launch.ts` at `FNF:3 BRF:31 BRH:23 LF:158 LH:151` (round 2 quoted `LF:148`). Conclusion unchanged — do-nothing projects to 1018/1352 = **75.30%**, ~1.7pp under the floor — and option (a) was measured too: 1000/1285 = **77.82%** branches, 269/419 = 64.20% functions, 4745/9165 = 51.77% lines, all four floors green. The owner now decides on numbers.
   - **Stale anchors and one live collision trap.** The migration bullet still said "sort after 20260901000000 (v2j)"; **v2k is taken and APPLIED** (`20260901180000_v2k_calibration_sampling_snapshot`) and the next letter is **v2l** — and this plan needs no migration at all, because `CalibrationRun.samplingParams` already exists at `schema.prisma:937`. The Facts header's "every anchor still holds on `5e48187`" is now a CORRECTION: v2k rewrote `launch.ts`, `run.ts` and `tests/db/calibration-link.test.ts`. Refreshed: `launch.ts` :88-110 / :157-462 / :241 / :312-314 / :316 / :330-371 / :373-379 / :381 / :455-461; `run.ts` :219 / :231 / :232; the db test file 604 lines, 17 `it(`, `mkWorld` :153-168, `noopPublish` :173, `launchParamsFrom` :175-183, reaper comments :30 / :339; handoff §8 :381 with its quoted sentence at :421-424; spec §5.4.1 :419 with the table :423-426; register item 8 :438-442.
   - **Reviewer claims checked and REJECTED with evidence, so the plan was left alone:** (i) "`mkWorld` is :153-171" — it is **:153-168**; :169 is blank and :170-172 are `noopPublish`'s doc comment. (ii) "`latency.ts`'s `JudgeLatencyClient` is :144-145, not :145" — the plan cites the DECLARATION, which is :145; :140-144 are its doc comment, and the plan's number stands. (iii) "the header `$transaction` is :330-370" — its closing `});` is **:371**. (iv) "`run.ts`'s failed loop is at :230" — :230 is the `accepted … failed` count line; the loop is **:231**. (v) "`CalibrationLaunchResult` is :88-109" — the member is :109, the closing brace **:110**. (vi) The claim that `vitest.db.config.ts`'s floors are elsewhere than `:149-156` with `branches: 77` at `:152` was checked line by line and the plan was already exactly right. Also re-verified as still correct and left untouched: `vitest.config.ts:37 / :41-44 / :187-220 / :188-191 / :196-199`, `timeout-policy.ts:94`, `env.ts:111`, `schema.prisma:499 / :502`, all five `tests/lib/calibration-latency.test.ts` anchors with its 27 `it(` blocks, runbook `§8.6 :461-492 / :485-487 / :489` and `§8.7 :494`, spec `§2.1 :115-120`, and the predicted `registry.ts:637` — which is exactly right.

9. **Revision round 4 (2026-09-02, against HEAD with `db5bff9` on top — a same-day, hours-later revision, not a new day).** This round exists because round 3 shipped the exact defect a SIBLING plan fixed a few hours after round 3 was written, and this plan was never updated to consume the fix.

   - **The defect, verified against the real tree, not assumed.** `judgeThroughputEstimate` was specified (Architecture line, Facts, Task 1's Interfaces/Step 1/Step 3, Task 2's fixture, Task 3's motivational comments, Task 4's runbook/register prose) as pooled `Σ outputTokens / Σ latencyMs`, with `select: { outputTokens: true, latencyMs: true }`. `ModelJudgment.outputTokens` is `usage.completion_tokens` verbatim (`src/lib/llm/openai-compatible.ts:260`), and `src/lib/calibration/token-accounting.ts` (landed as `e438da2`/`0bd6b6b`/`db5bff9`, hours after this plan's round 3) documents, with its own measurements, that this count EXCLUDES the reasoning channel on some models when the request carries `response_format: json_schema` — which `openai-compatible.ts:210-212` attaches to every `mode: 'judgment'` call, i.e. the judge path always. Read `token-accounting.ts` and its test file `tests/lib/calibration-token-accounting.test.ts` directly (not inferred): `accountTokens()` classifies each row via `REASONING_EXCLUDED_RATIO = 8` (`length(reasoningContent) / outputTokens`) and returns `estimatedGeneratedTokens` — equal to `outputTokens` when the provider already counted reasoning, or `outputTokens + Math.round(reasoningChars / CHARS_PER_TOKEN)` (3.64) when it did not.

   - **Independently re-verified against production, not taken on the sibling plan's word.** Read-only `psql` against `judge-arena-pg-1` (`kubectl exec -n tenant-public judge-arena-pg-1 -- psql -U postgres -d judge_arena`), 2026-09-02: qwen3.5:9b has two registered `JudgeModelVersion` rows (ordinal 1, `max_tokens: 6144`; ordinal 2 — the currently active one, `cmtkqwen35ord2v20000001` — `max_tokens: 8192`; NEITHER is 12288, see below). Over ordinal 2's 15 completed judgments: `Σ outputTokens = 2069`, `Σ latencyMs = 3,856,364`, `Σ length(reasoningContent) = 161,370`, ratio range **36.7…156.7** (every row `excludes_reasoning` under the ratio-8 threshold — none borderline). The PLAN'S formula: `2069 / 3856.364 = 0.537 tok/s` — the "~0.6 tok/s" order of magnitude the task brief described, confirmed independently, not copied. The CORRECT formula, computed row-by-row exactly as `accountTokens` does (`Σ (outputTokens + round(reasoningChars / 3.64))`, summed as `46,401`, not derived from means): `46401 / 3856.364 = 12.032 tok/s`. **The task brief's own worked number (142 outputTokens, 10560 reasoning chars, 239 s latency → 3043 tokens → 12.7 tok/s) was independently recomputed and its arithmetic is correct** (`142 + round(10560/3.64) = 142 + 2901 = 3043`; `3043/239 = 12.73`) — it is not the pooled production figure (whose 15-row mean latency is 257.1 s, not 239 s; the brief's own numbers do not match this plan's current production data, most likely because the corpus has grown while a calibration ran between when the brief was written and when this revision ran) — but it independently corroborates that the TRUE rate is in the low-to-mid teens, not 0.6, which is the fact that matters. **Reconciliation: 12.0 tok/s** (12.032 rounded to the one-decimal precision every other measured envelope in this plan already uses — 58.5, 35.9, 23.2), sourced to the pooled psql query above, used everywhere this plan states a "measured" qwen3.5:9b rate. `max_tokens: 12288` is kept as an ILLUSTRATIVE test budget (as it was in round 3) precisely because neither real registered version uses that number — this is stated explicitly wherever the figure is introduced, so no reader mistakes it for the live registered budget.

   - **The task brief's own numbers were not trusted uncritically, per its own instruction not to.** The brief cited "qwen3.5:9b was measured at 11.9 tok/s ... true rate is ~11.1" (from the pre-existing, deliberately-untouched ANCHOR RE-BASED note at Task 4 Step 2) and separately "~12.7 tok/s" as two different candidate replacements, and flagged its own arithmetic as unreliable. Both were checked against a live, independently-run pooled query rather than picked between; the result, 12.0 tok/s, agrees with neither exactly (it is between them) because it is a full pooled measurement over 15 real rows, not a single representative row or an un-sourced probe figure. **Left alone, and flagged rather than silently reconciled:** the ANCHOR RE-BASED note itself (this plan's Task 4 Step 2, inserted by the operator, not by an executor of this plan) says "the true rate is ~11.1" — close to but not identical to this round's 12.0. Per explicit instruction that note was not touched. It is prose ABOUT where the runbook anchor moved to, not a formula or test fixture this plan's Tasks execute, so the inconsistency is cosmetic (both numbers correctly convey "an order of magnitude higher than the broken 0.6, low-double-digits"), not a defect — but a future reader reconciling that note should know 12.0 is this plan's now-canonical, most-recently-sourced figure.

   - **What changed, file-by-file within this document.** Architecture line, Tech Stack line, Depends-on line (new: `token-accounting` named as a hard dependency, commits `e438da2`/`0bd6b6b`/`db5bff9`), the three Facts bullets covering the source columns / `formatDurationMs` illustration / "the judge this warning is actually for" (all rewritten with CORRECTION notes, round-3 text left visible per CONTRIBUTING.md:1653-1656's "say it was wrong, don't silently overwrite" rule), the Owner-decision section (a caveat that its branch/line/function counts are pre-round-4 and now a lower bound, not a re-derivation — re-deriving lcov numbers without running the instrumented suite would itself be an unchecked guess). Task 1: `ThroughputRow` gains `reasoningContent`; `summarizeThroughput` and `judgeThroughputEstimate` now call `accountTokens`; the `select` gains `reasoningContent: true`; a NEW Step 0 pre-flight for the `token-accounting` dependency; every existing fixture gains `reasoningContent: null` (inert — makes `estimatedGeneratedTokens === outputTokens`, so every PRE-EXISTING test's expected number is unchanged, verified by hand for each one below); ONE new test, `pools via accountTokens, not raw outputTokens — the qwen3.5:9b shape`, reusing `Q35_MIN_RATIO`/`Q35_THE_INCIDENT` from `tests/lib/calibration-token-accounting.test.ts` so the two files' numbers cross-check (`148,5589→1683`; `115,18019→5065`; pooled over 200s/350s = `6748/550 = 12.269 tok/s`, asserted `toBeCloseTo(12.27, 1)` and bounded `>12`/`<13`); Break (3) redesigned (the U1 exclusion moved into `accountTokens`, already tested there — this file's injection now targets the PROPAGATION, not the classification); Break (8) added (revert to raw `outputTokens`, red only on the new test, exact number checked: `263/550 = 0.4781818...`); test counts 27+7=34 → 27+8=35 throughout Task 1's Steps 2/4/5/7 and the `<N>` commit-body guide (895→896). Task 2: the core fixture rewritten to `{tokPerSec: 12.0, n: 15}` / `max_tokens 12288` / `1024.0s` / `17m4s`, every dependent assertion (`toContain('12.0 tok/s')`, `(n=15 completed judgment(s))`, `takes ~17m4s`) and injection description (`Break 3`'s "17m13s"→"17m4s", `Break 5`'s "1032605"→"1024000") updated; total 34+6=40 → 35+6=41; `<N>` guide 901→902. Task 3: no numeric fixture changes (its four db tests use inert round numbers — 2 tok/s, `reasoningContent` unset/null — chosen for wiring coverage, not to reproduce the live figure, now stated explicitly in `mkHistoryJudgment`'s doc comment and the (5) section banner), only the motivational comment/commit-body prose citing the old 11.9/1033 figure. Task 4: the runbook insert's formula line and its CORRECTION block, and the register DONE marker's formula/figure — both rewritten to name `accountTokens` and 12.0/1024s. Self-review: items 1, 2b and 3 updated for the new test/injection/type; round 3's stale "11.9 tok/s" bullet marked CORRECTED-not-overwritten; this item added.

   - **What was NOT changed, and why that is deliberate, not an oversight.** The four `tests/db/calibration-link.test.ts` fixtures in Task 3 keep their round numbers (2 tok/s, 6144000ms→102m24s, etc.) because `mkHistoryJudgment` never sets `reasoningContent`, so every db-test row is classified `no_reasoning_channel` by `accountTokens` and `estimatedGeneratedTokens === outputTokens` exactly — verified by hand, not assumed, for all four tests (over-cap, errored-history, fast-judge, resolved-vs-raw). Re-deriving those fixtures would have been busywork with no behavioural difference; what DID need adding was a doc comment on `mkHistoryJudgment` saying so explicitly, which is now there. The exact lcov branch/function/line counts in "Owner decisions needed" and the "Db coverage direction" Facts bullet were NOT hand-recomputed for the same reason the constant-derivation rule in this plan itself forbids carrying a number forward unchecked: nobody has run the post-round-4 instrumented suite, so any number offered here would be exactly the kind of unverified guess this whole revision exists to eliminate. A caveat was added instead, pointing at Task 3 Step 6's pre-existing "re-measure for real" policy.

   - **Self-check performed on every edit above** ("what exact wrong implementation would still pass the tests as now specified" / "did a new inconsistency get introduced"): the counter-test's own injection (Break 8) is the direct answer to the first question — reverting to raw `outputTokens` is exactly the wrong implementation that shipped in round 3, and it is now the one thing in the file that goes red for it. For the second question, every numeric occurrence of `11.9`, `1032605`/`1 032 605`, `1033`, and `17m13s` in this document was located by `grep -n -a` before and after editing and accounted for (one, the self-review's "1024000 > 900000" describing an unrelated, already-passing NaN-guard case, was found to ALREADY read 1024000 in round 3's own text — apparently a leftover from round 2's "round-number 12 tok/s" fixture that round 3's edit pass missed — and is left as is because it is now coincidentally consistent with round 4's figure and was not a claim this round needed to touch). Every test-count arithmetic chain (27→35 in Task 1, 34→41/35→41 in Task 2, the `<N>` commit-body guides) was re-added by hand rather than incremented by assumption.
