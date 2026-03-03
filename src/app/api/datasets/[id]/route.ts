import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { requireAuth, isAdmin } from '@/lib/auth-guard';

const updateDatasetSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).optional(),
  visibility: z.enum(['private', 'public']).optional(),
  inputType: z.enum(['query', 'query-response']).optional(),
  projectId: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
});

// GET /api/datasets/[id] - Get a single dataset with samples
export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  try {
    const dataset = await prisma.dataset.findUnique({
      where: { id: params.id },
      include: {
        user: { select: { id: true, name: true, email: true } },
        project: { select: { id: true, name: true } },
        samples: {
          orderBy: { index: 'asc' },
          take: 100,
        },
        versions: {
          select: { id: true, version: true, createdAt: true, sampleCount: true },
          orderBy: { version: 'desc' },
        },
        parent: {
          select: { id: true, version: true },
        },
        _count: { select: { samples: true } },
      },
    });

    if (!dataset) {
      return NextResponse.json(
        { error: 'Dataset not found' },
        { status: 404 }
      );
    }

    // Visibility check: owner, admin, or public
    if (
      dataset.userId !== session.user.id &&
      !isAdmin(session) &&
      dataset.visibility !== 'public'
    ) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    return NextResponse.json(dataset);
  } catch (error) {
    console.error('Failed to fetch dataset:', error);
    return NextResponse.json(
      { error: 'Failed to fetch dataset' },
      { status: 500 }
    );
  }
}

// PATCH /api/datasets/[id] - Update a dataset
export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  try {
    const existing = await prisma.dataset.findUnique({
      where: { id: params.id },
      select: { userId: true },
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

    const body = await request.json();
    const data = updateDatasetSchema.parse(body);

    const updateData: any = { ...data };
    if (data.tags) {
      updateData.tags = JSON.stringify(data.tags);
      delete updateData.tags;
      updateData.tags = JSON.stringify(data.tags);
    }

    const dataset = await prisma.dataset.update({
      where: { id: params.id },
      data: updateData,
      include: {
        user: { select: { id: true, name: true, email: true } },
        project: { select: { id: true, name: true } },
        _count: { select: { samples: true } },
      },
    });

    return NextResponse.json(dataset);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', details: error.errors },
        { status: 400 }
      );
    }
    console.error('Failed to update dataset:', error);
    return NextResponse.json(
      { error: 'Failed to update dataset' },
      { status: 500 }
    );
  }
}

// DELETE /api/datasets/[id]
export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  try {
    const existing = await prisma.dataset.findUnique({
      where: { id: params.id },
      select: { userId: true },
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

    await prisma.dataset.delete({ where: { id: params.id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete dataset:', error);
    return NextResponse.json(
      { error: 'Failed to delete dataset' },
      { status: 500 }
    );
  }
}
