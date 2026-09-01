# The judge scoreboard exists — handoff, 2026-09-01

**Supersedes the *status* sections of [`2026-08-30-state-and-next-steps.md`](./2026-08-30-state-and-next-steps.md).**
That document's traps, corrections and §5.6 follow-up register remain live and are referenced
throughout; read it after this one.

Everything below was verified against the live cluster, the production database or the tree on
2026-09-01. Nothing is carried forward from an earlier document. **Two things this session shipped
turned out to be wrong after they shipped, and both are called out as corrections rather than
quietly replaced** — they are the most useful part of the record.

---

## 0. If you read one thing

Three judges have been scored against a frozen golden set. **The best is 0.8667; the worst is worse
than a rubber stamp**, and the report does not say so because the degenerate baseline is never
computed.

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
| granite4.2:3b (Ollama) | 12288 | 0.6000 | 0.2355 | **15/25** | **+0.04** |
| granite4.1:3b (Ollama) | 4096 | 0.5000 | 0.1296 | 30/30 | **−0.07** |

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
8. **`--poll-timeout` expiring scores what landed** and prints a partial accuracy that looks exactly
   like a whole one apart from its denominator. Wait for the drain and use `--score-only`.
9. **Do not launch a second calibration against the same server while one drains.** They share a
   lane, and the reaper's deadline is a bound, not a guarantee.

---

## 7. Open, in priority order

The register lives in
[`2026-08-30-state-and-next-steps.md` §5.5–5.6](./2026-08-30-state-and-next-steps.md). Ranked here by
what a leaderboard actually needs.

### Blocks a trustworthy leaderboard

1. **`CalibrationRun` does not snapshot the sampling config, and `samplingDefaults` is mutable.**
   The obvious join reports *today's* config for a historical run — editing granite4.2's budget
   silently rewrote what that query says about the earlier run, with nothing logged. Truth is one
   level deeper on `ModelJudgment.samplingParams`. `rubricId`, `kappaVariant` and `passThreshold` are
   already pinned for exactly this reason; this was missed. **Additive, one column.**
2. **Emit the degenerate baseline beside the accuracy.** It is computable from the answer key,
   `score.ts` already derives it in prose, and nothing displays it. Without it a leaderboard cannot
   distinguish "learned a little" from "stamps A". Must be computed **per denominator** (§2).
3. **Distinguish a repetition loop from a genuine truncation** (§5.2). The guard's advice is
   actively harmful in the loop case.

### Correctness, unfixed

4. **The AMQP consumer re-registration defect.** The pipeline was silently dead for five days in
   August: the pod stayed 1/1 Running with 0 restarts while consuming nothing. `/health` now
   *detects* it; the reconnect itself is still broken. homelab PR #932 is still draft.
5. **`judge.dlq` holds 10 messages, has no consumer and no replay verb.** It grew from 4 during
   ordinary operation, so it is an accumulating sink, not run-1 residue.
6. **CI's false green** (trap 3). Make the job fail when a step fails *first*; the OOM is secondary.

### Product

7. **Zero human judgments.** The annotation studio has never been exercised end-to-end.
8. **No frontier reference line.** Claude Opus 4.5 / Sonnet 4.5 / Sonnet 4.6 are registered and
   unscored, so the local numbers have nothing to be placed against.
9. **One rubric, one protocol, one set.** Everything is pairwise under General Quality Assessment on
   30 items. Nothing is known about pointwise, other rubrics, or whether a judge is *good* versus
   *suited to this set* — and κ is not comparable across sets, which is the whole point of a
   scoreboard.
10. **`reasoningTokens` is NULL on every self-hosted backend** — llama.cpp and Ollama both. It is
    dead weight in the capture report rather than a per-backend gap. Derive it or drop it.
11. **`parseMode` is NULL on pairwise.** One fence-tolerant parse path, so no strict→lenient
    demotion to record. Document as pointwise-only or give it a pairwise meaning.

---

## 8. Starting the next session

```sh
# 1. What is running — the live object, not the manifest. (§1)
kubectl -n tenant-public get deploy judge-arena-web judge-arena-worker \
  -o custom-columns='NAME:.metadata.name,IMAGE:.spec.template.spec.containers[0].image,READY:.status.readyReplicas'

# 2. Is the pipeline alive? consumers must equal expectedConsumers (10). (§1, open #4)
kubectl -n tenant-public logs deploy/judge-arena-worker --tail=20 | grep 'judge worker started'

# 3. The scoreboard as the database holds it — never from a doc, and never
#    joining to JudgeModelVersion.samplingDefaults for the config. (open #1)
kubectl -n tenant-public exec judge-arena-pg-1 -c postgres -- psql -U postgres -d judge_arena -c "
  SELECT jm.name, cr.\"rawAgreement\" AS acc, cr.kappa, cr.\"verdictCount\",
         (SELECT DISTINCT mj.\"samplingParams\"->>'max_tokens'
            FROM \"ModelJudgment\" mj JOIN \"EvaluationRun\" er ON er.id = mj.\"runId\"
           WHERE er.\"calibrationRunId\" = cr.id AND mj.\"samplingParams\" IS NOT NULL) AS maxtok
    FROM \"CalibrationRun\" cr
    JOIN \"JudgeModelVersion\" jmv ON jmv.id = cr.\"judgeModelVersionId\"
    JOIN \"JudgeModel\" jm ON jm.id = jmv.\"judgeModelId\"
   ORDER BY cr.\"startedAt\" DESC;"

# 4. Confirm main has an image in Harbor. Green CI does not mean this. (trap 3/4)
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
