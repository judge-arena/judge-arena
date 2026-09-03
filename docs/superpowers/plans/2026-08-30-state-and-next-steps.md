# State and next steps — 2026-08-30

**Supersedes the *status* of `2026-08-17-a1-a15-complete-handoff.md`.** That document remains the
right place for the traps (§4) and the method notes; its §1–§3 have been corrected in place rather
than duplicated here. Read it after this.

**Everything below was verified against the tree, the remote or the live cluster on 2026-08-29/30.**
Nothing is carried forward from an earlier document. Three things that every prior handoff asserted
turned out to be false, and they are called out as corrections rather than quietly replaced.

---

> **SUPERSEDED FOR STATUS, 2026-09-01.** The current state of the world, the scoreboard, the traps
> and the prioritised open list are in
> [`2026-09-01-scoreboard-handoff.md`](./2026-09-01-scoreboard-handoff.md). **This document's §5.5
> and §5.6 follow-up registers remain the canonical list of open items** and are referenced from
> there; its corrections and traps are still accurate. Read the handoff first, then this.

## UPDATE 2026-09-01 — THREE JUDGES SCORED, AND A SCOREBOARD TO PUT THEM ON

**The two update blocks below remain accurate; this is the delta on top of both.**

Production is at **`sha-414e826a3ba3`**. Nine calibration runs now exist across **three distinct
judge models** on two inference servers. The full ledger, the per-model throughput envelopes, and the
traps that will corrupt a leaderboard built from them are in
[`docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md`](../specs/2026-09-01-judge-scoreboard-and-model-envelopes.md).

**The headline, and it is not the top score.** On this golden set a judge that stamps `A>B` on every
item scores **0.5667**, because the answer key is 17/13. `granite4.1:3b` scored **0.5000** — *below*
the constant. An accuracy that reads as a weak-but-real signal was in fact worse than a stamp, and
nothing in the report says so, because the floor is never computed. That is now follow-up §5.6/7 and
it is a display bug with real consequence: the leaderboard's whole job is to rank, and it currently
cannot tell "learned a little" from "learned nothing and guesses A".

**The best recorded result is Qwen3.6-35B-A3B at `max_tokens: 12288` — accuracy 0.8667, κ 0.7285,
30/30.** Raising the budget from 8192 both eliminated truncation *and* improved accuracy, which is
the ordinary result that a reasoning model given headroom uses it. On 30 items that is one extra
correct item; treat it as directional, not significant.

**Two structural findings outrank both numbers:**

1. **`CalibrationRun` does not snapshot the sampling config.** Editing a judge's `samplingDefaults`
   silently rewrites what the obvious join reports about *past* runs. §5.6/6.
2. **`max_tokens` and the timeout are stacked limits.** Fixing truncation on granite4.2 by raising
   the budget to 12288 exposed a 300 s wall underneath it — the model emits ~35 tok/s, so the budget
   was unreachable by construction. This is what forced the escalating-timeout promote mid-session.
   §5.6/8, and runbook §8.6.

**One thing worth carrying forward as method:** two `granite4.1:3b` runs 14 hours apart produced
**bit-identical verdicts on all 30 items**. That is a reproducibility check on the whole path —
prompt assembly, ordering, parsing — for 108 seconds of compute. Re-run it after any change to those.

---

## UPDATE 2026-08-31 — A2.1 SHIPPED, AND THIS PRODUCT PRODUCED ITS FIRST NUMBER

**Everything in §§0–6 below was true on 2026-08-30 and is left as written.** This section is the
delta, and it contains one correction to the *ordering* this document recommends, which is more
important than the news.

**The news.** A judge model was scored against a golden set in production for the first time. Five
commits, all on `main`, and **all five promoted to production at 21:29Z on 2026-08-31**, part-way
through the writing of this section (see §7.7 — the earlier reading is kept):

| | |
|---|---|
| `ae0d4a7` | the calibration substrate: migration `v2i`, `src/lib/calibration/{launch,score,readings}.ts`, prompt + reasoning capture, the truncation guard |
| `e4b9948` | the runner and the judge-registration CLI, bundled into the image |
| `c641786` | `.dockerignore` excluded `scripts/calibration/` — `e4b9948`'s image built **successfully** and shipped without the script it existed to ship |
| `cb2fc37` | `missingVerdicts` reported `0` while four items had dead-lettered |
| `1e7a427` | in-flight judgments hard-capped at 1 |

**THE BASELINE LANDED, AND IT IS 0.8333 — 25 OF 30.** `CalibrationRun`
**`cmthr58r100013s0sykuvn41x`**, sequential, **all thirty items completed**, zero errors, zero
dead-letters; kappa **0.6575** (`cohen`/`none`); **21m53s** wall clock; latency **avg 42.6s / min
16.1s / max 95.1s**. §7.2's placeholder is filled in below. **The durable record — both runs side by
side, the storage footprint, the concurrency lesson and the Ollama finding — is
`docs/superpowers/specs/2026-08-31-calibration-baseline-and-footprint.md`**; the operational path for
someone who has never run one is `docs/runbooks/scoring-a-judge-against-a-golden-set.md`.

**A SIXTH COMMIT LANDED AFTER THE PROMOTE AND IS NOT IN IT.** `b42972e` (*Ollama is judge-eligible —
the reason it was refused was never true*) was committed at **21:45:59Z**, sixteen minutes after the
21:29Z promote of `1e7a427`, and the table above stops at five for that reason. On the last reading
recorded in §7.7 production ran `sha-1e7a427d2c48`. **Ollama is judge-eligible on `main`, not
necessarily in production** — read the running image before planning a run against the Ollama server
at `192.168.1.9:11434`. What the commit found, and why the rule it removed was never coherent, is in
the spec's §6.

**THE CORRECTION, and it is to this document's own §5.** §5 ends *"Only then — A2 … do not write
the A2 spec until E1–E3 have produced real labels."* That was carried forward from the roadmap and
it is **half wrong**, in a way that cost real time: it treated "A2" as one thing.

> **Scoring a model against GROUND TRUTH needs no human labels.** `GoldenItem.expected` arrives with
> the dataset — 17 `A>B` / 13 `B>A` on the 30-item set — and has been sitting in production since
> 2026-08-19. The half of A2 that compares a model to a **human** still waits on E1. The half that
> compares a model to the **answer key** never did, and it has now shipped and run while
> `GoldenLabel` is still `0`.

The gate was real for the wrong scope. Anyone re-reading §5 should read it as: *do not write the
human-vs-model calibration spec until E1–E3 have produced labels* — which is still true, and which
is a much smaller claim than the one that was made.

