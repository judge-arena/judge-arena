# How to score a judge against a golden set

**What this is.** The end-to-end operational path from "I have a model serving somewhere" to "I have
an accuracy number I can defend", for someone who has never run one. It assumes no prior context
beyond a shell and cluster access.

**What this is NOT.** An explanation of *why* the machinery is shaped this way — that is
`docs/superpowers/specs/2026-08-31-calibration-baseline-and-footprint.md` (the measured baseline, the
storage footprint, the concurrency lesson) and README's *Calibration* section (the schema link and
the design). Read this to run one; read those to argue about one.

**First run recorded:** 2026-08-31. Two runs exist. Everything below was walked on those two.

---

## ⚠ READ THIS BEFORE YOU RUN ANY COMMAND

> ## THE FIRST CALIBRATION FREEZES THE GOLDEN SET, IRREVERSIBLY.
>
> `isGoldenSetFrozen` is literally `calibrationRun.count({ where: { goldenSetId } }) > 0`
> (`src/lib/golden-sets.ts:266-272`). **There is no `frozenAt` column and there is no unfreeze verb
> anywhere in this product.** The moment the `CalibrationRun` header commits, that set's items,
> candidates, `protocol` and `expected` are read-only **forever**:
>
> - you cannot delete the calibration to release it — `EvaluationRun.calibrationRunId` is
>   `onDelete: Restrict`;
> - `retiredAt` / `tombstonedAt` do **not** release it;
> - the only way to change a frozen set's content is `POST /api/golden-sets/[id]/fork`, which makes a
>   **new** set at version+1 — and a number measured on the fork is not comparable to one measured on
>   the parent.
>
> **So: fix the set before you calibrate it, not after.** Wrong `expected` values, a candidate that
> should have been tombstoned, a stray item — all of them become permanent. `result.frozeGoldenSet`
> in the launch output tells you whether **this** call was the one that froze it.
>
> The failure this ordering prevents: a golden set pinned forever by a calibration in which all
> thirty items failed for a single reason that was knowable before any of them ran. That is why
> `launchCalibrationRun` checks everything knowable **without touching an item** — set exists, not
> tombstoned, pairwise, ≥1 live item and ≤ `MAX_CALIBRATION_ITEMS` (100), project + rubric exist, a
> pairwise `PromptTemplate` exists, and the caller owns an **active, verified** endpoint — *before*
> writing the header.

---

## 0. Where this runs, and what must exist first

**In the cluster.** Both entrypoints are esbuild-bundled into the image (the runner ships no
TypeScript toolchain) and must run from a pod, because that is the only place with a route to **both**
`judge-arena-pg-rw.tenant-public` **and** the judge endpoint. A workstation has neither.

```sh
kubectl -n tenant-public exec deploy/judge-arena-web -- node /app/add-judge.js        ...
kubectl -n tenant-public exec deploy/judge-arena-web -- node /app/calibration-run.js  ...
```

Locally, against podman Postgres, the same script is `npm run calibration:run -- <flags>`.

> **PRODUCTION SAFETY.** Local Postgres is the podman container **`judge-arena-pg`**. Production is
> the Kubernetes pod **`judge-arena-pg-1`** in `tenant-public`. One character apart. Every `psql`
> snippet below names one deliberately.

The runner resolves the surrounding rows itself rather than making you paste four ids, so these must
already exist and it will refuse with a plain message if they do not: **a `Rubric`** (the pairwise
system prompt renders its criteria), **a `Project`** to hang the `Evaluation`s off, **an admin
`User`** to attribute the runs to, and **a pairwise `PromptTemplate`**. It takes the oldest of each.

---

## 1. Register the judge

```sh
kubectl -n tenant-public exec deploy/judge-arena-web -- node /app/add-judge.js \
  --name="<display name>" \
  --backend=<anthropic|openai|openrouter|vllm|llamacpp|ollama> \
  --base-model="<the id the server actually serves>" \
  --endpoint="http://<host>:<port>/v1" \
  [--max-tokens=8192] [--temperature=0.3] [--protocol=pairwise] [--dry-run]
```

Worked example, the judge in the recorded baseline:

