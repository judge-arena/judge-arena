# U3 — Hard-Cap Abort Escapes In-Process Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a `timeout: true` `ProviderError` (the hard-cap abort from `execute()`) escape `withRetry` on its first throw, so one queue delivery runs the 900 s hard cap at most once instead of up to three times under a 930 s lease.

**Architecture:** `callThroughResilience` in `src/lib/llm/index.ts:79-111` is the single wrapper every provider seam goes through (`executeJudgment` :120-124, `executeRespond` :131-135, `executePairwise` :144-148); it calls `withRetry` with the default 3-attempt, taxonomy-driven predicate. The fix is one predicate — `isRetryableInProcess` — passed as `isRetryable` in that one place: it returns `false` for any `ProviderError` whose `timeout === true` and otherwise defers to `defaultIsRetryable` (newly exported from `src/lib/llm/resilience.ts`). The consumer's disposition in `src/worker/judgment-consumer.ts` already owns the "15 + 15, then exit" policy via `hardCapAbortKind(attempt)`; this change stops the process from silently multiplying it. No schema change, no queue change, single commit.

**Tech Stack:** TypeScript, vitest (fake timers), Prisma untouched.

**Spec:**
- Handoff §3 table and §5.1: `/root/judge-arena/docs/superpowers/plans/2026-09-01-scoreboard-handoff.md:127-137`, `:174-198`
- Scoreboard spec §5.2: `/root/judge-arena/docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md:295-317`
- Verified map: `/tmp/ja-plan-inputs/dlq-replay.json` — `verify.contradictions[0]` and `verify.corrections[0]` are the defect statement; `/tmp/ja-plan-inputs/critique.json` q1 U3 is the binding shape.

**Priority / wave:** Wave 1 / #1 (XS)