**E1 IS STILL NOT DONE.** `SELECT count(*) FROM "GoldenLabel";` against `judge_arena` on
`judge-arena-pg-1` returned **`0`** on 2026-08-31, exactly as it did on 2026-08-29 and 2026-08-19.
Nothing in A2.1 touches the OIDC identity mismatch in §2, nothing in it produces a human label, and
nothing in it makes the agreement panel exist. **Do not let "calibration shipped" be read as "E1 is
finished".** The two are independent, and only one of them moved.

---

## 0. If you read one thing

> **E1 was never blocked by missing code. It is blocked by an identity mismatch, and has been since
> 2026-08-18.** Two golden sets, 650 items and two assignments have existed since 2026-08-19. Zero
> labels have. Every document written before today said the blocker was "a person, in a browser,
> ~20 minutes". A person tried, three times, and was refused at the door.
>
> **Still true on 2026-08-31.** `GoldenLabel` = 0. A2.1 shipping does not change this line; see the
> update above for why it did not have to.

---

## 1. What changed on 2026-08-29/30

| | |
|---|---|
| `gitea/main` | `e4164c8` → **`14d75f7`** — merged `feat/assignment-ui-and-random-subset` (`0309a7e`) plus a fixes commit (`ded6e1f`) |
| Production image | `sha-bee1d121ea7d` → **`sha-14d75f7d46de`**, promoted via homelab PR **#936** |
| Migrations | **18, unchanged.** `git diff --name-only bee1d12 14d75f7 -- prisma/migrations/` is empty; the migrate hook logged `No pending migrations to apply` |
| Evaluation pipeline | **Dead for 5 days → alive.** See §3 |
| Branches | 22 local + 17 Gitea branches deleted; Gitea went 20 → 3. Local `main` repointed from an April GitLab artifact to `gitea/main` |
| Worktrees | 10 removed across both repos, **~2.5 GB** reclaimed (root fs 94% → 91%) |

**What the merge shipped.** A1 built the assignments API and A1.5 built the studio; nothing let a
person create an assignment from a browser, so a set could be owned and never labelled. There is now
an assignment panel on `/golden-sets/<id>` with **Assign to me** / **Revoke** and a shortcut into the
studio, `annotatorId`/`assignedById` are projected through `toPublicOwner` (`{id, name}`, never the
email, `null` for a deleted account), and subset selection gained `randomCount`/`randomPercent`
**resolved server-side** — because `DatasetSample.index` is not dense once anything is tombstoned and
there is no `GET` on dataset samples for a client to enumerate live ordinals with.

**Gates at the merge point**, run locally against podman Postgres/Redis/RabbitMQ *and* by Gitea CI
in-cluster: lint 0, `tsc` 0, **594 unit / 641 db / 80 integration**, both coverage gates 0, build 0.
Against the `bee1d12` baseline of 578 / 633 / 80, the deltas reconcile exactly to the tests added.

**Two defects were fixed before merging, both found by review rather than by the suite:**
- `handleRevoke` had **no `catch`**. A rejected fetch escaped as an unhandled rejection while
  `finally` re-enabled the button — a *failed* revoke was pixel-identical to a successful one.
- The test named `randomPercent resolves against the LIVE sample count` **tombstoned nothing**, so
  live count and raw count were the same number and it passed under either. It now hides 20 of 40
  and asserts 5.

**And the two new surfaces were walked in a browser**, because `src/app/golden-sets/**` has no DOM
test environment. Runbook rows 13–18, recorded in `docs/runbooks/studio-manual-verification.md`.
The row worth keeping — one 620-row dataset, N=30, two modes:

```
First 30    0,1,2,3,…,29
Random 30   14,61,62,76,90,121,152,162,165,171,177,179,252,256,261,
            288,309,328,343,363,366,428,439,441,450,479,496,508,519,529
```

Rows 13 and 15 were **not** walked and the recording says so.

---

## 2. THE E1 BLOCKER — read this before trying to sign in

judge-arena's `User` row `cmsj951c30000881a4l63sx4b` (`trijeet@protonmail.com`, admin) — the row that
**owns both golden sets and holds both assignments** — has
`oidcSubject = 26f57dc2-77b6-455b-a939-d897dbdad6ee`.

Authentik has **two accounts sharing that email**:

| Authentik user | uuid |
|---|---|
| `akadmin` | `26f57dc2-77b6-455b-a939-d897dbdad6ee` ← the app row points here |
| `trijeet` | `e8b087cc-b38b-492a-bbb3-b34bdfb50c16` ← this is who signs in |

The provider's `sub_mode` is `user_uuid`, so `sub` **is** the uuid. The 2026-08-07 invite-claim
happened as `akadmin`; every attempt since has been as `trijeet`, matching nothing.
`resolveOidcUser` falls to branch 3, `ALLOW_OIDC_AUTOPROVISION` is absent from the deployment env,
and sign-in is refused. Three `authorize_application|trijeet` events (2026-08-18 21:33:35,
2026-08-19 13:41:28, 13:41:32) are each followed within a second by
`user.login.failed {"reason":"no_match_autoprovision_disabled"}`.

Credentials fallback is impossible: the row's `passwordHash` is `!oidc-managed`, and
`findCredentialsUserByEmail` excludes `!`-prefixed hashes.

- **Fastest path, mutates nothing:** sign in to Authentik as **`akadmin`** — private window, or log
  out of the `trijeet` SSO session first. That sub matches, and akadmin is in `users-primary`, the
  single enabled policy binding on the judge-arena application.
- **Durable fix, one row, an owner decision:**
  `UPDATE "User" SET "oidcSubject"='e8b087cc-b38b-492a-bbb3-b34bdfb50c16' WHERE id='cmsj951c30000881a4l63sx4b';`
  — or consolidate the two Authentik accounts.

> **DO NOT issue a fresh CLI invite, and DO NOT enable `ALLOW_OIDC_AUTOPROVISION`.** Both mint a
> **second, empty** `User` row that owns nothing and gets a hard 403 from the queue on both sets. The
> partial unique index you would expect to prevent it —
> `UNIQUE (email) WHERE "passwordHash" NOT LIKE '!%'` — does not, because the existing hash starts
> with `!`. `docs/runbooks/authentik-oidc-setup.md` recommended exactly these two remedies until
> today; it now leads with this case.

---

## 3. The pipeline was dead for five days, and the code defect is still live

All five queues reported `consumer_count=0` from **2026-08-24T17:55Z until the 2026-08-30 promote**.

