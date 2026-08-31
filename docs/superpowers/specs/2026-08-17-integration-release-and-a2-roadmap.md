# Integration, release, end-to-end verification, and A2 — roadmap

**Date:** 2026-08-17 · **Last verified against production: 2026-08-30** (the 2026-08-29 pass, plus
the promote and worker rollout that landed the next morning) · **Status:** roadmap, not a plan.
Each numbered item becomes its own plan.

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

> **UPDATE 2026-08-29 — a whole branch landed that no document had ever mentioned, and the position
> on this roadmap moved twice.**
>
> **The correction first, because it is the more important half.** Until today, **no document on any
> ref said that `feat/assignment-ui-and-random-subset` existed.** It was written, tested, pushed and
> left unmerged, and this roadmap's critical path — both ASCII diagrams, and the "YOU ARE HERE"
> marker in each of them — was drawn as though it were not there. That is a documentation failure
> rather than a code one, and it is the reason the "YOU ARE HERE" marker in every version of this
> file before this one was wrong.
>
> `0309a7e` (the feature) and `ded6e1f` (the fixes) merged into `gitea/main` as merge commit
> **`14d75f7`**. What shipped:
>
> - the **assignment panel** on `/golden-sets/<id>` — *Assign to me* / *Revoke*, and a shortcut
>   straight into the studio;
> - **`toPublicOwner`** on the assignments API: the annotator projects to `{id, name}`, **never the
>   email**, and `null` for a deleted account;
> - **server-side random subset selection** (`randomCount` / `randomPercent`) in
>   `src/lib/sample-selection.ts` — the client sends the ask, the server draws. **No migration.**
>   Nothing in this merge touches the schema; production stays at 18.
>
> `ded6e1f` additionally fixed `handleRevoke`'s missing `catch`; a `randomPercent` DB test that
> tombstoned nothing and therefore could not discriminate a live-count implementation from a
> raw-count one (it would have passed against the bug it existed to catch); and three stale doc
> blocks. It added `docs/superpowers/pr-assignment-ui-body.md` and studio-runbook rows 13–18.
>
> **Gates at the merge point**, all run locally against podman Postgres/Redis/RabbitMQ:
> **lint 0, tsc 0, 594 unit / 43 files, 641 db / 42 files, 80 integration / 10 files, both coverage
> gates 0, build 0.** The baseline this table records at `bee1d12` was **578 / 633 / 80** — so the
> merge added 16 unit and 8 DB tests and moved neither gate.
>
> **A browser walk happened**, 2026-08-29: rows 14, 16, 17 and 18 of the studio runbook, in a real
> browser. Row 14 is the one worth quoting, because it is the only evidence that random is not a
> prefix — over one 620-row dataset at N=30, **First** gave `0..29`, and **Random** gave
> `14, 61, 62, 76, 90, 121, 152, 162, 165, 171, 177, 179, 252, 256, 261, 288, 309, 328, 343, 363,
> 366, 428, 439, 441, 450, 479, 496, 508, 519, 529`. Rows 13 and 15 were **not** walked; the runbook
> says so rather than implying a full pass.
>
> **The two moves on the path.** M4 is **done** (its outcome is recorded below, with a correction to
> what it was previously reported to have created). E1 is **started and stalled** — two golden sets
> and two assignments exist, **zero labels do**, and sign-in is being refused for a reason nobody had
> diagnosed. Read E1 before doing anything else.

> **UPDATE 2026-08-31 — A2.1 SHIPPED, AND THE GATE THIS DOCUMENT IS BUILT ON WAS TOO BROAD.**
>
> This roadmap's organising claim is that **A2 waits on real labels**. That is correct for the
> human-vs-model half and **wrong for the model-vs-ground-truth half**, which needs no `GoldenLabel`
> at all — `GoldenItem.expected` arrives with the dataset and has been sitting in production since
> 2026-08-19. A2.1 has now shipped and produced a number **while `GoldenLabel` is still `0`**.
>
> Every present-tense sentence below that says "A2 cannot start" has been left as written and
> annotated where it is now scoped wrongly, rather than rewritten — the claim was load-bearing for
> months and quietly correcting it would hide that it was ever made.
>
> **What shipped**, all on `main`: `ae0d4a7` (migration `v2i`, `src/lib/calibration/*`, prompt and
> reasoning capture, the truncation guard), `e4b9948` (the runner + judge-registration CLI in the
> image), `c641786` (`.dockerignore` had excluded `scripts/calibration/`, so `e4b9948`'s image built
> successfully and shipped without the script it existed to ship), `cb2fc37` (`missingVerdicts`
> reported `0` while four items had dead-lettered) and `1e7a427` (in-flight judgments hard-capped
> at 1).
>
> **The number:** Qwen3.6-35B-A3B, calibration `cmtgib0xr00016k2r8nlyj1py`, **accuracy 0.8462 over
> 22 of 26 items**, kappa **0.6950** (cohen/none). Four of thirty items dead-lettered on a
> **configuration** fault — prefetch 8 against a 2-slot server — not on the model.
>
> **The re-run is in flight, not finished.** `CalibrationRun` `cmthr58r100013s0sykuvn41x` started
> `2026-08-31 21:30:17.101` (30 launched / 9 completed / 1 running / 20 pending at `21:37Z`). **No
> second result exists yet; do not record one.**
>
> **What did NOT move: E1.** `GoldenLabel` is still `0`, the OIDC mismatch is untouched, and the
> agreement panel still has no UI. See the plan doc §7 for the full account.
>
> **Deployment, two readings six minutes apart** — kept as a pair because the first is the basis of
> anything below that calls the cap un-deployed: `21:23Z` → `sha-c6417860027a` (`c641786`, two
> commits behind `main`, cap NOT in production); **`21:29Z` → `sha-1e7a427d2c48` (`1e7a427`) on both
> Deployments — promoted, pods rolled, cap live.** The worker's boot log is the proof:
> `clamped to the hard cap {requested:2, effective:1}` then
> `judge worker started {prefetch:1, concurrency:1}`. Note that the Deployment still sets
> `EVALUATION_MODEL_CONCURRENCY_PER_RUN=2` — **that env var is now intent, not control.**

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
>
> **CORRECTION 2026-08-31 — the first sentence is still true; the second was scoped too widely.**
> "A2" is two things. The **human-vs-model** half genuinely takes A1's label distribution as a design
> input and still cannot be specced. The **model-vs-ground-truth** half takes `GoldenItem.expected`,
> which is not produced by annotation at all — and it was specced, built, shipped and run (A2.1,
> 2026-08-31) with `GoldenLabel` at `0` throughout. The cost of the over-broad reading was months of
> treating a buildable thing as blocked.

**UPDATE 2026-08-29 — the headline sentence survives intact; its parenthetical does not.** Two
golden sets were created in production on **2026-08-19 13:44**: *"JudgeBench pairwise — full"* (620
items) and *"JudgeBenchSample — 30 random"* (30 items), with **650 `GoldenItem`** and **1300
`GoldenCandidate`** rows behind them, both self-assigned to the owner within the same minute. So
"the zero golden sets did not change" was true when written and is not true now, and every
present-tense repetition of it further down this document has been corrected in place.

