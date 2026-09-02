/**
 * LLM Retry
 *
 * Exponential backoff with jitter for transient failures (rate limits,
 * timeouts, 5xx, connection errors). Retryability is taxonomy-driven via
 * `classify()` (see `./errors.ts`) rather than the substring-matching
 * `isTransientError()` this module used to ship — see git history for the
 * old implementation.
 *
 * The circuit breaker that used to live in this file (an in-process `Map`,
 * blind to every other replica) has moved to `./breaker-redis.ts`, backed
 * by Redis so state is shared cluster-wide. Wiring between the two —
 * breaker gating + retry + `classify()` on every caught error — lives in
 * `./index.ts`'s `executeJudgment`/`executeRespond`.
 */

import { logger } from '@/lib/logger';
import { classify } from './errors';

// ─── Retry with Exponential Backoff ────────────────────────────────────────────

export interface RetryOptions {
  /** Maximum number of attempts (including the first) */
  maxAttempts?: number;
  /** Base delay in ms before the first retry */
  baseDelayMs?: number;
  /** Maximum delay cap in ms */
  maxDelayMs?: number;
  /** Only retry if this returns true for the thrown error */
  isRetryable?: (error: unknown) => boolean;
}

/**
 * Default retry predicate: classify the error (taxonomy-driven, never
 * message-substring-driven — see `./errors.ts`) and retry only
 * `'retryable'`/`'rate_limited'` kinds. The `'unknown'` provider label here
 * is a placeholder — `classify()`'s kind decision never branches on the
 * provider argument, and callers that already classified the error with
 * the real provider name (e.g. `index.ts`) get an instant passthrough via
 * `classify()`'s `err instanceof ProviderError` short-circuit, so the real
 * label is preserved end-to-end.
 */
export function defaultIsRetryable(error: unknown): boolean {
  const { kind } = classify(error, 'unknown');
  return kind === 'retryable' || kind === 'rate_limited';
}

const DEFAULT_RETRY: Required<RetryOptions> = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  isRetryable: defaultIsRetryable,
};

/** A `ProviderError`'s `retryAfterMs`, read structurally (duck-typed, no `errors.ts` import needed here). */
function retryAfterMsOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Run an async function with automatic retries and exponential backoff + jitter.
 *
 * A `rate_limited` error's `retryAfterMs` (from a `Retry-After` response
 * header, see `classify()`) pushes the wait out further than the plain
 * exponential formula would — "wait at least as long as the server asked"
 * — but is still bounded by `maxDelayMs`: an upstream returning an
 * unreasonable `Retry-After` shouldn't be able to stall a request
 * indefinitely from inside this loop.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs, isRetryable } = {
    ...DEFAULT_RETRY,
    ...opts,
  };

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt >= maxAttempts || !isRetryable(error)) {
        throw error;
      }

      const exponential = Math.min(
        baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * baseDelayMs,
        maxDelayMs
      );
      const retryAfterMs = retryAfterMsOf(error);
      const delay =
        retryAfterMs !== undefined ? Math.min(Math.max(exponential, retryAfterMs), maxDelayMs) : exponential;

      logger.warn('LLM call failed, retrying', {
        attempt,
        maxAttempts,
        delayMs: Math.round(delay),
        error: error instanceof Error ? error.message : String(error),
      });

      await sleep(delay);
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
