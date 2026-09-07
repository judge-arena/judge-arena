# The reaper kills judgments it just reclaimed — 2026-09-07

## 0. If you read one thing

**`reclaimStaleJudgments` is the only `running → pending` requeue path in the tree that does not clear the
run's execution deadline — and the same sweep then force-finalizes the judgment it just rescued.**

It has already killed one. Production row `cmtluq5t5038x2l0s83p3h1aw`, inside calibration
`cmtluplg500012l0sj315kyar` (the 78-hour qwen3.5:9b run), is the single `reaper: abandoned` judgment in
4200. Its timings are the trace, exactly:

| field | value | derivation |
|---|---|---|
| `startedAt` | 2026-09-06 21:40:09.334 | first dequeue; deadline stamped here |
| `deadlineAt` | 2026-09-06 21:56:09.34 | `startedAt + 960_000` — `runStartBudgetMs(1)` to the millisecond |
| `updatedAt` | 2026-09-06 21:59:25.437 | `deadlineAt + ~196 s` — the 180 s force-finalize grace plus sweep granularity |
| `attemptCount` | 2 | it had been reclaimed and republished |

**So one of that run's 164 "errors" is an infrastructure kill scored as a judge failure.** The published
`noVerdictRate` of 0.2645 — the figure that pushed the run over the 0.25 threshold and out of the
rankings — includes at least one judgment the fleet killed while it was healthy and queued.

The fix is about eight lines and no schema change: after a successful republish, the reaper's reclaim calls
the same `clearRunDeadlineOnRequeue(runId)` the consumer's retry path already calls
(`judgment-consumer.ts:1346`).

## 1. Why it fires every time, not occasionally

The two constants are 30 seconds apart, in the wrong direction:

```
LEASE_MS            = hardCapMs + POST_CALL_SLACK_MS (30_000)  =   930_000   (15.5 min)
runStartBudgetMs(1) = hardCapMs + RUN_DEADLINE_SLACK_MS (60_000) = 960_000   (16.0 min)
```

Production resolves `hardCapMs = DEFAULT_HARD_CAP_MS = 900_000` (`EVALUATION_MODEL_HARD_CAP_MS` is not set
on `judge-arena-worker`).

A judgment claimed at `T` stamps the run deadline at `T + 960_000`. Its lease expires at `T + 930_000` —
**30 seconds earlier**. `reclaimStaleJudgments` therefore fires on the sweep at or after `T + 930_000`, and
with `SWEEP_INTERVAL_MS = 60_000` the reclaim almost always lands *after* `T + 960_000`. The deadline has
already passed at the moment the judgment is rescued.

Then, in the **same** `runReaperSweep()` call:

- `reclaimStaleJudgments` runs first (`reaper.ts:466`) — sets `running → pending`, republishes, leaves
  `deadlineAt` untouched;
- `sweepOverdueRuns` runs second (`reaper.ts:472`) — sees `deadlineAt < now`, waits out
  `FORCE_FINALIZE_GRACE_MS = 180_000`, then `forceFinalizeAbandonedRun` stamps every `status: 'pending'`
  judgment on the run `reaper: abandoned` (`reaper.ts:353-358`).

The rescued judgment is `pending`. It is the one that gets stamped.

**This is the common path, not an exotic one.** All 4200 production runs have exactly one judgment, and
**498 of 4200 (11.9%) have `attemptCount ≥ 2`** — re-claims are routine.

## 2. The invariant, stated in the code and currently false

`src/worker/claim.ts:252-254` says it outright:

> `deadlineAt` is non-null EXACTLY WHILE the run has a claimed judgment in flight.
> `stampRunStartedAtFirstDequeue` sets it when execution starts; this clears it when execution stops
> without the run finishing.

`reaper.ts:317-320` stops execution — `running → pending` — and leaves `deadlineAt` non-null. The bug is a
violated invariant that the codebase already wrote down, not a missing feature.

