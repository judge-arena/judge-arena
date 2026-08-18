# Integration, release, end-to-end verification, and A2 — roadmap

**Date:** 2026-08-17 · **Status:** roadmap, not a plan. Each numbered item becomes its own plan.

> **UPDATE 2026-08-17, later the same day: M1, M2 and M3 are DONE.** The A1/A1.5 PR (#13) merged as
> `bee1d12`; production was promoted from `sha-70fce84bee11` to **`sha-bee1d121ea7d`**; and all five
> pending migrations applied cleanly — prod is now at **18 migrations, zero unfinished**, with all
> three of `v2h`'s hand-edited objects verified present in the live database. `judgearena.com`
> returns 200 in-cluster and publicly, both pods `1/1` with zero restarts.
>
> **M4 (seed) is now the next thing, and it is what gates E1.** Production still holds
> **2 datasets and 0 golden sets** — there is still nothing to annotate, so the argument below is
> unchanged in substance: A2 waits on real labels, and real labels wait on someone doing the work.
> What changed is that the deploy is no longer in the way.

**Supersedes nothing.** It sits between `2026-08-10-judge-training-engine-roadmap.md` (which says
*what* A2 is) and `2026-08-17-a2-calibration-and-reporting-decisions.md` (which says what about A2
is already settled). This says **what has to happen first, and why the order is not negotiable.**

---

## The finding that reorders everything

A2's own decisions document names two hard gates: **A1**, for labels, and **rebaseline T5**, for
broker safety. A1 is now done. So the natural reading is "one gate left".

**That reading is wrong, and the reason is worth stating plainly:**

> **A1 shipped the ability to produce labels. It has not produced any.**
> *(As first written, production also had zero golden sets AND was five migrations behind. The
> migrations landed 2026-08-17; the **zero golden sets** did not change.)* A2 cannot be *specced* —
> by its own decisions document — until real label data exists, because the shape of that data is an
> input to the calibration design rather than an assumption to be made ahead of it.

So the chain is longer than it looks:

```
merge  →  promote  →  migrate  →  seed  →  annotate for real  →  A2 can be SPECCED
  ✅         ✅          ✅        ← YOU ARE HERE              ↘
                                                    T5  →  A2 can be RUN
                                                    (still open)
```

The merge and deploy work below is therefore **not preliminary chores before the interesting
phase**. It is the gate. Treating it as housekeeping is how a team ends up specifying a calibration
engine against imagined data.

---

## Verified state, 2026-08-17

Every row was checked against the tree, the remote or the live cluster in the session that wrote
this. **Nothing here is carried forward from an earlier document** — the previous handoff's own §8
records that a fact about a remote decays faster than a fact about the tree, and two rows below had
in fact already moved.

### Code

| Thing | State | How it was checked |
|---|---|---|
| `gitea/main` | **`bee1d12`** — carries A0+L1+L2+R1+R3+A1+A1.5+R4+R5 | PR **#13** merged 2026-08-17 as a merge commit |
| Why a merge commit, not a squash | The docs cite specific SHAs **44 times across 8 files**; a squash or rebase would dangle every one | `grep` before merging |
| `feat/a0-golden-set-substrate` | `4e7028f`→`8397c4a`, now merged | Safe to delete |
| Suites at the merge point | 578 unit / 633 db / 80 integration; `tsc` + `lint` exit 0 | full run |
| Migrations on `main` | **18**, through `20260818120000_v2h_human_verification` | `git ls-tree` |
| CI for `bee1d12` | `ci`, `db-tests`, `build-push` all **success**; kaniko Job `Complete` | Gitea API + `kubectl get jobs -n tenant-builds` |

### Production

| Thing | State | Consequence |
|---|---|---|
| Running image | ~~`sha-70fce84bee11`~~ → **`sha-bee1d121ea7d`** | Promoted 2026-08-17. Was a **preflight**-branch build predating A0 entirely. |
| Prod DB migrations | ~~13~~ → **18**, latest `20260818120000_v2h_human_verification` | All five applied, **0 unfinished** (no P3009 wedge). `v2h`'s CHECK and both partial unique indexes verified present in the live DB. |
| Prod catalog | **2 datasets, 0 golden sets, 2 users** | **STILL TRUE.** The substrate now exists; nothing has been created in it. This is what M4 fixes. |
| Flux | In sync — `main@sha1:47e0603…`, HelmRelease Ready | Reconciled after the promote. |
| Promote model | **Manual** — judge-arena is excluded from the build-lag exporter (`286da59`) | No automatic promotion will ever happen. Someone must do it — and did, on 2026-08-17. |

### The T5 gate, re-measured rather than quoted

| Measurement | Value | Verdict |
|---|---|---|
| RabbitMQ memory vs watermark | **0.1407 GB / 0.2577 GB = 54.6%** at idle | Unchanged from the 54.5% recorded on 2026-08-17. The gate is real and stable, not a spike. |
| `VMServiceScrape` covering RabbitMQ | **zero** | Still nothing. |
| `VMRule` covering RabbitMQ | **zero** | Still nothing. |
| Free disk vs low watermark | 3.94 GB free / 2.0 GB watermark | Under 2 GB of headroom — thinner than the memory margin, and not currently alerted either. |
| Queue depths | all `0`, `judge.dlq` `0` | Idle. The 54.6% is the floor, not a backlog. |

**Read that table as one sentence:** the broker sits at over half its publisher-blocking watermark
while completely doing nothing, and no metric, scrape or alert in this cluster would tell anyone if
that changed.

---

## The promote lever, and the guard that does not guard it

**The authoritative image tag is `apps/public/judge-arena/helmrelease.yaml`** (~line 195), whose
inline `values:` block overrides the chart default in `charts/judge-arena/values.yaml`.

**CORRECTION to an earlier version of this section.** It called the chart default an undocumented
trap. It is not: `values.yaml`'s own comment states plainly that the HelmRelease "is the authority
and overrides this; the default exists so `helm template ./charts/judge-arena` renders standalone in
CI and in review." That is deliberate and correct, and anyone reading the file top to bottom is told
so. The claim was written before that comment had been read properly.

**The real defect is one line further in**, and it is recorded as homelab divergence **entry 67**.
`templates/deployment.yaml` guards the tag with `required "… The chart ships no default so a public
deploy can never silently float on :latest."` — but the chart *does* ship a default. Helm's
`required` fires only on nil or empty, so **the guard can never fire**, and its explanation is false
about its own chart. If the HelmRelease ever loses its `image.tag`, nothing errors and the deploy
silently pins a months-old image.

Two facts that matter under pressure, both already written into the HelmRelease:

- **A wrong tag stalls safely.** The Deployment is `maxUnavailable: 0` / `maxSurge: 1`, so a pull
  failure surges a pod that never becomes Ready while the **old pod keeps serving**. The symptom is
  a stalled rollout with the site up — not an outage. Confirmed in practice on 2026-08-17: the real
  promote rolled with zero restarts and no gap.
- **Rollback is `git revert` + `flux reconcile kustomization judge-arena --with-source`** — and note
  it restores the **image only**. The schema stays migrated, which is safe here because the five
  migrations are additive, non-destructive and backward-compatible.

---

## Part M — Merge and promote

### M1 · Open and land the A1/A1.5 PR — ✅ DONE 2026-08-17

The branch is pushed; the PR is not created, because there is no Gitea CLI or token on the
workstation. The prepared body is committed at `docs/superpowers/pr-a1-body.md`.

- Compare URL: `https://gitea.lab.asethi.com/trij/judge-arena/compare/main...feat/a0-golden-set-substrate`
- **Decide first whether to split.** Ten commits carrying A1 (7 tasks), A1.5 (5 tasks) and R4/R5 is
  a large review surface against a `main` that already absorbed the earlier half via #12. Splitting
  A1.5 onto its own branch off `main` is a rebase, and is cheap **before** the PR exists and
  annoying after.
- CI builds and pushes an image on merge to `main` — `.gitea/workflows/ci.yml` triggers on
  `push: [main]`, and `build-push` gates on both the DB and integration suites, so no image is
  published whose suites did not run.

**Exit:** `gitea/main` contains `4e7028f`'s tree, and CI has published `sha-<merge-commit>`.

**Outcome:** PR **#13** merged as `bee1d12`, deliberately as a **merge commit** — the docs cite
specific SHAs 44 times across 8 files, and a squash or rebase would have dangled every one. It was
merged whole rather than split; splitting after the PR existed would have required the rebase that
breaks those citations. CI `build-push` published `sha-bee1d121ea7d` (kaniko Job `Complete` —
worth checking directly, because that job is written to report success when it no-ops on a
non-main push).

### M2 · Promote the image — ✅ DONE 2026-08-17

One line, in the right file.

- Edit `apps/public/judge-arena/helmrelease.yaml` → `image.tag` → the new `sha-…`.
- Merge to homelab-setup `main`; Flux reconciles. **Nothing promotes itself** (M-note: manual by
  design, `286da59`).
- Watch the rollout rather than assuming it: a stalled surge pod is the documented failure shape.

**Exit:** `kubectl get deploy -n tenant-public judge-arena-web -o jsonpath='{…image}'` returns the
new tag, and pods are Ready.

### M3 · The five migrations — ✅ DONE 2026-08-17, cleanly

Migrations run as a **Helm hook Job** (`judge-arena-migrate`) from the same image, so M2 triggers
them. That is convenient and it is also where this can go wrong, so it gets its own item.

**What is about to be applied to production for the first time:** `v2d` (golden substrate), `v2e`
(golden item/label tombstones), `v2f` (tombstone overlay + a CHECK), `v2g` (sample revisions), `v2h`
(human verification — two new tables, a CHECK, and an index drop-and-recreate).

- **Take a backup first and prove it restores.** WAL archiving and a rehearsed restore are done
  (rebaseline T2, 6/6 exit gate verified) — so use them rather than trusting they work.
- **`v2h` drops and recreates a partial unique index** on `GoldenLabel`. Prod's `GoldenLabel` is
  empty (0 golden sets ⇒ 0 labels), so the CHECK and the index rebuild are free. **Verify that
  before applying**, not after: `SELECT count(*) FROM "GoldenLabel";` must be 0, or the
  `score_xor_preference` CHECK will refuse to apply.
- **Know the P3009 recovery in advance.** The migrations-job template documents it: a failed
  migration leaves the row unfinished and *every* later run aborts, and the fix is
  `prisma migrate resolve --rolled-back <name>`. Read `kubectl logs job/judge-arena-migrate`
  promptly — the template warns the logs are the only account of the attempt.

**Exit:** prod `_prisma_migrations` has **18** rows and `prisma migrate status` reports up to date.

**Outcome — and the pre-flight review is why it was boring.** All five applied, **0 unfinished**.
The review established beforehand that (a) there is **no destructive DDL** in any of them — zero
`DROP TABLE`/`DROP COLUMN`/`DELETE`/`TRUNCATE`, the only `DROP INDEX` acting on an empty table;
(b) every `NOT NULL`-without-default addition lands on `GoldenSet`/`GoldenItem`, both verified at
**0 rows**; and (c) the only pre-existing, actively-written table touched is `ModelJudgment`,
which gains one **nullable** column — so the window where migrated schema meets old code was safe
by construction rather than by luck. All three of `v2h`'s hand-edited objects were then verified
present in the live database, which is the only way to see them: no drift tool can.

**One thing went wrong and is worth carrying forward: the migrate Job's logs were lost.**
`hook-delete-policy: hook-succeeded` reaps the Job on success, and a `kubectl logs` attempt that
attaches during `PodInitializing` errors out rather than waiting. Start a follow **before** the
reconcile, not after. The outcome was fully recoverable from `_prisma_migrations` and
`pg_constraint` — but had a migration failed, there would have been less to work with.

### M4 · Seed the catalog — ⬅ NEXT

Prod has 2 datasets and 0 golden sets. Seeding is deliberately manual (`70fce84`'s own commit
message records the in-cluster invocation and that it is manual on purpose).

**Exit:** at least one dataset with enough samples to build a golden set worth annotating.

### M5 · Close the loop on the branch topology

`main` (local) is badly stale and `gitea/feat/a1-tombstone-overlay` is behind and finished. Once M1
lands, delete or retire the dead branches so the next person does not have to work out which of six
is current.

---

## Part E — End-to-end verification

**Why this is a numbered part rather than "test it".** Every suite in this repo runs against a
local Postgres with mocked auth. Not one of them has ever exercised the real path: a browser, a real
session, the deployed image, the cluster's Postgres, Redis and RabbitMQ. A1 and A1.5 are the first
phases where that gap matters, because they are the first that a *human being sits and uses*.

The A1.5 studio checklist (`docs/runbooks/studio-manual-verification.md`, 12 rows, walked
2026-08-17) is the model to copy: it exists precisely because that layer cannot be unit-tested.
**These items extend it from "the studio renders" to "the product works".**

### E1 · The first real annotation session

Not a smoke test — a *use*. One person, one golden set, a real sitting.

1. Sign in through Authentik (not credentials — prod uses OIDC, and the invite-claim path is the
   one that has never been exercised end to end with a golden set attached).
2. Create a golden set from a seeded dataset.
3. Assign it to yourself.
4. Label every item through `/golden-sets/<id>/label`.
5. Read the agreement panel.

**What to expect and not mistake for a bug:** with one account the inter-annotator number is
`insufficient-annotators` — null with a reason, never `0`. `testRetest` is the only reliability
signal that produces a value. This is the single most likely thing to be misread as a defect, which
is why it is written into three documents and now a fourth.

**Exit:** real `GoldenLabel` rows exist in production, produced through the UI by a human.

### E2 · The provenance and blinding claims, in production

The two properties A1 exists to protect are the two that a passing unit suite proves least about,
because both are properties of a *request* rather than a function.

- Edit an item **after** labelling it. Assert through `…/items/<itemId>/history` that the reading
  still resolves to the text that annotator saw, not the current text.
- Drive a blind re-read to completion and confirm the queue payload carries **no `round`**, no prior
  score and no `expected` — the same network-level check row 12 of the studio runbook uses, but
  against the deployed build.

**Exit:** both confirmed against production, and the result appended to the studio runbook's
recording table.

### E3 · A second annotator — the first time overlap is real

Every inter-annotator statistic in the product is currently unexercised against real data, because
there has only ever been one account. The overlap model, Fleiss path and disagreement ranking are
tested against fixtures that create N `User` rows; **they have never been driven by two humans.**

This is also where roadmap decision #5 (cross-user annotation policy) stops being theoretical:
`mayHoldAssignment` currently allows the set's owner and admins, and widening it is a one-line
change *by design* — but the policy question is the owner's, not the code's.

**Exit:** a golden set with genuine overlap, reporting a real kappa with its method and its
overlap count. **This is the first moment the product does the thing it exists to do.**

### E4 · The load shape A2 will actually impose

Before A2 runs, find out what a burst does to the broker — while someone is watching, and while T5's
instrumentation exists to watch it with. See the gate below: **this item is sequenced after T5, not
before it.** Running it first is precisely the "discover the watermark the invisible way" failure
the roadmap warns about.

---

## Part T5 — The broker gate

Not new work invented here; it is `2026-08-08-north-star-rebaseline-design.md`'s T5, restated with a
current measurement and promoted to the critical path because **A2 cannot start without it.**

The hard ordering inside T5 is its own: **observability strictly first.** You cannot raise
throughput toward a publisher-blocking watermark you cannot observe, and the watermark is computed
from a chart-injected override that GitOps cannot raise. The app-side cap is the only lever.

1. `VMServiceScrape` on `:15692` for all three brokers. Everything else depends on it.
2. Alerts, each with a stated self-clearing condition: disk-watermark alarm, memory-watermark alarm,
   publishers blocked, `judgment.execute` backlog sustained. **`judge.dlq` depth ships at `info`,
   not warning** — it has zero consumers by design, so at warning severity it is a ratchet that only
   an operator can clear. Put the purge command in the annotation.
3. Cap bulk enqueue: samples per run, a request body size limit (**there is none anywhere today**),
   and `judgeLimiter` on the local-dataset path.
4. `judge.dlq` TTL and max-length; truncate the persist-failure envelopes, which currently carry
   full untruncated LLM responses.
5. Rubric size caps — unbounded today, and every criterion enters every judgment prompt.
6. Move the two judgment retry queues from single-node classic to quorum.

**Add one item this measurement surfaced:** the **disk** watermark has under 2 GB of headroom
(3.94 GB free against a 2.0 GB low watermark) and is as unmonitored as memory. T5's alert list
already includes a disk-watermark alarm; this is the note that it is not hypothetical.

**Exit:** RabbitMQ metrics exist, alerts fire and self-clear, and a burst is capped by the
application rather than by the broker blocking publishers.

---

## Part A2 — The calibration engine

**Do not write the A2 spec until E1–E3 have produced real labels.** That is not process for its own
sake: the A2 decisions document states outright that its design takes A1's real label data as an
input rather than an assumption. What "real" adds over fixtures is the distribution — how many items
get a second reading in practice, how often annotators disagree, what the score set actually looks
like when nobody chose it to make a test pass.

### A2.0 · Spec it, against data

Settle the six open questions the decisions document lists. Three of them are now answerable in a
way they were not before A1 shipped:

| # | Question | What A1 changed |
|---|---|---|
| 5 | Is `agreement()` reused for human-vs-model? | **Very likely yes, and it should be confirmed cheaply.** `agreement()` takes `Reading[] = {itemId, raterId, category}[]`; a model is just another `raterId`. If it holds, **A2 writes no statistics code at all** — which is a large scope difference and should be settled first, not last. |
| 1 | The `biasSensitivityRate` perturbation set | Unchanged, still open. Version it from the first run or the metric is not comparable across runs. |
| 2 | PPI configuration | Needs a gold sample size — which E1–E3 will make concrete rather than notional. |
| 3 | Confusion matrix: computed on read, or stamped at freeze? | A1 set the precedent: agreement is **computed on read, recorded at freeze**. Follow it unless there is a reason not to. |
| 4 | What "state of the art" compares against | Roadmap B's territory; A2's header carries it. |
| 6 | Drain rate and seconds | `EvaluationRun` still lacks run-grain `startedAt` (roadmap item 4), without which elapsed time conflates queue wait with execution. |

### A2.1 · The per-item join row

The substrate that does not exist. `CalibrationRun` is a header with aggregate metrics and no
per-item rows; `ModelJudgment` reaches a `DatasetSample` only through `Evaluation`. **Nothing pairs
a `GoldenItem` with a model's verdict**, and without that there is no confusion matrix, no per-run
disagreement list and no human-vs-model kappa.

It carries the run, the item, the model's label **in `GoldenLabel`'s score-or-preference shape**
(reuse it, or human and model verdicts stop comparing directly, which is the entire point of the
row), a link to the `ModelJudgment` for reasoning, and the presentation order — because
`positionBias` is measured by re-presenting the same pair both ways.

### A2.2 · The run itself

Reuse `src/lib/llm/*` rather than a parallel path, so calibration inherits retry, circuit-breaker
and BYOK behaviour instead of re-implementing it. Populate `kappa`, `rawAgreement`, `verdictCount`,
`passed`; drive `TrustState` `untrusted → calibrating → trusted|rejected` from thresholds **recorded
as data**, so a judge that passed under one threshold is re-derivable under a later one.

### A2.3 · The report as a projection

`EvaluationReport` is **computed from the per-item rows, not stored**. Each answer is stored exactly
once, so no second copy can drift from the first, and internal data stays recalculable without
duplicating the heaviest text in the product.

### The accepted risk to re-examine before A2.1, not after

**Retention is uncapped, and that was a decision.** Nothing caps `rawResponse` or `reasoning`. The
per-item rows are the heaviest data this product will hold — items × judges × every re-run, each
carrying uncapped model text — and Postgres here is `instances: 1` on a single node.

The failure mode is a **full storage pool on a single-instance database**, whose first symptom is
*unrelated writes failing*. It was deferred while volumes were small. **A2.1 is the moment volumes
stop being small**, so the cheap mitigation — a documented byte cap with truncation recorded —
should be priced in there rather than discovered later. It closes a rebaseline item as a side
effect.

---

## The critical path, in one place

```
M1 merge ─► M2 promote ─► M3 migrate ─► M4 seed ─┬─► E1 first real session
   ✅           ✅            ✅          ⬅ NEXT   │      └─► E2 provenance + blinding in prod
                                                  └─► E3 second annotator ──► real kappa
                                                                    │
                                     T5 (observability first) ──────┼──► E4 load shape
                                          (still open)              │
                                                                    └──► A2.0 spec ─► A2.1 ─► A2.2 ─► A2.3
```

**Two independent tracks.** T5 is cluster work and needs no code from this repo; M1–M4 is release
work. They can proceed in parallel, and A2 needs both.

**The one ordering that must not be violated:** T5's observability lands before any concurrency
increase, and before E4. Everything else has slack.

---

## What is deliberately NOT here

- **A3, A4, A5** — unchanged in `2026-08-10-judge-training-engine-roadmap.md`. A3 in particular is
  the loop-closing surface and is worth reading before A2 is specced, because A2's per-item row is
  what A3 aggregates.
- **Roadmap B**, the public leaderboard half. Not started.
- **`reasoning_content` capture** (preflight Stage 5). Still backlogged; the studio's reasoning panel
  is correct and thin until it lands, and says so.
- **Preflight Stage 5** more broadly — the only open preflight stage.
- **Rebaseline T6/T7** — versioning and obligations. Neither gates A2.
