import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAuth, requireScope } from '@/lib/auth-guard';
import { logger } from '@/lib/logger';

/**
 * GET /api/models/catalog
 *
 * Lists every non-retired `JudgeModelVersion` (+ parent `JudgeModel`) in the
 * catalog — what the "pick from catalog" side of `POST /api/models` (and the
 * models-page picker) offers a user to create their own `ModelEndpoint`
 * against. Catalog entries are shared across all users (they carry no
 * credentials — those live per-user on `ModelEndpoint`); `models:read` is
 * sufficient (same scope `GET /api/models` requires).
 */
export async function GET() {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'models:read');
  if (scopeCheck) return scopeCheck;

  try {
    const versions = await prisma.judgeModelVersion.findMany({
      where: { retiredAt: null, judgeModel: { retiredAt: null } },
      include: {
        judgeModel: {
          select: {
            id: true,
            name: true,
            slug: true,
            judgeClass: true,
            scoringMechanism: true,
            baseModel: true,
          },
        },
      },
      orderBy: [{ judgeModel: { name: 'asc' } }, { ordinal: 'asc' }],
    });

    const catalog = versions.map((v) => ({
      judgeModelVersionId: v.id,
      judgeModelId: v.judgeModelId,
      ordinal: v.ordinal,
      servingBackend: v.servingBackend,
      quantization: v.quantization,
      trustState: v.trustState,
      name: v.judgeModel.name,
      slug: v.judgeModel.slug,
      judgeClass: v.judgeModel.judgeClass,
      scoringMechanism: v.judgeModel.scoringMechanism,
      baseModel: v.judgeModel.baseModel,
    }));

    return NextResponse.json(catalog);
  } catch (error) {
    logger.error('Failed to fetch model catalog', { error });
    return NextResponse.json({ error: 'Failed to fetch model catalog' }, { status: 500 });
  }
}