## 3. Why no amount of constant-tuning fixes it

The two bounding mechanisms cover disjoint states:

- a `running` judgment is bounded by `LEASE_MS`, via `reclaimStaleJudgments`;
- a `pending` judgment is bounded **only** by the run deadline, via `forceFinalizeAbandonedRun`, which
  filters `status: 'pending'`.

So the run deadline can never kill *stuck* work — only *queued* work — while being sized on *execution*
time (`N × hardCapMs`). A queued judgment's legitimate wait is queue depth, which is precisely the quantity
the design deliberately refuses to measure (`timeout-policy.ts:249-255`). Widening
`RUN_DEADLINE_SLACK_MS` past `POST_CALL_SLACK_MS` would only move the collision, not remove it.

## 4. The fix

In `reclaimStaleJudgments`, after a **successful** republish, call `clearRunDeadlineOnRequeue(runId)` —
the identical call the consumer's retryable-error disposition already makes.

Best-effort and after the publish, in that order, for the same reason the consumer does it that way: a
failure to clear must not fail the reclaim, and clearing before a publish that then fails would leave a
`pending` judgment with no deadline **and** no queue message, reachable only by the 45-day never-started
net.

**What must NOT change:**

- **A NULL `deadlineAt` means the 45-day `NEVER_STARTED_TIMEOUT_MS` net applies** (`reaper.ts:215`). That is
  the property a previous, reverted attempt at a different deadline fix destroyed by writing a value
  instead of nulling. Clearing is safe precisely because the net still bounds the run.
- **Queue-depth independence** (`timeout-policy.ts:249-255`). This fix removes a deadline; it does not
  reintroduce queue position into any formula.
- `LEASE_MS`, `RUN_DEADLINE_SLACK_MS`, `POST_CALL_SLACK_MS`, `FORCE_FINALIZE_GRACE_MS` and
  `NEVER_STARTED_TIMEOUT_MS` all keep their current values.

## 5. Two things this is NOT

**Not the multi-judge sibling-restamp defect.** That one — a run whose siblings span a fast lane and a
congested one, so the fast one starts a clock the slow one lives inside — is **latent**: zero occurrences
in 4200 runs, and already documented as an accepted limit at `claim.ts:168-177`. It is reachable by one
HTTP POST (`api/evaluations/route.ts:18` admits up to 10 judge versions) and has never happened.
Recommendation: leave the doc, change nothing.

**Not fixed by PermutedRun — made twice as likely.** PermutedRun turns N runs into 2N single-judgment runs,
every one carrying the same 16-minute budget that produced the fatality. The per-run exposure is unchanged
and the population doubles.

## 6. Tests

Each asserts an **observable outcome** — a judgment was or was not abandoned — never a predicate. A prior
fix in this area passed a test that only asserted its own new predicate while the behaviour was wrong.

1. **The trace, end to end.** A single-judgment run, claimed, lease expired, reclaimed by
   `reclaimStaleJudgments`, then a full `runReaperSweep()` past the grace window: the judgment must be
   `pending`, NOT `reaper: abandoned`. **This test must fail on unfixed code** — verify by reverting.
2. **The deadline is actually cleared** after a successful reclaim: `deadlineAt IS NULL`.
3. **A failed republish does NOT clear it.** Ordering matters; a cleared deadline with no queue message is
   reachable only by the 45-day net.
4. **The never-started net still applies** to a reclaimed-and-cleared judgment — it is not immortal.
5. **Genuinely dead work is still finalized.** A run whose judgment never dequeues at all is still
   abandoned by the never-started net; this fix must not make anything unkillable.

## 7. Priority

**P2.** One confirmed corpse in 4200, ~8 lines, no schema change, no constant change, no existing assertion
re-scoped. But it should land **before** any permuted sweep on a deep lane: PermutedRun doubles the exposed
population, a 620-item permuted run is 1240 single-judgment runs on one serial lane, and 11.9% of judgments
already take a second claim.
