# Calibration baseline and storage footprint — 2026-08-31

**What this is.** The durable record of the first two calibration runs this product ever executed,
the storage measurement taken because of them, and the two rules that changed as a result
(concurrency, and Ollama's judge eligibility). It exists because all of it was learned in one
session against a live judge server and a live database, and none of it is re-derivable later: the
golden set is now frozen, the servers get restarted with different flags, and a number without its
denominator and its method attached decays into folklore within a week.

**Scope.** This is a *record*, not a design. The design decisions it depends on live in
`docs/superpowers/specs/2026-08-17-a2-calibration-and-reporting-decisions.md`; the shipped state and
the ordering of what comes next live in `docs/superpowers/plans/2026-08-30-state-and-next-steps.md`;
the operational path is `docs/runbooks/scoring-a-judge-against-a-golden-set.md`.

**Provenance.** Numbers here come from three places and each claim says which: (a) the calibration
runner's own printed output, (b) read-only `psql` against production `judge-arena-pg-1`, recorded
verbatim in README's *Calibration* section and the plan's §7.2, (c) a `pg_column_size` measurement
run for the footprint exercise. Where two sources disagree, **both are printed and the disagreement
is named** rather than resolved by preference — see §2.4 and §3.4.

---

> **SUPERSEDED IN PART, 2026-09-01.** The method, the storage numbers and the concurrency lesson
> below all stand. What has moved is the *result set*: three judge models have now been scored across
> nine runs, and the baseline named in §1 is no longer the best recorded number. The running ledger,
> the per-model throughput envelopes, and two traps this document could not have known about —
> `CalibrationRun` not snapshotting the sampling config, and `max_tokens`/timeout being **stacked**
> limits — are in
> [`2026-09-01-judge-scoreboard-and-model-envelopes.md`](./2026-09-01-judge-scoreboard-and-model-envelopes.md).
> Read §1 below as the first careful measurement, not as the current standing.

## 0. If you read one thing

> **Qwen3.6-35B-A3B scores 0.8333 accuracy — 25 of 30 — against `JudgeBenchSample — 30 random`,
> with Cohen's kappa 0.6575.** That is the baseline. It comes from `CalibrationRun`
> `cmthr58r100013s0sykuvn41x`, which completed **all thirty** items with zero errors and zero
> dead-letters.
>
> **There is an earlier, higher number, and it is worse.** Run 1 reported **0.8462 — 22 of 26** —
> because four items never got a verdict. A higher score over a smaller, self-selected subset is
> not a better result; it is a weaker claim about a different population. Quote 0.8333/30, always
> with the denominator.

---

## 1. THE BASELINE — run 2, `cmthr58r100013s0sykuvn41x`

### 1.1 What was measured, against what

| | |
|---|---|
| Judge | **Qwen3.6-35B-A3B** — `Qwen3.6-35B-A3B-UD-Q3_K_XL.gguf`, `llamacpp` backend, self-hosted at `192.168.1.164:8001` |
| Sampling | `max_tokens 8192`, `temperature 0.3` |
| Golden set | `cmt057hd001g17y01lhjzgfuj` — *JudgeBenchSample — 30 random*, **30 pairwise items** |
| Ground truth | **17 `A>B` / 13 `B>A`, no ties** — a property of the set, fixed at freeze |
| Protocol | pairwise, `pairOrder` `AB` only (the B/A position sweep is a later phase) |
| Concurrency | **sequential** — one judgment in flight, enforced by `src/worker/concurrency.ts`'s hard cap |

### 1.2 The result

```
ACCURACY   0.8333   (25/30 items with a verdict)
kappa      0.6575   method cohen / weighting none
itemCount  30       missingVerdicts 0

raw verdict distribution      confusion [expected][judged]
  A     18                      A>B  ->  A>B:15   B>A:2
  B     12                      B>A  ->  A>B:3    B>A:10
  tie    0
```

**Every one of those numbers is checkable against the others, and that is the point of printing all
of them.** 15 + 2 = 17 and 3 + 10 = 13 reproduce the key's marginal; 15 + 3 = 18 and 2 + 10 = 12
reproduce the verdict distribution; 15 + 10 = 25 correct over 30 items is 0.8333 exactly. A report
where these do not reconcile is a report with a bug in it — which is precisely how run 1's
`missingVerdicts 0` was caught sitting under a denominator that said 26 (commit `cb2fc37`).

### 1.3 Capture, completeness and cost

| | |
|---|---|
| Wall clock | **21 m 53 s** for 30 items |
| Latency | **avg 42.6 s**, min **16.1 s**, max **95.1 s** |
| Errors / dead-letters | **0 / 0**; all 30 judgments reached `completed` |
| Capture at 30/30 | `systemPrompt`, `userPrompt`, `userPromptSha256`, `rawResponse`, `reasoning`, `reasoningContent` (avg **8,342 chars**), `inputTokens`, `outputTokens`, `servedModelId`, `finishReason` |
| Capture at 0/30 | `reasoningTokens` — see §5 |

**Derived, and worth deriving:** 30 × 42.6 s = 1,278 s of in-model time against 1,313 s of wall
clock — **~97%**. That ratio is what "sequential" looks like from the outside, and it is the
observational proof that the cap did what §4 claims: there is almost no queue, no overlap and
nowhere for a request to wait. Run 1 cannot produce this ratio, because with 8 in flight the wall
clock and the summed latency describe different things.

**This is the first latency figure in this product that means generation time.** At concurrency 1
there is no in-server queue for `latencyMs` to absorb (`latencyMs` is wall time around the HTTP
call — `src/lib/llm/openai-compatible.ts:249`, `Date.now() - startTime` spanning the SDK request).
Use 42.6 s when sizing timeouts and poll windows. See §3.4 before quoting any run-1 latency.

### 1.4 ACCURACY IS PRIMARY. Kappa is a labelled secondary.

`thresholdMetric` is written as `'accuracy'`, and the ordering is an argument, not a taste:

1. **Ground truth is an answer key, not a peer rater.** Cohen's kappa chance-corrects on *both*
   raters' marginals, which presumes two annotators who could each have been wrong. The key is not
   one of those. Its marginal (17/13) is a property of the **set**, fixed the moment the set froze,
   so discounting a judge's hits against it treats a constant as a source of chance. That is a
   category error, not a conservative choice.
2. **Kappa is not comparable across sets, and cross-set comparison is the one thing a leaderboard
   does.** `pe` depends on the key's class balance, so the same judge with the same hit rate scores
   a different kappa on a 17/13 set than on a 15/15 one. A column that cannot be sorted is not a
   leaderboard column.

**Kappa is stored anyway, and it earns its place**, because accuracy alone cannot tell a judge that
learned something from one that answers `A>B` every time: on this set the degenerate judge scores
**0.5667** accuracy — "better than chance" to the naked eye — and **0.0000** kappa. They fail in
opposite directions, so both are stored. `kappaVariant`/`kappaWeighting` record the method, because
a kappa with no stated method is uncheckable a year later.

**A2 wrote no statistics code.** `src/lib/agreement.ts` is reused unchanged — `raterId` is opaque to
it, so `'ground-truth'` is just another rater, the same trick the human `label-readings` path
already uses for `'round-1'`/`'round-2'`. A `tie` counts as a **miss** (the corpus has no ties, so
no item a tie could be right about; crediting it would let a judge raise its score by refusing to
answer), and an incomplete judgment is **not** a wrong answer — only `status: 'completed'` rows are
loaded, which is why an in-flight calibration scores what it has instead of improving as the queue
drains.

---

## 2. THE TWO RUNS SIDE BY SIDE — the comparison *is* the lesson

### 2.1 The table

| | **RUN 1** `cmtgib0xr00016k2r8nlyj1py` | **RUN 2** `cmthr58r100013s0sykuvn41x` |
|---|---|---|
| Concurrency | **8 in flight** (the bug) | **1 — sequential** |
| Accuracy | **0.8462** | **0.8333** |
| Denominator | **22 of 26** — four items never judged | **25 of 30** — the whole set |
| Kappa | 0.6950 | 0.6575 |
| Verdicts | A=15 B=10 tie=1 (26) | A=18 B=12 tie=0 (30) |
| Dead-lettered | **4**, `timed out after 300000ms` | **0** |
| Errors | 4 judgments (5 runs — see §2.3) | **0** |
| Latency | see §3.4 — contested | avg 42.6 s / min 16.1 s / max 95.1 s |
| Usable as a baseline? | **No** | **Yes** |

### 2.2 THE HIGHER NUMBER IS THE WORSE RESULT. Say it out loud.

> **0.8462 over 26 items is a weaker claim than 0.8333 over 30, and it is weaker in a direction
> that flatters the judge.** The four missing items are **not a random sample**. They are the four
> that happened to queue longest inside the inference server — selected by *our* configuration,
> correlated with whatever makes a request slow (longer candidates, longer reasoning), and dropped
> by a timeout rather than by a coin flip. A subset chosen by "which requests were still waiting
> when the clock ran out" is self-selected, and nothing in the accuracy figure records that.

The failure mode this protects against is social, not numerical: 0.8462 is the number that gets
copied into a slide, and it is 1.5 points higher than the honest one. Reporting a partial run at
all is defensible; reporting it **without its denominator in the same sentence** is not. That is why
the runner prints `ACCURACY 0.8333 (25/30 items with a verdict)` as one string and why
`missingVerdicts` is printed directly beneath it — and why `cb2fc37` exists, because the first
version of that report printed `missingVerdicts 0` while four items had dead-lettered.

**Nor is the kappa comparison meaningful between these two rows.** 0.6950 and 0.6575 are computed
over different item populations with different realised marginals. The drop is not evidence that the
judge got worse; it is evidence that the two numbers are not the same measurement (see §1.4.2).

### 2.3 A discrepancy anyone re-querying run 1 will hit

Five `EvaluationRun` rows carry `status='error'` while only **four** `ModelJudgment` rows do. Run
`a0983c08-4548-4663-a40d-0cd56b82f765` is stamped `error` at run grain while its judgment
**completed** on a later attempt (`verdict=B`, `latencyMs=108646`). Scoring reads the **judgment**,
so that item is inside the 26. **Count judgments, not runs.** The stale run-grain status is a real
defect and is listed as an open follow-up in the plan.

### 2.4 CORRECTION — the 26-item denominator, and a number in the source brief that does not reconcile

The 2026-08-31 ground-truth brief records run 1 as *"accuracy 0.8462 over 24/26"*. **Those two
figures cannot both be right:** 24 ÷ 26 = 0.9231. The value stored in production is
`rawAgreement = 0.8461538461538461`, and 0.8461538… × 26 = **22** exactly, which is what README's
*Calibration* table and the plan's §7.2 both record ("**22 of 26**", read back from
`judge-arena-pg-1`).