The Cozystack v1.6.2 roll recreated `judge-arena-pg-1` at 17:54:57Z. Twenty-one seconds later the
worker logged a burst of `Can't reach database server` and `57P01 terminating connection due to
administrator command`, and then **emitted no log line for five days**. Its socket reconnected — the
AMQP connection was `running` on `server-1` with one channel — but its **consumers never
re-registered**. The pod stayed `1/1 Running` with **0 restarts** throughout. Nothing looked wrong;
nothing alerted.

Rolling the Deployment fixed it: `run.create` and `judgment.execute` are back to `consumers 1`.
(`judge.dlq` and the two `judgment.retry.*` queues sit at 0 **by design** — do not read those three
zeroes as a fault.)

**The defect is not fixed.** The AMQP client re-subscribes only on boot, not on reconnect. Until
that changes, **any** roll of a broker node reproduces this silently. That matters immediately:

> **homelab PR #932** (judge-arena broker zone spread) bounces `server-1`, which is where both AMQP
> connections are homed. **#932 will re-break the consumers and must be followed by a worker
> restart** — or, better, by fixing the reconnect path first.

---

## 4. Corrections to things earlier documents stated as verified

1. **"The M4 seeder created two `PromptTemplate` rows that had never existed in production."**
   Half false. Only **`v1-pairwise`** was new (2026-08-18 14:07:31.432). `v1-legacy` has existed
   since **2026-08-12 17:42:35.664** — its Prisma cuid `cmsqdn8un00006p142rkwzuw1` embeds that
   insertion time, which proves it was not deleted and re-created. *PROMOTING DOES NOT SEED survives
   on `v1-pairwise` alone.*
2. **The operational rule built on it was false and is withdrawn.** "Run the seeder and read its
   output — a 'Created' line means production was behind" does not work: `seedPromptTemplates`
   `upsert`s and then logs `✓ Created prompt template: …` **unconditionally**, and
   `seed-judgebench.ts` opens with `✓ Created dataset: …` the same way. **No log line in the seeder
   is gated on an actual insert.** Only the parenthetical `${created.count} new samples` carries a
   real delta — and `seed-core.ts`, the file the rule named, never prints "Created" at all.
   Use `select name,version,"createdAt" from "PromptTemplate"` before and after instead.
   *(If you fix the seeder: `PromptTemplate` has **no `updatedAt`**, so "branch on
   `createdAt === updatedAt`" is not implementable. Use a `findUnique` first, a `count()` either
   side, or `create` with a P2002 catch.)*
3. **`stable.yaml` had drifted three promotes** and would have rolled production back to a pre-A0
   image from three weeks earlier, across five migrations. Its own header warned about exactly this.
   Fixed and backfilled in homelab PR #936. The general form: **manual promotion is two steps and
   only one is load-bearing at deploy time** — `helmrelease.yaml` changes what runs, `stable.yaml`
   changes what a rollback returns to.

---

## 5. What to do next, in order

> **STATUS REWRITE — 2026-08-31, evening. This ordering is now partly done and partly wrong, and
> those are two different problems.** The four subsections below are left exactly as written on
> 2026-08-30, each with a status banner; the table is the summary, and §5.5 is new.
>
> | Was | Status on 2026-08-31 |
> |---|---|
> | Immediate — unblock E1 | **STILL OPEN. `GoldenLabel` = 0.** Nothing in A2.1 moved it, and nothing in A2.1 needed it to move |
> | Next — AMQP consumers re-register on reconnect | **STILL OPEN** |
> | Next — `toCandidate` stamps `A`/`B` (+ 1300-row backfill) | **STILL OPEN**, and it now collides with the freeze — §5.4 |
> | Then — T5 RabbitMQ metrics | **STILL OPEN, ~5%**, and A2.1 handed it a concrete consumer — §5.5 |
> | Only then — A2 | **HALF DONE, and the gate was half wrong.** A2.1 (model vs **ground truth**) shipped and produced **0.8333, 25/30**. A2.2 (model vs **human**) is still gated on E1, correctly |
> | — | **NEW: five follow-ups discovered en route — §5.5** |
>
> **A2.1 needed no human labels, which is why it shipped past a gate that named it.** It scores
> against `GoldenItem.expected`, which arrives with the dataset and has been in production since
> 2026-08-19. **Do not read "calibration shipped" as "E1 is finished".** The two are independent;
> the one that moved is the one that was never blocked.

### Immediate — unblock E1 (minutes)

> **STILL OPEN on 2026-08-31, unchanged.** `SELECT count(*) FROM "GoldenLabel";` still returns **0**.
> A2.1 does not touch OIDC, does not produce a human label, and does not make the agreement panel
> exist. The freeze described in §5.4 does **not** block this work — labels are deliberately not
> freeze-guarded (`src/app/api/golden-sets/[id]/items/[itemId]/labels/route.ts:36-43`: item *content*
> freezes because that is what a calibration measured; agreement is computed on read, which presumes
> labels keep arriving). **The 30-item set being frozen is not a reason to postpone E1.**

Sign in as `akadmin` per §2, or make the one-row `oidcSubject` fix. Then walk E1 against the
**30-item** set (`JudgeBenchSample — 30 random`), not the 620-item one: `retestIntervalItems`
defaults to 20 and eligibility is intervening-items-only, so 30 clears K and makes blind re-reads
reachable while ≤20 can never produce one. With a single account `testRetest` is the only
reliability number the product can produce.

**Two things will look like bugs and are not:**
- **E1 step 5, "read the agreement panel", has no UI.** `GET /api/golden-sets/[id]/agreement` works,
  but nothing in `src/app/**` calls it. Navigate the signed-in tab straight to that URL and read the
  JSON. It is a missing surface, and it deserves its own work item.
- **Every `GoldenCandidate` has `label IS NULL`** (1300 of 1300), so the studio shows
  "Option 1"/"Option 2" while the verdict control asks for `A>B`/`tie`/`B>A`, with nothing on screen
  saying Option 1 is A. It **is** deterministic — `toCandidate(0, responseA)`, `toCandidate(1,
  responseB)`, queue orders by `position asc` — but an annotator who guesses the other way inverts
  every preference in the session and the corruption is silent. Fix `toCandidate` to stamp `A`/`B`,
  or have the studio letter them.

### Next — the two defects this session found but did not fix

> **BOTH STILL OPEN on 2026-08-31, and the first one is now more expensive.** A calibration that
> loses its consumers mid-drain leaves an **already-frozen** set with a partial denominator and no
> way to repair the run — only to launch a new one. `--score-only` re-scores; it cannot resurrect a
> judgment that was never executed.

