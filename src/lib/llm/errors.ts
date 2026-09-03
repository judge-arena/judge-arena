/**
 * ─── Provider Error Taxonomy ────────────────────────────────────────────────
 *
 * A single, typed shape (`ProviderError`) for every failure that can come
 * out of an LLM provider call, plus `classify()` to build one from whatever
 * the Anthropic/OpenAI SDKs (or a future raw-fetch backend) actually throw.
 *
 * Classification is driven ONLY by structural signals — HTTP status,
 * SDK-specific error subclasses, node system error codes, abort/timeout
 * markers — never by inspecting `error.message` text. Message strings are
 * free-form, provider-controlled, and not a contract; matching on them
 * (e.g. `msg.includes('rate limit')`) is exactly the kind of brittle
 * heuristic this module replaces (see resilience.ts's former
 * `isTransientError`, which did exactly that).
 *
 * Both the Anthropic and OpenAI SDKs (which `openai-compatible.ts` also
 * uses for every non-Anthropic backend, including local/Ollama endpoints)
 * throw a common `APIError` shape with `.status` set directly on the error
 * instance — see `node_modules/@anthropic-ai/sdk/src/error.ts` and
 * `node_modules/openai/src/error.ts`. Connection-level failures (DNS,
 * refused connection, client-side timeout) surface as `APIConnectionError`
 * / `APIConnectionTimeoutError` with `.status` left `undefined` — handled
 * below via `instanceof` against both SDKs' exported classes.
 */

import {
  APIConnectionError as AnthropicAPIConnectionError,
  APIUserAbortError as AnthropicAPIUserAbortError,
} from '@anthropic-ai/sdk';
import {
  APIConnectionError as OpenAIAPIConnectionError,
  APIUserAbortError as OpenAIAPIUserAbortError,
} from 'openai';
// Type-only (erased at compile time), so this does NOT create a runtime
// import cycle with `./provider`, which imports `ProviderError` from here
// as a value.
import type { ProviderCallResult } from './provider';
import type { RepetitionMeasure } from './degeneration';

export type ProviderErrorKind = 'retryable' | 'non_retryable' | 'rate_limited';

export interface ProviderErrorOptions {
  kind: ProviderErrorKind;
  provider: string;
  status?: number;
  /**
   * Milliseconds the caller should wait before retrying, taken from a
   * `Retry-After` response header when present (seconds or HTTP-date form).
   * Only ever set on `kind: 'rate_limited'` errors.
   */
  retryAfterMs?: number;
  /**
   * Set when this error represents a circuit-breaker fast-fail rather than
   * an actual provider response — lets callers (the future queue worker)
   * apply a different backoff than a normal retryable failure.
   */
  breakerOpen?: boolean;
  /**
   * Set when this error represents `registry.ts`'s `execute()` aborting a
   * call once its timeout budget elapsed (Task 8 review carry: the timeout
   * budget was never wired into an actual provider-call abort before Task
   * 10) — distinguishes a deliberate budget timeout from an ordinary
   * connection-level abort/timeout the SDK itself raised.
   *
   * Under the escalating policy (`./timeout-policy.ts`) the budget that
   * produces this is the HARD CAP (`EVALUATION_MODEL_HARD_CAP_MS`), not the
   * initial `EVALUATION_MODEL_TIMEOUT_MS` budget — reaching the initial
   * budget raises an alert and produces no error at all.
   */
  timeout?: boolean;
  /**
   * Which attempt produced this error, when the thrower knew it. Set by
   * `registry.ts`'s `execute()` on a hard-cap timeout, where the attempt is
   * what decides `kind` (`retryable` on the first, `non_retryable` on the
   * second — `timeout-policy.ts`'s `hardCapAbortKind`, the owner's "15 + 15,
   * then we exit").
   *
   * Carried on the error purely so that decision is AUDITABLE: without it, a
   * judgment marked `error` with a timeout message gives no way to tell
   * whether it was abandoned deliberately at the two-attempt limit or
   * misclassified, and those two look identical in the row. Never set by
   * `classify()` — only by code that had the attempt number in hand.
   */
  attempt?: number;
  /**
   * A2.1 v2i: the provider response that CAUSED this failure, when there
   * was one (a truncated or empty-content call — see `registry.ts`'s
   * `execute()`), so a failure can still carry what came back.
   *
   * The failure this exists to prevent: a judgment that failed used to
   * persist a message and nothing else, discarding the reasoning channel,
   * the token split and the rendered prompt — precisely the evidence that
   * explains WHY it failed, and precisely what a calibration corpus needs
   * most from its failures. `judgment-consumer.ts`'s `markJudgmentError`
   * reads this.
   *
   * Never set for a transport-level failure (there is no response to
   * carry), and never set by `classify()` — only by the code that had the
   * response in hand.
   */
  callResult?: ProviderCallResult;
  /**
   * Set by `registry.ts`'s `assertUsableContent` when the output that
   * caused a truncation/empty-content failure measured as a DEGENERATE
   * REPETITION LOOP (`./degeneration.ts`: a channel over 8,000 chars that
   * deflates ≥ 5x). Carried so the decision is AUDITABLE — the message says
   * "loop" and this says by how much, over which channel, in numbers a later
   * policy (a per-judge loop count, a retry-with-penalty) can branch on
   * without parsing text. Never set by `classify()`; only by the code that
   * had the output in hand. Absent on every ordinary truncation.
   */
  repetition?: RepetitionMeasure;
  /** The original error, preserved via the standard `Error.cause` chain. */
  cause?: unknown;
}

