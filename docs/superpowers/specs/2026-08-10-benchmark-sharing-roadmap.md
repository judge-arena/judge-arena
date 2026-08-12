# Roadmap B: benchmarks, review and the public leaderboard

**Date:** 2026-08-10 · **Status:** proposed, awaiting owner decisions
**Scope:** the sharing half — evaluate a trained judge against standardized benchmarks, review the
result, and publish it as a public good.
**Sibling:** `2026-08-10-judge-training-engine-roadmap.md` (Roadmap A) produces the judge this
roadmap measures.
**Platform foundation:** `2026-08-08-north-star-rebaseline-design.md` — data tiers, retention,
resilience, cluster constraints, and the board's serving work (its T3) all live there and are not
repeated here.

---

## What this half is for

Roadmap A answers *is my judge any good, against my own labels?* This one answers *how does my
judge compare to everyone else's, on a yardstick nobody controls?* The second question is the one
that needs a shared, curated, immutable benchmark set and a public board — and it is the reason the
public tier exists at all.

The loop closes here: a distilled judge from A gets a benchmark score in B, and that score is the
evidence that the distillation was worth doing. `flipRateVsParent` (A4) says the judge *changed*;
a benchmark score says it got *better*, against a yardstick the trainer did not choose.

---

## Publication is now a reviewed promotion, not an automatic consequence

**Decided 2026-08-10, and it supersedes the rebaseline's earlier framing.** A hosted run publishes
to *our database*; it is **not** automatically promoted to the public leaderboard. Promotion
requires **manual review.**

So there are four states, not three:

| State | Meaning | Who sees it |
|---|---|---|
| **User-retained** | No hosted compute spent | Only the user |
| **Platform-granted** | Hosted compute ran it; recorded in our database | The platform |
| **Candidate** | A hosted run against a published benchmark, eligible for the board | The platform, and the submitting user |
| **Public** | Promoted by a human after review | The world |

This is a better design than the automatic version it replaces, and worth being explicit about why:
compute provenance is a fact that can be *established mechanically*, but "this number belongs on a
research leaderboard" is a judgement that cannot. Making promotion a human act protects the public
tier's value, gives a clean answer to the verified-vs-self-reported problem (everything is reviewed,
so provenance becomes an input to review rather than a badge that has to carry trust on its own),
and means a gaming attempt has to get past a person rather than past a predicate.

**The cost is operator time, and it is a real scaling constraint.** At 10 users a review queue is
minutes a week; the same queue with automated submissions is a job. That is the same trade already
accepted for admin-only benchmarks, and it should be tracked rather than rediscovered — the trigger
to revisit is the queue's arrival rate, not a user count.

**What review actually examines matters more than that it happens.** A score is a bare number; a
reviewer cannot assess one. The queue has to present *evidence*: which benchmark version, which
judge model version and its lineage, the run's protocol, the verdict distribution, calibration
state, and anything anomalous (degenerate distributions, suspiciously perfect agreement, a
`positionBias` that says the judge is answering by position rather than content). Designing that
evidence view **is** designing the review.

---

## What exists today

- **No `Benchmark` entity.** It does not exist in the schema in any form.
- **The board is single-tenant and project-scoped.** `leaderboard/route.ts` filters to one
  `leaderboardProject.id`, and there is no API that can even create that project. It is publicly
  *readable* and not publicly *contributable*.
- **The board's response shape is missing most of the target row.** No user/org, no benchmark, and
  none of the selection metrics (cost, latency, reliability) — and `toPublicLeaderboardEntry` is an
  allow-list, so fields not added there are silently dropped rather than erroring.
- **There is no `/leaderboard` route.** The board renders client-side on the landing page, which
  shares a URL with HTML that is structurally uncacheable (per-request CSP nonce).
- **`RunProtocol` is already `pointwise | pairwise | listwise`.** The schema can express
  ranking-style judge benchmarks without a migration, which is a genuine head start.
- **Serving is unfit for a front door**: no cache anywhere, no rate limiter at all on the board
  route, readiness gated on Redis *and* RabbitMQ at one replica, and an aggregation that
  materialises every judgment in Node. All of this is specified in the rebaseline's T3; this
  roadmap depends on it rather than restating it.

