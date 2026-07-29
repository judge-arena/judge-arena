import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { requireAuth, requireScope, isAdmin } from '@/lib/auth-guard';
import { encryptIfNeeded } from '@/lib/crypto';
import { logger } from '@/lib/logger';
import { modelEndpointInclude, modelEndpointToWireShape } from '../shared';

/**
 * PATCH/DELETE /api/models/[id] — operates on a `ModelEndpoint` (Task 12).
 * The catalog (`JudgeModel`/`JudgeModelVersion` — name, judgeClass,
 * servingBackend, baseModel, ...) is immutable per-version here: this route
 * only ever touches the per-user connection (endpoint URL, API key,
 * isActive). Catalog retirement (`JudgeModel.retiredAt`) is an admin-only
 * concern out of this task's scope.
 */
const updateEndpointSchema = z.object({
  endpoint: z.string().url().optional().or(z.literal('')).or(z.null()),
  apiKey: z.string().optional().or(z.null()),
  isActive: z.boolean().optional(),
});

// GET /api/models/[id]
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'models:read');
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

    return NextResponse.json(modelEndpointToWireShape(endpoint));
  } catch (error) {
    logger.error('Failed to fetch model', { error, modelId: params.id });
    return NextResponse.json({ error: 'Failed to fetch model' }, { status: 500 });
  }
}

// PATCH /api/models/[id] — rotate key / change endpoint / toggle active
export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'models:write');
  if (scopeCheck) return scopeCheck;

  try {
    const body = await request.json();
    const data = updateEndpointSchema.parse(body);

    const existing = await prisma.modelEndpoint.findUnique({ where: { id: params.id } });
    if (!existing) {
      return NextResponse.json({ error: 'Model not found' }, { status: 404 });
    }
    if (existing.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const updateData: Record<string, unknown> = {};
    if (data.endpoint !== undefined) updateData.endpoint = data.endpoint || null;
    if (data.apiKey !== undefined) updateData.apiKeyEnc = data.apiKey ? encryptIfNeeded(data.apiKey) : null;
    if (data.isActive !== undefined) updateData.isActive = data.isActive;

    const connectionChanged = data.endpoint !== undefined || data.apiKey !== undefined;
    if (connectionChanged) {
      // Connection settings changed — the previous verification (and any
      // captured archFingerprint) no longer applies to what this endpoint
      // will actually be called with. Mirrors the pre-Task-12 ModelConfig
      // route's "Connection settings changed. Click Test to verify." reset.
      updateData.verifiedAt = null;
      updateData.verificationError = 'Connection settings changed. Click Test to verify.';
      updateData.archFingerprint = null;
    }

    const updated = await prisma.modelEndpoint.update({
      where: { id: params.id },
      data: updateData,
      include: modelEndpointInclude,
    });

    return NextResponse.json(modelEndpointToWireShape(updated));
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: error.errors }, { status: 400 });
    }
    logger.error('Failed to update model', { error, modelId: params.id });
    return NextResponse.json({ error: 'Failed to update model' }, { status: 500 });
  }
}

// DELETE /api/models/[id]
export async function DELETE(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'models:write');
  if (scopeCheck) return scopeCheck;

  try {
    const existing = await prisma.modelEndpoint.findUnique({ where: { id: params.id }, select: { userId: true } });
    if (!existing) return NextResponse.json({ error: 'Model not found' }, { status: 404 });
    if (existing.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // No FK anywhere references ModelEndpoint.id (the worker resolves an
    // endpoint dynamically by (judgeModelVersionId, userId) at execution
    // time — see judgment-consumer.ts's resolveEndpoint — rather than
    // pinning a persisted endpointId), so this is a plain delete with no
    // cascade/restrict concerns.
    await prisma.modelEndpoint.delete({ where: { id: params.id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('Failed to delete model', { error, modelId: params.id });
    return NextResponse.json({ error: 'Failed to delete model' }, { status: 500 });
  }
}
