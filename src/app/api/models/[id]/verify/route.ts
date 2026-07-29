import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { verifyModelConnection } from '@/lib/llm/verify';
import { requireAuth, requireScope, isAdmin } from '@/lib/auth-guard';
import { logger, serializeError } from '@/lib/logger';
import { decryptSafe } from '@/lib/crypto';

const DEFAULT_CLAUDE_MODEL_IDS = new Set([
  'claude-sonnet-4-5-20250514',
  'claude-sonnet-4-6-20250627',
  'claude-opus-4-5-20250630',
]);

// POST /api/models/[id]/verify
export async function POST(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'models:verify');
  if (scopeCheck) return scopeCheck;

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
      // `model.apiKey` is stored encrypted (see the create/update routes'
      // `encryptIfNeeded` calls) — decrypt before sending it to the
      // provider. The old code passed the ciphertext straight through as
      // if it were already the plaintext key (the "ciphertext-as-key"
      // MAJOR this task closes): every verify call with a per-model key
      // configured sent Postgres ciphertext as the API key, which the
      // provider would reject as invalid, or — worse, for a custom
      // endpoint expecting a bearer token with no format validation —
      // silently accept as opaque bytes. `decryptSafe` is a no-op for a
      // value that isn't actually tagged ciphertext, so this is safe
      // regardless of migration state.
      await verifyModelConnection({
        provider: model.provider as 'anthropic' | 'openai' | 'local',
        modelId: model.modelId,
        endpoint: model.endpoint || undefined,
        apiKey: model.apiKey ? decryptSafe(model.apiKey) : undefined,
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
    logger.error('Failed to verify model', { error: serializeError(error) });
    return NextResponse.json(
      { error: 'Failed to verify model connection' },
      { status: 500 }
    );
  }
}
