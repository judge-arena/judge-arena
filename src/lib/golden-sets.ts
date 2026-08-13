/**
 * ─── Golden sets: the import mapping (A0) ──────────────────────────────────
 *
 * A golden set is not free-form content. It is the annotation layer over
 * exactly one platform-curated `Dataset`, imported at exactly one protocol
 * (A0 design, "Creation is import"), so every `GoldenItem` is derived from a
 * `DatasetSample` by a pure function. That function lives here rather than
 * inside the route handler: `src/app/api/**` is outside every vitest
 * coverage `include`, and this is the part of A0 whose correctness is
 * cheapest to pin down in a unit test and most expensive to discover in a
 * 620-row import.
 *
 * WHAT THE SOURCE ROWS ACTUALLY LOOK LIKE (verified against the live
 * `judgebench-v1` corpus, 620 rows, 2026-08-12):
 *
 *     DatasetSample.input    = the question, ALONE
 *     DatasetSample.expected = 'A>B' (336) | 'B>A' (284)
 *     DatasetSample.metadata = a STRING holding JSON, keys exactly
 *                              split, source, pair_id, original_id,
 *                              response_model, response_A, response_B
 *                              (written at prisma/seed-judgebench.ts:195-203)
 *
 * The two candidate responses exist ONLY inside `metadata`. That is why this
 * mapping exists, and why the dataset mapping at
 * `src/app/api/evaluations/route.ts:538-546` must not be reused: for
 * `inputType: 'query-response'` it takes `sample.expected || sample.input`,
 * which here produces `inputText: 'A>B'` — a two-character string judged
 * against a rubric, on every row, with no error anywhere.
 *
 * THE ONLY THING THIS BRANCHES ON IS THE TARGET PROTOCOL, never
 * `dataset.inputType`:
 *
 *     pointwise   1 candidate  (response_A)   expected = null
 *     pairwise    2 candidates (A, B)         expected = 'A>B' | 'B>A'
 *     listwise    2 candidates (A, B)         expected = '0,1' | '1,0'
 *
 * A pointwise import of a preference corpus therefore has NO ground truth,
 * and that is correct rather than broken: the label is a preference between
 * two responses, not a score for one. Such a set is not calibration-ready
 * until A1's annotators label it.
 *
 * RESPONSE TEXT LIVES IN THE CANDIDATES AND NOWHERE ELSE. Item-level
 * `promptText`/`responseText` are null at every protocol, including pointwise
 * where the single response would "fit" in `responseText`. Two homes for one
 * string is two places to edit, and the fork's content comparison (A0 design,
 * "Freeze and fork") would have to keep them agreeing forever.
 *
 * `label` on a candidate is null: position IS the identity (0 = A, 1 = B),
 * which is what `pairOrder: 'AB'` means on the judgment that scores it.
 *
 * A CORRUPT SOURCE ROW FAILS LOUDLY. `metadata` is nullable and free-form, so
 * every accessor below is checked and every error names the sample id. A
 * golden set built from a row with no responses would be ground truth made
 * of empty strings — which nothing downstream can detect, because it is a
 * perfectly well-formed set.
 */

import type { Prisma, RunProtocol } from '@prisma/client';

/**
 * Owner of every corpus a golden set may be built from. Duplicated from
 * `PLATFORM_USER_EMAIL` (prisma/seed-core.ts:60) rather than imported:
 * `prisma/seed-core.ts` is a seeding module that pulls in the whole seed
 * graph, and nothing under src/ should drag that into a Next.js bundle.
 * `tests/lib/golden-sets.test.ts` asserts the two values agree.
 */
export const PLATFORM_OWNER_EMAIL = 'platform@judgearena.local';

export interface GoldenCandidateInput {
  position: number;
  promptText: string | null;
  responseText: string | null;
  label: string | null;
}

export interface GoldenItemInput {
  index: number;
  inputText: string;
  promptText: string | null;
  responseText: string | null;
  protocol: RunProtocol;
  expected: string | null;
  sourceDatasetSampleId: string;
  candidates: GoldenCandidateInput[];
}