**Depends on:** none. Must precede `dlq-replay` (#5 — a replay re-arms the hazard) and `amqp-reconnect` (#4 — every duplicate execution is a 15-minute lane stall).

**Owner decisions needed:** none.

## Global Constraints

- Repo: /root/judge-arena (Next.js 15.5.22, TypeScript, Prisma on Postgres — Json maps to JSONB —, amqplib 2.0.1, vitest). Node >= 22. Always use `git -C /root/judge-arena` (handoff trap 2: a stale `cd` once hard-reset the wrong repo).
- Gates, in this order, all must be clean before every commit: `npm run lint` (0 warnings) → `npx tsc --noEmit` → `npm run test:coverage` (unit; per-glob floors in vitest.config.ts:187-220 — NEVER lower a floor; if a new test import drags a module into a denominator, mock the seam as tests/lib/judgment-consumer-escalation.test.ts:41-69 does) → `npm run test:db:coverage` (RESETS the database at .env.test — verified today to be localhost:5432, the local podman `judge-arena-pg`, NOT the k8s `judge-arena-pg-1`; re-confirm with `grep DATABASE_URL /root/judge-arena/.env.test` before the first run) → `npm run test:integration` → `npm run build`. Baseline on HEAD fc9e936: 869 unit / 55 files; 670 db; 80 integration.
- TDD with an INJECTION step (CONTRIBUTING.md:210-234): every behaviour test must be shown to go RED by a deliberate breakage of the implementation and GREEN again after; a test that stays green after injection is a finding. Each task's steps must include the injection.
- One concern per commit/PR (CONTRIBUTING.md:1560). Wrong statements in docs get an explicit CORRECTION note, never a silent overwrite (CONTRIBUTING.md:1571-1574).
- Commit subject: `type(scope): lowercase summary` (feat/fix/docs/ci; scopes seen: worker, llm, queue, calibration, ci, docker). Body: narrative, then a `Gates: lint 0, tsc 0, <n> unit / <n> db / <n> integration, coverage 0.` line, then EXACTLY these trailers:
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
- Commit LOCALLY only. Never push, never promote; the operator does that (push-to-main fires CI and builds an image; promotion is a separate homelab-setup PR).
- Migration naming: `prisma/migrations/<YYYYMMDDHHMMSS>_v2<letter>_<snake>/migration.sql`, timestamp must sort after 20260901000000 (v2j); narrative `-- v2x — ...` header in the v2i/v2j style; ZERO hand edits (content must equal what `prisma migrate diff` emits), then `npx prisma generate`.
- GREP TRAP live in HEAD: /root/judge-arena/src/lib/calibration/readings.ts:164 and /root/judge-arena/scripts/importer/reconcile.ts:294 contain a deliberate NUL byte; plain grep returns nothing for those files. Use `grep -a`. NEVER remove the NUL.
- Production is sha-d21f31d47c35; main (fc9e936) is 4 docs-only commits ahead. Do not touch homelab-setup from a judge-arena task except where the plan explicitly says "separate PR in /root/homelab-setup".
- Any cluster/DB access in a plan step is READ-ONLY (psql SELECT, kubectl get/logs, rabbitmqctl list_queues). No requeue-peeks of judge.dlq (quorum delivery_limit 20 — every peek burns one).

---

## The defect, in the code as it stands (read before Task 1)

`src/lib/llm/index.ts:94-103` today:

```ts
  const retryOpts = state === 'half_open_probe' ? { maxAttempts: 1 } : {};

  try {
    const result = await withRetry(async () => {
      try {
        return await fn();
      } catch (error) {
        throw classify(error, providerName);
      }
    }, retryOpts);
```

`withRetry` (`src/lib/llm/resilience.ts:72-113`) fills `isRetryable` from `DEFAULT_RETRY` (`:48-53`), whose predicate is:

```ts
function defaultIsRetryable(error: unknown): boolean {
  const { kind } = classify(error, 'unknown');
  return kind === 'retryable' || kind === 'rate_limited';
}
```

`execute()` in `src/lib/llm/registry.ts:845-856` throws, on a hard-cap abort:

```ts
      throw new ProviderError(
        `Provider call to "${descriptor.id}" (${request.modelId}) hit the ${budgets.hardCapMs}ms hard cap ` +
          `on attempt ${attempt} (initial budget ${budgets.initialBudgetMs}ms)`,
        {
          kind: hardCapAbortKind(attempt),
          provider: descriptor.id,
          timeout: true,
          attempt,
          cause: error,
        }
      );
```

`hardCapAbortKind(1)` is `'retryable'` (`src/lib/llm/timeout-policy.ts:349-351`, `HARD_CAP_MAX_ATTEMPTS = 2` at `:106`). `classify()` returns a `ProviderError` unchanged (`src/lib/llm/errors.ts:146`). `attempt` is the escalation context's value and does not change between `withRetry` iterations. So on a first delivery the loop runs `fn()` three times at 900 s each — ~2700 s — while `LEASE_MS` is 930 s (`src/worker/claim.ts:78`). The reaper reclaims at 930 s and republishes; the two deliveries then each exhaust the consumer's attempt budget and each dead-letter, which is the paired attempt-3 / attempt-4 envelope per judgment sitting in `judge.dlq` today (dlq-replay map, `verify.contradictions[0]`).

`tests/lib/llm-index.test.ts:156-174` currently PROVES the multiplication for a generic retryable error (`toHaveBeenCalledTimes(3)`), and `tests/lib/llm-timeout.test.ts:330-336` proves attempt 1's abort is `retryable`. No test pins their composition. This plan adds the pin.

**Consequence to state plainly:** `classify()` also stamps `timeout: true` on an SDK `APIConnectionError` / `APIUserAbortError` / raw `AbortError` (`errors.ts:176-184`, `:217-230`) — with NO `attempt`, since only `registry.ts`'s hard-cap throw sets one. Under the new predicate those also escape after one in-process attempt. They remain `kind: 'retryable'`, so the consumer's delayed-retry path still re-delivers them with `attempt + 1` — after `'30s'` on the first attempt, `'5m'` from the second or when the breaker is open (`src/worker/judgment-consumer.ts:1289-1294`) — bounded by `MAX_ATTEMPTS = 3` (`:199`, `:1258`). What is given up is one cheap in-process retry for an SDK-wrapped dropped socket; what is gained is that nothing with a timeout signature can multiply the hard cap. A raw Node `ECONNRESET` (not SDK-wrapped) is classified without `timeout` (`errors.ts:186-189`) and keeps its in-process budget. This consequence is a stated behaviour, so it gets its own test (Step 2, third test) and its own injection (Step 9): a predicate narrowed to the hard-cap shape (`timeout === true && attempt !== undefined`) would leave the two ProviderError-built tests green and silently keep the 3× loop for SDK aborts.

---

### Task 1: `isRetryableInProcess` — a timeout escapes `withRetry` on the first throw

**Files:**
- Modify: `/root/judge-arena/src/lib/llm/resilience.ts:43` (export `defaultIsRetryable`)
- Modify: `/root/judge-arena/src/lib/llm/index.ts:40-41` (imports), after `:57` (new `isRetryableInProcess`), `:71-77` (doc bullet), `:94` (`retryOpts`)
- Test: `/root/judge-arena/tests/lib/llm-index.test.ts:44-45` (import), insert after `:185`
- Modify (docs, CORRECTION notes): `/root/judge-arena/docs/superpowers/plans/2026-09-01-scoreboard-handoff.md` after `:133`; `/root/judge-arena/docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md` after `:305`; `/root/judge-arena/docs/runbooks/scoring-a-judge-against-a-golden-set.md` after `:503`

**Interfaces:**
- Consumes: `withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T>` and `interface RetryOptions { maxAttempts?; baseDelayMs?; maxDelayMs?; isRetryable?: (error: unknown) => boolean }` (`resilience.ts:22-31`, `:72-75`); `class ProviderError { readonly kind; readonly provider; readonly timeout?: boolean; readonly attempt?: number; ... }` (`errors.ts:105-127`); `classify(err: unknown, provider: string): ProviderError` (`errors.ts:145`).
- Produces: `export function defaultIsRetryable(error: unknown): boolean` from `src/lib/llm/resilience.ts`; module-private `function isRetryableInProcess(error: unknown): boolean` in `src/lib/llm/index.ts`. Nothing later in this plan or in any other Wave-1 plan imports either by name; `dlq-replay` and `amqp-reconnect` depend on the *behaviour* (one hard-cap execution per delivery), not on a symbol.

- [ ] **Step 1: Confirm the baseline and the DB target**

Run:
```bash
git -C /root/judge-arena status --short
git -C /root/judge-arena rev-parse --short HEAD
grep -a DATABASE_URL /root/judge-arena/.env.test
cd /root/judge-arena && npx vitest run tests/lib/llm-index.test.ts 2>&1 | tail -6
```
Expected: no modified tracked files (the only `??` lines are the untracked `docs/superpowers/plans/2026-09-01-*.md` plans written by this planning batch — leave them alone); `fc9e936`; `DATABASE_URL` and `TEST_DATABASE_URL` are both `postgresql://judge_arena:...@localhost:5432/judge_arena_test`; `Tests  10 passed (10)`.

- [ ] **Step 2: Write the failing tests**

In `/root/judge-arena/tests/lib/llm-index.test.ts`, the current lines 44-45 are:

```ts
const { executeJudgment, executeRespond } = await import('@/lib/llm');
import type { RunProviderJudgmentInput, RunProviderResponseInput } from '@/lib/llm';
```

Replace them with:

```ts
const { executeJudgment, executeRespond } = await import('@/lib/llm');
import type { RunProviderJudgmentInput, RunProviderResponseInput } from '@/lib/llm';
// The real class, not a mock: `classify()` passes a ProviderError through by
// identity (errors.ts:146) and `withRetry` rethrows the same object, so the
// U3 tests below can assert `rejects.toBe(theErrorWeThrew)`.
import { ProviderError } from '@/lib/llm/errors';
```

Then find the test ending at line 185:

```ts
  it('does not retry a non_retryable classified error — single attempt, single breaker failure', async () => {
    const err400 = Object.assign(new Error('bad request'), { status: 400 });
    executeJudgmentCallMock.mockRejectedValue(err400);

    await expect(executeJudgment(baseJudgmentInput)).rejects.toMatchObject({
      kind: 'non_retryable',
    });
    expect(executeJudgmentCallMock).toHaveBeenCalledTimes(1);
    expect(onFailureMock).toHaveBeenCalledTimes(1);
  });
```

and insert these three tests immediately AFTER it (before the `it('a half-open probe gets exactly one attempt, …` test):

```ts
  it('U3: a timeout ProviderError (hard-cap abort, attempt 1, kind retryable) is NOT retried in-process — one call, one breaker failure, the same error propagates', async () => {
    // Fake timers so that if the implementation DOES retry, the failure is a
    // clean "called 3 times" rather than a 5 s test timeout spent in
    // withRetry's real backoff sleeps.
    vi.useFakeTimers();
    // Exactly what registry.ts's execute() throws when the 900 s hard cap
    // fires on a first delivery (registry.ts:845-856): kind is
    // hardCapAbortKind(1) === 'retryable', timeout: true, attempt: 1.
    const hardCap = new ProviderError(
      'Provider call to "llamacpp" (Qwen3.6-35B-A3B) hit the 900000ms hard cap on attempt 1 (initial budget 300000ms)',
      { kind: 'retryable', provider: 'llamacpp', timeout: true, attempt: 1 }
    );
    executeJudgmentCallMock.mockRejectedValue(hardCap);

    const promise = executeJudgment(baseJudgmentInput);
    promise.catch(() => {}); // swallow the eventual rejection before we assert on it below

    await vi.runAllTimersAsync();

    await expect(promise).rejects.toBe(hardCap);
    expect(executeJudgmentCallMock).toHaveBeenCalledTimes(1); // NOT withRetry's default 3
    expect(onFailureMock).toHaveBeenCalledTimes(1);
    expect(onSuccessMock).not.toHaveBeenCalled();
  });

  it('U3: a rate_limited ProviderError WITHOUT timeout keeps the full in-process retry budget', async () => {
    vi.useFakeTimers();
    const limited = new ProviderError('429 slow down', {
      kind: 'rate_limited',
      provider: 'llamacpp',
      status: 429,
    });
    executeJudgmentCallMock.mockRejectedValue(limited);

    const promise = executeJudgment(baseJudgmentInput);
    promise.catch(() => {});

    await vi.runAllTimersAsync();

    await expect(promise).rejects.toBe(limited);
    expect(executeJudgmentCallMock).toHaveBeenCalledTimes(3); // default maxAttempts, unchanged
    expect(onFailureMock).toHaveBeenCalledTimes(1);
  });

  it('U3: a raw AbortError — which classify() stamps timeout: true with no attempt (errors.ts isAbortOrTimeout) — also escapes after one call', async () => {
    vi.useFakeTimers();
    // NOT a ProviderError: this one goes through classify()'s isAbortOrTimeout
    // branch (errors.ts:176-184, :229), which yields kind 'retryable',
    // timeout: true and no `attempt`. It pins the "Consequence" paragraph
    // above — the predicate keys on the timeout flag alone, not on the
    // hard-cap shape — and is the only test that exercises the
    // classify()->timeout wiring rather than classify()'s identity short-circuit.
    const aborted = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    executeJudgmentCallMock.mockRejectedValue(aborted);

    const promise = executeJudgment(baseJudgmentInput);
    promise.catch(() => {});

    await vi.runAllTimersAsync();

    await expect(promise).rejects.toMatchObject({ name: 'ProviderError', kind: 'retryable', timeout: true, provider: 'anthropic' });
    expect(executeJudgmentCallMock).toHaveBeenCalledTimes(1);
    expect(onFailureMock).toHaveBeenCalledTimes(1);
  });
```

The existing `afterEach(() => { vi.useRealTimers(); })` at lines 87-89 already restores real timers. `provider: 'anthropic'` is `baseJudgeVersion.servingBackend` (`:48`), which `executeJudgment` passes to `callThroughResilience` as `providerName` (`index.ts:123`).

- [ ] **Step 3: Run the tests to verify the two timeout tests fail and the rate_limited test passes**

Run: `cd /root/judge-arena && npx vitest run tests/lib/llm-index.test.ts 2>&1 | tail -40`
Expected: `Tests  2 failed | 11 passed (13)`. The failures are the hard-cap test AND the AbortError test, each with
`AssertionError: expected "spy" to be called 1 times, but got 3 times` on its `toHaveBeenCalledTimes(1)` line. The rate_limited test passes already (it pins that the fix must not over-reach). The pre-existing 500 test at :156-174 stays green.

- [ ] **Step 4: Export `defaultIsRetryable` from resilience.ts**

In `/root/judge-arena/src/lib/llm/resilience.ts`, line 43 is:

```ts
function defaultIsRetryable(error: unknown): boolean {
```

Replace with:

```ts
export function defaultIsRetryable(error: unknown): boolean {
```

Nothing else in that file changes; `DEFAULT_RETRY` at `:48-53` still references it.

- [ ] **Step 5: Add the predicate and pass it to `withRetry`**

In `/root/judge-arena/src/lib/llm/index.ts`, lines 40-41 are:

```ts
import { withRetry } from './resilience';
import { classify, ProviderError } from './errors';
```

Replace with:

```ts
import type { RetryOptions } from './resilience';
import { defaultIsRetryable, withRetry } from './resilience';
import { classify, ProviderError } from './errors';
```

Lines 55-57 (end of `breakerKey`) are:

```ts
function breakerKey(servingBackend: string, endpoint: string | null, modelId: string): string {
  return `${servingBackend}:${endpoint ?? 'default'}:${modelId}`;
}
```

Insert immediately after that closing brace (before the `/**` that opens the `callThroughResilience` doc at line 59):

```ts

/**
 * The in-process retry predicate for `callThroughResilience`.
 *
 * Defers to `withRetry`'s taxonomy default for everything EXCEPT a
 * `ProviderError` carrying `timeout: true` — `registry.ts`'s `execute()`
 * hard-cap abort, or an SDK-level abort/connection error that `classify()`
 * marks the same way (errors.ts `isAbortOrTimeout`). Those escape to the
 * caller on the first throw.
 *
 * Why a timeout is different from a 500: retrying a 500 in-process is cheap
 * and often works. Retrying a timeout in-process re-runs the WHOLE budget. A
 * hard-cap abort on attempt 1 is `kind: 'retryable'` (`timeout-policy.ts`'s
 * `hardCapAbortKind` — the consumer is meant to give it one more delivery),
 * so under the default predicate ONE delivery ran `execute()` up to
 * `maxAttempts` (3) times at the full 900 s hard cap, ~2700 s, inside a 930 s
 * lease (`claim.ts`'s `LEASE_MS`). The reaper reclaimed the row mid-flight
 * and republished it, the second delivery ran beside the first, and both
 * dead-lettered: that is the paired attempt-3/attempt-4 `judge.dlq` envelope
 * per judgment on calibration run 1 (2026-08-31). The "15 + 15, then exit"
 * policy is decided by `judgment-consumer.ts`'s disposition of this SAME
 * error, so the correct number of in-process attempts for a timeout is
 * exactly one — anything more silently multiplies that policy.
 */
function isRetryableInProcess(error: unknown): boolean {
  if (error instanceof ProviderError && error.timeout === true) return false;
  return defaultIsRetryable(error);
}
```

In the `callThroughResilience` doc comment, lines 71-77 are:

```ts
 * - Every error crossing the provider boundary is classified immediately
 *   (with the real provider name) before `withRetry` ever sees it, so
 *   `withRetry`'s default taxonomy check and the error that ultimately
 *   propagates to the caller are both properly-typed `ProviderError`s.
 * - The breaker only ever records ONE outcome per call to `executeJudgment`/
 *   `executeRespond` — the whole retry sequence counts as a single
 *   breaker failure (or success).
```

Replace with:

```ts
 * - Every error crossing the provider boundary is classified immediately
 *   (with the real provider name) before `withRetry` ever sees it, so
 *   the retry predicate and the error that ultimately propagates to the
 *   caller are both properly-typed `ProviderError`s.
 * - A `timeout: true` `ProviderError` is never retried here (see
 *   `isRetryableInProcess` above): it goes straight to the caller, whose
 *   attempt policy — not `withRetry`'s — decides whether there is a second
 *   attempt.
 * - The breaker only ever records ONE outcome per call to `executeJudgment`/
 *   `executeRespond` — the whole retry sequence counts as a single
 *   breaker failure (or success).
```

Then the single line (currently line 94 before the insertions above; search for it, do not count):

```ts
  const retryOpts = state === 'half_open_probe' ? { maxAttempts: 1 } : {};
```

Replace with:

```ts
  const retryOpts: RetryOptions = {
    isRetryable: isRetryableInProcess,
    ...(state === 'half_open_probe' ? { maxAttempts: 1 } : {}),
  };
```

The `withRetry(async () => { … }, retryOpts)` call that follows is unchanged.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd /root/judge-arena && npx vitest run tests/lib/llm-index.test.ts tests/lib/resilience.test.ts tests/lib/llm-timeout.test.ts 2>&1 | tail -8`
Expected: all three files green; llm-index shows `13 passed (13)`.

- [ ] **Step 7: Injection A — remove the predicate**

Break: in `/root/judge-arena/src/lib/llm/index.ts` change

```ts
    isRetryable: isRetryableInProcess,
```
to
```ts
    isRetryable: defaultIsRetryable,
```

Run: `cd /root/judge-arena && npx vitest run tests/lib/llm-index.test.ts 2>&1 | grep -E "✓|×|expected|Tests "`
Expected: `2 failed | 11 passed` — the U3 hard-cap test AND the U3 AbortError test both fail with `expected "spy" to be called 1 times, but got 3 times`. Restore the line to `isRetryable: isRetryableInProcess,`.

- [ ] **Step 8: Injection B — over-reach (nothing is retried)**

Break: in `isRetryableInProcess` change

```ts
  return defaultIsRetryable(error);
```
to
```ts
  return false;
```

Run: `cd /root/judge-arena && npx vitest run tests/lib/llm-index.test.ts 2>&1 | grep -E "✓|×|expected|Tests "`
Expected: `2 failed | 11 passed` — the U3 rate_limited test AND the pre-existing `classifies a raw provider error, retries transient failures…` test both fail with `expected "spy" to be called 3 times, but got 1 times`. Restore to `return defaultIsRetryable(error);`. Re-run the file: `13 passed (13)`.

- [ ] **Step 9: Injection C — narrow the predicate to the hard-cap shape only**

This is the injection the first two tests cannot see: both build a `ProviderError` directly, so `classify()`'s identity short-circuit (`errors.ts:146`) is the only path they exercise. A predicate that additionally requires `attempt !== undefined` still fixes the hard cap and silently keeps 3× in-process retries for every SDK abort/connection error — the exact behaviour the "Consequence" paragraph and the commit body say is escaped.

Break: in `isRetryableInProcess` change

```ts
  if (error instanceof ProviderError && error.timeout === true) return false;
```
to
```ts
  if (error instanceof ProviderError && error.timeout === true && error.attempt !== undefined) return false;
```

Run: `cd /root/judge-arena && npx vitest run tests/lib/llm-index.test.ts 2>&1 | grep -E "✓|×|expected|Tests "`
Expected: `1 failed | 12 passed` — ONLY the U3 AbortError test fails, with `expected "spy" to be called 1 times, but got 3 times`; the hard-cap and rate_limited tests stay green (which is the point: without the third test this injection would be invisible). Restore the line to `if (error instanceof ProviderError && error.timeout === true) return false;`. Re-run the file: `13 passed (13)`.

If any of the three injections leaves the file green, stop: that is a finding (CONTRIBUTING.md:216-217), not a step to skip.

- [ ] **Step 10: CORRECTION note — handoff §3 table**

In `/root/judge-arena/docs/superpowers/plans/2026-09-01-scoreboard-handoff.md`, lines 129-135 are:

```markdown
| | value | behaviour |
|---|---|---|
| initial budget | `EVALUATION_MODEL_TIMEOUT_MS`, 300 000 ms | **warns, does not abort** |
| hard cap | `EVALUATION_MODEL_HARD_CAP_MS`, default 900 000 ms (unset in the manifest) | **aborts** |
| attempts | 2, then `non_retryable` | |

"Health" means **this judge has completed a judgment before** — not that a probe answers. A
```

Insert between the table's last row (`| attempts | 2, then …`) and the blank line before `"Health" means`:

```markdown

> **CORRECTION (2026-09-01, U3).** The `attempts` row above was true of the *consumer's* disposition
> and false of the *process*. `callThroughResilience` (`src/lib/llm/index.ts`) wrapped every
> `execute()` in `withRetry` with the default 3-attempt taxonomy predicate, and a hard-cap abort on
> attempt 1 is `kind: 'retryable'` — so one delivery could run the 900 s cap up to three times
> (~2700 s) inside a 930 s lease. The reaper reclaimed mid-flight and the row executed twice; that
> is the mechanism behind the paired attempt-3/attempt-4 `judge.dlq` envelopes on run 1, and it was
> still live on `sha-d21f31d47c35`. "2, then `non_retryable`" was never enforced end-to-end. Fixed by
> `isRetryableInProcess`: a `timeout: true` `ProviderError` escapes `withRetry` on its first throw,
> so the consumer's attempt policy is the only one that runs. Pinned by
> `tests/lib/llm-index.test.ts` ("U3: a timeout ProviderError … is NOT retried in-process").
```

- [ ] **Step 11: CORRECTION note — scoreboard spec §5.2**

In `/root/judge-arena/docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md`, lines 299-305 are:

```markdown
- **300 000 ms initial budget — alerts, does not abort.** With a latency baseline the warning states
  how far past normal this call is; with none, it says *confirm model access, waiting 10 more minutes*.
- **900 000 ms hard cap — aborts.** Two attempts, then `non_retryable`.
- Runtime recorded per `(dataset, item, model)`, so time-to-compute is queryable.

No manifest change was needed: `EVALUATION_MODEL_TIMEOUT_MS` stays `"300000"` and is now the
*initial budget*; `EVALUATION_MODEL_HARD_CAP_MS` is unset and takes the 900 000 default.
```

Insert immediately after line 305 (`*initial budget*; … takes the 900 000 default.`), before the blank line and `**The part that was a bug rather than a feature:**`:

```markdown

> **CORRECTION (2026-09-01, U3).** "Two attempts, then `non_retryable`" described the consumer's
> disposition of the hard-cap error, not what the process did with it. `src/lib/llm/index.ts`'s
> `callThroughResilience` still passed the attempt-1 abort (`kind: 'retryable'`, `timeout: true`)
> through `withRetry`'s default 3-attempt predicate, so one delivery could execute the 900 s cap
> three times under the 930 s lease that the paragraph directly below says closed the double-execution hazard — the
> lease fix bounded one `execute()`; it did not bound the retry loop around it. The
> `"LLM call failed, retrying" attempt 2 maxAttempts 3 … timed out` log line in §5 is that loop.
> Fixed by making a `timeout: true` `ProviderError` escape `withRetry` on its first throw
> (`isRetryableInProcess`, `src/lib/llm/index.ts`).
```

- [ ] **Step 12: CORRECTION note — runbook §8.7 table**

In `/root/judge-arena/docs/runbooks/scoring-a-judge-against-a-golden-set.md`, lines 499-505 are:

```markdown
| | value | behaviour |
|---|---|---|
| initial budget | `EVALUATION_MODEL_TIMEOUT_MS`, 300 000 ms | **warns and keeps waiting** |
| hard cap | `EVALUATION_MODEL_HARD_CAP_MS`, default 900 000 ms | **aborts** |
| attempts | 2 | then `non_retryable` |

At 300 s the worker emits `judgment passed the initial timeout budget`. If that judge has completed
```

Insert between the `| attempts | 2 | …` row and the blank line before `At 300 s the worker emits`:

```markdown

> **CORRECTION (2026-09-01, U3).** On images up to and including `sha-d21f31d47c35` the `attempts`
> row was only half true: the consumer gave the judgment two deliveries, but inside EACH delivery
> `withRetry` re-ran the 900 s hard cap up to three times, so the worst case per delivery was
> ~2700 s, not 900 s, and the 930 s lease let the reaper republish it mid-flight. The operator-visible
> symptoms are a `"LLM call failed, retrying" … hard cap` line in the worker log and paired
> attempt-3/attempt-4 envelopes for one judgment in `judge.dlq`. Fixed in `src/lib/llm/index.ts`
> (`isRetryableInProcess`): a timeout now escapes on its first throw. Worst case per item is 900 s
> per delivery, as the §8.7 sizing paragraph below assumes.
```

- [ ] **Step 13: Gates**

Run, in order, from `/root/judge-arena` (each must be clean before the next):

```bash
cd /root/judge-arena && npm run lint
cd /root/judge-arena && npx tsc --noEmit
cd /root/judge-arena && npm run test:coverage 2>&1 | tail -40
grep -a DATABASE_URL /root/judge-arena/.env.test   # must still be localhost:5432/judge_arena_test
cd /root/judge-arena && npm run test:db:coverage 2>&1 | tail -20
cd /root/judge-arena && npm run test:integration 2>&1 | tail -10
cd /root/judge-arena && npm run build 2>&1 | tail -5
```

Expected: lint exits 0 with no warnings; tsc prints nothing; unit reports `872 passed` across 55 files and every `src/lib/llm/**` floor (91/94/83/91, vitest.config.ts:203) still passes — the `src/lib/llm` row reads approximately `95.8 | 89.5 | 98.1 | 95.8` (baseline on fc9e936: `95.79 | 89.44 | 98.05 | 95.79`) and the `src/lib/queue`, `src/worker`, `src/lib/realtime` rows are unchanged from baseline (branches `82.35`, `90.43`, `87.5`), because the test file imports only `@/lib/llm` and `@/lib/llm/errors`, both already in the denominator; db reports `670 passed`; integration `80 passed`; build succeeds.

If the unit count is not 872, read the diff before proceeding — do not adjust a floor. The db and integration counts cannot be moved by this change: no file under `tests/db` or `tests/integration` imports `@/lib/llm` directly (`grep -rln "from '@/lib/llm'" tests/db tests/integration` is empty), and the nine that reach it transitively — via `@/worker/judgment-consumer` or `@/app/api/config/import/route` — either inject a fake provider through `createJudgmentConsumer({ provider… })` (worker-claims, finalization, pairwise-run, respond-mode) or use only `legacyProviderToBackend` (the config-import db tests), so `callThroughResilience` never executes there. A db or integration count other than 670 / 80 is therefore pre-existing drift on HEAD, not this change: record the measured numbers in the commit body's Gates line and do not adjust anything.

- [ ] **Step 14: Commit (single commit, locally only)**

```bash
git -C /root/judge-arena add \
  src/lib/llm/index.ts \
  src/lib/llm/resilience.ts \
  tests/lib/llm-index.test.ts \
  docs/superpowers/plans/2026-09-01-scoreboard-handoff.md \
  docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md \
  docs/runbooks/scoring-a-judge-against-a-golden-set.md \
  docs/superpowers/plans/2026-09-01-u3-hardcap-escapes-retry.md
git -C /root/judge-arena status --short   # exactly those seven paths staged (A/M in column 1); the other 2026-09-01-*.md plans stay `??` — do not add them
git -C /root/judge-arena commit -F - <<'EOF'
fix(llm): a timeout ProviderError escapes withRetry on the first throw

callThroughResilience wrapped every execute() in withRetry(maxAttempts 3)
under the taxonomy default predicate, and a hard-cap abort on attempt 1
is kind 'retryable' (hardCapAbortKind, timeout-policy.ts). One delivery
could therefore run the 900 s hard cap three times (~2700 s) inside a
930 s lease; the reaper reclaimed the row mid-flight and republished it,
and both deliveries dead-lettered. That is the paired attempt-3/attempt-4
judge.dlq envelope per judgment on calibration run 1 (2026-08-31), and it
was still live on sha-d21f31d47c35: neither 414e826 nor 60be6f6 touched
this policy, so "two attempts, then non_retryable" was enforced by the
consumer and silently multiplied by the process.

isRetryableInProcess returns false for any ProviderError with
timeout: true and defers to defaultIsRetryable (now exported from
resilience.ts) for everything else. A 500 or a 429 keeps the full
in-process budget; a timeout goes straight to judgment-consumer.ts,
whose disposition owns the 15 + 15 policy. An SDK-wrapped connection
error carries the same timeout flag (errors.ts isAbortOrTimeout) and now
also escapes after one attempt; it stays retryable, so the consumer's
delayed-retry path (30 s, then 5 m) re-delivers it, bounded by
MAX_ATTEMPTS.

tests/lib/llm-index.test.ts pins one call / one breaker failure for a
timeout error (red before: called 3 times), three calls for a
rate_limited non-timeout error (red under an over-reaching predicate),
and one call for a raw AbortError that classify() marks timeout: true
without an attempt (red under a predicate narrowed to the hard-cap
shape). CORRECTION notes on the "attempts 2, then non_retryable" tables
in the handoff (§3), the scoreboard spec (§5.2) and runbook §8.7.

Gates: lint 0, tsc 0, 872 unit / 670 db / 80 integration, coverage 0.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
EOF
git -C /root/judge-arena log -1 --stat
```

Expected: one commit on top of `fc9e936` touching exactly the seven files. Do NOT push. Hand back to the operator, who pushes, watches CI, and verifies the Harbor tag with `skopeo inspect` before promoting (handoff §6 traps 3/4).

---

## Self-review

1. **Spec coverage.** Binding decision items: `isRetryable` predicate returning false for `ProviderError.timeout === true` and deferring to the default (Step 5) — done; `defaultIsRetryable` exported (Step 4) — done; unit test with a `timeout: true, attempt: 1, kind: 'retryable'` mock called exactly once, red today (Steps 2-3, 7) — done; the existing 3× retry test at :156-174 stays green for non-timeout errors (Step 8 proves it is still live) — done; rate_limited non-timeout still retried (Step 2, second test) — done; the stated consequence that an SDK abort/connection error (`timeout: true`, no `attempt`) also escapes after one call is pinned by its own test (Step 2, third test — the only one that goes through `classify()`'s `isAbortOrTimeout` branch rather than the identity short-circuit) and its own injection (Step 9, red only for that test) — done; CORRECTION note in the handoff §3 table (Step 10) and in the spec where it states the same (Step 11) — done, plus runbook §8.7 which carries the identical row (Step 12); no schema change; single commit (Step 14) — done. Every behaviour the commit body claims has a test that goes red under a deliberate breakage: Injection A (both timeout tests), Injection B (rate_limited + pre-existing 500), Injection C (AbortError only).
2. **Placeholder scan.** No TBD/TODO/"similar to"; every edit shows the current text and the replacement; every referenced symbol (`RetryOptions`, `defaultIsRetryable`, `withRetry`, `ProviderError`, `classify`, `hardCapAbortKind`, `isAbortOrTimeout`, `LEASE_MS`, `MAX_ATTEMPTS`, `legacyProviderToBackend`, `createJudgmentConsumer`) exists in the tree at the cited line or is defined in Step 4/5. Every count in the plan is measured, not estimated: 10 → 13 tests in the file; 869 → 872 unit across 55 files; coverage rows quoted from a run of the exact Step 2/4/5 edits on a git-archive copy of fc9e936; db 670 / integration 80 are the HEAD baseline and are argued unmovable in Step 13 rather than assumed.
3. **Type consistency.** `isRetryableInProcess(error: unknown): boolean` is used with the exact same name in Steps 5, 7, 8, 9 and the three doc notes; `defaultIsRetryable(error: unknown): boolean` matches `resilience.ts:43`; `RetryOptions.isRetryable?: (error: unknown) => boolean` matches `resilience.ts:30`; the third test's `toMatchObject({ name: 'ProviderError', kind: 'retryable', timeout: true, provider: 'anthropic' })` matches what `classify()` builds at `errors.ts:183` with `providerName = baseJudgeVersion.servingBackend`.
