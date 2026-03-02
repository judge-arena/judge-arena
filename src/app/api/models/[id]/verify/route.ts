import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { verifyModelConnection } from '@/lib/llm/verify';
import { requireAuth, isAdmin } from '@/lib/auth-guard';

const DEFAULT_CLAUDE_MODEL_IDS = new Set([
  'claude-sonnet-4-5-20250514',
  'claude-sonnet-4-6-20250627',
  'claude-opus-4-5-20250630',
]);

// POST /api/models/[id]/verify
export async function POST(
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

    try {
      await verifyModelConnection({
        provider: model.provider as 'anthropic' | 'openai' | 'local',
        modelId: model.modelId,
        endpoint: model.endpoint || undefined,
        apiKey: model.apiKey || undefined,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Connection test failed';

      const shouldDeactivateDefaultClaude =
        model.provider === 'anthropic' &&
        DEFAULT_CLAUDE_MODEL_IDS.has(model.modelId) &&
        message.toLowerCase().includes('missing anthropic api key');

      await prisma.modelConfig.update({
        where: { id: params.id },
        data: {
          ...(shouldDeactivateDefaultClaude ? { isActive: false } : {}),
          isVerified: false,
          verificationError: message,
        },
      });

      return NextResponse.json(
        {
          error: shouldDeactivateDefaultClaude
            ? `Model connection test failed: ${message}. Default Claude model has been deactivated.`
            : `Model connection test failed: ${message}`,
        },
        { status: 400 }
      );
    }

    const updated = await prisma.modelConfig.update({
      where: { id: params.id },
      data: {
        isVerified: true,
        verifiedAt: new Date(),
        verificationError: null,
      },
    });

    return NextResponse.json({
      ...updated,
      apiKey: undefined,
      hasApiKey: !!updated.apiKey,
    });
  } catch (error) {
    console.error('Failed to verify model:', error);
    return NextResponse.json(
      { error: 'Failed to verify model connection' },
      { status: 500 }
    );
  }
}
