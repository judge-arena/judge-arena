/**
 * LLM Retry & Circuit Breaker
 *
 * - Exponential backoff with jitter for transient failures (rate limits, timeouts).
 * - Per-provider circuit breaker to stop hammering a failing service.
 */

import { logger } from '@/lib/logger';

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

const DEFAULT_RETRY: Required<RetryOptions> = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  isRetryable: isTransientError,
};

/**
 * Run an async function with automatic retries and exponential backoff + jitter.
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

      const delay = Math.min(
        baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * baseDelayMs,
        maxDelayMs
      );

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

// ─── Circuit Breaker ───────────────────────────────────────────────────────────

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Failures within the window before opening the circuit */
  failureThreshold?: number;
  /** Time in ms before the circuit transitions from open → half-open */
  resetTimeoutMs?: number;
  /** Rolling window in ms for counting failures */
  windowMs?: number;
}

const DEFAULT_CB: Required<CircuitBreakerOptions> = {
  failureThreshold: 5,
  resetTimeoutMs: 60_000,
  windowMs: 120_000,
};

interface CircuitBreakerState {
  state: CircuitState;
  failures: number[];
  lastOpenedAt: number;
  options: Required<CircuitBreakerOptions>;
}

const circuits = new Map<string, CircuitBreakerState>();

/**
 * Get or create a circuit breaker for a given key (e.g., provider name).
 */
function getCircuit(key: string, opts: CircuitBreakerOptions = {}): CircuitBreakerState {
  if (!circuits.has(key)) {
    circuits.set(key, {
      state: 'closed',
      failures: [],
      lastOpenedAt: 0,
      options: { ...DEFAULT_CB, ...opts },
    });
  }
  return circuits.get(key)!;
}

/**
 * Execute a function through a circuit breaker.
 *
 * - **Closed**: requests pass through normally; failures are tracked.
 * - **Open**: requests are immediately rejected for `resetTimeoutMs`.
 * - **Half-open**: a single probe request is allowed. If it succeeds the circuit
 *   resets to closed; if it fails it reopens.
 */
export async function withCircuitBreaker<T>(
  key: string,
  fn: () => Promise<T>,
  opts: CircuitBreakerOptions = {}
): Promise<T> {
  const cb = getCircuit(key, opts);
  const now = Date.now();

  // Prune old failure timestamps outside the window
  cb.failures = cb.failures.filter((t) => now - t < cb.options.windowMs);

  // Check state transitions
  if (cb.state === 'open') {
    if (now - cb.lastOpenedAt >= cb.options.resetTimeoutMs) {
      cb.state = 'half-open';
      logger.info('Circuit breaker half-open, allowing probe', { provider: key });
    } else {
      throw new CircuitOpenError(
        `Circuit breaker open for "${key}". Try again in ${Math.ceil(
          (cb.options.resetTimeoutMs - (now - cb.lastOpenedAt)) / 1000
        )}s.`
      );
    }
  }

  try {
    const result = await fn();

    // Success: reset the circuit
    if (cb.state === 'half-open') {
      logger.info('Circuit breaker closed after successful probe', { provider: key });
    }
    cb.state = 'closed';
    cb.failures = [];

    return result;
  } catch (error) {
    cb.failures.push(Date.now());

    if (cb.failures.length >= cb.options.failureThreshold || cb.state === 'half-open') {
      cb.state = 'open';
      cb.lastOpenedAt = Date.now();
      logger.error('Circuit breaker opened', {
        provider: key,
        failures: cb.failures.length,
        threshold: cb.options.failureThreshold,
      });
    }

    throw error;
  }
}

/**
 * Get the current state of a circuit breaker (for health checks / monitoring).
 */
export function getCircuitState(key: string): CircuitState | 'unknown' {
  return circuits.get(key)?.state ?? 'unknown';
}

/**
 * Reset a circuit breaker (e.g., after deploying a fix).
 */
export function resetCircuit(key: string): void {
  circuits.delete(key);
}

// ─── Combined: Retry + Circuit Breaker ─────────────────────────────────────────

export interface ResilientCallOptions extends RetryOptions, CircuitBreakerOptions {}

/**
 * Execute an LLM call with both circuit breaker protection and retry logic.
 * The circuit breaker wraps the entire retry sequence — if all retries fail,
 * it counts as a single circuit breaker failure.
 */
export async function resilientCall<T>(
  providerKey: string,
  fn: () => Promise<T>,
  opts: ResilientCallOptions = {}
): Promise<T> {
  return withCircuitBreaker(providerKey, () => withRetry(fn, opts), opts);
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

export class CircuitOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitOpenError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Determine whether an error is transient and worth retrying.
 */
export function isTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const msg = error.message.toLowerCase();

  // Rate limiting
  if (msg.includes('rate limit') || msg.includes('429') || msg.includes('too many requests')) {
    return true;
  }

  // Timeouts
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('etimedout')) {
    return true;
  }

  // Network errors
  if (
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('socket hang up') ||
    msg.includes('network') ||
    msg.includes('fetch failed')
  ) {
    return true;
  }

  // Server errors (5xx from provider SDKs)
  if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504')) {
    return true;
  }

  // Anthropic SDK overloaded error
  if (msg.includes('overloaded')) {
    return true;
  }

  return false;
}
