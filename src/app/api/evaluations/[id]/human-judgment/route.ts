import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';

const humanJudgmentSchema = z.object({
  overallScore: z.number().min(0).max(10),
  reasoning: z.string().max(5000).optional(),
  criteriaScores: z
    .array(
      z.object({
        criterionId: z.string(),
        criterionName: z.string(),
        score: z.number().min(0),
        maxScore: z.number(),
        weight: z.number(),
        comment: z.string().optional(),
      })
    )
    .optional(),
  selectedBestModelId: z.string().optional(),
});

/**
 * POST /api/evaluations/[id]/human-judgment
 *
 * Submit or update the human judgment for an evaluation.
 */
export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const body = await request.json();
    const data = humanJudgmentSchema.parse(body);

    // Verify evaluation exists
    const evaluation = await prisma.evaluation.findUnique({
      where: { id: params.id },
    });

    if (!evaluation) {
      return NextResponse.json(
        { error: 'Evaluation not found' },
        { status: 404 }
      );
    }

    // Upsert human judgment
    const judgment = await prisma.humanJudgment.upsert({
      where: { evaluationId: params.id },
      update: {
        overallScore: data.overallScore,
        reasoning: data.reasoning,
        criteriaScores: data.criteriaScores
          ? JSON.stringify(data.criteriaScores)
          : null,
        selectedBestModelId: data.selectedBestModelId,
      },
      create: {
        evaluationId: params.id,
        overallScore: data.overallScore,
        reasoning: data.reasoning,
        criteriaScores: data.criteriaScores
          ? JSON.stringify(data.criteriaScores)
          : null,
        selectedBestModelId: data.selectedBestModelId,
      },
    });

    // Update evaluation status to completed
    await prisma.evaluation.update({
      where: { id: params.id },
      data: { status: 'completed' },
    });

    return NextResponse.json(judgment);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', details: error.errors },
        { status: 400 }
      );
    }
    console.error('Failed to save human judgment:', error);
    return NextResponse.json(
      { error: 'Failed to save human judgment' },
      { status: 500 }
    );
  }
}
