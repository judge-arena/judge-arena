import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { redisHealthy } from '@/lib/redis';
import { rabbitHealthy } from '@/lib/queue/connection';
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

  // ─── Redis check ──
  // redisHealthy() never throws (500ms-bounded PING, swallows all errors
  // internally) — safe to call unconditionally, including in production
  // without REDIS_URL, where getRedis() would otherwise throw.
  const redisStart = Date.now();
  const redisUp = await redisHealthy();
  checks.redis = { status: redisUp ? 'ok' : 'error', latencyMs: Date.now() - redisStart };
  if (!redisUp) {
    logger.error('Health check: redis connectivity failed', {});
  }

  // ─── RabbitMQ check ──
  // rabbitHealthy() never throws (500ms-bounded checkExchange, swallows all
  // errors internally, including getRabbit() throwing in production without
  // RABBITMQ_URL) — safe to call unconditionally, same as redisHealthy().
  const rabbitStart = Date.now();
  const rabbitUp = await rabbitHealthy();
  checks.rabbitmq = { status: rabbitUp ? 'ok' : 'error', latencyMs: Date.now() - rabbitStart };
  if (!rabbitUp) {
    logger.error('Health check: rabbitmq connectivity failed', {});
  }

  // ─── Overall status ──
  // Redis and RabbitMQ are hard readiness gates only in production (Redis
  // backs rate limiting on every request; RabbitMQ backs judgment execution
  // end-to-end — see auth-guard.ts and src/lib/queue/**). In dev/test both
  // are optional infra: rate limiting fails open on Redis errors, and a
  // contributor running `npm run dev` without local Redis/RabbitMQ
  // containers shouldn't see a broken health endpoint over it.
  const dbHealthy = checks.database.status === 'ok';
  const allHealthy = isProd ? dbHealthy && redisUp && rabbitUp : dbHealthy;
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
