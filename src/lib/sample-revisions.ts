/**
 * ─── The revision log (L2) ─────────────────────────────────────────────────
 *
 * THIS MODULE IS THE SINGLE DEFINITION OF "A MUTATION WAS RECORDED", the way
 * src/lib/tombstones.ts is the single definition of "hidden". The two are
 * companions and are not merge-able: `Tombstone` is the CURRENT-STATE
 * projection every read filter consults, one row per entity and `@unique`;
 * this is the LOG, many rows per entity and filtered by nothing.
 *
 * It lives in src/lib/ rather than in the route handlers for the reason
 * tombstones.ts gives: `src/app/api/**` is outside every vitest coverage
 * `include`, and the payload shape is exactly the thing that is cheap to pin
 * in a unit test and expensive to discover in a corpus.
 */

import type { Prisma } from '@prisma/client';

/**
 * Why a revision row exists.
 *
 * A String column rather than a Prisma enum, matching
 * GoldenLabel.tombstonedReason and Dataset.source — this schema uses enums
 * only where one already existed (Visibility, RunProtocol).
 */
export type SampleChangeType = 'edit' | 'delete' | 'restore';

type BeforeImage = {
  input: string;
  expected: string | null;
  metadata: string | null;
};

/**
 * Append one revision for `datasetSampleId`, carrying the values as they stood
 * BEFORE the change.
 *
 * The log stores before-images rather than after-images because the current
 * values are already on the row: "what did this say before?" is the only
 * question a history answers, and reconstructing it from after-images means
 * reading the whole chain.
 *
 * `before` is omitted for 'delete' and 'restore', which change no content — the
 * signature makes passing it a type error rather than a silent no-op, and the
 * columns are left ABSENT rather than null, because a null would claim the row
 * had no input when in fact it had one and still does.
 *
 * MUST be called with the same tx as the mutation it records, so a rolled-back
 * mutation leaves behind no revision claiming it happened.
 */
export async function recordSampleRevision(
  tx: Prisma.TransactionClient,
  args:
    | {
        datasetSampleId: string;
        changeType: 'edit';
        actorId: string | null;
        before: BeforeImage;
      }
    | {
        datasetSampleId: string;
        changeType: Extract<SampleChangeType, 'delete' | 'restore'>;
        actorId: string | null;
        before?: undefined;
      }
): Promise<void> {
  await tx.sampleRevision.create({
    data: {
      datasetSampleId: args.datasetSampleId,
      changeType: args.changeType,
      actorId: args.actorId,
      ...(args.before ? args.before : {}),
    },
  });
}

/**
 * Append one revision per id, for the bulk verbs (DELETE, PUT, the config
 * importer's replace).
 *
 * Ids are de-duplicated first, so a request naming the same sample twice logs
 * one revision rather than two — matching `tombstoneSamples` in
 * src/lib/tombstones.ts, which de-duplicates for the same reason.
 *
 * Only 'delete' and 'restore' are bulk operations; a bulk edit would need a
 * distinct before-image per id, which no caller has.
 *
 * CALLERS MUST PASS THE IDS THAT ACTUALLY TRANSITIONED, not every id the
 * request named. `tombstoneSamples` returns the count of distinct ids NOW
 * HIDDEN, which counts an already-hidden row again — right for the response
 * body, wrong for the log, where a second row would record a deletion that did
 * not happen.
 *
 * Same transaction rule as `recordSampleRevision`.
 */
export async function recordSampleRevisions(
  tx: Prisma.TransactionClient,
  args: {
    datasetSampleIds: string[];
    changeType: Extract<SampleChangeType, 'delete' | 'restore'>;
    actorId: string | null;
  }
): Promise<number> {
  const ids = [...new Set(args.datasetSampleIds)];
  if (ids.length === 0) return 0;

  await tx.sampleRevision.createMany({
    data: ids.map((datasetSampleId) => ({
      datasetSampleId,
      changeType: args.changeType,
      actorId: args.actorId,
    })),
  });

  return ids.length;
}
