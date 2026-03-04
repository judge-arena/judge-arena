import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { requireAuth, requireScope, isAdmin } from '@/lib/auth-guard';
import { generateSlug } from '@/lib/config';

// POST /api/datasets/[id]/versions — create a new version from the current dataset
export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'datasets:write');
  if (scopeCheck) return scopeCheck;

  try {
    const existing = await prisma.dataset.findUnique({
      where: { id: params.id },
      include: {
        samples: { orderBy: { index: 'asc' } },
      },
    });

    if (!existing) {
      return NextResponse.json(
        { error: 'Dataset not found' },
        { status: 404 }
      );
    }

    if (existing.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Find the root dataset (original) for this version chain
    const rootId = existing.parentId ?? existing.id;

    // Find the highest version number in this chain
    const allVersions = await prisma.dataset.findMany({
      where: {
        OR: [
          { id: rootId },
          { parentId: rootId },
        ],
      },
      select: { version: true },
      orderBy: { version: 'desc' },
    });
    const nextVersion = (allVersions[0]?.version ?? 1) + 1;

    // Optionally accept modified samples with the new version
    let newSamples = existing.samples;
    try {
      const body = await request.json();
      const schema = z.object({
        samples: z.array(z.object({
          input: z.string().min(1),
          expected: z.string().optional().nullable(),
          metadata: z.string().optional().nullable(),
        })).optional(),
      });
      const data = schema.parse(body);
      if (data.samples) {
        newSamples = data.samples.map((s, i) => ({
          id: '',
          datasetId: '',
          index: i,
          input: s.input,
          expected: s.expected ?? null,
          metadata: s.metadata ?? null,
          createdAt: new Date(),
        }));
      }
    } catch {
      // No body or invalid body — duplicate existing samples as-is
    }

    // Generate a unique slug for version
    const baseSlug = generateSlug(existing.name);
    const versionSlug = `${baseSlug}-v${nextVersion}`;
    const existingSlugs = (await prisma.dataset.findMany({
      where: { userId: session.user.id },
      select: { slug: true },
    })).map((d) => d.slug).filter(Boolean) as string[];
    const uniqueSlug = existingSlugs.includes(versionSlug)
      ? `${versionSlug}-${Date.now().toString(36).slice(-4)}`
      : versionSlug;

    const newVersion = await prisma.dataset.create({
      data: {
        name: existing.name,
        slug: uniqueSlug,
        description: existing.description,
        source: existing.source,
        visibility: existing.visibility,
        inputType: existing.inputType,
        version: nextVersion,
        parentId: rootId,
        sourceUrl: existing.sourceUrl,
        huggingFaceId: existing.huggingFaceId,
        remoteMetadata: existing.remoteMetadata,
        format: existing.format,
        localData: existing.localData,
        sampleCount: newSamples.length,
        splits: existing.splits,
        features: existing.features,
        tags: existing.tags,
        projectId: existing.projectId,
        userId: session.user.id,
        samples: {
          create: newSamples.map((s, i) => ({
            index: i,
            input: s.input,
            expected: s.expected,
            metadata: s.metadata,
          })),
        },
      },
      include: {
        user: { select: { id: true, name: true, email: true } },
        project: { select: { id: true, name: true } },
        samples: { orderBy: { index: 'asc' } },
        _count: { select: { samples: true } },
      },
    });

    return NextResponse.json(newVersion, { status: 201 });
  } catch (error) {
    console.error('Failed to create dataset version:', error);
    return NextResponse.json(
      { error: 'Failed to create dataset version' },
      { status: 500 }
    );
  }
}

// GET /api/datasets/[id]/versions — list all versions of a dataset
export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  try {
    const dataset = await prisma.dataset.findUnique({
      where: { id: params.id },
      select: { id: true, parentId: true, userId: true, visibility: true },
    });

    if (!dataset) {
      return NextResponse.json(
        { error: 'Dataset not found' },
        { status: 404 }
      );
    }

    if (
      dataset.userId !== session.user.id &&
      !isAdmin(session) &&
      dataset.visibility !== 'public'
    ) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Find the root
    const rootId = dataset.parentId ?? dataset.id;

    const versions = await prisma.dataset.findMany({
      where: {
        OR: [
          { id: rootId },
          { parentId: rootId },
        ],
      },
      select: {
        id: true,
        version: true,
        sampleCount: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { samples: true } },
      },
      orderBy: { version: 'desc' },
    });

    return NextResponse.json(versions);
  } catch (error) {
    console.error('Failed to list dataset versions:', error);
    return NextResponse.json(
      { error: 'Failed to list versions' },
      { status: 500 }
    );
  }
}