1. **AMQP consumers must re-register on reconnect** (§3). Highest value: it is a silent
   total-loss-of-function that no probe sees.
2. **`toCandidate` should stamp `A`/`B`** for pairwise/listwise, plus a backfill for the 1300
   existing rows.

### Then — T5, which gates A2 and is ~5% done

> **STILL OPEN, and A2.1 handed it its first concrete consumer.** `judge.dlq` now holds **four parked
> messages that nothing will ever retry** (§5.5). Depth on that queue is exactly the alert the
> default `/metrics` cannot express — it carries no queue label — so this is no longer a hypothetical
> requirement for `/metrics/detailed?family=queue_coarse_metrics`.

Not one RabbitMQ sample has **ever** been stored in this cluster — VictoriaMetrics returns
`seriesFetched: "0"` for `{__name__=~"rabbitmq_.*"}`, with zero `VMServiceScrape`s and zero
`VMRule`s. Everything the scrape needs already works: `rabbitmq_prometheus 4.2.4` is enabled, both
Services publish `prometheus 15692`, the endpoint answers 2818 lines, and the existing
`allow-external-communication` policy already permits cross-namespace scraping — **no NetworkPolicy
work is needed.** Three corrections to T5 as written: there are **two** brokers now, not three; a
request body size limit **does** exist at the ingress (`proxy-body-size: 50m`); and the default
`/metrics` **carries no queue label**, so the `judgment.execute` backlog and `judge.dlq` depth alerts
are impossible from it — they need `/metrics/detailed?family=queue_coarse_metrics`, where only the
**leader** emits a depth sample.

Interim thresholds, until T5 lands: `homelab-setup:docs/runbooks/backpressure-watchlist.md`.

### Only then — A2

> **STATUS 2026-08-31: A2.1 is DONE and produced 0.8333 (25/30) against ground truth. A2.2
> (model vs human) is not started and remains correctly gated on E1.** The durable record is
> `docs/superpowers/specs/2026-08-31-calibration-baseline-and-footprint.md`.

~~Unchanged: **do not write the A2 spec until E1–E3 have produced real labels.**~~ One question is
worth settling cheaply first — whether `agreement()` is reusable for human-vs-model. It takes
`Reading[] = {itemId, raterId, category}[]`, and a model is just another `raterId`. If that holds,
**A2 writes no statistics code at all**, which is a large enough scope difference to settle before
planning rather than after.

> **CORRECTION 2026-08-31 — the struck sentence was too broad, and A2.1 shipped past it.** It is
> true of the human-vs-model half and false of the model-vs-ground-truth half, which needs no
> `GoldenLabel` at all. See the update at the top of this document and §7 below.
>
> **The open question in this paragraph is now CLOSED, and the answer was yes.** `agreement()` is
> reused **unchanged**: `raterId` is opaque to it, so passing `'ground-truth'` as a rater is the same
> trick `label-readings.ts` already uses for `'round-1'`/`'round-2'`. **A2 wrote no statistics code.**
> One bug was fixed *inside* `agreement.ts` while proving it — see §7 — but no new statistic was
> implemented, and that is exactly the scope difference this bullet existed to settle early.

### 5.4 THE 30-ITEM GOLDEN SET IS NOW FROZEN, IRREVERSIBLY — what that forecloses

`cmt057hd001g17y01lhjzgfuj` (*JudgeBenchSample — 30 random*) has two `CalibrationRun`s against it, so
`isGoldenSetFrozen` (`src/lib/golden-sets.ts:266-272`) answers **true** and will answer true forever.
There is no `frozenAt` column and no unfreeze verb.

**What is foreclosed:**

- **Item and candidate content, `protocol`, and `expected` are read-only.** The item write verbs are
  freeze-guarded (`src/app/api/golden-sets/[id]/items/route.ts:168, :314`) and `PATCH
  /api/golden-sets/[id]` refuses a `protocol` change (`route.ts:154`). A wrong `expected` on this set
  is now permanent — and 0.8333 is measured against it, whatever it says.
- **Deleting the calibrations to release it is impossible** — `EvaluationRun.calibrationRunId` is
  `onDelete: Restrict`. Retiring or tombstoning the set does not release it either.
- **The `toCandidate` A/B stamping backfill collides with this.** All 1300 `GoldenCandidate` rows
  still have `label IS NULL`, and candidates are content — so the fix listed under *Next* above
  cannot be applied to this set through the API. Doing it directly in SQL would edit rows two
  calibrations measured. **Decide that deliberately; do not discover it during a backfill.**
- **The only escape is `POST /api/golden-sets/[id]/fork`**, which makes a new set at version+1 — and
  **a number measured on the fork is not comparable to one measured on the parent**, so forking to
  fix a typo silently costs the baseline.

**What is NOT foreclosed, and this is the part most likely to be misread:**

- **Labelling.** `POST .../items/[itemId]/labels` is deliberately not freeze-guarded. E1 can proceed
  on this set today.
- **More calibrations.** Freezing is idempotent, and a second judge against the same frozen set is
  the normal way to build a comparison — that is what the owner's next ask (Ollama's `granite4.1:3b`
  and `gemma4:26b`) does.

### 5.5 Open follow-ups discovered en route (NEW — none of these existed on 2026-08-30)

1. **`parseMode` is NULL on the pairwise path.** One parse path (`tryParsePairwiseJudgment`,
   fence-tolerant) means no strict→lenient demotion and no mode to persist; the column is meaningful
   only pointwise. **It is not a capture bug, but the gap is real:** on pairwise a leniently-parsed
   verdict and a strictly-parsed one are indistinguishable afterwards. Decide whether to write a
   pairwise-meaningful value or to document the column as pointwise-only.
2. **`reasoningTokens` is unavailable from llama.cpp.** 0/30 on the baseline run, because its `usage`
   payload has no `completion_tokens_details`. **Do not "fix" this by defaulting to 0** — a real zero
   and an absent measurement are different facts, and the field will populate on backends that emit
   it. Worth confirming what Ollama sends before the next run reads the same column.
3. **`judge.dlq` holds four dead-lettered judgments from run 1, and NOTHING WILL RETRY THEM.** There
   is no consumer on `judge.dlq` and no retry-from-DLQ verb anywhere. Those four items are parked
   permanently; run 2 re-judged them only because it was a *new* run over the whole set. Two work
   items hide here: a way to see the depth (T5, above) and a decision about whether a
   replay/inspect path should exist at all.