> **Recorded as: 22 correct of 26 judged, of 30 in the set.** The "24" is a transcription error in
> the brief and is corrected here rather than silently dropped, because someone will read that brief
> again. The *denominator* (26 = 30 − 4 dead-lettered) is corroborated three ways: `verdictCount 26`
> in the row, the verdict distribution summing to 26, and the four DLQ'd items.

---

## 3. THE CONCURRENCY LESSON

### 3.1 Prefetch **is** the concurrency limit

The worker's `dispatch` starts a handler **per delivered message**. There is no pool in between, no
semaphore, nothing that holds a message while another finishes. So AMQP prefetch is not a buffer
that smooths delivery — it is the number of judgments that can be executing at once, exactly.

The old code computed `prefetch = concurrency × 4`. With `EVALUATION_MODEL_CONCURRENCY_PER_RUN=2`
that is **8 concurrent provider calls**, against a llama.cpp server advertising **`total_slots: 2`**.
Six of the eight were therefore *inside the inference server's queue* while their 300 s client
timeout ran.

### 3.2 What over-subscription actually does

> **Over-subscribing converts a queue you can see into a queue you cannot see, and then times out
> against it.** RabbitMQ's queue is observable: depth, consumer count, age, all of it on a
> dashboard. The inference server's slot queue is not — from the client every request looks like one
> slow HTTP call. Pushing work past the server's slot count does not increase throughput (the slots
> are the throughput); it *moves the backlog* from the instrumented queue into the uninstrumented
> one, where the only signal it produces is a timeout that looks exactly like a slow model.