export class ProviderError extends Error {
  override readonly name = 'ProviderError';
  readonly kind: ProviderErrorKind;
  readonly provider: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly breakerOpen?: boolean;
  readonly timeout?: boolean;
  readonly attempt?: number;
  readonly callResult?: ProviderCallResult;
  readonly repetition?: RepetitionMeasure;

  constructor(message: string, opts: ProviderErrorOptions) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.kind = opts.kind;
    this.provider = opts.provider;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    this.breakerOpen = opts.breakerOpen;
    this.timeout = opts.timeout;
    this.attempt = opts.attempt;
    this.callResult = opts.callResult;
    this.repetition = opts.repetition;
  }
}

const RETRYABLE_NODE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN']);

/**
 * Classify an unknown thrown value into a typed `ProviderError`.
 *
 * Precedence: HTTP status (429 → rate_limited; 5xx → retryable; other 4xx →
 * non_retryable) → SDK abort/timeout error classes → node system error
 * codes (checked on the error itself and one level into `.cause`, since
 * fetch-based SDKs wrap raw socket errors that way) → unknown shape.
 *
 * Unknown shapes default to `retryable`: the queue (Task 5+) bounds retry
 * damage with attempt caps and a DLQ, so treating an unrecognized failure
 * as transient is safer than silently giving up on something that might
 * have been a blip — the reverse mistake (retrying a truly permanent
 * failure a few extra times) is comparatively cheap.
 */
export function classify(err: unknown, provider: string): ProviderError {
  if (err instanceof ProviderError) return err;

  const status = extractStatus(err);

  if (status !== undefined && status >= 400) {
    if (status === 429) {
      return new ProviderError(describeError(err, status), {
        kind: 'rate_limited',
        provider,
        status,
        retryAfterMs: extractRetryAfterMs(err),
        cause: err,
      });
    }
    if (status >= 500) {
      return new ProviderError(describeError(err, status), {
        kind: 'retryable',
        provider,
        status,
        cause: err,
      });
    }
    return new ProviderError(describeError(err, status), {
      kind: 'non_retryable',
      provider,
      status,
      cause: err,
    });
  }

  if (isAbortOrTimeout(err)) {
    // Structural abort/timeout signal reaching classify() directly (not
    // already a ProviderError — that case short-circuits above). Marked
    // `timeout: true` for the same reason registry.ts's execute() marks its
    // own budget-abort ProviderError that way: a distinguishable signal for
    // callers that want to treat "the model may still be thinking" (a real
    // timeout) differently from a plain dropped connection.
    return new ProviderError(describeError(err), { kind: 'retryable', provider, timeout: true, cause: err });
  }

  const code = extractErrorCode(err);
  if (code && RETRYABLE_NODE_CODES.has(code)) {
    return new ProviderError(describeError(err), { kind: 'retryable', provider, cause: err });
  }

  return new ProviderError(describeError(err), { kind: 'retryable', provider, cause: err });
}

// ─── Structural signal extraction (never message text) ─────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Reads `.status` directly off the error (Anthropic/OpenAI SDK `APIError`
 * and subclasses expose it there), falling back to `.response.status` for
 * an axios/fetch-`Response`-shaped error from a future raw-fetch backend
 * (Task 11's vLLM/OpenRouter backends).
 */
function extractStatus(err: unknown): number | undefined {
  if (!isRecord(err)) return undefined;

  if (typeof err.status === 'number') return err.status;

  const response = err.response;
  if (isRecord(response) && typeof response.status === 'number') return response.status;

  return undefined;
}

function isAbortOrTimeout(err: unknown): boolean {
  if (
    err instanceof AnthropicAPIConnectionError ||
    err instanceof OpenAIAPIConnectionError ||
    err instanceof AnthropicAPIUserAbortError ||
    err instanceof OpenAIAPIUserAbortError
  ) {
    return true;
  }

  // A raw DOMException/Error from an AbortController-driven timeout (no SDK
  // wrapping) — checked by `.name`, a structural property, not message text.
  return err instanceof Error && err.name === 'AbortError';
}

/** Node `ErrnoException`-style `.code`, checked on the error and one level into `.cause`. */
function extractErrorCode(err: unknown): string | undefined {
  if (!isRecord(err)) return undefined;

  if (typeof err.code === 'string') return err.code;

  const cause = err.cause;
  if (isRecord(cause) && typeof cause.code === 'string') return cause.code;

  return undefined;
}

/** Best-effort `Retry-After` (seconds or HTTP-date) → milliseconds. */
function extractRetryAfterMs(err: unknown): number | undefined {
  if (!isRecord(err)) return undefined;

  const headers = err.headers;
  if (!headers) return undefined;

  let raw: string | null | undefined;
  if (typeof (headers as { get?: unknown }).get === 'function') {
    raw = (headers as { get(name: string): string | null }).get('retry-after');
  } else if (isRecord(headers)) {
    raw = headers['retry-after'] as string | null | undefined;
  }

  if (!raw) return undefined;

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const dateMs = Date.parse(raw);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());

  return undefined;
}

function describeError(err: unknown, status?: number): string {
  if (err instanceof Error) return err.message || err.name || 'Unknown provider error';
  if (status !== undefined) return `Provider request failed with status ${status}`;
  if (typeof err === 'string' && err) return err;
  return 'Unknown provider error';
}