4. **Per-endpoint concurrency — IN FLIGHT, not done.** The hard cap of 1 is a blunt instrument: it is
   correct for a 2-slot llama.cpp server and needlessly slow for anything larger, and it is global,
   so one slow endpoint sets the pace for every other. The real fix is a limit that knows which
   endpoint it is talking to — which is what makes the owner's ask (two servers queried in parallel,
   sequential *per server*) expressible at all. **Being implemented now; do not record it as
   shipped, and do not raise `HARD_CONCURRENCY_CAP` as an interim measure** — that is the exact
   configuration that dead-lettered four items.
5. **Run-grain `status` can be stale.** Five `EvaluationRun` rows read `error` on run 1 while only
   four `ModelJudgment` rows did (§7.2). Scoring reads the judgment and is right; any ad-hoc SQL that
   counts runs will disagree by one. Small, and it will mislead someone.

### 5.6 Follow-ups added 2026-09-01 (the scoreboard session)

Full record: [`docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md`](../specs/2026-09-01-judge-scoreboard-and-model-envelopes.md).

6. **`CalibrationRun` does not snapshot the sampling config, and `samplingDefaults` is mutable.**
   The obvious join — run → version → `samplingDefaults` — reports **today's** config for a
   historical run. Raising granite4.2 from 4096 to 12288 for a re-run silently rewrote what that
   query says about the *earlier* run, with nothing updated and nothing logged. The truth survives
   one level deeper on `ModelJudgment.samplingParams`, which is written per call and never revised.
   **This is the highest-value item in this list**, because a leaderboard is exactly the artifact
   that will do the wrong join. `rubricId`, `kappaVariant` and `passThreshold` are already pinned on
   the run for precisely this reason; `samplingDefaults` was missed. Additive, one column.

   > **DONE / CORRECTION (v2k, 2026-09-01).** Landed as `CalibrationRun.samplingParams` — resolved
   > at launch inside the launch transaction, NULL only on the 9 pre-v2k rows (no backfill), printed
   > and drift-checked by `scripts/calibration/run.ts`. And "`passThreshold` … already pinned" above
   > was wrong: `passThreshold`/`passed` have no writer anywhere in `src/` or `scripts/`; only
   > `rubricId` (launch) and `kappaVariant`/`kappaWeighting`/`thresholdMetric` (score) are pinned.

7. **`granite4.1:3b` scores BELOW the degenerate baseline and nothing on screen says so.** It scored
   0.5000 where a judge that stamps `A>B` on every item scores **0.5667** on this set. The floor is a
   property of the answer key (17/13) and is computable at score time, but it is not computed or
   displayed anywhere — so a reader compares 0.5000 against an imagined 0.50 coin flip and concludes
   "weak but real". `score.ts`'s header already derives the 0.5667 figure in prose. **Emit it beside
   the accuracy.**

8. **Two limits are stacked and only one is visible.** Fixing truncation by raising `max_tokens`
   exposed a timeout ceiling underneath it (`max_tokens / tok_per_s` must fit the hard cap). Nothing
   validates that relationship at registration, though both inputs are known: the endpoint verify step
   could measure `tok_per_s` on its probe call and refuse — or warn on — a budget the timeout cannot
   afford. Runbook §8.6 documents the manual check; **the check wants to be code.**

9. **`reasoningTokens` from Ollama — now answerable.** Item 2 above asked what Ollama sends. It sends
   nothing either: the column is NULL across all granite runs, same as llama.cpp. So the field is
   currently unpopulated on *every* self-hosted backend, which makes it dead weight in the capture
   completeness report rather than a gap in one backend. Decide whether to derive it or drop it from
   the checklist.

10. **`judge.dlq` is now at 10, up from the 4 in item 3.** Still no consumer, still no replay verb.
   The depth grew during ordinary operation, which is the argument item 3 was missing — this is not a
   one-off residue from run 1, it is an accumulating sink.

11. **CI REPORTS SUCCESS ON A FAILED BUILD.** `next build` was OOM-killed against the Gitea runner's
   `limits.memory: 4Gi` and the job still printed `🏁 Job succeeded`; no image reached Harbor. A green
   run is therefore **not** evidence that an image exists. Nothing else covers the gap either —
   `BuildPromoteLag` is excluded for judge-arena (`helmrelease.yaml:152`) and watches
   *built-not-promoted*, whereas this is *pushed-not-built*. Marginal rather than systematic (the
   same build passed 70 minutes earlier and again on retry), which is what makes it dangerous: it
   reads as flaky CI. **Two fixes, and the first is the real one** — make the job fail when a step
   fails; then raise the runner limit or bound Next's static-generation workers. Third instance of
   this family after `e4b9948`'s `.dockerignore` and homelab's chart-version no-op; the mechanical
   invariant that closes all three is one `skopeo inspect` asserting a tag for the pushed SHA.
   Detail: scoreboard spec §5.5.

   > **CORRECTION (2026-09-01).** *"`next build` was OOM-killed"* and *"the job still printed
   > `🏁 Job succeeded`"* — the first is false and the second is true only of the runner pod log.
   > Run 51 (task 4816) was cancelled by Gitea 1.23.6's built-in `CancelPreviousJobs` when
   > `7f0e0cb` was pushed 28 s later; act v0.261.10 prints `this step has been cancelled: signal:
   > killed` only on a cancelled context and then logs a spurious `🏁 Job succeeded` from a fresh
   > context that has lost the job error. Gitea's record said `cancelled` / "Has been cancelled"
   > throughout; the runner never restarted or OOMKilled; the same signature hit task 4818
   > (`7f0e0cb`, `db-tests`, no Node process) at 15:56:32Z. Of the two fixes proposed above, the
   > first was not needed (nothing in `ci.yml` swallows a failure) and the second addresses an
   > event that did not happen. Landed instead: `scripts/ci/assert-harbor-tag.sh` behind a new
   > `build-push` step, `scripts/ci/ci-status.sh <sha>` for the pre-promote read, and this note's
   > siblings in the handoff and spec §5.5.

---

## 6. Repo state

- `gitea/main` = `14d75f7`. **Branch from this.** Local `main` now tracks `gitea/main` correctly.
- Gitea holds **three** branches: `main`, `docs/productionized-state` (superseded — its durable
  content was folded into these docs, corrected, and it can be deleted), and
  `docs/rebaseline-north-stars` (content-dead: `main` is strictly *ahead* on every file it touches,
  but `git cherry` cannot see that, so it was left rather than deleted on an unverifiable check).
- Recovery record for the branch cleanup: `/root/judge-arena-worktrees/gitea-branch-shas-before-cleanup.txt`.
- `railway.toml` and `Procfile` are gone — PaaS artifacts from before the cluster migration. The
  `ctrl:*` scripts they referenced live on in `package.json`.