That is why the four failures read `Provider call to "llamacpp" (...) timed out after 300000ms` and
were initially discussed as if the model were too slow. It was not. **The cause was configuration**,
and the evidence is run 2: identical judge, identical set, identical prompts, zero timeouts, and a
mean latency of 42.6 s — a sixth of the ceiling that had been "exceeded".

### 3.3 The fix, and why it is a clamp rather than a tuned number

`src/worker/concurrency.ts` clamps `EVALUATION_MODEL_CONCURRENCY_PER_RUN` (1–16) to
`HARD_CONCURRENCY_CAP = 1` and sets AMQP prefetch to 1. Asking for more is **not** an error and does
not fail the boot; the clamp is logged at `warn` with requested and effective values, because it
must be silent to the configuration and loud to an operator.

**Why 1 and not "match the slot count":** the worker cannot know the slot count. It is a property of
whichever endpoint each `JudgeModelVersion` points at — invisible from the worker, different per
endpoint, and free to change the next time somebody restarts a server with different flags. One
global number applied to a fleet of heterogeneous endpoints was wrong even before it was multiplied
by four. Sequential execution is also what makes a latency baseline reproducible at all (§1.3).

> **THE ENV VAR IS NO LONGER A CONTROL AND THE MANIFEST STILL LOOKS LIKE ONE.** The Deployment sets
> `EVALUATION_MODEL_CONCURRENCY_PER_RUN=2`; the worker runs at 1. Read the `judge worker started`
> log line's `concurrency` field, not the manifest.