**What did not move is the gate.** `GoldenLabel` is still **`0`** — checked directly against
database `judge_arena` on pod `judge-arena-pg-1` (note the name: it is `judge_arena`, not
`judgearena`). A1 has still produced no labels, ten days after someone sat down to produce some. A2
still cannot be specced. What changed is the *diagnosis*, and therefore the next action: see **E1**.

**RE-CHECKED 2026-08-31: `GoldenLabel` is `0`, twelve days on.** ~~A2 still cannot be specced.~~ —
the model-vs-ground-truth half was specced and shipped; see the correction above and the update at
the top. The E1 gate itself is entirely unmoved, and **A2.1 shipping must not be read as E1 being
finished**: no human has labelled an item, the OIDC refusal in E1 is unchanged, and the agreement
panel still has no UI.

So the chain is longer than it looks:

```
merge  →  promote  →  migrate  →  seed  →  annotate for real  →  A2 can be SPECCED
  ✅         ✅          ✅         ✅       ↑                             ↘
                                       YOU ARE HERE — inside the step,       T5  →  A2 can be RUN
                                       not before it                        (still open)

   "annotate for real" is E1, and E1 is half-executed:
      1. sign in via Authentik ....... ⛔ REFUSED NOW — OIDC `sub` mismatch (it passed once, back
                                          on 2026-08-07; nothing since). THIS is the blocker, see E1.
      2. create a golden set ......... ✅ 2 sets, 2026-08-19 13:44
      3. assign it to yourself ....... ✅ 2 whole-set assignments, same minute, never revoked
      4. label every item ............ ⛔ GoldenLabel = 0, ten days later
      5. read the agreement panel .... ⛔ the panel has no UI at all (E1 sub-blocker 1)
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
| `gitea/main` | ~~**`bee1d12`**~~ → **`14d75f7`** — `bee1d12` carried A0+L1+L2+R1+R3+A1+A1.5+R4+R5; `14d75f7` adds the assignment UI and random subset selection | PR **#13** merged 2026-08-17 as a merge commit; `0309a7e`+`ded6e1f` merged 2026-08-29 as `14d75f7` |
| Why a merge commit, not a squash | The docs cite specific SHAs **44 times across 8 files**; a squash or rebase would dangle every one | `grep` before merging |
| `feat/a0-golden-set-substrate` | `4e7028f`→`8397c4a`, now merged | Safe to delete |
| Suites at the merge point | ~~578 unit / 633 db / 80 integration~~ → **594 unit / 43 files, 641 db / 42 files, 80 integration / 10 files**; `tsc` + `lint` exit 0, both coverage gates 0, build 0 | full run at `bee1d12` (2026-08-17) and again at the `14d75f7` merge point (2026-08-29), local podman Postgres/Redis/RabbitMQ |
| Migrations on `main` | **18**, through `20260818120000_v2h_human_verification` | `git ls-tree` |
| Migrations on `main` after `14d75f7` | **still 18** — the assignment-UI merge carries no migration | `git ls-tree`, 2026-08-29 |
| CI for `bee1d12` | `ci`, `db-tests`, `build-push` all **success**; kaniko Job `Complete` | Gitea API + `kubectl get jobs -n tenant-builds` |

### Production

| Thing | State | Consequence |
|---|---|---|
| Running image | ~~`sha-70fce84bee11`~~ → ~~`sha-bee1d121ea7d`~~ → **`sha-14d75f7d46de`** | Promoted 2026-08-17. Was a **preflight**-branch build predating A0 entirely. **2026-08-29: still `sha-bee1d121ea7d`** — the `14d75f7` build had not been promoted when *that* line was written, so the assignment panel was on `main` but not on the site. **Promoted 2026-08-30 01:47Z**, as homelab `f28be67` (PR #936, `apps/public/judge-arena/helmrelease.yaml` line 195): `kubectl get deploy -n tenant-public judge-arena-web -o jsonpath='{…image}'` now returns `sha-14d75f7d46de`, both pods Ready with 0 restarts. The panel is on the site. |
| Prod DB migrations | ~~13~~ → ~~**18**~~ → **19**, latest ~~`20260818120000_v2h_human_verification`~~ `20260830120000_v2i_calibration_item_link` (2026-08-31: 19 applied, 0 unfinished) | All five applied, **0 unfinished** (no P3009 wedge). `v2h`'s CHECK and both partial unique indexes verified present in the live DB. |
| Prod catalog | **2 datasets, ~~0 golden sets~~, 2 users** | **True on 2026-08-17; the golden-set half is not true now.** ~~The substrate now exists; nothing has been created in it. This is what M4 fixes.~~ **2026-08-29:** 2 datasets, **620 `DatasetSample`**, **2 `PromptTemplate`**, 2 users, and **2 golden sets / 650 `GoldenItem` / 1300 `GoldenCandidate` / 2 `GoldenAssignment` / 0 `GoldenLabel`**. Also `0` for `GoldenItemRevision`, `CalibrationRun`, `DeveloperApiKey` and `HumanJudgment`. **2026-08-31:** `GoldenLabel` **still 0** and `HumanJudgment` **still 0** — but `CalibrationRun` is now **1**, with **30 `EvaluationRun`** and **30 `ModelJudgment`** rows behind it. Production has executed judgments for the first time. |
| Flux | ~~In sync — `main@sha1:47e0603…`~~ → **`0.3.1+f28be677baf0`**, HelmRelease Ready | Reconciled after the 2026-08-17 promote, and again after the 2026-08-30 one: `kubectl get helmrelease -n tenant-public judge-arena -o jsonpath='{.status.lastAttemptedRevision}'`. |
| Promote model | **Manual** — judge-arena is excluded from the build-lag exporter (`286da59`) | No automatic promotion will ever happen. Someone must do it — and did, on 2026-08-17 and again on 2026-08-30. |
| Site | `judgearena.com` returns **200** | Re-checked 2026-08-29 — ~~serving the *pre-merge* build~~ — and again on 2026-08-30, now serving `sha-14d75f7d46de`. See the running-image row. |
| Worker pipeline | ~~**DEAD since 2026-08-24T17:55Z**~~ → **rolled 2026-08-30 01:47Z** | For five days all five queues reported `consumer_count=0` while the pod sat `1/1 Running` with **0 restarts**, which is why nothing alerted. The `14d75f7` promote rolled the Deployment and the consumers re-registered. **The code defect that caused it is still open** — see **E0**. |

### The T5 gate, re-measured rather than quoted

Re-measured 2026-08-29. The 2026-08-17/18 readings are kept as **superseded readings**, not deleted:
a single measurement is a claim about one moment, and the pair of them is the only evidence anyone
has that this number is stable rather than drifting.

| Measurement | Value | Verdict |
|---|---|---|
| RabbitMQ memory vs watermark | **0.1197 GB / 0.2577 GB = 46%** at idle (2026-08-29) | The gate is real. It is also **lower than it was**, which matters only as reassurance: the shape holds, the margin is not closing on its own. |
| ~~RabbitMQ memory vs watermark~~ | ~~**0.1407 GB / 0.2577 GB = 54.6%** at idle~~ (2026-08-17/18) | **SUPERSEDED READING**, kept deliberately. It was correct when taken, and any document still quoting **54.6%** is quoting this row, not a current measurement. |
| `VMServiceScrape` covering RabbitMQ | **zero** | Still nothing, 2026-08-29. |
| `VMRule` covering RabbitMQ | **zero** | Still nothing, 2026-08-29. |
| RabbitMQ samples ever stored | **none** | VictoriaMetrics returns `seriesFetched: "0"` for `{__name__=~"rabbitmq_.*"}`. Not one RabbitMQ sample has *ever* been written in this cluster — this is stronger than "no scrape exists" and it is the number to quote. |
| Free disk vs low watermark | **3.9393 GB** free / **2.0 GB** watermark (2026-08-29) | Under 2 GB of headroom — thinner than the memory margin, and not alerted either. Was quoted as 3.94 GB on 2026-08-17; the two agree. |
| Queue depths | all `0`, `judge.dlq` `0`; **no alarms** | Idle. The 46% is the floor, not a backlog. |
| Queue **consumers** | ~~**`consumer_count=0` on all five queues**~~ (2026-08-24 → 2026-08-30) → **`run.create` 1, `judgment.execute` 1** | Through that window it was not idle-by-design, it was idle because **the worker was dead**: depth `0` meant nothing was being *published*, not that anything was being drained. Restored by the 2026-08-30 promote's rollout (`rabbitmqctl list_queues name messages consumers`). `judge.dlq` and both `judgment.retry.*` queues report `0` consumers **by design** — see E0's exit. |

**Read that table as one sentence:** the broker sits at nearly half its publisher-blocking watermark
while completely doing nothing, no metric, scrape or alert in this cluster would tell anyone if that
changed — and the one thing that *did* change, a worker that had stopped consuming five days
earlier, was found by hand rather than by an alert and fixed by a rollout nobody scheduled for that
purpose, which is the entire argument for T5 in a single incident.

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
  empty, so the CHECK and the index rebuild are free. **Verify that before applying**, not after:
  `SELECT count(*) FROM "GoldenLabel";` must be 0, or the `score_xor_preference` CHECK will refuse
  to apply.
  **CORRECTION 2026-08-29 — the premise this bullet used to give is now false; the conclusion and
  the check are not.** It read "*0 golden sets ⇒ 0 labels*". Production has held **2 golden sets and
  650 golden items since 2026-08-19**, and `GoldenLabel` is nevertheless **still 0**. Golden sets do
  not imply labels; annotators do. So keep this bullet exactly as it is operationally — but keep it
  as an *instruction to run the count*, never as an inference from the set count. The day someone
  finally labels an item, the inference stops holding while the sentence still reads true, which is
  the worst failure shape a pre-flight check has.
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

### M4 · Seed the catalog — ✅ DONE 2026-08-18

*(As written 2026-08-17: prod had 2 datasets and 0 golden sets.)* Seeding is deliberately manual
(`70fce84`'s own commit message records the in-cluster invocation and that it is manual on purpose).

**Exit:** at least one dataset with enough samples to build a golden set worth annotating.

**Outcome.** Met. Production carries **2 datasets / 620 `DatasetSample` / 2 `PromptTemplate`**, and
on 2026-08-19 someone built two golden sets out of them (620 items and 30 items). The exit gate was
the *seeding*, and the seeding is not what is stuck — see E1.

**CORRECTION 2026-08-29 — this item was previously reported as having created two `PromptTemplate`
rows "that had never existed in production (`v1-legacy`, `v1-pairwise`)". That is half false.**
Only **`v1-pairwise`** was new; it was created **2026-08-18 14:07:31.432**, by the seeder, in the
window this item describes. **`v1-legacy` has existed since 2026-08-12 17:42:35.664** — six days
earlier, and nothing to do with M4. The proof is in the row's own primary key: Prisma cuids embed
their creation timestamp in base36 in characters 2–9, and `cmsqdn8un00006p142rkwzuw1` decodes to
2026-08-12. A row deleted and re-created by the seeder would carry a **new** cuid with an 08-18
timestamp, so this also rules out the "it was replaced" reading without needing an audit trail.

**The conclusion the claim was made to support survives, on `v1-pairwise` alone:**

> **PROMOTING DOES NOT SEED.** A promote ships an image. It does not run `seed.js`, and a
> `PromptTemplate` the code has depended on since 2026-08-12 can still be absent from production on
> 2026-08-18. One genuinely-missing row is enough to establish that; two were never needed.

**The operational rule that was derived from it is FALSE and is replaced, not softened.** It said:
*"run the seeder and READ ITS OUTPUT — a `Created` line means production was behind."* It does not,
and cannot:

- `seedPromptTemplates` logs `✓ Created prompt template: …` **unconditionally**, outside any branch,
  after an `upsert` (`prisma/seed-prompt-templates.ts:120` and `:135`). It prints the same line
  whether it inserted a row or updated one that was already there.
- `seed-judgebench.ts:307` likewise opens with `✓ Created dataset: …` unconditionally.
- **No log line anywhere in the seeder is gated on an actual insert.** The only text carrying a real
  delta is the parenthetical `${created.count} new samples` on that same judgebench line.
- And `seed-core.ts` — the file the old rule named — never prints the word `Created` at all.

**Replacement rule: do not read the log, read the table.** Query before and after —
`select name, version, "createdAt" from "PromptTemplate";` — and compare. Failing that, read *only*
the fragments that report a measured delta (`N new samples`), and treat every `✓ Created …` line as
decoration.

**Note for anyone tempted to fix this in code:** `PromptTemplate` has **no `updatedAt` column**, so
the obvious fix — branch the log on `createdAt === updatedAt` — is not implementable against this
schema. The implementable options are a `findUnique` before the upsert, a `count()` either side, or
a `create` with a `P2002` catch.

**Related, and worth fixing while in there:** `prisma/seed.ts:29` claims the seeder "is idempotent,
so a second run is safe and reports zero new rows." Safe, yes. *Reports* zero new rows — true for
judgebench, **false for prompt templates**, for exactly the reason above.

### M5 · Close the loop on the branch topology

`main` (local) is badly stale and `gitea/feat/a1-tombstone-overlay` is behind and finished. Once M1
lands, delete or retire the dead branches so the next person does not have to work out which of six
is current.

**UPDATE 2026-08-29 — this item stopped being tidiness and became the cause of a real defect.**
`feat/assignment-ui-and-random-subset` sat finished, pushed and unmerged for days while **no
document on any ref recorded that it existed**, which is how this roadmap came to describe a
critical path that was missing a whole shipped feature. It is now merged as `14d75f7` and is safe to
delete along with the others. The lesson is the cheap half of this item: a finished branch that no
document names is indistinguishable from work nobody did.

---

## Part E — End-to-end verification

**Why this is a numbered part rather than "test it".** Every suite in this repo runs against a
local Postgres with mocked auth. Not one of them has ever exercised the real path: a browser, a real
session, the deployed image, the cluster's Postgres, Redis and RabbitMQ. A1 and A1.5 are the first
phases where that gap matters, because they are the first that a *human being sits and uses*.

The A1.5 studio checklist (`docs/runbooks/studio-manual-verification.md`, 12 rows, walked
2026-08-17) is the model to copy: it exists precisely because that layer cannot be unit-tested.
**These items extend it from "the studio renders" to "the product works".**

**UPDATE 2026-08-29:** that checklist is now **18 rows**. `ded6e1f` added rows 13–18 for the
all-samples / first-N / random-N / random-% selection modes and the assignment panel, and rows
**14, 16, 17 and 18** were walked in a real browser the same day. Rows **13 and 15 were not walked**,
and the runbook records that rather than implying a clean sweep.

### E0 · Restart the worker — ✅ ROLLED 2026-08-30 · ⛔ THE CODE DEFECT IS STILL LIVE

**Found 2026-08-29. It is not hypothetical, and until this line it was in no document.**
judge-arena's evaluation pipeline consumed nothing from **2026-08-24T17:55Z** until **2026-08-30
01:47Z** — five days and seven hours. Through all of it, all five queues reported
**`consumer_count=0`**.

What happened, in order:

- The **Cozystack v1.6.2** roll recreated `judge-arena-pg-1` at **17:54:57Z**.
- **21 seconds later** the worker logged a burst of `Can't reach database server` and
  `terminating connection due to administrator command` (**SQLSTATE 57P01**).
