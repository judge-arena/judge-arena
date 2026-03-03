import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';
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
    let effectiveUserId = session.user.id;

    if (!isAdmin(session)) {
      const sessionUser = await prisma.user.findUnique({
        where: { id: session.user.id },
        select: { id: true },
      });

      if (!sessionUser && session.user.email) {
        const fallbackUser = await prisma.user.findUnique({
          where: { email: session.user.email },
          select: { id: true },
        });
        if (!fallbackUser) {
          return NextResponse.json(
            { error: 'User not found for current session. Please sign out and sign in again.' },
            { status: 401 }
          );
        }
        effectiveUserId = fallbackUser.id;
      }
    }

    const where = isAdmin(session) ? undefined : { userId: effectiveUserId };

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

    const sessionUser = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { id: true },
    });

    let effectiveUserId = session.user.id;
    if (!sessionUser && session.user.email) {
      const fallbackUser = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: { id: true },
      });

      if (!fallbackUser) {
        return NextResponse.json(
          { error: 'User not found for current session. Please sign out and sign in again.' },
          { status: 401 }
        );
      }

      effectiveUserId = fallbackUser.id;
    }

    const model = await prisma.modelConfig.create({
      data: {
        name: data.name,
        provider: data.provider,
        modelId: data.modelId,
        endpoint: data.endpoint || null,
        apiKey: data.apiKey || null,
        isActive: data.isActive,
        isVerified: false,
        verifiedAt: null,
        verificationError: 'Not tested yet',
        userId: effectiveUserId,
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
    if ((error as any)?.code === 'P2003') {
      return NextResponse.json(
        { error: 'Failed to create model: invalid user reference. Please sign out and sign in again.' },
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