```sh
node /app/add-judge.js --name="Qwen3.6-35B-A3B" --backend=llamacpp \
  --base-model="Qwen3.6-35B-A3B-UD-Q3_K_XL.gguf" \
  --endpoint="http://192.168.1.164:8001/v1" --max-tokens=8192 --temperature=0.3
```

**Use `--dry-run` first if you are unsure of the served model id, the backend, or the `/v1` suffix.**
Those three are the easiest fields to mistype and they fail **late** — at judgment time, after a run
has been launched and (first time) after the set has frozen.

**It reuses `createCustomJudgeModel`**, the same chokepoint `POST /api/models` goes through, so the
judge gets its `model.create` audit row instead of being invisible to the trail. It creates three
rows and prints all three ids as JSON:

```json
{ "judgeModelId": "...", "judgeModelVersionId": "...", "modelEndpointId": "...", ... }
```

> **Keep all three. They are not interchangeable, and the next two steps want different ones.**
> Step 2 (verify) is keyed on **`modelEndpointId`**. Step 4 (`--judge-version=`) wants
> **`judgeModelVersionId`**. Passing the wrong one produces a "not found" from a route that sounds
> like it should have accepted it.

Note `--protocol` defaults to `pairwise` and writes `protocolSupport {"pairwise":["selection"]}`,
because `createCustomJudgeModel`'s own default is `{"pointwise":["score"]}` — wrong for the pairwise
corpora this product measures against.

---

## 2. VERIFY the endpoint — a run will not launch without it

> **`requireOwnedActiveEndpoints` refuses an endpoint with no `verifiedAt`.**
> `src/lib/run-launch.ts:228-243` selects on `{ userId, judgeModelVersionId, isActive: true,
> verifiedAt: { not: null } }` and throws `400`:
>
> ```
> No active, verified endpoint configured for judge model version(s): <id>.
> Configure your own endpoint for each selected judge on the Models page.
> ```
>
> `add-judge.js` says so itself, in its last two printed lines. **A freshly registered judge is
> NEVER verified.**

Verification is a **live probe**, not a flag: `POST /api/models/<modelEndpointId>/verify` runs
`verifyModelConnection` against the real server and writes `verifiedAt` **or** `verificationError`.
So it is also your first proof the endpoint string, the `/v1` suffix and the served model id are all
right — which is exactly why the run refuses to start without it.

**There is no CLI verify entrypoint.** Today the only callers are the Models page and that route, so
verification needs a signed-in session holding the `models:verify` scope.

**Two traps here, both real:**

1. **`userId` must match.** The guard filters on the endpoint's **owner**. `add-judge.js` assigns the
   endpoint to the oldest admin `User` and `calibration-run.js` attributes the run to the same one,
   so the CLI path matches by construction — but an endpoint registered in a browser **as someone
   else** will be refused for a CLI-launched calibration, with a message that says "not verified"
   rather than "not yours".
2. **Signing in may itself be blocked.** As of 2026-08-31 the OIDC identity mismatch described in
   `docs/superpowers/plans/2026-08-30-state-and-next-steps.md` §2 refuses the `trijeet` Authentik
   account. Sign in as **`akadmin`** (private window) or apply the one-row `oidcSubject` fix. Do
   **not** work around it with a fresh invite or `ALLOW_OIDC_AUTOPROVISION` — both mint a second,
   empty `User` that owns nothing, which lands you back in trap 1.

Confirm it took, read-only:

```sh
kubectl exec -n tenant-public judge-arena-pg-1 -c postgres -- psql -U postgres -d judge_arena -tAc \
  'SELECT id, "judgeModelVersionId", "isActive", "verifiedAt", "verificationError" FROM "ModelEndpoint" ORDER BY "createdAt" DESC LIMIT 5;'
```

`verifiedAt` non-null and `verificationError` null. *(The verify probe sends `max_tokens: 1` and is
deliberately exempt from the truncation guard in §7.2 — otherwise every healthy endpoint would
report itself truncated.)*

---

## 3. Find the two ids the run needs

