/**
 * ─── Idempotent Judgment Claim ─────────────────────────────────────────────
 *
 * A single conditional UPDATE is the whole claim protocol: `pending ->
 * running` only succeeds for exactly one caller, even under concurrent
 * redelivery (two workers racing the same `judgment.execute` message, or a
 * message redelivered while the original consumer is still mid-flight) —
 * Postgres's row-level locking on `UPDATE ... WHERE` makes the race atomic,
 * no `SELECT ... FOR UPDATE` or app-level mutex required.
 *
 * `'already_done'` means a genuinely terminal row (`completed`/`error`) —
 * don't call the provider, just ack. A `running` row still comfortably
 * inside its lease (someone else's live claim, not yet stale — or this
 * call's own loss of the reclaim race below) is a DIFFERENT outcome,
 * `'in_progress'`: unlike a terminal row, it isn't safe to just strand the
 * message until the lease expires (Task 8's reclaim-sweeping reaper doesn't
 * exist yet, so nothing would ever re-check it) — the consumer instead
 * republishes the same message onto the 30s retry queue for a delayed
 * re-check (see judgment-consumer.ts). Only a `running` row whose
 * `updatedAt` has aged past `LEASE_MS` (the original claimant presumably
 * died mid-flight — killed process, dropped connection, crashed before ack)
 * is worth reclaiming, and that reclaim is itself just another conditional
 * UPDATE (`status: 'running', updatedAt: { lt: staleBefore }`), so a second
 * racing reclaim attempt loses cleanly the same way the initial claim does
 * (falls through to `'in_progress'`, not a crash or a double-claim).
 *
 * `'retry_claim'` covers a narrow inspection race: the initial conditional
 * UPDATE (`WHERE status = 'pending'`) can find 0 rows because the row
 * wasn't `pending` at that instant, yet by the time this function's
 * follow-up `SELECT` runs, a concurrent write (e.g. another delivery's
 * retryable-error disposition resetting the row back to `pending`) has
 * landed in that gap and the row reads `pending` again — a real, live
 * claim opportunity, not a terminal state. Misreporting it as
 * `'already_done'` would silently strand a claimable judgment. The caller
 * retries `claimJudgment()` once more; if that still doesn't resolve to
 * `'claimed'`/`'stale_running'`, nack-requeue the message rather than loop
 * claim attempts inline.
 */

import { prisma } from '@/lib/db';
import { leaseMsFor, resolveTimeoutBudgets, runStartBudgetMs } from '@/lib/llm/timeout-policy';

/**
 * Claim lease: how long a `running` judgment is presumed still in-flight
 * before another delivery is allowed to reclaim it. Generous slack (30s,
 * `POST_CALL_SLACK_MS`) over the model call's own budget — the budget bounds
 * the provider call itself, but the DB writes / event publish / finalization
 * that happen after the call returns need their own margin before a claimant
 * is declared dead.
 *
 * ── DERIVED FROM THE HARD CAP, NOT THE INITIAL BUDGET. THIS IS A CORRECTNESS
 *    BUG FIX, NOT A TUNING CHANGE. ─────────────────────────────────────────
 * This used to read `EVALUATION_MODEL_TIMEOUT_MS + 30_000`. Under the
 * escalating timeout (`src/lib/llm/timeout-policy.ts`) that variable is only
 * the ALERT point — a provider call may now legitimately run to
 * `EVALUATION_MODEL_HARD_CAP_MS` (15 minutes) before anything aborts it. The
 * old derivation therefore produced a 330s lease over a call allowed to take
 * 900s.
 *
 * What that costs, concretely: nothing writes the judgment row between the
 * claim above and the persist after the provider returns, so `updatedAt`
 * sits at claim time for the entire call. `src/worker/reaper.ts`'s
 * `reclaimStaleJudgments` sweeps `status: 'running' AND updatedAt < now −
 * LEASE_MS`, so at t=330s it would find a PERFECTLY HEALTHY in-flight
 * judgment, declare its claimant dead, and republish it — a second provider
 * call for the same row (billed, and on the local CPU judge a second
 * quarter-hour occupancy of a server that does one call at a time), then two
 * writers racing to persist one judgment. The row that survives is whichever
 * finished last; nothing in the data afterwards says it happened twice.
 *
 * ONE hard cap, not two: the second of the two allowed attempts arrives as a
 * separate delivery that re-claims the row and re-stamps `updatedAt`, so it
 * gets its own lease. Read at module load (matching this file's existing
 * convention and `run-launch.ts`/`run-create-consumer.ts`), which is why
 * `tests/lib/timeout-policy.test.ts` asserts the relationship
 * `LEASE_MS > hardCapMs` rather than a literal.
 */
