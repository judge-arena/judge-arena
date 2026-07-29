import { describe, it, expect, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';

// Unit test (no DB) — calls the real middleware() function directly
// against a constructed NextRequest, the same "drive the real handler"
// approach the DB-backed route tests use for API routes (see
// tests/db/model-endpoint-crud.test.ts's module doc). Covers Task 14's
// CSP nonce requirement: a per-request nonce present in BOTH the
// Content-Security-Policy header and the propagated x-nonce request
// header (which src/app/layout.tsx reads — see its module doc), and NO
// 'unsafe-inline' in script-src in production.

function setNodeEnv(value: string) {
  vi.stubEnv('NODE_ENV', value);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('src/middleware.ts — CSP nonce', () => {
  it('production: script-src carries a nonce and has NO unsafe-inline; style-src keeps unsafe-inline', () => {
    setNodeEnv('production');
    const res = middleware(new NextRequest('http://localhost/dashboard'));

    const csp = res.headers.get('Content-Security-Policy');
    expect(csp).toBeTruthy();

    const scriptSrc = csp!.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src'));
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
    expect(scriptSrc).not.toContain('unsafe-inline');
    expect(scriptSrc).not.toContain('unsafe-eval');

    const styleSrc = csp!.split(';').map((d) => d.trim()).find((d) => d.startsWith('style-src'));
    expect(styleSrc).toContain("'unsafe-inline'");
  });

  it('development: script-src still carries a nonce, unsafe-eval allowed (HMR), still no unsafe-inline', () => {
    setNodeEnv('development');
    const res = middleware(new NextRequest('http://localhost/dashboard'));

    const csp = res.headers.get('Content-Security-Policy');
    const scriptSrc = csp!.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src'));
    expect(scriptSrc).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
    expect(scriptSrc).toContain("'unsafe-eval'");
    expect(scriptSrc).not.toContain('unsafe-inline');
  });

  it('propagates the SAME nonce onto the request (x-nonce) that the response CSP header carries — what layout.tsx reads', () => {
    setNodeEnv('production');
    const res = middleware(new NextRequest('http://localhost/dashboard'));

    const csp = res.headers.get('Content-Security-Policy');
    const match = csp!.match(/'nonce-([A-Za-z0-9+/=]+)'/);
    expect(match).toBeTruthy();
    const cspNonce = match![1];

    // NextResponse.next({ request: { headers } }) stashes the rewritten
    // request headers on a well-known internal header
    // (`x-middleware-override-headers` + `x-middleware-request-<name>`)
    // that Next's runtime reads back out before invoking the route/page —
    // assert via that documented mechanism rather than reaching into
    // undocumented internals.
    const overrideList = res.headers.get('x-middleware-override-headers');
    expect(overrideList).toContain('x-nonce');
    expect(res.headers.get('x-middleware-request-x-nonce')).toBe(cspNonce);
  });

  it('two requests get two DIFFERENT nonces (per-request, not cached/static)', () => {
    setNodeEnv('production');
    const first = middleware(new NextRequest('http://localhost/dashboard'));
    const second = middleware(new NextRequest('http://localhost/dashboard'));

    const nonceOf = (res: ReturnType<typeof middleware>) =>
      res.headers.get('Content-Security-Policy')!.match(/'nonce-([A-Za-z0-9+/=]+)'/)![1];

    expect(nonceOf(first)).not.toBe(nonceOf(second));
  });

  it('still sets the other existing security headers (no regression)', () => {
    setNodeEnv('production');
    const res = middleware(new NextRequest('http://localhost/dashboard'));

    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('Strict-Transport-Security')).toContain('max-age=31536000');
    expect(res.headers.get('X-Request-Id')).toMatch(/^req_/);
  });
});
