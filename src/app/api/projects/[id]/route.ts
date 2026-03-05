import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { requireAuth, requireScope, isAdmin } from '@/lib/auth-guard';

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
  const scopeCheck = requireScope(session, 'projects:read');
  if (scopeCheck) return scopeCheck;

  try {
    const project = await prisma.project.findUnique({
      where: { id: params.id },
      include: {
        user: { select: { id: true, name: true, email: true } },
        evaluations: {
          include: {
            dataset: {
              select: {
                id: true,
                name: true,
              },
            },
            datasetSample: {
              select: {
                id: true,
                index: true,
              },
            },
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
            // Include latest run + run count so project page can group dataset batches
            runs: {
              select: {
                id: true,
                status: true,
                createdAt: true,
                modelJudgments: {
                  select: {
                    status: true,
                    overallScore: true,
                  },
                },
                humanJudgment: {
                  select: {
                    overallScore: true,
                  },
                },
              },
              orderBy: { createdAt: 'desc' },
              take: 1,
            },
            _count: {
              select: {
                runs: true,
              },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
        _count: { select: { evaluations: true } },
        datasets: {
          select: {
            id: true,
            name: true,
            source: true,
            visibility: true,
            sampleCount: true,
            huggingFaceId: true,
          },
          orderBy: { updatedAt: 'desc' },
        },
      },
    });

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    // Ownership check: owner, admin, or default (Leaderboard) projects are visible to all
    if (
      project.userId !== session.user.id &&
      !isAdmin(session) &&
      !(project as any).isDefault
    ) {
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
  const scopeCheck = requireScope(session, 'projects:write');
  if (scopeCheck) return scopeCheck;

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
  const scopeCheck = requireScope(session, 'projects:write');
  if (scopeCheck) return scopeCheck;

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
