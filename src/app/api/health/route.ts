import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { logger, serializeError } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const isProd = process.env.NODE_ENV === 'production';

/**
 * GET /api/health
 *
 * Health check endpoint for Docker HEALTHCHECK, load balancers, and uptime monitors.
 * Returns 200 if the service is healthy, 503 if any dependency is down.
 *
 * No authentication required — this is an infrastructure endpoint.
 * In production, error details are redacted to avoid leaking internals.
 */
export async function GET() {
  const startTime = Date.now();

  const checks: Record<string, { status: 'ok' | 'error'; latencyMs?: number; error?: string }> = {};

  // ─── Database check ──
  try {
    const dbStart = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    checks.database = { status: 'ok', latencyMs: Date.now() - dbStart };
  } catch (error) {
    logger.error('Health check: database connectivity failed', serializeError(error));
    checks.database = {
      status: 'error',
      // Never expose raw DB errors (connection strings, host info) to clients
      error: isProd ? 'unavailable' : (error instanceof Error ? error.message : 'Database connection failed'),
    };
  }

  // ─── Overall status ──
  const allHealthy = Object.values(checks).every((c) => c.status === 'ok');
  const totalLatency = Date.now() - startTime;

  const body = {
    status: allHealthy ? 'healthy' : 'degraded',
    version: process.env.npm_package_version ?? '1.0.0',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    latencyMs: totalLatency,
    checks,
  };

  return NextResponse.json(body, {
    status: allHealthy ? 200 : 503,
    headers: {
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
  });
}