- It then emitted **no log line at all** until the 2026-08-30 rollout — five days of silence
  from a process that was, by every signal anyone had, running.

**Why nothing caught it, which is the part worth carrying forward.** The pod was `1/1 Running` with
**0 restarts** the whole time — it never crashed, so no restart alert could fire. Its Postgres socket reconnected,
so no database alert could fire. The one thing that did *not* recover is the AMQP **consumer
registration**, and a broker with no consumers is exactly what this cluster cannot see: T5 item 1
does not exist yet, so queue depth `0` with zero consumers is indistinguishable from a healthy idle
broker. Every signal that was being watched read green through five days of a dead pipeline.

**Restore, operationally:** roll the worker Deployment. Consumers register on boot, so a rollout is
sufficient and immediate.

> **UPDATE 2026-08-30 01:47Z — the operational half is done, and it was done by accident.** The
> promote of the `14d75f7` build rolled *both* Deployments; the new worker pod logged
> `judge worker started` at `01:47:29.450Z` and re-registered on boot.
> `rabbitmqctl list_queues name messages consumers`, run on `rabbitmq-judge-arena-server-0`, now
> returns `run.create 0 1` and `judgment.execute 0 1`. Note what it was *not*: the promote commit
> (`f28be67`) is about an image tag and a drifted pin, not about this incident. The recovery is
> therefore not evidence that anything is watching. **The code half below is untouched:
> the next broker or database blip parks the worker in exactly the same state.**