```sh
# Golden sets — you want a PAIRWISE one, not retired, not tombstoned.
kubectl exec -n tenant-public judge-arena-pg-1 -c postgres -- psql -U postgres -d judge_arena -c \
  'SELECT id, name, version, protocol, "retiredAt", "tombstonedAt" FROM "GoldenSet" ORDER BY "createdAt";'

# How many live items it has (the runner caps at MAX_CALIBRATION_ITEMS = 100)
kubectl exec -n tenant-public judge-arena-pg-1 -c postgres -- psql -U postgres -d judge_arena -tAc \
  "SELECT count(*) FROM \"GoldenItem\" WHERE \"goldenSetId\" = '<goldenSetId>';"

# Is it already frozen? Non-zero = yes, and nothing you do will unfreeze it.
kubectl exec -n tenant-public judge-arena-pg-1 -c postgres -- psql -U postgres -d judge_arena -tAc \
  "SELECT count(*) FROM \"CalibrationRun\" WHERE \"goldenSetId\" = '<goldenSetId>';"

# Judge model versions
kubectl exec -n tenant-public judge-arena-pg-1 -c postgres -- psql -U postgres -d judge_arena -c \
  'SELECT v.id, m.name, v."servingBackend", m."baseModel", v."samplingDefaults"
     FROM "JudgeModelVersion" v JOIN "JudgeModel" m ON m.id = v."judgeModelId" ORDER BY v."createdAt";'
```

A set that is **already frozen is fine to calibrate again** — freezing is idempotent, and a second
judge against the same frozen set is the normal way to build a comparison. The count matters only
when the set is *not yet* frozen and you still want to edit it.

---

## 4. Size `--poll-timeout` before you launch

The runner launches, then **polls terminal judgment states** rather than sleeping a fixed time — a
local reasoning model is slow and variable, and a wrong fixed wait either truncates the run or wastes
the difference. `--poll-timeout=<seconds>` bounds that wait. **Default 3600.**

**The formula, and it is a floor not a guess:**

```
poll-timeout  ≈  (item count) × (observed per-item latency)  × 1.5 …2
```

Judgments execute **sequentially** — one in flight, worker-wide (§7.4) — so item count multiplies
directly. Nothing overlaps and nothing amortises.

Worked from the recorded baseline: 30 items × 42.6 s observed average = 1,278 s; the run actually took
**21 m 53 s** (1,313 s) wall clock. `--poll-timeout=3600` was comfortable; `--poll-timeout=1200`
would have expired **with items still pending** and reported an accuracy over a partial set — with
nothing wrong on screen except a smaller denominator.

If you have no observed latency yet, take the max rather than the mean — the baseline judge's spread
was 16.1 s to 95.1 s, a 5.9× range within one model on one set — or launch with the 3600 default and
read the per-item latencies afterwards.

> ### WHAT HAPPENS WHEN IT EXPIRES: **it scores what landed.**
> ```
>   ⏱ poll timeout after <n>s — scoring what landed.
> ```
> It does **not** cancel the run, and it does **not** fail. The queue keeps draining; the *report*
> stops waiting. You get an accuracy over however many items had completed at that instant — a
> partial number that looks exactly like a whole one apart from its denominator. Scoring only ever
> reads `status: 'completed'` judgments, so a still-running item is missing, not wrong.
>
> **This is the second way to produce a partial denominator, and the first way is what actually
> happened on run 1** — there, four items had **dead-lettered**, so the poll ended normally and the
> report was still over 26 of 30 (0.8462 = 22/26). *Correction to a common retelling: run 1's partial
> set came from dead-letters, not an expired poll.* The output shape is identical either way, which
> is the whole reason the denominator is printed inside the accuracy line.
>
> **The fix for an expired poll is free:** wait for the queue to drain, then `--score-only` (§6).
> Nothing is lost and nothing is re-launched.

---

## 5. Run it

```sh
kubectl -n tenant-public exec deploy/judge-arena-web -- node /app/calibration-run.js \
  --golden-set=<goldenSetId> --judge-version=<judgeModelVersionId> [--poll-timeout=<seconds>]
```

It prints the resolved context first — judge, sampling defaults, rubric, project, attributing user —
**and the freeze notice** — then the `calibrationRunId`, then `accepted` / `failed` counts with a
reason per failed item, then a progress line each time the counts change:

```
  completed 9  error 0  running 1  pending 20   (9/30)
```

> **`running 1` is the concurrency cap doing its job.** If you ever see `running` above 1 against a
> single-slot judge, stop and read §7.4 — that is the exact configuration that dead-lettered four
> items on run 1.

