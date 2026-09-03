import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_HARD_CAP_MS,
  DEFAULT_INITIAL_BUDGET_MS,
  HARD_CAP_MAX_ATTEMPTS,
  MAX_HARD_CAP_MS,
  POST_CALL_SLACK_MS,
  RUN_DEADLINE_SLACK_MS,
  armEscalatingTimeout,
  buildInitialBudgetAlert,
  budgetOrderingError,
  hardCapAbortKind,
  leaseMsFor,
  resolveTimeoutBudgets,
  runStartBudgetMs,
  type JudgeLatencyBaseline,
} from '@/lib/llm/timeout-policy';
import { envSchema } from '@/lib/env';
import { LEASE_MS } from '@/worker/claim';

/**
 * The owner's spec: start the timeout at 5 minutes, DO NOT abort there — alert
 * instead — and extend to a 15-minute hard cutoff; two 15-minute attempts and
 * then exit.
 *
 * Every test here is over the pure policy module, which is why the module
 * exists: the same assertions written against `registry.ts` would drag both
 * provider SDKs and four backend modules into the graph (see the module doc).
 */

const MINUTE = 60_000;

describe('timeout-policy: two budgets, resolved from the environment', () => {
  it('defaults are the owner\'s 5 minutes and 15 minutes', () => {
    const budgets = resolveTimeoutBudgets({});
    expect(budgets.initialBudgetMs).toBe(5 * MINUTE);
    expect(budgets.hardCapMs).toBe(15 * MINUTE);
    expect(DEFAULT_INITIAL_BUDGET_MS).toBe(5 * MINUTE);
    expect(DEFAULT_HARD_CAP_MS).toBe(15 * MINUTE);
  });

  it('reads both budgets independently — they are two separately configurable knobs, not a ratio', () => {
    const budgets = resolveTimeoutBudgets({
      EVALUATION_MODEL_TIMEOUT_MS: '60000',
      EVALUATION_MODEL_HARD_CAP_MS: '600000',
    });
    expect(budgets).toEqual({ initialBudgetMs: 60_000, hardCapMs: 600_000 });
  });

  it('a malformed value falls back to the default rather than becoming NaN', () => {
    // setTimeout(fn, NaN) fires on the next tick — a typo would abort every
    // provider call cluster-wide almost instantly rather than misconfigure it.
    const budgets = resolveTimeoutBudgets({
      EVALUATION_MODEL_TIMEOUT_MS: 'five minutes',
      EVALUATION_MODEL_HARD_CAP_MS: '',
    });
    expect(budgets).toEqual({ initialBudgetMs: 5 * MINUTE, hardCapMs: 15 * MINUTE });
  });

  it('CRITICAL: a hard cap below the initial budget is raised to it at runtime, never allowed to abort before the alert', () => {
    // The schema refuses this at boot (see below), but the worker reads
    // process.env directly and never calls getEnv() — so an abort that
    // preceded its own "waiting N more minutes" alert has to be impossible
    // here too, not just impossible to configure.
    const budgets = resolveTimeoutBudgets({
      EVALUATION_MODEL_TIMEOUT_MS: '300000',
      EVALUATION_MODEL_HARD_CAP_MS: '60000',
    });
    expect(budgets.hardCapMs).toBeGreaterThanOrEqual(budgets.initialBudgetMs);
  });
});