**Fix, in code — not yet written:** the AMQP client re-registers consumers **only on boot, never on
reconnect**. Any broker or database disruption that outlives the connection parks the worker
permanently in a Running-but-deaf state, with no crash and no log. Note this is **repo code**, so
unlike T5 it belongs to the release track rather than the cluster track — it is the one exception to
"T5 is cluster work and needs no code from this repo" below.

**Exit:** `consumer_count > 0` on **`judgment.execute` and `run.create`** — *and* a reconnect no
longer needs a human. Fixing only the first half leaves the same defect armed for the next node roll.

**CORRECTION 2026-08-30 — this exit gate first read "`consumer_count > 0` on all five queues",
which can never pass.** The worker registers exactly two consumers, both at boot
(`src/worker/main.ts:134` and `:144`); `judge.dlq` and the two `judgment.retry.*` queues are
dead-letter/TTL queues with **no consumer by design**, as T5 item 2 says of the DLQ further down.
A gate that cannot be met is worse than no gate: whoever ran it would have read three permanent
zeroes as an unfixed incident.

### E1 · The first real annotation session — ⬅ **YOU ARE HERE.** Started 2026-08-19, stalled

Not a smoke test — a *use*. One person, one golden set, a real sitting.

1. Sign in through Authentik (not credentials — prod uses OIDC, and the invite-claim path is the
   one that has never been exercised end to end with a golden set attached).
   → **⛔ REFUSED — now, not always.** Steps 2 and 3 below are the work of a session that was
   authenticated *as the owning row* on 2026-08-19, so this step has been passed at least once;
   what is refused is every **fresh** sign-in since. This is the blocker. See below; it is an
   identity mismatch, not a missing surface, and it is not fixed by anything in this repo.
2. Create a golden set from a seeded dataset. → **✅ done 2026-08-19 13:44**, twice:
   *"JudgeBench pairwise — full"* (620 items) and *"JudgeBenchSample — 30 random"* (30 items).
3. Assign it to yourself. → **✅ done**, both at 13:44:04.995 and 13:44:05.07 — **whole-set**
   assignments (`goldenItemId` NULL), `completedAt` NULL, `revokedAt` NULL. Still open today.
4. Label every item through `/golden-sets/<id>/label`. → **⛔ nothing. `GoldenLabel` = 0**, ten days
   on.
5. Read the agreement panel. → **⛔ there is no agreement panel.** Sub-blocker 1 below.

**CORRECTION 2026-08-29 — this item has been read, in this document and in the ones that point at
it, as "nobody has taken it". That diagnosis is wrong, and it points at the wrong next action.**
E1 is **partially executed**. Somebody sat down on 2026-08-19, got through steps 2 and 3, and
produced **zero labels**. "Find someone to do the annotation" is therefore not the next action;
**unblocking sign-in is.** The exit gate below is genuinely unmet — `GoldenLabel` is `0` and A2 is
still blocked, so the framing of this whole roadmap survives — but the reason it is unmet changed
completely.

#### The blocker: an OIDC identity mismatch, not a missing feature

The judge-arena `User` row that **owns both golden sets and holds both assignments** is
`cmsj951c30000881a4l63sx4b` (`trijeet@protonmail.com`, `role=admin`), and its
`oidcSubject` is **`26f57dc2-77b6-455b-a939-d897dbdad6ee`**.

Authentik has **two accounts sharing that email**:

| Authentik account | uuid | judge-arena sees it as |
|---|---|---|
| `akadmin` | `26f57dc2-77b6-455b-a939-d897dbdad6ee` | **the owner** of both sets |
| `trijeet` | `e8b087cc-b38b-492a-bbb3-b34bdfb50c16` | **nothing at all** |

The judge-arena OAuth2 provider's `sub_mode` is **`user_uuid`**, so the `sub` claim *is* the uuid.
The 2026-08-07 invite-claim was performed while signed in as **`akadmin`**; every attempt since has
been as **`trijeet`**, whose `sub` matches no row. `resolveOidcUser` therefore falls through to
branch 3, and `ALLOW_OIDC_AUTOPROVISION` is **absent from the deployment env**, so the sign-in is
refused rather than autoprovisioned.

