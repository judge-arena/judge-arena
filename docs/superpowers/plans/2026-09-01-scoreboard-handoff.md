# The judge scoreboard exists — handoff, 2026-09-01

**Supersedes the *status* sections of [`2026-08-30-state-and-next-steps.md`](./2026-08-30-state-and-next-steps.md).**
That document's traps, corrections and §5.6 follow-up register remain live and are referenced
throughout; read it after this one.

Everything below was verified against the live cluster, the production database or the tree on
2026-09-01. Nothing is carried forward from an earlier document. **Two things this session shipped
turned out to be wrong after they shipped, and both are called out as corrections rather than
quietly replaced** — they are the most useful part of the record.

---

> **SUPERSEDED FOR STATUS, 2026-09-03. Every status number below is stale; read
> [`2026-09-03-wave1-wave2-handoff.md`](./2026-09-03-wave1-wave2-handoff.md) first, then this.**
> Production is **`sha-5e48187cfb3a`**, not the `sha-d21f31d47c35` §1 records. A **fourth** judge
> (qwen3.5:9b, 0.8571 over 24 of 28) has been scored since §0 and §2 were written, so §2's four-row
> table is now five rows — recorded in the 2026-09-03 handoff §2 and the spec's §1 row 11, not here;
> §2 is left exactly as it was written on 2026-09-01. The ledger is **11** calibration runs /
> **330** model judgments, not the 9 / 270 in §1. §4's gates are this session's **start**; `HEAD`
> measures 1002 unit / 679 db / 82 integration. **§5's corrections, §6's traps and §7's register
> remain live** — §6 gains traps 10–17 in the new handoff and §7 carries a per-item status block.
> **§8's scoreboard query errors today**; see the note there.

## 0. If you read one thing

Three judges have been scored against a frozen golden set. **The best is 0.8667; the worst is worse
than a rubber stamp**, and the report does not say so because the degenerate baseline is never
computed.

> **CORRECTION (2026-09-02, v2l).** "the report does not say so because the degenerate baseline is
> never computed" was true when this was written and is no longer: `scripts/calibration/run.ts` now
> prints `constant <floor> … margin <±m>` beside ACCURACY and a `⚠ accuracy is at or below the
> constant floor` line when it is, the floor is computed per SCORED subset by
> `src/lib/calibration/baseline.ts`, and it is stored as `CalibrationRun.constantBaselineAccuracy`
> (v2l). The headline itself stands: the worst judge is still worse than a rubber stamp. Rows scored
> before v2l hold NULL for the column until re-scored with `--score-only`.

And the two corrections, because they are the shape of what goes wrong here:

1. **A feature shipped into 1 of 3 call sites and looked live in production** for an hour. The
   machinery downstream half-works without it, so nothing threw and nothing warned. It was caught
   only because its own alert stated something the database contradicted.
2. **`finish_reason: length` does not mean "raise `max_tokens`".** On one judge it meant a
   degenerate repetition loop, and the error message's advice would have made it worse. I gave that
   advice, in writing, before measuring. §5.2.

---

## 1. What is actually running

**Read these; do not assume them.** The equivalent row in the previous handoff was wrong twice.

```sh
# 1. The image, from the live object — not from helmrelease.yaml, not from stable.yaml.
kubectl -n tenant-public get deploy judge-arena-web judge-arena-worker \
  -o custom-columns='NAME:.metadata.name,IMAGE:.spec.template.spec.containers[0].image,READY:.status.readyReplicas'

# 2. The worker's AMQP consumers. It was silently dead for five days in August and
#    THE RECONNECT DEFECT IS STILL UNFIXED, so this is a standing check.
kubectl -n tenant-public logs deploy/judge-arena-worker --tail=20 | grep 'judge worker started'
#    Expect consumers == expectedConsumers == 10 (8 lanes + fallback + run.create).
#    Anything less means the pod is up and consuming nothing.

# 3. Queue depths, including the DLQ that nothing drains.
kubectl -n tenant-public exec rabbitmq-judge-arena-server-0 -- \
  rabbitmqctl list_queues name messages consumers
```

