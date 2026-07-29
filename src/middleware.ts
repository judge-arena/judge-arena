/**
 * ─── Next.js Middleware ───────────────────────────────────────────────────
 *
 * Centralized request interceptor for:
 * 1. Security headers (CSP, HSTS, X-Frame-Options, etc.)
 * 2. Request logging with correlation IDs
 *
 * Rate limiting does NOT live here. Edge middleware can't hold a Redis
 * connection, so the in-memory `Map`-based limiter that used to run here
 * has been deleted — it only ever protected a single replica's in-process
 * state and did nothing for a second instance. Rate limiting now happens in
 * route handlers (and the shared `requireAuth()` chokepoint in
 * `src/lib/auth-guard.ts`) via the Redis-backed limiter in
 * `src/lib/rate-limit-redis.ts`, which enforces one shared budget across
 * every replica.
 *
 * Auth enforcement is handled per-route by requireAuth() since middleware
 * runs in the Edge runtime and cannot access Prisma directly.
 *
 * ── CSP script-src nonce (Task 14) ──────────────────────────────────────
 * A fresh nonce is generated per request and threaded through TWO places,
 * following the official Next.js 15 App Router pattern
 * (https://nextjs.org/docs/app/guides/content-security-policy):
 *   1. The `Content-Security-Policy` RESPONSE header — the browser's
 *      enforcement copy.
 *   2. An `x-nonce` REQUEST header (set via `NextResponse.next({ request:
 *      { headers } })`, not just the response) — Next.js's App Router
 *      SSR pipeline extracts the nonce from the *request's*
 *      Content-Security-Policy-shaped value using the `'nonce-{value}'`
 *      pattern and automatically stamps it onto every framework script it
 *      injects (React/Next runtime chunks, page bundles, `next/script`
 *      tags that pass a `nonce` prop) — see src/app/layout.tsx for the one
 *      place this app reads `x-nonce` explicitly (next-themes' inline
 *      FOUC-prevention script, the only non-framework inline script in
 *      this app).
 * Reading `x-nonce` (or any `next/headers` API) inside a Server Component
 * forces that subtree into DYNAMIC rendering — nonces are meaningless on a
 * page prerendered at build time (no per-request value exists then). This
 * app already renders every route dynamically today (every page reads
 * `useSession()`/hits Prisma-backed API routes at request time; there is
 * no `generateStaticParams`/ISR anywhere in `src/app/**`), so this isn't a
 * new performance tradeoff — see CONTRIBUTING.md's CSP section.
 *
 * `'unsafe-inline'` is dropped from `script-src` in production (the T14
 * critique's "CSP allows unsafe-inline" finding) — the nonce is the sole
 * allowlist mechanism for scripts there. `style-src 'unsafe-inline'` is
 * KEPT deliberately: several components use inline `style={{...}}`
 * attributes (CSP's `style-src` governs the `style` attribute, not just
 * `<style>` tags) and Tailwind ships no CSS-in-JS `<style>` injection to
 * nonce instead — see CONTRIBUTING.md for the full writeup of what was
 * checked.
 */

import { NextRequest, NextResponse } from 'next/server';

/** Base64-encoded random nonce, one per request — Buffer is available in
 * the Node middleware runtime this app already requires (Prisma via
 * requireAuth() means routes can't run on the Edge runtime anyway; see
 * next.config.js's `serverExternalPackages`). */
function generateNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString('base64');
}

/** Build the CSP header value for this request's nonce. */
function buildCsp(nonce: string): string {
  const isProd = process.env.NODE_ENV === 'production';
  return [
    "default-src 'self'",
    // 'unsafe-eval' stays dev-only (React Fast Refresh / webpack HMR need
    // it); nonce-gated in both envs so a same-origin XSS still can't smuggle
    // in an arbitrary inline <script>.
    isProd ? `script-src 'self' 'nonce-${nonce}'` : `script-src 'self' 'nonce-${nonce}' 'unsafe-eval'`,
    // Kept 'unsafe-inline' — see the module doc above for why (inline
    // `style={{}}` attributes throughout src/**, no CSS-in-JS `<style>`
    // injection to nonce instead of allowlisting).
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self' https://huggingface.co https://datasets-server.huggingface.co https://api.anthropic.com https://api.openai.com${process.env.RAILWAY_PUBLIC_DOMAIN ? ` https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : ''}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

/**
 * Add security headers to the response.
 */
function addSecurityHeaders(response: NextResponse, csp: string): NextResponse {
  response.headers.set('Content-Security-Policy', csp);

  // Prevent clickjacking
  response.headers.set('X-Frame-Options', 'DENY');

  // Prevent MIME type sniffing
  response.headers.set('X-Content-Type-Options', 'nosniff');

  // Control referrer information
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Permissions Policy (restrict browser features)
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=()'
  );

  // HSTS (only in production with HTTPS)
  if (process.env.NODE_ENV === 'production') {
    response.headers.set(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains; preload'
    );
  }

  return response;
}

export function middleware(request: NextRequest) {
  const nonce = generateNonce();
  const csp = buildCsp(nonce);

  // Propagate the nonce (and the CSP itself) on the REQUEST headers too —
  // this is what lets Next.js's SSR pipeline pick the nonce up and stamp
  // it onto its own framework scripts (see the module doc above).
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });

  // ── Add request ID header for correlation ──
  const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  response.headers.set('X-Request-Id', requestId);

  // ── Add security headers (the browser-enforced response copy) ──
  addSecurityHeaders(response, csp);

  return response;
}

/**
 * Configure which routes the middleware runs on.
 * Excludes static files and Next.js internals.
 */
export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public files (images, etc.)
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
