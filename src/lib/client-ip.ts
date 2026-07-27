/**
 * ─── Client IP resolution ─────────────────────────────────────────────────
 *
 * Single shared implementation used by every rate limiter call site
 * (register route, evaluation run launches, HuggingFace dataset routes, and
 * the `requireAuth()` chokepoint in `auth-guard.ts`).
 */

/**
 * Structural subset of the DOM `Headers` interface. Deliberately narrower
 * than `Request` — `next/headers()`'s `ReadonlyHeaders` (returned by
 * `await headers()`) implements the same `.get()` method but isn't a
 * `Request`, and `auth-guard.ts`'s `requireAuth()` — the shared `api`
 * limiter chokepoint — only has access to that, not a `Request` object,
 * since it's called with no arguments from ~30 route handlers with no
 * consistent request parameter to thread through. Route handlers that do
 * have a `Request` just pass `request.headers`, which also satisfies this.
 */
export interface HeaderReader {
  get(name: string): string | null;
}

/**
 * Resolve the client IP for rate limiting, honoring `TRUSTED_PROXY`.
 *
 * - `TRUSTED_PROXY=true`: trust `X-Forwarded-For` (falling back to
 *   `X-Real-IP`). Assumption: exactly ONE trusted reverse proxy sits in
 *   front of the app (this app's deployed topologies — docker-compose's
 *   `app` service behind a proxy, or Railway — both put a single hop in
 *   front), and that hop appends the original client IP as the FIRST entry
 *   before forwarding (`client, proxy1[, proxy2...]`), so we take the
 *   leftmost entry. This is a simplification of "take the rightmost entry
 *   not added by a trusted hop": correct for exactly one trusted proxy, but
 *   would need a trusted-hop *count* (not just a boolean) to stay correct
 *   behind a chain of multiple trusted proxies, since each additional
 *   trusted hop shifts which entry is the real client.
 * - Otherwise: never trust client-supplied headers — a client could set
 *   `X-Forwarded-For` itself to spoof another IP and dodge rate limits —
 *   and fall back to the `127.0.0.1` sentinel. `NextRequest.ip` was only
 *   ever populated on Vercel's edge network (never for this app's
 *   self-hosted Docker/Node deployment) and was removed from the type
 *   entirely in Next.js 15, so there's no real per-connection IP available
 *   to fall back to here.
 */
export function getClientIp(headers: HeaderReader): string {
  const trustProxy = process.env.TRUSTED_PROXY === 'true';

  if (trustProxy) {
    const forwarded = headers.get('x-forwarded-for');
    const first = forwarded?.split(',')[0]?.trim();
    if (first) return first;

    const realIp = headers.get('x-real-ip');
    if (realIp) return realIp;
  }

  return '127.0.0.1';
}