If **nothing** is accepted the runner throws before polling, deliberately: there is nothing to wait
for, and the failure reasons are already on screen.

**A calibration is not a special execution path.** `launchCalibrationRun` creates rows and calls
`launchSingleRun` N times; it publishes nothing itself and knows nothing about providers. A
calibration run is an ordinary pairwise run with two extra columns set, drained by the same
`judgment.execute` consumer as everything else. **If you are debugging one, debug the normal
pipeline.**

---

## 6. Re-score without relaunching

```sh
kubectl -n tenant-public exec deploy/judge-arena-web -- node /app/calibration-run.js \
  --score-only=<calibrationRunId>
```

**Idempotent, and safe to run repeatedly.** Every scored field is a full overwrite recomputed from
the source rows — nothing increments, nothing appends, no judgment is re-executed and no provider is
called. Use it when:

- the poll timed out and the queue has since drained (§4);
- you want the report again without keeping the original terminal;
- scoring logic changed and you want the stored numbers refreshed.

It **cannot** rescue a dead-lettered item — there is no verdict to score. Only a fresh run can, and a
fresh run against the same set is a **new** `CalibrationRun` row, not a repair of the old one.

---

## 7. How to read the output

### 7.1 Accuracy, with its denominator — first, and never alone

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

### 7.2 The raw verdict distribution — this is the position-bias tell

```
raw verdict distribution (position bias lives here, not in derived preferences):
    A      18
    B      12
    tie     0
```

Read it **against the key's own marginal**, which is a property of the set (17 `A>B` / 13 `B>A` on
the 30-item set). A judge that answers `A>B` every time scores **0.5667** accuracy on that set —
"better than chance" to the naked eye — and **0.0000** kappa. **A distribution far more skewed than
the key's is the cheapest possible warning that you are looking at position bias rather than skill.**

It is a *tell*, not a measurement: every judgment here is `pairOrder AB`, and only the B/A sweep can
separate bias from a set that genuinely leans one way. `positionBias` is still NULL by design.

### 7.3 The confusion matrix

```
confusion [expected][judged]:
    A>B  -> A>B:15  B>A:2
    B>A  -> A>B:3   B>A:10
```

**Rows are ground truth, columns are the judge.** The diagonal sums to the correct count (15 + 10 =
25); each row sums to the key's count for that class (17 and 13); each column sums to the verdict
distribution (18 and 12). **If those three reconciliations do not hold, the report has a bug — stop
and find it before quoting anything.**

Asymmetry between the off-diagonals is the interesting part: 2 versus 3 here is even-handed, whereas
a heavily one-sided pair means the judge is systematically resolving one direction.

### 7.4 Capture completeness

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

Every field should be `n/n` where n is the judgment count. Two **known, honest** exceptions:

| Field | Expect | Why |
|---|---|---|
| `reasoningTokens` | **0/n on llama.cpp AND Ollama** (and never set for Anthropic) | its `usage` payload carries no `completion_tokens_details`. Nothing was dropped; the field was never sent. **Do not "fix" it by defaulting to 0** — a real 0 and an absent measurement are different facts. **CORRECTION (2026-09-01):** this row said llama.cpp only; Ollama sends nothing either and the Anthropic adapter never sets it. The line is now labelled usage-reported in the report, and the two `reasoningContent chars` lines beneath the checklist — one for `completed` rows, one for `error` rows — are the size signal to read. **Compare the two lines, do not read either alone:** an `error` mean several times the `completed` mean, with `content length 0` failures, is the repetition-loop signature (handoff 2026-09-01 §5.2 measured 44,287 vs 13,138), not a `max_tokens` problem. Pooling the two hides it — the same run pools to 18,330 |
| `parseMode` | **NULL on the pairwise path** | one parse path, so no strict→lenient demotion to record. Meaningful only pointwise |

**A NULL `systemPrompt` means the call never came back.** Transport failures have no response to
capture, so a shortfall here counts your transport failures, not a capture bug.

The runner then prints **one judgment in full** and, if any exist, **the failures** (with
`finishReason`, `outputTokens` and reasoning length) and **every disagreement** with the model's own
reasoning. Reading *why* it was wrong is the entire point of capturing the thinking channel — if you
skip everything else, read the disagreements.