**The evidence is a clean pairwise match across two systems.** Three Authentik
`authorize_application | trijeet` events — **2026-08-18 21:33:35**, **2026-08-19 13:41:28** and
**13:41:32** — are each followed **within a second** by a judge_arena `AuditLog` row
`user.login.failed {"method":"oidc","reason":"no_match_autoprovision_disabled"}`. Note the last two
timestamps: they sit three minutes before the golden sets were created at 13:44. Note also, because
it is its own finding: **no successful `user.login` has ever been written to that audit table.**

**One caveat on that sentence, because it is easy to over-read.** It does not mean nobody has ever
held a session. The table carries exactly one successful authentication of any kind — a
`user.invite_claimed` at **2026-08-07 19:21:17**, by this same user id — and the two sets and two
assignments made on 2026-08-19 13:44 belong to that row, so something *was* authenticated as it
that afternoon. Two properties stop the table from settling how: `audit()` is fire-and-forget and
swallows its own write failures (`src/lib/audit.ts`), and the session is a 24-hour rolling JWT
(`src/lib/auth.ts:58`) — so neither "the session was still alive" nor "a sign-in succeeded and its
audit row was lost" can be excluded. What *is* established is the part that matters: **no sign-in
can be obtained today as `trijeet`**, and the three refusals above are what happens when it is
tried.

**Credentials are not a fallback.** That row's `passwordHash` is the sentinel `!oidc-managed`, and
`findCredentialsUserByEmail` deliberately excludes `!`-prefixed hashes. There is no password to try.

**Fastest path, no mutation of anything:** sign in to Authentik as **`akadmin`** — private window,
or log out of the `trijeet` SSO session first. That `sub` matches the owning row, and `akadmin` is
in `users-primary`, which is the single enabled policy binding on the judge-arena application. This
unblocks step 4 today.

**Durable fix — one row, and it is an admin's decision, not a developer's:**

```sql
UPDATE "User" SET "oidcSubject" = 'e8b087cc-b38b-492a-bbb3-b34bdfb50c16'
 WHERE id = 'cmsj951c30000881a4l63sx4b';
```

or consolidate the two duplicate Authentik accounts so the email has one identity behind it.

> **DO NOT issue a fresh CLI invite, and DO NOT enable `ALLOW_OIDC_AUTOPROVISION`.** Both are the
> obvious-looking fix and both make it worse: each mints a **second, empty `User` row** that owns
> nothing and holds no assignment, and that row gets a hard **403** from the queue on both existing
> sets. The annotator would then be signed in, looking at a working product, and unable to reach the
> 650 items — a much harder failure to diagnose than the current clean refusal. The email partial
> unique index (`UNIQUE (email) WHERE passwordHash NOT LIKE '!%'`) does **not** prevent this,
> because the OIDC-managed row's hash is `!`-prefixed and so is not in the index.

#### Two sub-blockers behind it — E1 *and* E2 both walk straight into these

Neither is fixed by the `14d75f7` merge, and neither is visible until sign-in works, which is why
they are written down here rather than discovered at 650 items in.

1. **E1 step 5 has no UI. `GET /api/golden-sets/[id]/agreement` exists and works — nothing calls
   it.** No file under `src/app/**` or `src/components/**` ever fetches that route. The only
   "Agreement" anywhere in the interface is a hard-coded, permanently-empty stage on the progression
   rail (`src/app/golden-sets/[id]/label/page.tsx:87`), which is deliberate — the rail shows the
   stage as empty rather than omitting it — but it is not the panel. **This is a missing surface,
   not a bug.** Workaround for E1: from the signed-in tab, navigate straight to
   `/api/golden-sets/<id>/agreement` and read the JSON.
2. **Every `GoldenCandidate` in production has `label IS NULL` — 1300 of 1300 — and the studio's
   fallback silently renames the sides.** `toCandidate()` hard-codes `label: null`
   (`src/lib/golden-sets.ts:180`), so the studio renders
   `candidate.label ?? 'Option ' + (position + 1)`
   (`src/app/golden-sets/[id]/label/page.tsx:201`) → **"Option 1" / "Option 2"** — while the verdict
   control asks for **`A>B` / `tie` / `B>A`**. **Nothing on the screen says that Option 1 is A.**
   The mapping *is* deterministic in code — `toCandidate(0, responseA)`, `toCandidate(1, responseB)`,
   and the queue orders by `position asc` — but the annotator cannot see that, and an annotator who
   guesses the other way round **silently inverts every preference in the session**. There is no
   error, no warning, and no way to tell afterwards. Whoever does E1 must be told "Option 1 is A"
   before they start, and the real fix is to populate the label or to relabel the control.

**What to expect and not mistake for a bug:** with one account the inter-annotator number is
`insufficient-annotators` — null with a reason, never `0`. `testRetest` is the only reliability
signal that produces a value. This is the single most likely thing to be misread as a defect, which
is why it is written into three documents and now a fourth.

**Exit:** real `GoldenLabel` rows exist in production, produced through the UI by a human.
**Unmet as of 2026-08-29** — `SELECT count(*) FROM "GoldenLabel";` returns `0` against `judge_arena`
on `judge-arena-pg-1`. Steps 2 and 3 being done does not move this gate one row.

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

**Status, 2026-08-29: T5 is roughly 5% done and item 1 is untouched.** Not "in progress" — nothing
has been built. The measure is not opinion: VictoriaMetrics returns `seriesFetched: "0"` for
`{__name__=~"rabbitmq_.*"}`, so **not one RabbitMQ sample has ever been stored in this cluster**, and
there are zero `VMServiceScrape`s and zero `VMRule`s matching `rabbit` or `judge`.

1. **`VMServiceScrape` on `:15692` for both brokers.** Everything else depends on it.
   **CORRECTION 2026-08-29 — this item used to say "all three brokers". There are TWO.**
   `apps/managed/rabbitmq-shared.yaml` was deleted in `6f1a460` and Flux pruned `tenant-root/bus`;
   scoping this to three will produce one scrape target that does not exist.
   **The second correction is better news: every prerequisite already works, so this is a
   config-only change.** `rabbitmq_prometheus 4.2.4` is enabled, both Services publish
   `prometheus 15692`, and the endpoint answers with **2818 lines** when curled. Cross-namespace
   scraping is already permitted by the existing `allow-external-communication`
   `CiliumNetworkPolicy` — **no NetworkPolicy work is needed**, which earlier plans assumed there
   would be. What is missing is the `VMServiceScrape` object and nothing else.