describe('timeout-policy: the env schema REFUSES a hard cap below the initial budget', () => {
  // ENCRYPTION_KEY is here because it HAS to be: `env.ts` declares it
  // `.min(16).optional().default('')`, and zod applies the default and then
  // validates it, so the empty-string default can never satisfy the minimum —
  // any environment that omits the variable fails the object parse, and a
  // failed object parse means zod SKIPS every `superRefine`, including the
  // budget-ordering rule under test. Reported as a pre-existing finding rather
  // than changed here; this fixture is what makes the rule reachable.
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    NEXTAUTH_SECRET: 'x'.repeat(32),
    NEXTAUTH_URL: 'http://localhost:3000',
    ENCRYPTION_KEY: 'y'.repeat(32),
  };

  it('rejects the inverted pair at boot, naming both variables', () => {
    const result = envSchema.safeParse({
      ...base,
      EVALUATION_MODEL_TIMEOUT_MS: '300000',
      EVALUATION_MODEL_HARD_CAP_MS: '60000',
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    const messages = result.error.issues.map((i) => i.message).join('\n');
    expect(messages).toContain('EVALUATION_MODEL_HARD_CAP_MS');
    expect(messages).toContain('EVALUATION_MODEL_TIMEOUT_MS');
    // The failure must be attributed to the hard cap, so the error line an
    // operator reads at 3am points at the variable they should change.
    expect(result.error.issues.some((i) => i.path.includes('EVALUATION_MODEL_HARD_CAP_MS'))).toBe(true);
  });

  it('accepts an equal pair (degenerate but not nonsense) and the ordinary case', () => {
    expect(
      envSchema.safeParse({ ...base, EVALUATION_MODEL_TIMEOUT_MS: '300000', EVALUATION_MODEL_HARD_CAP_MS: '300000' })
        .success
    ).toBe(true);
    expect(
      envSchema.safeParse({ ...base, EVALUATION_MODEL_TIMEOUT_MS: '300000', EVALUATION_MODEL_HARD_CAP_MS: '900000' })
        .success
    ).toBe(true);
  });

  it('defaults alone are a valid configuration', () => {
    const result = envSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.EVALUATION_MODEL_HARD_CAP_MS).toBe(DEFAULT_HARD_CAP_MS);
  });

  it('refuses a hard cap past the RabbitMQ consumer_timeout ceiling', () => {
    // Not a taste bound: gate wait (600s) + this cap + post-call slack must
    // stay inside consumer_timeout (1,800,000ms), which kills the CHANNEL and
    // every consumer on it, not just one message.
    expect(envSchema.safeParse({ ...base, EVALUATION_MODEL_HARD_CAP_MS: String(MAX_HARD_CAP_MS + 1) }).success).toBe(
      false
    );
    expect(envSchema.safeParse({ ...base, EVALUATION_MODEL_HARD_CAP_MS: String(MAX_HARD_CAP_MS) }).success).toBe(true);
  });

  it('budgetOrderingError is the rule itself, and says why', () => {
    expect(budgetOrderingError(300_000, 900_000)).toBeNull();
    expect(budgetOrderingError(300_000, 300_000)).toBeNull();
    expect(budgetOrderingError(300_000, 60_000)).toContain('must be >=');
  });
});

describe('timeout-policy: escalation boundaries', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const budgets = { initialBudgetMs: 5 * MINUTE, hardCapMs: 15 * MINUTE };

  it('CRITICAL: reaching the initial budget alerts and DOES NOT abort', () => {
    const onInitialBudget = vi.fn();
    const onHardCap = vi.fn();
    armEscalatingTimeout({ budgets, onInitialBudget, onHardCap });

    vi.advanceTimersByTime(5 * MINUTE - 1);
    expect(onInitialBudget).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onInitialBudget).toHaveBeenCalledTimes(1);
    expect(onInitialBudget).toHaveBeenCalledWith(5 * MINUTE);
    // The whole point of the escalation: 5 minutes is a warning, not a cutoff.
    expect(onHardCap).not.toHaveBeenCalled();
  });

  it('CRITICAL: the abort happens at the hard cap and not one tick before', () => {
    const onInitialBudget = vi.fn();
    const onHardCap = vi.fn();
    armEscalatingTimeout({ budgets, onInitialBudget, onHardCap });

    vi.advanceTimersByTime(15 * MINUTE - 1);
    expect(onHardCap).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onHardCap).toHaveBeenCalledTimes(1);
    expect(onHardCap).toHaveBeenCalledWith(15 * MINUTE);
  });

  it('the hard cap is measured from the START of the call, not from the alert', () => {
    // An implementation that re-armed for hardCapMs once the alert fired would
    // abort at 20 minutes — past the lease this policy widened to 15m30s, so
    // the reaper would reclaim a live call again.
    const onHardCap = vi.fn();
    armEscalatingTimeout({ budgets, onInitialBudget: vi.fn(), onHardCap });

    vi.advanceTimersByTime(15 * MINUTE);
    expect(onHardCap).toHaveBeenCalledTimes(1);
  });

  it('the alert fires EXACTLY once and never again, however long the call runs', () => {
    const onInitialBudget = vi.fn();
    armEscalatingTimeout({ budgets, onInitialBudget, onHardCap: vi.fn() });

    vi.advanceTimersByTime(60 * MINUTE);
    expect(onInitialBudget).toHaveBeenCalledTimes(1);
  });

  it('cancel() clears BOTH timers — a returned call must not leave a 15-minute timer holding the event loop open', () => {
    const onInitialBudget = vi.fn();
    const onHardCap = vi.fn();
    const handle = armEscalatingTimeout({ budgets, onInitialBudget, onHardCap });

    handle.cancel();
    vi.advanceTimersByTime(60 * MINUTE);

    expect(onInitialBudget).not.toHaveBeenCalled();
    expect(onHardCap).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancelling AFTER the alert still stops the pending abort', () => {
    const onHardCap = vi.fn();
    const handle = armEscalatingTimeout({ budgets, onInitialBudget: vi.fn(), onHardCap });

    vi.advanceTimersByTime(5 * MINUTE);
    handle.cancel();
    vi.advanceTimersByTime(60 * MINUTE);

    expect(onHardCap).not.toHaveBeenCalled();
  });
});

