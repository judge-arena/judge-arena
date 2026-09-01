/**
 * ─── Escalating provider-call timeout policy ────────────────────────────────
 *
 * The owner's spec, in their words: "Arm the timeout at dynamic intervals:
 * start at 5min, but if the health is good, extend to up to 15min which is a
 * hard-cutoff. If we don't get any healthy response back in 15 + 15, we exit.
 * I would also like this hook/middleware to send alert back to running process
 * if it's surpassing 5min."
 *
 * Two budgets, not one:
 *   - INITIAL (`EVALUATION_MODEL_TIMEOUT_MS`, 5 min in production) — reaching
 *     it fires an alert and DOES NOT abort.
 *   - HARD CAP (`EVALUATION_MODEL_HARD_CAP_MS`, default 15 min) — reaching it
 *     aborts the `AbortController` in `registry.ts`'s `execute()`.
 *
 * ── WHY THIS IS ITS OWN MODULE ─────────────────────────────────────────────
 * Same reason `src/worker/health.ts` and `src/worker/concurrency.ts` were
 * extracted from `main.ts`: a unit test for the escalation boundaries must not
 * have to import `registry.ts`'s whole graph (both provider SDKs, `render.ts`,
 * four backend modules, `crypto`). Importing that graph to test four
 * arithmetic decisions would drag every one of those files into the coverage
 * denominator of a test that exercises none of them, and `vitest.config.ts`
 * already documents that this is how a coverage gate ends up punishing the
 * change it exists to encourage. Everything here is PURE: no I/O, no `prisma`,
 * no SDK import, one type-only import.
 *
 * ── HEALTH IS NOT A PROBE ──────────────────────────────────────────────────
 * Asked what "if the health is good" means, the owner was explicit: "Either a
 * successful response has been returned (processed a row successfully?) —
 * DON'T POLL THE SERVER." So nothing in this module contacts the inference
 * server. "Healthy" is a historical fact — whether a prior judgment for this
 * judge already completed, i.e. whether `judgeLatencyBaseline()` has anything
 * to report — and it only ever changes the WORDING of the 5-minute alert. It
 * never changes the budgets. Making it change the budgets would mean the first
 * judgment of a run got a different cutoff from the rest, which is precisely
 * the kind of "why did item 1 fail and items 2-30 pass" mystery the fixed
 * 15-minute cutoff exists to avoid.
 */

// Type-only (erased at compile time), so this does NOT pull `errors.ts` — and
// with it both provider SDKs — into this module's runtime graph. Same
// technique `errors.ts` itself uses for `./provider`.
import type { ProviderErrorKind } from './errors';
// Type-only for the same reason: `latency.ts` reads `prisma`, and nothing in
// this module may put a database client in `src/lib/llm/**`'s runtime graph.
import type { LatencyBaseline } from '@/lib/calibration/latency';

/** 5 minutes. The owner's "start at 5min". Matches the value
 * `EVALUATION_MODEL_TIMEOUT_MS` is already set to on both production pods via
 * helmrelease `extraEnv` — this default is documentation of the deployed
 * reality, NOT the 120000 the schema historically shipped. */
export const DEFAULT_INITIAL_BUDGET_MS = 300_000;

/** 15 minutes. The owner's "hard-cutoff". */
export const DEFAULT_HARD_CAP_MS = 900_000;

/**
 * Slack added on top of the HARD CAP to get `claim.ts`'s `LEASE_MS`. Unchanged
 * at 30s and deliberately so — it covers the same post-call work it always
 * did (the DB writes, the realtime publish, `maybeFinalizeRun`), which did not
 * get slower because the provider budget got longer. What changed is the term
 * it is added to: see `leaseMsFor` below.
 */
export const POST_CALL_SLACK_MS = 30_000;

/**
 * Floor on either budget, matching the existing
 * `EVALUATION_MODEL_TIMEOUT_MS: z.coerce.number().int().min(5000)` bound in
 * `src/lib/env.ts`.
 */
