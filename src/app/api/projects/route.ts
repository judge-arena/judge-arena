import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { requireAuth, requireScope, isAdmin, optionalAuth } from '@/lib/auth-guard';
import { generateSlug } from '@/lib/config';
import { parsePaginationParams, buildPrismaPageArgs, paginatedJson } from '@/lib/pagination';
import { logger } from '@/lib/logger';
import { toPublicProject } from '@/lib/serializers';

const createProjectSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  description: z.string().max(2000).optional(),
});

// GET /api/projects - List projects visible to the current user. Anonymous
// callers see only public (visibility: 'public' OR isDefault — the
// Leaderboard project predates the Visibility enum and is public by
// definition) projects; authed non-admins additionally see their own.
// Admins see all. Supports ?limit=N&cursor=ID for pagination.
export async function GET(request: Request) {
  const session = await optionalAuth();
  if (session) {
    const scopeCheck = requireScope(session, 'projects:read');
    if (scopeCheck) return scopeCheck;
  }

  try {
    const { searchParams } = new URL(request.url);
    const { limit, cursor } = parsePaginationParams(searchParams);
    const pageArgs = buildPrismaPageArgs({ limit, cursor });

    // Admins see all; authed non-admins see their own plus public/default
    // projects; anonymous callers see ONLY public/default projects.
    const where = !session
      ? { OR: [{ visibility: 'public' as const }, { isDefault: true }] }
      : isAdmin(session)
        ? undefined
        : { OR: [{ userId: session.user.id }, { visibility: 'public' as const }, { isDefault: true }] };

    const [projects, total] = await Promise.all([
      prisma.project.findMany({
        where,
        include: {
          user: { select: { id: true, name: true, email: true } },
          _count: { select: { evaluations: true } },
        },
        orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
        ...pageArgs,
      }),
      prisma.project.count({ where }),
    ]);

    // Own (or, for an admin, every) project gets the full shape; a
    // public/default project the caller doesn't own is PII-stripped
    // (src/lib/serializers.ts).
    const isOwnerOrAdmin = (p: { userId: string }) =>
      !!session && (session.user.id === p.userId || isAdmin(session));
    const body = projects.map((p) => (isOwnerOrAdmin(p) ? p : toPublicProject(p)));

    return paginatedJson(body, limit, total);
  } catch (error) {
    logger.error('Failed to fetch projects', { error });
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
  const scopeCheck = requireScope(session, 'projects:write');
  if (scopeCheck) return scopeCheck;

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
    logger.error('Failed to create project', { error });
    return NextResponse.json(
      { error: 'Failed to create project' },
      { status: 500 }
    );
  }
}
