# The judge scoreboard, and what it costs to add a model — 2026-09-01

Companion to [`2026-08-31-calibration-baseline-and-footprint.md`](./2026-08-31-calibration-baseline-and-footprint.md),
which established the *method* and the storage numbers. This one is the **ledger**: every
calibration run that has ever scored a judge against a golden set, what each judge's operating
envelope actually is, and the traps that will corrupt a leaderboard built from many of them.

The intent behind it is the scaling goal — *spin up hundreds of models and see how they score
against the golden set benchmarks*. Everything here is written for that: not "here is a number"
but "here is the number, its denominator, the config that produced it, and what would make it a lie."

---

## 0. If you read one thing

**On this golden set, a judge that stamps `A>B` on every item scores 0.5667.** That is the number
to compare against, not 0.5. Two of the runs below land *underneath* it. An accuracy that looks
like a weak-but-real signal can be strictly worse than a constant, and only the pair
(accuracy, kappa) says which.

Second: **`JudgeModelVersion.samplingDefaults` is mutable and is not snapshotted onto the
`CalibrationRun`.** The obvious join — run → version → config — reports *today's* config for a
year-old run. §4.1 has the query that doesn't lie.

Third: **`finish_reason: length` does not mean "needed more room".** On run 9 it meant a degenerate
repetition loop on 17% of the set, and the error message's advice — raise `max_tokens` — would have
made it worse. §5.4.2 has the compression-ratio test that tells the two apart in one query.

---

## 1. THE SCOREBOARD

Golden set `cmt057hd001g17y01lhjzgfuj` — *JudgeBenchSample — 30 random*, pairwise, frozen.
Answer key: **17 `A>B`, 13 `B>A`, no ties.** Rubric: General Quality Assessment (5 criteria).

`max_tokens` below is read from `ModelJudgment.samplingParams`, the per-judgment snapshot — **not**
from the version row, for the reason in §4.1.

| # | run id | judge | backend | `max_tokens` | **accuracy** | κ | n | trunc | verdict | 
|---|---|---|---|---|---|---|---|---|---|
| 1 | `cmtgib0xr` | Qwen3.6-35B-A3B | llamacpp | 8192 | 0.8462 | 0.6950 | 26/30 | 0 | ⚠ over-subscribed — see §2.1 |
| 2 | `cmthr58r1` | Qwen3.6-35B-A3B | llamacpp | 8192 | 0.8333 | 0.6575 | 30/30 | 0 | ✅ **the baseline** |
| 3 | `cmtht0o9a` | Qwen3.6-35B-A3B | llamacpp | 8192 | 0.8333 | 0.6637 | 30/30 | 0 | ✅ repeat of #2 |
| 4 | `cmtht0o9d` | granite4.1:3b | ollama | 4096 | 0.5000 | 0.1296 | 30/30 | 0 | ⛔ **below the constant baseline** |
| 5 | `cmtimse5m` | granite4.1:3b | ollama | 4096 | 0.5000 | 0.1296 | 30/30 | 0 | ⛔ bit-identical to #4 — see §3.1 |
| 6 | `cmtimssel` | Qwen3.6-35B-A3B | llamacpp | 8192 | 0.7931 | 0.6000 | 29/30 | 1 | ⚠ one item truncated |
| 7 | `cmtiplr3x` | granite4.2:3b | ollama | 4096 | 0.6667 | 0.3182 | **15/30** | **15** | ⛔ **VOID** — half the set truncated |
| 8 | `cmtipm1nb` | Qwen3.6-35B-A3B | llamacpp | **12288** | **0.8667** | **0.7285** | 30/30 | 0 | ✅ **best recorded** |
| 9 | `cmtircx0x` | granite4.2:3b | ollama | **12288** | 0.6000 | 0.2355 | **15/25** | **5** | ⛔ 5 items lost to a REPETITION LOOP — §5.4.2 |

**Reference lines for reading that column:**

| baseline | accuracy | κ | why it matters |
|---|---|---|---|
| always `A>B` (the degenerate judge) | **0.5667** | 0.0000 | 17/30. The real floor. |
| always `B>A` | 0.4333 | 0.0000 | 13/30. |
| uniform coin flip | ~0.5000 | ~0.0000 | what "0.50" *looks* like but is not. |

`granite4.1:3b` scoring **0.5000 is worse than a constant stamp**, and its κ of 0.1296 says it is
not *quite* degenerate — it has a faint signal and spends it badly. §3.2 shows exactly how.

**The floor moves with the denominator, so a partial run needs its own.** Run 9 scored 25 of 30
items, and that subset's key is 14 `A>B` / 11 `B>A` — a constant-`A>B` baseline of **0.5600**, not
0.5667. granite4.2 scored 0.6000 against it: **+0.04 over a constant stamp, for 82 minutes of
compute.** Comparing a partial run against the whole set's floor would have flattered it, which is
the second reason (after §4.1) that a leaderboard cannot compute this number once and cache it.

