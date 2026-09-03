# Wave 1 is live, Wave 2 is local — handoff, 2026-09-03

**Supersedes the *status* sections of
[`2026-09-01-scoreboard-handoff.md`](./2026-09-01-scoreboard-handoff.md).** That document's §5
corrections, §6 traps and §7 register remain live and are referenced throughout; its §7 now carries a
per-item status block pointing here. Read it after this one.

Everything below was verified against the live cluster, `judge-arena-pg-1` or the tree on
2026-09-03. Nothing is carried forward from an earlier document without being re-measured. **Three
things written down during this session turned out to be wrong, one of them about the previous
handoff's own root cause, and all three are recorded as corrections rather than quietly replaced** —
§5, which is the part of this document worth your time.

---

## 0. If you read one thing

All three items the previous handoff listed under *Blocks a trustworthy leaderboard* — the sampling
snapshot, the per-denominator degenerate baseline, and loop-versus-truncation — are closed **in the
tree**. **They are not running.** Production is `sha-5e48187cfb3a`, which is Wave 1 only: 9 commits,
pushed, built and promoted. The other **16 commits of this session are Wave 2 and are local on this
workstation** — not on `gitea/main`, no image in Harbor, not promoted, and two of them carry
migrations `judge-arena-pg-1` has not applied. A fourth judge, qwen3.5:9b, was scored at 0.8571 (24
of 28), which is a fifth row on the same 30 items under the same rubric — more rows in the one
column, not a second column.

And the corrections, because they are the shape of what goes wrong here:

1. **A claimed ~2.2× understatement of every throughput envelope was a double count and is wrong.**
   Two of the three judges' published rates were correct and do not move. §5.1.
2. **A truncation figure was inflated from 82.4% to 98% of budget** by dividing reasoning characters
   by a chars-per-token constant measured on the *content* channel. §5.2.
3. **The previous handoff's own CI root cause — an OOM — did not happen.** The run was cancelled
   server-side. That correction was written on 2026-09-01 and is restated here because the wrong
   version is the one people remember. §5.3.

---

## 1. What is actually running

**Read these; do not assume them.** The 2026-09-01 handoff records the equivalent row as having been
wrong **twice** in the 2026-08-30 one (§1 there). No third instance has been measured: the
2026-09-01 row was correct on the day it was written and is merely stale now, which is why this one
re-measures it rather than carrying it forward.

```sh
# 1. The image, from the live object — not from helmrelease.yaml, not from stable.yaml.
kubectl -n tenant-public get deploy judge-arena-web judge-arena-worker \
  -o custom-columns='NAME:.metadata.name,IMAGE:.spec.template.spec.containers[0].image,READY:.status.readyReplicas'

# 2. The worker's AMQP consumers. consumers must equal expectedConsumers (10).
#    Wave 1 changed the FAILURE MODE here, not the reconnect — see §3 and open #4.
kubectl -n tenant-public logs deploy/judge-arena-worker --tail=30 | grep 'judge worker started'

# 3. Queue depths, including the DLQ that nothing drains.
kubectl -n tenant-public exec rabbitmq-judge-arena-server-0 -- \
  rabbitmqctl list_queues name messages consumers
```

Measured 2026-09-03:

```
judge-arena-web      harbor.cluster.asethi.com/homelab/judge-arena:sha-5e48187cfb3a   1
judge-arena-worker   harbor.cluster.asethi.com/homelab/judge-arena:sha-5e48187cfb3a   1
```

```json
{"level":"info","msg":"judge worker started","timestamp":"2026-09-02T23:58:34.188Z",
 "service":"judge-arena","lanes":8,"lanePrefetch":1,"fallbackPrefetch":4,
 "maxServersInFlight":8,"perJudgeConcurrency":1,"perJudgeCap":1,"healthPort":9090,
 "consumers":10,"expectedConsumers":10}
```

