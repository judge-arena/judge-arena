import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';

const criterionSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  maxScore: z.number().int().min(1).max(100).default(10),
  weight: z.number().min(0).max(10).default(1),
  order: z.number().int().min(0).optional(),
});

const newVersionSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  criteria: z.array(criterionSchema).min(1, 'At least one criterion is required'),
});

// GET /api/rubrics/[id]/versions
// Returns all versions in the same rubric family, sorted by version asc
export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const rubric = await prisma.rubric.findUnique({ where: { id: params.id } });
    if (!rubric) {
      return NextResponse.json({ error: 'Rubric not found' }, { status: 404 });
    }

    const rootId = rubric.parentId ?? rubric.id;

    const versions = await prisma.rubric.findMany({
      where: { OR: [{ id: rootId }, { parentId: rootId }] },
      include: { criteria: { orderBy: { order: 'asc' } } },
      orderBy: { version: 'asc' },
    });

    return NextResponse.json(versions);
  } catch (error) {
    console.error('Failed to fetch rubric versions:', error);
    return NextResponse.json(
      { error: 'Failed to fetch rubric versions' },
      { status: 500 }
    );
  }
}

// POST /api/rubrics/[id]/versions
// Creates a new version branching from the rubric family identified by [id]
export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const rubric = await prisma.rubric.findUnique({ where: { id: params.id } });
    if (!rubric) {
      return NextResponse.json({ error: 'Rubric not found' }, { status: 404 });
    }

    const body = await request.json();
    const data = newVersionSchema.parse(body);

    // Always anchor to the family root (v1)
    const rootId = rubric.parentId ?? rubric.id;

    // Find the highest version in this family
    const familyVersions = await prisma.rubric.findMany({
      where: { OR: [{ id: rootId }, { parentId: rootId }] },
      select: { version: true },
      orderBy: { version: 'desc' },
    });

    const nextVersion = (familyVersions[0]?.version ?? 0) + 1;

    const newRubric = await prisma.rubric.create({
      data: {
        name: data.name ?? rubric.name,
        description:
          data.description !== undefined ? data.description : rubric.description,
        version: nextVersion,
        parentId: rootId,
        criteria: {
          create: data.criteria.map((c, i) => ({
            name: c.name,
            description: c.description,
            maxScore: c.maxScore,
            weight: c.weight,
            order: c.order ?? i,
          })),
        },
      },
      include: { criteria: { orderBy: { order: 'asc' } } },
    });

    return NextResponse.json(newRubric, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', details: error.errors },
        { status: 400 }
      );
    }
    console.error('Failed to create rubric version:', error);
    return NextResponse.json(
      { error: 'Failed to create rubric version' },
      { status: 500 }
    );
  }
}