---

## Phases

### B0 — The `Benchmark` entity and the standard set · ~4 days

Admin-only creation and publication (owner decision, 2026-08-10; user proposition deferred).

- `Benchmark` binding a canonical `(dataset, rubric)` pair, mirroring `GoldenSet`'s shape —
  `visibility`, `publishedAt`, `retiredAt`, `ownerId … onDelete: SetNull` — because that idiom is
  already understood by `account-deletion.ts`. `@@unique([datasetId, rubricId])` is load-bearing:
  it forecloses publishing the same pair under two names, which is intended, but reversing a unique
  index after rows exist means choosing a winner.
- `EvaluationRun.benchmarkId`, threaded through `run-launch.ts`.
- **Both halves of a published benchmark must be immutable.** The rebaseline already requires
  immutable rubrics and datasets; a benchmark is the pair, so publishing one is what makes the
  immutability guarantee *matter* rather than merely hold.
- **Seed the standard benchmark set** — the actual yardsticks, each a curated `(dataset, rubric)`
  pair. JudgeBench and RankJudge are the two named candidates that fit this shape. Each still needs
  a definition pass before implementation, because a benchmark built from a guess is worse than no
  benchmark, and I am least confident of a canonical **RankJudge** definition — I would want yours
  or a source before building it.

**Correction, per the owner 2026-08-10: PPI and the coin-flip measure are NOT benchmarks.** An
earlier draft of this roadmap modelled them as candidate benchmark entities, which was wrong. They
are **per-run measurements** that apply to any run against any dataset — they exist to say what real
gain an evaluator delivers, which is a property of a *result*, not a yardstick to be scored against.
They are specified in **Roadmap A's A3** (the per-run measurement bundle), alongside the confusion
matrix, throughput and latency.

That correction simplifies this roadmap rather than complicating it: `Benchmark` **is** strictly a
`(dataset, rubric)` pair, with no estimator or reference-judge variants to model, so the taxonomy
question this section previously raised as "the one expensive choice" dissolves.

One thing does cross back the other way: **Roadmap A's A3 needs "position on the leaderboard for the
same dataset" as an input**, so this roadmap owes A a query — given a dataset and a judge model
version, where does it sit among published rows. That is a read against the board's own aggregation
and is cheap once B3's SQL exists, but it is a dependency in the A→B direction that would otherwise
go unnoticed until A3 is being built.

**Exit gate:** a published benchmark exists, its dataset and rubric are immutable, and a run can be
launched against it.

### B1 — Candidate results · ~2 days

- Record eligibility on the run: hosted provenance plus a published benchmark. This is the
  `candidate` state, and it is a query, not a new column beyond what the rebaseline already
  specifies (`executionTier`).
- Show users their own candidate results immediately, with their status. A submission that
  disappears into a queue with no feedback reads as broken.
- **Answered by the rebaseline, restated because it matters here:** a hosted run against an
  *unpublished* pair produces no board row and never becomes a candidate. It is platform-granted
  and private, which is what lets someone use hosted compute without appearing anywhere.

**Exit gate:** a completed hosted run against a published benchmark appears as a candidate to its
owner and nowhere else.

### B2 — The review queue and promotion · ~4 days

