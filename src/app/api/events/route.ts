import { NextResponse } from 'next/server';
import { requireAuth, requireScope } from '@/lib/auth-guard';
import { prisma } from '@/lib/db';
import {
  replayTopicSince,
  runTopic,
  subscribeTopic,
  userTopic,
  type RealtimeEnvelope,
} from '@/lib/realtime/events';
import { userOwnsRun } from '@/lib/realtime/ownership';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KEEP_ALIVE_MS = Number(process.env.SSE_KEEP_ALIVE_MS ?? '25000');

function encodeSseChunk(event: string, data: unknown, id?: string): string {
  const lines: string[] = [];
  if (id) lines.push(`id: ${id}`);
  lines.push(`event: ${event}`);
  lines.push(`data: ${JSON.stringify(data)}`);
  return `${lines.join('\n')}\n\n`;
}

/**
 * GET /api/events[?run={runId}]
 *
 * Every connection subscribes to the caller's own `user:{self}` topic —
 * this is the only topic any authenticated user gets for free. Passing
 * `?run={id}` additionally subscribes `run:{id}`, but only after verifying
 * the session user owns that run (triggered it themselves, or owns the
 * run's evaluation's project) — otherwise 403. Prior to this endpoint's v2
 * rewrite, every authenticated user received every event regardless of
 * ownership; that is the bug this scoping fixes.
 *
 * Supports resume via the standard SSE `Last-Event-ID` header: missed
 * events on each subscribed topic are replayed (via each topic's Redis
 * Stream) before live delivery resumes. See src/lib/realtime/redis-bus.ts.
 */
export async function GET(request: Request) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'evaluations:read');
  if (scopeCheck) return scopeCheck;

  const { searchParams } = new URL(request.url);
  const runId = searchParams.get('run');
  const lastEventId = request.headers.get('last-event-id');

  const topics = [userTopic(session.user.id)];

  if (runId) {
    const run = await prisma.evaluationRun.findUnique({
      where: { id: runId },
      select: {
        triggeredById: true,
        evaluation: { select: { project: { select: { userId: true } } } },
      },
    });

    if (!run) {
      return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }

    if (!userOwnsRun(session.user.id, run)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    topics.push(runTopic(runId));
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let closed = false;

      const push = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Controller already closed (client disconnect race) — ignore.
        }
      };

      const emit = (event: RealtimeEnvelope) => {
        push(encodeSseChunk(event.type, event.payload, event.id));
      };

      push(
        encodeSseChunk('ready', {
          ok: true,
          run: runId ?? null,
          ts: new Date().toISOString(),
        })
      );

      const unsubscribes: Array<() => void> = [];

      try {
        // Replay missed events BEFORE live subscription (a reconnect with
        // Last-Event-ID only). A tiny overlap window between "replay
        // snapshot" and "live subscription active" is accepted — see
        // module docstring / task brief; client-side dedupe by id is out
        // of scope.
        if (lastEventId) {
          for (const topic of topics) {
            // eslint-disable-next-line no-await-in-loop -- topics is at most 2 (user + run); ordering (replay-before-live per topic) matters more than parallelism here.
            const missed = await replayTopicSince(topic, lastEventId);
            for (const event of missed) emit(event);
          }
        }

        for (const topic of topics) {
          // eslint-disable-next-line no-await-in-loop -- see above.
          const unsubscribe = await subscribeTopic(topic, emit);
          unsubscribes.push(unsubscribe);
        }
      } catch (error) {
        console.error('Realtime SSE: failed to establish subscription:', error);
        push(
          encodeSseChunk('error', {
            message: 'Realtime subscription is currently unavailable.',
          })
        );
        for (const unsubscribe of unsubscribes) unsubscribe();
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed.
        }
        return;
      }

      const keepAliveTimer = setInterval(() => {
        push(`: keep-alive ${Date.now()}\n\n`);
      }, KEEP_ALIVE_MS);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepAliveTimer);
        for (const unsubscribe of unsubscribes) unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };

      request.signal.addEventListener('abort', cleanup, { once: true });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