`/health` on the same pod reads
`{"status":"healthy","checks":{"rabbitmq":true,"redis":true,"database":true,"consumers":10},"expectedConsumers":10,"missingConsumers":[]}`.
`judge.dlq` reads **10 messages, 0 consumers** — unchanged at every check across the whole session,
which is itself the measurement (open #5).

**`sha-5e48187cfb3a` is Wave 1 only.** Everything in the Wave 2 table in §3 is absent from it. In
particular, measured against `judge-arena-pg-1` on 2026-09-03, **neither `CalibrationRun.samplingParams`
(v2k) nor `CalibrationRun.constantBaselineAccuracy` (v2l) exists as a column** — the
`information_schema.columns` query for both returns zero rows. Any query in an older document that
selects them will error, not return NULL.

| | 2026-09-01 | 2026-09-03 (measured) |
|---|---|---|
| golden sets / items (live) | 2 / 650 | 2 / 650 |
| judge models / versions | — / 6 | 7 / **8** (3 Anthropic unscored, 5 self-hosted) |
| model endpoints | 3 | 5 |
| calibration runs | 9 | **11** |
| evaluation runs / model judgments | 270 / 270 | **330 / 330** |
| **human judgments** | **0** | **0** |
| database size | 10 MB | 20 MB of a 10 Gi PVC |
| `judge.dlq` | 10 msgs, 0 consumers | **10 msgs, 0 consumers** |

**Human judgments is still 0 and it is still the largest structural gap in the product.** Every
number in §2 is a judge scored against an *imported* answer key. The A1/A1.5 annotation studio
remains unexercised end-to-end, and no commit in this session could have changed that.

**The 8 judge model versions include two for qwen3.5:9b deliberately.** `seed-core.ts:223-229` states
that a version needing different values is a NEW ORDINAL, never a mutated one. Ordinal 1
(`cmtkt2d6w00027h33of3j9iky`, `max_tokens 6144`, `CalibrationRun cmtkt3sg200017h3tlf87khhn`) is
**VOID** — launched, **8 items complete at the moment it was stopped**, then abandoned. A ninth
judgment landed after the stop and is `completed` in the database, so a query today returns **9**;
both numbers are right for their own denominator, and the spec's §1.2 works the two apart. Its
poller scored the partial run before it was killed; `rawAgreement` and `kappa` have been NULLed and
`verdictCount` zeroed so the phantom `0.75 / 8` cannot be read as a result. Its 30 `ModelJudgment`
rows are retained, and — measured 2026-09-03 — **no row carries both** halves of the provenance: the
**21 error rows** carry an explicit `VOID:` string and have `samplingParams` NULL, and the **9
completed rows** carry `samplingParams {"max_tokens": 6144}` and have no `error`. Ordinal 2
(`cmtkqwen35ord2v20000001`, `max_tokens 8192`) is the real run.

---

## 2. The scoreboard

Full ledger, with per-model throughput envelopes and the traps that corrupt it:
[`docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md`](../specs/2026-09-01-judge-scoreboard-and-model-envelopes.md).

Golden set `cmt057hd001g17y01lhjzgfuj` — *JudgeBenchSample — 30 random*, pairwise, frozen.
**Answer key over the whole set: 17 `A>B`, 13 `B>A`, no ties** (re-measured 2026-09-03).

**The denominators differ, so accuracy is not strictly comparable down this column, and each floor
belongs to its own row.** A judge's floor is the key restricted to the rows it actually scored, so
three different floors appear against one 30-item set.

| judge | `max_tokens` | accuracy | κ | verdicts | **its own floor** | margin |
|---|---|---|---|---|---|---|
| **Qwen3.6-35B-A3B** (llama.cpp) | **12288** | **0.8667** | 0.7285 | 30/30 | 0.5667 (17/30) | **+0.3000** |
| **qwen3.5:9b** (Ollama) | **8192** | **0.8571** | 0.7128 | **28/30** | **0.5357 (15/28)** | **+0.3214** |
| Qwen3.6-35B-A3B (llama.cpp) | 8192 | 0.8333 | 0.6575 | 30/30 | 0.5667 (17/30) | +0.2666 |
| granite4.2:3b (Ollama) | 12288 | 0.6000 | 0.2355 | 25/30 | 0.5600 (14/25) | +0.0400 |
| granite4.1:3b (Ollama) | 4096 | 0.5000 | 0.1296 | 30/30 | 0.5667 (17/30) | **−0.0667** |

**Every floor in this table is DERIVED by hand from the answer key over the scored subset — not read
from the database.** `CalibrationRun.constantBaselineAccuracy` is v2l, v2l is Wave 2, and the column
does not exist on `judge-arena-pg-1`. The three subset marginals above were re-measured on 2026-09-03
(17/13 whole set, 15/13 on qwen3.5:9b's 28, 14/11 on granite4.2's 25); the accuracies and κ were read
from `CalibrationRun`.

**qwen3.5:9b's two lost items are not a random sample** — they are the two it was slowest on. Both
failed with `hit the 900000ms hard cap on attempt 2`, `attemptCount 2`, latency 900 s, no content
returned: **the clock bound, not the token budget.** κ is comparable only within the same set and
rubric, which holds across every row here.

### qwen3.5:9b, the judge added this session

Registered 2026-09-02 against the Ollama server at `http://192.168.1.9:11434/v1`.
`CalibrationRun cmtkub3ym00017h4xf68aguqh`.

```
accuracy (rawAgreement)  0.8571428571428571   (24/28)
kappa                    0.7128205128205124
verdictCount             28   (2 items failed)
constant floor           15/28 = 0.5357   DERIVED — v2l is not deployed
margin over floor        +0.3214
verdict marginal         15 A / 13 B — an exact match to the scored subset's key marginal
disagreements            4, symmetric: 2 × (expected A>B, said B), 2 × (expected B>A, said A)
compute                  151m total · mean 5m02s · p50 3m51s · p90 7m05s · max 15m00s
truncations              ZERO. Closest to budget: 6,558 estimated tokens = 80% of 8192
                         (DERIVED at 3.64 chars/token, ±10% — see §5.2 for what a wrong
                          constant does to exactly this figure)
```

**Why 8192, and not 6144 and not 12288.** A pre-registration probe measured ~11.9 tok/s. The largest
completed item consumed ~6,558 estimated tokens — **107% of the abandoned 6144 budget**, i.e. it
would have truncated there, and it completed cleanly at 8192. In the other direction, 12288 tokens
needs ~1021 s at 12.03 tok/s against a 900 s hard cap, so it does not fit. Both estimated-token
figures are **DERIVED at `CHARS_PER_TOKEN = 3.64`, ±10%** (`src/lib/calibration/token-accounting.ts:75`)
— not measured, and see §5.2 for what happens when that constant is wrong.

> **Provenance caveat on 12.03 tok/s, which changes nothing about the decision.** That figure is
> pooled `Σ estimatedGeneratedTokens / Σ latency` over the **15** judgments that had completed at the
> moment it was measured (2026-09-02). It was written up as being over "ordinal 2's completed
> judgments", which reads as all 28 and was not. Recomputed on 2026-09-03 over all **28** completed
> judgments it is **12.613 tok/s** (Σ outputTokens 3951, Σ reasoning chars 318,940, Σ latency
> 7,259,999 ms). 12288 / 12.613 = 974 s — 975 s at the rounded **12.61** the spec publishes, the same
> measurement to one more decimal place, not a second one — still over the 900 s cap either way, so
> the sizing conclusion holds on either denominator. Quote the number with its `n`.

---

## 3. What shipped

25 commits, `fc9e936..HEAD` (`e167f5b`). They are in two waves and **the difference between them is
the difference between committed and running.**

### Wave 1 — 9 commits, PROMOTED and live as `sha-5e48187cfb3a`

Pushed to `gitea/main`, built, Harbor tag asserted, promoted via homelab PR #952 (merge `5884ed4`),
Flux applied, both deployments rolled clean with 0 restarts.

| commit | what |
|---|---|
| `7e769c1` | fix(llm): a timeout `ProviderError` escapes `withRetry` on the first throw |
| `9defdd4` | ci(harbor): assert a registry artifact exists for a tag |
| `c3bcd40` | ci(build-push): assert the Harbor tag after the kaniko Job completes |
| `270dc50` | ci(status): read a commit's outcome from Gitea's record, not the pod log |
| `ba0b686` | docs(ci): the false green was a cancelled run, not an OOM — say so in `ci.yml` |
| `e103d43` | docs(ci): correction — the 2026-09-01 false green was a cancelled run, not an OOM |
| `80fc4ab` | feat(worker): consumer-loss policy — log once, flush, exit 1 |
| `20fc4fc` | fix(worker): exit on AMQP consumer loss so `restartPolicy` re-registers |
| `5e48187` | docs(worker): the consumer-loss defect is closed by exiting |

**`20fc4fc` does not fix the reconnect.** It replaces a silent zombie — 1/1 Running, 0 restarts, 0
consumers, five days in August — with a **visible, bounded restart**. The cost is that a flapping pod
is now the symptom; the gain is that the failure can no longer be silent. It unblocks homelab PR
#932.

### Wave 2 — 16 commits, LOCAL ONLY

`refs/heads/main` is `e167f5b`; `refs/remotes/gitea/main` is `5e48187`. Nothing below is on any
remote, in Harbor, or in production.

| commit | what |
|---|---|
| `a96cf94` | refactor(llm): extract the sampling resolver into a leaf module |
| `33b7be4` | feat(calibration): **v2k** — the run snapshots the sampling config it ran under |
| `a272519` | feat(llm): name a repetition loop as a loop |
| `0a6669e` | docs(llm): the truncation message has two endings now |
| `e438da2` | feat(calibration): `outputTokens` does not always count the reasoning channel |
| `0bd6b6b` | feat(calibration): warn when a judgment's estimated generation nears `max_tokens` |
| `db5bff9` | docs(calibration): correct the tok/s formula and the throughput envelopes |
| `1806e7f` | feat(calibration): `reasoningTokens` is usage-reported — report reasoning length instead |
| `781bf58` | feat(llm): record `parseMode` on pairwise judgments |
| `1ef04ab` | feat(calibration): the constant-verdict floor as a pure function, per denominator |
| `712301b` | feat(calibration): **v2l** — score emits and stores the constant floor beside accuracy |
| `f78d90c` | feat(calibration): print the constant floor and margin beside accuracy |
| `c5513d9` | feat(calibration): pooled output throughput per judge, via `accountTokens` |
| `58139bb` | feat(calibration): the stacked-limits rule — `max_tokens` against the hard cap |
| `c5e84f3` | feat(calibration): warn at launch when `max_tokens` cannot fit the hard cap |
| `e167f5b` | docs(calibration): register §5.6/8 done — the stacked-limits check is code |

**Two migrations are in Wave 2 and production is at neither:**

| migration | column | type |
|---|---|---|
| `20260901180000_v2k_calibration_sampling_snapshot` | `CalibrationRun.samplingParams` | JSONB, additive, nullable |
| `20260901190000_v2l_calibration_constant_baseline` | `CalibrationRun.constantBaselineAccuracy` | DOUBLE PRECISION, additive, nullable |

Both are additive and nullable, so applying them is not a breaking change. **When v2k is applied, 11
rows hold NULL, not 9** — both qwen3.5:9b ordinals were launched on a pre-v2k image, and there is
deliberately no backfill, because a snapshot invented after the fact is not a snapshot. The v2l
column is NULL on every existing row until each is re-scored with `--score-only` on a v2l image; that
is an operator write, not a migration step.

**New modules** (all Wave 2 except the two `scripts/ci/` files, which are Wave 1):
`src/lib/llm/sampling.ts`, `src/lib/llm/degeneration.ts`, `src/lib/calibration/token-accounting.ts`,
`src/lib/calibration/baseline.ts`, `src/lib/calibration/reasoning-length.ts`,
`src/lib/calibration/sampling-drift.ts`, `scripts/ci/assert-harbor-tag.sh`, `scripts/ci/ci-status.sh`.
All eight exist on disk at `HEAD`.

**Uncommitted, and easy to lose.** `git status` on 2026-09-03 shows two **modified, uncommitted**
files — `docs/superpowers/plans/2026-09-01-scoreboard-handoff.md` and
`docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md` — which is where the §7
status block and the spec's corrections live. **Nine** documents under
`docs/superpowers/plans/` are **untracked** (`??`) as of 2026-09-03 — the eight dated 2026-09-01,
including the two named in §7 as authored-but-not-executed, **and this handoff itself**
(`2026-09-03-wave1-wave2-handoff.md`). They exist on this workstation and in no clone.

---

## 4. Suites and gates

```sh
npm run lint             # eslint src/ prisma/ scripts/ tests/  — 0, no warnings
npx tsc --noEmit         # 0
npm test                 # 1002 unit         (61 files)
npm run test:db          # 679 db            (46 files) — resets the TEST database, see trap 1
npm run test:integration # 82                (11 files)
npm run build            # clean
npm run test:coverage    # per-glob floors; exit 0 required
```

The numbers above were measured on `HEAD` (`e167f5b`) by the orchestrator at the end of the session.
**The session started at 869 unit / 670 db / 80 integration** (55 / 46 / 10 files) — all six of those
figures printed in the [2026-09-01 handoff](./2026-09-01-scoreboard-handoff.md) §4, which is that
session's end and therefore this one's start. The deltas —
+133 unit, +9 db, +2 integration, +6 unit files, +1 integration file, 0 new db files — are
subtraction of two printed pairs, not a measurement of their own.

**Use the printed number, never an arithmetic one.** `869 + 3 = 872` is a guess; an unexplained delta
between the predicted and the printed count is a finding, not rounding.

`npm run test:db` runs `prisma migrate reset --force` against whatever `.env.test` points at, and it
is not concurrency-safe — see traps 1 and 15.

---

## 5. Corrections — what this session got wrong

### 5.1 The throughput envelopes were "understated ~2.2×" — a double count, and wrong

While working the token-accounting item I claimed, in writing, that **every** recorded throughput
envelope was understated by ~2.2×:

> "Qwen3.6 31.3 → 67.4 tok/s, granite4.2 35.1 → 78.3 tok/s"

**That is wrong.** The correction to `outputTokens` is that on *some* servers the provider's
completion-token count excludes the reasoning channel. Where it already includes reasoning, adding a
chars-derived estimate of the reasoning channel on top **counts the reasoning channel twice**.

The discriminator is (reasoning + content) characters per `outputTokens`. Where the model's own
tokenizer is doing the counting that ratio lands at ordinary prose density, 3–4 chars per token; where
the count excludes reasoning it explodes. Measured per judge:

| judge | (reasoning + content) chars / `outputTokens`, with its `n` | reading |
|---|---|---|
| Qwen3.6-35B-A3B | **3.76** (n=145) | already complete — do not add |
| granite4.2:3b | **3.87** (n=40) | already complete — do not add |
| qwen3.5:9b | **78.96** (n=20 — all 9 completed at 6144 plus the first 11 at 8192, taken mid-run; **82.28** over all 37) | content only — the count **excludes** reasoning |

**So Qwen3.6's and granite4.2's published rates were correct and do not move. Only qwen3.5:9b's was
wrong: 0.54 tok/s raw against 12.03 tok/s pooled-and-derived**, a ~22× gap, and the difference
between a `max_tokens` budget that fits the 900 s hard cap and one that cannot. That is exactly what
`accountTokens()` (`src/lib/calibration/token-accounting.ts`) now discriminates, via
`REASONING_EXCLUDED_RATIO = 8`, and `db5bff9` corrected the runbook §8.6 formula accordingly.

> **Provenance note on 78.96.** Re-measured on 2026-09-03 over completed judgments the same ratio
> reads **85.36** for ordinal 2 alone and **82.28** pooled over both qwen3.5:9b ordinals, computed
> against `rawResponse::text` as the content channel. The spread is which content field and which
> population, not a disagreement: every value is an order of magnitude above the threshold of 8, so
> the classification — *this count excludes reasoning* — is identical under all of them. It is a
> classifier input, not a published rate; do not quote it to two decimal places without saying which
> population it came from.

**The generalisable form:** a correction that is right for one member of a population is not right
for the population. Before applying a multiplier everywhere, measure the discriminating ratio on each
member — the whole reason it is a correction is that the servers disagree.

### 5.2 A truncation figure inflated from 82.4% to 98% of budget by the wrong constant

The memo that motivated the truncation-proximity work reported an item at **"~6023 tokens — 98% of
budget"**. That number is wrong, and it is wrong in the direction that makes the finding look more
urgent than it is.

The item is real and unambiguous: `outputTokens 115`, `length(reasoningContent) 18019`,
`max_tokens 6144`, `finishReason 'stop'`. The arithmetic:

| constant | derivation | estimated tokens | % of 6144 |
|---|---|---|---|
| 3.05 chars/token | `115 + 18019/3.05` | 6,023 | **98.0%** |
| **3.64 chars/token** | `115 + round(18019/3.64)` | **5,065** | **82.4%** |

**3.05 is the *content*-channel figure**, taken from an ad-hoc Ollama A/B (`598 chars / 196
completion_tokens`). The reasoning channel is denser prose and measures 3.5–3.9 in production, which
is where `CHARS_PER_TOKEN = 3.64` comes from — the mean of two measured populations, written as the
literal `3.64` rather than `(3.52 + 3.76) / 2` so that it cannot silently drift with a re-measurement
of either. Do not use 3.05 on a reasoning channel.

**The gap between 82% and 98% is exactly this constant's error bar**, and both are above the 80%
`TRUNCATION_PROXIMITY_WARN` threshold, so the deliverable was unaffected — which is the only reason
this cost nothing beyond the time to find it. The report prints `outputTokens` and `reasoningChars`
on the same line precisely so an operator can re-derive under any constant, and the line ends
`(DERIVED at 3.64 chars/token, ±10%)` so the estimate never reads as a measurement.

### 5.3 The previous handoff's own CI root cause was wrong

The 2026-09-01 handoff's trap 3 stated:

> "`next build` was OOM-killed against the runner's `limits.memory: 4Gi` and no image reached
> Harbor" … "CI reports `🏁 Job succeeded` on a build it marked `❌ Failure`"

**There was no OOM.** Gitea 1.23.6 calls `CancelPreviousJobs` on every push to the same ref and
cancelled run 51 / task 4816 server-side; `7f0e0cb` was authored 28 s before the kill. `this step has
been cancelled: signal: killed` is the string act v0.261.10 prints only when the step's context is
cancelled — never on a kernel OOM — and the `🏁 Job succeeded` that follows appears in the **runner
pod log only**, because act's `job_executor.go` swaps in a fresh context and loses the job error.
Gitea's own record was never green: task `cancelled`, all three commit statuses "Has been cancelled".
The runner had `restartCount 0` and no `OOMKilled` state, and the identical signature recurred on
task 4818 — a kubectl polling loop with no Node process in it at all, which cannot OOM a 4Gi limit.

**Two prescriptions were therefore aimed at an event that did not happen:** the 2026-08-30 register's
"raise the runner limit or bound Next's static-generation workers", and "make the job fail when a
step fails" — nothing in `ci.yml` swallowed a failure. **Do not retune the runner or `NODE_OPTIONS`
on this evidence.** "Passed again on retry" was also wrong: `d21f31d` was a new push whose run was
simply not cancelled, and `60be6f6` was never rebuilt.

This correction was written on 2026-09-01, from the Gitea tasks API rather than the pod log. It is
restated here because the OOM version is still the one that gets repeated, and because two commits of
Wave 1 (`ba0b686`, `e103d43`) exist only to put the correction next to the claim in `ci.yml` and the
docs.

**A second, different failure hides under the same symptom.** `2c1e85e` and `740e7bb` have no image
because they **never had a run at all** — neither was the head of its push. Cancelled and never-ran
are indistinguishable from Harbor and are separated only by Gitea's record:
`bash scripts/ci/ci-status.sh <sha>` exits 2 for never-ran and 1 for ran-but-no-image. **Push one head
at a time.**

---

## 6. Traps, each of which cost something

Continuing the 2026-09-01 handoff's list, which ends at 9. Traps 1–9 there are all still live; trap 1
(`judge-arena-pg` podman vs `judge-arena-pg-1` in k8s, one character apart) and trap 7 (the NUL bytes,
which are **still in the tree** at `src/lib/calibration/readings.ts:164` and
`scripts/importer/reconcile.ts:294` — use `grep -a`, never "fix" them) are the two most likely to
bite on day one.

10. **`git commit --only <path>` refuses untracked paths.** A revision pass produced a commit form
    that provably cannot execute: `error: pathspec ... did not match any file(s) known to git`. The
    working form, verified: `git add <paths>` and then `git commit --only <paths>` — which still
    keeps a foreign pre-staged file out of the commit *and* works for new files. It cost a revision
    round to find because the plan's own verification step never ran the command.

11. **`helm template` does NOT strip `#` comments.** A plan proved a comment-only chart edit was safe
    by asserting the rendered output was byte-identical before and after. Comments pass straight
    through to stdout, so the diff is non-empty on **correct** work — the check red-gates the thing
    it is supposed to pass. Worse, its injection (change a real field, observe a non-empty diff)
    could not discriminate, because the diff was already non-empty. Diff with comment lines excluded.

12. **A per-line regex misses the multi-line form.** A guard asserting a leaf module has no value
    imports used `/^(?:import|export\s.*\sfrom)/` per line. A multi-line
    `export {\n  x,\n} from './registry';` walks straight through: line 1 has no `from`, the middle
    lines are bare identifiers, line 3 starts with `}`. The bundle would have silently regained the
    whole SDK — the entire reason `src/lib/llm/sampling.ts` exists as a leaf module — with every test
    green. Assert on the whole file with type-only statements stripped.

13. **`grep -c name` cannot detect a rename to `nameX`.** A doc-injection check renamed the export
    and expected the count to drop; substring matching kept it identical, so the injection proved
    nothing. `grep -cw` works.

14. **A test can be green against a broken implementation when the fixture bypasses the broken
    path.** The budget-warning defect survived two review rounds and a confirmation because its
    fixture passed `{tokPerSec: 11.9}` straight into the downstream function and never called the
    broken one. **The question to ask of every verification step is: what exact wrong implementation
    would still pass this?** If you cannot name one concretely, the step is not discriminating. The
    same rule catches an assertion with no injection behind it — a `toBe` identity check pinning "one
    resolver, not a copy" had no injection that reddened it, so the most likely mis-execution
    (copying the function instead of re-exporting it, leaving two divergent definitions) would have
    passed every suite.

15. **Mass `Test timed out in 5000ms` across unrelated db files is a stopped podman container, not a
    regression.** Postgres alone is not enough — code paths touching redis or rabbitmq hang to the
    5 s default. It reproduces identically on re-run, which is what makes it look deterministic and
    real. Related and distinct: **the db suite is not concurrency-safe**, one shared
    `judge_arena_test`, so a parallel `test:db` produces uniqueness/idempotence/FK failures that read
    exactly like a regression. Serialize, and re-run the failing files alone before concluding
    anything.

16. **The working tree is shared and not isolated.** All of this session's work happened in
    `/root/judge-arena` itself, so committed work, two modified-but-uncommitted docs and **nine**
    untracked plan documents coexist in one index. That is why trap 10 matters: `git commit -a` or a
    bare `git commit` here sweeps in whatever a parallel piece of work left staged. Scope every
    commit to explicit paths, or use a worktree.

17. **`if: always()` steps do NOT run after a server-side cancel.** act SIGKILLs the step and goes
    straight to cleanup, so a cleanup step promising to reap a spawned Job silently does not — which
    is the same mechanism as §5.3 and means a cancelled run also never reaches the Harbor assert in
    `build-push`. The in-repo assert structurally cannot catch the case that produced open item #6.

---

## 7. Open, in priority order

The register lives in
[`2026-08-30-state-and-next-steps.md` §5.5–5.6](./2026-08-30-state-and-next-steps.md); the
2026-09-01 handoff's §7 now carries a per-item status block. Nothing there was deleted or rewritten —
every closed item keeps the text of what was believed at the time and carries a **DONE** marker
naming the commit, per CONTRIBUTING.md:1653-1656.

**Closed this session, all in the tree:** #1 (v2k, `33b7be4`), #2 (v2l, `1ef04ab`/`712301b`/`f78d90c`),
#3 (`a272519`), #4 (`20fc4fc`, Wave 1, promoted), #6 (`9defdd4`/`c3bcd40`/`270dc50`, Wave 1,
promoted), #10 (`1806e7f`), #11 (`781bf58`), U1 (`c5e84f3`), U3 (`7e769c1`, Wave 1, promoted), plus
one item that did not exist when the list was written — `outputTokens` undercount and
truncation-proximity blindness (`e438da2`/`0bd6b6b`/`db5bff9`). **Only #4, #6 and U3 are running.**