- A review queue presenting the evidence set described above, not just scores.
- Promotion and rejection as explicit, audited acts: who, when, why. The board is a research good,
  so its provenance includes *the decision to publish*, and `AuditLog` already exists for this
  (note the rebaseline's requirement to stop writing emails into its metadata).
- Rejection needs a reason the submitter can see, or review becomes arbitrary from the outside.
- **Demotion must exist from the start.** A published row that later turns out to be wrong needs a
  path off the board — and because deletion elsewhere reassigns rather than purges, decide
  explicitly whether demotion hides the row or annotates it. *Recommendation: annotate.* A research
  board that silently retracts is less trustworthy than one that shows a correction.

**Exit gate:** a candidate is promoted, appears publicly, and can be demoted with the reason and
actor recorded.

### B3 — The public board · depends on the rebaseline's T3

Everything here is specified in the rebaseline and referenced rather than duplicated: the SQL
aggregation keyed on `(user, model, benchmark)` with hand-written partial indexes, its own
`/leaderboard` route split away from the nonce'd HTML, edge caching with `stale-if-error` plus the
"as of" age indicator shipped in the same change, a rate limiter on a route that currently has
none, the readiness split, and the bounded dataset export.

Additions specific to this roadmap:

- The board must be **grouped by benchmark**, because scores are only comparable within one. A
  single global ranking across benchmarks would be a category error presented as a feature.
- **The board carries the selection metrics, not just the score.** Owner thesis, 2026-08-10: how
  fast, how much and how reliably are the primary axes for choosing a judge framework. So a row is
  score **plus cost, latency and reliability** — and reliability shows its components (availability,
  determinism, robustness, format compliance) rather than one opaque number, because a judge that is
  99% available and wildly non-deterministic is unreliable in a way an average conceals. This is a
  recorded widening of the public tier; see the rebaseline. Sorting must be possible on each axis,
  since the whole point is that different choosers weight them differently.
- **Where opted in, link the published reasonings.** The owner's own leaderboard-listed evaluations
  are published as a public good, and users may opt in. That corpus is what makes a board row
  inspectable rather than merely rankable — and it is the same corpus Roadmap A's diagnosis reads.
- Show the **CoinFlip floor** alongside scores if that reference judge lands — a number is easier to
  read against a baseline than in isolation.
- Surface **calibration state and lineage** from Roadmap A. A `trusted` judge and an `untrusted`
  one sitting at the same score are not the same claim.

### B4 — External submission · ~3 days, after B2

The self-hosting commitment includes "publish only your final scores," which needs a submission
path from an instance we do not run. It does not exist today.

- `executionTier: 'external'`, and it enters the *same* review queue — which is why making
  promotion manual in B2 first is what makes this tractable at all.
- Integrity story, decided before the first submission rather than after the first inflated score.
  **Note a correction:** an earlier draft proposed matching `Rubric.contentHash`. That cannot work —
  the owner has settled that `contentHash` is **admin-internal and instance-specific** (never
  displayed), so two instances will not agree on it by construction. Cross-instance verification
  needs a *separately published* canonical digest that is part of the benchmark's public definition
  and computed by a documented, unsalted algorithm. Keep the two distinct: `contentHash` is an
  internal freeze/dedup aid; the published digest is the verification token. Signing the submission
  is the stronger option and does not depend on either.
- Badge provenance visibly and offer a verified-only filter. Mixing platform-run and self-reported
  rows unlabelled makes the research good less trustworthy than a smaller closed board would be.

**Exit gate:** a self-hosted instance submits a score, it is reviewed like any other, and its
provenance is visible on the row.

---

## Deliberately not doing

- **User-proposed benchmarks.** Deferred by owner decision. The bottleneck is intentional while the
  standard set is being established.
- **A single cross-benchmark ranking.** Not comparable; see B3.
- **Automatic promotion on any criterion.** The whole point of B2 is that this judgement is human.
  A heuristic that auto-promotes "obvious" cases is how the gate erodes.
- **Sub-run detail on the public board** (per-sample scores, judge reasoning). Owner decision:
  the public tier is score, benchmark, model, handle — nothing else.
- **Human judgements as a score.** Owner decision, 2026-08-10. They surface as *human agreement*
  in Roadmap A, which is a different and more useful axis.

---

## Decisions this roadmap needs

1. **RESOLVED 2026-08-10 — `Benchmark` is strictly a `(dataset, rubric)` pair.** PPI and the
   coin-flip floor are per-run measurements in Roadmap A's A3, not benchmark variants, so there is
   no estimator or reference-judge modelling to do here.
2. **Confirm the definitions** of JudgeBench and RankJudge, or point me at sources — RankJudge is
   the one I would not build from inference. (PPI and coin-flip definitions now belong to Roadmap A.)
3. **What evidence does the review queue show**, and what is disqualifying? This is the design of
   review, not a detail of it.
4. **Does demotion hide or annotate?** *Recommendation: annotate.*
5. **Who reviews?** Only you, or a reviewer role? A role means a permission model beyond
   `isAdmin`, which today is the only gate that works for cookie sessions.