export const MIN_BUDGET_MS = 5_000;

/**
 * Ceiling on the hard cap, and the number is DERIVED, not chosen for looking
 * round: 1_800_000 − 600_000 − 30_000.
 *
 * RabbitMQ's `consumer_timeout` is 1,800,000ms, and blowing it does not fail
 * one message — it closes the CHANNEL and takes every consumer on it down
 * (`src/worker/concurrency.ts`'s module doc spells this out, and
 * `src/worker/health.ts` exists because a worker holding zero consumers stayed
 * 1/1 Running and 200-OK for five days). The unacked window of a FALLBACK-queue
 * delivery is `GATE_WAIT_TIMEOUT_MS` (600_000, concurrency.ts:225) parked on
 * the judge gate, plus the provider call, plus the post-call work this
 * module's `POST_CALL_SLACK_MS` bounds. A hard cap above this ceiling makes
 * that window exceed `consumer_timeout` by construction, so it is a
 * configuration that cannot work rather than one that merely runs long — which
 * is why it is refused at boot instead of discovered when the channel dies.
 *
 * At the 900_000 default that window is ~1,530,000ms, ~85% of the ceiling.
 * That is a real reduction in margin from the ~52% `concurrency.ts` documents
 * for a 300s provider timeout, and it is reported as a finding rather than
 * silently absorbed here.
 */
export const MAX_HARD_CAP_MS = 1_170_000;

/**
 * "Two 15-minute attempts total, then exit." The SECOND hard-cap abort is the
 * last one — see `hardCapAbortKind`.
 *
 * NOT a new retry mechanism, and deliberately NOT a second attempt counter:
 * this is a threshold applied to the attempt number the queue already tracks
 * (`judgment-consumer.ts`'s `effectiveAttempt = Math.max(msg.attempt,
 * judgment.attemptCount)`), used to pick the `kind` of one error. The retrying
 * itself stays entirely in `judgment-consumer.ts`'s existing disposition.
 */
export const HARD_CAP_MAX_ATTEMPTS = 2;

export interface TimeoutBudgets {
  /** Alert here; do not abort. */
  initialBudgetMs: number;
  /** Abort here. */
  hardCapMs: number;
}

/** The only two variables this module reads. Narrower than
 * `NodeJS.ProcessEnv` on purpose: it documents the whole env surface of the
 * timeout policy in one place, and it lets a test pass a two-key literal
 * instead of a full process environment. */
export interface TimeoutBudgetEnv {
  EVALUATION_MODEL_TIMEOUT_MS?: string;
  EVALUATION_MODEL_HARD_CAP_MS?: string;
}

/**
 * `Number(process.env.X ?? default)`, matching the convention
 * `claim.ts`/`run-launch.ts`/`run-create-consumer.ts` already use — and read
 * as a FUNCTION rather than a module-load constant so a test can override the
 * env per-test without module-reset gymnastics (the reason `registry.ts`'s
 * former `getTimeoutMs()` was a function; this replaces it).
 *
 * Two guards, both of which prevent a specific observed failure:
 *
 * 1. NON-FINITE / NON-POSITIVE falls back to the default. `Number('')` and
 *    `Number('nope')` are `NaN`, and `setTimeout(fn, NaN)` is clamped by Node
 *    to fire on effectively the NEXT TICK (verified directly) — before this
 *    guard a typo'd env var would not misconfigure the timeout, it would abort
 *    every provider call cluster-wide almost instantly.
 *
 * 2. A hard cap BELOW the initial budget is raised to the initial budget. That
 *    combination is refused at boot by `src/lib/env.ts` (see
 *    `budgetOrderingError`), but this function reads `process.env` directly and
 *    deliberately — `getEnv()` is a Next.js-side validator that the worker
 *    process does not call — so the schema is not on this code path. Left
 *    unclamped, a hard cap of 60s against an initial budget of 300s would abort
 *    the call FOUR MINUTES BEFORE the "we are waiting 10 more minutes" alert
 *    that promises we will not: the timeout would be strictly worse than
 *    having no policy at all, and nothing would say so.
 */