---

## 8. Known failure modes

### 8.1 Dead-lettered judgments land in `judge.dlq` and **nothing consumes it**

The attempt budget is `MAX_ATTEMPTS = 3` (`src/worker/judgment-consumer.ts:154` — first delivery plus
two retries, via the 30 s and 5 m retry queues). On exhaustion the judgment is marked `error` and
`publishToDlq` puts the envelope on **`judge.dlq`**.

> **`judge.dlq` has no consumer, by design, and there is no retry-from-DLQ verb.** A message there is
> parked, not queued. **Nothing will ever retry it.** Run 1's four dead-lettered judgments are still
> sitting there and will remain there.

So: a non-zero DLQ depth is **permanent data loss for that run's denominator**, and the only remedy
is a **new** calibration. It also means `judge.dlq` at depth 0 is the normal state and a rising depth
is a real signal — see the T5 monitoring note in the plan. *(Run 1's failures were recorded as four
attempts each against a budget of three; `attemptCount` can advance past the message's own `attempt`
across crash-reclaim cycles, so read the DLQ trigger as "the attempt budget ran out", not as a fixed
number of provider calls.)*

### 8.2 A truncated response is a **hard, non-retryable** failure — and the message says whether it was a loop

`finish_reason: 'length'` / `stop_reason: 'max_tokens'`, or an empty content channel, throws
`non_retryable` in `registry.ts`'s `execute()` — **one chokepoint, before any parse**, so pointwise,
pairwise and respond all inherit it. The message carries every number needed to size the fix, and
since `a272519` it ends with one of TWO pieces of advice, chosen by measuring the output:

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

> **CORRECTION (2026-09-01).** Until `a272519` this section quoted a single message ending
> "raise `samplingDefaults.max_tokens` on the `JudgeModelVersion` for this judge" and said "the fix
> is yours to make, and it is one field". That was wrong twice. (1) On calibration run 9 the five
> `finish_reason: length` failures were a degenerate repetition loop, and raising the budget — the
> advice this section and the message both gave — is what turned run 8's 11,680-char loop at 4096
> tokens into run 9's 56,004-char loop at 12288. (2) "Raise it on the version" invited editing
> `samplingDefaults` in place, which §8.8 already forbids mid-run; the field is a provenance pin and
> the fix is a new ordinal.

> **Check the clock before you raise the budget — see §8.6.** A larger `max_tokens` is a larger
> *worst-case call duration*, and on a slow local server the new budget may not be reachable inside
> the timeout at all. Raising it blind converts a truncation failure into a timeout failure, which
> looks like a regression and is not.

> **Do not copy a budget from a same-size sibling.** `granite4.2:3b` was registered at 4096 because
> `granite4.1:3b` ran fine there. Same family, same parameter count — and 4.1 emits ~109 output
> tokens per judgment while 4.2 emits ~1950. Half the set truncated. A budget is a property of the
> model's *behaviour*, not of its size.

### 8.3 Timeouts that are really queueing — the run-1 signature

Four items failed with `Provider call to "llamacpp" (...) timed out after 300000ms`. **The model was
not too slow.** Prefetch was `concurrency(2) × 4 = 8` against a server advertising `total_slots: 2`,
so six requests queued *inside the inference server* while their client timeout ran. Same judge, same
set, sequential: zero timeouts and a 42.6 s mean.

**The 300 000 ms in that message is now the INITIAL BUDGET, not the wall** — as of
`sha-414e826a3ba3` it warns and keeps waiting, and 900 000 ms aborts (§8.7). The diagnosis below is
unchanged; only the number a timeout message carries has moved.

**Recognising it:** timeouts clustered on the items that queued longest, latencies bunched just under
the ceiling, and a server whose own slot count is smaller than your in-flight count. Over-subscribing
moves the backlog from a queue you can watch (RabbitMQ) into one you cannot (the inference server),
and the only symptom it emits is a timeout that looks like a slow model.

**Now capped:** `src/worker/concurrency.ts` clamps `EVALUATION_MODEL_CONCURRENCY_PER_RUN` to 1 and
sets prefetch to 1, **whatever the environment asks for**. The clamp is logged at `warn`:

```
"EVALUATION_MODEL_CONCURRENCY_PER_RUN clamped to the hard cap" requested=2 effective=1
```

> **The Deployment still sets `=2` and the worker still runs at 1.** Read the `judge worker started`
> log line's `concurrency` field, never the manifest, the compose file or CONTRIBUTING's pool table.
> Per-endpoint concurrency is the real fix and is in flight; raising the cap is not.

### 8.4 The reaper can force-finalize a queued batch

`src/worker/reaper.ts` sweeps `pending`/`judging` runs past their `deadlineAt` and, ~180 s later,
stamps every still-`pending` judgment `error: 'reaper: abandoned'`. `launchCalibrationRun` widens the
deadline formula from "models in this run" to "judgments queued ahead of this one" precisely so a
sequential batch is not scored as errors while it is still queued and healthy.

**It is a bound, not a guarantee: a batch queued behind ANOTHER batch can still outlive it.** So
**do not launch a second calibration while one is draining.** A force-finalized run is
indistinguishable from one that really failed, and the resulting accuracy is computed over the head
of the set with nothing on screen saying so.

### 8.5 Run-grain `status` can be stale — count judgments, not runs

On run 1, five `EvaluationRun` rows carried `status='error'` while only four `ModelJudgment` rows
did: one run stayed stamped `error` while its judgment completed on a later attempt. **Scoring reads
the judgment**, so that item was correctly inside the denominator. Any ad-hoc SQL you write to
double-check a calibration must do the same, or it will disagree with the report by one.

### 8.6 TWO LIMITS ARE STACKED — fixing `max_tokens` can expose a timeout underneath it

`max_tokens` bounds **how much the model may say**. The timeout bounds **how long you will wait to
hear it**. They fail in ways that look nothing alike, and only the outer one is visible until you
remove it.

Observed 2026-09-01 on `granite4.2:3b`. At `max_tokens: 4096`, 15 of 30 items truncated (§8.2) — so
the fix was obvious and correct: raise it to 12288. The re-run then reached 11/30 and stalled on

```
Provider call to "ollama" (granite4.2:3b) timed out after 300000ms
```

**Nothing regressed.** The model emits ~35 output tok/s, so a 12288-token budget needs ~351 s to
exhaust and the 300 s wall could only ever afford ~8,700 tokens. At 4096 the model was being cut off
*before* it could run out of time; removing the token ceiling let it run into the clock instead.

**The check is two numbers and one division. Do it at registration, not after a failed run:**

```
time_to_exhaust_budget = max_tokens / tok_per_s      # must fit under the 900 s hard cap
max_safe_tokens        = timeout_s  × tok_per_s      # the ceiling your timeout can actually afford
```

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

> **CORRECTION (2026-09-02, `0bd6b6b`).** This paragraph used to read:
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

**Recognising which limit you hit:** truncation gives `finishReason: 'length'` with `completion_tokens`
exactly equal to `max_tokens`, on *every* long item, deterministically. A timeout gives no
`finishReason` at all, a retry in the worker log, and it clusters on the long items while short ones
sail through. A run that shows **both** has had its budget raised without its clock checked.

### 8.7 The timeout ESCALATES — 300 s is an alert, not the wall

As of `sha-414e826a3ba3`, `EVALUATION_MODEL_TIMEOUT_MS` (still `"300000"`) is the **initial budget**
and no longer aborts anything:

| | value | behaviour |
|---|---|---|
| initial budget | `EVALUATION_MODEL_TIMEOUT_MS`, 300 000 ms | **warns and keeps waiting** |
| hard cap | `EVALUATION_MODEL_HARD_CAP_MS`, default 900 000 ms | **aborts** |
| attempts | 2 | then `non_retryable` |

> **CORRECTION (2026-09-01, U3).** On images up to and including `sha-d21f31d47c35` the `attempts`
> row was only half true: the consumer gave the judgment two deliveries, but inside EACH delivery
> `withRetry` re-ran the 900 s hard cap up to three times, so the worst case per delivery was
> ~2700 s, not 900 s, and the 930 s lease let the reaper republish it mid-flight. The operator-visible
> symptoms are a `"LLM call failed, retrying" … hard cap` line in the worker log and paired
> attempt-3/attempt-4 envelopes for one judgment in `judge.dlq`. Fixed in `src/lib/llm/index.ts`
> (`isRetryableInProcess`): a timeout now escapes on its first throw. Worst case per item is 900 s
> per delivery, as the §8.7 sizing paragraph below assumes.

