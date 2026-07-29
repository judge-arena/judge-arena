import { describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { ProviderError, classify } from '@/lib/llm/errors';

describe('classify()', () => {
  describe('HTTP status classification', () => {
    it('429 → rate_limited', () => {
      const result = classify({ status: 429, message: 'Too Many Requests' }, 'anthropic');
      expect(result).toBeInstanceOf(ProviderError);
      expect(result.kind).toBe('rate_limited');
      expect(result.status).toBe(429);
      expect(result.provider).toBe('anthropic');
    });

    it.each([500, 502, 503, 504, 520])('%i (5xx) → retryable', (status) => {
      const result = classify({ status, message: 'Server error' }, 'anthropic');
      expect(result.kind).toBe('retryable');
      expect(result.status).toBe(status);
    });

    it.each([400, 401, 403, 404, 409, 422])('%i (remaining 4xx) → non_retryable', (status) => {
      const result = classify({ status, message: 'Client error' }, 'anthropic');
      expect(result.kind).toBe('non_retryable');
      expect(result.status).toBe(status);
    });

    it('reads status from a response.status shape (fetch/axios-style errors)', () => {
      const result = classify({ response: { status: 503 } }, 'openrouter');
      expect(result.kind).toBe('retryable');
      expect(result.status).toBe(503);
    });
  });

  describe('never classifies from message substrings', () => {
    it('status 400 with a message that says "rate limit" stays non_retryable', () => {
      const result = classify(
        { status: 400, message: 'rate limit exceeded, please slow down' },
        'anthropic'
      );
      expect(result.kind).toBe('non_retryable');
    });

    it('status 500 with a message that says "success" stays retryable', () => {
      const result = classify({ status: 500, message: 'success (this is a lie)' }, 'anthropic');
      expect(result.kind).toBe('retryable');
    });

    it('a plain Error whose message mentions "429"/"timeout" but has no status/code is still just the conservative default (retryable), not specifically matched off the text', () => {
      const result = classify(new Error('call failed: 429 timeout maybe?'), 'anthropic');
      expect(result.kind).toBe('retryable');
      expect(result.status).toBeUndefined();
    });
  });

  describe('Retry-After extraction (rate_limited only)', () => {
    it('numeric seconds header → retryAfterMs', () => {
      const result = classify(
        { status: 429, message: 'slow down', headers: { 'retry-after': '2' } },
        'anthropic'
      );
      expect(result.kind).toBe('rate_limited');
      expect(result.retryAfterMs).toBe(2000);
    });

    it('Headers-like object (.get) is supported', () => {
      const result = classify(
        { status: 429, message: 'slow down', headers: new Headers({ 'retry-after': '3' }) },
        'anthropic'
      );
      expect(result.retryAfterMs).toBe(3000);
    });

    it('HTTP-date retry-after is converted to a millisecond offset', () => {
      const future = new Date(Date.now() + 5000).toUTCString();
      const result = classify(
        { status: 429, message: 'slow down', headers: { 'retry-after': future } },
        'anthropic'
      );
      expect(result.retryAfterMs).toBeGreaterThan(4000);
      expect(result.retryAfterMs).toBeLessThanOrEqual(5000);
    });

    it('missing retry-after header → retryAfterMs undefined', () => {
      const result = classify({ status: 429, message: 'slow down' }, 'anthropic');
      expect(result.retryAfterMs).toBeUndefined();
    });

    it('non-429 statuses never carry retryAfterMs, even if a header is present', () => {
      const result = classify(
        { status: 500, message: 'oops', headers: { 'retry-after': '2' } },
        'anthropic'
      );
      expect(result.retryAfterMs).toBeUndefined();
    });
  });

  describe('abort/timeout (no HTTP status)', () => {
    it('AbortError by .name → retryable, timeout: true', () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      const result = classify(err, 'anthropic');
      expect(result.kind).toBe('retryable');
      expect(result.status).toBeUndefined();
      // Task 10: distinguishable from an ordinary connection-level abort —
      // see registry.ts's execute(), which raises its own timeout
      // ProviderError with the same flag before this path is ever reached
      // for a budget-driven timeout; this covers the case where a raw
      // abort/timeout signal reaches classify() directly.
      expect(result.timeout).toBe(true);
    });
  });

  describe('node system error codes (checked via .code, never message text)', () => {
    it.each(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN'])(
      '%s → retryable',
      (code) => {
        const err = Object.assign(new Error(`connect ${code} 127.0.0.1:443`), { code });
        const result = classify(err, 'local');
        expect(result.kind).toBe('retryable');
      }
    );

    it('detects the code one level into .cause (fetch-wrapped socket errors)', () => {
      const causeErr = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      const err = new Error('fetch failed', { cause: causeErr });
      const result = classify(err, 'local');
      expect(result.kind).toBe('retryable');
    });

    it('an unrecognized code (e.g. ENOTFOUND) falls through to the conservative retryable default', () => {
      const err = Object.assign(new Error('getaddrinfo ENOTFOUND example.invalid'), {
        code: 'ENOTFOUND',
      });
      const result = classify(err, 'local');
      expect(result.kind).toBe('retryable');
    });
  });

  describe('Anthropic SDK error classes', () => {
    it('RateLimitError (429) → rate_limited', () => {
      const err = Anthropic.APIError.generate(429, {}, 'Rate limited', {});
      const result = classify(err, 'anthropic');
      expect(result.kind).toBe('rate_limited');
      expect(result.status).toBe(429);
    });

    it('InternalServerError (5xx) → retryable', () => {
      const err = Anthropic.APIError.generate(529, {}, 'Overloaded', {});
      const result = classify(err, 'anthropic');
      expect(result.kind).toBe('retryable');
    });

    it('BadRequestError (400) → non_retryable', () => {
      const err = Anthropic.APIError.generate(400, {}, 'Bad request', {});
      const result = classify(err, 'anthropic');
      expect(result.kind).toBe('non_retryable');
    });

    it('APIConnectionError (no status — network failure) → retryable', () => {
      const err = new Anthropic.APIConnectionError({ message: 'Connection error.' });
      const result = classify(err, 'anthropic');
      expect(result.kind).toBe('retryable');
      expect(result.status).toBeUndefined();
    });

    it('APIConnectionTimeoutError (no status — client timeout) → retryable', () => {
      const err = new Anthropic.APIConnectionTimeoutError();
      const result = classify(err, 'anthropic');
      expect(result.kind).toBe('retryable');
    });

    it('APIUserAbortError (no status) → retryable', () => {
      const err = new Anthropic.APIUserAbortError();
      const result = classify(err, 'anthropic');
      expect(result.kind).toBe('retryable');
    });
  });

  describe('OpenAI SDK error classes (also used by the openai-compatible provider for local/Ollama endpoints)', () => {
    it('RateLimitError (429) → rate_limited', () => {
      const err = OpenAI.APIError.generate(429, {}, 'Rate limited', {});
      const result = classify(err, 'openai');
      expect(result.kind).toBe('rate_limited');
    });

    it('InternalServerError (5xx) → retryable', () => {
      const err = OpenAI.APIError.generate(503, {}, 'Service unavailable', {});
      const result = classify(err, 'local');
      expect(result.kind).toBe('retryable');
    });

    it('BadRequestError (400) → non_retryable', () => {
      const err = OpenAI.APIError.generate(400, {}, 'Bad request', {});
      const result = classify(err, 'local');
      expect(result.kind).toBe('non_retryable');
    });

    it('APIConnectionError (no status) → retryable', () => {
      const err = new OpenAI.APIConnectionError({ message: 'Connection error.' });
      const result = classify(err, 'local');
      expect(result.kind).toBe('retryable');
    });
  });

  describe('unknown/unrecognized shapes', () => {
    it('a plain Error with no status/code → retryable (conservative default)', () => {
      const result = classify(new Error('something went sideways'), 'anthropic');
      expect(result.kind).toBe('retryable');
    });

    it('a non-Error thrown value (string) → retryable, with a sane message', () => {
      const result = classify('oops', 'anthropic');
      expect(result.kind).toBe('retryable');
      expect(result.message).toBe('oops');
    });

    it('a non-Error thrown value (undefined) → retryable, with a fallback message', () => {
      const result = classify(undefined, 'anthropic');
      expect(result.kind).toBe('retryable');
      expect(result.message).toBe('Unknown provider error');
    });
  });

  describe('idempotent passthrough', () => {
    it('classifying an already-classified ProviderError returns the same instance unchanged', () => {
      const original = classify({ status: 400 }, 'anthropic');
      const reclassified = classify(original, 'some-other-provider');
      expect(reclassified).toBe(original);
      expect(reclassified.kind).toBe('non_retryable');
      expect(reclassified.provider).toBe('anthropic');
    });
  });

  describe('ProviderError shape', () => {
    it('is an Error with name "ProviderError" and preserves the original error as .cause', () => {
      const original = new Error('boom');
      const result = classify(original, 'anthropic');
      expect(result).toBeInstanceOf(Error);
      expect(result.name).toBe('ProviderError');
      expect(result.cause).toBe(original);
    });
  });
});