describe('timeout-policy: the 5-minute alert message', () => {
  const budgets = { initialBudgetMs: 5 * MINUTE, hardCapMs: 15 * MINUTE };

  it('NO baseline (first record for this judge): the owner\'s exact intent', () => {
    const alert = buildInitialBudgetAlert({ elapsedMs: 5 * MINUTE, budgets, modelId: 'qwen3-8b' });

    expect(alert.kind).toBe('no_baseline');
    expect(alert.baseline).toBeNull();
    expect(alert.message).toContain('5 minutes elapsed');
    expect(alert.message).toContain('CONFIRM MODEL ACCESS');
    // "waiting 10 more minutes" — derived (15 − 5), not hardcoded.
    expect(alert.remainingMs).toBe(10 * MINUTE);
    expect(alert.message).toContain('10 minutes');
    expect(alert.message).toContain('qwen3-8b');
  });

  it('a baseline exists: says how far past the observed average this call is', () => {
    // The live Qwen numbers from the 30-item calibration run.
    const baseline: JudgeLatencyBaseline = {
      count: 30,
      meanMs: 42_600,
      p50Ms: 38_000,
      p90Ms: 80_000,
      maxMs: 95_100,
    };
    const alert = buildInitialBudgetAlert({ elapsedMs: 5 * MINUTE, budgets, baseline, modelId: 'qwen3-8b' });

    expect(alert.kind).toBe('over_baseline');
    // 300000 / 42600 ≈ 7.04 — the number that distinguishes "slow" from
    // "stuck", which the raw elapsed time alone does not.
    expect(alert.multipleOfMean).toBeCloseTo(7.04, 2);
    expect(alert.message).toContain('7.0x');
    expect(alert.message).toContain('42.6s');
    expect(alert.message).toContain('30 completed judgment(s)');
    expect(alert.message).not.toContain('CONFIRM MODEL ACCESS');
  });

  it('a baseline of zeros is treated as NO baseline, not as an instant judge', () => {
    // Defensive read of the sibling contract (latency.ts returns null, never
    // zeros): a zero mean would render "Infinity× the observed average".
    const alert = buildInitialBudgetAlert({
      elapsedMs: 5 * MINUTE,
      budgets,
      baseline: { count: 0, meanMs: 0, p50Ms: 0, p90Ms: 0, maxMs: 0 },
    });
    expect(alert.kind).toBe('no_baseline');
    expect(alert.message).toContain('CONFIRM MODEL ACCESS');
  });

  it('the message tells the truth under a non-default configuration too', () => {
    const alert = buildInitialBudgetAlert({
      elapsedMs: 50,
      budgets: { initialBudgetMs: 50, hardCapMs: 200 },
    });
    expect(alert.message).toContain('50ms');
    expect(alert.message).toContain('150ms');
    expect(alert.message).not.toContain('5 minutes');
  });
});

describe('timeout-policy: two attempts, then exit', () => {
  it('CRITICAL: a hard-cap abort is retryable on attempt 1 and non_retryable on attempt 2', () => {
    expect(hardCapAbortKind(1)).toBe('retryable');
    expect(hardCapAbortKind(2)).toBe('non_retryable');
    expect(HARD_CAP_MAX_ATTEMPTS).toBe(2);
  });

  it('never a third attempt — attempt 3+ stays non_retryable', () => {
    // Belt and braces for the crash-reclaim path, where judgment.attemptCount
    // can climb past 2 without msg.attempt moving.
    expect(hardCapAbortKind(3)).toBe('non_retryable');
    expect(hardCapAbortKind(9)).toBe('non_retryable');
  });

  it('an unknown/absent attempt is treated as the first — never as a give-up', () => {
    // A caller that does not know its attempt must not silently cause a
    // judgment to be abandoned after one 15-minute call.
    expect(hardCapAbortKind(0)).toBe('retryable');
  });
});