As of 2026-09-01, production is **`sha-d21f31d47c35`** (promoted via homelab-setup #951).

| | |
|---|---|
| golden sets (live) | 2 |
| golden items (live) | 650 |
| judge model versions | 6 (3 Anthropic, unscored; 3 self-hosted, all scored) |
| model endpoints | 3 |
| calibration runs | 9 |
| evaluation runs / model judgments | 270 / 270 |
| **human judgments** | **0** |
| database size | 10 MB of a 10 Gi PVC |
| `judge.dlq` | **10 messages, 0 consumers** |

**Human judgments is 0 and that is the largest structural gap in the product.** Every number in §2
is a judge scored against an *imported* answer key. Nothing has been labelled by a person in this
system, so the A1/A1.5 annotation studio remains unexercised end-to-end.

---

## 2. The scoreboard

Full ledger, with per-model throughput envelopes and the traps that corrupt it:
[`docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md`](../specs/2026-09-01-judge-scoreboard-and-model-envelopes.md).

Golden set `cmt057hd001g17y01lhjzgfuj` — *JudgeBenchSample — 30 random*, pairwise, frozen.
**Answer key: 17 `A>B`, 13 `B>A`, no ties.**

| judge | `max_tokens` | accuracy | κ | verdicts | vs. constant stamp |
|---|---|---|---|---|---|
| **Qwen3.6-35B-A3B** (llama.cpp) | **12288** | **0.8667** | 0.7285 | 30/30 | **+0.30** |
| Qwen3.6-35B-A3B | 8192 | 0.8333 | 0.6575 | 30/30 | +0.27 |
| granite4.2:3b (Ollama) | 12288 | 0.6000 | 0.2355 | **25/30** | **+0.04** |
| granite4.1:3b (Ollama) | 4096 | 0.5000 | 0.1296 | 30/30 | **−0.07** |

> **CORRECTION (2026-09-02).** The granite4.2 row read `15/25` under *verdicts* until v2l landed.
> That is correct/verdictCount (0.6000 × 25 = 15); every other row is verdictCount/items, under which
> run 9 is **25/30**. The spec's §1 ledger carried the same slip and is corrected there. The
> *vs. constant stamp* column is now computed and stored, not hand-worked: `scripts/calibration/run.ts`
> prints `constant <floor> … margin <±m>` (per scored subset) and `CalibrationRun.constantBaselineAccuracy`
> holds the floor; the values here were produced by hand before that existed and agree with it.

**The comparison column is the point.** A judge that stamps `A>B` on every item scores **0.5667** on
this set — 17/30. Read against 0.5, `granite4.1`'s 0.5000 looks like a weak signal; read against
0.5667 it is *worse than not thinking*. Its κ of 0.1296 says it is not quite degenerate: a faint
signal, spent badly.

**The floor moves with the denominator.** granite4.2 scored only 25 items, and that subset's key is
14/11 — a floor of **0.5600**, not 0.5667. A leaderboard cannot compute this number once and cache
it.

### What each judge actually is

- **Qwen3.6-35B-A3B** — the only viable judge on this fleet. ~58.5 tok/s, ~2,869 output tokens per
  judgment, 49 s mean. Raising its budget 8192 → 12288 improved accuracy 0.8333 → 0.8667 with no
  truncation at either setting, i.e. more room produced *better verdicts*, not merely fewer
  failures. On 30 items that is one extra correct item — **directional, not significant**.
- **granite4.1:3b** — emits **109 output tokens** per judgment. It is not reasoning and then
  concluding; it is concluding. Verdict distribution 21 A / 2 B / 7 tie against a key with no ties,
  so 7 of its 15 errors are refusals. Position-biased and below the floor.
- **granite4.2:3b** — genuinely reasons (~3,310 tokens) and **enters a degenerate repetition loop on
  17% of the set**. See §5.2. Not viable at `temperature: 0.3` with no repetition penalty.

### The reproducibility result worth keeping

Two `granite4.1:3b` runs 14 hours apart produced **bit-identical verdicts on all 30 items**
(30/30 compared, 30 identical). At `temperature: 0.3` the sampler does not guarantee that, so this is
evidence about the *whole path* — prompt assembly, item ordering, pair ordering, parsing — not just
the model. **It is the cheapest regression test available: 108 seconds of granite4.1 time.** Re-run
it after any change to prompt construction or parsing; a differing verdict has a real cause.

---

## 3. What shipped

Five commits on `main`, all promoted.

| commit | what |
|---|---|
| `414e826` | escalating 5→15 min timeout; time-to-compute per (dataset, item, model) |
| `60be6f6` | **fix**: that escalation reached 1 of 3 provider seams — §5.1 |
| `7f0e0cb` `d21f31d` `ba237bd` | the calibration record, the throughput envelopes, the loop finding |

### The escalating timeout, as it now behaves

| | value | behaviour |
|---|---|---|
| initial budget | `EVALUATION_MODEL_TIMEOUT_MS`, 300 000 ms | **warns, does not abort** |
| hard cap | `EVALUATION_MODEL_HARD_CAP_MS`, default 900 000 ms (unset in the manifest) | **aborts** |
| attempts | 2, then `non_retryable` | |

> **CORRECTION (2026-09-01, U3).** The `attempts` row above was true of the *consumer's* disposition
> and false of the *process*. `callThroughResilience` (`src/lib/llm/index.ts`) wrapped every
> `execute()` in `withRetry` with the default 3-attempt taxonomy predicate, and a hard-cap abort on
> attempt 1 is `kind: 'retryable'` — so one delivery could run the 900 s cap up to three times
> (~2700 s) inside a 930 s lease. The reaper reclaimed mid-flight and the row executed twice; that
> is the mechanism behind the paired attempt-3/attempt-4 `judge.dlq` envelopes on run 1, and it was
> still live on `sha-d21f31d47c35`. "2, then `non_retryable`" was never enforced end-to-end. Fixed by
> `isRetryableInProcess`: a `timeout: true` `ProviderError` escapes `withRetry` on its first throw,
> so the consumer's attempt policy is the only one that runs. Pinned by
> `tests/lib/llm-index.test.ts` ("U3: a timeout ProviderError … is NOT retried in-process").

"Health" means **this judge has completed a judgment before** — not that a probe answers. A
side-channel probe proves the server is up, not that *this request* is progressing, and would
extend a wedged call to the full 15 minutes. With a baseline the alert says how far past normal the
call is; without one it says *confirm model access, waiting 10 more minutes*.

> **Do not raise the timeout by environment variable on an image older than `414e826`.** `LEASE_MS`
> was `EVALUATION_MODEL_TIMEOUT_MS + 30s` = 330 s, so a 15-minute call under a 330 s lease is
> **reclaimed by the reaper mid-flight and executed twice**. It now derives from the hard cap
> (930 s). Setting the env var alone happens to move the lease with it — which is what makes the
> shortcut look safe — but it forfeits the alert and the attempt policy and re-arms the hazard for
> whoever tunes the two numbers apart.

---

## 4. Suites and gates

```sh
npm run lint            # eslint src/ prisma/ scripts/ tests/   — 0, no warnings
npx tsc --noEmit        # 0
npm test                # 869 unit  (55 files)
npm run test:db         # 670 db    (46 files) — resets the TEST database, see below
npm run test:integration# 80        (10 files)
npm run test:coverage   # per-glob floors; exit 0 required
```

**`npm run test:db` runs `prisma migrate reset --force`.** It reads `.env.test`. Confirm that file
points at the local podman Postgres before running it — see §6.

**The coverage floors are a ratio over a denominator that moves with imports.** A new test that
imports `src/worker/judgment-consumer.ts` pulls the whole `realtime` bus/redis-bus chain into
`src/lib/realtime/**` and drops its branch coverage from 87.5% to 77.77% **without changing which
lines any test covers**. `vitest.config.ts` already predicts this for `src/worker/reaper.ts`. The fix
is to mock the seam's unused dependency, not to lower the floor — see the header of
`tests/lib/judgment-consumer-escalation.test.ts`.

---

## 5. Corrections — the two things this session got wrong

### 5.1 The escalating timeout shipped into ONE of three seams

`414e826` wired the escalation into `defaultRunProviderJudgment` (pointwise) and into neither
`defaultRunProviderPairwise` nor `defaultRunProviderResponse`. **Calibration is pairwise** — the path
the feature was requested for was the one path it never reached.

**It failed in the direction that looks healthy.** `execute()` arms its own timers from
`resolveTimeoutBudgets()` unconditionally, so the hard cap still aborted and the 5-minute alert still
fired in production logs. Nothing threw, nothing warned, and the feature looked live. What was
silently dropped was the *context*:

| dropped | consequence |
|---|---|
| `attempt` → defaults to 1 | `hardCapAbortKind(1)` returns `retryable` **forever**; "two attempts then give up" was not enforced. **The only behaviour defect of the three.** |
| `latencyBaseline` | the alert claimed *"this is the first judgment for this judge"* against a judge with 26 of them |
| `onInitialBudgetElapsed` | the alert never reached the running process |

**What caught it:** the alert's own claim, read against the database. Corroborated inside the same
run — the CLI's read of the same data reported `n=40` while the worker's alert said "no baseline".

**The generalisable form:** a feature spread across N sibling call sites, where the shared machinery
downstream still half-works without it, produces a partial rollout that looks complete. **The seam
count is the thing to check.** `grep -c buildTimeoutEscalation` is now the check, and
`tests/lib/judgment-consumer-escalation.test.ts` asserts it per-seam, named per-seam — a test
exercising only the pointwise path would have passed against the bug.

### 5.2 "It's truncation, raise `max_tokens`" — wrong, and I wrote it down before measuring

granite4.2:3b failed 5 of 30 items with `finish_reason: length` at `max_tokens: 12288`. I reasoned
from the throughput curve to a recommendation — `num_ctx 24576`, `max_tokens ~16384` — and published
it while the run was still draining.

**The failures were a degenerate repetition loop.** All five: `content length 0 chars` with
26,549–56,004 characters of reasoning against a mean of 13,138 for judgments that finished. Reading
in at offset 40,000 shows one clause cycling verbatim.

Measured across all five rather than eyeballed on one, using `pg_column_size()` — the pglz-compressed
on-disk size:

| | n | mean chars | mean stored | compression |
|---|---|---|---|---|
| completed | 25 | 13,138 | 4,676 | **2.63×** — ordinary prose |
| failed | 5 | 44,287 | 8,040 | **8.23×** — a loop |

A larger budget buys a longer loop. **These five consumed 41 of the run's 82 minutes for zero
verdicts.**

**The error message gives this advice too**, with total confidence:

```
A response cut off mid-reasoning is not a completed judgment — raise samplingDefaults.max_tokens
on the JudgeModelVersion for this judge.
```

Correct when a model needed room; harmful when it is looping. `finish_reason: length` is ambiguous
between "ran out of room" and "never going to stop", and the guard assumes the first. **The
distinguishing signal is already computed**: compression ratio above ~5×, or `content length 0` after
tens of thousands of reasoning characters. Follow-up, not fixed — it is a change to the `execute()`
chokepoint and wants its own test.

### 5.3 A thing I nearly got wrong and didn't

Truncation is not random — it hits the items that make a judge reason longest — so the tempting
conclusion is that a partial run's surviving accuracy is **inflated by survivorship**. Tested against
Qwen, which scored all 30 and is a clean control on the same items:

| granite4.2 outcome | items | Qwen accuracy on them | Qwen mean tokens |
|---|---|---|---|
| completed | 25 | 0.8400 | 2,610 |
| failed | 4* | 1.0000 | 4,564 (+75%) |

The items **do** demand more reasoning — Qwen spent 75% more tokens on them, and that reproduces
across two unrelated models. But they are **not shown to be harder to answer**: 4-of-4 at Qwen's 0.84
base rate has probability 0.84⁴ ≈ 0.50, a coin flip carrying no information. **So no survivorship
adjustment in either direction.** The rule: a partial run's denominator is never a random sample, so
bias is always live — but check it against a judge that finished the set rather than inferring its
direction from the mechanism.

\* four at the time of measurement; the fifth landed after.

---

## 6. Traps, each of which cost something

1. **`judge-arena-pg` (podman, local) and `judge-arena-pg-1` (k8s, PRODUCTION) differ by one
   character.** `npm run test:db` resets whatever `.env.test` points at.
2. **`cd` persists between shell invocations.** A `cd A && …; cd B && git reset --hard origin/main`
   where the second `cd` was never typed hard-reset the wrong repo to a four-month-old commit.
   **Use `git -C <path>`.** Nothing was lost only because the work was already pushed.
3. **CI reports `🏁 Job succeeded` on a build it marked `❌ Failure`.** `next build` was OOM-killed
   against the runner's `limits.memory: 4Gi` and no image reached Harbor. **A green CI run is not
   evidence that an image exists.** Nothing covers the gap: `BuildPromoteLag` is excluded for
   judge-arena (`helmrelease.yaml:152`) *and* watches built-not-promoted, whereas this is
   pushed-not-built. Marginal rather than systematic — the same build passed 70 minutes earlier and
   again on retry — which is what makes it read as flaky CI.

   > **CORRECTION (2026-09-01).** The cause stated above — *"`next build` was OOM-killed against
   > the runner's `limits.memory: 4Gi`"* — is wrong, and so is *"CI reports `🏁 Job succeeded`"*.
   > The run for `60be6f6` (run 51, task 4816) was **cancelled server-side by the next push**:
   > Gitea 1.23.6 calls `CancelPreviousJobs` on every push to the same ref, and `7f0e0cb` was
   > authored 28 s before the kill. `this step has been cancelled: signal: killed` is the string act
   > v0.261.10 prints only when the step's context is cancelled — never on a kernel OOM — and the
   > `🏁 Job succeeded` that follows it appears in the **runner pod log only** (act's
   > `job_executor.go` swaps in a fresh context and loses the job error). Gitea's own record was
   > never green: task `cancelled`, all three commit statuses "Has been cancelled". The runner had
   > `restartCount 0` and no `OOMKilled` state, and the identical signature recurred at 15:56:32Z
   > on task 4818 (`7f0e0cb`, job `db-tests`, a kubectl polling loop with no Node process), 8 s
   > after `d21f31d` was authored (15:56:24Z). `2c1e85e` and `740e7bb` have no image for a different reason:
   > they were never the head of a push and never had a run. "Passed again on retry" is also
   > wrong — `d21f31d` was a new push whose run was simply not cancelled; `60be6f6` was never
   > rebuilt. What stands: a green-looking pod log is not evidence of an image. What changed: read
   > `bash scripts/ci/ci-status.sh <sha>` (tasks + commit-status APIs, no token, then Harbor)
   > before every promote; `build-push` now prints `IMAGE_PUBLISHED …` after asserting the tag.
   > Do not retune the runner or `NODE_OPTIONS` on this evidence. Detail: spec §5.5 correction.
4. **Verify the artifact, not the source tree.** `e4b9948`'s image never built because
   `.dockerignore` excluded `scripts/**`; Harbor silently stayed on the previous tag. Third instance
   of this family with trap 3 and homelab's chart-version no-op. **The invariant that closes all
   three:** after any push to `main`, assert a Harbor tag exists for the commit SHA — one
   `skopeo inspect`.
5. **`NewReplicaSetAvailable` is true *before* a new rollout starts.** Waiting on it exits
   immediately and reports success against the previous rollout. Wait on the observable you care
   about — the deployment's image string changing.
6. **`pgrep -f <pattern>` matches its own command line.** `until ! pgrep -f "calibration/run.ts"`
   never exits.
7. **NUL bytes as map-key delimiters make a source file binary.** `file` reports "data" and grep
   silently skips every line. Already removed once in `41147c8`; reintroduced and removed again.

   > **CORRECTION (2026-09-03).** *"reintroduced and removed again"* reads as *they are gone*. They
   > are not. Measured on a clean tree at `HEAD` (`e167f5b`): **one NUL byte each**, committed and
   > tracked, in `src/lib/calibration/readings.ts:164` (`` const key = `${itemId}\0${raterId}` ``)
   > and `scripts/importer/reconcile.ts:294` (`` const key = `${j.runId}\0${triple}` ``). `file`
   > reports `data` for both, and the trap is live: `grep -c const readings.ts` prints nothing
   > while `grep -ac const readings.ts` prints 12. **Use `grep -a` on this repo.** The byte is the
   > map-key delimiter the surrounding code depends on — deleting it to make grep behave changes
   > what those keys collide on, so it is a code change, not a formatting fix.
8. **`--poll-timeout` expiring scores what landed** and prints a partial accuracy that looks exactly
   like a whole one apart from its denominator. Wait for the drain and use `--score-only`.
9. **Do not launch a second calibration against the same server while one drains.** They share a
   lane, and the reaper's deadline is a bound, not a guarantee.

---

## 7. Open, in priority order

> **STATUS 2026-09-03 — read
> [`2026-09-03-wave1-wave2-handoff.md`](./2026-09-03-wave1-wave2-handoff.md) first; this list is
> partly historical.** Seven of the eleven items below are closed — **#1, #2, #3, #4, #6, #10,
> #11** — as are **U1** and **U3** from the 2026-08-30 register, and one item that did not exist
> when this list was written was opened and closed in the same session (it is item 12, added at the
> end). **#5, #7, #8 and #9 are still open**, and each now says what it is waiting on. Nothing below
> is deleted or rewritten: every closed item keeps the text of what was believed at the time and
> carries a **DONE** marker naming the commit, per CONTRIBUTING.md:1653-1656.
>
> **A DONE marker means the code is in the tree. It does not mean the behaviour is live.** Nine
> commits — `7e769c1`, `9defdd4`, `c3bcd40`, `270dc50`, `ba0b686`, `e103d43`, `80fc4ab`, `20fc4fc`,
> `5e48187` — are Wave 1: pushed, built and promoted, running now as `sha-5e48187cfb3a`. The other
> **16 commits of this session are Wave 2 and were local only on 2026-09-03** — not on `gitea/main`,
> no image in Harbor, not promoted. Two of them carry migrations production has not applied:
> measured against `judge-arena-pg-1` on 2026-09-03, **neither `CalibrationRun.samplingParams` (v2k)
> nor `CalibrationRun.constantBaselineAccuracy` (v2l) exists as a column.**
>
> **Note dates below do not always match commit dates.** Several notes are labelled 2026-09-01 while
> the commit that implements them is authored 2026-09-02 (`git log --date=iso-strict`). Trust the
> commit.

The register lives in
[`2026-08-30-state-and-next-steps.md` §5.5–5.6](./2026-08-30-state-and-next-steps.md). Ranked here by
what a leaderboard actually needs.

### Blocks a trustworthy leaderboard

1. **`CalibrationRun` does not snapshot the sampling config, and `samplingDefaults` is mutable.**
   The obvious join reports *today's* config for a historical run — editing granite4.2's budget
   silently rewrote what that query says about the earlier run, with nothing logged. Truth is one
   level deeper on `ModelJudgment.samplingParams`. `rubricId`, `kappaVariant` and `passThreshold` are
   already pinned for exactly this reason; this was missed. **Additive, one column.**

   > **CORRECTION (2026-09-01, v2k).** Landed as `CalibrationRun.samplingParams` — the RESOLVED
   > `{ temperature, max_tokens }` (`effectiveSamplingParams(samplingDefaults)`, never the raw JSON)
   > written inside the launch transaction in `src/lib/calibration/launch.ts`; NULL only on the 9
   > runs launched before v2k, deliberately not backfilled. The sentence above also said
   > `passThreshold` is "already pinned". **It is not**: `CalibrationRun.passed` and
   > `CalibrationRun.passThreshold` are declared in `prisma/schema.prisma` and NOTHING in `src/` or
   > `scripts/` writes them. What is
   > actually pinned is `rubricId` at launch and `kappaVariant`/`kappaWeighting`/`thresholdMetric` at
   > score time (`score.ts`). The same wrong sentence appeared in the scoreboard spec §4.1 and the
   > register §5.6 #6 and is corrected in both. `scripts/calibration/run.ts` now prints the snapshot
   > and warns when a run's judgments disagree with its header or with each other.

   > **DONE — `33b7be4` (v2k), authored 2026-09-02T21:01. Wave 2: in the tree, not pushed, not
   > promoted.** Migration `prisma/migrations/20260901180000_v2k_calibration_sampling_snapshot` adds
   > `CalibrationRun.samplingParams` (JSONB, additive, nullable). It is local. **Production is not at
   > it — the column does not exist on `judge-arena-pg-1`, checked 2026-09-03.**
   >
   > **CORRECTION to "NULL only on the 9 runs launched before v2k" above.** That was measured when
   > there were nine runs. Production now holds **11 `CalibrationRun` rows** (measured 2026-09-03):
   > the two qwen3.5:9b ordinals were both launched on a pre-v2k image, so when the migration is
   > applied **11 rows hold NULL, not 9**. The design point stands — no backfill, because a
   > snapshot invented after the fact is not a snapshot.

2. **Emit the degenerate baseline beside the accuracy.** It is computable from the answer key,
   `score.ts` already derives it in prose, and nothing displays it. Without it a leaderboard cannot
   distinguish "learned a little" from "stamps A". Must be computed **per denominator** (§2).

   > **DONE (v2l, 2026-09-02).** `src/lib/calibration/baseline.ts` computes it per scored subset;
   > `scoreCalibrationRun` returns `constantBaseline` + `marginOverConstant` and stores the floor as
   > `CalibrationRun.constantBaselineAccuracy` in the same overwrite as `rawAgreement`; the CLI prints
   > `constant … margin` and a `⚠` when accuracy ≤ floor. The 9 existing rows hold NULL until re-scored
   > with `--score-only` on an image carrying v2l — an operator write, not a migration step. "Computable
   > from the answer key" above was only half right: from the key **restricted to the scored rows**.

   > **DONE — `1ef04ab` (the floor as a pure function, per denominator), `712301b` (v2l: score emits
   > it and stores it), `f78d90c` (the CLI prints floor and margin), all authored 2026-09-02. Wave 2:
   > in the tree, not pushed, not promoted.** Migration
   > `prisma/migrations/20260901190000_v2l_calibration_constant_baseline` adds
   > `CalibrationRun.constantBaselineAccuracy` (DOUBLE PRECISION, additive, nullable).
   >
   > **The caveat that changes how every floor is read:** the note above says the existing rows hold
   > NULL "until re-scored with `--score-only` on an image carrying v2l". **No such image exists.**
   > The column does not exist on `judge-arena-pg-1` (checked 2026-09-03), so every constant floor
   > quoted in any document — including the 0.5357 for qwen3.5:9b in the 2026-09-03 handoff — is
   > **derived by hand from the key over the scored subset, not read from the database.**

3. **Distinguish a repetition loop from a genuine truncation** (§5.2). The guard's advice is
   actively harmful in the loop case. **Shipped in `a272519`** — `src/lib/llm/degeneration.ts`,
   deflate ≥ 5× over ≥ 8,000 chars per channel; see the CORRECTION in spec §5.4.2 for what the
   deflate re-measurement changed about "all five".

   > **DONE — `a272519`, authored 2026-09-02** (docs sibling `0a6669e`, which fixes the truncation
   > message where it was quoted elsewhere). **Wave 2: in the tree, not pushed, not promoted** — so
   > the harmful advice quoted in §5.2 is still exactly what production emits on
   > `sha-5e48187cfb3a`. "Shipped in `a272519`" above should be read as *committed*, not *running*.

### Correctness, unfixed

> **2026-09-03: the heading is left as it was written, and it is now wrong about two of its three
> items.** #4 and #6 are closed. Only **#5** is still unfixed under this heading.

4. **The AMQP consumer re-registration defect.** The pipeline was silently dead for five days in
   August: the pod stayed 1/1 Running with 0 restarts while consuming nothing. `/health` now
   *detects* it; the reconnect itself is still broken. homelab PR #932 is still draft.

   > **DONE — `20fc4fc` (exit on AMQP consumer loss so `restartPolicy` re-registers), with `80fc4ab`
   > (the policy: log once, flush, exit 1) and `5e48187` (the docs). Wave 1: pushed, built and
   > PROMOTED — live now as `sha-5e48187cfb3a`.**
   >
   > **Read the scope exactly, because the item above asks for something this does not do.
   > Exiting does NOT fix the reconnect.** The last sentence above — *"the reconnect itself is still
   > broken"* — is still true of the reconnect path. What changed is the failure mode: a silent
   > zombie (1/1 Running, 0 restarts, 0 consumers, five days in August) becomes a **visible, bounded
   > restart** — the worker logs the loss once, flushes and exits 1, the pod restarts, and
   > registration runs again from the top. The cost is that a flapping pod is now the symptom, so
   > the standing consumer check in §1 stays standing; the gain is that the failure can no longer be
   > silent. **It unblocks homelab PR #932.**

5. **`judge.dlq` holds 10 messages, has no consumer and no replay verb.** It grew from 4 during
   ordinary operation, so it is an accumulating sink, not run-1 residue.

   > **STILL OPEN, 2026-09-03 — and unchanged, which is itself the measurement.** `judge.dlq` read
   > **10 messages, 0 consumers** at every check across the 2026-09-02/03 session. **Blocked on
   > execution, not on design:**
   > [`2026-09-01-dlq-admin-cli.md`](./2026-09-01-dlq-admin-cli.md) is authored and reviewed and was
   > **not executed** — no file in `fc9e936..HEAD` touches the DLQ path. **That plan is untracked**
   > (`git status` shows it as `??` on 2026-09-03), so it exists on this workstation and in no clone.

6. **CI's false green** (trap 3) — **CORRECTION (2026-09-01)**, same day: the item as written —
   *"Make the job fail when a step fails first; the OOM is secondary"* — assumed a YAML defect and
   an OOM, and there was neither (trap 3 correction). Done as far as this repo can do it. What landed:
   `scripts/ci/assert-harbor-tag.sh` + an `Assert Harbor has sha-<12>` step in `build-push`,
   `scripts/ci/ci-status.sh <sha>` as the pre-promote read, and comment/doc corrections. Still
   open, and not in this repo: nothing watches pushed-not-built out-of-band (a cancelled run never
   reaches the assert step) — a homelab-setup exporter comparing Gitea `main` HEAD to Harbor tags
   would be the shape that catches it.

   > **DONE as far as this repo can close it — `9defdd4` (assert a registry artifact exists for a
   > tag), `c3bcd40` (assert the Harbor tag after the kaniko Job completes), `270dc50` (read a
   > commit's outcome from Gitea's record, not the pod log), with `ba0b686` and `e103d43` putting
   > the correction next to the claim in `ci.yml` and the docs. Wave 1: pushed, built and PROMOTED
   > as `sha-5e48187cfb3a`.**
   >
   > **CORRECTION — the root cause recorded in this document was wrong.** Trap 3 above stated
   > *"`next build` was OOM-killed against the runner's `limits.memory: 4Gi` and no image reached
   > Harbor"*, and the 2026-08-30 register's item 11 prescribed *"make the job fail when a step
   > fails; then raise the runner limit or bound Next's static-generation workers"*. **There was no
   > OOM.** Gitea 1.23.6 calls `CancelPreviousJobs` on every push to the same ref and cancelled the
   > run server-side; act v0.261.10 then printed `🏁 Job succeeded` **in the runner pod log only**,
   > from a fresh context that had lost the job error, while **Gitea's own status said cancelled**
   > throughout. Nothing in `ci.yml` swallowed a failure and the runner never OOMKilled. So the
   > second prescribed fix addressed an event that did not happen, and the first was not needed.
   > This correction is not new on 2026-09-03 — it was written into trap 3 and into the body of this
   > item on 2026-09-01, from the Gitea tasks API rather than the pod log. It is restated here
   > because this register is where a reader looks for the cause, and because the wrong version is
   > still the one most people remember.
   >
   > **A second, different failure hides under the same symptom.** `2c1e85e` and `740e7bb` have no
   > image because they **never had a run at all** — neither was the head of its push. Cancelled and
   > never-ran are indistinguishable from Harbor (no tag either way) and are separated only by
   > Gitea's record: `bash scripts/ci/ci-status.sh <sha>` exits 2 for never-ran and 1 for
   > ran-but-no-image. Push one head at a time.
   >
   > **What is still open is unchanged and is not in this repo:** nothing watches pushed-not-built
   > out of band. A cancelled run never reaches the assert step, so the in-repo assert structurally
   > cannot catch the case that produced this item.

### Product

7. **Zero human judgments.** The annotation studio has never been exercised end-to-end.

   > **STILL OPEN, 2026-09-03.** `HumanJudgment` is **0 rows** on `judge-arena-pg-1`, measured
   > 2026-09-03 — unmoved. **Blocked on a person, not on code:** no file in `fc9e936..HEAD` touches
   > the studio, and no commit could close this one. Scoring more judges widens §2 without touching
   > it.

8. **No frontier reference line.** Claude Opus 4.5 / Sonnet 4.5 / Sonnet 4.6 are registered and
   unscored, so the local numbers have nothing to be placed against.

   > **STILL OPEN, 2026-09-03.** Measured: all three Anthropic judge models still have **0
   > calibration runs** (11 runs exist, all against the four self-hosted models). **Blocked on an
   > API key and the spend it implies** — not on code, and not on anything this session produced.

9. **One rubric, one protocol, one set.** Everything is pairwise under General Quality Assessment on
   30 items. Nothing is known about pointwise, other rubrics, or whether a judge is *good* versus
   *suited to this set* — and κ is not comparable across sets, which is the whole point of a
   scoreboard.

   > **STILL OPEN, 2026-09-03, and untouched.** Unlike #7 and #8 this is not blocked on anything
   > external — it is unstarted work, and no plan is authored for it (`docs/superpowers/plans/`
   > holds none as of 2026-09-03). The session added a fourth judge, qwen3.5:9b — a fifth
   > scoreboard row, recorded in the 2026-09-03 handoff §2 and the spec's §1 row 11, **not in §2
   > above**, which is left as it was written on 2026-09-01 — against the same 30 items, the same
   > rubric and the same protocol: more rows in the one column, not a second column.

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

    > **DONE — `1806e7f`, authored 2026-09-02T23:05. Wave 2: in the tree, not pushed, not
    > promoted.** The decision above ("neither" — not derived, not dropped) is what the commit
    > implements: the column stays, labelled usage-reported, and the report prints reasoning
    > *length* beside it. Note the dates: this item was written up as "CLOSED 2026-09-01", a day
    > before the code existed, and production still runs the pre-`1806e7f` report.

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

    > **DONE — `781bf58`, authored 2026-09-02T23:17. Wave 2: in the tree, not pushed, not
    > promoted.** Same shape as #10: written up as "CLOSED 2026-09-01", coded a day later,
    > production on neither.
    >
    > **The re-run demanded by the last sentence above is still owed, and it is the cheapest
    > regression signal this product has.** `781bf58` is the first change ever to write `parseMode`
    > on the **pairwise** path — the path calibration runs on. After the Wave 2 image is promoted,
    > re-run granite4.1:3b against golden set `cmt057hd001g17y01lhjzgfuj` and confirm the verdicts
    > are still **bit-identical on all 30 items**. Run it whole at its registered `max_tokens: 4096`
    > — the runbook does not permit changing `max_tokens` mid-run. It costs ~108 s of judge time and
    > covers prompt assembly, item ordering, pair ordering and parsing, not just the model. A
    > differing verdict has a real cause and should be chased before anything else lands.

### Closed in the same session, and never on the list above

12. **`outputTokens` does not always count the reasoning channel, and nothing warned when a
    judgment ran close to `max_tokens`.** Found mid-session on 2026-09-02, so it was never one of
    the eleven.

    > **DONE — `e438da2` (derive the generated total), `0bd6b6b` (warn when a judgment's estimated
    > generation nears `max_tokens`), `db5bff9` (correct the tok/s formula and the throughput
    > envelopes in the runbook). Wave 2: in the tree, not pushed, not promoted.**
    >
    > The measurement that forced it — (reasoning + content) chars per `outputTokens`, measured per
    > judge: **3.76** on Qwen3.6-35B-A3B and **3.87** on granite4.2:3b, where the provider's count
    > already includes reasoning; **78.96** on qwen3.5:9b, whose count **excludes the reasoning
    > channel entirely**. The same column means two different things depending on the server. Read
    > raw, qwen3.5:9b runs at **0.54 tok/s** over all 28 of ordinal 2's completed judgments; pooled
    > through `accountTokens()` (`src/lib/calibration/token-accounting.ts`) it is **12.03 tok/s** —
    > DERIVED, and over the **first 15** of those 28, which is what had drained when it was measured.
    > Re-measured over all 28 it is **12.61**. The two numbers do not share a denominator; quote
    > either with its `n`. That ~22× gap is the difference between a `max_tokens` budget that fits
    > the 900 s hard cap and one that cannot, and it is the same gap on either denominator — 12288
    > needs 1021 s at 12.03 and 975 s at 12.61, against a 900 s cap.
    >
    > **CORRECTION, inside the same session.** An earlier claim made while working this item — that
    > *every* recorded throughput envelope was understated ~2.2× (Qwen3.6 31.3→67.4, granite4.2
    > 35.1→78.3) — **was a double count and is wrong.** Where the chars-per-token ratio is ~3–4 the
    > provider's count already includes reasoning, so adding a chars-derived estimate on top counts
    > the reasoning channel twice. **Qwen3.6's and granite4.2's published rates were correct and do
    > not move.** Only qwen3.5:9b's was wrong.

### From the 2026-08-30 register §5.5–5.6, worked in the same session

- **U1 — the stacked `max_tokens`/timeout limits wanted to be code** (register §5.6/8). **DONE —
  `c5e84f3` (warn at launch when `max_tokens` cannot fit the hard cap), on `c5513d9` (pooled output
  throughput per judge, via `accountTokens`) and `58139bb` (the rule); `e167f5b` marks the register
  item done. Wave 2: in the tree, not pushed, not promoted.** It **warns, never refuses** — a
  first-ever judge has no history to pool. The register item carries its own CORRECTION and its
  scope limits; they are not repeated here.
- **U3 — a hard-cap abort escaped the in-process retry**, so one delivery could run the 900 s cap up
  to three times inside a 930 s lease. **DONE — `7e769c1`. Wave 1: pushed, built and PROMOTED as
  `sha-5e48187cfb3a`.** The CORRECTION in §3 above states the defect; this is the commit that closes
  it.
- **U2 — the finalizer never revisits a terminal run.** STILL OPEN. **Blocked on execution, not on
  design:**
  [`2026-09-01-finalizer-error-to-needs-human.md`](./2026-09-01-finalizer-error-to-needs-human.md)
  is authored and was **not executed** — no file in `fc9e936..HEAD` touches the finalizer. Like the
  DLQ plan, it is **untracked**: on this workstation only, not in any clone.
- **U4 — `toCandidate` stamps `label: null`** (`src/lib/golden-sets.ts`), so the studio shows
  Option 1 / Option 2 against an `A>B` answer key. STILL OPEN, untouched this session.
- **U5 — no UI for the agreement route** (`src/app/api/golden-sets/[id]/agreement/route.ts`). STILL
  OPEN, untouched this session.

---

## 8. Starting the next session

```sh
# 1. What is running — the live object, not the manifest. (§1)
kubectl -n tenant-public get deploy judge-arena-web judge-arena-worker \
  -o custom-columns='NAME:.metadata.name,IMAGE:.spec.template.spec.containers[0].image,READY:.status.readyReplicas'

# 2. Is the pipeline alive? consumers must equal expectedConsumers (10). (§1, open #4)
kubectl -n tenant-public logs deploy/judge-arena-worker --tail=20 | grep 'judge worker started'

# 3. CORRECTION (2026-09-03): THIS QUERY ERRORS TODAY — it does not return NULL.
#    "samplingParams" (v2k) and "constantBaselineAccuracy" (v2l) are Wave 2 and local:
#    measured on judge-arena-pg-1 2026-09-03, NEITHER COLUMN EXISTS. Drop both from the
#    SELECT until Wave 2 is promoted. The pre-v2k row count below is also stale — it is
#    11, not 9 (see §7 #1). Current version: 2026-09-03-wave1-wave2-handoff.md §8.
#    The scoreboard as the database holds it — never from a doc, and never
#    joining to JudgeModelVersion.samplingDefaults for the config. (open #1,
#    landed as v2k: cr."samplingParams" is the launch-time snapshot. The
#    nested DISTINCT is only the fallback for the 9 rows launched before v2k,
#    which are NULL by design — and it ERRORS with "more than one row" on a
#    run whose config moved mid-run, which is the right outcome.)
#    floor = CalibrationRun.constantBaselineAccuracy (v2l): NULL until a row is re-scored on a v2l image.
kubectl -n tenant-public exec judge-arena-pg-1 -c postgres -- psql -U postgres -d judge_arena -c "
  SELECT jm.name, cr.\"rawAgreement\" AS acc, cr.\"constantBaselineAccuracy\" AS floor, cr.kappa, cr.\"verdictCount\",
         COALESCE(cr.\"samplingParams\"->>'max_tokens',
           (SELECT DISTINCT mj.\"samplingParams\"->>'max_tokens'
              FROM \"ModelJudgment\" mj JOIN \"EvaluationRun\" er ON er.id = mj.\"runId\"
             WHERE er.\"calibrationRunId\" = cr.id AND mj.\"samplingParams\" IS NOT NULL)) AS maxtok,
         (cr.\"samplingParams\" IS NULL) AS pre_v2k
    FROM \"CalibrationRun\" cr
    JOIN \"JudgeModelVersion\" jmv ON jmv.id = cr.\"judgeModelVersionId\"
    JOIN \"JudgeModel\" jm ON jm.id = jmv.\"judgeModelId\"
   ORDER BY cr.\"startedAt\" DESC;"

# 4. Confirm main has an image in Harbor. Green CI does not mean this. (trap 3/4)
# CORRECTION (2026-09-01): read Gitea's record first — exit 2 = never ran, 1 = ran, no image.
bash /root/judge-arena/scripts/ci/ci-status.sh $(git -C /root/judge-arena rev-parse main)
skopeo inspect --no-tags \
  docker://harbor.cluster.asethi.com/homelab/judge-arena:sha-$(git -C /root/judge-arena rev-parse main | cut -c1-12)
```

**To score another judge**, follow
[`docs/runbooks/scoring-a-judge-against-a-golden-set.md`](../../runbooks/scoring-a-judge-against-a-golden-set.md).
Its §8.6–8.8 are new and are the ones that will save time: the stacked `max_tokens`/timeout limits,
the escalating timeout, and which config changes are safe mid-run.

**Before registering a judge**, score one item and read `outputTokens` / `latencyMs`. That gives
tok/s, and `max_tokens / tok_per_s` must fit under the 900 s hard cap. **Throughput decays with
output length** — granite4.2 ran 35.9 tok/s at 4.5k tokens and 23.2 tok/s at 12k — so treat the
linear estimate as a lower bound on duration, not an estimate.

**Capacity is a property of the fleet, not the scoreboard.** Lanes key on the normalised endpoint
*origin*: two models on one Ollama host share a lane and run strictly serially; a model on its own
box gets its own lane. Registering 300 models against one server produces a 300-deep queue, not
parallelism.
