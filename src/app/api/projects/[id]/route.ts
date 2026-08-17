import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { requireAuth, requireScope, optionalAuth, resolveResourceAccess, requireOwnership, RateLimitedError } from '@/lib/auth-guard';
import { logger, serializeError } from '@/lib/logger';
import { toPublicProject } from '@/lib/serializers';
import { liveDatasetsOnly, liveSamplesOnly } from '@/lib/tombstones';

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
//
// Access is resolved from a CHEAP projection FIRST (id/userId/visibility/
// isDefault/name/description/publishedAt/_count — no evaluations at all),
// and the expensive nested include (evaluations -> runs -> modelJudgments/
// humanJudgment, every evaluation author's email) only ever runs on the
// OWNER/admin branch below. Before this, the heavy query ran for EVERY
// caller — including anonymous ones on this now-public route — and got
// thrown away on the public branch: an anonymous-amplification vector
// (T14 follow-up finding) on a route anyone can now hit with no auth.
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;

  try {
    const session = await optionalAuth();
    if (session) {
      const scopeCheck = requireScope(session, 'projects:read');
      if (scopeCheck) return scopeCheck;
    }

    const projectMeta = await prisma.project.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        userId: true,
        visibility: true,
        isDefault: true,
        name: true,
        slug: true,
        description: true,
        publishedAt: true,
        createdAt: true,
        updatedAt: true,
        user: { select: { id: true, name: true } },
        _count: { select: { evaluations: true } },
      },
    });

    if (!projectMeta) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const isPublic = projectMeta.visibility === 'public' || projectMeta.isDefault;
    const decision = resolveResourceAccess(session, projectMeta.userId, isPublic);
    if ('error' in decision) return decision.error;

    if (decision.access === 'public') {
      // Public/anonymous path: the cheap projection above IS the full
      // response (via toPublicProject) — no evaluations query, no
      // author-email join, ever. Only datasets that are THEMSELVES
      // public, filtered in the DB rather than fetched-then-discarded.
      const publicDatasets = await prisma.dataset.findMany({
        // A1, read 1 of 3 IN THIS FILE. Its twin is the owner's nested
        // `datasets:` select in the heavy query below. Both filter or
        // neither does — a hidden dataset that still shows on the owner's
        // own project page is the failure this pairing exists to prevent.
        where: { projectId: projectMeta.id, visibility: 'public', ...liveDatasetsOnly() },
        select: {
          id: true,
          name: true,
          source: true,
          visibility: true,
          sampleCount: true,
          huggingFaceId: true,
        },
        orderBy: { updatedAt: 'desc' },
      });

      return NextResponse.json({
        ...toPublicProject(projectMeta),
        datasets: publicDatasets,
      });
    }

    // Owner/admin path — full heavy query, unchanged from before this fix.
    const project = await prisma.project.findUnique({
      where: { id: params.id },
      include: {
        user: { select: { id: true, name: true, email: true } },
        evaluations: {
          include: {
            // A1, read 2 of 3 IN THIS FILE. The other two are
            // `dataset.findMany` calls that take `liveDatasetsOnly()` directly;
            // these are nested to-ONE relation args, but OPTIONAL ones, so they
            // take the same filters in the same place — restoring the `null`
            // that `Evaluation.datasetId`'s `onDelete: SetNull` produced before
            // the overlay.
            //
            // The project page groups these into dataset batches
            // (src/lib/dataset-run-groups.ts) keyed on the SCALAR `datasetId`,
            // which is left populated, so grouping is unaffected; the group's
            // display name falls back from `dataset.name` to the project's own
            // `datasets:` list below (already filtered) and then to
            // `Dataset ${datasetId}`.
            dataset: {
              where: liveDatasetsOnly(),
              select: {
                id: true,
                name: true,
              },
            },
            datasetSample: {
              where: liveSamplesOnly(),
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
          // A1, read 3 of 3 IN THIS FILE — the OWNER's copy of the same
          // list. A `dataset.findMany` grep does NOT surface this line; it
          // is a nested relation arg. See the anonymous read above.
          where: liveDatasetsOnly(),
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
      // Vanishingly unlikely (deleted between the cheap and heavy
      // queries) — same 404 shape as the cheap-path check above.
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    return NextResponse.json(project);
  } catch (error) {
    if (error instanceof RateLimitedError) return error.response;
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
