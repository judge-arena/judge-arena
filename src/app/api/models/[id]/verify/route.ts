import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { verifyModelConnection } from '@/lib/llm/verify';
import { requireAuth, requireScope, isAdmin } from '@/lib/auth-guard';
import { logger, serializeError } from '@/lib/logger';
import { decryptSafe } from '@/lib/crypto';
import { modelEndpointInclude, modelEndpointToWireShape } from '../../shared';

/**
 * POST /api/models/[id]/verify — Task 12: verifies a `ModelEndpoint` (was
 * `ModelConfig`) via the registry-driven `verifyModelConnection`
 * (`src/lib/llm/verify.ts`), dispatching on `JudgeModelVersion.servingBackend`
 * directly (no legacy `ModelConfig.provider` mapping — that whole indirection
 * is gone). On success, persists the returned `archFingerprint` onto
 * `ModelEndpoint.archFingerprint` — closing the Task 10 carry ("no
 * ModelEndpoint/archFingerprint column to write it to yet").
 */
export async function POST(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'models:verify');
  if (scopeCheck) return scopeCheck;

  try {
    const endpoint = await prisma.modelEndpoint.findUnique({
      where: { id: params.id },
      include: modelEndpointInclude,
    });

    if (!endpoint) {
      return NextResponse.json({ error: 'Model not found' }, { status: 404 });
    }
    if (endpoint.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const judgeModel = endpoint.judgeModelVersion.judgeModel;
    if (!judgeModel.baseModel) {
      return NextResponse.json(
        { error: `Judge model "${judgeModel.name}" has no baseModel configured — cannot verify a connection.` },
        { status: 400 }
      );
    }

    try {
      // `endpoint.apiKeyEnc` is stored encrypted (see the create/update
      // routes' `encryptIfNeeded` calls) — decrypt before sending it to the
      // provider. `decryptSafe` is a no-op for a value that isn't actually
      // tagged ciphertext, so this is safe regardless of migration state.
      const result = await verifyModelConnection({
        servingBackend: endpoint.judgeModelVersion.servingBackend,
        modelId: judgeModel.baseModel,
        endpoint: endpoint.endpoint || undefined,
        apiKey: endpoint.apiKeyEnc ? decryptSafe(endpoint.apiKeyEnc) : undefined,
      });

      const updated = await prisma.modelEndpoint.update({
        where: { id: params.id },
        data: {
          verifiedAt: new Date(),
          verificationError: null,
          archFingerprint: result.archFingerprint as unknown as object,
        },
        include: modelEndpointInclude,
      });

      return NextResponse.json(modelEndpointToWireShape(updated));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Connection test failed';

      await prisma.modelEndpoint.update({
        where: { id: params.id },
        data: { verifiedAt: null, verificationError: message },
      });

      return NextResponse.json({ error: `Model connection test failed: ${message}` }, { status: 400 });
    }
  } catch (error) {
    logger.error('Failed to verify model', { error: serializeError(error) });
    return NextResponse.json({ error: 'Failed to verify model connection' }, { status: 500 });
  }
}
