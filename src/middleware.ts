/**
 * ─── Next.js Middleware ───────────────────────────────────────────────────
 *
 * Centralized request interceptor for:
 * 1. Security headers (CSP, HSTS, X-Frame-Options, etc.)
 * 2. Rate limiting on auth endpoints
 * 3. Request logging with correlation IDs
 *
 * Auth enforcement is handled per-route by requireAuth() since middleware
 * runs in the Edge runtime and cannot access Prisma directly.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/** Simple in-memory rate limiter for Edge runtime (middleware) */
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(key: string, maxRequests: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(key);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (entry.count >= maxRequests) {
    return false;
  }

  entry.count++;
  return true;
}

// Periodic cleanup (runs on each request, checks lazily)
let lastCleanup = Date.now();
function cleanupRateLimits() {
  const now = Date.now();
  if (now - lastCleanup < 60000) return; // Cleanup every 60s
  lastCleanup = now;
  for (const [key, entry] of rateLimitMap.entries()) {
    if (now > entry.resetAt) {
      rateLimitMap.delete(key);
    }
  }
}

/**
 * Extract client IP safely.
 * Only trusts X-Forwarded-For / X-Real-IP when TRUSTED_PROXY is set,
 * indicating the app runs behind a reverse proxy that overwrites these headers.
 * Without a trusted proxy, uses Next.js's built-in IP (from the socket) to
 * prevent clients from spoofing their IP to bypass rate limits.
 */
function getClientIp(request: NextRequest): string {
  const trustProxy = process.env.TRUSTED_PROXY === 'true';

  if (trustProxy) {
    const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    if (forwarded) return forwarded;

    const realIp = request.headers.get('x-real-ip');
    if (realIp) return realIp;
  }

  // Next.js provides the socket IP via request.ip in Edge runtime
  return request.ip ?? '127.0.0.1';
}

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
      "connect-src 'self' https://huggingface.co https://datasets-server.huggingface.co https://api.anthropic.com https://api.openai.com",
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

export function middleware(request: NextRequest) {
  cleanupRateLimits();

  const { pathname } = request.nextUrl;
  const clientIp = getClientIp(request);

  // ── Rate limit auth endpoints (5/min per IP) ──
  if (
    pathname.startsWith('/api/auth/register') ||
    pathname.startsWith('/api/auth/callback')
  ) {
    const allowed = checkRateLimit(`auth:${clientIp}`, 5, 60 * 1000);
    if (!allowed) {
      return new NextResponse(
        JSON.stringify({ error: 'Too many requests. Please try again later.' }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '60',
          },
        }
      );
    }
  }

  // ── Rate limit general API endpoints (120/min per IP) ──
  if (pathname.startsWith('/api/') && !pathname.startsWith('/api/auth/')) {
    const allowed = checkRateLimit(`api:${clientIp}`, 120, 60 * 1000);
    if (!allowed) {
      return new NextResponse(
        JSON.stringify({ error: 'Rate limit exceeded. Please slow down.' }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '60',
          },
        }
      );
    }
  }

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
