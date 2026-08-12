import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  requireAuth,
  requireScope,
  isAdmin,
  optionalAuth,
  resolveResourceAccess,
  RateLimitedError,
} from '@/lib/auth-guard';
import { parsePaginationParams, buildPrismaPageArgs, paginatedJson } from '@/lib/pagination';
import { logger, serializeError } from '@/lib/logger';
import { toPublicGoldenSet } from '@/lib/serializers';
import { generateSlug } from '@/lib/config';
import { PLATFORM_OWNER_EMAIL, mapSampleToGoldenItem } from '@/lib/golden-sets';
import { createGoldenSetSchema, goldenSetInclude } from './shared';

// GET /api/golden-sets — list golden sets visible to the caller.
// Public-read (optionalAuth), paginated {data, pagination}. Retired and
// tombstoned sets are filtered out of EVERY read path; ?includeRetired=true
// is the escape. A retire writer with no reader would be a no-op button.
export async function GET(request: Request) {
  try {
    const session = await optionalAuth();
    if (session) {
      const scopeCheck = requireScope(session, 'golden-sets:read');
      if (scopeCheck) return scopeCheck;
    }

    const { searchParams } = new URL(request.url);
    const protocol = searchParams.get('protocol');
    const datasetId = searchParams.get('datasetId');
    const includeRetired = searchParams.get('includeRetired') === 'true';
    const { limit, cursor } = parsePaginationParams(searchParams);
    const pageArgs = buildPrismaPageArgs({ limit, cursor });

    const where: Prisma.GoldenSetWhereInput = {};

    if (!session) {
      where.visibility = 'public';
    } else if (!isAdmin(session)) {
      where.OR = [{ ownerId: session.user.id }, { visibility: 'public' }];
    }

    if (!includeRetired) {
      where.retiredAt = null;
      where.tombstonedAt = null;
    }

    // Same enum guard the datasets list uses (datasets/route.ts:74-78): an
    // arbitrary ?protocol= value would be a Prisma validation error on an
    // enum column, not a zero-row match.
    if (protocol === 'pointwise' || protocol === 'pairwise' || protocol === 'listwise') {
      where.protocol = protocol;
    }
    if (datasetId) where.datasetId = datasetId;

    const [goldenSets, total] = await Promise.all([
      prisma.goldenSet.findMany({
        where,
        include: goldenSetInclude,
        orderBy: { updatedAt: 'desc' },
        ...pageArgs,
      }),
      prisma.goldenSet.count({ where }),
    ]);

    const isOwnerOrAdmin = (g: { ownerId: string | null }) =>
      !!session && (session.user.id === g.ownerId || isAdmin(session));
    const body = goldenSets.map((g) => (isOwnerOrAdmin(g) ? g : toPublicGoldenSet(g)));

    return paginatedJson(body, limit, total);
  } catch (error) {
    if (error instanceof RateLimitedError) return error.response;
    logger.error('Failed to fetch golden sets', { error: serializeError(error) });
    return NextResponse.json({ error: 'Failed to fetch golden sets' }, { status: 500 });
  }
}