describe('timeout-policy: the LEASE must cover the hard cap (the double-execution bug)', () => {
  it('CRITICAL: leaseMsFor is derived from the HARD CAP, not the initial budget', () => {
    const budgets = { initialBudgetMs: 5 * MINUTE, hardCapMs: 15 * MINUTE };
    expect(leaseMsFor(budgets)).toBe(15 * MINUTE + POST_CALL_SLACK_MS);
    // The old derivation, spelled out so the assertion below cannot be read as
    // an arbitrary number: initial + slack = 330000, which is 570000ms SHORT
    // of a legitimate 15-minute call.
    expect(leaseMsFor(budgets)).not.toBe(budgets.initialBudgetMs + POST_CALL_SLACK_MS);
    expect(leaseMsFor(budgets)).toBeGreaterThan(budgets.hardCapMs);
  });

  it('CRITICAL: claim.ts\'s LEASE_MS outlives the longest legitimate provider call', () => {
    // THE BUG THIS PREVENTS: reaper.ts:161 reclaims `status: 'running'` rows
    // whose `updatedAt` is older than LEASE_MS, and nothing writes the row
    // between the claim and the persist — so `updatedAt` sits at claim time
    // for the whole call. A lease shorter than the hard cap means the reaper
    // reclaims a HEALTHY in-flight judgment, republishes it, and a second
    // provider call runs for the same row: a burned call on a judge that can
    // only do one at a time, and two writers racing for one row.
    //
    // Under the old `EVALUATION_MODEL_TIMEOUT_MS + 30_000` derivation this is
    // 330000 against a 900000 hard cap, and this test goes red.
    const budgets = resolveTimeoutBudgets();
    expect(LEASE_MS).toBeGreaterThan(budgets.hardCapMs);
    expect(LEASE_MS).toBe(leaseMsFor(budgets));
  });

  it('the lease covers ONE hard cap, not two — the second attempt re-claims and re-stamps updatedAt', () => {
    const budgets = { initialBudgetMs: 5 * MINUTE, hardCapMs: 15 * MINUTE };
    expect(leaseMsFor(budgets)).toBeLessThan(2 * budgets.hardCapMs);
  });
});

describe('timeout-policy: runStartBudgetMs — the run-level deadline is sized on THIS run\'s own work, not queue depth', () => {
  it('one judgment (the calibration shape): budget is exactly one hard cap plus slack', () => {
    const budgets = { initialBudgetMs: 5 * MINUTE, hardCapMs: 15 * MINUTE };
    expect(runStartBudgetMs(1, budgets)).toBe(15 * MINUTE + RUN_DEADLINE_SLACK_MS);
  });

  it('N judgments (an ordinary multi-model run): budget scales with THIS run\'s own count', () => {
    const budgets = { initialBudgetMs: 5 * MINUTE, hardCapMs: 15 * MINUTE };
    expect(runStartBudgetMs(4, budgets)).toBe(4 * 15 * MINUTE + RUN_DEADLINE_SLACK_MS);
  });

  it('CRITICAL: derived from the HARD CAP, not the initial budget — same asymmetry as leaseMsFor', () => {
    // A budget sized on the shorter initial-alert window would let the
    // reaper force-finalize a judgment that is still legitimately executing
    // to the hard cap — the exact failure this task exists to fix,
    // reintroduced through the wrong budget instead of through queue depth.
    const budgets = { initialBudgetMs: 5 * MINUTE, hardCapMs: 15 * MINUTE };
    expect(runStartBudgetMs(1, budgets)).toBeGreaterThan(budgets.initialBudgetMs);
    expect(runStartBudgetMs(1, budgets)).not.toBe(budgets.initialBudgetMs + RUN_DEADLINE_SLACK_MS);
  });

  it('a custom slack overrides the default, mirroring leaseMsFor\'s own optional parameter', () => {
    const budgets = { initialBudgetMs: 5 * MINUTE, hardCapMs: 15 * MINUTE };
    expect(runStartBudgetMs(2, budgets, 10_000)).toBe(2 * 15 * MINUTE + 10_000);
  });

  it('RUN_DEADLINE_SLACK_MS is 60 seconds, matching the three now-deleted creation-time copies it replaces', () => {
    expect(RUN_DEADLINE_SLACK_MS).toBe(60_000);
  });
});
