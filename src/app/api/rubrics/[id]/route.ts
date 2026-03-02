import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { requireAuth, isAdmin } from '@/lib/auth-guard';

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

// GET /api/rubrics/[id]
export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  try {
    const rubric = await prisma.rubric.findUnique({
      where: { id: params.id },
      include: {
        criteria: { orderBy: { order: 'asc' } },
        user: { select: { id: true, name: true, email: true } },
        _count: { select: { projects: true } },
      },
    });

    if (!rubric) {
      return NextResponse.json({ error: 'Rubric not found' }, { status: 404 });
    }

    if (rubric.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    return NextResponse.json(rubric);
  } catch (error) {
    console.error('Failed to fetch rubric:', error);
    return NextResponse.json(
      { error: 'Failed to fetch rubric' },
      { status: 500 }
    );
  }
}

// PATCH /api/rubrics/[id]
export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  try {
    const existing = await prisma.rubric.findUnique({ where: { id: params.id }, select: { userId: true } });
    if (!existing) return NextResponse.json({ error: 'Rubric not found' }, { status: 404 });
    if (existing.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const data = updateRubricSchema.parse(body);

    // If criteria are provided, replace all criteria
    if (data.criteria) {
      await prisma.rubricCriterion.deleteMany({
        where: { rubricId: params.id },
      });
    }

    const rubric = await prisma.rubric.update({
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

    return NextResponse.json(rubric);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', details: error.errors },
        { status: 400 }
      );
    }
    console.error('Failed to update rubric:', error);
    return NextResponse.json(
      { error: 'Failed to update rubric' },
      { status: 500 }
    );
  }
}

// DELETE /api/rubrics/[id]
export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  try {
    const existing = await prisma.rubric.findUnique({ where: { id: params.id }, select: { userId: true } });
    if (!existing) return NextResponse.json({ error: 'Rubric not found' }, { status: 404 });
    if (existing.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    await prisma.rubric.delete({ where: { id: params.id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete rubric:', error);
    return NextResponse.json(
      { error: 'Failed to delete rubric' },
      { status: 500 }
    );
  }
}
