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
| 9 | `cmtircx0x` | granite4.2:3b | ollama | **12288** | *pending* | | | 0 | in flight — see §5 |

**Reference lines for reading that column:**

| baseline | accuracy | κ | why it matters |
|---|---|---|---|
| always `A>B` (the degenerate judge) | **0.5667** | 0.0000 | 17/30. The real floor. |
| always `B>A` | 0.4333 | 0.0000 | 13/30. |
| uniform coin flip | ~0.5000 | ~0.0000 | what "0.50" *looks* like but is not. |

`granite4.1:3b` scoring **0.5000 is worse than a constant stamp**, and its κ of 0.1296 says it is
not *quite* degenerate — it has a faint signal and spends it badly. §3.2 shows exactly how.

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
