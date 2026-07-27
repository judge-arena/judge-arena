import { NextResponse } from 'next/server';

/**
 * DEPRECATED — use POST /api/evaluations/[id]/runs/[runId]/human-judgment instead.
 *
 * Human judgments are now tied to individual EvaluationRun records.
 * This endpoint is kept as a 410 Gone stub.
 */
export async function POST(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  return NextResponse.json(
    {
      error: 'This endpoint has been replaced.',
      message: `Use POST /api/evaluations/${params.id}/runs/[runId]/human-judgment to submit a human judgment for a specific run.`,
    },
    { status: 410 }
  );
}


