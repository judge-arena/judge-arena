import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { requireAuth, isAdmin } from '@/lib/auth-guard';

const addSamplesSchema = z.object({
  samples: z.array(z.object({
    input: z.string().min(1),
    expected: z.string().optional().nullable(),
    metadata: z.record(z.unknown()).optional(),
  })).min(1),
});

const updateSampleSchema = z.object({
  sampleId: z.string(),
  input: z.string().min(1).optional(),
  expected: z.string().optional().nullable(),
  metadata: z.record(z.unknown()).optional().nullable(),
});

const deleteSamplesSchema = z.object({
  sampleIds: z.array(z.string()).min(1),
});

const bulkReplaceSamplesSchema = z.object({
  samples: z.array(z.object({
    input: z.string().min(1),
    expected: z.string().optional().nullable(),
    metadata: z.record(z.unknown()).optional(),
  })),
});

// POST /api/datasets/[id]/samples — add new samples to the dataset
export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  try {
    const dataset = await prisma.dataset.findUnique({
      where: { id: params.id },
      select: { userId: true, _count: { select: { samples: true } } },
    });

    if (!dataset) {
      return NextResponse.json({ error: 'Dataset not found' }, { status: 404 });
    }
    if (dataset.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const data = addSamplesSchema.parse(body);

    const startIndex = dataset._count.samples;
    const created = await prisma.$transaction(
      data.samples.map((s, i) =>
        prisma.datasetSample.create({
          data: {
            datasetId: params.id,
            index: startIndex + i,
            input: s.input,
            expected: s.expected ?? undefined,
            metadata: s.metadata ? JSON.stringify(s.metadata) : undefined,
          },
        })
      )
    );

    // Update sample count
    await prisma.dataset.update({
      where: { id: params.id },
      data: { sampleCount: startIndex + data.samples.length },
    });

    return NextResponse.json({ added: created.length, samples: created }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', details: error.errors },
        { status: 400 }
      );
    }
    console.error('Failed to add samples:', error);
    return NextResponse.json(
      { error: 'Failed to add samples' },
      { status: 500 }
    );
  }
}

// PATCH /api/datasets/[id]/samples — update a single sample
export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  try {
    const dataset = await prisma.dataset.findUnique({
      where: { id: params.id },
      select: { userId: true },
    });

    if (!dataset) {
      return NextResponse.json({ error: 'Dataset not found' }, { status: 404 });
    }
    if (dataset.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const data = updateSampleSchema.parse(body);

    // Verify the sample belongs to this dataset
    const sample = await prisma.datasetSample.findUnique({
      where: { id: data.sampleId },
      select: { datasetId: true },
    });

    if (!sample || sample.datasetId !== params.id) {
      return NextResponse.json({ error: 'Sample not found in this dataset' }, { status: 404 });
    }

    const updateData: Record<string, unknown> = {};
    if (data.input !== undefined) updateData.input = data.input;
    if (data.expected !== undefined) updateData.expected = data.expected;
    if (data.metadata !== undefined) {
      updateData.metadata = data.metadata ? JSON.stringify(data.metadata) : null;
    }

    const updated = await prisma.datasetSample.update({
      where: { id: data.sampleId },
      data: updateData,
    });

    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', details: error.errors },
        { status: 400 }
      );
    }
    console.error('Failed to update sample:', error);
    return NextResponse.json(
      { error: 'Failed to update sample' },
      { status: 500 }
    );
  }
}

// DELETE /api/datasets/[id]/samples — delete samples by ID
export async function DELETE(
  request: Request,
  { params }: { params: { id: string } }
) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  try {
    const dataset = await prisma.dataset.findUnique({
      where: { id: params.id },
      select: { userId: true },
    });

    if (!dataset) {
      return NextResponse.json({ error: 'Dataset not found' }, { status: 404 });
    }
    if (dataset.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const data = deleteSamplesSchema.parse(body);

    // Verify all samples belong to this dataset
    const samples = await prisma.datasetSample.findMany({
      where: { id: { in: data.sampleIds }, datasetId: params.id },
      select: { id: true },
    });

    if (samples.length !== data.sampleIds.length) {
      return NextResponse.json(
        { error: 'Some samples not found in this dataset' },
        { status: 400 }
      );
    }

    await prisma.datasetSample.deleteMany({
      where: { id: { in: data.sampleIds }, datasetId: params.id },
    });

    // Re-index remaining samples
    const remaining = await prisma.datasetSample.findMany({
      where: { datasetId: params.id },
      orderBy: { index: 'asc' },
      select: { id: true },
    });

    if (remaining.length > 0) {
      await prisma.$transaction(
        remaining.map((s, i) =>
          prisma.datasetSample.update({
            where: { id: s.id },
            data: { index: i },
          })
        )
      );
    }

    await prisma.dataset.update({
      where: { id: params.id },
      data: { sampleCount: remaining.length },
    });

    return NextResponse.json({ deleted: data.sampleIds.length, remaining: remaining.length });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', details: error.errors },
        { status: 400 }
      );
    }
    console.error('Failed to delete samples:', error);
    return NextResponse.json(
      { error: 'Failed to delete samples' },
      { status: 500 }
    );
  }
}

// PUT /api/datasets/[id]/samples — bulk replace all samples (used by revert)
export async function PUT(
  request: Request,
  { params }: { params: { id: string } }
) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  try {
    const dataset = await prisma.dataset.findUnique({
      where: { id: params.id },
      select: { userId: true },
    });

    if (!dataset) {
      return NextResponse.json({ error: 'Dataset not found' }, { status: 404 });
    }
    if (dataset.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const data = bulkReplaceSamplesSchema.parse(body);

    // Delete all existing samples
    await prisma.datasetSample.deleteMany({
      where: { datasetId: params.id },
    });

    // Create new samples
    if (data.samples.length > 0) {
      await prisma.$transaction(
        data.samples.map((s, i) =>
          prisma.datasetSample.create({
            data: {
              datasetId: params.id,
              index: i,
              input: s.input,
              expected: s.expected ?? undefined,
              metadata: s.metadata ? JSON.stringify(s.metadata) : undefined,
            },
          })
        )
      );
    }

    await prisma.dataset.update({
      where: { id: params.id },
      data: { sampleCount: data.samples.length },
    });

    const newSamples = await prisma.datasetSample.findMany({
      where: { datasetId: params.id },
      orderBy: { index: 'asc' },
    });

    return NextResponse.json({ replaced: newSamples.length, samples: newSamples });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', details: error.errors },
        { status: 400 }
      );
    }
    console.error('Failed to replace samples:', error);
    return NextResponse.json(
      { error: 'Failed to replace samples' },
      { status: 500 }
    );
  }
}