At 300 s the worker emits `judgment passed the initial timeout budget`. If that judge has completed
a judgment before, the warning states how far past its own baseline this call is; if it has not, it
says *confirm model access, waiting 10 more minutes*. **Health means "this judge has returned a
successful response", not "the server answers a probe"** — a side-channel probe proves the server is
up, not that this request is progressing, and would happily extend a wedged call to the full 15
minutes.

> **Do not raise the timeout by environment variable on an older image.** Before this release
> `claim.ts` derived `LEASE_MS` as `EVALUATION_MODEL_TIMEOUT_MS + 30s`. A 15-minute call under a
> 330 s lease is **reclaimed by the reaper mid-flight and executed twice** (§8.4). `LEASE_MS` now
> derives from the hard cap instead (930 s). Setting the env var alone happens to move the lease with
> it — which is exactly what makes the shortcut look safe — but it forfeits the alert and the
> attempt policy, and it re-arms the hazard for anyone who later tunes the two numbers apart.

**Sizing `--poll-timeout` against the new cap:** the worst case per item is now 900 s, not 300 s, so a
run whose tail exceeds the initial budget takes correspondingly longer. Size from the observed mean
(§4) and let the cap bound the tail; do not size from the cap or you will wait 7.5 hours for 30 items.

### 8.8 Extending a timeout mid-run is SAFE; changing `max_tokens` mid-run is NOT

Both feel like "editing the config while it runs", and they are not the same act.

- **`max_tokens` changes what the model produces.** A truncated answer and a complete one are
  different data, so a run whose budget moved mid-flight is a mixture of two experiments and is
  neither one. Let a doomed run finish, mark it void, re-run whole.
- **A timeout changes only whether the client is still listening.** Judgments already recorded were
  produced under identical model configuration; only the harness's patience differed. Mixing them
  with the rest is sound.

Run `cmtircx0x` is the worked example: 11 items completed under the flat 300 s wall, the remaining 19
under the escalating policy, and the run is internally comparable because the model's own
configuration never moved. The tell that a run *is* contaminated is §4.1 of the scoreboard spec —
`SELECT DISTINCT mj."samplingParams"->>'max_tokens'` returning more than one row — and, since v2k,
any judgment's `samplingParams` differing from the header's `CalibrationRun."samplingParams"` (the
launch-time snapshot; NULL on runs launched before v2k). `scripts/calibration/run.ts` checks both in
its Result block and prints a ⚠ naming the configs. A judge that needs a different `max_tokens` is a
**new version ordinal** (`prisma/seed-core.ts:223-229` states the invariant: a version is immutable
under a judgment) — or, at the very minimum, is never edited while a run is draining.


---

## 9. Worked reference — the recorded baseline

```
golden set   cmt057hd001g17y01lhjzgfuj   "JudgeBenchSample — 30 random"  (30 pairwise items, 17 A>B / 13 B>A)
judge        Qwen3.6-35B-A3B-UD-Q3_K_XL  llamacpp @ 192.168.1.164:8001, max_tokens 8192, temp 0.3

RUN 2  cmthr58r100013s0sykuvn41x   sequential — THE BASELINE
  ACCURACY 0.8333 (25/30)   kappa 0.6575 cohen/none   missingVerdicts 0
  verdicts A=18 B=12 tie=0  ·  confusion A>B->[15,2]  B>A->[3,10]
  21m53s wall clock  ·  latency avg 42.6s / min 16.1s / max 95.1s  ·  0 errors, 0 dead-letters

RUN 1  cmtgib0xr00016k2r8nlyj1py   concurrency 8 — DO NOT QUOTE
  ACCURACY 0.8462 (22/26)   kappa 0.6950   4 items dead-lettered, never judged
```

**The higher number is the worse result.** Full reasoning, and the storage footprint measured off
these rows: `docs/superpowers/specs/2026-08-31-calibration-baseline-and-footprint.md`.