### 1.1 What changed between the two Qwen configurations

Runs #2/#3 and #8 are the same judge, the same frozen set, the same rubric, sequential in both
cases. The only difference is the token budget.

| | 8192 (#2) | 12288 (#8) | Δ |
|---|---|---|---|
| accuracy | 0.8333 | **0.8667** | +0.0334 (25→26 of 30) |
| κ | 0.6575 | 0.7285 | +0.0710 |
| mean output tokens | 2364 | 2869 | +21% |
| max output tokens | 7272 | 7733 | — |
| mean latency | 42.6 s | 49.0 s | +15% |

**More room to reason produced better verdicts, not merely fewer failures.** Neither run truncated,
so this is not the truncation fix showing up as accuracy — at 8192 the judge was already finishing.
It is the ordinary result that a reasoning model given more headroom uses it. The cost is 15% wall
clock for one extra correct item out of thirty, which on a 30-item set is one sample and **not yet
a significant difference**; treat it as directional until a larger set repeats it.

---

## 2. OPERATING ENVELOPES — what a model costs, before you queue 300 of them

Measured over every `status='completed'` judgment attached to a calibration run.

| judge | `max_tokens` | n | mean out | max out | mean lat | max lat | **tok/s** | mean in |
|---|---|---|---|---|---|---|---|---|
| Qwen3.6-35B-A3B | 12288 | 30 | 2869 | 7733 | 49.0 s | 140.2 s | **58.5** | 1773 |
| Qwen3.6-35B-A3B | 8192 | 115 | 2351 | 7272 | 86.2 s | 299.1 s | 27.3 ⚠ | 1756 |
| granite4.2:3b | 12288 | 11* | 3310 | 7305 | 94.5 s | 250.2 s | **35.0** | 2072 |
| granite4.2:3b | 4096 | 15 | 1950 | 3058 | 52.3 s | 99.8 s | 37.3 | 1650 |
| granite4.1:3b | 4096 | 60 | 109 | 163 | 3.6 s | 16.8 s | 30.2 | 1660 |

\* partial — run #9 was still draining when this table was built.

**The 8192 row's 27.3 tok/s is polluted and must not be quoted as Qwen's speed.** It pools run #1,
which was over-subscribed (prefetch 8 against `total_slots: 2`), so its latencies include time spent
queued *inside* the inference server. The clean sequential figure for Qwen is **58.5 tok/s**. This is
the same contamination §3.4 of the baseline spec warns about, reappearing in an aggregate that looks
innocent because nothing in the row says "two different concurrency regimes are averaged here".

### 2.1 The arithmetic that predicts a timeout, before you hit one

```
time_to_exhaust_budget  =  max_tokens / tok_per_s
```

| judge | tok/s | budget | worst-case call | vs. 300 s wall | vs. 900 s cap |
|---|---|---|---|---|---|
| Qwen3.6-35B-A3B | 58.5 | 12288 | 210 s | fits | fits |
| granite4.2:3b | 35.0 | 12288 | **351 s** | ✗ **exceeds** | fits |
| granite4.2:3b | 35.0 | 4096 | 117 s | fits | fits |
| granite4.1:3b | 30.2 | 4096 | 136 s | fits | fits |

**Run this before registering a judge.** It is two numbers and it is the difference between a clean
30/30 and the failure in §5. Rearranged, the token ceiling a given timeout can afford is:

```
max_safe_tokens  =  timeout_s  ×  tok_per_s
```

granite4.2 at 35 tok/s under the old flat 300 s wall could only ever finish **~8,700 tokens** — so a
12288 budget was unreachable by construction, and every item whose reasoning ran long was doomed
before it started.

---

## 3. WHAT THE SCOREBOARD REVEALS ABOUT THE JUDGES

### 3.1 The harness is reproducible — verified, not assumed

Runs #4 and #5 are `granite4.1:3b`, same config, launched **14 hours apart**. They did not merely
score the same:

```
items compared: 30    verdicts identical: 30
```

**Every single item produced the same verdict.** At `temperature: 0.3` that is not guaranteed by the
sampler, so this is evidence about the whole path — prompt construction, item ordering, pair
ordering, parsing — and not just about the model. Any future run that scores differently on an
unchanged (judge, set, config) triple has a real cause worth finding.

This is also the cheapest available regression test for the harness, and it costs 108 seconds of
granite4.1 time. Re-run #5's exact command after any change to prompt assembly or parsing.

### 3.2 granite4.1:3b is not a weak judge; it is a stuck one

| | verdict distribution | mean output tokens |
|---|---|---|
| answer key | 17 `A>B`, 13 `B>A`, 0 tie | — |
| granite4.1:3b | **21 A, 2 B, 7 tie** | **109** |
| Qwen @ 12288 | 17 A, 13 B, 0 tie | 2869 |

Three things at once, and the accuracy number alone shows none of them:

1. **It says A 70% of the time** on a set that is 57% A. That is the position-bias tell the runbook's
   §7.2 describes, and it is why the raw distribution is recorded separately from derived preferences.
2. **It emits 7 ties on a corpus with no ties** — all 7 are automatic misses. Per `score.ts`, a tie is
   a miss precisely so a judge cannot raise its score by declining to answer; here that rule is doing
   visible work, and 7 of its 15 errors are refusals rather than wrong answers.
3. **109 output tokens.** It is not reasoning and then concluding; it is concluding. Compare
   granite4.2 at the same 4096 budget: 1950 tokens. Same family, same size, ~18× the deliberation.

Qwen at 12288 reproducing the key's 17/13 marginal *exactly* is worth noting but not over-reading —
on 30 items that is one plausible draw among several, not evidence of calibration.

### 3.3 A void run is not a low score

Run #7 must never appear on a leaderboard as "granite4.2 scored 0.6667". Its denominator is 15,
because the other 15 judgments were **cut off at the token budget** and are not judgments at all.
`missingVerdicts: 15` is the field that says so, and it is reported beside the accuracy for exactly
this reason. The correct summary of run #7 is *"no result; configuration error"*.

The error message names its own fix, so this is recoverable without diagnosis:

```
Provider call to "ollama" (granite4.2:3b) was CUT OFF at the token budget
(finish_reason "length"): max_tokens 4096, completion_tokens 4096, ...
raise samplingDefaults.max_tokens on the JudgeModelVersion for this judge.
```

**Why the 4096 was wrong:** it was copied from granite4.1's registration. The two are the same
family and the same parameter count, and they are not the same shape of model — granite4.2 returns a
`reasoning` key and spends ~1950 tokens before answering where 4.1 spends 109. A budget is a property
of the model's *behaviour*, not of its size.

The run was **deliberately not corrected mid-flight.** Changing `max_tokens` between items would make
the items incomparable and produce a number that is neither the 4096 result nor the 12288 result.
Let a doomed run finish, mark it void, re-run whole.

---

## 4. TRAPS THAT WILL CORRUPT A LEADERBOARD

### 4.1 `samplingDefaults` is mutable, and the run does not snapshot it

`CalibrationRun` stores the judge *version* id. It does not store the sampling config. So:

```sql
-- WRONG. Reports TODAY'S config for every historical run.
SELECT cr.id, jmv."samplingDefaults"->>'max_tokens'
FROM "CalibrationRun" cr JOIN "JudgeModelVersion" jmv ON jmv.id = cr."judgeModelVersionId";
```

Run #7 was executed at `max_tokens: 4096`. Raising the version to 12288 for run #9 silently rewrote
what that query reports about run #7 — the historical row now claims a configuration it never ran
under. Nothing was updated, nothing was logged; the join simply reads a field that moved.

The truth is one level deeper, on the per-judgment snapshot:

```sql
-- RIGHT. ModelJudgment.samplingParams is written per call and never revised.
SELECT DISTINCT mj."samplingParams"->>'max_tokens'
FROM "ModelJudgment" mj JOIN "EvaluationRun" er ON er.id = mj."runId"
WHERE er."calibrationRunId" = '<id>' AND mj."samplingParams" IS NOT NULL;
```

Two caveats on the right-hand query: `samplingParams` is **NULL** for judgments that never reached
the provider (pending, or failed before the call), so filter them out rather than letting a NULL
collapse the `DISTINCT`; and it is `DISTINCT` rather than `LIMIT 1` on purpose, because a run whose
config was edited mid-flight will return **two rows** — which is the signal that the run is not
internally comparable.

> **Open follow-up.** `CalibrationRun` should snapshot the resolved sampling config at launch, the
> way it already snapshots `rubricId`, `kappaVariant` and `passThreshold`. Those three were pinned
> because a report you cannot reconstruct is not a report; `samplingDefaults` is the same argument
> and was missed. Until then, every reader must know to go one level deeper, and readers do not
> reliably know things.

> **Landed (v2k, 2026-09-01) — with a CORRECTION.** `CalibrationRun.samplingParams` now snapshots
> the RESOLVED config at launch (`effectiveSamplingParams(samplingDefaults)`, a full
> `{ temperature, max_tokens }`, never the raw JSON), so the header itself is now the right answer:
>
> ```sql
> -- RIGHT, since v2k. NULL only on the 9 runs launched before the column existed —
> -- for those, and only those, fall through to the per-judgment query above.
> SELECT cr.id, cr."samplingParams"->>'max_tokens' AS max_tokens, cr."samplingParams" IS NULL AS pre_v2k
> FROM "CalibrationRun" cr;
> ```
>
> The note above says the run "already snapshots `rubricId`, `kappaVariant` and
> `passThreshold`". **That is wrong about `passThreshold`**: `CalibrationRun.passed` and
> `CalibrationRun.passThreshold` are declared in `prisma/schema.prisma` and nothing writes them.
> `rubricId` is pinned at launch;
> `kappaVariant`/`kappaWeighting`/`thresholdMetric` at score time. The header is a snapshot, not a
> lock — the worker still reads the version row per judgment — so a judge whose config must change
> gets a **new version ordinal** (`prisma/seed-core.ts:223-229` states the invariant) or, at the very
> minimum, is never edited mid-run; `scripts/calibration/run.ts` prints a ⚠ when a run's judgments
> disagree with the header or with each other, comparing with keys canonicalised (JSONB reorders them).

### 4.2 Kappa is not comparable across sets — and the scoreboard is cross-set by design

`score.ts` states this at length and it bears repeating *here*, because a scoreboard is exactly the
artifact that invites the mistake. Cohen's κ chance-corrects on both raters' marginals, so the same
judge with the same hit rate scores differently on a 17/13 set than on a 15/15 one. **Rank on
accuracy. Read κ as a per-set annotation** that distinguishes a judge which learned something from
one that answers `A>B` every time.

Every row in §1 shares one frozen set, so the κ column is internally comparable *today*. It stops
being so the moment a second set appears — which is the point of the program.

### 4.3 Two limits are stacked, and fixing the outer one exposes the inner one

Recorded in full in §5, because it is the live example: `max_tokens` bounds how much the model may
say; the timeout bounds how long you will wait to hear it. Raising the first without checking the
second converts a **truncation** failure into a **timeout** failure and looks like a regression.
§2.1's two-line arithmetic is the check.

---

## 5. THE 12288 TIMEOUT WALL — run #9, and why the fix had to ship first

Run #9 (`cmtircx0x`, granite4.2 at 12288) reached 11/30 and stopped advancing. The worker log:

```
"LLM call failed, retrying"  attempt 2  maxAttempts 3
error: Provider call to "ollama" (granite4.2:3b) timed out after 300000ms
```

**The model was not wedged, and the server was not down.** The 11 completed judgments are the
evidence — every one `finishReason: "stop"`, no truncation, and latency tracking output length
almost exactly linearly:

| output tokens | 1527 | 2025 | 3179 | 4567 | 5062 | 7305 |
|---|---|---|---|---|---|---|
| latency | 37.5 s | 52.0 s | 83.4 s | 127.1 s | 143.8 s | **250.2 s** |

≈35 tok/s, and the longest *successful* call already sat at 83% of the 300 s wall. The items still
queued were the long ones. They could not have finished.

**So the 12288 bump did not fail — it succeeded, and revealed the constraint beneath it.** At 4096
the model was cut off before it could run out of time; removing the token ceiling let it run into the
clock instead.

### 5.1 Why the run was salvageable

Every remaining item was still `status: 'pending'` at `attemptCount: 1`, sitting durably in
`judgment.execute.lane.0`. Nothing had exhausted its attempts and nothing had dead-lettered from this
run. So the fix was a rollout, not a relaunch.

**Extending a timeout does not compromise comparability, and raising `max_tokens` does.** This is
worth being precise about, because §3.3 refuses the opposite change mid-flight. A token budget
changes *what the model produces* — a truncated answer and a complete one are different data. A
timeout changes only *whether the client is still listening*. The 11 judgments already recorded were
produced under identical model configuration; only the harness's patience differed. Mixing them with
the remaining 19 is sound.

### 5.2 The fix, and the latent bug it carried

Promoted `sha-414e826a3ba3` (homelab-setup #950):

- **300 000 ms initial budget — alerts, does not abort.** With a latency baseline the warning states
  how far past normal this call is; with none, it says *confirm model access, waiting 10 more minutes*.
- **900 000 ms hard cap — aborts.** Two attempts, then `non_retryable`.
- Runtime recorded per `(dataset, item, model)`, so time-to-compute is queryable.

No manifest change was needed: `EVALUATION_MODEL_TIMEOUT_MS` stays `"300000"` and is now the
*initial budget*; `EVALUATION_MODEL_HARD_CAP_MS` is unset and takes the 900 000 default.

> **CORRECTION (2026-09-01, U3).** "Two attempts, then `non_retryable`" described the consumer's
> disposition of the hard-cap error, not what the process did with it. `src/lib/llm/index.ts`'s
> `callThroughResilience` still passed the attempt-1 abort (`kind: 'retryable'`, `timeout: true`)
> through `withRetry`'s default 3-attempt predicate, so one delivery could execute the 900 s cap
> three times under the 930 s lease that the paragraph directly below says closed the double-execution hazard — the
> lease fix bounded one `execute()`; it did not bound the retry loop around it. The
> `"LLM call failed, retrying" attempt 2 maxAttempts 3 … timed out` log line in §5 is that loop.
> Fixed by making a `timeout: true` `ProviderError` escape `withRetry` on its first throw
> (`isRetryableInProcess`, `src/lib/llm/index.ts`).

**The part that was a bug rather than a feature:** `claim.ts`'s `LEASE_MS` was
`EVALUATION_MODEL_TIMEOUT_MS + 30s` = 330 s. A 15-minute call under a 330 s lease is **reclaimed by
the reaper mid-flight and executed twice.** `LEASE_MS` now derives from the hard cap (930 s), and two
further deadline sites carrying the same hazard were fixed with it.

This matters beyond this release because of the shortcut it forecloses. The cheap-looking alternative
— *just set `EVALUATION_MODEL_TIMEOUT_MS=900000` in the manifest and skip the promote* — happens to
avoid the double-execution by accident, since `LEASE_MS` is derived from that same variable. But it
is one edit away from disaster on any older image, it forfeits the 5-minute alert and the
two-attempt policy, and it silently arms the reaper against anyone who later tunes the two numbers
independently.

### 5.3 The fix shipped into ONE of three seams, and the alert it produced is what caught it

Within minutes of the promote the 5-minute warning fired on the live run, exactly on time:

```
"5 minutes elapsed with no response from judge \"granite4.2:3b\". This is the first judgment
 for this judge, so there is no latency baseline to compare it against. CONFIRM MODEL ACCESS —
 waiting 10 minutes more before aborting at the 15 minutes hard cap."
 elapsedMs 300000  hardCapMs 900000  remainingMs 600000  baselineKind no_baseline
```

**It was wrong.** granite4.2:3b had **26 completed judgments** in the same database. The alert stated
the opposite of the truth in the one sentence whose entire job is to tell an operator whether to
worry.

`judgment-consumer.ts` has **three** provider seams — pointwise, pairwise, respond — and
`sha-414e826a3ba3` wired the escalation into pointwise only. **Calibration is pairwise**, so the path
the feature was requested for was the one path it never reached.

**Why nothing caught it.** `execute()` arms its own timers from `resolveTimeoutBudgets()`
unconditionally, so the hard cap still aborted and the 5-minute alert still fired. Nothing threw,
nothing logged a warning, and the feature looked live in production logs. What was silently dropped
was the *context*, and each omission degrades differently:

| dropped | consequence |
|---|---|
| `attempt` → defaults to 1 | `hardCapAbortKind(1)` returns `retryable` **forever**. "Two 15-minute attempts, then give up" was **not enforced** on the calibration path. |
| `latencyBaseline` | the alert claims "first judgment for this judge" against 26 of them. |
| `onInitialBudgetElapsed` | the alert never reaches the running process — the half of the request that was actually novel. |

Only the first is a behaviour defect; the other two are honesty defects. All three were invisible
without reading the alert's own claim against the database.

**Fixed in `60be6f6`:** one `buildTimeoutEscalation(judgment, version)` that every seam calls, and
`TimeoutEscalationContext` re-exported from the `@/lib/llm` barrel — a type reachable only by deep
import is a type a seam will quietly omit. `tests/lib/judgment-consumer-escalation.test.ts` asserts
the invariant **per seam, named per seam**, because a test exercising only the pointwise path would
have passed against the bug. Verified by re-injection: removing the pairwise wiring turns four tests
red and leaves pointwise green.

> **The generalisable part.** A feature spread across N sibling call sites, where the shared machinery
> downstream still half-works without it, produces exactly this: a partial rollout that looks
> complete. The seam count is the thing to check, and `grep -c` on the constructor is the check.

### 5.4 12288 IS STILL NOT ENOUGH — the constraint moved again

With the escalation live, the first long item ran **528.6 s** — 1.76× past the old 300 s wall, so the
new policy demonstrably worked — and then failed anyway:

```
Provider call to "ollama" (granite4.2:3b) was CUT OFF at the token budget
(finish_reason "length"): max_tokens 12288, completion_tokens 12288
```

**granite4.2:3b exhausts a 12288-token budget on this set.** Two things follow, and the second is the
harder one:

1. Its effective rate on long generations is ~23 tok/s, not the ~35 tok/s the shorter completions
   suggested — generation slows as context grows, so §2.1's linear model is optimistic at the tail
   and should be read as a lower bound on duration.
2. **The Ollama server's context is 16384 total**, and the prompt is ~2,072 tokens. So the largest
   budget that fits is ~14,000, which at 23 tok/s is ~609 s — inside the 900 s cap, but only just,
   and it may still not be enough for the worst items.

So the ceiling here is no longer time and no longer the token budget in isolation: it is **the
server's context window**. A judge that wants more reasoning than its own context can hold is not
mis-configured, it is unsuitable at that context size. That is a legitimate finding about the model,
not a defect to engineer around, and it is the first time the fleet has produced one.

#### 5.4.1 tok/s is NOT constant — it decays with output length, and that sets the real ceiling

§2.1's `max_tokens / tok_per_s` treats throughput as flat. Measured on this run, it is not:

| output tokens | 4567 | 5062 | 6808 | 7305 | 8205 | 12288 |
|---|---|---|---|---|---|---|
| **tok/s** | 35.9 | 35.2 | 32.8 | 29.2 | 31.1 | **23.2** |
| latency | 127 s | 144 s | 208 s | 250 s | 264 s | 529 s |

Attention cost grows with sequence length, so a longer generation is slower *per token* as well as
longer. **The consequence is that duration grows super-linearly in the budget**, and the naive
`budget / mean_rate` estimate understates the tail badly: at 12288 tokens the flat 35 tok/s model
predicts 351 s and the real answer was 529 s — off by 51%.

**So the binding constraint is the HARD CAP, not the context window.** Extrapolating the decay, a
900 s cap at ~19–20 tok/s buys roughly **16,000 output tokens**; beyond that the call is aborted
before the context is exhausted. With a max observed prompt of 3,074 tokens on this set:

| setting | value | why |
|---|---|---|
| `num_ctx` | 24576 | 3,074 prompt + ~16,000 output + headroom. |
| `max_tokens` | ~16384 | the most that can finish inside the 900 s hard cap. |

**Raising `num_ctx` beyond ~20k buys nothing on this hardware** — the clock binds first.

> ### ⛔ THE TABLE ABOVE IS SUPERSEDED FOR granite4.2:3b. DO NOT ACT ON IT.
>
> It was written while the run was still draining, on the assumption that the failures were ordinary
> truncation — a model that wanted more room than it had. **§5.4.2 shows they are not.** The five
> failed items were in a degenerate repetition loop, and a larger budget buys a longer loop at more
> wall-clock, not a verdict. The arithmetic in this section is still correct *as arithmetic*; the
> recommendation it produces is answering the wrong question.
>
> It is kept rather than deleted because the reasoning error is the instructive part: a token budget
> is the obvious lever when `finish_reason` is `length`, and the error message says so in as many
> words. Reaching for it without checking **why** the output was long is how you spend an hour making
> a loop longer.

---

### 5.4.2 IT WAS NOT TRUNCATION. IT WAS A REPETITION LOOP — and the error message gives the wrong fix

The final report closed the question the two sections above were circling. All five failures:

```
finishReason=length  out=12288  content length 0 chars  reasoning 26,549–56,004 chars
```

**Zero content, and up to 56,000 characters of reasoning** — against a mean of 13,138 for the
judgments that finished. Reading into one of them at offset 40,000:

```
"the person who likes chess" refers to the person whose hobby is chess; "the person who likes
rock-climbing" refers to the person whose hobby is rock-climbing; "the person who likes collecting"
refers to the person whose hobby is collecting; "the person who likes traveling" refers to …
```

It is cycling one clause verbatim, forever.

**Measured rather than eyeballed, across all five.** Repetitive text compresses far better than
prose, and `pg_column_size()` already reports the pglz-compressed on-disk size — the same tool §4.2
of the baseline spec used for the storage footprint:

| | n | mean chars | mean stored | **compression ratio** |
|---|---|---|---|---|
| completed | 25 | 13,138 | 4,676 | **2.63×** — ordinary prose |
| failed | 5 | 44,287 | 8,040 | **8.23×** — 3.1× more compressible |

8.23× is not a long answer. It is a loop, and it is all five of them, not the one that was sampled.

#### Why this matters more than the score

**The error message's advice is wrong for this case, and it is stated with total confidence:**

```
A response cut off mid-reasoning is not a completed judgment — raise samplingDefaults.max_tokens
on the JudgeModelVersion for this judge.
```

That is correct when a model *needed more room*. Here it would buy a longer loop at more wall-clock:
these five already consumed **41 of the run's 82 minutes** — half the total compute for zero
verdicts — and a 16k budget would push that toward an hour for the same nothing. `finish_reason:
length` is genuinely ambiguous between "ran out of room" and "never going to stop", and the guard
currently assumes the first.

**The distinguishing signal is cheap and already computed.** A compression ratio above ~5×, or
`content length 0` after tens of thousands of reasoning characters, separates the two cases without
a second model call. The message could then say *"this looks like degenerate repetition; raising
max_tokens will make it worse — try a repetition penalty or a different judge"* — which is
actionable, where the current text is actively misleading.

~~Recorded as a follow-up rather than fixed here: it is a guard change on the `execute()` chokepoint
and wants its own test, not a drive-by edit during a calibration.~~ **Shipped in `a272519` (2026-09-01):**
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

#### What it says about the judge

`granite4.2:3b` enters degenerate repetition on **17% of this set** (5 of 30). That is a property of
the model at these sampling settings (`temperature: 0.3`, no repetition penalty), not of the budget.
The remedies are a repetition/presence penalty or a different judge — **not** a bigger context.

---

### 5.4.3 Are the truncated items HARDER? Measured, and the obvious answer is wrong

Truncation is not random — it hits the items that make the judge reason longest. The tempting next
step is to conclude that the surviving accuracy is **inflated by survivorship**, because the dropped
items were the hard ones. That conclusion is available, plausible, and **not supported by the data**.

The test: take the items granite4.2 truncated, and look at how the *other* judge did on those same
items. Qwen scored all 30, so it is a clean control.

| granite4.2 outcome | items | Qwen accuracy on the same items | Qwen mean output tokens |
|---|---|---|---|
| completed | 25 | 0.8400 | 2,610 |
| **truncated** | 4 | **1.0000** | **4,564** (+75%) |

Two different readings, and only one survives scrutiny:

1. **These items genuinely demand more reasoning — supported.** Qwen spent 75% more output tokens on
   exactly the items granite4.2 could not finish. That signal reproduces across two unrelated models
   on the same inputs, which is what makes it credible rather than a property of one judge.
2. **These items are harder to get RIGHT — not supported, and not refuted.** Qwen went 4-for-4. It is
   tempting to read that as "they were easy", but with n = 4 and Qwen's base rate of 0.84,
   P(4 of 4 correct) = 0.84⁴ ≈ 0.50. **A coin flip.** The observation carries essentially no
   information about difficulty.

**So do not adjust granite4.2's score for survivorship in either direction.** What can be said is
narrow and useful: the dropped items are *verbosity-demanding*, which is a statement about token
budget, and nothing at this sample size is a statement about difficulty. "Length of reasoning" and
"hardness of item" are separate axes, and this set does not yet have the power to relate them.

> Worth generalising, because a leaderboard over hundreds of models will meet this constantly: a
> partial run's denominator is not a random sample of the set, so *some* bias is a live possibility
> every time. The move is to check it against a judge that completed the set — not to assume its
> direction from the mechanism. Here the mechanism suggested inflation and the measurement declined
> to confirm it.

---

## 5.5 CI reported SUCCESS on a build that was OOM-killed, and nothing else would have caught it

> **CORRECTION (2026-09-01).** Same day. The heading and the interpretation below are wrong; the
> quoted log is exact. The build was not OOM-killed — the run was **cancelled by the next push**.
> Gitea 1.23.6 calls `CancelPreviousJobs(repo, ref, workflow, event)` on every push to the same ref
> before inserting the new run (`services/actions/notifier_helper.go`); `7f0e0cb` was authored at
> 15:41:44Z and the kill landed at 15:42:12Z. act v0.261.10 emits `this step has been cancelled: %w`
> only inside `select { case <-ctx.Done(): … }` (`pkg/container/host_environment.go`) — a kernel
> OOM does not close `ctx.Done()` — and its `job_executor.go` then replaces the cancelled context
> with a fresh `context.Background()` that carries no job-error container, so `JobError()` is nil
> and `🏁 Job succeeded` is logged. **Only the runner pod log says that.** Gitea ignored the report
> (the task was already Done) and its record for `60be6f6` is task 4816 `cancelled`, run 51, all
> three commit statuses "Has been cancelled". The runner container: `restartCount 0`, no
> `OOMKilled`, same pod since 15:27:13Z. And the identical signature recurred at 15:56:32Z on task
> 4818 — `7f0e0cb`, job `db-tests`, step "Wait for the DB-test Job", a kubectl polling loop with no
> Node process — 8 s after `d21f31d` was authored; that rules out memory without any argument about
> Next.js. `2c1e85e` and `740e7bb` have no image because they were never the head of a push (runs
> 50-55 are exactly 414e826, 60be6f6, 7f0e0cb, d21f31d, ba237bd, fc9e936). "Passed again on retry"
> is also wrong: `d21f31d` was a new push whose run was not cancelled; `60be6f6` was never rebuilt.
> The CPU-count paragraph is true in general and irrelevant here — and Next 15.5.22 strips
> `--max-old-space-size` from its static workers (`isolatedMemory: true`), so `NODE_OPTIONS` never
> bounded them anyway. Neither the runner's 4Gi nor `NODE_OPTIONS` should be retuned on this
> evidence. What is right below: nothing watches pushed-not-built, `BuildPromoteLag` is the wrong
> shape, and the family resemblance to `e4b9948`. The fix table at the end is replaced.

Observed 2026-09-01 while trying to promote the §5.3 fix. The runner log, verbatim:

```
✅ Success - Main Lint
✅ Success - Main Type check
✅ Success - Main Unit tests (+ coverage gate)
⭐ Run Main Build
   ✓ Compiled successfully in 16.3s
   ⚠ Using edge runtime on a page currently disables static generation for that page
   ❌  Failure - Main Build
   this step has been cancelled: signal: killed
🏁  Job succeeded
```

`next build` was killed during **static generation** — the memory-heavy phase — against the Gitea
runner's `limits.memory: 4Gi`. **The job then reported success.** No image reached Harbor.

**Which safeguard should have caught this, and why didn't it?** Two, and they fail in opposite
directions:

1. **CI's own job status.** It is the safeguard, and it reported green on a step it had itself
   marked `❌ Failure`. A green run that produced no artifact is worse than a red one, because the
   next reader concludes "built, just waiting on Harbor" — which is precisely what happened here for
   twenty minutes.
2. **`BuildPromoteLag`** would have flagged an image that built and was never promoted — but
   judge-arena carries `homelab.asethi.com/build-lag-exclude: "manual-promote-until-phase-2"` in
   `helmrelease.yaml:152`, so it is outside that coverage entirely. And it is the wrong shape anyway:
   it watches *built-not-promoted*, and this failure is *pushed-not-built*. **Nothing watches the gap
   between a commit on `main` and an image in Harbor.**

**It is marginal, not systematic**, which is what makes it dangerous. The identical build passed 70
minutes earlier for `414e826` and passed again on retry as `sha-d21f31d47c35`. `gitea-runner-0` had
been recreated onto `w-gharial` (16 cores) at 15:27; Next.js forks static-generation workers in
proportion to CPU count, so peak build memory is a function of **which node the runner lands on** —
not of the diff. A build that fails on one scheduling outcome and passes on the next will be
diagnosed as "flaky CI" and retried until green, and the false-green means it may not even be
noticed.

**This is the third instance of the same family in this repo.** `e4b9948`'s image never built
because `.dockerignore` excluded `scripts/**`, and Harbor silently stayed on the previous tag; the
chart-version no-op in homelab's CLAUDE.md is the same shape one layer up. The invariant worth
enforcing is small and mechanical: **after any push to `main`, assert that a tag matching the commit
SHA exists in Harbor.** One `skopeo inspect`, and it closes all three.

What was done (2026-09-01; replaces the table that stood here — *"make the job fail when a step
fails"* / *"raise the runner limit, or bound Next's build workers"* — both of which addressed things
that had not happened, per the correction at the top of this section):

| change | what it addresses |
|---|---|
| `scripts/ci/ci-status.sh <sha>` — `actions/tasks` + `commits/<sha>/status` (no token), then Harbor | the reading rule: Gitea's record, never the runner pod log. Exit 2 = never ran (not the head of a push); exit 1 = ran, no image. **Run before every promote.** |
| `scripts/ci/assert-harbor-tag.sh` + the `Assert Harbor has sha-<12>` step in `build-push`, printing `IMAGE_PUBLISHED repo=… tag=… digest=…` | kaniko-said-Complete-but-registry-empty (never observed; cheap). Cannot fire for a cancelled run. |
| `ci.yml` comments: `CancelPreviousJobs` mechanism; `concurrency:` inert on 1.23.6; `if: always()` reap step does not run after a cancel | the next reader of a `signal: killed` / `Job succeeded` pair |
| **not done, out of repo:** an out-of-band pushed-not-built exporter (Gitea `main` HEAD vs Harbor tags) | the only shape that would have caught `60be6f6` |

---

## 6. Adding the next model — the short version

1. **Point at the endpoint and register.** `--max-tokens=` is the field to think about; the rest is
   mechanical. See [`docs/runbooks/scoring-a-judge-against-a-golden-set.md`](../../runbooks/scoring-a-judge-against-a-golden-set.md) §1.
2. **Score one item first** and read `outputTokens` and `latencyMs`. That gives tok/s.
3. **Do the §2.1 arithmetic.** `max_tokens / tok_per_s` must fit under 900 s. If it does not, the
   budget is unreachable on this hardware and the run will fail at the tail, not at the start.
4. **Size `--poll-timeout` from the envelope**, not from a guess: `items × mean_latency × 1.5`.
5. **Launch, and do not launch a second calibration against the same server while it drains** —
   they share a lane and the reaper's deadline is a bound, not a guarantee (runbook §8.4).
6. **Read `missingVerdicts` before reading accuracy.** Non-zero means the accuracy has a smaller
   denominator than the set, and may mean the run is void (§3.3).

**What parallelises and what does not:** lanes key on the normalized endpoint *origin*, so two models
on one Ollama host share a lane and run strictly serially; a model on its own box gets its own lane.
Registering 300 models against one server does not make them faster — it makes a 300-deep queue.
Capacity is a property of the fleet, not of the scoreboard.

---

## 7. What this record does not establish

- **30 items is a small set.** A one-item difference moves accuracy by 0.033. Every gap in §1 smaller
  than ~0.10 should be treated as directional. The 12288-vs-8192 Qwen result is one item.
- **One rubric, one protocol.** Everything here is pairwise under General Quality Assessment. Nothing
  is known about pointwise, or about how these judges rank under a different rubric.
- **No cross-set evidence.** Every run shares one frozen golden set, so nothing here distinguishes
  "this judge is good" from "this judge suits this set". That is the next thing worth buying.
- **Anthropic judges are registered and unscored.** Claude Opus 4.5, Sonnet 4.5 and Sonnet 4.6 exist
  as `trusted` versions with no calibration run. The scoreboard has no frontier reference line, which
  makes the local numbers hard to place.
- **Reasoning-token capture is still partial.** `reasoningTokens` is NULL for llama.cpp, and
  `parseMode` is NULL on pairwise; both are open and recorded in the baseline spec §5.