export const LEASE_MS = leaseMsFor(resolveTimeoutBudgets());

export type ClaimResult = 'claimed' | 'already_done' | 'not_found' | 'stale_running' | 'in_progress' | 'retry_claim';

/**
 * Attempt to claim `judgmentId` for processing.
 *
 * - `'claimed'` — this call won a normal `pending -> running` transition;
 *   proceed to process it.
 * - `'stale_running'` — the row was `running` but its lease had expired;
 *   this call won the reclaim (fresh `updatedAt`/incremented
 *   `attemptCount`); proceed to process it exactly like `'claimed'`.
 * - `'in_progress'` — the row is `running` and still within its lease (a
 *   live claim — either someone else's, or this call lost a reclaim race to
 *   a concurrent caller). Don't call the provider; the caller republishes
 *   this same message onto the 30s retry queue for a delayed re-check
 *   rather than dropping it (see judgment-consumer.ts).
 * - `'already_done'` — the row is terminal (`completed`/`error`). Ack
 *   without calling the provider or republishing anything.
 * - `'retry_claim'` — an inspection-race artifact: the row read `pending`
 *   again by the time of the follow-up SELECT (see module doc). The caller
 *   should call `claimJudgment()` once more.
 * - `'not_found'` — no such judgment row. Ack (nothing to do).
 */
export async function claimJudgment(judgmentId: string): Promise<ClaimResult> {
  const now = new Date();

  const claim = await prisma.modelJudgment.updateMany({
    where: { id: judgmentId, status: 'pending' },
    data: { status: 'running', startedAt: now, attemptCount: { increment: 1 } },
  });
  if (claim.count > 0) return 'claimed';

  const row = await prisma.modelJudgment.findUnique({
    where: { id: judgmentId },
    select: { status: true, updatedAt: true },
  });
  if (!row) return 'not_found';

  if (row.status === 'pending') {
    // Inspection race: the row wasn't 'pending' when the conditional UPDATE
    // above ran, but is 'pending' again now — a concurrent reset landed in
    // the gap. Live claim opportunity; let the caller retry the attempt.
    return 'retry_claim';
  }

  if (row.status !== 'running') {
    // 'completed' or 'error' — terminal, nothing to reclaim.
    return 'already_done';
  }

  const staleBefore = new Date(now.getTime() - LEASE_MS);
  if (row.updatedAt >= staleBefore) {
    // Running, still within lease — duplicate delivery of a live claim.
    // The holder will finish (and ack) or its lease will eventually expire.
    return 'in_progress';
  }

  const reclaim = await prisma.modelJudgment.updateMany({
    where: { id: judgmentId, status: 'running', updatedAt: { lt: staleBefore } },
    data: { status: 'running', startedAt: now, attemptCount: { increment: 1 } },
  });
  if (reclaim.count > 0) return 'stale_running';

  // Lost the reclaim race to a concurrent caller (or the original claimant
  // resumed and touched the row again just in time) — treat as a live claim
  // this call doesn't own.
  return 'in_progress';
}

