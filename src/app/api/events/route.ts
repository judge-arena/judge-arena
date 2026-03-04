import { NextResponse } from 'next/server';
import { requireAuth, requireScope } from '@/lib/auth-guard';
import {
  subscribeRealtime,
  type RealtimeEnvelope,
  type RealtimeTopic,
} from '@/lib/realtime/events';

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

export async function GET(request: Request) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'evaluations:read');
  if (scopeCheck) return scopeCheck;

  const { searchParams } = new URL(request.url);
  const topic = searchParams.get('topic') as RealtimeTopic | null;
  const datasetId = searchParams.get('datasetId');

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();

      const push = (chunk: string) => {
        controller.enqueue(encoder.encode(chunk));
      };

      push(
        encodeSseChunk('ready', {
          ok: true,
          topic: topic ?? 'all',
          datasetId: datasetId ?? null,
          ts: new Date().toISOString(),
        })
      );

      const unsubscribe = subscribeRealtime((event: RealtimeEnvelope) => {
        if (topic && event.topic !== topic) return;

        if (
          datasetId &&
          event.type === 'dataset.summary.updated' &&
          event.payload.datasetId !== datasetId
        ) {
          return;
        }

        push(encodeSseChunk(event.type, event.payload, event.id));
      });

      const keepAliveTimer = setInterval(() => {
        push(`: keep-alive ${Date.now()}\n\n`);
      }, KEEP_ALIVE_MS);

      const abortHandler = () => {
        clearInterval(keepAliveTimer);
        unsubscribe();
        controller.close();
      };

      request.signal.addEventListener('abort', abortHandler, { once: true });
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
