import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { verifyModelConnection } from '@/lib/llm/verify';

// POST /api/models/[id]/verify
export async function POST(
  _request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const model = await prisma.modelConfig.findUnique({
      where: { id: params.id },
    });

    if (!model) {
      return NextResponse.json({ error: 'Model not found' }, { status: 404 });
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

      await prisma.modelConfig.update({
        where: { id: params.id },
        data: {
          isVerified: false,
          verificationError: message,
        },
      });

      return NextResponse.json(
        { error: `Model connection test failed: ${message}` },
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