Still open, in the order a leaderboard needs them:

**#5 — `judge.dlq` holds 10 messages, has no consumer and no replay verb.** It grew from 4 during
ordinary operation, so it is an accumulating sink, not run-1 residue, and it read 10/0 at every check
this session. **Blocked on execution, not on design:**
[`2026-09-01-dlq-admin-cli.md`](./2026-09-01-dlq-admin-cli.md) is authored and reviewed and was not
executed — no file in `fc9e936..HEAD` touches the DLQ path. **That plan is untracked**, so it exists
on this workstation and in no clone; commit it before anything else.

**#7 — zero human judgments.** `HumanJudgment` is 0 rows on `judge-arena-pg-1`, measured 2026-09-03.
**Blocked on a person, not on code.** No commit can close it, and scoring more judges widens §2
without touching it.

**#8 — no frontier reference line.** All three Anthropic judge model versions still have 0
calibration runs; all 11 runs are against the four self-hosted models. **Blocked on an API key and
the spend it implies.**

**#9 — one rubric, one protocol, one set.** Everything is pairwise under General Quality Assessment
on 30 items. Nothing is known about pointwise, other rubrics, or whether a judge is *good* versus
*suited to this set* — and κ is not comparable across sets, which is the whole point of a scoreboard.
**Not blocked on anything external; it is unstarted, and no plan is authored for it.** This session
added a fifth row, not a second column.