export function resolveTimeoutBudgets(env: TimeoutBudgetEnv = process.env as TimeoutBudgetEnv): TimeoutBudgets {
  const initialBudgetMs = positiveOr(env.EVALUATION_MODEL_TIMEOUT_MS, DEFAULT_INITIAL_BUDGET_MS);
  const rawHardCapMs = positiveOr(env.EVALUATION_MODEL_HARD_CAP_MS, DEFAULT_HARD_CAP_MS);

  return { initialBudgetMs, hardCapMs: Math.max(rawHardCapMs, initialBudgetMs) };
}

function positiveOr(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * The cross-field rule `src/lib/env.ts` enforces at boot: returns an operator-
 * readable message when the hard cap precedes the initial budget, `null` when
 * the pair is sane.
 *
 * Lives here rather than inline in the schema so the rule and the runtime that
 * obeys it cannot drift apart, and so it is testable without importing the
 * whole env surface.
 */
export function budgetOrderingError(initialBudgetMs: number, hardCapMs: number): string | null {
  if (hardCapMs >= initialBudgetMs) return null;
  return (
    `EVALUATION_MODEL_HARD_CAP_MS (${hardCapMs}) must be >= EVALUATION_MODEL_TIMEOUT_MS ` +
    `(${initialBudgetMs}): the hard cap is the abort, the timeout budget is only the alert, ` +
    `so a cap below it would abort the call before the alert that promises more time ever fires.`
  );
}

/**
 * ── THE LEASE. This is the correctness bug this whole change turns on. ──────
 *
 * `src/worker/claim.ts` derives `LEASE_MS` from this, and
 * `src/worker/reaper.ts:161` reclaims any judgment that is `status: 'running'`
 * with `updatedAt` older than `LEASE_MS`. Nothing writes the row between the
 * claim and the persist, so `updatedAt` sits at claim time for the entire
 * duration of the provider call.
 *
 * Derived from the INITIAL budget, the arithmetic is: lease 330s, provider call
 * legitimately allowed to run to 900s. At t=330s the reaper finds a perfectly
 * healthy in-flight judgment "stale", reclaims it, and republishes — a SECOND
 * provider call for the same judgment (billed, and on a local CPU judge a
 * second 15-minute occupancy of the only slot), and then two writers racing to
 * persist one row. Neither call is wrong on its own; the row that lands is
 * whichever finishes last.
 *
 * So the lease must cover the LONGEST the row can legitimately stay untouched:
 * the hard cap, plus the post-call work the 30s slack always existed for. Note
 * it is ONE hard cap, not two: the second attempt is a separate delivery that
 * re-claims and re-stamps `updatedAt`, so it gets its own lease.
 */
export function leaseMsFor(budgets: TimeoutBudgets, slackMs: number = POST_CALL_SLACK_MS): number {
  return budgets.hardCapMs + slackMs;
}

/**
 * The latency baseline for one judge — THE contract, re-exported under a
 * judge-scoped name rather than redeclared: this is
 * `src/lib/calibration/latency.ts`'s `LatencyBaseline`, the return of
 * `judgeLatencyBaseline(judgeModelVersionId)`.
 *
 * `import type`, so it is erased at compile time and this module's runtime
 * graph stays free of `prisma` — which is the whole reason it was extracted
 * (see the module doc). Aliased rather than copied because a second
 * declaration of the same five fields is a second thing to keep in step, and
 * the field that matters most here is the one a copy would not carry: the
 * guarantee that the empty case is `null` and NEVER a zero-filled record. A
 * zero baseline reads as "this judge answers instantly", which would make
 * every real call look pathologically slow and invert the branch below.
 */
export type JudgeLatencyBaseline = LatencyBaseline;

export interface InitialBudgetAlertInput {
  /** How long the call has actually been running. Normally the initial budget. */
  elapsedMs: number;
  budgets: TimeoutBudgets;
  /** `null` / omitted = no completed judgment for this judge yet. */
  baseline?: JudgeLatencyBaseline | null;
  /** Provider model id, for an operator who has several judges in flight. */
  modelId?: string;
  judgeModelVersionId?: string;
}

export interface InitialBudgetAlert {
  /** Which branch of the owner's spec produced `message`. Asserted on by
   *  tests and switched on by callers, so neither has to match prose. */
  kind: 'no_baseline' | 'over_baseline';
  elapsedMs: number;
  /** `hardCapMs - elapsedMs` — the "waiting 10 more minutes" number, computed
   *  rather than hardcoded so it stays true if either budget is retuned. */
  remainingMs: number;
  hardCapMs: number;
  modelId?: string;
  judgeModelVersionId?: string;
  baseline: JudgeLatencyBaseline | null;
  /** `elapsedMs / baseline.meanMs`, only on the `over_baseline` branch. This
   *  is the number the owner actually needs: 1.5x the average is a slow call,
   *  400x is a stuck one, and the raw elapsed time alone does not distinguish
   *  them. */
  multipleOfMean?: number;
  message: string;
}

/**
 * Build the 5-minute alert. Pure — the caller decides where it goes.
 *
 * The two wordings are the owner's, not a paraphrase:
 *   - no baseline: "5min have elapsed, confirm model access and waiting 10
 *     more minutes message".
 *   - baseline: how far past the observed average this call is.
 *
 * `count === 0` or a non-positive `meanMs` is treated as NO baseline even
 * though a non-null object was passed. A zero mean would render "Infinity×
 * the observed average", and a count of zero is not an observation — the
 * sibling module's contract is to return `null` in that case, and this is the
 * defensive read of that contract rather than a second implementation of it.
 */
export function buildInitialBudgetAlert(input: InitialBudgetAlertInput): InitialBudgetAlert {
  const { elapsedMs, budgets, modelId, judgeModelVersionId } = input;
  const remainingMs = Math.max(0, budgets.hardCapMs - elapsedMs);
  const baseline = input.baseline ?? null;
  const usable = baseline !== null && baseline.count > 0 && baseline.meanMs > 0;

  const subject = modelId ? `judge "${modelId}"` : 'this judge';
  const common = `${humanizeMs(elapsedMs)} elapsed with no response from ${subject}.`;

  if (!usable) {
    return {
      kind: 'no_baseline',
      elapsedMs,
      remainingMs,
      hardCapMs: budgets.hardCapMs,
      modelId,
      judgeModelVersionId,
      baseline: null,
      message:
        `${common} This is the first judgment for this judge, so there is no latency ` +
        `baseline to compare it against. CONFIRM MODEL ACCESS — waiting ${humanizeMs(remainingMs)} ` +
        `more before aborting at the ${humanizeMs(budgets.hardCapMs)} hard cap.`,
    };
  }

  const multipleOfMean = elapsedMs / baseline.meanMs;
  return {
    kind: 'over_baseline',
    elapsedMs,
    remainingMs,
    hardCapMs: budgets.hardCapMs,
    modelId,
    judgeModelVersionId,
    baseline,
    multipleOfMean,
    message:
      `${common} That is ${multipleOfMean.toFixed(1)}x the observed average of ` +
      `${humanizeMs(baseline.meanMs)} over ${baseline.count} completed judgment(s) for this judge ` +
      `(p90 ${humanizeMs(baseline.p90Ms)}, slowest ${humanizeMs(baseline.maxMs)}). ` +
      `Waiting ${humanizeMs(remainingMs)} more before aborting at the ` +
      `${humanizeMs(budgets.hardCapMs)} hard cap.`,
  };
}

/** Minutes/seconds/ms, so the message reads correctly at the production 300000
 * AND at the 50ms a unit test configures — a hardcoded "5 minutes" would be a
 * lie in every non-default configuration, including every test. */
function humanizeMs(ms: number): string {
  if (ms >= 60_000) {
    const minutes = ms / 60_000;
    return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} minutes`;
  }
  if (ms >= 1_000) {
    const seconds = ms / 1_000;
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
  }
  return `${Math.round(ms)}ms`;
}

/**
 * The give-up rule, expressed as the `kind` of ONE error rather than as a
 * mechanism.
 *
 * "If we don't get any healthy response back in 15 + 15, we exit." Attempt 1's
 * hard-cap abort is `retryable`, so `judgment-consumer.ts`'s existing
 * disposition resets the row to `pending` and republishes onto
 * `judgment.retry.5m` for attempt 2. Attempt 2's abort is `non_retryable`, and
 * that branch (judgment-consumer.ts:1122) marks the judgment `error` and ACKS
 * — no republish, and, importantly, NO DLQ: the DLQ is reached only from the
 * `effectiveAttempt >= MAX_ATTEMPTS` branch below it, which a `non_retryable`
 * error returns before ever reaching. So "no third attempt, no DLQ churn"
 * falls out of the existing code with no new branch anywhere.
 *
 * Two 15-minute attempts is 30 minutes of wall clock per judgment before the
 * verdict is "this judge is not answering", which is the owner's arithmetic
 * ("15 + 15"), not an accident of the default `maxAttempts: 3`.
 *
 * This applies ONLY to hard-cap aborts. Every other retryable failure (a 500,
 * a dropped socket, an open breaker) keeps the full 3-attempt budget, because
 * those retries are cheap and often work — a 30-minute timeout retry is
 * neither.
 */
export function hardCapAbortKind(attempt: number): ProviderErrorKind {
  return attempt >= HARD_CAP_MAX_ATTEMPTS ? 'non_retryable' : 'retryable';
}

export interface EscalatingTimeoutOptions {
  budgets: TimeoutBudgets;
  /** Fires ONCE at the initial budget. Must not abort. */
  onInitialBudget: (elapsedMs: number) => void;
  /** Fires at the hard cap. This is the abort. */
  onHardCap: (elapsedMs: number) => void;
  /** Injectable only for tests that drive time directly; production uses the
   *  globals, which `vi.useFakeTimers()` also replaces. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface EscalatingTimeoutHandle {
  /**
   * Clears BOTH timers. Must be called in a `finally` — a call that returns in
   * 3 seconds otherwise leaves a 15-minute timer pending, and a pending
   * `setTimeout` keeps the Node event loop alive: the worker would not shut
   * down promptly and a test process would hang for a quarter of an hour
   * rather than exit.
   */
  cancel(): void;
}

/**
 * Arm the escalation for one provider call.
 *
 * TWO INDEPENDENT ONE-SHOT TIMERS, not an interval and not a timer that
 * re-arms itself: the alert must fire exactly once and the abort must happen at
 * the hard cap measured from the START of the call, not from the alert. An
 * implementation that re-armed for `hardCapMs` after the alert fired would
 * abort at initial + cap (20 minutes at the defaults), quietly overrunning the
 * lease this policy just widened — which is the bug the lease derivation
 * exists to prevent, reintroduced from the other end.
 *
 * `alerted` guards the alert independently of the timer, so the "exactly once"
 * property survives any future change to how the alert is scheduled.
 */
export function armEscalatingTimeout(options: EscalatingTimeoutOptions): EscalatingTimeoutHandle {
  const { budgets, onInitialBudget, onHardCap } = options;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));

  let alerted = false;

  const alertTimer = setTimer(() => {
    if (alerted) return;
    alerted = true;
    onInitialBudget(budgets.initialBudgetMs);
  }, budgets.initialBudgetMs);

  const abortTimer = setTimer(() => {
    onHardCap(budgets.hardCapMs);
  }, budgets.hardCapMs);

  return {
    cancel() {
      clearTimer(alertTimer);
      clearTimer(abortTimer);
    },
  };
}
