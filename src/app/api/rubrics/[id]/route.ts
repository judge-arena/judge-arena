import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { requireAuth, requireScope, optionalAuth, resolveResourceAccess, requireOwnership, RateLimitedError } from '@/lib/auth-guard';
import { logger, serializeError } from '@/lib/logger';
import { toPublicRubric } from '@/lib/serializers';

const updateRubricSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  criteria: z
    .array(
      z.object({
        id: z.string().optional(), // existing criterion
        name: z.string().min(1),
        description: z.string().min(1),
        maxScore: z.number().int().min(1).max(100).default(10),
        weight: z.number().min(0).max(10).default(1),
        order: z.number().int().min(0).default(0),
      })
    )
    .optional(),
});

// GET /api/rubrics/[id] — public if visibility: 'public', else owner/admin
// only. Access matrix: tests/db/access-matrix.test.ts.
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;

  try {
    const session = await optionalAuth();
    if (session) {
      const scopeCheck = requireScope(session, 'rubrics:read');
      if (scopeCheck) return scopeCheck;
    }

    const rubric = await prisma.rubric.findUnique({
      where: { id: params.id },
      include: {
        criteria: { orderBy: { order: 'asc' } },
        user: { select: { id: true, name: true, email: true } },
        _count: { select: { evaluations: true, evaluationRuns: true } },
      },
    });

    if (!rubric) {
      return NextResponse.json({ error: 'Rubric not found' }, { status: 404 });
    }

    const decision = resolveResourceAccess(session, rubric.userId, rubric.visibility === 'public');
    if ('error' in decision) return decision.error;

    return NextResponse.json(decision.access === 'owner' ? rubric : toPublicRubric(rubric));
  } catch (error) {
    if (error instanceof RateLimitedError) return error.response;
    logger.error('Failed to fetch rubric', { error: serializeError(error) });
    return NextResponse.json(
      { error: 'Failed to fetch rubric' },
      { status: 500 }
    );
  }
}

// PATCH /api/rubrics/[id]
export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'rubrics:write');
  if (scopeCheck) return scopeCheck;

  try {
    const ownershipError = await requireOwnership('rubric', params.id, session);
    if (ownershipError) return ownershipError;

    const body = await request.json();
    const data = updateRubricSchema.parse(body);

    // Atomic: delete old criteria + update rubric with new criteria in one transaction
    const rubric = await prisma.$transaction(async (tx) => {
      if (data.criteria) {
        await tx.rubricCriterion.deleteMany({
          where: { rubricId: params.id },
        });
      }

      return tx.rubric.update({
        where: { id: params.id },
        data: {
          ...(data.name && { name: data.name }),
          ...(data.description !== undefined && { description: data.description }),
          ...(data.criteria && {
            criteria: {
              create: data.criteria.map((c, i) => ({
                name: c.name,
                description: c.description,
                maxScore: c.maxScore,
                weight: c.weight,
                order: c.order ?? i,
              })),
            },
          }),
        },
        include: {
          criteria: { orderBy: { order: 'asc' } },
        },
      });
    });

    return NextResponse.json(rubric);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', details: error.errors },
        { status: 400 }
      );
    }
    logger.error('Failed to update rubric', { error: serializeError(error) });
    return NextResponse.json(
      { error: 'Failed to update rubric' },
      { status: 500 }
    );
  }
}

// DELETE /api/rubrics/[id]
export async function DELETE(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'rubrics:write');
  if (scopeCheck) return scopeCheck;

  try {
    const ownershipError = await requireOwnership('rubric', params.id, session);
    if (ownershipError) return ownershipError;

    await prisma.rubric.delete({ where: { id: params.id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('Failed to delete rubric', { error: serializeError(error) });
    return NextResponse.json(
      { error: 'Failed to delete rubric' },
      { status: 500 }
    );
  }
}