**U2 — the finalizer never revisits a terminal run.** **Blocked on execution, not on design:**
[`2026-09-01-finalizer-error-to-needs-human.md`](./2026-09-01-finalizer-error-to-needs-human.md) is
authored and was not executed — no file in `fc9e936..HEAD` touches the finalizer. Untracked, same as
the DLQ plan.

**U4 — `toCandidate` stamps `label: null`** (`src/lib/golden-sets.ts`), so the studio shows Option 1 /
Option 2 against an `A>B` answer key. Untouched this session. It is a prerequisite for #7 being worth
a person's time.

**U5 — no UI for the agreement route** (`src/app/api/golden-sets/[id]/agreement/route.ts`). Untouched
this session.

---

## 8. Starting the next session

```sh
# 0. What is running — the live object, not the manifest. (§1)
kubectl -n tenant-public get deploy judge-arena-web judge-arena-worker \
  -o custom-columns='NAME:.metadata.name,IMAGE:.spec.template.spec.containers[0].image,READY:.status.readyReplicas'
kubectl -n tenant-public logs deploy/judge-arena-worker --tail=30 | grep 'judge worker started'
```

### 1. Promote Wave 2 — everything else in this section waits on it

```sh
# a. Push. ONE head at a time — a second push cancels the first run server-side (§5.3, trap 17).
git -C /root/judge-arena push gitea main

# b. Read Gitea's record, not the pod log. exit 2 = never ran, 1 = ran but no image.
bash /root/judge-arena/scripts/ci/ci-status.sh $(git -C /root/judge-arena rev-parse main)
skopeo inspect --no-tags \
  docker://harbor.cluster.asethi.com/homelab/judge-arena:sha-$(git -C /root/judge-arena rev-parse main | cut -c1-12)

# c. PROMOTE. Nothing in THIS repo deploys an image — README.md:102, "Nothing deploys that
#    image." The authoritative tag is a hand-edited field in the homelab-setup repo:
#      apps/public/judge-arena/helmrelease.yaml   spec.values.image.tag: sha-<12>
#    It reads sha-5e48187cfb3a today. Set it to the sha asserted in (b), open and merge the
#    PR (Wave 1 went as homelab PR #952, merge 5884ed4), then:
flux reconcile kustomization judge-arena -n cozy-fluxcd --with-source
kubectl -n tenant-public rollout status deploy/judge-arena-web deploy/judge-arena-worker

# d. Only now do the migrations exist. The chart's pre-install,pre-upgrade hook Job
#    (homelab-setup/charts/judge-arena/templates/migrations-job.yaml) runs `prisma migrate
#    deploy`, and a helm upgrade is the ONLY thing that fires it — a push and a Harbor tag
#    apply nothing. Confirm the columns landed BEFORE trusting any query that selects them;
#    today this returns zero rows, and such a query ERRORS rather than returning NULL.
kubectl -n tenant-public exec judge-arena-pg-1 -c postgres -- psql -U postgres -d judge_arena -tAF'|' -c \
  "SELECT column_name FROM information_schema.columns WHERE table_name='CalibrationRun'
     AND column_name IN ('samplingParams','constantBaselineAccuracy');"
