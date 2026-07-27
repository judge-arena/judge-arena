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
 */

import { NextResponse } from 'next/server';

/**
 * Add security headers to the response.
 */
function addSecurityHeaders(response: NextResponse): NextResponse {
  // Content Security Policy
  response.headers.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      process.env.NODE_ENV === 'production'
        ? "script-src 'self' 'unsafe-inline'"
        : "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      `connect-src 'self' https://huggingface.co https://datasets-server.huggingface.co https://api.anthropic.com https://api.openai.com${process.env.RAILWAY_PUBLIC_DOMAIN ? ` https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : ''}`,
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ')
  );

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

export function middleware() {
  // ── Add request ID header for correlation ──
  const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const response = NextResponse.next();
  response.headers.set('X-Request-Id', requestId);

  // ── Add security headers ──
  addSecurityHeaders(response);

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
