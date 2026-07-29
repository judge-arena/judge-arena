import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { requireAuth, requireScope, optionalAuth, resolveResourceAccess, requireOwnership } from '@/lib/auth-guard';
import { logger, serializeError } from '@/lib/logger';
import { toPublicProject } from '@/lib/serializers';

const updateProjectSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
});

// GET /api/projects/[id] — public if visibility: 'public' or isDefault
// (the Leaderboard project predates the Visibility enum), else owner/admin
// only. The public view is metadata-only (src/lib/serializers.ts's
// toPublicProject): evaluations are user-created data (spec §7 D3 — never
// part of the public-visibility set, regardless of the parent project's
// visibility) and are only ever returned to the project's owner/admin, the
// same as the owner's email on every other public serializer in this file.
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await optionalAuth();
  if (session) {
    const scopeCheck = requireScope(session, 'projects:read');
    if (scopeCheck) return scopeCheck;
  }

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

    const isPublic = project.visibility === 'public' || project.isDefault;
    const decision = resolveResourceAccess(session, project.userId, isPublic);
    if ('error' in decision) return decision.error;

    if (decision.access === 'owner') {
      return NextResponse.json(project);
    }

    return NextResponse.json({
      ...toPublicProject(project),
      // Only datasets that are THEMSELVES public — this select set
      // (id/name/source/visibility/sampleCount/huggingFaceId) already
      // carries no user join, so no further stripping is needed.
      datasets: project.datasets.filter((d) => d.visibility === 'public'),
    });
  } catch (error) {
    logger.error('Failed to fetch project', { error: serializeError(error) });
    return NextResponse.json(
      { error: 'Failed to fetch project' },
      { status: 500 }
    );
  }
}

// PATCH /api/projects/[id]
export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'projects:write');
  if (scopeCheck) return scopeCheck;

  try {
    const ownershipError = await requireOwnership('project', params.id, session);
    if (ownershipError) return ownershipError;

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
    logger.error('Failed to update project', { error: serializeError(error) });
    return NextResponse.json(
      { error: 'Failed to update project' },
      { status: 500 }
    );
  }
}

// DELETE /api/projects/[id]
export async function DELETE(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'projects:write');
  if (scopeCheck) return scopeCheck;

  try {
    const ownershipError = await requireOwnership('project', params.id, session);
    if (ownershipError) return ownershipError;

    await prisma.project.delete({ where: { id: params.id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('Failed to delete project', { error: serializeError(error) });
    return NextResponse.json(
      { error: 'Failed to delete project' },
      { status: 500 }
    );
  }
}
