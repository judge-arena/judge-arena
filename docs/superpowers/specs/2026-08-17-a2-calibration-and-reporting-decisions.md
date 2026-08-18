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
5. **Whether `agreement()` is reused for human-vs-model.** A1 ships
   `src/lib/agreement.ts` taking `Reading[] = {itemId, raterId, category}[]`. A model is just another
   `raterId`, so human-vs-model kappa should need no new statistics — only a projection of the
   per-item verdicts into `Reading[]`. Confirm this when A2 is specced rather than assuming it, since
   it decides whether A2 writes any statistics code at all.
6. **Drain rate and seconds** — `CalibrationRun` has `startedAt`/`finishedAt` but no throughput
   measure, and `EvaluationRun` still lacks the run-grain `startedAt` the roadmap flags (item 4),
   without which elapsed time conflates queue wait with execution.

---

## Hard gates before any of this runs

- **A1**, for labels. There is no `GoldenLabel` writer today, so there is nothing to calibrate
  against.
- **Rebaseline T5.** Measured 2026-08-17 on `rabbitmq-judge-arena-server-0`: **0.1405 GB against a
  0.2577 GB watermark — 54.5% at idle**, with **zero** VMServiceScrapes and **zero** VMRules covering
  RabbitMQ. Calibration is a burst of judgment work against exactly that broker. The roadmap calls T5
  a hard gate on A2 rather than a nice-to-have, and the reason is that the failure is silent: publishers
  block, no metric moves, no alert fires, and the symptom — runs that never start — points at the
  worker.