- `.gitignore` no longer ignores `.github/`. It did, under a "Local env files" heading, which meant
  any **new** workflow file was silently unstageable — precisely the trap someone restoring the
  GitHub mirror would have hit. The mirror has been frozen since 2026-08-07 and has no push
  automation in either workflow file; that is still open.

---

## 7. A2.1 in detail — what shipped, what it measured, and what it did not

### 7.1 The link: two nullable columns, not a join table

`prisma/migrations/20260830120000_v2i_calibration_item_link/migration.sql` adds
`EvaluationRun.goldenItemId`, `EvaluationRun.calibrationRunId`, `CalibrationRun.rubricId`, and seven
capture columns on `ModelJudgment`. Production is at **19 migrations, 0 unfinished** (re-checked
2026-08-31 against `_prisma_migrations` on `judge-arena-pg-1`).

**What did not exist before it.** Nothing paired a `GoldenItem` with a model verdict.
`ModelJudgment` hangs off `EvaluationRun` → `Evaluation`, and `Evaluation` carries a
`datasetSampleId` but no golden item — so there was no path from a verdict to the `expected` it
should be scored against. `CalibrationRun` was **read-only dead schema**: it existed, and the only
code that touched it was `isGoldenSetFrozen`'s `count()`. It is now written.

**Two nullable columns, deliberately, and the reasoning is worth keeping:**

- An `EvaluationRun` is **already 1:1 with a golden item by construction** — a pairwise run holds
  exactly one candidate pair (`RunCandidate @@unique([runId, position])`, and
  `buildPairwiseUserPrompt` requires exactly two). A join table would model a relationship the schema
  already enforces.
- A join table would have carried a stored `preference`, and **A0 decision #4 forbids exactly that**.
  Which sample was preferred is *derived* from `(verdict, pairOrder)` at read time; encoding it turns
  the B/A position-bias sweep into a **backfill** instead of an insert.

`@@unique([calibrationRunId, goldenItemId])` keeps Postgres' default `NULLS DISTINCT` — every
ordinary run has both columns NULL and they must all coexist. That is why v2i needed **zero hand
edits** and CONTRIBUTING's pseudo-drift table stays at **eight** rows.

### 7.2 The first real number, with its caveat attached

Verified read-only against production on 2026-08-31:

```
kubectl exec -n tenant-public judge-arena-pg-1 -c postgres -- psql -U postgres -d judge_arena -tAc \
  'SELECT id, kappa, "rawAgreement", "verdictCount", "thresholdMetric", passed FROM "CalibrationRun";'
→ cmtgib0xr00016k2r8nlyj1py|0.6950146627565981|0.8461538461538461|26|accuracy|
```

| | |
|---|---|
| Judge | **Qwen3.6-35B-A3B** (`Qwen3.6-35B-A3B-UD-Q3_K_XL.gguf`, `llamacpp`, local) |
| Golden set | `cmt057hd001g17y01lhjzgfuj` — *JudgeBenchSample — 30 random*; ground truth **17 `A>B` / 13 `B>A`**, no ties |
| **Accuracy** | **0.8462** — **22 of 26**, stored on the legacy `rawAgreement` column |
| Kappa | **0.6950**, `cohen`, weighting `none` |
| Window | started `2026-08-31 00:35:04`, finished `01:47:46` |
| `passed` / `passThreshold` | **NULL.** No threshold is set, so nothing has passed or failed |
| Still NULL | `testRetest`, `positionBias`, `biasSensitivityRate`, `flipRateVsParent` — later phases, not lost writes |

> **THE CAVEAT IS NOT OPTIONAL: this is a 26-item number and the four missing items were OUR fault.**
> Four items dead-lettered with
> `Provider call to "llamacpp" (Qwen3.6-35B-A3B-UD-Q3_K_XL.gguf) timed out after 300000ms`, four
> attempts each. The cause was **configuration, not the model**: prefetch was `concurrency(2) × 4 = 8`
> against a server advertising `total_slots: 2`, so six requests queued *inside the inference server*
> while their client timeout ran. Quoting 0.8462 without "22/26, four items never judged" is the
> failure `cb2fc37` was written to stop — that commit exists because the report printed
> `missingVerdicts 0` directly underneath a denominator that said 26.

**A LATENCY NUMBER IN OUR OWN SOURCE DOES NOT SURVIVE CHECKING, AND IT IS THE ONE EVERYONE WILL
QUOTE.** `src/worker/concurrency.ts:12-13` and `1e7a427`'s commit message both say *"judgments that
completed averaged 94s, well inside the 300s ceiling."* Measured against the rows:

```
SELECT count(*), round(avg(mj."latencyMs")), min(mj."latencyMs"), max(mj."latencyMs"),
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY mj."latencyMs")::numeric)
  FROM "ModelJudgment" mj JOIN "EvaluationRun" er ON er.id = mj."runId"
 WHERE er."calibrationRunId" = 'cmtgib0xr00016k2r8nlyj1py' AND mj.status = 'completed';
→ n=26   avg=232917   min=65774   max=299063   median=265372      (milliseconds)
```

**233s average, 265s median, and a maximum of 299,063 ms — 937 milliseconds under the 300,000 ms
timeout.** The picture is not "four unlucky items timed out while the rest were comfortable"; it is
**26 of 30 finishing within a second of the wall.** The incident was closer to total loss than the
"4 of 30" headline suggests, and the same configuration on a slightly slower day loses most of the
set.

The two numbers are not necessarily in conflict, and the difference *is* the incident:
`latencyMs` is wall time around the HTTP call (`src/lib/llm/openai-compatible.ts:249`,
`Date.now() - startTime` spanning the SDK request), so it **includes time queued inside the inference
server**. 94s may be generation time from some other observation. **It is not derivable from this
database** — nothing in these rows separates generation from queue wait.

> **Treat 94s as UNVERIFIED. Do not quote it as a latency baseline, and consider correcting the
> comment in `src/worker/concurrency.ts`** — it is currently the most quotable sentence in the
> module, it is the evidence the cap's argument rests on, and it does not match the data. The
> argument for the cap survives either way (the cause was in-server queueing, which is exactly why
> `latencyMs` is inflated), but the supporting number should be one someone can re-derive.
> **The sequential re-run is what produces a real baseline:** at concurrency 1 there is no in-server
> queue for `latencyMs` to absorb, so its stored value becomes generation time.

