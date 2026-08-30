# A2 — Calibration and reporting: decisions recorded

**Date:** 2026-08-17 · **Status:** **DECISIONS ONLY — not a full spec, and deliberately still not one.**
**Phase:** Roadmap A's **A2**, the calibration engine.
**Depends on:** **A1** for labels, and on rebaseline **T5** for broker safety.

> **UPDATE 2026-08-17: A1 and A1.5 are DONE** (`4ff04f4`…`05bf29b`), **merged (PR #13) and
> DEPLOYED** — production now runs `sha-bee1d121ea7d` at 18 migrations. And it *still* changes less
> than it looks like it does. **A1 shipped the ability to produce labels; none have been produced.**
> Production holds **0 golden sets**, so the input this document says A2's design requires — *real*
> label data — still does not exist. The deploy is no longer in the way; the annotation work is.
>
> **Both gates below therefore still stand**, and the sequencing between them is now written out in
> **`2026-08-17-integration-release-and-a2-roadmap.md`**, which is the document to read next. T5 was
> re-measured for it rather than quoted: **54.6% at idle, still zero scrapes and zero rules.**
>
> One open question moved, though. **#5 — whether `agreement()` is reused for human-vs-model — is
> now cheaply answerable**, because A1 shipped it: it takes `Reading[] = {itemId, raterId,
> category}[]`, and a model is just another `raterId`. Settle that FIRST when speccing, because it
> decides whether A2 writes any statistics code at all.
> **(It has since been settled — 2026-08-29, yes. See open question 5, which now records the
> signature that was read rather than the assumption that was made.)**

> **UPDATE 2026-08-29 — both gates re-checked, and one of them moved in a direction this document
> did not anticipate.**
>
> **A1 now has a UI surface and still zero output.** `feat/assignment-ui-and-random-subset`
> (`0309a7e`) plus a fixes commit (`ded6e1f`) merged to `gitea/main` as **`14d75f7`**, adding the
> assignment panel on `/golden-sets/<id>` (Assign to me / Revoke / a shortcut into the studio), a
> `toPublicOwner` projection returning `{id,name}` and never the email, and server-side random
> subset selection. No migration. **Promoted 2026-08-30 01:47Z**: `judge-arena-web` and
> `judge-arena-worker` now run `sha-14d75f7d46de`, so the `sha-bee1d121ea7d` in the 2026-08-17
> block above is a record of that day, not of today. Still 18 migrations — `14d75f7` ships none.
>
> **The sentence "Production holds 0 golden sets" above was true when written and is now wrong.**
> Verified against `judge_arena` on prod: **2 `GoldenSet`** (620 items and 30 items), **650
> `GoldenItem`**, **1300 `GoldenCandidate`**, **2 `GoldenAssignment`** — created and both
> self-assigned by the owner on **2026-08-19 13:44**, neither revoked, neither completed. What is
> zero is **`GoldenLabel`**, ten days on. So this document's conclusion survives exactly as written
> — *real label data still does not exist, so A2 still cannot be specced* — while its stated reason
> does not. It is not an empty catalog, and since `14d75f7` it is not a missing surface either.
>
> **The actual blocker is an identity mismatch, and it changes the next action completely.** The
> `User` row that owns both sets and holds both assignments carries an `oidcSubject` matching the
> Authentik account `akadmin`; every sign-in attempt since 2026-08-18 has been as `trijeet`, a
> *second* Authentik account on the same email with a different uuid, and the provider's `sub_mode`
> is `user_uuid`. `resolveOidcUser` falls through, `ALLOW_OIDC_AUTOPROVISION` is not set on the
> deployment, and sign-in is refused: three authentik `authorize_application|trijeet` events each
> have a matching `user.login.failed {"method":"oidc","reason":"no_match_autoprovision_disabled"}`
> `AuditLog` row within a second, and **no successful `user.login` has ever been written**. (Read
> that last clause narrowly — the whole audit table is 44 `user.login.failed` plus one
> `user.invite_claimed` on 2026-08-07, and `src/lib/auth.ts:157-161` records a successful
> invite-claiming sign-in under that *other* action, so it is evidence about repeat sign-ins
> rather than about sign-in as such; something did hold a working session on 2026-08-19 or
> these sets would not exist. The roadmap doc carries the full note. It does not change the
> fix.) Fastest
> path, no mutation: sign in as `akadmin`. Durable fix: repoint that one `oidcSubject`, or
> consolidate the duplicate Authentik accounts. **Do not mint a fresh invite and do not enable
> autoprovision** — either creates a second, empty `User` that owns nothing and would take a hard
> 403 from the queue on both sets.
>
> **Two more things stand between here and a first label, and the merge fixed neither.** (1) E1's
> "read the agreement panel" step **has no UI**: `GET /api/golden-sets/[id]/agreement` works, but
> nothing under `src/app/**` or `src/components/**` calls it, and the only "Agreement" on screen is
> a hard-coded empty progression-rail stage at `src/app/golden-sets/[id]/label/page.tsx:87`. Read
> the JSON directly until it is built. (2) **All 1300 production `GoldenCandidate` rows have
> `label IS NULL`** — `toCandidate()` at `src/lib/golden-sets.ts:180` hard-codes it — so the studio
> renders "Option 1"/"Option 2" while the verdict control asks for `A>B`/`tie`/`B>A`, and nothing on
> screen says Option 1 is A. The mapping is deterministic in code; an annotator guessing it the
> other way inverts every preference in the session silently. **That one matters to A2 directly**:
> it is a way for the label data A2 depends on to arrive systematically wrong while looking fine.

| What | Spec | Plan |
|---|---|---|
| **A1** — human verification, the agreement floor | `2026-08-17-a1-human-verification-design.md` | `../plans/2026-08-17-a1-human-verification.md` — 7 tasks · **DONE** |
| **A1.5** — the annotation studio | `2026-08-17-a1_5-annotation-studio-design.md` | `../plans/2026-08-17-a1_5-annotation-studio.md` — 5 tasks · **DONE** |
| **Getting from here to A2** | `2026-08-17-integration-release-and-a2-roadmap.md` — merge, promote, migrate, seed, end-to-end, T5 | *(each item becomes its own plan)* |
| **A2** — this document | *(decisions only)* | *(none — see below)* |

A1 and A1.5 were **independent and buildable in parallel**: A1 owns the data and endpoints, A1.5
owns the surface, and they met only in A1.5's last task. In the event A1 landed first, so that task
composed the real queue and submit routes rather than the static fixture it was designed to fall
back to.

> **Why this document exists rather than a spec.** These decisions were made while designing A1 and
> would otherwise survive only in a conversation. A2 cannot be specced properly until A1 has produced
> real labels — the shape of the agreement data is an input to the calibration design, not an
> assumption to be made ahead of it. This records what is settled so it is not re-litigated, and what
> is open so it is not mistaken for settled.

---

## The two artifacts

A calibration run produces **two things with different audiences, different lifetimes and different
visibility**:

### 1. `CalibrationRun` — the header

What the user learns from: **how their evaluator performs against others and against the state of the
art.** One row per run. It is the thing that can be **entered into the leaderboard**, or referenced
internally without publishing.

The model already exists and already carries the metric columns (`kappa`, `rawAgreement`,
`testRetest`, `positionBias`, `biasSensitivityRate`, `flipRateVsParent`, `verdictCount`, `passed`)
plus decision #3's provenance (`passThreshold`, `thresholdMetric`, `kappaVariant`, `kappaWeighting`)
and timing (`startedAt`, `finishedAt`).

**It must be frozen once published or referenced.** There is **no `Leaderboard` model** —
`src/app/api/leaderboard/route.ts` computes over existing rows — so the header row *is* what the
board reads. A header that can move after publication makes the leaderboard silently
non-reproducible.

### 2. `EvaluationReport` — the introspection

An **item-by-item breakdown of the run**, for full introspection into *how* or *why* the evaluator
performs as it does. This is where a number becomes a reason: which items diverged, in which
direction, and what the judge said about them.

**It is a PROJECTION, not a stored document** (decided 2026-08-17). One row per golden item per run
holds the model's label — in the same score-or-preference shape `GoldenLabel` uses, so human and
model verdicts compare directly — plus a link to the `ModelJudgment` carrying its reasoning. The
confusion matrix, the disagreement ranking and the drill-down are **computed from those rows**.

Two reasons this beats a materialised document: each answer is stored exactly once, so no second copy
can drift from the first; and it satisfies the standing rule that internal data is *always viewable
or recalculable* without duplicating the heaviest text in the product.

---

## The substrate this needs, which does not exist

**Nothing today pairs a `GoldenItem` with a model's verdict.** `CalibrationRun` is a header row with
aggregate metrics and no per-item rows; `ModelJudgment` hangs off `EvaluationRun` and reaches a
`DatasetSample` only through `Evaluation`. Verified at `43ce744`.

Without that join row there is no confusion matrix, no per-run disagreement list, and no
human-vs-model kappa — which is most of what "view that run's performance" means. **A2's first
schema work is that per-item row.** It carries, at minimum:

- the `CalibrationRun` it belongs to, and the `GoldenItem` it is about
- the model's label, in `GoldenLabel`'s score-or-preference shape — **which A1 defines**: nullable
  `overallScore` XOR `preference`, under the `GoldenLabel_score_xor_preference` CHECK. Reuse that
  shape rather than inventing a second one, or human and model verdicts stop comparing directly,
  which is the entire point of the row
- a link to the `ModelJudgment` that produced it (reasoning, `rawResponse`, latency, tokens)
- the position/order the item was presented in, since `positionBias` is measured by re-presenting the
  same pair in both orders

---

## The layering, for reference

| Concept | What it is | Where it lives |
|---|---|---|
| **golden set** | questions, candidate answers, human labels | `Golden*` — A1. **No model concept.** |
| **model** | which model, who owns it, which compute | `JudgeModel`/`JudgeModelVersion` + `ModelEndpoint` |
| **evaluation** | one golden set × one model | `CalibrationRun` — A2 |
| **evaluation performance** | that run's seconds, drain rate, confusion, bias, kappa | `CalibrationRun` columns + the per-item rows — A2 |
| **model performance** | aggregated across runs: throughput, bias, confusion, kappa | does not exist — A3 |

Product flow: pick a golden set and a model from a menu, request an evaluation, then view **that
run's** performance, confusion, agreements and disagreements.

---

## Accepted risks and open questions

**RETENTION IS UNCAPPED, AND THAT IS A DECISION** (2026-08-17). Nothing in `src/` caps `rawResponse`
or `reasoning` — verified, not assumed. The per-item rows are the heaviest data this product will
hold: items × judges × every re-run, each carrying uncapped model text. The rebaseline already lists
*"cap `rawResponse`/`reasoning` growth"* as outstanding, and Postgres here is `instances: 1` on a
single node with a LINSTOR-backed volume.

The failure mode is therefore **a full storage pool on a single-instance database**, not a slow
query — and its first symptom is unrelated writes failing. Deferred deliberately while volumes are
small; the cheap mitigation when it is wanted is a documented byte cap with the fact of truncation
recorded, which closes the rebaseline item as a side effect.

**Still open, to be settled when A2 is specced:**

1. **The `biasSensitivityRate` perturbation set** (roadmap decision #4) — a metric whose value depends
   entirely on its definition, so it needs versioning from the first run.
2. **PPI configuration** (roadmap decision #7) — gold-sample size, and whether the confidence interval
   gates anything.
3. **Confusion matrix storage** — computed on read like the rest of the report, or stamped onto the
   header when it is frozen for the leaderboard.
4. **What "against the state of the art" compares to** — the reference judges, and where their runs
   come from. Roadmap B's territory, but A2's header is what would carry the comparison.
5. ~~**Whether `agreement()` is reused for human-vs-model.**~~ **SETTLED 2026-08-29 — yes, and it
   means A2 writes no statistics code at all.** This entry asked for the signature to be *confirmed
   rather than assumed*; it has now been read, at `14d75f7`:

   ```ts
   // src/lib/agreement.ts:72 and :227
   export type Reading = { itemId: string; raterId: string; category: string };
   export function agreement(readings: Reading[], opts?: { weighting?: Weighting }): AgreementResult
   ```

   `raterId` is an opaque `string`, and the module **imports nothing** — no Prisma, no clock, no env
   (pure on purpose, so it runs in the DB-free unit suite), so nothing in it can tie a rater to a
   `User`. The reuse is not even hypothetical: **`src/lib/label-readings.ts:116-117` already feeds
   `agreement()` synthetic rater ids** — `'round-1'` and `'round-2'` — to compute test-retest. That
   is shipped, tested precedent that a rater need not be a person, which is a stronger answer than
   the type signature alone. A `judgeModelVersionId` is one more string. **Human-vs-model kappa is a
   projection, not a statistic.**

   Three things the projection must handle. All are visible in the code, none is a rewrite, and A1
   already solved the first one:

   - **`annotatorCount` will lie unless A2 reports its own.** `agreement()` derives it from distinct
     `raterId`s (`agreement.ts:229`), so one human plus one model comes back as `annotatorCount: 2`
     — a straightforwardly false statement about who produced the number. `testRetestReadings`
     hit this first and returns its own `annotatorCount` alongside the readings; the comment at
     `label-readings.ts:88-92` says exactly why. Do the same.
   - **`interAnnotatorReadings` is not the projection to reuse.** It filters to `round === 1` and
     drops anonymised labels (`label-readings.ts:63-72`) — both correct for human-vs-human and both
     wrong here. Human-vs-model needs a fourth function beside the three that exist, for the reason
     that file gives for having three.
   - **The statistic and the weighting are chosen for you, and must be reported.** One human + one
     model = two raters, so **Cohen's** (`agreement.ts:247`); and `weighting` is forced to `'none'`
     for non-numeric categories (`agreement.ts:249`), which is every pairwise `preference`. So a
     preference-set human-vs-model kappa is **unweighted and says so** — consistent with roadmap
     decision #3, which requires the weighting be recorded, not that it always be applied. Add a
     second human (two humans + a model) and it silently becomes **Fleiss**, unweighted by
     construction. Which of those A2 reports as "the" agreement number is a reporting decision A2
     owns; it is not a defect in `agreement()`.

6. **Drain rate and seconds** — `CalibrationRun` has `startedAt`/`finishedAt` but no throughput
   measure, and `EvaluationRun` still lacks the run-grain `startedAt` the roadmap flags (item 4),
   without which elapsed time conflates queue wait with execution.

   **Re-verified 2026-08-29 against `prisma/schema.prisma` at `14d75f7`: still true.**
   `EvaluationRun` carries `deadlineAt`, `finalizedAt`, `createdAt` and `updatedAt`, and no
   `startedAt`. Note why grepping misleads here — `startedAt` **is** in the schema twice, on
   `ModelJudgment` (judgment grain) and on `CalibrationRun` (`@default(now())`) — so the column name
   is present and the run-grain gap is easy to read past. What that means for this question
   specifically: **`CalibrationRun` can already time itself**, because its `startedAt` is stamped on
   insert, so *items finished per second of calibration run* is computable today. What is not
   computable is *judging throughput*, because the boundary that separates queue wait from execution
   is the column that does not exist. Say which of the two a reported drain rate is, or the number
   will be read as the second while measuring the first.

---

## Hard gates before any of this runs

- **A1**, for labels. ~~There is no `GoldenLabel` writer today, so there is nothing to calibrate
  against.~~ **UPDATED 2026-08-29: the writer exists, the surface to reach it exists, and there is
  still nothing to calibrate against.** A1 shipped the writer on 2026-08-17; `14d75f7` shipped the
  assignment panel that gets an annotator from a golden set into the studio. Prod holds 2 golden
  sets, 650 items and 2 live whole-set assignments dated 2026-08-19 — and **`GoldenLabel` = 0**,
  because sign-in is refused by the OIDC subject mismatch described at the top of this document. The
  gate is unchanged in force and completely changed in what would clear it: **fix one identity, not
  build one feature.**
- **Rebaseline T5.** Measured 2026-08-17 on `rabbitmq-judge-arena-server-0`: **0.1405 GB against a
  0.2577 GB watermark — 54.5% at idle**, with **zero** VMServiceScrapes and **zero** VMRules covering
  RabbitMQ. Calibration is a burst of judgment work against exactly that broker. The roadmap calls T5
  a hard gate on A2 rather than a nice-to-have, and the reason is that the failure is silent: publishers
  block, no metric moves, no alert fires, and the symptom — runs that never start — points at the
  worker.

  > **UPDATE 2026-08-29 — the 2026-08-17 measurement above stands as recorded; here is today's.**
  > At idle: **0.1197 GB against the same 0.2577 GB watermark = 46%**, no alarms, and 3.9393 GB free
  > disk against a 2.0 GB low watermark. **T5 itself is ~5% done and item 1 is untouched** —
  > VictoriaMetrics returns `seriesFetched: "0"` for `{__name__=~"rabbitmq_.*"}`, so not one
  > RabbitMQ sample has ever been stored in this cluster; still zero VMServiceScrapes and zero
  > VMRules. Everything the scrape needs already works (`rabbitmq_prometheus 4.2.4` enabled, both
  > Services publishing `prometheus 15692`, the endpoint answering 2818 lines, and
  > `allow-external-communication` already permitting cross-namespace scraping — **no NetworkPolicy
  > work needed**). Two corrections for whoever specs it: there are now **two** brokers, not three
  > (`apps/managed/rabbitmq-shared.yaml` deleted in `6f1a460`, `tenant-root/bus` pruned by Flux),
  > and **the default `/metrics` carries no queue label at all**, so the `judgment.execute` backlog
  > and `judge.dlq` depth alerts need a second scrape of
  > `/metrics/detailed?family=queue_coarse_metrics`, where only the leader node emits a depth
  > sample.
  >
  > **And a third gate exists that this document did not have: the run pipeline was dead when this
  > was written.** All five queues reported `consumer_count=0` from **2026-08-24T17:55Z**
  > (see the 2026-08-30 update below for how that ended). The Cozystack v1.6.2 roll
  > recreated `judge-arena-pg-1` at 17:54:57Z; the worker logged `Can't reach database server` /
  > SQLSTATE 57P01 twenty-one seconds later and has logged nothing since, while sitting 1/1 Running
  > with 0 restarts. Its database socket reconnected; its **AMQP consumers never re-registered**. A
  > worker rollout restores service, but the defect — consumers registered on boot and not on
  > reconnect — is unfixed. Note how precisely that rhymes with the failure this section warns
  > about: a silent broker-side stall whose only symptom is runs that never start, pointing at the
  > worker. It has already happened once, before A2 exists to trigger it.
  >
  > **UPDATE 2026-08-30 — service is back, the defect is not fixed, and the gate does not lift.**
  > The `14d75f7` promote rolled `judge-arena-worker` at `2026-08-30T01:47:21Z` and the consumers
  > re-registered as a side effect: `rabbitmqctl list_queues name messages consumers` on
  > `rabbitmq-judge-arena-server-0` now reports `run.create 0 1` and `judgment.execute 0 1` (the
  > DLQ and the two retry queues sit at 0 consumers by design, not by outage). Nobody diagnosed
  > it; an unrelated deploy did what a rollout does. The reconnect defect is still in the tree, so
  > this is a third gate on A2 exactly as written above — a calibration burst is the workload most
  > likely to trip it again, and the six days it went unnoticed is the measurement that matters,
  > not today's consumer count.