2. Alerts, each with a stated self-clearing condition: disk-watermark alarm, memory-watermark alarm,
   publishers blocked, `judgment.execute` backlog sustained. **`judge.dlq` depth ships at `info`,
   not warning** — it has zero consumers by design, so at warning severity it is a ratchet that only
   an operator can clear. Put the purge command in the annotation.
   **NEW FACT 2026-08-29, and it changes how item 2 must be built: RabbitMQ's default `/metrics`
   carries no queue label at all.** It is aggregate-only. So the `judgment.execute` **backlog** and
   `judge.dlq` **depth** alerts named above are **impossible** from the endpoint item 1 scrapes —
   the series simply do not exist per-queue. They require a **second scrape** of
   `/metrics/detailed?family=queue_coarse_metrics`, and on that endpoint **only the leader node
   emits a depth sample**, so the query has to tolerate the other nodes reporting nothing rather
   than treating their absence as zero. Plan item 1 as *two* scrapes, not one; discovering this
   after the alert rules are written means rewriting them.
   **Add a fifth alert: consumers at zero on a queue that should have them.** E0 is the proof that
   this is not theoretical — a worker sat Running, 0 restarts, consuming nothing for five days, and
   every existing signal read green. Depth `0` with `consumer_count 0` is not idle, it is deaf.
3. Cap bulk enqueue: samples per run and `judgeLimiter` on the local-dataset path.
   **CORRECTION 2026-08-29 — this item used to demand "a request body size limit (there is none
   anywhere today)". There is one.** The ingress enforces **`50m`**, nginx's 1 MB default having
   been deliberately raised fifty-fold. So the work here is *reviewing whether 50m is the right
   number for the bulk-enqueue path*, and adding an application-level cap if it is not — not
   introducing a first limit. Writing this item as "there is no limit" would send someone to add a
   second one at a different layer, in ignorance of the first.
4. `judge.dlq` TTL and max-length; truncate the persist-failure envelopes, which currently carry
   full untruncated LLM responses.
5. Rubric size caps — unbounded today, and every criterion enters every judgment prompt.
6. Move the two judgment retry queues from single-node classic to quorum.

**Add one item this measurement surfaced:** the **disk** watermark has under 2 GB of headroom
(**3.9393 GB** free against a 2.0 GB low watermark, re-measured 2026-08-29) and is as unmonitored as
memory. T5's alert list already includes a disk-watermark alarm; this is the note that it is not
hypothetical.

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
| 5 | Is `agreement()` reused for human-vs-model? | **CLOSED 2026-08-31 — yes, and it is reused UNCHANGED.** `raterId` is opaque to it, so `'ground-truth'` is just another rater — the same trick `label-readings.ts` already uses for `'round-1'`/`'round-2'`. **A2 wrote no statistics code.** One defect *inside* `agreement.ts` was found while proving it: Fleiss builds `pe` from two exact integers so `pe === 1` on the nose, but Cohen accumulates `1/n`, and thirty additions of `1/30` sum to `0.9999999999999999` — so the `1 - pe === 0` guard missed the degenerate case and kappa silently collapsed to **0.5** for every n whose reciprocal does not sum exactly (3 and 4 do; **30, the calibration set size, does not**). A judge matching the key on all thirty items would have been filed under "moderate agreement": in range, not NaN, not null, indistinguishable from a real 0.5. Now an epsilon guard plus a clamp to kappa's defined `[-1, 1]`. |
| 1 | The `biasSensitivityRate` perturbation set | Unchanged, still open. Version it from the first run or the metric is not comparable across runs. |
| 2 | PPI configuration | Needs a gold sample size — which E1–E3 will make concrete rather than notional. |
| 3 | Confusion matrix: computed on read, or stamped at freeze? | A1 set the precedent: agreement is **computed on read, recorded at freeze**. Follow it unless there is a reason not to. |
| 4 | What "state of the art" compares against | Roadmap B's territory; A2's header carries it. |
| 6 | Drain rate and seconds | `EvaluationRun` still lacks run-grain `startedAt` (roadmap item 4), without which elapsed time conflates queue wait with execution. |

### A2.1 · The per-item join row — ✅ SHIPPED 2026-08-31, and NOT as a join row

*Original text, kept because the shape it proposed is the thing that changed:*

> The substrate that does not exist. `CalibrationRun` is a header with aggregate metrics and no
> per-item rows; `ModelJudgment` reaches a `DatasetSample` only through `Evaluation`. **Nothing pairs
> a `GoldenItem` with a model's verdict**, and without that there is no confusion matrix, no per-run
> disagreement list and no human-vs-model kappa.
>
> It carries the run, the item, the model's label **in `GoldenLabel`'s score-or-preference shape**
> (reuse it, or human and model verdicts stop comparing directly, which is the entire point of the
> row), a link to the `ModelJudgment` for reasoning, and the presentation order — because
> `positionBias` is measured by re-presenting the same pair both ways.

**The diagnosis was exactly right and the prescription was wrong.** There is no new table.
`20260830120000_v2i_calibration_item_link` adds **two nullable columns on `EvaluationRun`** —
`goldenItemId` and `calibrationRunId` — plus `@@unique([calibrationRunId, goldenItemId])`,
`CalibrationRun.rubricId`, and seven capture columns on `ModelJudgment`.

Two reasons, both of which the original text would have violated:

1. **An `EvaluationRun` is already 1:1 with a golden item by construction.** A pairwise run holds
   exactly one candidate pair (`RunCandidate @@unique([runId, position])`, and
   `buildPairwiseUserPrompt` requires exactly two). A join table would model a relationship the
   schema already enforces — and every per-item field the original text lists is already reachable
   from the run.
2. **"The model's label in `GoldenLabel`'s score-or-preference shape" is a stored `preference`, and
   A0 decision #4 forbids it.** Which sample was preferred is **derived** from `(verdict, pairOrder)`
   at read time. Storing it makes the B/A position-bias sweep a **backfill** instead of an insert —
   which is the precise failure the derive-never-encode rule exists to prevent, and it would have
   been introduced by following this item as written.

The unique index deliberately keeps Postgres' default `NULLS DISTINCT`: every ordinary run has both
columns NULL and they must all coexist, while at most one calibration run may exist per (calibration,
item). That is why v2i required **zero hand edits** and CONTRIBUTING's pseudo-drift table stays at
eight rows.

`CalibrationRun` was **read-only dead schema** until this — it existed, and the only code that
touched it was `isGoldenSetFrozen`'s `count()`. It is now written, and writing it is what **freezes
the golden set irreversibly**.

**Exit:** met. `CalibrationRun` = 1, `EvaluationRun` = 30, `ModelJudgment` = 30 in production.

### A2.2 · The run itself — ◐ PARTLY SHIPPED 2026-08-31

Reuse `src/lib/llm/*` rather than a parallel path, so calibration inherits retry, circuit-breaker
and BYOK behaviour instead of re-implementing it. Populate `kappa`, `rawAgreement`, `verdictCount`,
`passed`; drive `TrustState` `untrusted → calibrating → trusted|rejected` from thresholds **recorded
as data**, so a judge that passed under one threshold is re-derivable under a later one.

**Done:** the reuse, exactly as written and more strictly than required —
`launchCalibrationRun` creates rows and calls `launchSingleRun` N times. It publishes nothing itself
and knows nothing about providers; **a calibration run is an ordinary pairwise run with two extra
columns set**, drained by the same `judgment.execute` consumer. (Deliberately *not*
`launchBulkRunCreates`: `run-create-consumer.ts` refuses any protocol but `'pointwise'` up front, so
every item would have come back as a visible errored run.) `kappa`, `rawAgreement` and `verdictCount`
are populated, with `kappaVariant`/`kappaWeighting`/`thresholdMetric` recorded beside them.

