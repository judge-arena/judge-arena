import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { requireAuth, requireScope, isAdmin } from '@/lib/auth-guard';
import { generateSlug } from '@/lib/config';
import {
  fetchDatasetMetadata,
  parseHuggingFaceUrl,
} from '@/lib/huggingface';
import { parsePaginationParams, buildPrismaPageArgs, paginatedJson } from '@/lib/pagination';
import { logger } from '@/lib/logger';

const createDatasetSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  description: z.string().max(4000).optional(),
  source: z.enum(['local', 'remote']),
  visibility: z.enum(['private', 'public']),
  inputType: z.enum(['query', 'query-response']).optional().default('query-response'),
  // Remote fields
  sourceUrl: z.string().url().optional(),
  huggingFaceId: z.string().optional(),
  // Local fields
  format: z.enum(['json', 'csv', 'jsonl', 'text']).optional(),
  localData: z.string().optional(),
  // Optional project association
  projectId: z.string().optional(),
  // Inline samples for local datasets
  samples: z
    .array(
      z.object({
        input: z.string().min(1),
        expected: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
      })
    )
    .optional(),
  tags: z.array(z.string()).optional(),
});

// GET /api/datasets - List datasets visible to the current user
// Supports ?limit=N&cursor=ID for pagination
export async function GET(request: Request) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'datasets:read');
  if (scopeCheck) return scopeCheck;

  const { searchParams } = new URL(request.url);
  const source = searchParams.get('source'); // 'local' | 'remote'
  const visibility = searchParams.get('visibility'); // 'private' | 'public'
  const projectId = searchParams.get('projectId');
  const { limit, cursor } = parsePaginationParams(searchParams);
  const pageArgs = buildPrismaPageArgs({ limit, cursor });

  try {
    // Users see their own private datasets + all public datasets
    // Admins see everything
    const where: any = {};

    if (!isAdmin(session)) {
      where.OR = [
        { userId: session.user.id },
        { visibility: 'public' },
      ];
    }

    if (source) where.source = source;
    if (visibility) where.visibility = visibility;
    if (projectId) where.projectId = projectId;

    const [datasets, total] = await Promise.all([
      prisma.dataset.findMany({
        where,
        include: {
          user: { select: { id: true, name: true, email: true } },
          project: { select: { id: true, name: true } },
          _count: { select: { samples: true } },
        },
        orderBy: { updatedAt: 'desc' },
        ...pageArgs,
      }),
      prisma.dataset.count({ where }),
    ]);

    return paginatedJson(datasets, limit, total);
  } catch (error) {
    logger.error('Failed to fetch datasets', { error });
    return NextResponse.json(
      { error: 'Failed to fetch datasets' },
      { status: 500 }
    );
  }
}

// POST /api/datasets - Create a new dataset
export async function POST(request: Request) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'datasets:write');
  if (scopeCheck) return scopeCheck;

  try {
    const body = await request.json();
    const data = createDatasetSchema.parse(body);
    const sanitizedProjectId = data.projectId?.trim() || undefined;

    if (sanitizedProjectId) {
      const project = await prisma.project.findUnique({
        where: { id: sanitizedProjectId },
        select: { id: true, userId: true, isDefault: true },
      });

      if (!project) {
        return NextResponse.json(
          { error: 'Invalid projectId: project does not exist' },
          { status: 400 }
        );
      }

      const canUseProject =
        isAdmin(session) ||
        project.userId === session.user.id ||
        project.isDefault;
      if (!canUseProject) {
        return NextResponse.json(
          { error: 'Forbidden: project is not accessible' },
          { status: 403 }
        );
      }
    }

    let remoteMetadata: string | undefined;
    let sampleCount: number | undefined;
    let splits: string | undefined;
    let features: string | undefined;
    let tags = data.tags ? JSON.stringify(data.tags) : undefined;
    let huggingFaceId = data.huggingFaceId;

    // For remote datasets, try to fetch metadata from HuggingFace
    if (data.source === 'remote' && data.sourceUrl) {
      // If no huggingFaceId provided, try to parse from URL
      if (!huggingFaceId) {
        huggingFaceId = parseHuggingFaceUrl(data.sourceUrl) ?? undefined;
      }

      if (huggingFaceId) {
        try {
          const meta = await fetchDatasetMetadata(huggingFaceId);
          remoteMetadata = JSON.stringify(meta);
          sampleCount = meta.sampleCount ?? undefined;
          splits = JSON.stringify(meta.splits);
          features = JSON.stringify(meta.features);
          if (meta.tags.length > 0 && !data.tags?.length) {
            tags = JSON.stringify(meta.tags);
          }
        } catch (err) {
          console.warn(
            `Could not fetch HF metadata for ${huggingFaceId}:`,
            err
          );
          // Continue without metadata — user can retry later
        }
      }
    }

    // Auto-generate slug for config portability
    const dsSlug = generateSlug(data.name);
    const existingSlugs = (await prisma.dataset.findMany({
      where: { userId: session.user.id },
      select: { slug: true },
    })).map((d) => d.slug).filter(Boolean) as string[];
    const uniqueSlug = existingSlugs.includes(dsSlug)
      ? `${dsSlug}-${Date.now().toString(36).slice(-4)}`
      : dsSlug;

    const dataset = await prisma.dataset.create({
      data: {
        name: data.name,
        slug: uniqueSlug,
        description: data.description,
        source: data.source,
        visibility: data.visibility,
        inputType: data.inputType,
        sourceUrl: data.sourceUrl,
        huggingFaceId,
        remoteMetadata,
        format: data.format,
        localData: data.localData,
        sampleCount: data.samples?.length ?? sampleCount,
        splits,
        features,
        tags,
        projectId: sanitizedProjectId,
        userId: session.user.id,
        ...(data.samples?.length
          ? {
              samples: {
                create: data.samples.map((s, i) => ({
                  index: i,
                  input: s.input,
                  expected: s.expected,
                  metadata: s.metadata
                    ? JSON.stringify(s.metadata)
                    : undefined,
                })),
              },
            }
          : {}),
      },
      include: {
        user: { select: { id: true, name: true, email: true } },
        project: { select: { id: true, name: true } },
        _count: { select: { samples: true } },
      },
    });

    return NextResponse.json(dataset, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', details: error.errors },
        { status: 400 }
      );
    }

    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2003'
    ) {
      return NextResponse.json(
        {
          error:
            'Foreign key constraint failed. Invalid relation reference while creating dataset.',
        },
        { status: 400 }
      );
    }

    logger.error('Failed to create dataset', { error });
    return NextResponse.json(
      { error: 'Failed to create dataset' },
      { status: 500 }
    );
  }
}
