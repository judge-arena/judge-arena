import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { requireAuth, isAdmin } from '@/lib/auth-guard';
import { generateSlug } from '@/lib/config';

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

// GET /api/rubrics — only own rubrics (admin sees all)
export async function GET() {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  try {
    const where = isAdmin(session) ? undefined : { userId: session.user.id };

    const rubrics = await prisma.rubric.findMany({
      where,
      include: {
        criteria: { orderBy: { order: 'asc' } },
        user: { select: { id: true, name: true, email: true } },
        _count: { select: { evaluations: true, evaluationRuns: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return NextResponse.json(rubrics);
  } catch (error) {
    console.error('Failed to fetch rubrics:', error);
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
    console.error('Failed to create rubric:', error);
    return NextResponse.json(
      { error: 'Failed to create rubric' },
      { status: 500 }
    );
  }
}