> **RESOLVED — 2026-08-31. The placeholder that stood here is filled in; the re-run finished.**
> `CalibrationRun` **`cmthr58r100013s0sykuvn41x`** — same golden set, same judge version, sequential.
>
> ```
> ACCURACY   0.8333   (25/30 items with a verdict)     ← THE BASELINE. Quote this one, with its denominator.
> kappa      0.6575   cohen / weighting none
> itemCount  30       missingVerdicts 0     errors 0     dead-lettered 0
> verdicts   A=18   B=12   tie=0
> confusion  A>B -> A>B:15  B>A:2   ·   B>A -> A>B:3  B>A:10
> wall clock 21m53s        latency avg 42.6s / min 16.1s / max 95.1s
> ```
>
> **The warning that stood here was right on both counts, and worth keeping for that reason.** It is
> NOT 0.8462 over 30: accuracy fell **1.3 points** once the four unseen items were included, which is
> what a self-selected subset looks like from the other side. And the latency distribution is
> unrecognisable — **42.6s average against the first run's stored 233s**, same judge, same set, same
> prompts. That gap is the in-server queueing, measured.
>
> **42.6s is now the latency baseline. Both 94.4s and 233s are retired** — the first never had a
> re-runnable measurement attached, the second is an artefact of the over-subscription it was
> describing.
>
> **Capture on this run:** 30/30 on `systemPrompt`, `userPrompt`, `userPromptSha256`, `rawResponse`,
> `reasoning`, `reasoningContent` (avg **8,342 chars**), `inputTokens`, `outputTokens`,
> `servedModelId`, `finishReason`. `reasoningTokens` **0/30** — llama.cpp sends no
> `completion_tokens_details`, so nothing was dropped.
>
> Derived, and it is the proof the cap worked: 30 × 42.6s = 1,278s of in-model time against 1,313s of
> wall clock, **~97%**. Nothing overlapped, so nothing queued.
>
> Full side-by-side of the two runs, the storage footprint measured off these rows, and the
> concurrency lesson: `docs/superpowers/specs/2026-08-31-calibration-baseline-and-footprint.md`.

**A discrepancy anyone re-querying this will hit.** Five `EvaluationRun` rows carry `status='error'`
but only **four** `ModelJudgment` rows do. Run `a0983c08-4548-4663-a40d-0cd56b82f765` is stamped
`error` at run grain while its judgment **completed** on attempt 6 (`verdict=B`,
`latencyMs=108646`). Scoring reads the *judgment*, so that item is inside the 26. **Count judgments,
not runs** — and the stale run-grain status is worth its own small work item.

### 7.3 Accuracy is primary; kappa is a labelled secondary

`thresholdMetric` is written as `'accuracy'`, and the ordering is an argument rather than a taste:

1. **Ground truth is an answer key, not a peer rater.** Cohen's kappa chance-corrects on *both*
   raters' marginals, presuming two annotators who could each have been wrong. The key's marginal is
   a property of the **set** — 17/13, fixed the moment it froze — so discounting a judge's hits
   against it treats a constant as a source of chance. That is a category error.
2. **Kappa is not comparable across sets, and cross-set ranking is the one thing a leaderboard does.**
   `pe` depends on the key's class balance, so the same judge with the same hit rate scores
   differently on a 17/13 set than on a 15/15 one.

**Both are stored anyway**, because accuracy alone cannot separate a judge that learned something
from one that answers `A>B` every time: on this set the degenerate judge scores **0.5667** accuracy
and **0.0000** kappa. They fail in opposite directions. `kappaVariant`/`kappaWeighting` record the
method, because a kappa with no stated method is uncheckable a year later.

**One real bug was found inside `agreement()` while proving the reuse**, and it is the kind worth
remembering: Fleiss builds `pe` from two exact integers, so a single observed category gives
`pe === 1` exactly — but **Cohen accumulates `1/n`**, and thirty additions of `1/30` sum to
`0.9999999999999999`. The old `if (1 - pe === 0) return 1` guard therefore missed the degenerate
case and the quotient collapsed to **0.5 for every n whose reciprocal does not sum exactly** (3 and 4
do; 30 does not). A judge that matched the answer key on all thirty items would have been filed
under "moderate agreement" — in range, not NaN, not null, indistinguishable from a real 0.5. The
guard is now an epsilon (`PE_DEGENERATE_EPSILON = 1e-9`) with a clamp to kappa's defined `[-1, 1]`.

### 7.4 Capture, and two honest gaps

`ModelJudgment` now stores `systemPrompt`, `userPrompt`, `userPromptSha256`, `promptTruncated`,
`rawResponse`, `reasoning`, `reasoningContent`, `reasoningSource`, `reasoningTokens`.

**The prompt is STORED, not reconstructed, and the reason is a live defect elsewhere.** `PATCH
/api/rubrics/[id]` `deleteMany`s a rubric's criteria and recreates them on the **same rubric id with
no version bump** (verified), and the pairwise system prompt embeds those criteria verbatim — so
re-rendering a historical judgment from `promptTemplateId` + the item silently yields **today's**
rubric with nothing recording that it moved. `userPrompt` is capped at 32 KiB (backed off to a UTF-8
boundary so the stored copy cannot end in `U+FFFD`); `userPromptSha256` is over the **full, pre-cap**
text, so a capped copy still identifies the exact bytes.

| Gap | Measured | Why |
|---|---|---|
| `reasoningTokens` | **NULL on 30/30** | Read from `usage.completion_tokens_details.reasoning_tokens`. llama.cpp does not emit `completion_tokens_details` at all — nothing was dropped, nothing was sent |
| `parseMode` | **NULL on 30/30** | The pairwise path has one parse path (`tryParsePairwiseJudgment` is fence-tolerant), so there is no strict→lenient demotion and no mode to persist. The column is meaningful only pointwise |

`reasoningSource` is `reasoning_content` on all 30; `systemPrompt` is non-null on **26** of 30,
because the four timeouts are transport failures with no response to capture.

> **STORAGE FOOTPRINT: deliberately not stated here.** N judges × M items × every re-run of uncapped
> model text against a single-instance Postgres is the accepted risk the roadmap deferred, and A2.1
> is the moment volumes stop being small. The measurement is a separate, dedicated exercise and its
> numbers belong in a follow-up. **Nothing in this section may be filled in from a per-row average
> read off one run.**

### 7.5 Truncation is a hard failure; concurrency is hard-capped at 1