/**
 * ─── Stamp `EvaluationRun.deadlineAt` at FIRST DEQUEUE ─────────────────────
 *
 * THE FIX documented (and deliberately deferred) in `src/lib/run-launch.ts`'s
 * now-deleted `deadlineAt` JSDoc: every launch path used to stamp
 * `EvaluationRun.deadlineAt` at CREATION, sized on "judgments queued ahead of
 * this one" — a property of the WHOLE SYSTEM's queue depth at launch time,
 * not of this run's own work. `src/worker/reaper.ts` sweeps
 * `deadlineAt < now` and force-finalizes 3 sweeps later; a run created late
 * in a large batch could have its still-healthy, still-queued judgments
 * stamped `error: 'reaper: abandoned'` before a worker ever looked at them —
 * this cost 4 of 30 items on a real calibration and is the reason
 * `MAX_CALIBRATION_ITEMS` was capped at 100 (`src/lib/calibration/launch.ts`).
 *
 * This function stamps the deadline instead at the moment a worker actually
 * claims the run's FIRST judgment — `runStartBudgetMs(judgmentCount, budgets)`
 * milliseconds from THAT moment, not from creation. The deadline is now
 * about THIS run's own work and is immune to how many other runs, batches
 * or users were queued ahead of THIS run's FIRST claim.
 *
 * The limit of that guarantee, stated so it is not over-read: a
 * MULTI-judgment run's budget is `judgmentCount * hardCapMs`, which assumes
 * its judgments execute CONCURRENTLY across their judges' lanes. A run whose
 * judgments span a fast lane and a congested one still has its clock started
 * by the fast one while the slow one waits (lanes are keyed on server
 * ORIGIN, not model — `src/lib/queue/lanes.ts`). That is not a regression:
 * the creation-time deadline it replaces started the same clock strictly
 * EARLIER, at creation. It is the reason `clearRunDeadlineOnRequeue` below
 * exists, and the reason the never-started net in `src/worker/reaper.ts` is
 * sized loosely rather than tightly.
 *
 * ── CALLED FROM EXACTLY ONE PLACE ────────────────────────────────────────
 * `src/worker/judgment-consumer.ts`'s `executeClaimed`, immediately after
 * `claimJudgment()` resolves to `'claimed'` or `'stale_running'` — i.e.
 * every time THIS delivery actually owns the judgment row and is about to
 * execute it. Not folded into `claimJudgment()` itself: that function's
 * contract (`ClaimResult`, its five-way return) is unrelated to which RUN
 * the judgment belongs to and is exercised by its own well-established
 * tests; this is an independent, separately-testable concern that happens
 * to be triggered by the same event. Any FUTURE caller of `claimJudgment()`
 * must also call this on a `'claimed'`/`'stale_running'` result — there is
 * exactly one caller today, so that obligation costs nothing to satisfy,
 * but it is not enforced by the type system and is recorded here so it
 * isn't missed.
 *
 * ── ATOMICITY: WHY A CONCURRENT CLAIM CANNOT RE-STAMP OR CLOBBER ───────────
 * A single conditional `updateMany` — `WHERE id = $1 AND "deadlineAt" IS
 * NULL` — is the entire guard, the same idiom `claimJudgment`'s own
 * `pending -> running` transition uses a few lines above it, and the same
 * idiom `run-finalizer.ts`'s `markRunCompleted` uses for its
 * `needs_human -> completed` guard. Two judgments of the SAME run claimed
 * concurrently by two different workers both call this function; both read
 * the SAME `judgmentCount` (an `EvaluationRun`'s judgment rows are fixed at
 * creation — nothing in this codebase ever adds one afterwards — so the
 * value cannot itself be racing), and both issue the UPDATE. Postgres locks
 * the row for whichever UPDATE reaches it first; the SECOND UPDATE blocks
 * on that lock, and once it acquires it, re-evaluates its OWN `WHERE`
 * clause against the row AS IT NOW STANDS — already committed, already
 * non-null — and therefore matches ZERO rows. `updateMany` returns
 * `{ count: 0 }` and this function returns without touching anything.
 * Exactly one caller's write survives; the other is a correctly-recognized
 * no-op, not a lost update masked by a last-writer-wins race — there is no
 * window in which both writes are "in flight" against the same row,
 * because the second one's WHERE clause is evaluated AFTER the lock, not
 * against a stale snapshot taken before it. (`default_transaction_isolation`
 * on the production database is `read committed`, measured 2026-09-03;
 * Postgres's EvalPlanQual re-check is what makes the post-lock re-evaluation
 * true rather than hopeful.)
 *
 * HONESTY ABOUT WHAT IS TESTED: the tests in
 * `tests/integration/worker-claims.test.ts` drive two claims SEQUENTIALLY,
 * so they prove idempotence, not the concurrent case. The concurrent claim
 * above is Postgres semantics plus the same idiom `claimJudgment` already
 * ships, not something this plan's tests demonstrate. A deliberately
 * non-discriminating test was NOT added for it: the observable difference
 * between this guarded UPDATE and a read-then-write under a real race is a
 * few milliseconds of `deadlineAt`, which no assertion can separate from
 * scheduling noise.
 *
 * Best-effort by design: the caller wraps this in a try/catch and logs
 * rather than fails the judgment on error (see judgment-consumer.ts's
 * `executeClaimed`). A run whose deadline never gets stamped (this call
 * throws, or is never reached because the process dies between claim and
 * this line) is covered — but SLOWLY: `src/worker/reaper.ts`'s
 * `NEVER_STARTED_TIMEOUT_MS` treats a null-deadline row as "never started"
 * and sweeps it at 45 DAYS, where the creation-time deadline this replaces
 * would have republished it in ~16 minutes. A crash between the claim and
 * this line is the better-covered case: the judgment is `running`, so
 * `reclaimStaleJudgments` picks it up at `LEASE_MS`, not at the net.
 */
