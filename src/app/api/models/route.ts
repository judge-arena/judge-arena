import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';

const createModelSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  provider: z.enum(['anthropic', 'openai', 'local']),
  modelId: z.string().min(1, 'Model ID is required'),
  endpoint: z.string().url().optional().or(z.literal('')),
  apiKey: z.string().optional(),
  isActive: z.boolean().default(true),
});

// GET /api/models
export async function GET() {
  try {
    const models = await prisma.modelConfig.findMany({
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });

    // Don't send API keys to the client
    const sanitized = models.map((m) => ({
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
  try {
    const body = await request.json();
    const data = createModelSchema.parse(body);

    const model = await prisma.modelConfig.create({
      data: {
        name: data.name,
        provider: data.provider,
        modelId: data.modelId,
        endpoint: data.endpoint || null,
        apiKey: data.apiKey || null,
        isActive: data.isActive,
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