```

Also commit the untracked work before pushing: **nine** documents under
`docs/superpowers/plans/` — the eight dated 2026-09-01 **and this handoff itself**, which is
otherwise the one file in this section that exists in no clone — plus the two
modified-but-uncommitted docs named in §3. Scope the commit to explicit paths (`git add <paths>`
then `git commit --only <paths>` — trap 10 and trap 16).

### 2. The granite4.1:3b regression re-run — the first thing to do once Wave 2 is live

**`781bf58` is the first change ever to write `parseMode` on the *pairwise* path — the path every
calibration runs on.** Parse *output* is supposed to be unchanged. The cheapest way to find out is
already sitting in the ledger.

Two `granite4.1:3b` runs 14 hours apart — `cmtht0o9d00017b21kvmnvga0` (2026-08-31 22:22) and
`cmtimse5m00012b0sk08rwl4f` (2026-09-01 12:16) — produced **bit-identical verdicts on all 30 items**
(30/30 compared, 30 identical; both scored 0.5000 with κ 0.1295938104448742). At `temperature: 0.3`
the sampler does not guarantee that, so this is **evidence about the whole path — prompt assembly,
item ordering, pair ordering, parsing — not just the model.** It costs **~108 seconds of judge time**,
which makes it the cheapest regression signal this product has, and `781bf58` is exactly the kind of
change that could move it.

```sh
# After the Wave 2 image is promoted. Whole run, at its REGISTERED max_tokens: 4096 —
# the runbook does not permit changing max_tokens mid-run, and granite4.1's
# JudgeModelVersion samplingDefaults already reads {"max_tokens": 4096, "temperature": 0.3}.
kubectl -n tenant-public exec deploy/judge-arena-web -- node /app/calibration-run.js \
  --golden-set=cmt057hd001g17y01lhjzgfuj \
  --judge-version=cmthszzng00027b0sevegsum6 \
  --poll-timeout=600