export async function stampRunStartedAtFirstDequeue(runId: string): Promise<void> {
  const judgmentCount = await prisma.modelJudgment.count({ where: { runId } });
  const budgets = resolveTimeoutBudgets();
  const deadlineAt = new Date(Date.now() + runStartBudgetMs(judgmentCount, budgets));

  await prisma.evaluationRun.updateMany({
    where: { id: runId, deadlineAt: null },
    data: { deadlineAt },
  });
}

/**
 * ─── The other half of the same invariant ─────────────────────────────────
 *
 * `deadlineAt` is non-null EXACTLY WHILE the run has a claimed judgment in
 * flight. `stampRunStartedAtFirstDequeue` sets it when execution starts;
 * this clears it when execution stops without the run finishing.
 *
 * ── WHY THIS IS NOT OPTIONAL ──────────────────────────────────────────────
 * `src/worker/judgment-consumer.ts`'s retryable-error disposition resets a
 * failed judgment to `status: 'pending'` and republishes it through the
 * 30s/5m delay exchange, which delivers it to the BACK of the same
 * single-consumer judge lane. That judgment is queued work again, not
 * executing work. Leave the run's deadline in place and it still says "one
 * hard cap from the FIRST claim" (~16 minutes for a calibration run's single
 * judgment) while the retry waits out every item ahead of it — hours for a
 * 30-item batch, DAYS at `MAX_CALIBRATION_ITEMS = 1000`. `src/worker/reaper.ts`
 * force-finalizes 3 sweeps past the deadline by stamping every still-`pending`
 * judgment `error: 'reaper: abandoned'`, so the healthy queued retry is
 * killed and recorded as an abandonment: bit-for-bit the 4-of-30 failure this
 * whole change exists to remove, relocated from the launch path to the retry
 * path. It would have been a REGRESSION, not a pre-existing hole — the
 * creation-time formula this plan deletes gave a 30-item calibration batch
 * `launch + 30 x hardCapMs`, i.e. 7.5 hours, which covered the requeue.
 *
 * For a run with exactly ONE judgment (the ordinary, pre-A2 case), clearing
 * restores the "not started" state the stamp's own guard tests for, so the
 * NEXT claim re-stamps a FRESH budget measured from when the work actually
 * resumes. Between the clear and that next claim the run is bounded by
 * `src/worker/reaper.ts`'s `NEVER_STARTED_TIMEOUT_MS` (45 days) — a wide net,
 * but the run genuinely has nothing executing, so deferring to it is correct.
 *
 * ── A2 (BA sweep): NULLING IS WRONG WHEN A SIBLING JUDGMENT IS STILL
 *    NON-TERMINAL ──────────────────────────────────────────────────────────
 * A paired calibration run carries TWO judgments (AB, BA) on the SAME judge
 * — the SAME single-consumer lane, at up to `MAX_PAIRED_CALIBRATION_ITEMS`
 * (719) items x 2 orders = 1438 messages deep. If AB fails retryably while BA
 * is still `pending`/`running`, nulling unconditionally is a lie: the run has
 * NOT gone idle, BA is still live work. The bug this produces: BA (next in
 * the lane, published immediately after AB) claims moments later, and its own
 * `stampRunStartedAtFirstDequeue` call finds `deadlineAt IS NULL` and
 * re-stamps a FRESH ~31-minute budget — sized on THIS moment, with no memory
 * of AB's already-established protection — while AB's requeued message sits
 * behind however many OTHER items are still queued on this judge, which can
 * legally take days. `src/worker/reaper.ts` then force-finalizes AB as
 * `'reaper: abandoned'` roughly 34 minutes later, while it is still healthily
 * (if slowly) queued — bit-for-bit the 4-of-30 failure this whole mechanism
 * exists to prevent, now reachable because A2 makes a deep, single-lane,
 * multi-judgment queue the NORMAL shape rather than a rare one.
 *
 * The fix: when MORE THAN ONE of this run's judgments is still non-terminal
 * (`pending` or `running`) at the moment of the clear — i.e. a sibling has
 * not yet reached a terminal state — do NOT null. Instead, MONOTONICALLY
 * extend the deadline: recompute what `stampRunStartedAtFirstDequeue` would
 * stamp from THIS moment (this requeue is itself evidence the run's clock
 * should restart) and write it only if it is LATER than what is already
 * there — never earlier. `updateMany`'s `deadlineAt: { lt: candidate }` guard
 * is what makes this safe against a concurrent sibling claim: whichever write
 * lands second re-evaluates its WHERE clause against the row as committed and
 * either extends further or no-ops, the same idiom `stampRunStartedAtFirstDequeue`
 * itself uses for its own guard.
 *
 * This does NOT solve the general case — a judgment that must wait LONGER
 * than one restart's worth of budget with ZERO claim activity anywhere on
 * the run (no retry, no sibling claim) can still see its deadline elapse
 * before its turn comes. Closing that fully would mean sizing the deadline
 * on which judgments are ACTUALLY in flight right now rather than on the
 * run's total `judgmentCount` — a change to `stampRunStartedAtFirstDequeue`'s
 * own formula (`src/lib/llm/timeout-policy.ts`'s `runStartBudgetMs`), out of
 * scope here: see the review round 1 fix report for why that redesign was
 * deliberately not attempted.
 *
 * With exactly one non-terminal judgment (BOTH the ordinary pre-A2 case, and
 * a paired run whose sibling has ALREADY completed/errored), this count is
 * 1, the condition is false, and behaviour is BYTE-FOR-BYTE the pre-A2 one:
 * null, unconditionally.
 *
 * Best-effort, exactly like the stamp — a failure here must never fail the
 * disposition it is part of (see the caller in judgment-consumer.ts).
 */
