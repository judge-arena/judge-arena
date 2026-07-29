import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { requireAuth, requireScope, isAdmin, optionalAuth } from '@/lib/auth-guard';
import { generateSlug } from '@/lib/config';
import { logger, serializeError } from '@/lib/logger';
import { toPublicRubric } from '@/lib/serializers';

const criterionSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  maxScore: z.number().int().min(1).max(100).default(10),
  weight: z.number().min(0).max(10).default(1),
  order: z.number().int().min(0).default(0),
});

const createRubricSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  description: z.string().max(2000).optional(),
  criteria: z.array(criterionSchema).min(1, 'At least one criterion is required'),
});

// GET /api/rubrics — public (visibility: public) rubrics + the caller's own
// (admin sees all). Anonymous callers see only public rubrics. Access
// matrix: tests/db/access-matrix.test.ts.
export async function GET() {
  const session = await optionalAuth();
  if (session) {
    const scopeCheck = requireScope(session, 'rubrics:read');
    if (scopeCheck) return scopeCheck;
  }

  try {
    const where = !session
      ? { visibility: 'public' as const }
      : isAdmin(session)
        ? undefined
        : { OR: [{ userId: session.user.id }, { visibility: 'public' as const }] };

    const rubrics = await prisma.rubric.findMany({
      where,
      include: {
        criteria: { orderBy: { order: 'asc' } },
        user: { select: { id: true, name: true, email: true } },
        _count: { select: { evaluations: true, evaluationRuns: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    // Own (or, for an admin, every) rubric gets the full shape; a public
    // rubric the caller doesn't own is PII-stripped (src/lib/serializers.ts)
    // — never leaks another user's email in this list.
    const isOwnerOrAdmin = (r: { userId: string }) =>
      !!session && (session.user.id === r.userId || isAdmin(session));
    const body = rubrics.map((r) => (isOwnerOrAdmin(r) ? r : toPublicRubric(r)));

    return NextResponse.json(body);
  } catch (error) {
    logger.error('Failed to fetch rubrics', { error: serializeError(error) });
    return NextResponse.json(
      { error: 'Failed to fetch rubrics' },
      { status: 500 }
    );
  }
}

// POST /api/rubrics
export async function POST(request: Request) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'rubrics:write');
  if (scopeCheck) return scopeCheck;

  try {
    const body = await request.json();
    const data = createRubricSchema.parse(body);

    // Auto-generate slug for config portability
    const slug = generateSlug(data.name);
    const existingSlugs = (await prisma.rubric.findMany({
      where: { userId: session.user.id },
      select: { slug: true },
    })).map((r) => r.slug).filter(Boolean) as string[];
    const uniqueSlug = existingSlugs.includes(slug)
      ? `${slug}-${Date.now().toString(36).slice(-4)}`
      : slug;

    const rubric = await prisma.rubric.create({
      data: {
        name: data.name,
        slug: uniqueSlug,
        description: data.description,
        userId: session.user.id,
        criteria: {
          create: data.criteria.map((c, i) => ({
            ...c,
            order: c.order ?? i,
          })),
        },
      },
      include: {
        criteria: { orderBy: { order: 'asc' } },
      },
    });

    return NextResponse.json(rubric, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', details: error.errors },
        { status: 400 }
      );
    }
    logger.error('Failed to create rubric', { error: serializeError(error) });
    return NextResponse.json(
      { error: 'Failed to create rubric' },
      { status: 500 }
    );
  }
}
