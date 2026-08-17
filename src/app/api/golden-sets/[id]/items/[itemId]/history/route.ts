import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { RateLimitedError } from '@/lib/auth-guard';
import { logger, serializeError } from '@/lib/logger';
import { toPublicOwner } from '@/lib/serializers';
import { labelCategory } from '@/lib/label-readings';
import { resolveReportingAccess } from '../../../reporting-access';

/**
 * A1 — `GET …/golden-sets/[id]/items/[itemId]/history`. Who saw what, and
 * answered what.
 *
 * ── THE ONE THING THIS ROUTE EXISTS FOR ────────────────────────────────────
 *
 * `sawText` is the item content AS THAT ANNOTATOR SAW IT, resolved through
 * `GoldenLabel.goldenItemRevisionId`, not the item's current content. A
 * handler that returned the current content unconditionally would look
 * entirely correct — every field populated, every reading present — and would
 * silently assert that people scored text they never read. That is the whole
 * defect this route and A1's revision log exist to close, which is why the
 * fallback below is explicit rather than a `??`.
 *
 * THE INVARIANT: `goldenItemRevisionId IS NULL` means they saw the CURRENT
 * content — because the revision capturing a before-image does not exist until
 * the edit that supersedes it, so an un-edited item has nothing to point at.
 * Non-null means they saw that revision's before-image.
 *
 * TOMBSTONED READINGS ARE INCLUDED, unlike every other reporting query in this
 * phase. A retired reading is exactly what this route is for: it is the
 * reading whose text is gone, and omitting it would leave the history of an
 * edited item empty at precisely the point where provenance matters.
 *
 * WHO is stripped on the public branch, to `null`. The owner view gets
 * `{ id, name }` through the same `toPublicOwner` allow-list every other
 * user-bearing response uses — never the email.
 */
export async function GET(
  _request: Request,
  props: { params: Promise<{ id: string; itemId: string }> }
) {
  const params = await props.params;

  try {
    const resolved = await resolveReportingAccess(params.id);
    if ('error' in resolved) return resolved.error;
    const isOwnerView = resolved.access === 'owner';

    const item = await prisma.goldenItem.findFirst({
      where: { id: params.itemId, goldenSetId: params.id },
      select: {
        id: true,
        inputText: true,
        promptText: true,
        responseText: true,
        expected: true,
      },
    });
    if (!item) {
      return NextResponse.json(
        { error: 'That item does not belong to this golden set' },
        { status: 404 }
      );
    }

    const labels = await prisma.goldenLabel.findMany({
      where: { goldenItemId: params.itemId },
      select: {
        id: true,
        round: true,
        overallScore: true,
        preference: true,
        goldenItemId: true,
        annotatorId: true,
        createdAt: true,
        tombstonedAt: true,
        tombstonedReason: true,
        annotator: { select: { id: true, name: true } },
        goldenItemRevision: {
          select: {
            id: true,
            inputText: true,
            promptText: true,
            responseText: true,
            expected: true,
          },
        },
      },
      orderBy: [{ createdAt: 'asc' }, { round: 'asc' }],
    });

    const current = {
      inputText: item.inputText,
      promptText: item.promptText,
      responseText: item.responseText,
      expected: item.expected,
    };

    const readings = labels.map((label) => ({
      labelId: label.id,
      round: label.round,
      annotator: isOwnerView && label.annotator ? toPublicOwner(label.annotator) : null,
      value: labelCategory(label),
      at: label.createdAt,
      tombstonedAt: label.tombstonedAt,
      tombstonedReason: label.tombstonedReason,
      sawRevisionId: label.goldenItemRevision?.id ?? null,
      sawText: label.goldenItemRevision
        ? {
            inputText: label.goldenItemRevision.inputText,
            promptText: label.goldenItemRevision.promptText,
            responseText: label.goldenItemRevision.responseText,
            expected: label.goldenItemRevision.expected,
          }
        : current,
    }));

    return NextResponse.json({ itemId: item.id, readings });
  } catch (error) {
    if (error instanceof RateLimitedError) return error.response;
    logger.error('Failed to read golden-item history', { error: serializeError(error) });
    return NextResponse.json({ error: 'Failed to read item history' }, { status: 500 });
  }
}
