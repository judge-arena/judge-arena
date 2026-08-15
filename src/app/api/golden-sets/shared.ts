/**
 * Shared zod schemas and Prisma includes for `/api/golden-sets` and its
 * sub-routes. Extracted into a sibling module (rather than exported from
 * route.ts) for the same reason `src/app/api/models/shared.ts` exists:
 * Next.js 15 validates `route.ts` exports against a known allowlist
 * (GET/POST/PATCH/DELETE/.../config) and rejects arbitrary named exports.
 *
 * `goldenSetInclude` is the shape `toPublicGoldenSet` (src/lib/serializers.ts)
 * REQUIRES — `owner: { id, name }` (never email) and `_count.items`. Every
 * query whose result can reach the public branch must use it, or one of the
 * includes below that extends it.
 */
import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { goldenItemLifecycleWhere, type GoldenSetNotInCirculationError } from '@/lib/golden-sets';

/** The 409 body every write that refused an out-of-circulation set returns —
 * the items verbs, PATCH /api/golden-sets/[id], and the fork. Lives here
 * rather than in src/lib/golden-sets.ts so that module stays free of
 * `next/server`, and here rather than in one route.ts because Next.js 15
 * rejects arbitrary named exports from a route module.
 *
 * `forkUrl` is offered for a RETIRED set only. Forking a tombstoned one would
 * mint a live copy of a set pending purge — which the fork route now refuses
 * outright rather than merely declining to advertise. */
export function notInCirculationResponse(error: GoldenSetNotInCirculationError) {
  return NextResponse.json(
    {
      error: error.message,
      goldenSetId: error.goldenSetId,
      state: error.state,
      ...(error.state === 'retired'
        ? {
            retireUrl: `/api/golden-sets/${error.goldenSetId}/retire`,
            forkUrl: `/api/golden-sets/${error.goldenSetId}/fork`,
          }
        : {}),
    },
    { status: 409 }
  );
}

// `_count.items` is a FILTERED relation count. Unfiltered, every list row and
// every public projection would report tombstoned items in `itemCount` —
// toPublicGoldenSet(g).itemCount is the number a reader uses to decide
// whether a set is worth calibrating against, so over-reporting it is a lie
// with consequences, not a cosmetic drift.
export const goldenSetInclude = {
  owner: { select: { id: true, name: true } },
  // The bound corpus, by name. Same two columns and same reasoning as
  // `goldenSetDetailInclude` below: Dataset joins no user data, and
  // `toPublicGoldenSet` (src/lib/serializers.ts:292-305) builds a fresh
  // literal of ten named fields with no spread of the row, so this cannot
  // reach the public projection. Without it the list card's
  // `from {set.dataset.name}` line (src/app/golden-sets/page.tsx) is a
  // permanently dead branch — guarded by `set.dataset &&`, so it renders
  // nothing rather than crashing, which is exactly why it went unnoticed.
  //
  // MUST NOT BE TOMBSTONE-FILTERED (A1), and unreachably so rather than
  // riskily so: `findGoldenSetsPinningDataset`'s `datasetId` arm
  // (src/lib/golden-sets.ts) is not lifecycle-filtered, so every destructive
  // dataset verb answers 409 while ANY golden set names the corpus — live,
  // retired or tombstoned. A bound dataset therefore cannot be hidden, and
  // projecting this to null (the treatment `Evaluation.dataset` gets, since it
  // has no such guard) would add a branch nothing can enter. The same marker
  // and the same reasoning sit on `goldenSetDetailInclude` below and on
  // config/export/route.ts's golden-set read, which has a second reason.
  dataset: { select: { id: true, name: true } },
  _count: { select: { items: { where: goldenItemLifecycleWhere(false) } } },
} satisfies Prisma.GoldenSetInclude;

export const goldenSetDetailInclude = {
  owner: { select: { id: true, name: true } },
  // The bound corpus, by name. `datasetId` is on the row already, but a
  // detail reader wants the NAME — the set is the annotation layer over
  // exactly one dataset and that binding is immutable, so it is the first
  // thing the detail page states (src/app/golden-sets/[id]/page.tsx). Two
  // columns only: Dataset joins no user data, and this include feeds the
  // public branch of GET /api/golden-sets/[id] as well, where
  // `toPublicGoldenSet`'s allow-list drops it.
  //
  // MUST NOT BE TOMBSTONE-FILTERED (A1) — see `goldenSetInclude` above.
  dataset: { select: { id: true, name: true } },
  _count: { select: { items: { where: goldenItemLifecycleWhere(false) } } },
  items: {
    where: goldenItemLifecycleWhere(false),
    orderBy: { index: 'asc' },
    include: { candidates: { orderBy: { position: 'asc' } } },
  },
} satisfies Prisma.GoldenSetInclude;

