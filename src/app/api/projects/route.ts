import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { requireAuth, isAdmin } from '@/lib/auth-guard';

const createProjectSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  description: z.string().max(2000).optional(),
  rubricId: z.string().optional(),
});

// GET /api/projects - List projects visible to the current user
export async function GET() {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  try {
    const where = isAdmin(session) ? undefined : { userId: session.user.id };

    const projects = await prisma.project.findMany({
      where,
      include: {
        rubric: {
          include: { criteria: { orderBy: { order: 'asc' } } },
        },
        user: { select: { id: true, name: true, email: true } },
        _count: { select: { evaluations: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return NextResponse.json(projects);
  } catch (error) {
    console.error('Failed to fetch projects:', error);
    return NextResponse.json(
      { error: 'Failed to fetch projects' },
      { status: 500 }
    );
  }
}

// POST /api/projects - Create a new project
export async function POST(request: Request) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  try {
    const body = await request.json();
    const data = createProjectSchema.parse(body);

    const project = await prisma.project.create({
      data: {
        name: data.name,
        description: data.description,
        rubricId: data.rubricId || null,
        userId: session.user.id,
      },
      include: {
        rubric: {
          include: { criteria: { orderBy: { order: 'asc' } } },
        },
        user: { select: { id: true, name: true, email: true } },
        _count: { select: { evaluations: true } },
      },
    });

    return NextResponse.json(project, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', details: error.errors },
        { status: 400 }
      );
    }
    console.error('Failed to create project:', error);
    return NextResponse.json(
      { error: 'Failed to create project' },
      { status: 500 }
    );
  }
}
