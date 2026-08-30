/**
 * Choosing WHICH dataset samples become a golden set.
 *
 * Pure, and in `src/lib/**` rather than in the create dialog, for the reason
 * this codebase keeps repeating: `src/components/**` and `src/app/**` are
 * outside every coverage `include`, and a selection rule that is quietly wrong
 * produces a golden set that looks fine and measures the wrong thing.
 *
 * ── WHY RANDOM IS A FEATURE AND NOT A FLOURISH ─────────────────────────────
 *
 * "First N" is the cheap subset and it is systematically biased on any ordered
 * corpus. JudgeBench is grouped by source, so its first 30 rows are not 30
 * rows of JudgeBench — they are 30 rows of whichever source sorts first. An
 * agreement number computed over that is a number about one source, presented
 * as a number about the benchmark. Random selection is what makes a subset a
 * SAMPLE rather than a PREFIX.
 *
 * ── THE INDICES ARE REAL, NOT SYNTHESISED ──────────────────────────────────
 *
 * Selection draws from the dataset's ACTUAL `DatasetSample.index` values,
 * which are **not dense**: tombstoning keeps a row's ordinal, so a dataset can
 * hold 0, 5, 9, 40 and nothing between. Generating numbers in `[0, count)`
 * would name indices that do not exist, and the importer would silently import
 * fewer items than asked for. That is the bug this module's shape exists to
 * make impossible — it takes the available indices and picks from them.
 */

/**
 * NOTE ON REACH: production constructs only `random-count` and `random-percent`
 * — see the sole caller, `src/app/api/golden-sets/route.ts`. `all` and `first`
 * are the API's OTHER two modes expressed here for completeness, but the route
 * answers those without this module (absent fields, and `limit`, respectively),
 * so they are exercised by unit tests alone. They are kept, not deleted,
 * because `resolveCount` is exported and total over `SubsetSpec`; a partial
 * function would be the worse shape. Do not read their presence as evidence of
 * a caller.
 */
export type SubsetSpec =
  | { kind: 'all' }
  | { kind: 'first'; count: number }
  | { kind: 'random-count'; count: number }
  | { kind: 'random-percent'; percent: number };

/** The subset fields of `POST /api/golden-sets` — never more than one at once. */
export type ImportSelection = { limit?: number; sampleIndices?: number[] };

/**
 * How many rows a spec actually asks for, given what exists.
 *
 * Clamped to `available` rather than rejected: asking for 200 items of a
 * 30-row dataset is unambiguous, and a 400 would be an error the user cannot
 * act on. Floored at 1 whenever anything was asked for and rows exist —
 * 1% of 30 rounds to 0, and a golden set with no items is not what "1%" meant.
 */
export function resolveCount(spec: SubsetSpec, available: number): number {
  if (available <= 0) return 0;
  const asked =
    spec.kind === 'random-percent'
      ? Math.round((spec.percent / 100) * available)
      : spec.kind === 'all'
        ? available
        : spec.count;
  return Math.min(available, Math.max(1, Math.round(asked)));
}

/**
 * Fisher-Yates, partial: shuffle only the first `count` positions.
 *
 * Chosen over "pick a random index, retry on a duplicate", which is correct
 * but unbounded — as `count` approaches `available` the retry loop's expected
 * work grows without limit, and at `count === available` it may never finish.
 * This is O(count) with no retries and is uniform over subsets.
 */
function pickDistinct(from: readonly number[], count: number, rng: () => number): number[] {
  const pool = [...from];
  const take = Math.min(count, pool.length);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(rng() * (pool.length - i));
    // Guard a caller-supplied rng that returns exactly 1 (or drifts out of
    // range): an out-of-bounds swap would put `undefined` into the result.
    const safe = Math.min(j, pool.length - 1);
    [pool[i], pool[safe]] = [pool[safe], pool[i]];
  }
  return pool.slice(0, take).sort((a, b) => a - b);
}

/**
 * Resolve a spec into concrete selection fields.
 *
 * READ THE CALLER FIRST: this runs on the SERVER, inside `POST
 * /api/golden-sets`, against the live indices that route has just read. An
 * earlier draft had the browser call this and post `sampleIndices`; that design
 * was abandoned precisely because the client cannot enumerate live ordinals —
 * there is no GET on dataset samples — so it would have named rows that are not
 * there. The client sends `randomCount`/`randomPercent`; the server draws.
 *
 * The return shape is still the API's field shape rather than a bare array,
 * because the route feeds it back through the one code path that also serves
 * an explicit `sampleIndices` request.
 *
 * `rng` is injected so tests are deterministic; production passes
 * `Math.random`, which is the correct tool here — this is a sample, not a
 * secret, and reproducibility is provided by RECORDING the chosen indices
 * rather than by seeding.
 */
export function buildImportSelection(
  spec: SubsetSpec,
  availableIndices: readonly number[],
  rng: () => number = Math.random
): ImportSelection {
  if (spec.kind === 'all') return {};
  if (spec.kind === 'first') {
    return { limit: resolveCount(spec, availableIndices.length) };
  }

  const count = resolveCount(spec, availableIndices.length);
  // An empty dataset: `sampleIndices: []` fails the API's `.min(1)`, and {}
  // means "import all", which of nothing is also nothing. The latter is the
  // request that does not 400.
  if (count === 0) return {};
  return { sampleIndices: pickDistinct(availableIndices, count, rng) };
}
