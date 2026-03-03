import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { requireAuth, isAdmin } from '@/lib/auth-guard';
import { generateSlug } from '@/lib/config';

const createModelSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  provider: z.enum(['anthropic', 'openai', 'local']),
  modelId: z.string().min(1, 'Model ID is required'),
  endpoint: z.string().url().optional().or(z.literal('')),
  apiKey: z.string().optional(),
  isActive: z.boolean().default(true),
});

// GET /api/models — own models only (admin sees all)
export async function GET() {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  try {
    const where = isAdmin(session) ? undefined : { userId: session.user.id };

    const models = await prisma.modelConfig.findMany({
      where,
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      include: { user: { select: { id: true, name: true, email: true } } },
    });

    // Don't send API keys to the client
    const sanitized = models.map((m: any) => ({
      ...m,
      apiKey: undefined,
      hasApiKey: !!m.apiKey,
    }));

    return NextResponse.json(sanitized);
  } catch (error) {
    console.error('Failed to fetch models:', error);
    return NextResponse.json(
      { error: 'Failed to fetch models' },
      { status: 500 }
    );
  }
}

// POST /api/models
export async function POST(request: Request) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  try {
    const body = await request.json();
    const data = createModelSchema.parse(body);

    // Auto-generate slug for config portability
    const slug = generateSlug(data.name);
    const existingSlugs = (await prisma.modelConfig.findMany({
      where: { userId: session.user.id },
      select: { slug: true },
    })).map((m) => m.slug).filter(Boolean) as string[];
    const uniqueSlug = existingSlugs.includes(slug)
      ? `${slug}-${Date.now().toString(36).slice(-4)}`
      : slug;

    const model = await prisma.modelConfig.create({
      data: {
        name: data.name,
        slug: uniqueSlug,
        provider: data.provider,
        modelId: data.modelId,
        endpoint: data.endpoint || null,
        apiKey: data.apiKey || null,
        isActive: data.isActive,
        isVerified: false,
        verifiedAt: null,
        verificationError: 'Not tested yet',
        userId: session.user.id,
      },
    });

    return NextResponse.json(
      { ...model, apiKey: undefined, hasApiKey: !!model.apiKey },
      { status: 201 }
    );
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
            'Foreign key constraint failed. Invalid relation reference while creating model.',
        },
        { status: 400 }
      );
    }
    console.error('Failed to create model:', error);
    return NextResponse.json(
      { error: 'Failed to create model' },
      { status: 500 }
    );
  }
}
