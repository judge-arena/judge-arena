import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { verifyModelConnection } from '@/lib/llm/verify';
import { requireAuth, isAdmin } from '@/lib/auth-guard';

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

    try {
      await verifyModelConnection({
        provider: data.provider,
        modelId: data.modelId,
        endpoint: data.endpoint || undefined,
        apiKey: data.apiKey || undefined,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Connection test failed';
      return NextResponse.json(
        { error: `Model connection test failed: ${message}` },
        { status: 400 }
      );
    }

    const model = await prisma.modelConfig.create({
      data: {
        name: data.name,
        provider: data.provider,
        modelId: data.modelId,
        endpoint: data.endpoint || null,
        apiKey: data.apiKey || null,
        isActive: data.isActive,
        isVerified: true,
        verifiedAt: new Date(),
        verificationError: null,
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
    console.error('Failed to create model:', error);
    return NextResponse.json(
      { error: 'Failed to create model' },
      { status: 500 }
    );
  }
}