**Not done:** `passed`, `passThreshold` and the `TrustState` transition. Both threshold columns are
**NULL** on the only run that exists — nothing has passed or failed, because no threshold has been
set. The "thresholds recorded as data" requirement is the reason `thresholdMetric` is a stored column
rather than an assumption, so the remaining work is choosing a number, not changing a shape.

**One correction to the metric ordering this item implies.** It lists `kappa` first and
`rawAgreement` second. **Accuracy is the primary number and kappa is a labelled secondary** —
`rawAgreement` *is* accuracy (the column predates the phase and its name was not changed), and
`thresholdMetric` is written as `'accuracy'`. Ground truth is an answer key, not a peer rater:
chance-correcting on its marginal is a category error, and kappa is not comparable across sets, which
is the one thing a leaderboard exists to do. Kappa is stored anyway because accuracy alone cannot
separate a judge that learned something from one that answers `A>B` every time — on this set that
degenerate judge scores 0.5667 accuracy and 0.0000 kappa.

### A2.3 · The report as a projection — ⛔ NOT STARTED

`EvaluationReport` is **computed from the per-item rows, not stored**. Each answer is stored exactly
once, so no second copy can drift from the first, and internal data stays recalculable without
duplicating the heaviest text in the product.

**2026-08-31: the principle is honoured; the surface does not exist.** `scoreCalibrationRun`
recomputes every field from the source rows and writes a **full overwrite** — nothing increments,
which matters because `verdictCount` is an `Int @default(0)` that an implementation reaching for
`{ increment }` would read perfectly and return 60 from on the second pass. Re-scoring after a
partial failure therefore resumes rather than accumulates, and `--score-only=<id>` exists to exercise
exactly that.

What does not exist is a **route or a screen**. The report is printed by
`scripts/calibration/run.ts` and nowhere else — deliberately, because the number was the deliverable
and the surface was not, and a CLI reaches the same `launchCalibrationRun`/`scoreCalibrationRun` a
route would, so adding the route later adds a *caller* rather than a second implementation. That is
the remaining A2.3 work.

### The accepted risk to re-examine before A2.1, not after — ⚠ A2.1 HAS LANDED AND THIS IS NOW LIVE

**Retention is uncapped, and that was a decision.** Nothing caps `rawResponse` or `reasoning`. The
per-item rows are the heaviest data this product will hold — items × judges × every re-run, each
carrying uncapped model text — and Postgres here is `instances: 1` on a single node.

The failure mode is a **full storage pool on a single-instance database**, whose first symptom is
*unrelated writes failing*. It was deferred while volumes were small. **A2.1 is the moment volumes
stop being small**, so the cheap mitigation — a documented byte cap with truncation recorded —
should be priced in there rather than discovered later. It closes a rebaseline item as a side
effect.

**STATUS 2026-08-31 — half priced in, half still open, and the open half got heavier.**

*Priced in:* `userPrompt` is capped at **32 KiB**, backed off to a UTF-8 character boundary, with
`promptTruncated` recording that it was capped and `userPromptSha256` taken over the **full, pre-cap**
text so a capped copy still identifies the exact bytes the model saw. That is the "documented byte
cap with truncation recorded" this item asked for, on the one field it was applied to.

*Still open, and now larger:* `rawResponse`, `reasoning` and the **new** `reasoningContent` are all
uncapped. A2.1 did not merely fail to cap the heaviest text — it **added a channel**, because
`reasoning_content` was being discarded entirely before. Not capping it was correct (it is the
evidence that explains a wrong verdict, which is the point of capturing it) but it means the per-row
cost is strictly higher than this item was written against.

> **NO FOOTPRINT NUMBERS ARE RECORDED HERE.** The measurement — per-row cost, and what N models × M
> items actually costs to store before it stops being viable — is a separate, dedicated exercise. Its
> results belong in a follow-up, with the spread and the assumptions stated, not a mean extrapolated
> from one 26-row run. **Do not fill this in from an average.**

### A2.4 · What running it for real added to the roadmap — NEW 2026-08-31

Three of these are not features. They are constraints the first real run discovered, and each one
names a failure that had already happened.

**1. Two entrypoints, because a leaderboard is many judges.** `/app/add-judge.js` and
`/app/calibration-run.js`, esbuild-bundled into the image, plus `npm run calibration:run` locally.
They must run **in the cluster**: only a pod can reach both `judge-arena-pg-rw.tenant-public` and a
judge endpoint. `add-judge.ts` reuses `createCustomJudgeModel` — the same chokepoint `POST
/api/models` goes through — so a CLI-registered judge gets its `model.create` audit row rather than
being invisible to the trail. **Note the failure that shipping them exposed:** `.dockerignore`
excluded `scripts/calibration/`, so `e4b9948`'s image built *successfully* and shipped without the
script it existed to ship. Check the built image, not the build log.

**2. The golden set is FROZEN IRREVERSIBLY by the first calibration.** `isGoldenSetFrozen` is
`calibrationRun.count({ where: { goldenSetId } }) > 0` — there is no `frozenAt` column and no
unfreeze verb anywhere in the product. Deleting the calibration is impossible
(`EvaluationRun.calibrationRunId` is `onDelete: Restrict`); retiring or tombstoning does not release
it; the only escape is `POST /api/golden-sets/[id]/fork` at version+1. This is why
`launchCalibrationRun` checks **everything knowable without touching an item** before writing the
header. The failure it prevents is specific: a golden set pinned forever by a calibration in which
all 30 items failed for one reason that was knowable before any of them ran.

**3. Truncation is now a HARD FAILURE, and the bug it closes was a silent one.**
`finish_reason: 'length'` / `stop_reason: 'max_tokens'`, or an empty content channel, throws
`non_retryable` in `registry.ts`'s `execute()` — **one chokepoint, before any parse**, so pointwise,
pairwise and respond all inherit it. **Respond mode previously persisted a truncated answer as
`status: 'completed'`**, making a generation chopped in half indistinguishable in the corpus from a
finished one; pointwise misclassified it as *retryable* and burned three attempts plus a shared
breaker on a deterministic failure. Non-retryable is correct because the token budget is a property
of the request, not of provider health. It fails on `'length'` even when the content parses — a model
cut off mid-reasoning is not a completed judgment for a calibration corpus.