**Truncation.** `finish_reason: 'length'` / `stop_reason: 'max_tokens'`, or an empty content channel,
now throws `non_retryable` in `registry.ts`'s `execute()` — **one chokepoint, before any parse**, so
pointwise, pairwise and respond all inherit it. Non-retryable because the token budget is a property
of the *request*, not of provider health: the identical call truncates identically every time, so
retrying burns the attempt budget, DLQs the judgment and charges three failures to a breaker shared
with healthy calls. **The failure it prevents: respond mode previously persisted a truncated answer
as `status: 'completed'`**, making a generation chopped in half indistinguishable in the corpus from
a finished one. It fails on `'length'` even when the content parses. `verify.ts`'s connection test is
exempt by design — it sends `max_tokens: 1` and would otherwise report truncation on every healthy
endpoint.

**Concurrency.** `src/worker/concurrency.ts` clamps `EVALUATION_MODEL_CONCURRENCY_PER_RUN` (1–16) to
`HARD_CONCURRENCY_CAP = 1`. Asking for more is not an error and does not fail the boot; the clamp is
**logged at `warn`** with requested and effective values, because it must be silent to the
configuration and never to an operator. The old `prefetch = concurrency × 4` was wrong twice: prefetch
is not a buffer here (`dispatch` starts a handler per delivered message, so prefetch **is** the
concurrency), and even un-multiplied it was one global number applied to a fleet of heterogeneous
endpoints. **Why 1 and not "match the slots":** the worker cannot know the slot count — it is a
property of whichever endpoint each `JudgeModelVersion` points at, invisible from here and free to
change when someone restarts a server with different flags. It also makes a calibration run
**sequentially**, which is what makes a latency baseline reproducible. **Raising the cap is not the
eventual fix; per-endpoint concurrency is.**

### 7.6 Two new entrypoints

`/app/add-judge.js` and `/app/calibration-run.js`, both esbuild-bundled into the image (the runner
ships no TypeScript toolchain), plus `npm run calibration:run` locally. They must run **in the
cluster**: only a pod can reach both `judge-arena-pg-rw.tenant-public` and a judge endpoint.
`add-judge.ts` reuses `createCustomJudgeModel` — the same chokepoint `POST /api/models` uses — so a
CLI-registered judge gets its `model.create` audit row instead of being invisible to the trail.

> **LAUNCHING FREEZES THE GOLDEN SET, IRREVERSIBLY.** `isGoldenSetFrozen` is
> `calibrationRun.count({ where: { goldenSetId } }) > 0` — there is no `frozenAt` column and no
> unfreeze verb. Deleting the calibration is impossible (`onDelete: Restrict`); retiring or
> tombstoning does not release it; the only escape is `POST /api/golden-sets/[id]/fork`. This is why
> `launchCalibrationRun` checks everything knowable without touching an item **before** writing the
> header — the failure it prevents is a set pinned forever by a calibration in which all 30 items
> failed for one reason knowable before any of them ran.

Full commands: README's **Calibration** section, and CONTRIBUTING's *Running a calibration against
production*.

### 7.7 The promote, and a reading that decayed inside one session

**Two readings, six minutes apart.** Both are kept, because the pair is more instructive than either
one: this repo's own convention is that a fact about a remote decays faster than a fact about the
tree, and here it decayed *while the paragraph describing it was being typed*.

```
2026-08-31 21:23Z   both Deployments → sha-c6417860027a   (commit c641786, TWO BEHIND main)
                    git log --oneline c641786..1e7a427
                      cb2fc37  missingVerdicts reported 0 while four items had dead-lettered
                      1e7a427  cap in-flight judgments at 1
                    ⇒ the hard cap was NOT in production

2026-08-31 21:29Z   both Deployments → sha-1e7a427d2c48   (commit 1e7a427)  ← CURRENT
                    ⇒ promoted; pods rolled; the cap is live
```

**The proof is the worker's own boot log, not the image tag** — a tag says what was deployed, the log
says what the process decided:

```
{"level":"warn","msg":"EVALUATION_MODEL_CONCURRENCY_PER_RUN clamped to the hard cap",
 "timestamp":"2026-08-31T21:29:24.604Z","requested":2,"effective":1,
 "reason":"concurrent provider calls queue INSIDE the inference server while their client timeout runs"}
{"level":"info","msg":"judge worker started","timestamp":"2026-08-31T21:29:24.605Z",
 "prefetch":1,"concurrency":1,"healthPort":9090,"consumers":2}
```

> **THE ENV VAR IS NO LONGER A CONTROL, AND THE MANIFEST STILL LOOKS LIKE IT IS.** The Deployment
> sets `EVALUATION_MODEL_CONCURRENCY_PER_RUN=2` and the worker runs at **1**. Anyone reading the
> HelmRelease, the compose file, or CONTRIBUTING's pool-sizing table will infer 2 and be wrong.
> **Read `judge worker started`'s `concurrency` field.** This is precisely why the clamp is logged at
> `warn` — the design note in `concurrency.ts` says it must be silent to the configuration and never
> to an operator, and this is the situation it was anticipating.

**The re-run is in flight and is genuinely sequential.** `CalibrationRun`
**`cmthr58r100013s0sykuvn41x`** — same golden set (`cmt057hd001g17y01lhjzgfuj`), same judge version
(`cmtgia5sx00026k1prl6a8tyf`) — started `2026-08-31 21:30:17.101`, **53 seconds after** the capped
worker booted. At `21:37Z`: **30 launched, 9 completed, 1 running, 20 pending**, with
`rawAgreement`/`kappa`/`finishedAt` NULL and `verdictCount` 0 because scoring runs at the end.
**One judgment in flight is the cap doing its job**, observed rather than assumed.

**DONE — the re-run finished and §7.2's placeholder is filled in.** `0.8333` accuracy over
**25/30**, kappa `0.6575` (`cohen`/`none`), `missingVerdicts 0`, zero errors, zero dead-letters,
21m53s wall clock, latency **avg 42.6s / min 16.1s / max 95.1s**. Neither 94s nor 233s was carried
forward; **42.6s is the speed baseline**, and it is the first one measured with no in-server queue
for `latencyMs` to absorb.

**Next action is no longer this.** The durable record of both runs, the storage footprint measured
off their rows, the concurrency lesson and the Ollama finding now live in
`docs/superpowers/specs/2026-08-31-calibration-baseline-and-footprint.md`, and the end-to-end
operating procedure in `docs/runbooks/scoring-a-judge-against-a-golden-set.md`. What is actually open
is §5.5 — five follow-ups — and the owner's ask: the same 30-item set against the Ollama server's two
models, sequential **per server** but with the two servers in parallel, which is what §5.5 item 4
(per-endpoint concurrency, in flight) exists to make expressible.