export type GoldenSetListRow = Prisma.GoldenSetGetPayload<{ include: typeof goldenSetInclude }>;
export type GoldenSetDetailRow = Prisma.GoldenSetGetPayload<{
  include: typeof goldenSetDetailInclude;
}>;

/**
 * `POST /api/golden-sets` — creation IS import (A0 design, "Creation is
 * import"). Two ways to select a subset, and they are MUTUALLY EXCLUSIVE:
 *
 *   - `sampleIndices` names `DatasetSample.index` values, IN THE ORDER GIVEN.
 *     Duplicates are rejected rather than silently minting two golden items
 *     from one source sample.
 *   - `limit` means "the first N LIVE samples, in index order". It exists
 *     because the caller cannot synthesise that list: `index` is a high-water
 *     ordinal, not a dense 0..n-1 sequence, the moment a sample is hidden — so
 *     `Array.from({ length: N }, (_, i) => i)` names hidden rows and the route
 *     400s on the first one it cannot resolve. Only the server knows which
 *     rows are live.
 *
 * Neither present = every live sample.
 *
 * Sending BOTH is a 400 rather than a precedence rule: they are two different
 * selections, and honouring one silently would import rows the caller did not
 * ask for.
 */
export const createGoldenSetSchema = z
  .object({
    datasetId: z.string().min(1),
    protocol: z.enum(['pointwise', 'pairwise', 'listwise']),
    name: z.string().min(1, 'Name is required').max(200),
    description: z.string().max(4000).optional(),
    sampleIndices: z
      .array(z.number().int().min(0))
      .min(1)
      .refine((v) => new Set(v).size === v.length, {
        message: 'sampleIndices must not contain duplicates',
      })
      .optional(),
    limit: z.number().int().min(1).optional(),
  })
  .refine((v) => v.sampleIndices === undefined || v.limit === undefined, {
    message: 'Send either sampleIndices or limit, not both — they select different rows.',
    path: ['limit'],
  });

/**
 * `PATCH /api/golden-sets/[id]`. `name`/`description`/`visibility` are NOT
 * frozen — renaming a set changes nothing a calibration run measured.
 * `protocol` IS content, so the route freeze-guards it inside the same
 * transaction as the update.
 *
 * `datasetId` IS ABSENT, DELIBERATELY, and is not a "frozen" field either: it
 * is IMMUTABLE for the life of the row. A golden set is the annotation layer
 * over exactly one dataset, so repointing it silently re-describes every label
 * it holds; the legitimate moves are fork (same dataset, next version) or a
 * fresh import against the other dataset. The route 400s a body that names
 * `datasetId` rather than stripping it silently — a caller who sent it meant
 * something by it, unlike a forged `ownerId` on POST, which the server always
 * knew better than and can drop without losing intent. This shape is the
 * second line of defence: delete that guard and `datasetId` still cannot reach
 * `goldenSet.update`, because it is not a property of the parsed result.
 */
export const updateGoldenSetSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).nullable().optional(),
  visibility: z.enum(['private', 'public']).optional(),
  protocol: z.enum(['pointwise', 'pairwise', 'listwise']).optional(),
});

/** `PATCH /api/golden-sets/[id]/items` — item content, always freeze-guarded. */
export const updateGoldenItemsSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().min(1),
        inputText: z.string().min(1).optional(),
        promptText: z.string().nullable().optional(),
        responseText: z.string().nullable().optional(),
        expected: z.string().nullable().optional(),
      })
    )
    .min(1),
});

/** `DELETE /api/golden-sets/[id]/items` — TOMBSTONES the named items. Nothing
 * is removed, so survivors keep their `index` and are never re-packed. */
export const deleteGoldenItemsSchema = z.object({
  itemIds: z.array(z.string().min(1)).min(1),
});

/** `POST /api/golden-sets/[id]/fork` — body optional; falls back to the source set's name/description. */
export const forkGoldenSetSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).nullable().optional(),
});

/** `POST /api/golden-sets/[id]/retire` — `retired: false` un-retires. */
export const retireGoldenSetSchema = z.object({
  retired: z.boolean().default(true),
});
