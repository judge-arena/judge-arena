import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { requireAuth, isAdmin } from '@/lib/auth-guard';

const updateProjectSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
});

// GET /api/projects/[id]
export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  try {
    const project = await prisma.project.findUnique({
      where: { id: params.id },
      include: {
        user: { select: { id: true, name: true, email: true } },
        evaluations: {
          include: {
            rubric: {
              select: {
                id: true,
                name: true,
                version: true,
                parentId: true,
              },
            },
            user: { select: { id: true, name: true, email: true } },
            modelSelections: {
              include: {
                modelConfig: {
                  select: {
                    id: true,
                    name: true,
                    provider: true,
                    modelId: true,
                    isActive: true,
                    isVerified: true,
                  },
                },
              },
              orderBy: { createdAt: 'asc' },
            },
            // Include run summaries so the project page can show run count + latest status
            runs: {
              select: {
                id: true,
                status: true,
                createdAt: true,
              },
              orderBy: { createdAt: 'desc' },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
        _count: { select: { evaluations: true } },
      },
    });

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    // Ownership check: only owner or admin can view
    if (project.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    return NextResponse.json(project);
  } catch (error) {
    console.error('Failed to fetch project:', error);
    return NextResponse.json(
      { error: 'Failed to fetch project' },
      { status: 500 }
    );
  }
}

// PATCH /api/projects/[id]
export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  try {
    const existing = await prisma.project.findUnique({ where: { id: params.id }, select: { userId: true } });
    if (!existing) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    if (existing.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const data = updateProjectSchema.parse(body);

    const project = await prisma.project.update({
      where: { id: params.id },
      data,
      include: {
        _count: { select: { evaluations: true } },
      },
    });

    return NextResponse.json(project);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', details: error.errors },
        { status: 400 }
      );
    }
    console.error('Failed to update project:', error);
    return NextResponse.json(
      { error: 'Failed to update project' },
      { status: 500 }
    );
  }
}

// DELETE /api/projects/[id]
export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  try {
    const existing = await prisma.project.findUnique({ where: { id: params.id }, select: { userId: true } });
    if (!existing) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    if (existing.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    await prisma.project.delete({ where: { id: params.id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete project:', error);
    return NextResponse.json(
      { error: 'Failed to delete project' },
      { status: 500 }
    );
  }
}