```

Then compare the new run's per-item verdicts against `cmtimse5m00012b0sk08rwl4f`. Do not eyeball 30
rows; the comparison is one query, and **zero rows out means bit-identical on all 30 items**:

```sh
# Verified read-only on 2026-09-03: run against the TWO HISTORICAL runs
# (cmtht0o9d00017b21kvmnvga0 and cmtimse5m00012b0sk08rwl4f) it returns zero rows,
# which is the 30/30 result this check is trying to reproduce.
kubectl -n tenant-public exec judge-arena-pg-1 -c postgres -- psql -U postgres -d judge_arena -tAF'|' -c "
SELECT COALESCE(o.gi, n.gi) AS item, o.v AS old, n.v AS new
  FROM (SELECT er.\"goldenItemId\" gi, mj.verdict v FROM \"EvaluationRun\" er
          JOIN \"ModelJudgment\" mj ON mj.\"runId\" = er.id
         WHERE er.\"calibrationRunId\" = 'cmtimse5m00012b0sk08rwl4f') o
  FULL JOIN (SELECT er.\"goldenItemId\" gi, mj.verdict v FROM \"EvaluationRun\" er
          JOIN \"ModelJudgment\" mj ON mj.\"runId\" = er.id
         WHERE er.\"calibrationRunId\" = '<new run id>') n ON n.gi = o.gi
 WHERE o.v IS DISTINCT FROM n.v;"
```

**A differing verdict has a real cause and must be chased before anything else lands** — do not
average it away, do not re-run until it agrees, and do not attribute it to temperature without
showing that the two historical runs disagreed too. If the run comes back 30/30 identical, `781bf58`
is clear on the path that matters and the rest of Wave 2 can be exercised.

### 3. Backfill the scoreboard's floor column, once v2l is live

```sh
# Idempotent, no provider call, no judgment re-executed. Per run id.
kubectl -n tenant-public exec deploy/judge-arena-web -- node /app/calibration-run.js \
  --score-only=<calibrationRunId>
```

**Do NOT run this on the VOID run `cmtkt3sg200017h3tlf87khhn`.** `scoreCalibrationRun` overwrites
`rawAgreement`, `kappa` and `verdictCount` in a single `update` whose own comment is *"Same
full-overwrite rule as everything here"* (`src/lib/calibration/score.ts`), and `--score-only` takes
any run id with no void guard (`scripts/calibration/run.ts`). That run still holds **9 completed
judgments with verdicts** (measured 2026-09-03), so re-scoring it would compute an aggregate over
them and undo the NULLing described in §1 — the phantom result would be back, and this time it would
look like it came from v2l. **Re-score the other 10 runs only; the void run keeps its NULLs by
hand.** Until that is done, every floor in §2 stays hand-derived.

### 4. The scoreboard as the database holds it

Never from a doc, and never joining to `JudgeModelVersion.samplingDefaults` for the config — that
reports *today's* config for a historical run, and Qwen3.6's registered default has already moved to
12288. After v2k, `cr."samplingParams"` is the launch-time snapshot; the nested `DISTINCT` is the
fallback for the 11 rows launched before it, and it **errors** with "more than one row" on a run whose
config moved mid-run, which is the right outcome. The query is in the 2026-09-01 handoff §8 — **it
will error today**, because it selects two columns that do not exist yet.

**To score another judge**, follow
[`docs/runbooks/scoring-a-judge-against-a-golden-set.md`](../../runbooks/scoring-a-judge-against-a-golden-set.md).
Its §8.6–8.8 are the ones that save time. **Two rows of its capture table are Wave 2 and were not
corrected there** (they are outside this session's edit scope, and fixing them is the cheapest item
on the next session's list): the `parseMode` row says *"NULL on pairwise rows written before
2026-09-01; `structured`/`fallback` after"*, and the `samplingParams` note says the header column is
present with NULL "on runs launched before v2k". Neither is live — `781bf58` and `33b7be4` are in
the tree only, `parseMode` is NULL on **330 of 330** rows, and the header column does not exist. If
you group on `parseMode` in psql after promoting and find NULL everywhere, the promote did not fail;
the rows predate it. **Before registering one**, score a single item and read
`outputTokens`, `reasoningContent` length and `latencyMs` — and run the ratio in §5.1 before dividing
anything, because on an Ollama server `outputTokens` may not be counting the reasoning channel at
all. `max_tokens / tok_per_s` must fit under the 900 s hard cap, and **throughput decays with output
length**, so the linear estimate is a lower bound on duration, not an estimate.

---

## 9. Process findings — do these, don't just note them

1. **Run a confirm pass scoped to exactly what a revision touched, every time.** Revision passes
   introduced blocking defects in **4 of 4 cases** this session: an arithmetic error inside the
   sentence added to prevent arithmetic errors; a `git commit --only <untracked path>` form that
   provably cannot execute; an assertion that does not type-check under `strict`. "Findings applied"
   is not "plan correct". The scoped confirm phase is what caught all four.

2. **Re-read every remaining plan against a plan that has just landed.** Cross-plan conflicts are
   invisible to per-plan review, and two near-misses were findable no other way: an insertion that
   would have gone *inside* a CORRECTION note, because the sentence it anchored on now survives only
   as a quotation; and a throughput formula ~20× wrong for its own target judge, because the plan
   that fixed that exact defect landed hours after it was written.

3. **Name the wrong implementation your verification step would still pass, before you accept the
   step.** A test can be green against a broken implementation when the fixture bypasses the broken
   path — the budget-warning defect survived two review rounds and a confirmation for exactly this
   reason (trap 14). If you cannot name a concrete mis-execution the step catches, the step is
   decoration.

4. **Open the cited location before applying any review finding.** Three reviewer findings this
   session were wrong on the facts: a line number that was correct as written, a "dangling reference"
   that named both siblings explicitly, and a claim about which lines a block spanned. **Skipping a
   finding with evidence is a correct outcome; applying an unverified one introduces the defect.**