**4. Concurrency is hard-capped at 1, and this is the item that changes T5's arithmetic.**
`src/worker/concurrency.ts` clamps `EVALUATION_MODEL_CONCURRENCY_PER_RUN` (1–16) to
`HARD_CONCURRENCY_CAP = 1`; the request is not an error, does not fail the boot, and the clamp is
logged at `warn`. `prefetch = concurrency × 4` was wrong twice: prefetch is not a buffer here
(`dispatch` starts a handler per delivered message, so prefetch **is** the concurrency), and even
un-multiplied it was one global number for a fleet of heterogeneous endpoints. **It cost four
dead-lettered items** — eight concurrent requests to a server advertising `total_slots: 2`, six
queueing *inside the server* while a 300s client timeout ran. **Measured, and worse than the headline:
the 26 judgments that completed have a stored `latencyMs` averaging 233s, median 265s, max 299,063 ms
against a 300,000 ms timeout** — 26 of 30 finished within a second of the wall, so this was much
nearer total loss than "4 of 30" reads. (Note that `src/worker/concurrency.ts:12-13` says those
judgments "averaged 94s"; that is **not** what the rows say, and `latencyMs` includes in-server queue
time by construction — see the plan doc §7.2. Do not quote 94s as a baseline.)
Over-subscribing an inference server converts a queue you can see (RabbitMQ: depth, retries, a DLQ)
into one you cannot, and then times out against it.

> **This interacts with T5 and with E4, and the interaction is favourable — do not undo it.** T5's
> hard ordering is *observability strictly first, before any concurrency increase*. The cap makes
> that ordering cheap to honour: throughput cannot rise until someone deliberately replaces the cap.
> **The eventual fix is per-endpoint concurrency, not a bigger global number** — the value belongs
> beside the endpoint that constrains it (a column on `ModelEndpoint`, or a probe of the server's
> advertised slots) with a scheduler that respects it per endpoint. **Add that as an A2 work item**;
> it is the lever E4 will want, and raising the cap instead is the wrong one.

**5. The cap ~~is NOT DEPLOYED~~ was promoted at 21:29Z on 2026-08-31 and is live.** Both Deployments
run `sha-1e7a427d2c48`; the worker logs `clamped to the hard cap {requested:2, effective:1}` and then
`judge worker started {prefetch:1, concurrency:1}` on boot. The struck clause was true at `21:23Z`
and false six minutes later — kept, because it is the reading the rest of this item was written
against.

**The durable point survives the promote, and it is a documentation hazard rather than a bug:** the
Deployment, the compose file and CONTRIBUTING's pool-sizing table all still say
`EVALUATION_MODEL_CONCURRENCY_PER_RUN=2`, and the worker runs at **1**. Anyone sizing capacity from a
manifest will be wrong by a factor of two. **The effective value is only observable in the boot
log** — which is exactly why the clamp is logged at `warn` rather than being silently applied.

---

## The critical path, in one place

```
M1 merge ─► M2 promote ─► M3 migrate ─► M4 seed ─┬─► E1 first real session ─► E2 provenance+blinding
   ✅           ✅            ✅           ✅    │      ⬅ YOU ARE HERE — inside E1, not before it
 (+ 14d75f7 merged 2026-08-29,                   │
    promoted to prod 2026-08-30)                 └─► E3 second annotator ──► real kappa
                                                                    │
   E1, opened up — it is half-executed:                             │
     1  sign in .......... ⛔ OIDC sub mismatch  ◄── FIX THIS NEXT  │
     2  create a set ..... ✅ 2026-08-19 13:44   (2 sets, 650 items)│
     3  self-assign ...... ✅ 2026-08-19 13:44   (2 assignments)    │
     4  label the items .. ⛔ GoldenLabel = 0    ← the gate         │
     5  agreement panel .. ⛔ no UI exists at all                   │
                                                                    │
   E0  dead 08-24, rolled 08-30 ─► fix AMQP reconnect: STILL OPEN   │
                                                                    │
                       T5 (observability first, ~5% done) ──────────┼──► E4 load shape
                                                                    │
                                                                    └──► A2.0 spec ─► A2.1 ─► A2.2 ─► A2.3
```

**UPDATE 2026-08-31 — the diagram above draws A2 hanging off E3, and that edge only exists for half
of A2.** The model-vs-ground-truth track does not touch E1–E3 at all, and it has already run:

```
   GROUND-TRUTH TRACK  (needs NO human label — GoldenLabel is still 0)
     A2.1 substrate ......... ✅ v2i, two nullable columns, shipped 2026-08-31
     A2.2 the run ........... ◐  reuse + accuracy/kappa done; passed/passThreshold/TrustState open
     A2.3 report projection .. ⛔ not started — no route, no screen; the CLI prints the report
        │
        └─► ✅ UNBLOCKED 2026-08-31 21:29Z: sha-1e7a427d2c48 promoted, cap live (prefetch 1).
               Re-run cmthr58r1... launched 21:30:17, in flight. Score it, then record the
               number WITH its denominator — and the first latency spread that is not
               inflated by in-server queueing.

   HUMAN-VS-MODEL TRACK  (genuinely gated on E1 → E3, unchanged)
     inter-annotator agreement, test-retest, human-vs-model kappa ... ⛔ GoldenLabel = 0
```

**Do not read "A2.1 shipped" as "the A2 gate cleared".** One track moved; the other has not moved
since 2026-08-19.

**Two independent tracks.** T5 is cluster work and needs no code from this repo; M1–M5 is release
work, and **M1–M4 are now all done** (M5 is branch bookkeeping and is the only one still open).
They can proceed in parallel, and A2 needs both. **One exception, added 2026-08-29:** E0 presents as a broker problem but its real fix — AMQP consumers that re-register on
reconnect — is **repo code**, so it lands on the release side of a split that otherwise puts
everything broker-shaped on the cluster side. Do not let it fall between the two tracks; that is
exactly how it went five days unnoticed.

**The one ordering that must not be violated:** T5's observability lands before any concurrency
increase, and before E4. Everything else has slack. **E0 is outside that ordering and outside the
slack** — a dead pipeline is not a sequencing question, and rolling the worker costs a minute.

---

## What is deliberately NOT here

- **A3, A4, A5** — unchanged in `2026-08-10-judge-training-engine-roadmap.md`. A3 in particular is
  the loop-closing surface and is worth reading before A2 is specced, because A2's per-item row is
  what A3 aggregates.
- **Roadmap B**, the public leaderboard half. Not started.
- ~~**`reasoning_content` capture** (preflight Stage 5). Still backlogged; the studio's reasoning panel
  is correct and thin until it lands, and says so.~~ **LANDED 2026-08-31 in A2.1** (`ae0d4a7`).
  `ModelJudgment` now stores `reasoningContent`, `reasoningSource` and `reasoningTokens`, extracted
  in a fixed, documented key order (`reasoning_content` first, then an in-band `<think>` block whose
  closing tag is optional so a truncated thought is still captured). It is deliberately **not** merged
  into `reasoning`, which is already triple-booked. Two honest gaps, both measured on all 30 rows:
  `reasoningTokens` is **NULL** because llama.cpp emits no `completion_tokens_details` in its usage
  payload, and `parseMode` is **NULL** because the pairwise path has one fence-tolerant parse path and
  therefore no strict→lenient demotion to record. **The studio's reasoning panel has not been updated
  to show any of this** — the capture landed, the surface did not.
- **Preflight Stage 5** more broadly — the only open preflight stage.
- **Rebaseline T6/T7** — versioning and obligations. Neither gates A2.
