import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { requireAuth, isAdmin } from '@/lib/auth-guard';

const updateModelSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  provider: z.enum(['anthropic', 'openai', 'local']).optional(),
  modelId: z.string().min(1).optional(),
  endpoint: z.string().url().optional().or(z.literal('')).or(z.null()),
  apiKey: z.string().optional().or(z.null()),
  isActive: z.boolean().optional(),
});

// GET /api/models/[id]
export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  try {
    const model = await prisma.modelConfig.findUnique({
      where: { id: params.id },
    });

    if (!model) {
      return NextResponse.json({ error: 'Model not found' }, { status: 404 });
    }

    if (model.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    return NextResponse.json({
      ...model,
      apiKey: undefined,
      hasApiKey: !!model.apiKey,
    });
  } catch (error) {
    console.error('Failed to fetch model:', error);
    return NextResponse.json(
      { error: 'Failed to fetch model' },
      { status: 500 }
    );
  }
}

// PATCH /api/models/[id]
export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  try {
    const body = await request.json();
    const data = updateModelSchema.parse(body);

    const existing = await prisma.modelConfig.findUnique({
      where: { id: params.id },
    });

    if (!existing) {
      return NextResponse.json({ error: 'Model not found' }, { status: 404 });
    }

    if (existing.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const updateData: Record<string, unknown> = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.provider !== undefined) updateData.provider = data.provider;
    if (data.modelId !== undefined) updateData.modelId = data.modelId;
    if (data.endpoint !== undefined)
      updateData.endpoint = data.endpoint || null;
    if (data.apiKey !== undefined) updateData.apiKey = data.apiKey || null;
    if (data.isActive !== undefined) updateData.isActive = data.isActive;

    const connectionChanged =
      data.provider !== undefined ||
      data.modelId !== undefined ||
      data.endpoint !== undefined ||
      data.apiKey !== undefined;

    if (connectionChanged) {
      updateData.isVerified = false;
      updateData.verifiedAt = null;
      updateData.verificationError =
        'Connection settings changed. Click Test to verify.';
    }

    const model = await prisma.modelConfig.update({
      where: { id: params.id },
      data: updateData,
    });

    return NextResponse.json({
      ...model,
      apiKey: undefined,
      hasApiKey: !!model.apiKey,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', details: error.errors },
        { status: 400 }
      );
    }
    console.error('Failed to update model:', error);
    return NextResponse.json(
      { error: 'Failed to update model' },
      { status: 500 }
    );
  }
}

// DELETE /api/models/[id]
export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  try {
    const existing = await prisma.modelConfig.findUnique({ where: { id: params.id }, select: { userId: true } });
    if (!existing) return NextResponse.json({ error: 'Model not found' }, { status: 404 });
    if (existing.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    await prisma.modelConfig.delete({ where: { id: params.id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete model:', error);
    return NextResponse.json(
      { error: 'Failed to delete model' },
      { status: 500 }
    );
  }
}