// POST /api/golden-sets — CREATION IS IMPORT. One platform Dataset, one
// protocol, one transaction. There is no blank-item form and no separate
// import route.
export async function POST(request: Request) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'golden-sets:write');
  if (scopeCheck) return scopeCheck;

  try {
    const body = await request.json();
    const data = createGoldenSetSchema.parse(body);

    const dataset = await prisma.dataset.findUnique({
      where: { id: data.datasetId },
      select: { id: true, userId: true, visibility: true },
    });
    if (!dataset) {
      return NextResponse.json({ error: 'Dataset not found' }, { status: 404 });
    }

    // Gated on VISIBILITY, not ownership. evaluations/route.ts:522 guards its
    // dataset read by ownership; copying that here would make the seeded
    // 620-row JudgeBench corpus unimportable for every non-admin, because it
    // is owned by the platform user.
    const decision = resolveResourceAccess(session, dataset.userId, dataset.visibility === 'public');
    if ('error' in decision) return decision.error;

    // A0 additionally restricts creation to platform-curated corpora.
    // findFirst, not findUnique: User.email is deliberately NOT db-unique —
    // identity is (oidcIssuer, oidcSubject) — and only prisma/seed-core.ts's
    // resolvePlatformUser ever writes a row with this email.
    const platformUser = await prisma.user.findFirst({
      where: { email: PLATFORM_OWNER_EMAIL },
      select: { id: true },
    });
    if (!platformUser || dataset.userId !== platformUser.id) {
      return NextResponse.json(
        {
          error:
            'Golden sets can only be imported from platform-curated datasets. Widening this is a dropped check, not a migration.',
        },
        { status: 403 }
      );
    }

    // Samples are read SERVER-SIDE. Never through GET /api/datasets/[id],
    // which takes `samples: { take: 100 }` — that path imports 100 of 620,
    // errors nothing, and looks like it worked.
    const samples = await prisma.datasetSample.findMany({
      where: {
        datasetId: dataset.id,
        ...(data.sampleIndices ? { index: { in: data.sampleIndices } } : {}),
      },
      orderBy: { index: 'asc' },
      select: { id: true, index: true, input: true, expected: true, metadata: true },
    });

    // Present => only the named samples, IN THE ORDER GIVEN.
    let ordered = samples;
    if (data.sampleIndices) {
      const byIndex = new Map(samples.map((s) => [s.index, s]));
      const missing = data.sampleIndices.filter((i) => !byIndex.has(i));
      if (missing.length > 0) {
        return NextResponse.json(
          { error: `sampleIndices not present in this dataset: ${missing.join(', ')}` },
          { status: 400 }
        );
      }
      ordered = data.sampleIndices.map((i) => byIndex.get(i)!);
    }

    if (ordered.length === 0) {
      return NextResponse.json({ error: 'Dataset has no samples' }, { status: 400 });
    }

    // The importer branches on the TARGET PROTOCOL, never on
    // dataset.inputType — reusing the evaluations mapping would yield
    // inputText = 'A>B' on every row. GoldenItem.index is 0..n-1 over the
    // SELECTION, not inherited from DatasetSample.index.
    const items = ordered.map((s, i) =>
      mapSampleToGoldenItem(
        { id: s.id, input: s.input, expected: s.expected, metadata: s.metadata },
        data.protocol,
        i
      )
    );

    const baseSlug = generateSlug(data.name);
    const existingSlugs = (
      await prisma.goldenSet.findMany({
        where: { ownerId: session.user.id },
        select: { slug: true },
      })
    )
      .map((g) => g.slug)
      .filter(Boolean) as string[];
    const uniqueSlug = existingSlugs.includes(baseSlug)
      ? `${baseSlug}-${Date.now().toString(36).slice(-4)}`
      : baseSlug;

    // Set + items + candidates in ONE transaction, and via createMany rather
    // than 620 sequential creates: an interactive transaction's default 5s
    // timeout will not survive 620 round trips.
    //
    // The 5s default is not relied on even so: JudgeBench measures at
    // 350-520ms today, but this route exists to grow into corpora an order
    // of magnitude larger (MMLU-Pro, LiveBench, ...), where the default
    // margin would be thin. `{ maxWait: 10_000, timeout: 60_000 }` is a
    // considered ceiling, not decoration — matching the other bulk-write
    // path in this feature, `forkGoldenSet`'s transaction
    // (src/lib/golden-set-versions.ts:253), so the two agree.
    const goldenSet = await prisma.$transaction(
      async (tx) => {
        const created = await tx.goldenSet.create({
          data: {
            name: data.name,
            slug: uniqueSlug,
            description: data.description,
            ownerId: session.user.id,
            datasetId: dataset.id,
            protocol: data.protocol,
          },
          select: { id: true },
        });

        await tx.goldenItem.createMany({
          data: items.map((item) => ({
            goldenSetId: created.id,
            index: item.index,
            inputText: item.inputText,
            promptText: item.promptText,
            responseText: item.responseText,
            protocol: item.protocol,
            expected: item.expected,
            sourceDatasetSampleId: item.sourceDatasetSampleId,
          })),
        });

        // createMany returns no ids, so read them back by the index we just
        // assigned (unique per set) to attach candidates.
        const persisted = await tx.goldenItem.findMany({
          where: { goldenSetId: created.id },
          select: { id: true, index: true },
        });
        const idByIndex = new Map(persisted.map((p) => [p.index, p.id]));

        const candidateRows = items.flatMap((item) =>
          item.candidates.map((c) => ({
            goldenItemId: idByIndex.get(item.index)!,
            position: c.position,
            promptText: c.promptText,
            responseText: c.responseText,
            label: c.label,
          }))
        );
        if (candidateRows.length > 0) {
          await tx.goldenCandidate.createMany({ data: candidateRows });
        }

        return tx.goldenSet.findUniqueOrThrow({
          where: { id: created.id },
          include: goldenSetInclude,
        });
      },
      { maxWait: 10_000, timeout: 60_000 }
    );

    return NextResponse.json(goldenSet, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', details: error.errors },
        { status: 400 }
      );
    }
    logger.error('Failed to create golden set', { error: serializeError(error) });
    return NextResponse.json({ error: 'Failed to create golden set' }, { status: 500 });
  }
}
