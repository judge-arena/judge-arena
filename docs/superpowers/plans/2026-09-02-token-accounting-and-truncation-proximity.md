# Token Accounting and Truncation Proximity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ModelJudgment.outputTokens` is `usage.completion_tokens` verbatim, and **whether that number includes the reasoning channel varies per MODEL** — not per backend, not per `reasoningSource`. Two consequences ship today: the runbook's `max_tokens` sizing formula is wrong by 18x on one production judge, and a judgment that generated ~5,065 tokens against a 6,144 budget reported `outputTokens 115` with `finishReason: 'stop'` and nothing warned. This plan adds a DERIVED, clearly-labelled total-generation estimate and a truncation-proximity warning to the calibration capture report, pins the per-model discriminator as a tested pure function, and corrects the two documents that carry the wrong numbers. **`outputTokens` keeps meaning "what the provider reported" and is never overwritten.**

**Architecture:** One new leaf module, `src/lib/calibration/token-accounting.ts`, holding four pure functions and three justified constants: `accountTokens` (classifies a judgment's provider accounting from `length(reasoningContent) / outputTokens` and returns `estimatedGeneratedTokens`), `resolveMaxTokens` (judgment `samplingParams` first, `CalibrationRun.samplingParams` header second, `null` third — never a registry default), `truncationProximity`, and `formatTokenAccountingLines` (the report strings). `scripts/calibration/run.ts` gains one section header, one `for … console.log` loop and one field on its existing one-judgment dump — **no new `select` fields, no schema change, no migration, no worker edit**. The strings live in `src/lib` rather than in the script for the same reason `sampling-drift.ts` does: `scripts/**` is outside every coverage `include` and has no harness, and the `>= 0.80` boundary is exactly the thing that must stay tested (CONTRIBUTING.md:247-250 — *"Put every rule that can be silently wrong into `src/lib/**` so that it can be unit-tested"*; `:238-243`, cited in an earlier draft of this plan, is the browser-walk paragraph and says no such thing).

**Tech Stack:** TypeScript, vitest (unit only — this plan reaches no `tests/db/**` file, no `tests/integration/**` file and no Prisma schema), Node's `readFileSync` for the one call-site guard (precedent: `tests/lib/sampling.test.ts:22`).

**Spec:**
- The defect, measured live 2026-09-02 and re-verified for this plan by read-only `psql` against `judge-arena-pg-1` (see **Measurements** below).
- Handoff §5.1 (a feature that reaches 1 of N seams looks live): `docs/superpowers/plans/2026-09-01-scoreboard-handoff.md:186-210`. §5.2 (chars-of-thinking as the signal, and `finish_reason: length` being ambiguous): `:211-244`. §6 traps 1-9: `:246-317`.
- The register rule this plan obeys and never breaks: `docs/superpowers/plans/2026-08-30-state-and-next-steps.md` — an absent measurement is not a measured zero, and `reasoningTokens` must not be defaulted to 0.
- `/tmp/ja-review-failure-modes.md` — 19 real defects that all passed every gate. Every verification step below names the wrong implementation it discriminates against.

**Priority / wave:** Wave 3 / new. Independent of every unlanded Wave 2/3 plan (see **Depends on**), so it can be executed at any point after `0a6669e`.

**Depends on:** Nothing unlanded. **The tree moved while this plan was being written: HEAD is now `0a6669e`** — `a272519` + `0a6669e` (the `2026-09-01-repetition-loop-detector` plan) landed after this plan's first draft was measured on `33b7be4`. They add `src/lib/llm/degeneration.ts`, `tests/lib/degeneration.test.ts` (a 58th unit file) and roughly 200 lines to `tests/lib/llm-truncation.test.ts`, and they rewrote runbook §8.2 and the `execute()` truncation message. Consequences, all handled below: the unit baseline is **917 / 58 files, re-measured on `0a6669e` with a clean tree** (not the 888 / 57 the first draft used); runbook §8.6 moved from `:461` to `:510` and its `tok_per_s` paragraph from `:485` to `:534`; `assertUsableContent` moved from `registry.ts:606` to `:626`. **Every `old_string` in this plan was re-verified against `0a6669e` and still matches uniquely** — only the line numbers moved. **This plan adds ZERO migrations** — see Task 1 Step 1's decision record — so it takes no `v2` letter, does not touch `prisma/schema.prisma`, and does not contend with `2026-09-01-calibration-constant-baseline.md`, which reserves `v2l` (`prisma/migrations/20260901190000_v2l_calibration_constant_baseline`, that plan's Global Constraints and Task 2). **Neither `v2l` nor `v2m` is claimed here.**

**Boundary notes — what belongs to a sibling plan and not to this one:**

1. **`2026-09-01-capture-field-gaps.md` owns handoff item #10 (`reasoningTokens` is NULL on self-hosted backends).** That plan documents and de-lists the field, adds `src/lib/calibration/reasoning-length.ts` (`summarizeReasoningLength`) and a per-status `reasoningContent chars` line to the capture report, and edits `prisma/schema.prisma:520`, `README.md:578`, `docs/runbooks/scoring-a-judge-against-a-golden-set.md:336-342` + `:348`, the handoff `:374-375`, the register `:392-395`/`:444-448`/`:668`, and `docs/superpowers/specs/2026-08-31-calibration-baseline-and-footprint.md:341`. **This plan touches none of those lines and does not mention `reasoningTokens` in any document it edits.** The two are complementary and not duplicative: capture-field-gaps answers *"why is this column NULL"* and reports reasoning **length**; this plan answers *"what does the column that is NOT null actually count"* and reports **estimated total generation against `max_tokens`**. Both add lines to `scripts/calibration/run.ts` — capture-field-gaps inserts immediately after the field loop at `:341-343`, **this plan inserts immediately before `const first = judgments.find(...)` at `:405`**, an anchor capture-field-gaps does not touch, so the two **block insertions** do not collide in either landing order.

   **Edit 6c DOES collide, and this is the one thing to check before running Task 2 Step 6.** `capture-field-gaps` Edit 6d (that document's `:372-378`, opened and confirmed) matches the SAME `run.ts:410` line this plan's Edit 6c matches — `console.log(\`  tokens in=${first.inputTokens} out=${first.outputTokens} reasoning=${first.reasoningTokens}   latency ${first.latencyMs}ms\`);` — and replaces it with a `reasoningChars=` variant. If **this** plan lands first, capture-field-gaps' Edit 6d still matches, because Edit 6c appends two lines *after* that line and does not alter it. **If capture-field-gaps lands first, Edit 6c's `old_string` no longer exists** and the Edit fails with no fallback. Establish which case you are in first:

   ```bash
   cd /root/judge-arena && grep -acF 'reasoningChars=' scripts/calibration/run.ts
   ```
   `0` ⇒ this plan is first, use Edit 6c as written. `1` ⇒ capture-field-gaps landed first; use the re-anchored `old_string` given in Task 2 Step 6, keeping the same two appended lines.
2. **`2026-09-01-calibration-budget-warning.md` owns the runbook insertion point at `:488` and the `judgeThroughputEstimate` helper in `src/lib/calibration/latency.ts`.** It inserts a new paragraph *after* the `tok_per_s` paragraph at `:485-487`; **this plan rewrites `:485-487` itself.** Whichever lands second re-anchors — that plan's Task 4 Step 2 quotes the old three lines as its anchor, so **if this plan lands first, that plan's anchor must be updated to the replacement text written in Task 3 Edit 1 below.** Say so in that plan's re-anchor step rather than restoring the old sentence.
3. **A finding for `calibration-budget-warning`, not a change this plan makes.** That plan defines `judgeThroughputEstimate` as `Σ outputTokens / Σ latencyMs` — the exact formula this plan is correcting — while its own worked example quotes *"qwen3.5:9b, measured 2026-09-02 at 11.9 tok/s"*. Measured 2026-09-02, `Σ outputTokens / Σ latencyMs` on qwen3.5:9b is **0.6 tok/s**, not 11.9; `Σ estimatedGeneratedTokens / Σ latencyMs` is **11.1**. Its warning would still fire on that judge (`12288 / 0.6 ≈ 20,480 s` ≫ the 900 s cap) but for the wrong reason and with a number 18x off, and it would be silent-and-wrong in the opposite direction for any judge whose reasoning is excluded and whose budget is genuinely fine. **The fix is one line in `judgeThroughputEstimate` — feed it `accountTokens(row).estimatedGeneratedTokens` — and it belongs in that plan, executed after this one lands.** It is recorded as follow-up F1 below and is deliberately NOT done here: `src/lib/calibration/latency.ts` is that plan's file, and editing it here would be two plans writing one function.
4. **`2026-09-01-repetition-loop-detector.md` LANDED on 2026-09-02 as `a272519` + `0a6669e`**, and it owns `README.md:594-622` and runbook §8.2. This plan edits neither. Its subject matter is adjacent — a repetition loop is the case where a *large* estimate is real generation that must NOT be fixed by raising `max_tokens` (handoff §5.2, failure mode 16) — so Task 2's warning text points at §8.2 rather than telling anyone to raise the budget.

   **That pointer was checked against §8.2 as it reads on `0a6669e`, not as it read on `33b7be4`.** §8.2 is now titled *"A truncated response is a **hard, non-retryable** failure — and the message says whether it was a loop"* (`:380`) and its body carries both endings of the `execute()` message, including *"raising `samplingDefaults.max_tokens` buys a longer loop, not a verdict"* and the deflate-ratio test at `src/lib/llm/degeneration.ts`. Before `a272519`, §8.2's only advice was *"raise `samplingDefaults.max_tokens`"*, which would have made this plan's warning point at the wrong fix. **It no longer does, so the §8.2 pointer stands as written** — but if §8.2 is ever rewritten again, re-check it, and the fallback target is scoreboard spec `docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md:459` (§5.4.2, *"IT WAS NOT TRUNCATION. IT WAS A REPETITION LOOP"*).

**Dry-run verified, 2026-09-02, on a scratch checkout that was reverted to a clean tree afterwards.** Every code block in Tasks 1 and 2 was materialised verbatim from this document (the four ```` ```ts ```` blocks concatenated as the plan describes, plus the three `run.ts` edits) and run. Results, which is why the numbers below are stated rather than predicted:

- `npx tsc --noEmit` — clean, with and without the `run.ts` wiring.
- `npm run lint` — 0 warnings (`eslint src/ prisma/ scripts/ tests/`, silent).
- `npx vitest run tests/lib/calibration-token-accounting.test.ts` **before** the wiring: `Tests  1 failed | 24 passed (25)`, the single failure being the call-site guard — exactly what Task 2 Step 5 predicts.
- The same command **after** the wiring: `Tests  25 passed (25)`.
- `npm run test:coverage`: no coverage-threshold failure, no floor touched. **The counts the dry run printed (`Test Files  58 passed (58)` / `Tests  913 passed (913)`) were taken on `33b7be4` and are now STALE** — `a272519`/`0a6669e` have since landed and the clean-tree baseline re-measures at `Test Files  58 passed (58)` / `Tests  917 passed (917)`. Treat every count in this plan as arithmetic on the baseline you measure in Task 1 Step 0, never as a measurement of the end state.
- `formatTokenAccountingLines` was executed against all six test fixtures and its output compared character by character with the expected arrays in Task 2 Step 2. They match exactly, including the `…`, `⇒`, `⚠`, `ⓘ` and `±` characters.

The scratch files were deleted and `scripts/calibration/run.ts` restored with `git checkout --`; `git status --porcelain` shows only untracked plan documents. **An executor still runs every step** — the dry run proves the code and the expected outputs are right, not that the steps were performed.

**Owner decisions needed:** none. Two decisions are made and argued in-plan rather than deferred: **(a)** `reasoningChars` is derived at read time and gets **no column** (Task 1 Step 1); **(b)** `CHARS_PER_TOKEN = 3.64` and `REASONING_EXCLUDED_RATIO = 8` are fixed constants with stated error bars, not configuration — the arithmetic behind each is written into its doc comment in Task 1 Step 4, and Task 2 Step 4 does the same for `TRUNCATION_PROXIMITY_WARN = 0.8`. One operator action is noted and not performed: re-running `npm run calibration:run -- --score-only=<id>` on a promoted image is what makes the new block appear for an existing run, and promotion is the operator's.

---

## Verified corrections to this plan's own brief

Every item below was checked against the tree or the production database on 2026-09-02. Failure mode 19 — *reviewers are confidently wrong; open the cited location before applying a finding* — cuts both ways, so each correction states what was checked and how.

1. **The CORRECTION-note rule is `CONTRIBUTING.md:1653-1656`, not `:1571-1574`.** `:1568-1577` is the "Test coverage" section (`npm run test:coverage` … gate on `coverage.thresholds`). The rule — *"if you find a claim in here that is wrong, **say that it was wrong and what it said** rather than silently overwriting it"* — is item 8 of **Pull Request Guidelines**, at `:1653-1656`. `grep -n "and what it said" CONTRIBUTING.md` prints `1655`.
2. **Spec §2 contains no `31.3` and no `35.1`.** `grep -rn "31\.3\|35\.1" docs/ README.md` returns nothing. §2's table (`:93-99`) is split by `max_tokens` and reads `58.5`, `27.3`, `35.0`, `37.3`, `30.2`. `31.3` and `35.1` are the **pooled-across-`max_tokens`** naive rates for Qwen3.6 and granite4.2 — real numbers, just not the ones in that table. Task 3 therefore corrects §2's **definition** and adds the missing judge, rather than editing four cells that do not contain the quoted values.
3. **`Qwen3.6 31.3 → 67.4` and `granite4.2 35.1 → 78.3` are a double count, and this plan does not write them.** Both reconstructions add a chars-derived reasoning estimate to `outputTokens` on two judges whose `outputTokens` **already contains** the reasoning — which the brief itself states (`3.52` and `3.76` chars/output-token ⇒ reasoning IS inside). Measured: `Σ (reasoningChars + rawResponseChars) / Σ outputTokens` is `3.762` on Qwen3.6 and `3.868` on granite4.2, i.e. the whole generated stream is already accounted for by `outputTokens` to within 7%. **The corrected rate for those two judges is the rate they already have.** The judge whose rate is wrong is qwen3.5:9b: `0.6 → 11.1`. Task 3 Edit 2 states this in the CORRECTION note explicitly, so the double-counted figures cannot be reintroduced.
4. **The memo's "~6023 tokens — 98% of budget" implies `CHARS_PER_TOKEN ≈ 3.05`; this plan's constant is 3.64 and puts the same item at 5,065 tokens = 82.4%.** The item is real and unambiguous — `outputTokens 115`, `length(reasoningContent) 18019`, `max_tokens 6144`, `finishReason 'stop'`. `115 + 18019/3.05 = 6023` (98.0%); `115 + round(18019/3.64) = 5065` (82.4%). **The gap between 82% and 98% is exactly the constant's error bar, and both are above this plan's 80% threshold**, so the deliverable is unaffected — but the report prints `outputTokens` and `reasoningChars` on the same line precisely so an operator can re-derive under any constant. 3.05 is the *content*-channel figure from the ad-hoc Ollama A/B (`598 chars / 196 completion_tokens`); the reasoning channel is denser prose and measures 3.5-3.9 in production. Do not use 3.05.
5. **qwen3.5:9b's chars/output-token re-measures at 68.46, not 70.52 and not the 66.32 an earlier draft of this plan carried.** Re-measured read-only against `judge-arena-pg-1` on 2026-09-02: over **the nine completed judgments of the voided `max_tokens 6144` run**, `Σ length(reasoningContent) / Σ outputTokens` = **68.46**. The 66.32 was arithmetic drift in the draft, not a population difference — the same query returns the `37.76 … 156.69` range the draft also quotes, so the population is identical. **Always scope this figure to the 6144 run and say so**, because the relaunched run at `max_tokens 8192` was still draining as this plan was reviewed (n=10 and rising on 2026-09-02; as of then, ratio 36.73 … 103.51, `Σrc/Σot` 73.83) and the pooled figure over both is **71.03** (as of 2026-09-02) and still moving. Nothing in the code depends on which is quoted — every one of them is 8x above the threshold — but the number is published into two documents by Task 3, so it must be the one the query prints. **The measured per-row range is what the threshold is actually sized against**, and its lower bound has moved from `37.76` to **`36.73`** now that the 8192 run has drained; the plan uses `36.73` in the band assertion for that reason.
6. **Nothing named `reasoningChars`, `estimatedGeneratedTokens` or `token-accounting` exists in the tree.** `grep -ran "reasoningChars\|estimatedGeneratedTokens\|token-accounting" src/ scripts/ tests/ prisma/` returns nothing (`-a` per the NUL-byte trap). No naming collision.
7. **The brief's code claims all hold, re-verified on `0a6669e`**, each opened: `openai-compatible.ts:260` sets `outputTokens: response.usage?.completion_tokens`; `:263` sets `reasoningTokens: response.usage?.completion_tokens_details?.reasoning_tokens`; `:253` extracts the reasoning channel via `extractReasoningChannel` (`:169-187`, key order `reasoning_content` → `reasoning` → `<think>`); `:210-212` sets `structuredOutputRequested` for every `mode: 'judgment'` call to a descriptor whose `caps.structuredOutput !== 'none'`; `ollamaStructuredRequestFields` (`backends/ollama.ts:45-53`) and `llamacppStructuredRequestFields` (`backends/llamacpp.ts:30-38`) both send `response_format: {type: 'json_schema', json_schema: {…, strict: true}}`. Persist sites are `markJudgmentError` (`judgment-consumer.ts:632-674`, its field writes at `:659-670`) and `commonSuccessUpdateData` (`:725-757`, its field writes at `:729-745`) — **four seams if a column were added**, which is half of Task 1 Step 1's argument. (An earlier draft cited `:661-664` and `:733-742`; both land mid-field-list rather than on the declaration, so the declaration lines are given here.)

8. **All 46 `status='error'` judgments carry `samplingParams IS NULL`**, measured read-only 2026-09-02. This is the load-bearing fact behind `resolveMaxTokens`'s run-header fallback: the truncation cases are exactly the rows that have no `samplingParams` of their own.

9. **Production `judge-arena-pg-1` does NOT yet have `CalibrationRun.samplingParams`** (`information_schema.columns` for `CalibrationRun` lists 18 columns and that is not one of them) — v2k is landed in the repo and applied to the local test DB, but the production migration is the operator's, not this plan's. Nothing here breaks: `readMaxTokens(undefined)` returns `null` and the report falls back to the judgment's own `samplingParams`, which every `completed` row carries. It only means the `(max_tokens from the run header)` path stays unexercised in production until the operator promotes an image that applies v2k. Noted in the Post-landing checklist, not acted on.

---

## Global Constraints

- Repo: /root/judge-arena (Next.js 15.5.22, TypeScript, Prisma on Postgres — `Json` maps to JSONB —, amqplib 2.0.1, vitest 3.2.4). Node >= 22. **Always use `git -C /root/judge-arena`** (handoff §6 trap 2: a stale `cd` once hard-reset the wrong repo to a four-month-old commit).
- Gates, in this order, all clean before every commit: `npm run lint` (0 warnings) → `npx tsc --noEmit` → `npm run test:coverage` (unit; per-glob floors in vitest.config.ts:187-220 — **NEVER lower a floor**) → `npm run test:db:coverage` → `npm run test:integration` → `npm run build` (CONTRIBUTING.md:1640-1645). **Documented carve-out for this plan:** Tasks 1 and 3 stop after `test:coverage`, because neither reaches a `tests/db/**` file, a `tests/integration/**` file, a Prisma schema or a Next build; **Task 2 runs the full chain ONCE for the branch.** Every extra `npm run test:db:coverage` is another `prisma migrate reset --force` of the single shared `judge_arena_test`, whose suite is **not** concurrency-safe (failure mode 11) — never run two at once, and re-run a failing db file **alone** before calling anything a regression.
- **Before the first `npm run test:db:coverage`, confirm what it will reset:** `grep DATABASE_URL /root/judge-arena/.env.test`. It must be `localhost:5432` (the local podman `judge-arena-pg`). `judge-arena-pg` (podman, local) and `judge-arena-pg-1` (k8s, **PRODUCTION**) differ by one character (handoff §6 trap 1). A calibration may be draining in production; **any production access in this plan is read-only `psql SELECT` and nothing else.**
- Baseline **re-measured on HEAD `0a6669e`, 2026-09-02, clean tree: lint 0, `npx tsc --noEmit` 0, `Test Files 58 passed (58)` / `Tests 917 passed (917)` unit, 674 db / 46 files, 82 integration / 11 files.** (The first draft of this plan used 888 / 57, measured on `33b7be4`; `a272519` + `0a6669e` landed in between and added `tests/lib/degeneration.test.ts` plus ~200 lines of `tests/lib/llm-truncation.test.ts`.) **Every predicted count below is arithmetic on the baseline you MEASURE in Task 1 Step 0 — `baseline + 11` after Task 1, `baseline + 27` after Tasks 2 and 3, file count `+1` — and is never itself a measurement** (failure mode 15). If `test:coverage` prints something else, **the printed number is the truth** — put IT in the `Gates:` line, and treat an unexplained delta as a finding to diagnose, not a number to overwrite.
- **Before EVERY commit in this plan, prove the index is empty first.** Other agents execute sibling plans in this same checkout; during the review of this plan `git status --porcelain` twice showed another plan's work already staged (`A  src/lib/llm/degeneration.ts`, `A  tests/lib/degeneration.test.ts`, `A  tests/lib/reasoning-fixtures.ts`).

  ```bash
  git -C /root/judge-arena diff --cached --name-only
  ```
  Expected: **empty**. If it prints anything, another agent has work staged — **stop, and do NOT `git reset` it** (that is their work); hand it back to the operator, or execute this plan in a `git worktree`. `git add <paths> && git commit` (no `--only`) commits the **whole index**, not the paths just added, so a pre-staged file lands silently under this plan's subject line and breaks one-concern-per-commit with every gate green. **Every commit below therefore does `git add <paths>` and then `git commit --only <paths>`** — `--only` restricts the commit to those paths and cannot pull the rest of the index in, but it does NOT imply the add: `git commit --only <untracked path>` fails with `error: pathspec … did not match any file(s) known to git`, so the `git add` step is required, not optional, even though `--only` is doing the actual restricting. Verify afterwards with `git show --stat --oneline HEAD`: commit A must list exactly 3 files, B exactly 3, C exactly 2.
- TDD with an INJECTION step (CONTRIBUTING.md:210-234): every behaviour test must be shown to go RED by a deliberate breakage and GREEN again after. **An injection that leaves the suite green is a finding, not a formality.** A failure message that does not describe the defect is not evidence (CONTRIBUTING.md:230-234) — if an injection fails for an incidental reason, write a cleaner one.
- **Every verification step must name the wrong implementation it discriminates against.** Where a step cannot discriminate, this plan says so out loud rather than implying coverage it does not have (`/tmp/ja-review-failure-modes.md` §A).
- One concern per commit/PR (CONTRIBUTING.md:1639). Wrong statements in docs get an explicit `CORRECTION` note that **quotes what the document used to say**, never a silent overwrite (CONTRIBUTING.md:1653-1656).
- Commit subject: `type(scope): lowercase summary` (feat/fix/docs/ci; scopes in use: worker, llm, queue, calibration, ci, docker). Body: narrative, then a `Gates: lint 0, tsc 0, <n> unit / <n> db / <n> integration, coverage 0.` line — EVERY slot present; a slot deliberately not measured reads `n-a` with the reason in the parenthetical that follows — then EXACTLY these trailers:
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
- **Name paths explicitly (via `git commit --only <paths>`). Never `git add -A` / `git add .`** — sibling plan files are untracked in `docs/superpowers/plans/` and belong to other concerns; a blanket add sweeps them all into this plan's commit. **Do not assert how many there are**: it was nine when this plan was drafted and is eight on `0a6669e` (`2026-09-01-repetition-loop-detector.md` became tracked when it landed), and it changes again every time a sibling lands. The count is not a check; the empty index and the explicit path list are.
- Commit **LOCALLY only. Never push, never promote, never mutate the cluster.** Those are the operator's. Pushing to main fires CI and builds an image; promotion is a separate homelab-setup PR.
- **Migration naming is INERT for this plan — it adds ZERO migrations and does not touch `prisma/schema.prisma`.** For the record, since a later reader may want it: `prisma/migrations/<YYYYMMDDHHMMSS>_v2<letter>_<snake>/migration.sql`, `20260901180000_v2k` is on disk and applied so any timestamp `<= 20260901180000` collides, `v2l` is reserved by `2026-09-01-calibration-constant-baseline.md`, the next free letter is therefore `v2m`; narrative `-- v2x — …` header in the v2i/v2j style, content exactly what `prisma migrate diff` emits with zero hand edits, then `npx prisma generate`.
- **GREP TRAP, live in HEAD:** `/root/judge-arena/src/lib/calibration/readings.ts` and `/root/judge-arena/scripts/importer/reconcile.ts` contain a deliberate NUL byte; plain `grep` silently returns nothing for those two files. **Use `grep -a`. NEVER remove the NUL.**
- `scripts/calibration/run.ts` is outside every coverage `include` (`vitest.config.ts:37`) and no test imports it. It IS lint-gated (`npm run lint` = `eslint src/ prisma/ scripts/ tests/`) and tsc-gated (`tsconfig.json` includes `**/*.ts`). The Docker image bundles it with esbuild and `.dockerignore:72` promises it "pulls in `src/lib/calibration/**` and `@/lib/db` only" — **`src/lib/calibration/token-accounting.ts` imports nothing at all**, so that promise stays true.
- `src/lib/**/*.ts` is inside `vitest.config.ts`'s coverage `include` (`:37`). A new, fully-unit-tested module raises the aggregate; **no floor moves in either direction**, and `vitest.config.ts` is not edited by this plan.

---

## Measurements — re-verified 2026-09-02 by read-only `psql` against `judge-arena-pg-1`

Reproduce with (read-only; safe while a calibration drains):

```sh
kubectl exec -n tenant-public judge-arena-pg-1 -- psql -U postgres -d judge_arena -tAF'|' -c "
with x as (
 select jm.name as judge, j.\"outputTokens\" ot, j.\"latencyMs\" lat,
        coalesce(length(j.\"reasoningContent\"),0) rc, coalesce(length(j.\"rawResponse\"),0) cc,
        (j.\"samplingParams\"->>'max_tokens')::int mt
 from \"ModelJudgment\" j
 join \"JudgeModelVersion\" jv on jv.id=j.\"judgeModelVersionId\"
 join \"JudgeModel\" jm on jm.id=jv.\"judgeModelId\"
 where j.status='completed' and j.\"outputTokens\" is not null and j.\"outputTokens\">0),
y as (select *, rc::numeric/ot ratio,
      case when rc::numeric/ot > 8 then ot + round(rc/3.64) else ot end est from x)
select judge, count(*) n, round(min(ratio),2) minr, round(max(ratio),2) maxr,
  round(sum(rc)::numeric/sum(ot),2) chars_per_outtok,
  round(sum(rc+cc)::numeric/sum(ot),3) cpt_unbiased,
  round(sum(ot)::numeric/sum(lat)*1000,1) naive_toks,
  round(sum(est)::numeric/sum(lat)*1000,1) est_toks
from y group by 1 order by 1;"
```

| judge | n | ratio min…max | Σrc/Σot | unbiased chars/tok | naive tok/s | estimated tok/s |
|---|---|---|---|---|---|---|
| Qwen3.6-35B-A3B (llama.cpp) | 145 | 2.31 … 4.73 | 3.52 | 3.762 | 31.3 | **31.3** |
| granite4.2:3b (Ollama) | 40 | 2.57 … 4.63 | 3.76 | 3.868 | 35.1 | **35.1** |
| granite4.1:3b (Ollama) | 60 | 0.00 … 0.00 | 0.00 | 4.909 | 30.2 | **30.2** |
| qwen3.5:9b (Ollama) | 18\* | 36.73 … 156.69 | 71.03 | 75.680 | 0.6 | **11.7** |

\* Pooled across two budgets; the relaunched `8192` run was still draining as of 2026-09-02 (n=9 and rising then). **Split by `max_tokens`, which is the scoping Task 3 publishes:** `6144` → n=9, `Σrc/Σot` **68.46**, ratio 37.76 … 156.69, naive **0.6**, estimated **11.1**, largest estimate 5065 (this run is voided and complete — these figures are frozen); `8192` → n=9, `Σrc/Σot` 73.83, ratio 36.73 … 103.51, naive 0.6, estimated 12.3, **all as of 2026-09-02 and still moving — re-run the query below for the current count.**

> **THIS CORPUS GROWS WHILE A CALIBRATION DRAINS.** It was 254 completed judgments when this plan was drafted and is **263** as re-measured on 2026-09-02. **Re-run the query above at execution time and paste the printed numbers into the doc comments, the CORRECTION notes, the test-file comment at the `REASONING_EXCLUDED_RATIO` band assertion, and the `263`/`245`/`18`/`261` figures in commit messages A and B** — do not copy the table below on faith. Only two things about it are stable and load-bearing, and both were re-confirmed at 263: the two ratio bands do not overlap, and `>= 0.80` fires on exactly two judgments. The 6144-scoped figures Task 3 publishes are frozen (that run is voided and complete) and were re-confirmed exact on 2026-09-02, so only the pooled/`8192` numbers move.

**Three facts this table establishes, each load-bearing below.**

1. **The two bands do not overlap and are 8x apart.** "Includes reasoning" tops out at `4.73`; "excludes reasoning" bottoms out at `36.73`. `REASONING_EXCLUDED_RATIO = 8` sits 1.69x above the first and 4.6x below the second. (The lower bound was `37.76` before the 8192 run drained. It moves; the gap does not.)
2. **The chars model reproduces the provider's own count where both exist.** On the two judges with a reasoning channel that IS counted, `Σ(rc+cc)/3.64 / Σot` is `1.071` and `1.076` — the estimator reads **7% high** where it can be checked. That residual is this plan's error bar.
3. **Only one judge's published rate is wrong.** Qwen3.6, granite4.2 and granite4.1 estimate to exactly their naive rate, because for them the naive rate was already right. qwen3.5:9b moves `0.6 → 11.1` on the `6144` run (`0.6 → 11.7` pooled across both budgets). Task 3 publishes the **6144-scoped 11.1**, because the spec row it sits in is split by `max_tokens`.

Per-judgment fixtures used verbatim by the tests below, each one real:

| tag | judge | outputTokens | reasoningChars | max_tokens | ratio | classification |
|---|---|---|---|---|---|---|
| `QWEN36_MAX_RATIO` | Qwen3.6 | 2628 | 12428 | 8192 | 4.73 | includes |
| `QWEN36_NEAR_BUDGET` | Qwen3.6 | 7272 | 18819 | 8192 | 2.59 | includes, **88.8% of budget** |
| `GRANITE42_MAX_OUT` | granite4.2 | 9160 | 35212 | 12288 | 3.84 | includes, 74.5% |
| `GRANITE41_NO_REASONING` | granite4.1 | 163 | 0 | 4096 | — | no reasoning channel |
| `Q35_MIN_RATIO` | qwen3.5:9b | 148 | 5589 | 6144 | 37.76 | excludes |
| `Q35_THE_INCIDENT` | qwen3.5:9b | 115 | 18019 | 6144 | 156.69 | excludes, **82.4% of budget** |

---

## Commit shape (binding)

Exactly **three** commits land from this plan, one per task, one concern each:

| commit | task | subject |
|---|---|---|
| A | Task 1 | `feat(calibration): outputTokens does not always count the reasoning channel — derive the total` |
| B | Task 2 | `feat(calibration): warn when a judgment's estimated generation nears max_tokens` |
| C | Task 3 | `docs(calibration): correct the tok/s formula and the throughput envelopes` |

---

### Task 1: the accounting model — classify what `outputTokens` counted, and derive the total

**Files:**
- Create: `/root/judge-arena/src/lib/calibration/token-accounting.ts`
- Create (Test): `/root/judge-arena/tests/lib/calibration-token-accounting.test.ts`
- Create: this plan file is committed here — named explicitly in Step 11's `git commit --only` (sibling plans are untracked and belong to other concerns; never `git add -A`, and never assert how many siblings there are).
- Modify: nothing. No schema, no migration, no script, no worker file.

**Interfaces:**
- Consumes: nothing. The module has **zero imports** — that is a property `npm run lint` and Task 2's bundle promise both depend on.
- Produces:
  - `export const CHARS_PER_TOKEN = 3.64;`
  - `export const REASONING_EXCLUDED_RATIO = 8;`
  - `export type ReasoningAccounting = 'includes_reasoning' | 'excludes_reasoning' | 'no_reasoning_channel' | 'unmeasurable';`
  - `export interface TokenAccounting { accounting: ReasoningAccounting; reasoningChars: number; charsPerOutputToken: number | null; estimatedGeneratedTokens: number | null; }`
  - `export function accountTokens(input: { outputTokens?: number | null; reasoningContent?: string | null }): TokenAccounting`

- [ ] **Step 0: Establish the starting state and MEASURE the baseline**

```bash
cd /root/judge-arena && git log -1 --format='%h %s' && git diff --cached --name-only && git status --porcelain
```

`git diff --cached --name-only` must print **nothing**. `git status --porcelain` must show only `?? docs/superpowers/plans/` lines. **If any line begins with `A `, `M `, ` M`, `D ` or ` D`, STOP** — another agent is executing a sibling plan in this checkout (this happened twice during review, with `src/lib/llm/degeneration.ts` staged). Do not `git stash`, do not `git reset`, do not commit around it: hand it back to the operator, or take a `git worktree`. Do **not** assert how many `??` plan files there are; that count changes as siblings land.

Then measure, because every count in this plan is arithmetic on this number and nothing else:

```bash
cd /root/judge-arena && npm run lint && npx tsc --noEmit && npx vitest run 2>&1 | tail -5
```

Expected on `0a6669e`: lint 0, tsc silent, `Test Files  58 passed (58)` / `Tests  917 passed (917)`. **Write down whatever it prints — call it `B` (tests) and `F` (files).** Task 1's gate is `B + 11` over `F + 1`; Tasks 2 and 3's is `B + 27` over `F + 1`. If the printed baseline is not 917/58, that is a later commit landing, not a regression — recompute `B + 11` and carry on.

- [ ] **Step 1: Record the no-column decision (read it, do not skip it — the rest of the plan assumes it)**

No code in this step. The decision, and why it is not a coin flip:

**`reasoningChars` is derived at read time. No column is added.**

*For a column:* it would make the number queryable from SQL without `length()`, and it would survive a future change that stopped persisting `reasoningContent` in full.

*Against, and this is what decides it:*

1. **It is a derived duplicate of a column that is already there, and duplicates drift.** `prisma/schema.prisma:519` documents `reasoningContent` as the model's raw thinking channel stored verbatim; `rawResponse` at `:497` is documented "full LLM response, never truncated". `length()` over it is exact and costs nothing. The 2026-08-30 register's own precedent — *chars is derivable at read time with no column* — was written for this shape.
2. **The seam count is four, and one missed seam is a partial rollout that looks live.** A written column would need `commonSuccessUpdateData` (`src/worker/judgment-consumer.ts:725-757`, itself the anti-drift extraction covering judge/respond/pairwise) **and** `markJudgmentError` (`:632-674`), which is a separate write and the one that matters most here — a truncated or looping judgment is an `error` row. Handoff §5.1 is exactly this failure at N=3, and it looked healthy in production for an hour. Read-time derivation has **zero** seams.
3. **Every existing row would be NULL.** 263 completed judgments carry the evidence today; a column carries it only for judgments made after the migration, and a backfill is a production write this plan is not permitted to make.
4. **A column changes nothing about the actual defect.** The defect is that `outputTokens` has two meanings. Storing the character count does not disambiguate them; the *ratio* does, and the ratio needs no storage.

*Consequence to state once and honour everywhere:* the character count is computed in **JavaScript**, as `reasoningContent.length` — UTF-16 code units, the same definition `scripts/calibration/run.ts:73-75`'s `cap()` already prints as "`N` chars". Postgres `length()` counts **code points**, so the two differ on astral-plane characters (emoji). Nothing in this plan compares a JS count to a SQL count; the SQL in **Measurements** above is provenance for the constants, not an assertion the code makes.

- [ ] **Step 2: Write the failing test**

Create `/root/judge-arena/tests/lib/calibration-token-accounting.test.ts` with exactly this content:

```ts
import { describe, expect, it } from 'vitest';
import {
  CHARS_PER_TOKEN,
  REASONING_EXCLUDED_RATIO,
  accountTokens,
} from '@/lib/calibration/token-accounting';

// ─── Real judgments, measured 2026-09-02 against judge-arena-pg-1 ──────────
//
// `ModelJudgment.outputTokens` is `usage.completion_tokens` verbatim
// (src/lib/llm/openai-compatible.ts:260) and whether it includes the
// reasoning channel varies PER MODEL. granite4.2:3b and qwen3.5:9b are both
// Ollama and both report `reasoningSource: 'reasoning'`, and they disagree —
// so neither `servingBackend` nor `reasoningSource` can be the discriminator.
// Only `length(reasoningContent) / outputTokens` separates them.
//
// Only the LENGTH of reasoningContent is ever read, so a repeat() string of
// the measured length is the whole fixture.
const chars = (n: number): string => 'x'.repeat(n);

const QWEN36_MAX_RATIO = { outputTokens: 2628, reasoningContent: chars(12428) }; // ratio 4.73
const QWEN36_NEAR_BUDGET = { outputTokens: 7272, reasoningContent: chars(18819) }; // ratio 2.59
const GRANITE42_MAX_OUT = { outputTokens: 9160, reasoningContent: chars(35212) }; // ratio 3.84
const GRANITE41_NO_REASONING = { outputTokens: 163, reasoningContent: null }; // no channel at all
const Q35_MIN_RATIO = { outputTokens: 148, reasoningContent: chars(5589) }; // ratio 37.76
const Q35_THE_INCIDENT = { outputTokens: 115, reasoningContent: chars(18019) }; // ratio 156.69

describe('calibration/token-accounting: the constants are what the measurement says', () => {
  it('CHARS_PER_TOKEN is the literal 3.64, not a computed mean', () => {
    // (3.52 + 3.76) / 2 evaluates to 3.6399999999999997 in IEEE754, which
    // would make every estimate depend on how the constant was spelled.
    expect(CHARS_PER_TOKEN).toBe(3.64);
    expect(CHARS_PER_TOKEN).not.toBe((3.52 + 3.76) / 2);
  });

  it('REASONING_EXCLUDED_RATIO sits between the two measured bands', () => {
    // Measured 2026-09-02 over all 263 completed judgments with a usable count:
    //   includes-reasoning band, n=245:   0.00 …   4.73
    //   excludes-reasoning band, n= 18:  36.73 … 156.69
    // The lower bound of the second band moves as runs drain (it was 37.76
    // before the relaunched 8192 run finished). The GAP does not — see the
    // REASONING_EXCLUDED_RATIO doc comment for why 8 is placed against the
    // physical ceiling of the first band rather than the midpoint of the gap.
    expect(REASONING_EXCLUDED_RATIO).toBeGreaterThan(4.73);
    expect(REASONING_EXCLUDED_RATIO).toBeLessThan(36.73);
  });
});

describe('calibration/token-accounting: accountTokens classification', () => {
  it('a ratio inside the 2-5 band means the provider ALREADY counted the reasoning', () => {
    for (const row of [QWEN36_MAX_RATIO, QWEN36_NEAR_BUDGET, GRANITE42_MAX_OUT]) {
      expect(accountTokens(row).accounting).toBe('includes_reasoning');
    }
    const acc = accountTokens(QWEN36_MAX_RATIO);
    expect(acc.charsPerOutputToken).toBeCloseTo(4.7291, 3);
    expect(acc.reasoningChars).toBe(12428);
  });

  it('a ratio far above the tokenizer ceiling means the count EXCLUDES reasoning', () => {
    for (const row of [Q35_MIN_RATIO, Q35_THE_INCIDENT]) {
      expect(accountTokens(row).accounting).toBe('excludes_reasoning');
    }
    expect(accountTokens(Q35_THE_INCIDENT).charsPerOutputToken).toBeCloseTo(156.687, 2);
  });

  it('exactly at the threshold the count is treated as INCLUDING reasoning', () => {
    // The boundary is `> REASONING_EXCLUDED_RATIO`, not `>=`. 8.0 is still a
    // physically possible chars-per-token, so it is not evidence of exclusion;
    // only a ratio that cannot be a tokenizer rate is.
    expect(800 / 100).toBe(REASONING_EXCLUDED_RATIO);
    expect(accountTokens({ outputTokens: 100, reasoningContent: chars(800) }).accounting).toBe(
      'includes_reasoning'
    );
    expect(accountTokens({ outputTokens: 100, reasoningContent: chars(801) }).accounting).toBe(
      'excludes_reasoning'
    );
  });

  it('no reasoning channel is its own answer, never "includes"', () => {
    // granite4.1:3b emits no thinking at all. Claiming `includes_reasoning`
    // here would assert a measurement that was never made.
    const acc = accountTokens(GRANITE41_NO_REASONING);
    expect(acc.accounting).toBe('no_reasoning_channel');
    expect(acc.reasoningChars).toBe(0);
    expect(acc.charsPerOutputToken).toBe(0);
  });

  it('an empty-string reasoning channel is the same as none', () => {
    expect(accountTokens({ outputTokens: 163, reasoningContent: '' }).accounting).toBe(
      'no_reasoning_channel'
    );
  });
});

describe('calibration/token-accounting: estimatedGeneratedTokens is DERIVED and never a fabrication', () => {
  it('when the provider already counted reasoning, the estimate IS the provider count', () => {
    // Adding a chars-derived reasoning estimate here would double-count: the
    // measured `Σ(reasoningChars+contentChars)/Σ outputTokens` on this judge
    // is 3.762, i.e. outputTokens already covers the whole generated stream.
    expect(accountTokens(QWEN36_NEAR_BUDGET).estimatedGeneratedTokens).toBe(7272);
    expect(accountTokens(GRANITE42_MAX_OUT).estimatedGeneratedTokens).toBe(9160);
    expect(accountTokens(GRANITE41_NO_REASONING).estimatedGeneratedTokens).toBe(163);
  });

  it('when it did not, the two channels ADD — this is the item nothing could see', () => {
    // The live incident: 6144-token budget, finishReason 'stop', outputTokens
    // 115. 115 + round(18019 / 3.64) = 115 + 4950 = 5065 tokens generated.
    expect(accountTokens(Q35_THE_INCIDENT).estimatedGeneratedTokens).toBe(5065);
    expect(accountTokens(Q35_MIN_RATIO).estimatedGeneratedTokens).toBe(1683);
  });

  it('an absent outputTokens yields null, NEVER zero', () => {
    // The 2026-08-30 register forbids conflating an absent measurement with a
    // measured one. A 0 here would flow into a tok/s denominator and into a
    // truncation fraction as "this judgment generated nothing", which is the
    // opposite of what an unmeasured row means.
    for (const outputTokens of [null, undefined, 0]) {
      const acc = accountTokens({ outputTokens, reasoningContent: chars(44287) });
      expect(acc.accounting).toBe('unmeasurable');
      expect(acc.estimatedGeneratedTokens).toBeNull();
      expect(acc.charsPerOutputToken).toBeNull();
      // The one thing that IS measured on such a row is still reported.
      expect(acc.reasoningChars).toBe(44287);
    }
  });

  it('a negative outputTokens is unmeasurable, not a negative estimate', () => {
    expect(accountTokens({ outputTokens: -1, reasoningContent: chars(10) }).accounting).toBe(
      'unmeasurable'
    );
  });
});
```

- [ ] **Step 3: Run it and confirm it fails for the reason expected**

```bash
cd /root/judge-arena && npx vitest run tests/lib/calibration-token-accounting.test.ts
```

**Exact expected FAIL** (captured on this machine, vitest 3.2.4, by running this precise import against the not-yet-created module):

```
⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/lib/calibration-token-accounting.test.ts [ tests/lib/calibration-token-accounting.test.ts ]
Error: Cannot find module '@/lib/calibration/token-accounting' imported from '/root/judge-arena/tests/lib/calibration-token-accounting.test.ts'.
```

If it fails with anything else — in particular an assertion failure, which would mean the module already exists — **stop and diagnose.**

- [ ] **Step 4: Minimal implementation**

Create `/root/judge-arena/src/lib/calibration/token-accounting.ts` with exactly this content:

```ts
/**
 * ─── Token accounting: what the provider COUNTED vs. what the model GENERATED ──
 *
 * `ModelJudgment.outputTokens` is `usage.completion_tokens` verbatim
 * (src/lib/llm/openai-compatible.ts:260). What that number MEANS varies by
 * MODEL — not by backend, and not by `reasoningSource`. Measured 2026-09-02,
 * two identical requests to Ollama 0.32.15 (qwen3.5:9b) differing only by
 * `response_format`:
 *
 *   plain                          completion_tokens 1069   reasoning 2583 chars + content 530
 *   + response_format json_schema  completion_tokens  196   reasoning 2304 chars + content 598
 *
 * The judge path ALWAYS sends the schema — `ollamaStructuredRequestFields`
 * (src/lib/llm/backends/ollama.ts:45) and `llamacppStructuredRequestFields`
 * (backends/llamacpp.ts:30) both emit `response_format: {type:'json_schema'}`,
 * and `openai-compatible.ts:210-212` attaches it to every `mode: 'judgment'`
 * call — so the judge path is the affected one.
 *
 * WHY THIS IS NOT A COLUMN. `reasoningContent` is already persisted verbatim
 * and never truncated (prisma/schema.prisma:514-519), so its length is exact
 * and free at read time. A `reasoningChars` column would duplicate a column
 * that is already there, would be NULL on every pre-existing row, and would
 * need writing at FOUR persist seams — `commonSuccessUpdateData`
 * (src/worker/judgment-consumer.ts:725-757, covering judge/respond/pairwise)
 * and `markJudgmentError` (:632-674), which is the seam that matters most
 * because a truncated or looping judgment is an `error` row. One missed seam
 * is the partial rollout that looked live in production for an hour
 * (handoff §5.1). Read time has zero seams and cannot drift from its source.
 *
 * NOTHING HERE IS EVER WRITTEN TO `outputTokens`. That column means, and
 * keeps meaning, "what the provider reported". Everything this module returns
 * is DERIVED and is labelled DERIVED wherever it is printed.
 *
 * NOT A TOKENIZER. No tokenizer is installed and none is being added; the
 * exact split is only obtainable from a second round trip to a native API,
 * which is deliberately out of scope.
 *
 * LEAF MODULE: zero imports, by design. `scripts/calibration/run.ts` is
 * bundled into the image's `calibration-run.js` by esbuild, and
 * `.dockerignore:72` promises that bundle pulls in `src/lib/calibration/**`
 * and `@/lib/db` only.
 */

/**
 * Characters of generated text per output token.
 *
 * DERIVED, with the arithmetic. On the two judges whose provider count
 * demonstrably INCLUDES the reasoning channel, `Σ length(reasoningContent) /
 * Σ outputTokens` measured 2026-09-02 over every completed judgment:
 *
 *   Qwen3.6-35B-A3B (llama.cpp, n=145)   3.52
 *   granite4.2:3b   (Ollama,    n= 40)   3.76
 *   mean                                 3.64   <- this constant
 *
 * Written as the literal `3.64`, not as `(3.52 + 3.76) / 2`, which evaluates
 * to 3.6399999999999997.
 *
 * WHY THE SLIGHT UNDERSTATEMENT IS DELIBERATE. Those two ratios divide
 * reasoning chars by ALL output tokens — reasoning plus content — so each
 * understates true chars-per-token, and a SMALLER constant produces a LARGER
 * token estimate, which is the safe direction for a budget warning. The
 * unbiased figure, `Σ (reasoningChars + rawResponseChars) / Σ outputTokens`
 * on the same two populations, is 3.762 and 3.868 (mean 3.82): 3.64 therefore
 * runs 3.82 / 3.64 = 1.049, about 5% high, on purpose.
 *
 * ERROR BARS: +-10%. Measured against the only available ground truth — the
 * provider's own count, on the two judges where it is comparable — the
 * whole-stream chars model reads +7.1% (Qwen3.6) and +7.6% (granite4.2). The
 * spread of the two inputs is 3.52…3.76, +-3.3% about the mean. Treat every
 * number derived from this constant as an estimate with a 10% band, never as
 * a measurement — which is why the report prints `outputTokens` and the raw
 * character count beside every estimate, so an operator can re-derive under a
 * different constant without re-running anything.
 */
export const CHARS_PER_TOKEN = 3.64;

/**
 * Above this ratio of `length(reasoningContent) / outputTokens`, the
 * provider's count EXCLUDES the reasoning channel.
 *
 * WHY A RATIO IS THE ONLY DISCRIMINATOR AVAILABLE: the semantics vary per
 * MODEL. granite4.2:3b and qwen3.5:9b are both Ollama and both report
 * `reasoningSource: 'reasoning'`, and they disagree — so neither
 * `servingBackend` nor `reasoningSource` separates them, and nothing on the
 * wire says which meaning applies.
 *
 * WHY 8. When the count INCLUDES reasoning, `reasoningTokens <= outputTokens`,
 * so this ratio is bounded above by the model's own chars-per-token — it
 * cannot physically exceed it. The largest chars-per-token measured on any
 * stream in this corpus is 4.909 (granite4.1:3b, content only), so a
 * physically consistent "includes" reading tops out near 5. Measured
 * 2026-09-02 over every completed judgment:
 *
 *   includes   Qwen3.6 + granite4.2 + granite4.1   n=245   ratio   0.00 …   4.73
 *   excludes   qwen3.5:9b                          n= 18   ratio  36.73 … 156.69
 *
 * 8 sits 1.69x above the highest "includes" reading and 4.6x below the lowest
 * "excludes" one. Any threshold in 5…37 classifies this corpus identically; 8
 * is placed just above the PHYSICAL ceiling rather than at the midpoint of an
 * empirical gap, because the ceiling is the part that generalises to a model
 * this corpus has never seen.
 *
 * The comparison is `>`, not `>=`: a ratio of exactly 8.0 is still a possible
 * tokenizer rate and is therefore not evidence of anything.
 */
export const REASONING_EXCLUDED_RATIO = 8;

/**
 * What `outputTokens` was found to count for one judgment.
 *
 * `unmeasurable` and `no_reasoning_channel` are separate values on purpose:
 * the first means the provider reported no usable token count, the second
 * means the model emitted no thinking. Collapsing either into
 * `includes_reasoning` would assert a measurement that was never made.
 */
export type ReasoningAccounting =
  | 'includes_reasoning'
  | 'excludes_reasoning'
  | 'no_reasoning_channel'
  | 'unmeasurable';

export interface TokenAccounting {
  accounting: ReasoningAccounting;
  /** `reasoningContent.length` — UTF-16 code units, the same definition
   * `scripts/calibration/run.ts`'s `cap()` prints as "N chars". Exact, and
   * free: the column is stored verbatim. */
  reasoningChars: number;
  /** `reasoningChars / outputTokens`. `null` when `outputTokens` is not a
   * usable positive count — never 0, which would read as a measured ratio. */
  charsPerOutputToken: number | null;
  /** DERIVED total tokens the model generated, reasoning included. `null`
   * when `outputTokens` is absent. NEVER written to `ModelJudgment
   * .outputTokens`, and never presented without the DERIVED label. */
  estimatedGeneratedTokens: number | null;
}

export function accountTokens(input: {
  outputTokens?: number | null;
  reasoningContent?: string | null;
}): TokenAccounting {
  const reasoningChars = input.reasoningContent?.length ?? 0;
  const outputTokens = input.outputTokens ?? null;

  // An absent or non-positive provider count is an ABSENCE. Returning 0 here
  // would put "this judgment generated nothing" into a tok/s denominator and
  // into a truncation fraction — the exact conflation the 2026-08-30 register
  // forbids for `reasoningTokens`, for the same reason.
  if (outputTokens === null || outputTokens <= 0) {
    return {
      accounting: 'unmeasurable',
      reasoningChars,
      charsPerOutputToken: null,
      estimatedGeneratedTokens: null,
    };
  }

  // No thinking was emitted at all, so there is no hidden channel that could
  // be missing from the count: the provider's number is the whole generation.
  // `extractReasoningChannel` (src/lib/llm/openai-compatible.ts:169-187) has
  // already looked at `reasoning_content`, `reasoning` and an in-band
  // `<think>` block, so "no channel here" means "no channel on the wire".
  if (reasoningChars === 0) {
    return {
      accounting: 'no_reasoning_channel',
      reasoningChars,
      charsPerOutputToken: 0,
      estimatedGeneratedTokens: outputTokens,
    };
  }

  const charsPerOutputToken = reasoningChars / outputTokens;

  if (charsPerOutputToken > REASONING_EXCLUDED_RATIO) {
    // The two channels add: `outputTokens` is the content alone.
    return {
      accounting: 'excludes_reasoning',
      reasoningChars,
      charsPerOutputToken,
      estimatedGeneratedTokens: outputTokens + Math.round(reasoningChars / CHARS_PER_TOKEN),
    };
  }

  // The provider already counted the thinking; adding a chars-derived
  // estimate on top would double-count it. Measured: on these judges
  // `Σ(reasoningChars + contentChars) / Σ outputTokens` is 3.762 and 3.868,
  // i.e. `outputTokens` already covers the whole generated stream.
  return {
    accounting: 'includes_reasoning',
    reasoningChars,
    charsPerOutputToken,
    estimatedGeneratedTokens: outputTokens,
  };
}
```

- [ ] **Step 5: Run it to pass**

```bash
cd /root/judge-arena && npx vitest run tests/lib/calibration-token-accounting.test.ts
```

Expected: `Test Files  1 passed (1)` with **11** tests passing. If the count differs, count the `it(` blocks in the file and reconcile before continuing (failure mode 15 — the printed number wins, and an unexplained delta is a finding).

- [ ] **Step 6: INJECTION A — the threshold is load-bearing**

Edit `/root/judge-arena/src/lib/calibration/token-accounting.ts`.

old_string:
```
export const REASONING_EXCLUDED_RATIO = 8;
```
new_string:
```
export const REASONING_EXCLUDED_RATIO = 200;
```

```bash
cd /root/judge-arena && npx vitest run tests/lib/calibration-token-accounting.test.ts
```

**Expected RED**, at least these:
- `REASONING_EXCLUDED_RATIO sits between the two measured bands` → `expected 200 to be less than 36.73`
- `a ratio far above the tokenizer ceiling means the count EXCLUDES reasoning` → `expected 'includes_reasoning' to be 'excludes_reasoning'`
- `when it did not, the two channels ADD` → `expected 115 to be 5065`

**Restore the `8` and re-run to green before continuing.**

*What wrong implementation would still pass this?* One that hardcoded `>= 8` or `> 7` — the constant would be edited and the behaviour unchanged for this corpus. Injection B discriminates that.

- [ ] **Step 7: INJECTION B — the boundary operator**

Edit `/root/judge-arena/src/lib/calibration/token-accounting.ts`.

old_string:
```
  if (charsPerOutputToken > REASONING_EXCLUDED_RATIO) {
```
new_string:
```
  if (charsPerOutputToken >= REASONING_EXCLUDED_RATIO) {
```

```bash
cd /root/judge-arena && npx vitest run tests/lib/calibration-token-accounting.test.ts
```

**Expected RED, and exactly one test:**
- `exactly at the threshold the count is treated as INCLUDING reasoning` → `expected 'excludes_reasoning' to be 'includes_reasoning'`

That only one test moves is the point: it proves the boundary case is the only thing this assertion pins, and that no other test is accidentally sitting on the boundary. **Restore `>` and re-run to green.**

- [ ] **Step 8: INJECTION C — an absent measurement must not become a zero**

Edit `/root/judge-arena/src/lib/calibration/token-accounting.ts`.

old_string:
```
      accounting: 'unmeasurable',
      reasoningChars,
      charsPerOutputToken: null,
      estimatedGeneratedTokens: null,
```
new_string:
```
      accounting: 'unmeasurable',
      reasoningChars,
      charsPerOutputToken: 0,
      estimatedGeneratedTokens: 0,
```

```bash
cd /root/judge-arena && npx vitest run tests/lib/calibration-token-accounting.test.ts
```

**Expected RED:**
- `an absent outputTokens yields null, NEVER zero` → `expected +0 to be null`
- `a negative outputTokens is unmeasurable, not a negative estimate` stays GREEN (it asserts only the classification), which is correct and is why the null assertion is a separate test.

**Blast radius, measured by actually applying this injection: exactly ONE test reddens** — `Tests  1 failed | 10 passed (11)`. That is the count **in Task 1's state**, where the file holds only these 11 tests. If you re-run this injection AFTER Task 2 has appended its blocks, four tests redden (`an absent outputTokens yields null, NEVER zero`, `is null — never 0% and never 100% — when either input is absent`, `prints the corpus exactly`, `says so rather than printing an empty range when nothing is measurable`) plus the CLI guard if `run.ts` is not yet wired. Both counts are correct for their state; know which state you are in before calling a delta a finding.

**Restore both `null`s and re-run to green.**

- [ ] **Step 9: INJECTION D — the additive term in the excluded branch**

Edit `/root/judge-arena/src/lib/calibration/token-accounting.ts`.

old_string:
```
      estimatedGeneratedTokens: outputTokens + Math.round(reasoningChars / CHARS_PER_TOKEN),
```
new_string:
```
      estimatedGeneratedTokens: Math.round(reasoningChars / CHARS_PER_TOKEN),
```

```bash
cd /root/judge-arena && npx vitest run tests/lib/calibration-token-accounting.test.ts
```

**Expected RED:**
- `when it did not, the two channels ADD` → `expected 4950 to be 5065`

`4950` versus `5065` is a 2.3% difference on one item — small enough that a "close enough" assertion would have missed it, which is why the test asserts the exact integer rather than a `toBeCloseTo`.

**Blast radius, measured: exactly ONE test reddens in Task 1's state** — `Tests  1 failed | 10 passed (11)`. Re-run after Task 2 appends its blocks and three redden (this one, `sees the item outputTokens hid: 5065 of 6144, reported as 115`, `prints the corpus exactly`) plus the CLI guard if `run.ts` is unwired.

**Restore the `outputTokens +` and re-run to green.**

- [ ] **Step 10: Gates**

```bash
cd /root/judge-arena && npm run lint && npx tsc --noEmit && npm run test:coverage 2>&1 | tail -30
```

Expected: lint 0 warnings; tsc silent; **`B + 11` tests over `F + 1` files**, where `B`/`F` are the numbers Step 0 printed — on a `0a6669e` baseline of 917/58 that is `Tests  928 passed (928)` over `Test Files  59 passed (59)`. **This is arithmetic on Step 0's measurement, not itself a measurement** (failure mode 15). Use whatever `test:coverage` actually prints in the commit message, and if the delta from `B` is not exactly `+11`, count the `it(` blocks in the new file (there are 11) and diagnose before committing.

No coverage floor moves: the new file is a fully-covered `src/lib/**` module, which can only raise the aggregate. **If `test:coverage` reports a threshold failure, do not touch `vitest.config.ts`** — a floor never goes down (CONTRIBUTING.md's coverage section; `vitest.config.ts:187-220`).

`npm run test:db:coverage`, `npm run test:integration` and `npm run build` are deliberately **not** run for this commit: it creates one leaf module under `src/lib/` and one unit test, reaches no `tests/db/**` or `tests/integration/**` file, touches no Prisma schema and no Next surface. Task 2 runs the full chain once for the branch.

- [ ] **Step 11: Commit**

**First, prove the index is empty** (Global Constraints — `git add … && git commit` commits the whole index, and a sibling plan's staged work has appeared in this checkout twice):

```bash
cd /root/judge-arena && git diff --cached --name-only
```
Expected: **empty**. If it prints anything, stop and hand it to the operator; do not `git reset` another agent's work. All three paths below are untracked at this point, so `git commit --only` alone would fail (`error: pathspec … did not match any file(s) known to git`) — `git add` them first, then verify the staged set before committing:

```bash
git -C /root/judge-arena add \
  src/lib/calibration/token-accounting.ts \
  tests/lib/calibration-token-accounting.test.ts \
  docs/superpowers/plans/2026-09-02-token-accounting-and-truncation-proximity.md
git -C /root/judge-arena status --short
```
Expected: exactly those three paths, each prefixed `A `. Then commit with `--only`, which restricts the commit to those paths and cannot pull the rest of the index in:

```bash
git -C /root/judge-arena commit --only \
  src/lib/calibration/token-accounting.ts \
  tests/lib/calibration-token-accounting.test.ts \
  docs/superpowers/plans/2026-09-02-token-accounting-and-truncation-proximity.md \
  -F - <<'EOF'
feat(calibration): outputTokens does not always count the reasoning channel — derive the total

`ModelJudgment.outputTokens` is `usage.completion_tokens` verbatim
(src/lib/llm/openai-compatible.ts:260), and whether that number includes the
reasoning channel varies per MODEL — not per backend and not per
`reasoningSource`. granite4.2:3b and qwen3.5:9b are both Ollama, both report
`reasoningSource: 'reasoning'`, and they disagree. Two identical requests to
Ollama 0.32.15 differing only by `response_format` isolate the cause: plain
returns `completion_tokens 1069` for 2583 chars of reasoning + 530 of content;
`response_format: {type:'json_schema'}` returns 196 for 2304 + 598. The judge
path always sends the schema.

`accountTokens` classifies one judgment from `length(reasoningContent) /
outputTokens` and returns a DERIVED `estimatedGeneratedTokens`. Measured
2026-09-02 over all 263 completed judgments with a usable count, the two bands
do not overlap: 0.00…4.73 where the count includes reasoning (n=245),
36.73…156.69 where it does not (n=18). The threshold is 8 — just above the
physical ceiling, since
`reasoningTokens <= outputTokens` bounds the ratio by chars-per-token when the
count includes reasoning, and the largest chars-per-token in the corpus is
4.909.

`CHARS_PER_TOKEN = 3.64` is the mean of the two measured chars-per-output-token
ratios (3.52, 3.76), written as a literal because the expression evaluates to
3.6399999999999997. It runs ~5% low against the unbiased 3.82, on purpose: a
smaller constant yields a larger estimate, which is the safe direction for a
budget warning. Error bar +-10%, from the +7.1%/+7.6% residual measured against
the provider's own count on the two judges where both numbers exist.

No column and no migration: `reasoningContent` is already persisted verbatim, so
`length()` is exact and free at read time, and a written column would need four
persist seams including `markJudgmentError` — the seam a truncated judgment
actually uses. `outputTokens` keeps meaning "what the provider reported" and is
never overwritten; an absent count yields `null`, never 0.

Gates: lint 0, tsc 0, <B+11> unit / n-a db (no tests/db file, no schema change) / n-a integration (no tests/integration file), coverage 0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
EOF
```

Replace `<B+11>` with whatever `test:coverage` printed (928 on a 917 baseline). Then verify the commit took exactly the three named files and nothing else:

```bash
cd /root/judge-arena && git show --stat --oneline HEAD
```
Expected: **3 files changed**. Any fourth file is a leaked index — that commit belongs to two concerns and must be reported, not amended around.

---

### Task 2: truncation proximity — make 82%-of-budget visible before the next run is sized

**Files:**
- Modify: `/root/judge-arena/src/lib/calibration/token-accounting.ts` — append `resolveMaxTokens`, `truncationProximity`, `formatTokenAccountingLines` and `TRUNCATION_PROXIMITY_WARN` after `accountTokens`
- Modify (Test): `/root/judge-arena/tests/lib/calibration-token-accounting.test.ts` — append the Task 2 `describe` blocks
- Modify: `/root/judge-arena/scripts/calibration/run.ts:54` (one import line inserted after it), `:405` (the block inserted before `const first = …`), `:410` (the one-judgment token line)

**Interfaces:**
- Consumes: `accountTokens`, `CHARS_PER_TOKEN`, `REASONING_EXCLUDED_RATIO` from Task 1; `scripts/calibration/run.ts`'s existing `judgments` rows (`status`, `outputTokens`, `reasoningContent`, `samplingParams`, `run.goldenItem.index` — **all five are already in the `select` at `:292-305`; this task adds no `select` field**) and its existing `headerSampling` (`:160`, `:170`, `:228`).
- Produces:
  - `export const TRUNCATION_PROXIMITY_WARN = 0.8;`
  - `export interface MaxTokensResolution { maxTokens: number; source: 'judgment' | 'run_header'; }`
  - `export function resolveMaxTokens(judgmentSampling: unknown, headerSampling: unknown): MaxTokensResolution | null`
  - `export interface TruncationProximity { estimatedGeneratedTokens: number; maxTokens: number; maxTokensSource: 'judgment' | 'run_header'; fraction: number; near: boolean; }`
  - `export function truncationProximity(accounting: TokenAccounting, maxTokens: MaxTokensResolution | null): TruncationProximity | null`
  - `export interface TokenAccountingRow { goldenItemIndex: number | null; status: string; outputTokens: number | null; reasoningContent: string | null; samplingParams: unknown; }`
  - `export function formatTokenAccountingLines(rows: ReadonlyArray<TokenAccountingRow>, headerSampling: unknown): string[]`

- [ ] **Step 0: Confirm the starting state**

```bash
cd /root/judge-arena && git log -1 --format='%h %s' && git diff --cached --name-only && git status --porcelain --untracked-files=no
```

Expected: HEAD is Task 1's commit A (`feat(calibration): outputTokens does not always count…`), `git diff --cached --name-only` prints **nothing**, and `git status --porcelain --untracked-files=no` prints **nothing except, possibly, ` M docs/superpowers/plans/2026-09-02-token-accounting-and-truncation-proximity.md`** — that file became tracked in commit A, so a ticked `- [ ]` checkbox is a legitimate dirty entry and is NOT a finding (same allowance as Task 3 Step 6). Untracked `?? docs/superpowers/plans/*.md` files are other plans; **their count changes as siblings land, so do not assert it** (it was nine when this plan was drafted, eight on `0a6669e`). If `src/lib/calibration/token-accounting.ts` is missing, or if any OTHER tracked file is dirty or staged, stop.

- [ ] **Step 1: Verify the floating-point boundary by hand before writing the test**

CONTRIBUTING.md:230 — *"Work the arithmetic by hand before you write the module"*; a fixture that cannot fail under any implementation is a green test that means nothing. The `>= 0.80` boundary fixture uses `4096 / 5120`, which is `0.8` in real arithmetic. Confirm it is also `0.8` as an IEEE754 double:

```bash
node -e "console.log('4096/5120===0.8', 4096/5120===0.8, '| 7272/8192', (7272/8192*100).toFixed(1), '| 9160/12288', (9160/12288*100).toFixed(1), 9160/12288>=0.8, '| 5065/6144', (5065/6144*100).toFixed(1))"
```

**Exact expected output:**
```
4096/5120===0.8 true | 7272/8192 88.8 | 9160/12288 74.5 false | 5065/6144 82.4
```

If `4096/5120===0.8` printed `false`, the boundary test below would be untestable as written and the fixture must change; do not proceed on an assumption.

- [ ] **Step 2: Write the failing test**

Append to `/root/judge-arena/tests/lib/calibration-token-accounting.test.ts`. First replace the import block at the top of the file:

old_string:
```
import { describe, expect, it } from 'vitest';
import {
  CHARS_PER_TOKEN,
  REASONING_EXCLUDED_RATIO,
  accountTokens,
} from '@/lib/calibration/token-accounting';
```
new_string:
```
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CHARS_PER_TOKEN,
  REASONING_EXCLUDED_RATIO,
  TRUNCATION_PROXIMITY_WARN,
  accountTokens,
  formatTokenAccountingLines,
  resolveMaxTokens,
  truncationProximity,
  type TokenAccountingRow,
} from '@/lib/calibration/token-accounting';
```

Then append these blocks to the end of the file:

```ts
// ─── The report corpus ─────────────────────────────────────────────────────
//
// Five real judgments, measured 2026-09-02. Row 2 is the item that motivated
// this work: 6144-token budget, finishReason 'stop', outputTokens 115, and an
// estimated 5065 tokens actually generated — 82.4% of budget, invisible in
// every number the report printed before this change. Row 5 is the
// repetition-loop shape from handoff §5.2: 44,287 chars of reasoning on a row
// that never produced a usable token count.
const CORPUS: TokenAccountingRow[] = [
  {
    goldenItemIndex: 8,
    status: 'completed',
    outputTokens: 7272,
    reasoningContent: chars(18819),
    samplingParams: { max_tokens: 8192, temperature: 0.3 },
  },
  {
    goldenItemIndex: 12,
    status: 'completed',
    outputTokens: 115,
    reasoningContent: chars(18019),
    samplingParams: { max_tokens: 6144, temperature: 0.3 },
  },
  {
    goldenItemIndex: 3,
    status: 'completed',
    outputTokens: 9160,
    reasoningContent: chars(35212),
    samplingParams: { max_tokens: 12288, temperature: 0.3 },
  },
  {
    goldenItemIndex: 5,
    status: 'completed',
    outputTokens: 163,
    reasoningContent: null,
    samplingParams: { max_tokens: 4096, temperature: 0.3 },
  },
  {
    goldenItemIndex: 9,
    status: 'error',
    outputTokens: null,
    reasoningContent: chars(44287),
    samplingParams: null,
  },
];

describe('calibration/token-accounting: resolveMaxTokens', () => {
  it('prefers the JUDGMENT over the run header — execution truth beats launch intent', () => {
    // v2k's whole point (src/lib/calibration/sampling-drift.ts): the header is
    // what the run was LAUNCHED under, each judgment is what it was EXECUTED
    // under, and they diverge when the version row is edited mid-run. Sizing
    // must use what actually ran.
    expect(
      resolveMaxTokens({ max_tokens: 12288, temperature: 0.3 }, { max_tokens: 6144, temperature: 0.3 })
    ).toEqual({ maxTokens: 12288, source: 'judgment' });
  });

  it('falls back to the run header, and says so', () => {
    // `markJudgmentError` (src/worker/judgment-consumer.ts:645-671) does not
    // write `samplingParams`, so an errored judgment — the truncation case —
    // has none. The v2k header is a recorded snapshot, not a default, and
    // `detectSamplingDrift` already warns when the two disagree.
    expect(resolveMaxTokens(null, { max_tokens: 6144, temperature: 0.3 })).toEqual({
      maxTokens: 6144,
      source: 'run_header',
    });
  });

  it('returns null rather than inventing a registry default', () => {
    // JUDGE_DEFAULT_SAMPLING_PARAMS.max_tokens is 4096 (src/lib/llm/sampling.ts:43).
    // Falling through to it would present a guess as the budget a run used —
    // the exact lie `describeSamplingSnapshot` exists to avoid.
    expect(resolveMaxTokens(null, null)).toBeNull();
    expect(resolveMaxTokens({ temperature: 0.3 }, {})).toBeNull();
    expect(resolveMaxTokens('4096', undefined)).toBeNull();
    expect(resolveMaxTokens({ max_tokens: '8192' }, null)).toBeNull();
    expect(resolveMaxTokens({ max_tokens: 0 }, null)).toBeNull();
  });
});

describe('calibration/token-accounting: truncationProximity', () => {
  it('warns at exactly the threshold — the boundary is >=, not >', () => {
    const acc = accountTokens({ outputTokens: 4096, reasoningContent: null });
    const prox = truncationProximity(acc, { maxTokens: 5120, source: 'judgment' });
    expect(prox?.fraction).toBe(TRUNCATION_PROXIMITY_WARN);
    expect(prox?.near).toBe(true);
  });

  it('does not warn just below it', () => {
    const acc = accountTokens({ outputTokens: 4095, reasoningContent: null });
    expect(truncationProximity(acc, { maxTokens: 5120, source: 'judgment' })?.near).toBe(false);
  });

  it('sees the item outputTokens hid: 5065 of 6144, reported as 115', () => {
    const acc = accountTokens({ outputTokens: 115, reasoningContent: chars(18019) });
    const prox = truncationProximity(acc, { maxTokens: 6144, source: 'judgment' });
    expect(prox?.estimatedGeneratedTokens).toBe(5065);
    expect(prox?.near).toBe(true);
    // What the report printed before this change, for the same judgment:
    expect(115 / 6144).toBeLessThan(0.02);
  });

  it('is null — never 0% and never 100% — when either input is absent', () => {
    const unmeasurable = accountTokens({ outputTokens: null, reasoningContent: chars(18019) });
    expect(truncationProximity(unmeasurable, { maxTokens: 6144, source: 'judgment' })).toBeNull();
    const measured = accountTokens({ outputTokens: 115, reasoningContent: chars(18019) });
    expect(truncationProximity(measured, null)).toBeNull();
  });
});

describe('calibration/token-accounting: formatTokenAccountingLines', () => {
  it('prints the corpus exactly', () => {
    expect(formatTokenAccountingLines(CORPUS, { max_tokens: 8192, temperature: 0.3 })).toEqual([
      '  accounting          includes_reasoning 2   excludes_reasoning 1   no_reasoning_channel 1   unmeasurable 1',
      "  chars/outputToken   2.59 … 156.69 over 3 judgment(s) with a reasoning channel   (> 8 ⇒ the provider's count EXCLUDES reasoning)",
      '  est. generation     closest to budget: 7272 tok = 88.8% of max_tokens 8192   (DERIVED at 3.64 chars/token, ±10%)',
      '  ⚠ 2 of 4 sized judgment(s) estimate at or above 80.0% of max_tokens. Size the next run from the ESTIMATE, not from outputTokens — but read runbook §8.2 first: a large estimate can be a repetition loop, which a bigger budget makes worse.',
      '       item 8  completed  est 7272 = 88.8% of 8192 (max_tokens from the judgment)  [outputTokens 7272, reasoning 18819 chars]',
      '       item 12  completed  est 5065 = 82.4% of 6144 (max_tokens from the judgment)  [outputTokens 115, reasoning 18019 chars]',
      '  ⓘ 1 judgment(s) had no usable outputTokens and 0 had no max_tokens on the judgment or the run header — excluded from every number above, never counted as zero.',
    ]);
  });

  it('names the run header when that is where max_tokens came from', () => {
    const errored: TokenAccountingRow[] = [
      {
        goldenItemIndex: 20,
        status: 'error',
        outputTokens: 115,
        reasoningContent: chars(18019),
        samplingParams: null,
      },
    ];
    const lines = formatTokenAccountingLines(errored, { max_tokens: 6144, temperature: 0.3 });
    expect(lines.some((l) => l.includes('(max_tokens from the run header)'))).toBe(true);
  });

  it('counts the judgments it could not size, rather than dropping them silently', () => {
    // A partial denominator that looks like a whole one is this repo's most
    // expensive recurring defect (runbook §4's expired-poll box, handoff §6
    // trap 8). Nothing is ever excluded without being counted.
    const unsizable: TokenAccountingRow[] = [
      {
        goldenItemIndex: 1,
        status: 'completed',
        outputTokens: 7272,
        reasoningContent: chars(18819),
        samplingParams: null,
      },
    ];
    expect(formatTokenAccountingLines(unsizable, null)).toEqual([
      '  accounting          includes_reasoning 1   excludes_reasoning 0   no_reasoning_channel 0   unmeasurable 0',
      "  chars/outputToken   2.59 … 2.59 over 1 judgment(s) with a reasoning channel   (> 8 ⇒ the provider's count EXCLUDES reasoning)",
      '  est. generation     no judgment had both an outputTokens count and a max_tokens — nothing to size against',
      '  ⓘ 0 judgment(s) had no usable outputTokens and 1 had no max_tokens on the judgment or the run header — excluded from every number above, never counted as zero.',
    ]);
  });

  it('omits the exclusions line only when there is genuinely nothing excluded', () => {
    const clean: TokenAccountingRow[] = [
      {
        goldenItemIndex: 3,
        status: 'completed',
        outputTokens: 9160,
        reasoningContent: chars(35212),
        samplingParams: { max_tokens: 12288, temperature: 0.3 },
      },
    ];
    const lines = formatTokenAccountingLines(clean, null);
    expect(lines).toHaveLength(3);
    expect(lines.some((l) => l.includes('excluded from every number above'))).toBe(false);
    expect(lines.some((l) => l.startsWith('  ⚠'))).toBe(false);
  });

  it('says so rather than printing an empty range when nothing is measurable', () => {
    const nothing: TokenAccountingRow[] = [
      {
        goldenItemIndex: 9,
        status: 'error',
        outputTokens: null,
        reasoningContent: chars(44287),
        samplingParams: null,
      },
    ];
    expect(formatTokenAccountingLines(nothing, null)).toEqual([
      '  accounting          includes_reasoning 0   excludes_reasoning 0   no_reasoning_channel 0   unmeasurable 1',
      '  chars/outputToken   no judgment carried both a reasoning channel and an outputTokens count',
      '  est. generation     no judgment had both an outputTokens count and a max_tokens — nothing to size against',
      '  ⓘ 1 judgment(s) had no usable outputTokens and 0 had no max_tokens on the judgment or the run header — excluded from every number above, never counted as zero.',
    ]);
  });

  it('is total over an empty run', () => {
    expect(formatTokenAccountingLines([], null)).toEqual([
      '  accounting          includes_reasoning 0   excludes_reasoning 0   no_reasoning_channel 0   unmeasurable 0',
      '  chars/outputToken   no judgment carried both a reasoning channel and an outputTokens count',
      '  est. generation     no judgment had both an outputTokens count and a max_tokens — nothing to size against',
    ]);
  });

  it('the real truncated shape: status error, samplingParams NULL, outputTokens == max_tokens', () => {
    // Measured 2026-09-02: 21 judgments carry finishReason 'length' — 20
    // granite4.2:3b and 1 Qwen3.6 — each with `outputTokens` exactly equal to
    // its budget (4096, 8192, 12288), `status: 'error'`, and NO samplingParams
    // of their own, because `markJudgmentError` does not write them. This is
    // the shape the report will print most often, and it is the only fixture
    // that exercises the run-header fallback and the 100%-of-budget path at
    // once. Without it, an implementation that clamped `fraction` below 1, or
    // returned null when estimate === maxTokens, passes every other test here.
    const truncated: TokenAccountingRow[] = [
      {
        goldenItemIndex: 4,
        status: 'error',
        outputTokens: 12288,
        reasoningContent: chars(56004),
        samplingParams: null,
      },
    ];
    const lines = formatTokenAccountingLines(truncated, { max_tokens: 12288, temperature: 0.3 });
    expect(lines[2]).toBe(
      '  est. generation     closest to budget: 12288 tok = 100.0% of max_tokens 12288   (DERIVED at 3.64 chars/token, ±10%)'
    );
    expect(lines[4]).toBe(
      '       item 4  error  est 12288 = 100.0% of 12288 (max_tokens from the run header)  [outputTokens 12288, reasoning 56004 chars]'
    );
  });

  it('lists at most ten near-budget items, and still counts all of them', () => {
    // `near.slice(0, 10)` is claimed behaviour with, otherwise, no coverage:
    // every other fixture has at most two near items, so deleting the cap — or
    // shrinking it to 1 — leaves the whole suite green while a run with 11+
    // near items prints a ⚠ header saying "12 of 12" above a list of one. The
    // visibility half is the entire deliverable, so it gets an assertion.
    const many: TokenAccountingRow[] = Array.from({ length: 12 }, (_, i) => ({
      goldenItemIndex: i,
      status: 'completed',
      outputTokens: 115,
      reasoningContent: chars(18019),
      samplingParams: { max_tokens: 6144, temperature: 0.3 },
    }));
    const lines = formatTokenAccountingLines(many, null);
    expect(lines.filter((l) => l.startsWith('       item ')).length).toBe(10);
    // The header counts all twelve: the cap truncates the LIST, never the
    // denominator. A cap that also dropped them from the count would be the
    // partial-denominator defect this module exists to avoid.
    expect(lines.some((l) => l.startsWith('  ⚠ 12 of 12 sized judgment(s)'))).toBe(true);
  });
});

describe('calibration/token-accounting: the CLI actually calls it', () => {
  // scripts/** is outside every coverage include (vitest.config.ts:37) and no
  // test can import run.ts (it calls main() at module scope), so the only
  // available guard on the wiring is the source text. This is a CALL-SITE
  // guard, not a behaviour test, and it is stated as such:
  //
  //   what it catches   — the block being deleted, renamed, computed and never
  //                       printed, called with the wrong header argument, or
  //                       built from the wrong Prisma columns
  //   what it does NOT  — anything about WHERE in the report the block appears,
  //                       and anything at all about whether the script RUNS
  //                       (nothing here executes run.ts; see the Post-landing
  //                       checklist item 3)
  const RUN_TS = readFileSync(new URL('../../scripts/calibration/run.ts', import.meta.url), 'utf8');

  it('imports and calls formatTokenAccountingLines, and prints every line it returns', () => {
    // A bare substring count cannot tell `formatTokenAccountingLines` from a
    // renamed `formatTokenAccountingLinesV2` (failure mode 3), so the `(`
    // is part of the pattern and the import is asserted separately.
    expect(RUN_TS).toContain("from '@/lib/calibration/token-accounting'");
    expect(RUN_TS.match(/formatTokenAccountingLines\(/g)).toHaveLength(1);
    // Returned lines must reach stdout. A computed-and-discarded call is the
    // exact wrong implementation the previous assertion cannot see.
    //
    // The ARGUMENTS are pinned, not skipped with `[^)]*`. The second parameter
    // is typed `unknown`, so `formatTokenAccountingLines(accountingRows, null)`
    // type-checks, lints, and passes every other assertion here — while
    // destroying the feature's core case: `markJudgmentError` writes no
    // `samplingParams` (all 46 production `status='error'` rows have it NULL),
    // so a null header unsizes every errored judgment and the truncated item
    // this plan exists to surface is never printed.
    expect(RUN_TS).toMatch(
      /for \(const line of formatTokenAccountingLines\(accountingRows, headerSampling\)\) console\.log\(line\);/
    );
    // And the row mapping, because tsc only closes the DROPPED-field half of
    // the mis-mapping risk, not the SWAPPED-field half: `reasoningContent:
    // j.reasoning` is `string | null` on both sides and would silently feed
    // the parsed rationale (also in the select at run.ts:294) to a function
    // that thinks it is reading the thinking channel.
    expect(RUN_TS).toContain('    outputTokens: j.outputTokens,');
    expect(RUN_TS).toContain('    reasoningContent: j.reasoningContent,');
    expect(RUN_TS).toContain('    samplingParams: j.samplingParams,');
  });
});
```

- [ ] **Step 3: Run it and confirm it fails for the reason expected**

```bash
cd /root/judge-arena && npx vitest run tests/lib/calibration-token-accounting.test.ts
```

**Exact expected result** (measured by materializing the Task 1 module plus this file and running the suite):

```
 Test Files  1 failed (1)
      Tests  16 failed | 11 passed (27)
```

**All 16 new tests fail and Task 1's 11 keep passing.** Note what does NOT happen: vitest's SSR transform rewrites `import { TRUNCATION_PROXIMITY_WARN } …` into a property read, so a missing named export is `undefined` rather than a load-time `SyntaxError` — the file still loads and the 11 Task 1 tests still run green. The new failures are `TypeError: resolveMaxTokens is not a function` and friends. If Task 1's 11 do NOT all pass, the Task 1 module was disturbed — stop and diagnose that, not this.

- [ ] **Step 4: Minimal implementation**

Append to `/root/judge-arena/src/lib/calibration/token-accounting.ts` (after `accountTokens`):

```ts
/**
 * Warn when a judgment's estimated generation reaches this fraction of the
 * `max_tokens` it ran under.
 *
 * WHY 0.80, with the counts. Measured 2026-09-02 over all 263 completed
 * judgments with a usable token count, this threshold fires on exactly TWO:
 *
 *   item at 88.8%  Qwen3.6 @ 8192,  outputTokens 7272 — one long item from truncating
 *   item at 82.4%  qwen3.5:9b @ 6144, outputTokens 115 — the run that had to be voided
 *
 * and stays silent on the other 261, including every one of the 40
 * granite4.2:3b judgments, whose widest is 74.7% (3058 of 4096). So it is not
 * an "every long item warns" threshold.
 *
 * WHY NOT HIGHER, and why not lower. The estimator's measured residual against
 * the provider's own count is +7.1% / +7.6% (see CHARS_PER_TOKEN), so an item
 * truly at 87% or above always reads at or above 80% and cannot hide; pushing
 * the threshold to 0.90 would surrender that margin. Dropping it to 0.70 would
 * add FIVE more items — three granite4.2 @ 4096 (widest 74.7%), one
 * granite4.2 @ 12288 (74.5%) and one Qwen3.6 @ 8192 — all healthy, which is
 * how an operator is trained to ignore the line.
 *
 * IT IS A WARNING, NOT A VERDICT, and the direction of the right response is
 * not obvious: `finish_reason: 'length'` is ambiguous between "ran out of
 * room" and "never going to stop" (handoff §5.2 — five looping items burned 41
 * of one run's 82 minutes for zero verdicts), so the line points at runbook
 * §8.2 rather than telling anyone to raise the budget. It also prints
 * `outputTokens` and the raw character count beside every estimate, so the
 * number can be re-derived under a different constant without re-running.
 *
 * ONE ASSUMPTION, STATED BECAUSE NOTHING HERE TESTS IT. The fraction below
 * assumes `max_tokens` bounds the WHOLE generated stream, reasoning included,
 * even on a model whose `completion_tokens` excludes it. That is confirmed
 * only where the count INCLUDES reasoning: measured 2026-09-02, all 21
 * `finishReason: 'length'` judgments in the corpus (20 granite4.2:3b, 1
 * Qwen3.6) carry `outputTokens` exactly equal to their budget — 4096, 8192,
 * 12288. On qwen3.5:9b — the only judge where the count EXCLUDES reasoning,
 * and therefore the only judge whose fraction this module changes at all —
 * `finishReason: 'length'` has NEVER been observed, across 18 completed
 * judgments at two budgets. So the budget's scope on that path is INFERRED,
 * not measured. It is consistent with every row in the corpus (no item's
 * estimate has ever exceeded its budget) and it is the conservative reading,
 * but if it is false the fraction on an `excludes_reasoning` row is an
 * overstatement. That is why the line prints `outputTokens` and the raw
 * character count beside every estimate, and why it points at runbook §8.2
 * instead of advising a bigger budget.
 */
export const TRUNCATION_PROXIMITY_WARN = 0.8;

export interface MaxTokensResolution {
  maxTokens: number;
  source: 'judgment' | 'run_header';
}

/** `max_tokens` off a `SamplingParams`-shaped JSONB value, or `null`. Total
 * over everything a `Json?` column can hold; a non-number or a non-positive
 * number is not a budget. */
function readMaxTokens(value: unknown): number | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = (value as Record<string, unknown>).max_tokens;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
}

/**
 * The `max_tokens` a judgment actually ran under.
 *
 * ORDER MATTERS. `ModelJudgment.samplingParams` is EXECUTION truth and wins;
 * `CalibrationRun.samplingParams` (v2k) is the LAUNCH snapshot and is the
 * fallback, because `markJudgmentError` (src/worker/judgment-consumer.ts
 * :645-671) does not write `samplingParams` — so the errored rows, which are
 * exactly the truncation cases, have none of their own. The two agree by
 * construction unless the version row was edited mid-run, and
 * `detectSamplingDrift` already warns about that separately.
 *
 * `null` is returned rather than falling through to
 * `JUDGE_DEFAULT_SAMPLING_PARAMS` (src/lib/llm/sampling.ts:43, max_tokens
 * 4096). A registry default is a guess; presenting one as the budget a run
 * used is the lie `describeSamplingSnapshot` exists to avoid.
 */
export function resolveMaxTokens(
  judgmentSampling: unknown,
  headerSampling: unknown
): MaxTokensResolution | null {
  const fromJudgment = readMaxTokens(judgmentSampling);
  if (fromJudgment !== null) return { maxTokens: fromJudgment, source: 'judgment' };
  const fromHeader = readMaxTokens(headerSampling);
  if (fromHeader !== null) return { maxTokens: fromHeader, source: 'run_header' };
  return null;
}

export interface TruncationProximity {
  estimatedGeneratedTokens: number;
  maxTokens: number;
  maxTokensSource: 'judgment' | 'run_header';
  fraction: number;
  near: boolean;
}

/** `null` when either half is missing — never a 0% that would read as "this
 * judgment generated nothing", and never a fraction against a guessed budget. */
export function truncationProximity(
  accounting: TokenAccounting,
  maxTokens: MaxTokensResolution | null
): TruncationProximity | null {
  if (accounting.estimatedGeneratedTokens === null || maxTokens === null) return null;
  const fraction = accounting.estimatedGeneratedTokens / maxTokens.maxTokens;
  return {
    estimatedGeneratedTokens: accounting.estimatedGeneratedTokens,
    maxTokens: maxTokens.maxTokens,
    maxTokensSource: maxTokens.source,
    fraction,
    near: fraction >= TRUNCATION_PROXIMITY_WARN,
  };
}

/**
 * One judgment as the report reads it. EVERY FIELD IS REQUIRED on purpose:
 * `scripts/calibration/run.ts` maps its Prisma rows into this shape field by
 * field, and an explicit mapping that silently drops a field is failure mode
 * 14 — a partial rollout with tsc green. Required fields make the drop a type
 * error instead.
 */
export interface TokenAccountingRow {
  goldenItemIndex: number | null;
  status: string;
  outputTokens: number | null;
  reasoningContent: string | null;
  samplingParams: unknown;
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/**
 * The Token-accounting block of the calibration capture report.
 *
 * The STRINGS live here rather than in the script because `scripts/**` is
 * outside every coverage `include` (vitest.config.ts:37) and has no harness,
 * and the `>= 0.80` boundary is exactly the rule that must stay tested
 * (CONTRIBUTING.md:247 — "Put every rule that can be silently wrong into
 * `src/lib/**` so that it *can* be unit-tested" — the same argument
 * `sampling-drift.ts` was extracted under).
 *
 * Nothing is ever dropped silently: judgments with no usable `outputTokens`
 * and judgments with no resolvable `max_tokens` are excluded from the ratios
 * and the fractions, and the count of each is printed. A partial denominator
 * that looks like a whole one is this repo's most expensive recurring defect.
 */
export function formatTokenAccountingLines(
  rows: ReadonlyArray<TokenAccountingRow>,
  headerSampling: unknown
): string[] {
  const counts: Record<ReasoningAccounting, number> = {
    includes_reasoning: 0,
    excludes_reasoning: 0,
    no_reasoning_channel: 0,
    unmeasurable: 0,
  };
  const ratios: number[] = [];
  const near: Array<{ row: TokenAccountingRow; prox: TruncationProximity }> = [];
  let widest: TruncationProximity | null = null;
  let sized = 0;
  let noMaxTokens = 0;

  for (const row of rows) {
    const acc = accountTokens(row);
    counts[acc.accounting] += 1;

    // A 0.00 from a judge with no thinking channel at all (granite4.1:3b)
    // would drag the printed range down and read as a suspiciously dense
    // tokenizer rather than as an absent channel.
    if (acc.charsPerOutputToken !== null && acc.reasoningChars > 0) {
      ratios.push(acc.charsPerOutputToken);
    }

    const prox = truncationProximity(acc, resolveMaxTokens(row.samplingParams, headerSampling));
    if (prox === null) {
      if (acc.estimatedGeneratedTokens !== null) noMaxTokens += 1;
      continue;
    }
    sized += 1;
    if (widest === null || prox.fraction > widest.fraction) widest = prox;
    if (prox.near) near.push({ row, prox });
  }

  const lines: string[] = [
    `  accounting          includes_reasoning ${counts.includes_reasoning}   ` +
      `excludes_reasoning ${counts.excludes_reasoning}   ` +
      `no_reasoning_channel ${counts.no_reasoning_channel}   ` +
      `unmeasurable ${counts.unmeasurable}`,
  ];

  lines.push(
    ratios.length > 0
      ? `  chars/outputToken   ${Math.min(...ratios).toFixed(2)} … ${Math.max(...ratios).toFixed(2)} ` +
          `over ${ratios.length} judgment(s) with a reasoning channel   ` +
          `(> ${REASONING_EXCLUDED_RATIO} ⇒ the provider's count EXCLUDES reasoning)`
      : '  chars/outputToken   no judgment carried both a reasoning channel and an outputTokens count'
  );

  lines.push(
    widest !== null
      ? `  est. generation     closest to budget: ${widest.estimatedGeneratedTokens} tok = ${pct(widest.fraction)} ` +
          `of max_tokens ${widest.maxTokens}   (DERIVED at ${CHARS_PER_TOKEN} chars/token, ±10%)`
      : '  est. generation     no judgment had both an outputTokens count and a max_tokens — nothing to size against'
  );

  if (near.length > 0) {
    lines.push(
      `  ⚠ ${near.length} of ${sized} sized judgment(s) estimate at or above ` +
        `${pct(TRUNCATION_PROXIMITY_WARN)} of max_tokens. Size the next run from the ESTIMATE, ` +
        'not from outputTokens — but read runbook §8.2 first: a large estimate can be a ' +
        'repetition loop, which a bigger budget makes worse.'
    );
    // Capped at ten, matching the Failures block below it in the report.
    for (const { row, prox } of near.slice(0, 10)) {
      lines.push(
        `       item ${row.goldenItemIndex ?? '?'}  ${row.status}  ` +
          `est ${prox.estimatedGeneratedTokens} = ${pct(prox.fraction)} of ${prox.maxTokens} ` +
          `(max_tokens from the ${prox.maxTokensSource === 'judgment' ? 'judgment' : 'run header'})  ` +
          `[outputTokens ${row.outputTokens ?? 'NULL'}, reasoning ${row.reasoningContent?.length ?? 0} chars]`
      );
    }
  }

  if (counts.unmeasurable > 0 || noMaxTokens > 0) {
    lines.push(
      `  ⓘ ${counts.unmeasurable} judgment(s) had no usable outputTokens and ${noMaxTokens} had ` +
        'no max_tokens on the judgment or the run header — excluded from every number above, ' +
        'never counted as zero.'
    );
  }

  return lines;
}
```

- [ ] **Step 5: Run the module tests to pass (the CLI guard will still fail)**

```bash
cd /root/judge-arena && npx vitest run tests/lib/calibration-token-accounting.test.ts
```

**Expected: exactly ONE failing test**, the call-site guard, because `run.ts` has not been wired yet:

```
 FAIL  tests/lib/calibration-token-accounting.test.ts > calibration/token-accounting: the CLI actually calls it > imports and calls formatTokenAccountingLines, and prints every line it returns
AssertionError: expected '/**\n * ─── Run a judge against a gol…' to contain 'from '@/lib/calibration/token-accounting''
```
(the exact line:column the assertion reports shifts with fixtures added above it in this revision — match on the test name and the `to contain` clause, not a specific line number)

followed by

```
 Test Files  1 failed (1)
      Tests  1 failed | 26 passed (27)
```

**The `expected` side is the entire 437-line source of `run.ts`, printed as a green/red diff that fills the terminal.** That is normal for a `toContain` against a whole file and is not a second problem — read the test NAME and the `to contain` clause, and ignore the diff body.

The other 26 pass. **If any of the 26 fails, fix the module before touching `run.ts`** — a wiring change made while the model is red cannot be attributed.

- [ ] **Step 6: Wire the report — three edits to `scripts/calibration/run.ts`**

**Edit 6a — the import.** old_string (`:53-54`):
```
import { scoreCalibrationRun } from '@/lib/calibration/score';
import { canonicalJson, describeSamplingSnapshot, detectSamplingDrift } from '@/lib/calibration/sampling-drift';
```
new_string:
```
import { scoreCalibrationRun } from '@/lib/calibration/score';
import { canonicalJson, describeSamplingSnapshot, detectSamplingDrift } from '@/lib/calibration/sampling-drift';
import { accountTokens, formatTokenAccountingLines } from '@/lib/calibration/token-accounting';
```

**Edit 6b — the block.** It goes immediately **before** the one-judgment dump, i.e. after the time-to-compute section, because it is the correction to the throughput numbers printed just above it. The anchor is ASCII-only and unique (`grep -cF` returns 1) — deliberately not the box-drawing comment at `:345`, whose 55 `─` characters are easy to mis-transcribe, and deliberately not the field loop at `:341-343`, which `capture-field-gaps` owns.

old_string:
```
  const first = judgments.find((j) => j.status === 'completed');
```
new_string:
```
  // ── Token accounting (DERIVED) ────────────────────────────────────────────
  // `outputTokens` is `usage.completion_tokens` verbatim, and whether that
  // number includes the reasoning channel varies PER MODEL: granite4.2:3b and
  // qwen3.5:9b are both Ollama, both report `reasoningSource: 'reasoning'`,
  // and they disagree. This block is the only thing in the report that can see
  // a judgment sitting at 82% of its budget while `outputTokens` says 115 —
  // which happened, at `finishReason: 'stop'`, and cost a voided run.
  // The rules live in src/lib and are unit-tested there; this script prints
  // them and owns none of them (CONTRIBUTING.md:247, "put every rule that can
  // be silently wrong into src/lib/** so that it can be unit-tested").
  console.log('\n── Token accounting — DERIVED; outputTokens stays the provider count ──');
  const accountingRows = judgments.map((j) => ({
    goldenItemIndex: j.run.goldenItem?.index ?? null,
    status: j.status,
    outputTokens: j.outputTokens,
    reasoningContent: j.reasoningContent,
    samplingParams: j.samplingParams,
  }));
  for (const line of formatTokenAccountingLines(accountingRows, headerSampling)) console.log(line);

  const first = judgments.find((j) => j.status === 'completed');
```

**Edit 6c — the one-judgment dump. CHECK THE ANCHOR FIRST — this is the one Edit in the plan that a sibling can steal.**

```bash
cd /root/judge-arena && grep -acF 'reasoningChars=' scripts/calibration/run.ts
```

- **`0` — this plan is first.** Use the `old_string` below as written.
- **`1` — `2026-09-01-capture-field-gaps.md` landed first** and its Edit 6d rewrote this exact line. Use this `old_string` instead, keeping the same two appended lines and the same `new_string` tail:
  ```
      console.log(`  tokens in=${first.inputTokens} out=${first.outputTokens} reasoning=${first.reasoningTokens} reasoningChars=${first.reasoningContent?.length ?? 'n/a'}   latency ${first.latencyMs}ms`);
  ```
  (In the reverse order there is no conflict: this Edit appends two lines *after* the dump and does not alter it, so capture-field-gaps' Edit 6d still matches afterwards.)

old_string (`:410`):
```
    console.log(`  tokens in=${first.inputTokens} out=${first.outputTokens} reasoning=${first.reasoningTokens}   latency ${first.latencyMs}ms`);
```
new_string:
```
    console.log(`  tokens in=${first.inputTokens} out=${first.outputTokens} reasoning=${first.reasoningTokens}   latency ${first.latencyMs}ms`);
    const firstAccounting = accountTokens(first);
    console.log(`  DERIVED  accounting=${firstAccounting.accounting}   estimatedGeneratedTokens=${firstAccounting.estimatedGeneratedTokens ?? 'n/a'}   (out= above is what the provider reported, unchanged)`);
```

`first` is a variable, not an object literal, so TypeScript's excess-property check does not apply and its extra Prisma fields are fine; `accountTokens` reads only `outputTokens` and `reasoningContent`, which `first` carries as `number | null` and `string | null`.

- [ ] **Step 7: Run to pass**

```bash
cd /root/judge-arena && npx vitest run tests/lib/calibration-token-accounting.test.ts && npx tsc --noEmit
```

Expected: `Tests  27 passed (27)` and tsc silent.

`tsc` is run here and not only at the gate because Edit 6b's `.map()` is the seam a required-field type error is supposed to catch, and this is the moment to see it hold. **It catches a DROPPED field only** — a field swapped for another of the same type is invisible to it, which is what the three `toContain` assertions in the call-site guard are for.

- [ ] **Step 8: INJECTION E — the warn boundary**

Edit `/root/judge-arena/src/lib/calibration/token-accounting.ts`.

old_string:
```
    near: fraction >= TRUNCATION_PROXIMITY_WARN,
```
new_string:
```
    near: fraction > TRUNCATION_PROXIMITY_WARN,
```

```bash
cd /root/judge-arena && npx vitest run tests/lib/calibration-token-accounting.test.ts
```

**Expected RED, exactly one test:**
- `warns at exactly the threshold — the boundary is >=, not >` → `expected false to be true`

The corpus test stays GREEN (its two near items are at 88.8% and 82.4%, both strictly above 80%), which is precisely why the boundary needs its own fixture. **Restore `>=` and re-run to green.**

- [ ] **Step 9: INJECTION F — resolution order**

Edit `/root/judge-arena/src/lib/calibration/token-accounting.ts`.

old_string:
```
  const fromJudgment = readMaxTokens(judgmentSampling);
  if (fromJudgment !== null) return { maxTokens: fromJudgment, source: 'judgment' };
  const fromHeader = readMaxTokens(headerSampling);
  if (fromHeader !== null) return { maxTokens: fromHeader, source: 'run_header' };
```
new_string:
```
  const fromHeader = readMaxTokens(headerSampling);
  if (fromHeader !== null) return { maxTokens: fromHeader, source: 'run_header' };
  const fromJudgment = readMaxTokens(judgmentSampling);
  if (fromJudgment !== null) return { maxTokens: fromJudgment, source: 'judgment' };
```

```bash
cd /root/judge-arena && npx vitest run tests/lib/calibration-token-accounting.test.ts
```

**Expected RED:**
- `prefers the JUDGMENT over the run header` → `expected { maxTokens: 6144, source: 'run_header' } to deeply equal { maxTokens: 12288, source: 'judgment' }`
- `prints the corpus exactly` also reddens (the corpus is passed a header of 8192, so rows 2-4 would all be sized against 8192), which is the mid-run-drift case reaching the report. **Restore the original order and re-run to green.**

- [ ] **Step 10: INJECTION G — nothing is excluded silently**

Edit `/root/judge-arena/src/lib/calibration/token-accounting.ts`.

old_string:
```
  if (counts.unmeasurable > 0 || noMaxTokens > 0) {
```
new_string:
```
  if (counts.unmeasurable > 0 && noMaxTokens > 0) {
```

```bash
cd /root/judge-arena && npx vitest run tests/lib/calibration-token-accounting.test.ts 2>&1 | head -40
```

`&&` rather than a `false` literal, because it is the mis-implementation a reviewer would plausibly write and both tsc and eslint accept: it prints the exclusions line only when BOTH kinds of exclusion occur at once, which is the rarest case and is never the corpus's.

**Expected RED, three tests:** `prints the corpus exactly` (unmeasurable 1, noMaxTokens 0), `counts the judgments it could not size` (0 and 1) and `says so rather than printing an empty range` (1 and 0) each lose their final array element. `omits the exclusions line only when there is genuinely nothing excluded` and `is total over an empty run` stay GREEN — correctly, since neither has anything to exclude, which is what makes the three failures attributable to the operator rather than to the line existing at all.

**Restore `||` and re-run to green.**

- [ ] **Step 11: INJECTION H — the wiring itself**

Edit `/root/judge-arena/scripts/calibration/run.ts`.

old_string:
```
  for (const line of formatTokenAccountingLines(accountingRows, headerSampling)) console.log(line);
```
new_string:
```
  const unusedAccountingLines = formatTokenAccountingLines(accountingRows, headerSampling);
  void unusedAccountingLines;
```

```bash
cd /root/judge-arena && npx vitest run tests/lib/calibration-token-accounting.test.ts
```

**Expected RED, exactly one test:**
- `imports and calls formatTokenAccountingLines, and prints every line it returns` → `AssertionError: expected '/**\n * ─── Run a judge against a gol…' to match /for \(const line of formatTokenAccountingLines\(accountingRows, headerSampling\)\) console\.log\(line\);/`

This is the discriminating half of the guard: the function is still imported and still called exactly once, so a bare `toContain('formatTokenAccountingLines')` would have stayed green on a report that computes its lines and throws them away. **Restore the loop and re-run to green.**

- [ ] **Step 11a: INJECTION H2 — the header argument, which types cannot catch**

Edit `/root/judge-arena/scripts/calibration/run.ts`.

old_string:
```
  for (const line of formatTokenAccountingLines(accountingRows, headerSampling)) console.log(line);
```
new_string:
```
  for (const line of formatTokenAccountingLines(accountingRows, null)) console.log(line);
```

```bash
cd /root/judge-arena && npx vitest run tests/lib/calibration-token-accounting.test.ts && npx tsc --noEmit
```

**Expected: `tsc` stays SILENT — that is the entire point** (the second parameter is `unknown`, so `null` is legal) — **and exactly ONE test reddens:**
- `imports and calls formatTokenAccountingLines, and prints every line it returns` → `AssertionError: expected '/**\n * ─── Run a judge against a gol…' to match /for \(const line of formatTokenAccountingLines\(accountingRows, headerSampling\)\) console\.log\(line\);/`

This is why the regex pins the argument names instead of using `[^)]*`. With a `null` header, every `status='error'` judgment loses its `max_tokens` — all 46 error rows in production have `samplingParams IS NULL` — so every one of them falls out of the sized set into the `ⓘ` line, and the truncated item this plan exists to surface is silently never printed. Lint, tsc and all 26 other tests stay green. **Restore `headerSampling` and re-run to green.**

- [ ] **Step 11b: INJECTION K — the ten-item cap**

Edit `/root/judge-arena/src/lib/calibration/token-accounting.ts`.

old_string:
```
    for (const { row, prox } of near.slice(0, 10)) {
```
new_string:
```
    for (const { row, prox } of near.slice(0, 1)) {
```

```bash
cd /root/judge-arena && npx vitest run tests/lib/calibration-token-accounting.test.ts
```

**Expected RED, exactly TWO tests** (measured by applying it):
- `lists at most ten near-budget items, and still counts all of them` → `expected 1 to be 10`
- `prints the corpus exactly` → `expected [ …(6) ] to deeply equal [ …(7) ]` — the corpus has two near items and `slice(0, 1)` drops the second, which is the same defect at n=2

The second failure is why the dedicated fixture is still needed: with only the corpus, `near.slice(0, 10)` could be **deleted entirely** and both tests stay green, because 2 < 10. Only the 12-item fixture can tell "no cap" from "a cap at ten". **Restore `near.slice(0, 10)` and re-run to green.**

- [ ] **Step 12: Gates — the full chain, once for the branch**

```bash
cd /root/judge-arena && grep DATABASE_URL .env.test
```
Confirm `localhost:5432` before continuing. Then, **serially** (the db suite is not concurrency-safe — one shared `judge_arena_test`, and a parallel run fakes failures that read exactly like a regression):

```bash
cd /root/judge-arena && npm run lint && npx tsc --noEmit && npm run test:coverage 2>&1 | tail -25
cd /root/judge-arena && npm run test:db:coverage 2>&1 | tail -15
cd /root/judge-arena && npm run test:integration 2>&1 | tail -10
cd /root/judge-arena && npm run build 2>&1 | tail -10
```

Expected: lint 0; tsc silent; **`B + 27` tests over `F + 1` files**, where `B`/`F` are Task 1 Step 0's printed baseline — on a 917/58 baseline that is `Tests  944 passed (944)` over `Test Files  59 passed (59)`. **This is arithmetic, not a measurement.** (The header block's dry run printed 913/58, but that was on `33b7be4`, before `a272519`/`0a6669e` landed and before this revision added two tests; it is superseded. **The printed number wins.**) db `674 passed`; integration `82 passed`; build succeeds — those three are the unchanged baseline and were not re-measured.

`test:db` and `test:integration` are **expected to be unchanged**, because this commit adds no DB behaviour and no worker behaviour. **A non-zero delta in either is a finding, not a number to write down** — most likely a stopped podman container (failure mode 10: mass `Test timed out in 5000ms` across unrelated db files is a dead redis/rabbitmq, not a regression, and it reproduces identically on re-run which makes it look deterministic).

- [ ] **Step 13: Commit**

**First, prove the index is empty** (Global Constraints):

```bash
cd /root/judge-arena && git diff --cached --name-only
```
Expected: **empty**. These three paths are already tracked (the first two by commit A, `run.ts` pre-existing) and modified, so stage them and verify before committing:

```bash
git -C /root/judge-arena add \
  src/lib/calibration/token-accounting.ts \
  tests/lib/calibration-token-accounting.test.ts \
  scripts/calibration/run.ts
git -C /root/judge-arena status --short
```
Expected: exactly those three paths, each prefixed `M `. Then:

```bash
git -C /root/judge-arena commit --only \
  src/lib/calibration/token-accounting.ts \
  tests/lib/calibration-token-accounting.test.ts \
  scripts/calibration/run.ts \
  -F - <<'EOF'
feat(calibration): warn when a judgment's estimated generation nears max_tokens

A live calibration at max_tokens 6144 had an item whose estimated total
generation was 5,065 tokens — 82% of budget — while `outputTokens` reported 115
and `finishReason` was 'stop'. Nothing in the product could surface it. The run
was voided and relaunched at 8192 on a new ordinal.

The capture report now prints a Token accounting block: how many judgments'
`outputTokens` include the reasoning channel and how many exclude it, the
measured chars-per-output-token range, the widest estimated generation against
the max_tokens it ran under, and a per-item warning at or above 80% of budget.
`max_tokens` comes from the judgment's own `samplingParams` and falls back to
the v2k run header — `markJudgmentError` does not write `samplingParams`, so
errored rows, which are the truncation cases, have none of their own — and
never to a registry default.

80% fires on exactly two of the 263 completed judgments in the corpus (88.8%
and 82.4%) and is silent on the other 261, including all 40 granite4.2:3b items,
whose widest is 74.7%. The estimator's measured residual is +7%, so an item
truly at 87% or above cannot read below the threshold.

One assumption is written into the module rather than left implicit: the
fraction assumes `max_tokens` bounds the whole generated stream, reasoning
included. That is measured where the count INCLUDES reasoning — all 21
`finishReason: 'length'` rows sit exactly on their budget — and inferred on
qwen3.5:9b, which has never returned `finishReason: 'length'` in 18 completed
judgments. The doc comment says so.

The warning points at runbook §8.2 rather than advising a bigger budget:
`finish_reason: 'length'` is ambiguous between "ran out of room" and "never
going to stop", and a bigger budget buys a longer loop.

The strings live in src/lib, not in the script: scripts/** is outside every
coverage include and has no harness, and the >= 0.80 boundary is exactly the
rule that must stay tested. `outputTokens` is unchanged and still means what
the provider reported; every derived number is labelled DERIVED and printed
beside the raw counts it came from.

Gates: lint 0, tsc 0, <B+27> unit / 674 db / 82 integration, coverage 0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
EOF
```

Replace `<B+27>`/`674`/`82` with the printed numbers (944 unit on a 917 baseline). Then:

```bash
cd /root/judge-arena && git show --stat --oneline HEAD
```
Expected: **3 files changed**, all three named above. A fourth file is a leaked index (Global Constraints) — report it, do not amend around it.

---

### Task 3: correct the two documents that carry the wrong numbers

**Files:**
- Modify: `/root/judge-arena/docs/runbooks/scoring-a-judge-against-a-golden-set.md:534-536` (§8.6's `tok_per_s` paragraph; §8.6 heading is at `:510`, the two-line formula block at `:529-532`, and `**Recognising which limit you hit:**` at `:538`). **All four numbers moved by +49 when `a272519`/`0a6669e` landed** — the first draft cited `:485-487`/`:461`/`:481-484`/`:489`. The `old_string` still matches uniquely; the numbers are orientation only.
- Modify: `/root/judge-arena/docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md:99` (a table row is added after it) and `:101` (the CORRECTION note is inserted after it, before the `**The 8192 row's 27.3 tok/s is polluted…**` paragraph at `:103`)
- Test: none — this commit changes no code. Verification is two `grep -cF` pairs with exact expected counts and an injection against each, in Steps 3 and 5.

**Interfaces:**
- Consumes: the short SHA of Task 2's commit B, for the CORRECTION notes.
- Produces: nothing code-facing.

- [ ] **Step 1: Re-anchor, and capture the SHA**

```bash
cd /root/judge-arena && \
  grep -n "^### 8.6 " docs/runbooks/scoring-a-judge-against-a-golden-set.md && \
  grep -n "Get \`tok_per_s\`" docs/runbooks/scoring-a-judge-against-a-golden-set.md && \
  grep -n "^## 2. OPERATING ENVELOPES" docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md && \
  grep -n "^\\\\\* partial — run #9" docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md && \
  git log -1 --format=%h --grep='warn when a judgment'
```

Expected on `0a6669e` + commits A and B: **`510`, `534`, `89`, `101`**, and one 7-char SHA. (The first draft of this plan expected `461`, `485`, `89`, `101`, measured on `33b7be4`; `a272519`/`0a6669e` pushed the two runbook numbers down by 49. The two spec numbers are unchanged, re-verified.) **The `old_string` blocks below are what an Edit matches on, not the line numbers** — a number that has moved is orientation drift (a sibling plan landing first), not a failed re-anchor, and is never a reason to stop. If the quoted TEXT is not found, stop and diagnose.

- [ ] **Step 2: Edit 1 — runbook §8.6**

In `/root/judge-arena/docs/runbooks/scoring-a-judge-against-a-golden-set.md`:

old_string:
```
Get `tok_per_s` from a single scored item — `ModelJudgment.outputTokens / (latencyMs/1000)`. The
recorded envelopes for every judge scored so far are in
[`docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md`](../superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md) §2.
```

new_string:
````
Get `tok_per_s` from the **estimated generation**, pooled over the judge's completed judgments — not
from `outputTokens`, and not from one item:

```
tok_per_s = Σ estimatedGeneratedTokens / Σ (latencyMs / 1000)
```

`estimatedGeneratedTokens` is `accountTokens()` in `src/lib/calibration/token-accounting.ts`, and
`npm run calibration:run` prints it in the **Token accounting** block of every report, beside the
raw `outputTokens` and character counts it was derived from. The recorded envelopes for every judge
scored so far are in
[`docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md`](../superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md) §2.

> **CORRECTION (2026-09-02, `<SHA>`).** This paragraph used to read:
> *"Get `tok_per_s` from a single scored item — `ModelJudgment.outputTokens / (latencyMs/1000)`."*
> **Both halves were wrong.**
>
> **`outputTokens` is `usage.completion_tokens` verbatim, and whether it includes the reasoning
> channel varies per MODEL** — not per backend, and not per `reasoningSource`. Measured 2026-09-02
> over every completed judgment, `Σ length(reasoningContent) / Σ outputTokens` is **3.52** on
> Qwen3.6-35B-A3B and **3.76** on granite4.2:3b — at or below the tokenizer's own chars-per-token,
> which is only possible if the reasoning tokens are already inside `completion_tokens` — and
> **68.46** on qwen3.5:9b — measured over the nine completed judgments of the voided `max_tokens
> 6144` run — where `completion_tokens` is the JSON verdict alone. On that judge the old formula
> returns **0.6 tok/s against 11.1 tok/s of real generation, an 18x error**, in the number this
> section tells you to size `max_tokens` with.
>
> Two identical requests to Ollama 0.32.15 differing only by `response_format` isolate the cause:
> plain returns `completion_tokens 1069` for 2583 chars of reasoning + 530 of content;
> `response_format: {type:'json_schema'}` returns **196** for 2304 + 598. **The judge path always
> sends the schema** (`ollamaStructuredRequestFields`, `llamacppStructuredRequestFields`), so the
> judge path is the affected one. `reasoningTokens` cannot rescue this — it is NULL on every
> self-hosted backend (§7.4).
>
> **And "a single scored item" was never safe**, even on a judge that counts reasoning: throughput
> decays with output length (scoreboard spec §5.4.1), so one item's rate is not the run's, and the
> flat-rate estimate is a lower bound on duration rather than an estimate of it.
>
> **What did NOT change:** the two formulas above, and the published rates for Qwen3.6, granite4.2
> and granite4.1 — for those judges `outputTokens` already counted the thinking, so the naive figure
> was already right.
````

Replace `<SHA>` with Step 1's SHA. **Two notes for the executor:**

1. The inner fenced block in the `new_string` (the three lines opening and closing with ```` ``` ````) is literal file content, not plan formatting — copy it as written.
2. **Do NOT re-wrap the quoted sentence in the CORRECTION note.** `*"Get \`tok_per_s\` from a single scored item — \`ModelJudgment.outputTokens / (latencyMs/1000)\`."*` must stay on ONE line: Step 3's verification is `grep -cF`, which is line-based, and an earlier draft of this plan wrapped that sentence across two lines and therefore red-gated its own correct edit (`0`, not `1`). The line is 97 characters, within the file's prose width.

- [ ] **Step 3: Verify Edit 1, and inject against the verification**

```bash
cd /root/judge-arena && \
  grep -cF 'Get `tok_per_s` from a single scored item' docs/runbooks/scoring-a-judge-against-a-golden-set.md ; \
  grep -cF 'tok_per_s = Σ estimatedGeneratedTokens / Σ (latencyMs / 1000)' docs/runbooks/scoring-a-judge-against-a-golden-set.md ; \
  grep -cF 'CORRECTION (2026-09-02' docs/runbooks/scoring-a-judge-against-a-golden-set.md
```

**Exact expected output: `1`, `1`, `1`.**

The **first** count is the one that matters and it is `1`, not `0`, on purpose: CONTRIBUTING.md:1653-1656 requires the CORRECTION to **quote what the document used to say**, so the old sentence must survive — inside the note, and only there. `grep -cF` (fixed-string) rather than a bare `grep -c` pattern, because the sentence contains backticks and a `/`.

**If the first count prints `0`, the most likely cause is that the quoted sentence got re-wrapped across two lines.** `grep -cF` matches within a single line. Put it back on one line (Step 2, note 2) rather than weakening the check.

**INJECTION I:** in the CORRECTION note, replace the whole quoted-sentence line
```
> *"Get `tok_per_s` from a single scored item — `ModelJudgment.outputTokens / (latencyMs/1000)`."*
```
with
```
> *the old single-item formula*
```
and re-run. **Expected: the first count drops from `1` to `0`, while the second and third stay `1`.** The note then asserts that something was wrong without saying what — the silent overwrite CONTRIBUTING.md:1653-1656 forbids — while every other signal about the edit stays green, which is exactly why the quote gets its own check. **Restore the sentence verbatim, on one line, and re-run to `1`, `1`, `1`.**

*Why this injection and not "delete the line":* deleting a line that a wrapped quote had already made unmatchable would move the count from `0` to `0` and prove nothing. Replacing the quote with a paraphrase moves it from `1` to `0` only if the quote was matchable in the first place, so the injection also validates the check.

*What wrong edit would still pass this check?* One that left the ORIGINAL paragraph in place at `:534` and merely appended the note — the count would be `1` from the original rather than from the quote. The second count discriminates that: it is `1` only if the replacement formula is present, and the replacement and the original cannot both occupy that position.

- [ ] **Step 4: Edit 2 — scoreboard spec §2**

**Edit 2a, the missing row.** In `/root/judge-arena/docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md`:

old_string:
```
| granite4.1:3b | 4096 | 60 | 109 | 163 | 3.6 s | 16.8 s | 30.2 | 1660 |
```
new_string:
```
| granite4.1:3b | 4096 | 60 | 109 | 163 | 3.6 s | 16.8 s | 30.2 | 1660 |
| qwen3.5:9b † | 6144 | 9 | 147 | 184 | 261.3 s | 477.7 s | 0.6 ⚠⚠ → **11.1** | 4582 |
```

**Edit 2b, the footnote and the correction.**

old_string:
```
\* partial — run #9 was still draining when this table was built.
```
new_string:
```
\* partial — run #9 was still draining when this table was built.

† **`outputTokens` on this judge does not include the reasoning channel, so the naive 0.6 tok/s is
wrong by 18x.** The bolded 11.1 is `Σ estimatedGeneratedTokens / Σ latency` — see the CORRECTION
below. Every other cell in this row is a direct measurement and needs no correction.

> **CORRECTION (2026-09-02, `<SHA>`) — the `tok/s` column is `outputTokens / latency`, and
> `outputTokens` does not mean the same thing on every model.**
>
> **All five original rows are CORRECT and unchanged.** Measured 2026-09-02 over every completed
> judgment, `length(reasoningContent) / outputTokens` runs **2.31 … 4.73** on Qwen3.6-35B-A3B,
> granite4.2:3b and granite4.1:3b — at or below the tokenizer's own chars-per-token, which is only
> possible if the reasoning tokens are already inside `completion_tokens`. **The same ratio on
> qwen3.5:9b is 37.76 … 156.69** over the nine judgments of the `6144` run in row 6 (36.73 … 156.69
> pooled over both of that judge's budgets): there `completion_tokens` is the JSON verdict alone,
> the naive column reads 0.6 tok/s, and the real figure is 11.1.
>
> Nothing on the wire distinguishes the two cases, and **the split is per MODEL, not per backend**:
> granite4.2:3b and qwen3.5:9b are both Ollama and both report `reasoningSource: 'reasoning'`. The
> only in-tree discriminator is the ratio itself, pinned as `accountTokens()` in
> `src/lib/calibration/token-accounting.ts` and printed by `npm run calibration:run`.
>
> **Do not add a row to this table from `outputTokens` alone.** Use `estimatedGeneratedTokens`.
>
> **A number this note does NOT endorse.** An earlier reconstruction circulated as *"Qwen3.6
> 31.3 → 67.4, granite4.2 35.1 → 78.3"*. `31.3` and `35.1` are the pooled-across-`max_tokens` naive
> rates — this table is split BY `max_tokens`, which is why neither appears in it — and `67.4`/`78.3`
> come from adding a chars-derived reasoning estimate to an `outputTokens` that **already contains
> it**, a double count. Measured, neither judge's rate moves.
>
> **One dated refresh, not a defect in the number as published:** the granite4.2 `12288` row was
> marked `11*` partial and that run has since drained. Re-measured 2026-09-02 it is `n=25`, mean out
> 3493, mean lat 101.7 s, **34.4** tok/s. The other four rows reproduce exactly.
```

Replace `<SHA>` with Step 1's SHA.

- [ ] **Step 5: Verify Edit 2, and inject against the verification**

```bash
cd /root/judge-arena && S=docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md && \
  grep -cF '| qwen3.5:9b † |' "$S" ; \
  grep -cF '31.3 → 67.4' "$S" ; \
  grep -cwF 'accountTokens' "$S" ; \
  sed -n '/^## 2. OPERATING ENVELOPES/,/^\\\* partial/p' "$S" | grep -c '^|'
```

**Exact expected output: `1`, `1`, `1`, `8`.**

- The second count is `1`, not `0`: the double-counted reconstruction is quoted **once**, inside the note that repudiates it, so a future reader who searches for that number finds the repudiation rather than reintroducing it.
- The third uses `-w` because `grep -cF accountTokens` cannot tell `accountTokens` from a later `accountTokensV2` (failure mode 3).
- The fourth counts table lines between the §2 heading and the `\* partial` footnote — header, separator and **six** data rows. It was 7 before this edit. It is anchored on the heading and the footnote rather than on line numbers, so a sibling plan landing first cannot silently change what it measures.

**INJECTION J:** change the new row's judge cell from `| qwen3.5:9b † |` to `| qwen3.5:9b |` (drop the dagger) and re-run. **Expected: the first count drops to `0`** — a row whose 0.6 carries no footnote is the original defect, published again. **Restore the dagger.**

- [ ] **Step 6: Gates**

```bash
cd /root/judge-arena && npm run lint && npx tsc --noEmit && npm run test:coverage 2>&1 | tail -8
```

Expected: **identical to what Task 2 Step 12 printed** — lint 0, tsc silent, `B + 27` tests over `F + 1` files. A docs-only commit must move nothing; a delta here means a file other than the two markdown documents was touched. `npm run test:db:coverage`, `npm run test:integration` and `npm run build` are not run: this commit changes two `.md` files under `docs/` and nothing else, which no suite and no build reads.

```bash
cd /root/judge-arena && git diff --cached --name-only && git diff --stat
```

`git diff --cached --name-only` must print **nothing** (Global Constraints). `git diff --stat` is expected to show the two markdown documents under `docs/`, **plus `docs/superpowers/plans/2026-09-02-token-accounting-and-truncation-proximity.md` if your harness ticks this plan's `- [ ]` checkboxes as it goes** — that file became tracked in Task 1, so a ticked checkbox is a legitimate third entry and is NOT a finding. **Anything OUTSIDE `docs/` is a finding**: this commit changes no code. The `--only` path list below names the two documents, so a ticked plan file stays out of commit C either way.

- [ ] **Step 7: Commit**

These two paths are already tracked (both pre-existing docs, modified by Task 3's edits), so stage them and verify before committing:

```bash
git -C /root/judge-arena add \
  docs/runbooks/scoring-a-judge-against-a-golden-set.md \
  docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md
git -C /root/judge-arena status --short
```
Expected: exactly those two paths, each prefixed `M `. Then:

```bash
git -C /root/judge-arena commit --only \
  docs/runbooks/scoring-a-judge-against-a-golden-set.md \
  docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md \
  -F - <<'EOF'
docs(calibration): correct the tok/s formula and the throughput envelopes

Runbook §8.6 told operators to get `tok_per_s` from `ModelJudgment.outputTokens
/ (latencyMs/1000)` on a single scored item. That is the number §8.6 exists to
size `max_tokens` with against the 900 s hard cap, and on qwen3.5:9b it returns
0.6 tok/s against 11.1 tok/s of real generation — an 18x error in the guard
against the stacked-limits trap. It now reads from `estimatedGeneratedTokens`,
pooled over the judge's completed judgments.

Scoreboard spec §2's `tok/s` column has the same definition. Its five published
rows are correct and unchanged — measured, `length(reasoningContent) /
outputTokens` is 2.31…4.73 on all three of those judges, which is only possible
if the reasoning is already inside `completion_tokens`. The missing row is
qwen3.5:9b at 37.76…156.69, whose naive rate is 0.6. Both notes quote what the
documents used to say (CONTRIBUTING.md:1653-1656) rather than overwriting it,
and both repudiate by name the "31.3 → 67.4 / 35.1 → 78.3" reconstruction,
which double-counts reasoning on two judges that already count it.

The granite4.2 12288 row's `11*` partial marker is also resolved: that run has
drained and re-measures at n=25, 34.4 tok/s. Recorded as a dated refresh, not
as a correction — the number was right for the population it was taken over.

Gates: lint 0, tsc 0, <B+27> unit / n-a db (docs-only; no suite reads docs/) / n-a integration (docs-only), coverage 0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
EOF
```

Replace `<B+27>` with whatever `test:coverage` printed (944 on a 917 baseline — identical to commit B's, because this commit changes no code). Then:

```bash
cd /root/judge-arena && git show --stat --oneline HEAD
```
Expected: **2 files changed**, both under `docs/`.

---

## Post-landing checklist (the operator's, not this plan's)

Not steps. This plan never pushes, promotes or mutates the cluster.

1. **The block only appears on a promoted image.** `npm run calibration:run -- --score-only=<calibrationRunId>` on an image carrying commit B prints the Token accounting block for an existing run. Note that `--score-only` **writes** (`scoreCalibrationRun` updates `CalibrationRun`), so it is a production write and is the operator's call, not a verification step.
2. **The first real read to do:** run it against the voided qwen3.5:9b run at `max_tokens 6144`. Expected shape — `excludes_reasoning 9`, `chars/outputToken 37.76 … 156.69`, and `⚠ 1 of 9 … item 12 … est 5065 = 82.4% of 6144`. That is the item that cost a run, printed before the next one is sized.
3. **The end-to-end wiring has no automated proof.** Task 2's guard asserts the call site in source text and tsc asserts the row mapping; **neither runs the script.** The first `--score-only` after promotion is the only thing that proves the block renders, and a plausible failure it would catch is an exception from the `.map()` on a run whose `goldenItem` is null. Read the output; do not assume it.
4. **`(max_tokens from the run header)` will not appear in production yet.** Measured 2026-09-02, `judge-arena-pg-1` has no `CalibrationRun.samplingParams` column — v2k is landed in the repo and applied to the local test DB, but the production migration rides on a promoted image, which is the operator's. Until then `headerSampling` is `undefined`, `readMaxTokens` returns `null`, and every judgment is sized from its own `samplingParams` (which all `completed` rows carry) or counted in the `ⓘ` line (which every `error` row will be, since `markJudgmentError` writes none). **That is correct behaviour, not a bug** — but it means the errored/truncated rows stay unsized until v2k reaches production, so do not read an empty `⚠` block as "nothing was near budget".
5. **The observation that would settle the module's one stated assumption.** `TRUNCATION_PROXIMITY_WARN`'s doc comment records that `max_tokens` bounding the *whole* generated stream is measured only where the count includes reasoning, and inferred on qwen3.5:9b. **A qwen3.5:9b judgment with `finishReason: 'length'` and an `outputTokens` far below `max_tokens` would PROVE the budget covers the uncounted reasoning channel; a judgment whose estimate exceeds `max_tokens` while `finishReason` stays `'stop'` would DISPROVE it.** Neither has been seen in 18 completed judgments. Record whichever appears first against the ASSUMPTION note in `token-accounting.ts` — and if it is the second, follow-up F7 becomes a correction rather than a note.

## Follow-ups — out of scope here, recorded so they are not lost

- **F1 (owned by `2026-09-01-calibration-budget-warning.md`, do it there).** `judgeThroughputEstimate` as that plan defines it is `Σ outputTokens / Σ latencyMs` — the formula this plan corrects. Feed it `accountTokens(row).estimatedGeneratedTokens` instead. Its own worked example already quotes 11.9 tok/s for qwen3.5:9b, which its formula cannot produce (that formula gives 0.6). One line plus a test.
- **F2. Derive true `reasoningTokens` from a second round trip to a native API.** Explicitly out of scope: it changes what the provider is asked for, doubles the cost of every judgment, and would put a differently-measured number into a column documented as usage-reported. `2026-09-01-capture-field-gaps.md` owns that column.
- **F3. Ask for the split instead of estimating it.** Ollama and llama.cpp both accept `response_format`; whether either can be made to report `completion_tokens_details.reasoning_tokens` alongside it is unknown and untested. Out of scope — changing what is requested changes what is generated, and every historical judgment would remain unexplained.
- **F4. A tokenizer.** `CHARS_PER_TOKEN` has a ±10% error bar that a real tokenizer would close. It would also add a per-model dependency to a leaf module that currently imports nothing and is bundled into the CLI image. Not worth it for a warning threshold with a 20-point margin; worth revisiting if the estimate is ever used for anything that must be exact.
- **F5. Scoreboard-wide re-measurement.** Spec §2's rows are dated snapshots; three of the five have grown since they were written. A `scripts/calibration/envelopes.ts` that regenerates the table from the database would end the drift, and is a bigger change than a correction note.
- **F6. Nothing in the worker path changed, deliberately.** The timeout policy, the execution path and `assertUsableContent` (`src/lib/llm/registry.ts:626` — it was `:606` before `a272519` landed) are untouched. A future change that made truncation proximity a launch-time or worker-time signal would have to answer failure mode 16 first: a large estimate is ambiguous between "needs more room" and "is looping", and only the second is made worse by a bigger budget.

- **F7. The operator-facing truncation message, and runbook §8.6's "Recognising which limit you hit", both read `completion_tokens` at face value.** `registry.ts`'s CUT-OFF message prints `completion_tokens ${result.outputTokens ?? 'unknown'}` (`src/lib/llm/registry.ts:626-700`, the block §8.2 quotes as carrying "every number needed to size the fix"), and the runbook paragraph at `:538-541` says truncation gives `finishReason: 'length'` with `completion_tokens` **exactly equal to** `max_tokens`. Both are confirmed true wherever the count INCLUDES reasoning — all 21 `finishReason: 'length'` rows in the corpus sit exactly on their budget. **On an `excludes_reasoning` model neither has ever been observed**: qwen3.5:9b has never returned `finishReason: 'length'` in 18 completed judgments, so there is no production instance either way and nothing to correct yet. Recorded rather than fixed for two reasons: adding the derived estimate to that message is a change at the `execute()` chokepoint, which is the worker path this plan deliberately does not touch; and writing a CORRECTION note against a claim that has never been falsified would publish an inference as a measurement. **The observation to watch for** is in the Post-landing checklist.