**Raising the cap is not the eventual fix. Per-endpoint concurrency is** — a limit that knows which
server it is talking to. That work is in flight; see the plan's follow-up list.

### 3.4 CONTESTED — run 1's average latency. Do not quote either figure bare.

Two measurements of the same run disagree by ~2.5×:

| Source | Figure |
|---|---|
| Ground-truth brief, and `src/worker/concurrency.ts`'s comment / `1e7a427`'s commit message | **94.4 s average** |
| Read-only production query over run 1's 26 completed judgments (README *Calibration*, plan §7.2) | **avg 232,917 ms, median 265,372 ms, max 299,063 ms** (n=26) |

The stored figure has a re-runnable query attached; the 94 s figure does not, and no source in the
tree says what it was measured with. **They are not necessarily contradictory** — `latencyMs` spans
the whole HTTP call and therefore *includes* time queued inside the inference server, so 94 s could
be generation time observed elsewhere. **It is not recoverable from this database:** nothing in
these rows separates generation from queue wait.

> **Treat 94.4 s as UNVERIFIED. Do not carry 233 s forward either** — it is an artefact of the very
> over-subscription being described. **Run 2's 42.6 s is the latency baseline** (§1.3). The maximum
> is the part worth remembering: **299,063 ms, 937 ms under the 300,000 ms timeout.** Run 1 was not
> "four unlucky items"; it was 26 of 30 finishing within a second of the wall, and the same
> configuration on a slower day loses most of the set.

---

## 4. STORAGE FOOTPRINT

### 4.1 The method, and why `length()` would have been wrong