/**
 * The subset of `DatasetSample` this mapping reads. `metadata` is a STRING
 * holding JSON, not a Json column — see the model at schema.prisma:600-614.
 */
export interface SourceSample {
  id: string;
  input: string;
  expected: string | null;
  metadata: string | null;
}

/**
 * The preference vocabulary that can be imported for any protocol. A Map,
 * not an object literal: `{}['constructor']` is a function rather than
 * undefined, so an object lookup keyed on untrusted `expected` text has a
 * prototype hole a Map does not.
 */
const ALLOWED_PREFERENCE_LABELS = new Set<string>(['A>B', 'B>A']);

/**
 * The mapping from preference labels to listwise rankings. Subset of
 * ALLOWED_PREFERENCE_LABELS with computed values.
 */
const LISTWISE_RANKING_BY_PREFERENCE = new Map<string, string>([
  ['A>B', '0,1'],
  ['B>A', '1,0'],
]);

interface PairResponses {
  responseA: string;
  responseB: string;
}

function readPairResponses(sample: SourceSample): PairResponses {
  if (sample.metadata === null || sample.metadata.trim() === '') {
    throw new Error(
      `mapSampleToGoldenItem: dataset sample ${sample.id} has no metadata, so it carries no ` +
        'candidate responses (expected a JSON object with response_A and response_B)'
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(sample.metadata);
  } catch (error) {
    throw new Error(
      `mapSampleToGoldenItem: dataset sample ${sample.id} has metadata that is not valid JSON: ` +
        (error instanceof Error ? error.message : String(error))
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `mapSampleToGoldenItem: dataset sample ${sample.id} has metadata that is not a JSON object`
    );
  }

  const { response_A: responseA, response_B: responseB } = parsed as Record<string, unknown>;
  if (typeof responseA !== 'string' || typeof responseB !== 'string') {
    throw new Error(
      `mapSampleToGoldenItem: dataset sample ${sample.id} is missing response_A/response_B in ` +
        'its metadata; it is not a pair, and no protocol can be built from it'
    );
  }

  return { responseA, responseB };
}

function validatePreferenceLabel(sample: SourceSample): void {
  if (sample.expected === null) return;
  if (!ALLOWED_PREFERENCE_LABELS.has(sample.expected)) {
    throw new Error(
      `mapSampleToGoldenItem: dataset sample ${sample.id} has expected ` +
        `${JSON.stringify(sample.expected)}, which is not an allowed preference label (known ` +
        `labels: ${[...ALLOWED_PREFERENCE_LABELS].join(', ')})`
    );
  }
}

function toListwiseRanking(sample: SourceSample): string | null {
  if (sample.expected === null) return null;
  const ranking = LISTWISE_RANKING_BY_PREFERENCE.get(sample.expected);
  if (ranking === undefined) {
    throw new Error(
      `mapSampleToGoldenItem: dataset sample ${sample.id} has expected ` +
        `${JSON.stringify(sample.expected)}, which has no listwise ranking (known preference ` +
        `labels: ${[...LISTWISE_RANKING_BY_PREFERENCE.keys()].join(', ')})`
    );
  }
  return ranking;
}

function toCandidate(position: number, responseText: string): GoldenCandidateInput {
  return { position, promptText: null, responseText, label: null };
}

/**
 * Maps one `DatasetSample` to one `GoldenItemInput` for the target protocol.
 * Pure: no DB, no clock, no ids minted. `index` is the caller's position in
 * the SELECTION (0..n-1 over `sampleIndices`), never the sample's own index.
 */
export function mapSampleToGoldenItem(
  sample: SourceSample,
  protocol: RunProtocol,
  index: number
): GoldenItemInput {
  const { responseA, responseB } = readPairResponses(sample);

  const base = {
    index,
    inputText: sample.input,
    promptText: null,
    responseText: null,
    protocol,
    sourceDatasetSampleId: sample.id,
  };

  if (protocol === 'pointwise') {
    return { ...base, expected: null, candidates: [toCandidate(0, responseA)] };
  }

  if (protocol === 'pairwise') {
    validatePreferenceLabel(sample);
    return {
      ...base,
      expected: sample.expected,
      candidates: [toCandidate(0, responseA), toCandidate(1, responseB)],
    };
  }

  if (protocol === 'listwise') {
    return {
      ...base,
      expected: toListwiseRanking(sample),
      candidates: [toCandidate(0, responseA), toCandidate(1, responseB)],
    };
  }

  // Exhaustive over RunProtocol — `protocol` is `never` here. Reachable only
  // from an unvalidated caller, which must not silently get a listwise item.
  const unsupported: never = protocol;
  throw new Error(`mapSampleToGoldenItem: unsupported protocol ${String(unsupported)}`);
}

/**
 * ─── Freeze ────────────────────────────────────────────────────────────────
 *
 * A golden set is frozen iff any CalibrationRun references it:
 *
 *     frozen(goldenSetId) := calibrationRun.count({ where: { goldenSetId } }) > 0
 *
 * WHAT FREEZES is item content — items, candidates, `protocol`, `expected`.
 * WHAT DOES NOT is `name`, `description`, `visibility`, `retiredAt`: renaming
 * a set changes nothing a calibration run measured, and refusing a typo fix is
 * hostile and buys nothing.
 *
 * `datasetId` IS IN NEITHER LIST ANY MORE. Listing it as frozen content made
 * it editable on any set without a CalibrationRun, which is backwards: a
 * golden set annotates exactly one dataset, so repointing it is illegitimate
 * whether or not anything has measured it. It is now immutable for the life of
 * the row, refused with a 400 in the PATCH route, and never reaches this
 * predicate at all.
 *
 * `finishedAt` IS NOT CONSULTED. CalibrationRun has no status enum, only
 * `startedAt`/`finishedAt`, so "still running" and "crashed" are the same
 * state; excluding unfinished runs would let a crashed run's set drift
 * underneath the numbers it already produced.
 *
 * IT TAKES THE CALLER'S TRANSACTION CLIENT, deliberately. The count and the
 * mutation it guards must commit or roll back together — separated, a
 * calibration run that starts between them measures a set that changed
 * underneath it, and nothing logs.
 *
 * ONE DEFINITION, TWO CALLERS. `src/lib/account-deletion.ts` had this
 * predicate inline first (its golden-set branch, closing 1b-prereq (a)); it
 * now calls this function, so the account-lifecycle path and the golden-set
 * write-guards cannot drift into disagreeing about what "frozen" means.
 */

export async function isGoldenSetFrozen(
  tx: Prisma.TransactionClient,
  goldenSetId: string
): Promise<boolean> {
  const pinningCalibrationRunCount = await tx.calibrationRun.count({ where: { goldenSetId } });
  return pinningCalibrationRunCount > 0;
}

/**
 * Thrown by a write-guard that refused to change the content of a frozen set.
 * Routes map it to a 409 whose body points at POST /api/golden-sets/[id]/fork
 * — the whole point of decision #6 is that editing a measured set is not
 * forbidden, it is redirected to a new version.
 */
export class GoldenSetFrozenError extends Error {
  readonly goldenSetId: string;

  constructor(goldenSetId: string) {
    super(
      `Golden set ${goldenSetId} is frozen: a calibration run has already measured it. ` +
        'Fork it to a new version to change its items.'
    );
    this.name = 'GoldenSetFrozenError';
    this.goldenSetId = goldenSetId;
  }
}

/* ─── Item lifecycle: tombstone, never delete ───────────────────────────────
 *
 * Owner ruling 2026-08-13: "delete is ALWAYS a same-transaction tombstone
 * tag; no actual data removal, anywhere." `GoldenItem.tombstonedAt` is that
 * tag. NULL = live.
 *
 * NOTE THE ASYMMETRY WITH A SET'S `tombstonedAt`, IT IS DELIBERATE. A SET's
 * `tombstonedAt` is an ACCOUNT-LIFECYCLE verb written by
 * src/lib/account-deletion.ts for a set pending purge, and nothing may ever
 * hand one back — there is no escape hatch. An ITEM's `tombstonedAt` is a
 * PRODUCT verb: its owner curating their own set. The owner therefore has to
 * be able to see what they removed (to notice a mistake, and because the row
 * is being kept precisely so it can be looked at), so the item filter DOES
 * take an escape — gated to the owner/admin branch by its caller, never
 * offered to a public reader of a public set.
 *
 * `true` returns an EMPTY predicate rather than `{ tombstonedAt: { not: null } }`:
 * "include tombstoned" means live AND tombstoned, not tombstoned only.
 */
export function goldenItemLifecycleWhere(includeTombstoned: boolean): Prisma.GoldenItemWhereInput {
  return includeTombstoned ? {} : { tombstonedAt: null };
}

/** The one spelling of the item escape hatch. Strict `=== 'true'`, matching
 * this repo's other boolean query flags — `?includeRetired` (the golden-set
 * routes) and `?includeSamples` (src/app/api/config/export/route.ts:38) — so
 * `?includeTombstoned=1` is false everywhere rather than true on some
 * routes. */
export function parseIncludeTombstoned(searchParams: URLSearchParams): boolean {
  return searchParams.get('includeTombstoned') === 'true';
}

/** The only `GoldenLabel.tombstonedReason` any code writes today. A future
 * annotator retraction or purge gets its OWN value rather than overloading
 * this one — the column exists so "why did this score stop applying" is
 * answerable without reading git history. */
export const GOLDEN_LABEL_TOMBSTONE_REASON_CONTENT_EDIT = 'item-content-edit';

/**
 * The other writer: `POST /api/config/import` replacing a set's items wholesale
 * from a config document.
 *
 * NOT folded into the constant above, even though both are "the text this score
 * applied to is gone". An import replace tombstones EVERY live item of the set,
 * including items whose content the document did not change, because the
 * document is the new truth for the whole set and the old rows are not
 * re-identified against it. Labelling those `'item-content-edit'` would assert
 * something false about the items that did not change — and a reason that lies
 * is worse than no reason, which is the whole point of the column.
 */
export const GOLDEN_LABEL_TOMBSTONE_REASON_CONFIG_IMPORT_REPLACE = 'config-import-replace';

/**
 * The next `GoldenItem.index` for a set: a HIGH-WATER MARK over every row,
 * tombstoned included, never a count and never a reused ordinal.
 *
 *     nextIndex = max(index) over ALL rows of the set + 1
 *
 * WHY NOT `count()` of live rows: tombstone item 0 of 3 and the count is 2,
 * but index 2 is occupied — P2002 on the very first insert.
 *
 * WHY NOT `max` over LIVE rows: tombstone the tail (items 0..4, tombstone 3
 * and 4) and live-max + 1 is 3, which is occupied by a tombstoned row.
 *
 * The consequence, stated so nobody rediscovers it as a bug: after the first
 * tombstone, `index` is NOT dense. Its only guarantees are uniqueness within
 * the set and monotonic insertion order. Any code treating it as a 0-based
 * position into the live item array is wrong. The importer's 0..n-1
 * (mapSampleToGoldenItem, above) stays correct only because import runs
 * against an empty set.
 *
 * Takes the caller's transaction client for the same reason
 * `isGoldenSetFrozen` does: read-then-insert across a commit boundary is a
 * race against a concurrent append.
 */
export async function nextGoldenItemIndex(
  tx: Prisma.TransactionClient,
  goldenSetId: string
): Promise<number> {
  const highWaterMark = await tx.goldenItem.aggregate({
    where: { goldenSetId },
    _max: { index: true },
  });
  return (highWaterMark._max.index ?? -1) + 1;
}
