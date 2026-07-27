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

  // ── Lifecycle state shared between the stream's `start()` and `cancel()`
  // (both need to reach the same `cleanup()`, so this lives outside the
  // ReadableStream's underlying-source object rather than nested in
  // `start`) ──────────────────────────────────────────────────────────────
  let cleanedUp = false;
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  const unsubscribes: Array<() => void> = [];

  // Idempotent — guarded by `cleanedUp` so it's safe to call from any of:
  // the abort listener, `cancel()`, the subscribe-failure catch below, or a
  // late subscribeTopic() resolution racing an earlier cleanup (see the
  // subscribe loop). Also safe to call before any subscription exists:
  // `unsubscribes` is only ever appended to *after* a given subscribeTopic()
  // call actually resolves, so it always reflects exactly what's live.
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    for (const unsubscribe of unsubscribes) unsubscribe();
    try {
      streamController?.close();
    } catch {
      // Already closed.
    }
  };

  // Registered BEFORE the ReadableStream (and therefore before any of the
  // replayTopicSince()/subscribeTopic() awaits inside it) is even
  // constructed. A client can disconnect at any point — including while
  // those calls are in flight, which is the common case for an EventSource
  // recreated on fast navigation — and if the listener weren't registered
  // until after those awaits, that abort would fire with nothing listening:
  // cleanup() would never run, leaking a listener entry in the
  // process-wide realtime bus singleton plus an orphaned Redis SUBSCRIBE
  // with no consumer. Registering first (and re-checking `aborted` below
  // and after each await) closes that race.
  request.signal.addEventListener('abort', cleanup, { once: true });
  if (request.signal.aborted) cleanup();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      streamController = controller;
      const encoder = new TextEncoder();

      const push = (chunk: string) => {
        if (cleanedUp) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Controller already closed (client disconnect race) — ignore.
        }
      };

      const emit = (event: RealtimeEnvelope) => {
        push(encodeSseChunk(event.type, event.payload, event.id));
      };

      // Already aborted before start() even ran (e.g. cleanup() fired
      // above from a pre-aborted signal) — nothing left to do.
      if (cleanedUp) return;

      push(
        encodeSseChunk('ready', {
          ok: true,
          run: runId ?? null,
          ts: new Date().toISOString(),
        })
      );

      try {
        // Replay missed events BEFORE live subscription (a reconnect with
        // Last-Event-ID only). Events published in the gap between the
        // replay snapshot and live subscription becoming active are
        // silently missed, not duplicated or double-delivered — that's the
        // accepted tradeoff (see module docstring / task brief); closing it
        // would mean subscribing first and buffering live events until the
        // replay snapshot catches up, which is out of scope here.
        if (lastEventId) {
          for (const topic of topics) {
            // eslint-disable-next-line no-await-in-loop -- topics is at most 2 (user + run); ordering (replay-before-live per topic) matters more than parallelism here.
            const missed = await replayTopicSince(topic, lastEventId);
            if (cleanedUp) return; // aborted/cancelled mid-replay
            for (const event of missed) emit(event);
          }
        }

        for (const topic of topics) {
          // eslint-disable-next-line no-await-in-loop -- see above.
          const unsubscribe = await subscribeTopic(topic, emit);
          if (cleanedUp) {
            // cleanup() already ran (abort or cancel) while this
            // subscribeTopic() call was still in flight, so it never saw
            // this subscription and — being idempotent — won't run again
            // to catch it. Tear it down directly rather than leaking a
            // live Redis SUBSCRIBE with no consumer.
            unsubscribe();
            return;
          }
          unsubscribes.push(unsubscribe);
        }
      } catch (error) {
        console.error('Realtime SSE: failed to establish subscription:', error);
        push(
          encodeSseChunk('error', {
            message: 'Realtime subscription is currently unavailable.',
          })
        );
        cleanup();
        return;
      }

      if (cleanedUp) return; // aborted/cancelled between subscribe and keep-alive setup

      keepAliveTimer = setInterval(() => {
        push(`: keep-alive ${Date.now()}\n\n`);
      }, KEEP_ALIVE_MS);
    },
    cancel() {
      // Backstop for consumer-side cancellation that doesn't surface as a
      // `request.signal` abort (e.g. the platform tearing down the
      // ReadableStream directly) — routes to the same idempotent cleanup.
      cleanup();
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