Measured with **`pg_column_size()`**, not `length()`. `length()` counts characters in the *logical*
value; `pg_column_size()` reports the bytes Postgres actually stores for that datum, **after** TOAST
compression and including the varlena header. For rows whose bulk is compressible model text those
answers differ by nearly 2×, and the projection would have been almost twice the truth.

### 4.2 What was measured

| | |
|---|---|
| Completed judgment | **8.69 KiB** |
| Per **(model × item)**, all-in | **13.36 KiB** — includes the `Evaluation` + `EvaluationRun` + **2** `RunCandidate` rows each item creates |
| Compression | **1.94×** on judgment text; **1.68×** end-to-end |
| Out-of-line columns | only three: `reasoningContent`, `userPrompt`, `systemPrompt` |
| Stored raw | `rawResponse` and `reasoning` (~590 B) sit **below the ~2 KB TOAST threshold**, so they are never compressed — ratio **0.99** |
| `criteriaScores` | **NULL on every pairwise row** — excluded from projections |
| FAILED judgment | **~450 B**, not 8.69 KiB — error text only, no prompts |

**The all-in unit is (model × item), not "a judgment".** A judgment does not arrive alone; the four
surrounding rows are ~54% on top of it. Sizing from 8.69 KiB would under-count by a third.

**A failure is nearly free, and that cuts both ways.** ~450 B means a run that fails wholesale costs
nothing to keep — but it also means storage growth tracks *successes*, so a healthy fleet is the
expensive case. Do not reassure yourself with a footprint measured during an outage.

### 4.3 Projections, and what dominates the uncertainty

| Fleet | Footprint |
|---|---|
| 100 models × 620 items | **825 MiB** |
| 500 models × 620 items | **4.03 GiB** |
| **10 GiB volume fills at** | **~990 models** against the 620-item set (band **825–1,125**) |
| | **~20,800 models** against the 30-item set |

> **The dominant uncertainty is the JUDGE, not the item set.** `reasoningContent` is **24.3%** of
> the per-item cost and varies **3.3×** within a single model. Extrapolating 30 → 620 items is safe
> to **~2%** (candidate text sizes match closely between the two sets) — so the item axis is nearly
> free of risk and the *model* axis carries all of it. A verbose reasoning model can move the total
> by more than tripling the corpus would.

**One thing that does not reconcile exactly, recorded rather than smoothed.** 825 MiB ÷ 620 ÷ 100
implies ~13.6 KiB per (model × item) against the 13.36 KiB measured in §4.2, and a naive
10 GiB ÷ 13.6 KiB ÷ 620 gives ~1,240 models rather than ~990. The projections evidently carry
overhead and headroom (indexes, WAL, bloat) that the per-row measurement does not, which is also
what the stated 825–1,125 band expresses. **Plan against ~990** — the conservative figure — and do
not re-derive a fill point from the per-item number alone.

### 4.4 The conclusion: BUILD NO MITIGATION

> **Hundreds of judges against the 620-item set is comfortably viable on the existing 10 GiB volume.
> Do not build truncation, tiering, external blob storage, a retention policy, or a "prune old
> reasoning" job.** At the fleet sizes this product plausibly reaches, the footprint is not a
> problem, and every one of those mitigations trades away the thing the capture exists for: being
> able to read *why* a judge was wrong, a year later, from the row itself.

This closes the "N judges × M items × uncapped model text against a single-instance Postgres" risk
that the roadmap deferred and that A2.1's §7.4 deliberately refused to estimate from a per-row
average. It is now measured, and the answer is that it does not need solving. **Revisit only if** a
judge's `reasoningContent` mean moves well past the 8,342 chars observed here, or the item set grows
by an order of magnitude, or the volume stops being 10 GiB.

---

## 5. CAPTURE COMPLETENESS, AND TWO HONEST GAPS

