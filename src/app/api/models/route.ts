/**
 * ─── /api/models — JudgeModel catalog + ModelEndpoint CRUD (Task 12) ───────
 *
 * Pre-Task-12, this route CRUD'd `ModelConfig` rows directly (one row =
 * one user's model, holding both the "which model" identity AND the "how do
 * I reach it" connection details). Task 12 splits that in two:
 *   - `JudgeModel`/`JudgeModelVersion` — the catalog: shared, credential-free
 *     "which model" identity (name, judgeClass, servingBackend, baseModel,
 *     ...).
 *   - `ModelEndpoint` — per-user "how do I reach it" (endpoint URL,
 *     encrypted API key, isActive/verifiedAt).
 *
 * GET returns the CALLING user's `ModelEndpoint`s (admin sees everyone's),
 * each joined to its `JudgeModelVersion`+`JudgeModel` catalog entry, API
 * keys sanitized. This is a BREAKING wire-format change from the old
 * `ModelConfig[]` response — see CONTRIBUTING.md's "API wire-format
 * changes" section.
 *
 * POST creates a new `ModelEndpoint` for the calling user, either:
 *   - `mode: 'catalog'` — against an EXISTING `JudgeModelVersion` (picked
 *     from `GET /api/models/catalog`); or
 *   - `mode: 'custom'` — first creates a brand-new `JudgeModel` +
 *     `JudgeModelVersion` (ordinal 1) from the provided fields, then the
 *     `ModelEndpoint` against it. This is the ONLY place new catalog
 *     entries are created by the runtime — no write path in this task
 *     mutates an EXISTING `JudgeModel`/`JudgeModelVersion` (immutable
 *     version; retirement is a separate, admin-only concern, out of this
 *     task's scope).
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { requireAuth, requireScope, isAdmin } from '@/lib/auth-guard';
import { generateSlug } from '@/lib/config';
import { encryptIfNeeded } from '@/lib/crypto';
import { logger } from '@/lib/logger';
import { modelEndpointInclude, modelEndpointToWireShape } from './shared';

const JUDGE_CLASSES = [
  'prompted_api',
  'prompted_open_weight',
  'finetuned_judge_lm',
  'sequence_classifier_rm',
  'generative_rm',
  'specialized_safety',
  'specialized_factuality',
] as const;
const SCORING_MECHANISMS = ['reward_head_scalar', 'token_probability', 'critique_generative'] as const;
const SERVING_BACKENDS = ['anthropic', 'openai', 'openrouter', 'vllm', 'ollama'] as const;

const catalogSelectionSchema = z.object({
  mode: z.literal('catalog'),
  judgeModelVersionId: z.string().min(1),
  endpoint: z.string().url().optional().or(z.literal('')),
  apiKey: z.string().optional(),
  isActive: z.boolean().default(true),
});

const customModelSchema = z.object({
  mode: z.literal('custom'),
  name: z.string().min(1, 'Name is required').max(100),
  judgeClass: z.enum(JUDGE_CLASSES),
  scoringMechanism: z.enum(SCORING_MECHANISMS),
  servingBackend: z.enum(SERVING_BACKENDS),
  baseModel: z.string().min(1, 'Base model id is required'),
  endpoint: z.string().url().optional().or(z.literal('')),
  apiKey: z.string().optional(),
  isActive: z.boolean().default(true),
});

const createModelSchema = z.discriminatedUnion('mode', [catalogSelectionSchema, customModelSchema]);

// GET /api/models — the calling user's ModelEndpoints (admin sees all)
export async function GET() {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'models:read');
  if (scopeCheck) return scopeCheck;

  try {
    const where = isAdmin(session) ? undefined : { userId: session.user.id };

    const endpoints = await prisma.modelEndpoint.findMany({
      where,
      include: modelEndpointInclude,
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
    });

    return NextResponse.json(endpoints.map(modelEndpointToWireShape));
  } catch (error) {
    logger.error('Failed to fetch models', { error });
    return NextResponse.json({ error: 'Failed to fetch models' }, { status: 500 });
  }
}

async function uniqueJudgeModelSlug(name: string): Promise<string> {
  const base = generateSlug(name);
  const existing = await prisma.judgeModel.findUnique({ where: { slug: base }, select: { id: true } });
  if (!existing) return base;
  return `${base}-${Date.now().toString(36).slice(-4)}`;
}

// POST /api/models — select an existing catalog version, or add a custom model
export async function POST(request: Request) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'models:write');
  if (scopeCheck) return scopeCheck;

  try {
    const body = await request.json();
    const data = createModelSchema.parse(body);
    const encryptedApiKey = data.apiKey ? encryptIfNeeded(data.apiKey) : null;

    let judgeModelVersionId: string;

    if (data.mode === 'catalog') {
      const version = await prisma.judgeModelVersion.findUnique({
        where: { id: data.judgeModelVersionId },
        select: { id: true, retiredAt: true, judgeModel: { select: { retiredAt: true } } },
      });
      if (!version) {
        return NextResponse.json({ error: 'Judge model version not found' }, { status: 404 });
      }
      if (version.retiredAt || version.judgeModel.retiredAt) {
        return NextResponse.json({ error: 'This judge model version has been retired' }, { status: 400 });
      }
      judgeModelVersionId = version.id;
    } else {
      const slug = await uniqueJudgeModelSlug(data.name);
      const judgeModel = await prisma.judgeModel.create({
        data: {
          name: data.name,
          slug,
          judgeClass: data.judgeClass,
          scoringMechanism: data.scoringMechanism,
          baseModel: data.baseModel,
        },
      });
      const version = await prisma.judgeModelVersion.create({
        data: {
          judgeModelId: judgeModel.id,
          ordinal: 1,
          servingBackend: data.servingBackend,
          protocolSupport: { pointwise: ['score'] },
        },
      });
      judgeModelVersionId = version.id;
    }

    const created = await prisma.modelEndpoint.create({
      data: {
        userId: session.user.id,
        judgeModelVersionId,
        endpoint: data.endpoint || null,
        apiKeyEnc: encryptedApiKey,
        isActive: data.isActive,
        verifiedAt: null,
        verificationError: 'Not tested yet',
      },
      include: modelEndpointInclude,
    });

    return NextResponse.json(modelEndpointToWireShape(created), { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: error.errors }, { status: 400 });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
      return NextResponse.json(
        { error: 'Foreign key constraint failed. Invalid relation reference while creating model.' },
        { status: 400 }
      );
    }
    logger.error('Failed to create model', { error });
    return NextResponse.json({ error: 'Failed to create model' }, { status: 500 });
  }
}

