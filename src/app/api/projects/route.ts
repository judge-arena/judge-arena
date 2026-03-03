import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { requireAuth, isAdmin } from '@/lib/auth-guard';
import { generateSlug } from '@/lib/config';

const createProjectSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  description: z.string().max(2000).optional(),
});

// GET /api/projects - List projects visible to the current user
export async function GET() {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  try {
    // Admins see all; regular users see their own plus default (Leaderboard) projects
    const where = isAdmin(session)
      ? undefined
      : { OR: [{ userId: session.user.id }, { isDefault: true }] };

    const projects = await prisma.project.findMany({
      where,
      include: {
        user: { select: { id: true, name: true, email: true } },
        _count: { select: { evaluations: true } },
      },
      orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
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

    // Auto-generate slug for config portability
    const slug = generateSlug(data.name);
    const existingSlugs = (await prisma.project.findMany({
      where: { userId: session.user.id },
      select: { slug: true },
    })).map((p) => p.slug).filter(Boolean) as string[];
    const uniqueSlug = existingSlugs.includes(slug)
      ? `${slug}-${Date.now().toString(36).slice(-4)}`
      : slug;

    const project = await prisma.project.create({
      data: {
        name: data.name,
        slug: uniqueSlug,
        description: data.description,
        userId: session.user.id,
      },
      include: {
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
