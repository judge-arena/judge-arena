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
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { goldenItemLifecycleWhere } from '@/lib/golden-sets';

// `_count.items` is a FILTERED relation count. Unfiltered, every list row and
// every public projection would report tombstoned items in `itemCount` —
// toPublicGoldenSet(g).itemCount is the number a reader uses to decide
// whether a set is worth calibrating against, so over-reporting it is a lie
// with consequences, not a cosmetic drift.
export const goldenSetInclude = {
  owner: { select: { id: true, name: true } },
  _count: { select: { items: { where: goldenItemLifecycleWhere(false) } } },
} satisfies Prisma.GoldenSetInclude;

export const goldenSetDetailInclude = {
  owner: { select: { id: true, name: true } },
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
 * import"). `sampleIndices` names `DatasetSample.index` values; omitted means
 * every sample. Duplicates are rejected rather than silently minting two
 * golden items from one source sample.
 */
export const createGoldenSetSchema = z.object({
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