`ModelJudgment` stores `systemPrompt`, `userPrompt`, `userPromptSha256`, `promptTruncated`,
`rawResponse`, `reasoning`, `reasoningContent`, `reasoningSource`, `reasoningTokens`. On run 2 every
one of the fields the runner checks came back **30/30** except one.

**The rendered prompt is STORED, not reconstructed, and the reason is a live defect elsewhere.**
`PATCH /api/rubrics/[id]` `deleteMany`s a rubric's criteria and recreates them on the **same rubric
id with no version bump**, and the pairwise system prompt embeds those criteria verbatim. Re-render
a historical judgment from `promptTemplateId` + the item and you silently get **today's** rubric,
with nothing recording that it moved. `userPrompt` is capped at 32 KiB, backed off to a UTF-8
character boundary so a stored copy cannot end in `U+FFFD`; `userPromptSha256` is taken over the
**full, pre-cap** text, so a capped copy still identifies the exact bytes the model saw, and
`promptTruncated` says which it is.

| Gap | Measured | Why, and what it is not |
|---|---|---|
| `reasoningTokens` | **NULL on 30/30** | Read from `usage.completion_tokens_details.reasoning_tokens`. **llama.cpp does not emit `completion_tokens_details` at all** — nothing was dropped and nothing was mis-parsed; the field was never sent. Expect it to be non-null on backends that do emit it, so do not "fix" this by defaulting it to 0: a real 0 and an absent measurement are different facts. **CORRECTION (2026-09-01):** also NULL on Ollama and never set by the Anthropic adapter — usage-reported, kept, labelled in the report; see handoff 2026-09-01 §7 item 10 |
| `parseMode` | **NULL on 30/30** | The pairwise path has exactly one parse path (`tryParsePairwiseJudgment`, fence-tolerant), so there is no strict→lenient demotion and no mode to persist. **The column is meaningful only pointwise.** It reads as a capture bug and is not one — but it does mean pairwise loses the "this response needed the lenient parser" signal entirely, which is a real gap on a path where a leniently-parsed verdict and a strictly-parsed one are indistinguishable afterwards. **CORRECTION (2026-09-01):** pairwise now writes it — `structured` = schema attached AND no fence/verdict repair, else `fallback`; rows in this table predate that and stay NULL (= pre-change, not `fallback`). See the `ModelJudgment.parseMode` schema comment |

`reasoningSource` is `reasoning_content` on all 30 of run 2. On run 1, `systemPrompt` was non-null
on only **26** of 30 — the four timeouts are transport failures with no response to capture, which
is the correct behaviour and a useful tell: **a NULL `systemPrompt` means the call never came back**,
not that capture failed.

---

## 6. THE OLLAMA FINDING — a rule that was never true, and never differentiated anything

### 6.1 The claim

`ollama` shipped with `structuredOutput: 'none'` and **`scoredRunsAllowed: false`**, so
`runProviderJudgment()` refused it outright as `non_retryable`. The stated justification:

> *"Ollama is refused for scored runs because it cannot constrain output, so its verdicts are
> unparseable-by-construction."*

### 6.2 The measurement that disproved it

Measured against a live server on 2026-08-31 — **Ollama 0.32.15 at `192.168.1.9:11434`**:

- `granite4.1:3b` returned **schema-conformant JSON on three consecutive calls**, `finish_reason`
  `stop`.
- `gemma4:26b` did the same.

Ollama honours the standard `response_format: {type: 'json_schema'}` path. The claim was **false as
a matter of fact**, and the file already knew: the descriptor's own inline comment conceded the
restriction was *"a SCORED-RUN restriction, NOT a technical one"* while the module doc twenty lines
above asserted the technical claim — **and the wrong half was the half doing the gating.**

### 6.3 The sharper discovery: the rule never differentiated anything

This is the part worth keeping, and it was only found because a test written to assert the *opposite*
failed:

