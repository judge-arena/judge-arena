import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { requireAuth, requireScope, isAdmin, optionalAuth, resolveResourceAccess } from '@/lib/auth-guard';
import { logger, serializeError } from '@/lib/logger';
import { createRubricVersion, RubricVersionConflictError } from '@/lib/rubric-versions';

const criterionSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  maxScore: z.number().int().min(1).max(100).default(10),
  weight: z.number().min(0).max(10).default(1),
  order: z.number().int().min(0).optional(),
});

const newVersionSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  criteria: z.array(criterionSchema).min(1, 'At least one criterion is required'),
});

// GET /api/rubrics/[id]/versions — same visibility rule as GET
// /api/rubrics/[id]: public if the rubric is visibility: 'public', else
// owner/admin only. This sub-resource carries no user/email join, so
// there's no separate serializer step — the gate below IS the whole fix.
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await optionalAuth();

  try {
    const rubric = await prisma.rubric.findUnique({ where: { id: params.id } });
    if (!rubric) {
      return NextResponse.json({ error: 'Rubric not found' }, { status: 404 });
    }

    const decision = resolveResourceAccess(session, rubric.userId, rubric.visibility === 'public');
    if ('error' in decision) return decision.error;

    const rootId = rubric.parentId ?? rubric.id;

    const versions = await prisma.rubric.findMany({
      where: { OR: [{ id: rootId }, { parentId: rootId }] },
      include: { criteria: { orderBy: { order: 'asc' } } },
      orderBy: { version: 'asc' },
    });

    return NextResponse.json(versions);
  } catch (error) {
    logger.error('Failed to fetch rubric versions', { error: serializeError(error) });
    return NextResponse.json(
      { error: 'Failed to fetch rubric versions' },
      { status: 500 }
    );
  }
}

// POST /api/rubrics/[id]/versions
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'rubrics:write');
  if (scopeCheck) return scopeCheck;

  try {
    const rubric = await prisma.rubric.findUnique({ where: { id: params.id } });
    if (!rubric) {
      return NextResponse.json({ error: 'Rubric not found' }, { status: 404 });
    }

    if (rubric.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const data = newVersionSchema.parse(body);

    const rootId = rubric.parentId ?? rubric.id;

    const newRubric = await createRubricVersion(prisma, {
      rootRubricId: rootId,
      userId: session.user.id,
      name: data.name ?? rubric.name,
      description: data.description !== undefined ? data.description : rubric.description,
      criteria: data.criteria,
    });

    return NextResponse.json(newRubric, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', details: error.errors },
        { status: 400 }
      );
    }
    if (error instanceof RubricVersionConflictError) {
      logger.error('Rubric version conflict exhausted retries', {
        error: serializeError(error),
      });
      return NextResponse.json(
        {
          error:
            'Failed to create rubric version due to concurrent updates. Please try again.',
        },
        { status: 500 }
      );
    }
    logger.error('Failed to create rubric version', { error: serializeError(error) });
    return NextResponse.json(
      { error: 'Failed to create rubric version' },
      { status: 500 }
    );
  }
}
