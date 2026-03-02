import { NextResponse } from 'next/server';

/**
 * DEPRECATED — use POST /api/evaluations/[id]/runs instead.
 *
 * Model judgments are now tied to individual EvaluationRun records, not directly
 * to the Evaluation template.  This endpoint is kept as a 410 Gone stub so that
 * any lingering client references fail with a clear error rather than a 404.
 */
export async function POST(
  _request: Request,
  { params }: { params: { id: string } }
) {
  return NextResponse.json(
    {
      error: 'This endpoint has been replaced.',
      message: `Use POST /api/evaluations/${params.id}/runs to create a new evaluation run.`,
    },
    { status: 410 }
  );
}