> **`openai` and `openrouter` BOTH declare `structuredOutput: 'none'` with `scoredRunsAllowed: true`,
> and always have.** They take the lenient parse path (`parseMode 'fallback'`) — a deliberate,
> tested design. So the rule "cannot constrain output ⇒ cannot be scored" was already contradicted
> by **two shipped backends** before Ollama's capability was ever measured.

**The exclusion was internally inconsistent from the start, not merely stale.** That distinction
changes what the lesson is. A stale rule is a maintenance problem: the world moved, update the rule.
An inconsistent rule was **never enforceable** — it named a property (`structuredOutput: 'none'`)
that two permitted backends also had, so it could only ever have been enforcing "we do not like this
backend" under a technical-sounding name. The generalisation: **a capability gate that does not
partition the capability it names is not a gate, and re-measuring the capability will not find
that.** Only checking the rule against every value it is supposed to discriminate will.

### 6.4 The claim had propagated into four places

| Where | What it said |
|---|---|
| `src/lib/llm/registry.ts` — module doc | the technical claim, asserted |
| `src/lib/llm/registry.ts` — the **llamacpp** descriptor | drew its **own** justification from the contrast with Ollama |
| `tests/lib/llamacpp-backend.test.ts` | *"is allowed for scored runs, unlike ollama"* |
| `src/components/models/model-config-form.tsx` | told operators, in a dropdown, that Ollama was *"respond-only — not judge-eligible"* |

All four are corrected in `b42972e`, and **the llamacpp test was decoupled rather than updated** —
because hanging one backend's meaning on a neighbour's restriction is exactly how a single wrong
claim reached four places. *(The commit message itself says "three files" and then lists four; the
count is four. Noted here so the discrepancy does not turn into a fifth propagation.)*

### 6.5 What was kept

`backends/ollama.ts` is its own module rather than a shared helper with llama.cpp, deliberately:
sending one server's request shape to the other is a request that is **wrong rather than
unsupported** — it fails silently, returning plausible free text that only a strict parse would
flag. Collapsing two independently-verified shapes because they agree *today* is how that silent
failure returns when one server's API moves.

**The refusal guard is kept and still tested.** No shipped backend now sets
`scoredRunsAllowed: false`, so the path would have gone live and unexercised.
`assertScoredRunsAllowed` was extracted specifically so it can be driven against a synthetic
descriptor — ESM live bindings make stubbing `getDescriptor` from outside the module impossible, and
**a guard nothing can reach is a guard nothing can test.**

**What this does NOT claim:** that an Ollama-served model is a *good* judge. Constraining output
guarantees a parseable verdict, not a correct one. Whether a 3B quantised model deserves any trust
is precisely what a `CalibrationRun` measures — the machinery that was unreachable while the backend
was refused outright.

---

## 7. What this record forecloses, and what it does not

- **The golden set `cmt057hd001g17y01lhjzgfuj` is now frozen irreversibly** — a `CalibrationRun`
  exists against it and `isGoldenSetFrozen` is a `count() > 0` with no inverse. Consequences are in
  the plan's follow-up section; the operational warning is in the runbook.
- **0.8333 (25/30) is a baseline for one judge on one 30-item set**, not a leaderboard entry and not
  a statement about the 620-item set. Nothing here licenses extrapolating a judge's accuracy across
  sets — that is the same non-comparability argument as §1.4.2, applied to accuracy's population
  rather than kappa's `pe`.
- **`positionBias` is still NULL and unmeasured.** Every judgment here is `pairOrder AB`. The raw
  verdict distribution (A=18, B=12) is the *tell* for position bias, not a measurement of it — the
  key itself is 17/13, so an 18/12 split is close to the key's own skew and is not evidence of
  anything on its own. Only the B/A sweep can separate them.
- **`testRetest`, `biasSensitivityRate`, `flipRateVsParent`, `passThreshold`, `passed` remain NULL.**
  Later phases, not lost writes. `passed` NULL means *no threshold has been set*, so nothing has
  passed or failed — do not render it as a failure.