export async function clearRunDeadlineOnRequeue(runId: string): Promise<void> {
  // `in: ['pending', 'running']` — the two JudgmentStatus values that are
  // NOT terminal (schema.prisma's JudgmentStatus enum: pending, running,
  // completed, error). The caller already reset THIS judgment to 'pending'
  // before calling here (judgment-consumer.ts's retryable-error disposition),
  // so it is counted like any other non-terminal row.
  const nonTerminal = await prisma.modelJudgment.count({
    where: { runId, status: { in: ['pending', 'running'] } },
  });

  if (nonTerminal > 1) {
    const budgets = resolveTimeoutBudgets();
    const judgmentCount = await prisma.modelJudgment.count({ where: { runId } });
    const candidate = new Date(Date.now() + runStartBudgetMs(judgmentCount, budgets));
    // Monotonic: `deadlineAt: { lt: candidate }` means this UPDATE only ever
    // moves the deadline LATER (or leaves it alone) — it can never shorten
    // an existing deadline a sibling's claim, or an earlier call to this same
    // function, already established. A plain unconditional
    // `data: { deadlineAt: candidate }` would not have this property.
    await prisma.evaluationRun.updateMany({
      where: { id: runId, deadlineAt: { lt: candidate } },
      data: { deadlineAt: candidate },
    });
    return;
  }

  await prisma.evaluationRun.updateMany({
    where: { id: runId },
    data: { deadlineAt: null },
  });
}
