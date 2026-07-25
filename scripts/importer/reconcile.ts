/**
 * Importer phase — reconciliation report + verification gate.
 *
 * `reconcile(ctx, ids)` runs AFTER every write phase (./owners, ./judges,
 * ./artifacts, ./runs) has executed in `apply` mode. It is the code-level
 * form of the program doc's cutover abort criterion (architecture spec §8):
 * "row-count reconciliation per entity + provenance spot-checks + leaderboard
 * before/after diff... If local verification fails, cutover is blocked —
 * not patched live." `cli.ts` enforces that by exiting non-zero when
 * `reconcile(...).ok` is `false`.
 *
 * Every row-count / spot-check query here is INDEPENDENT of the in-memory
 * bookkeeping that produced it where possible: `v2` counts and spot-check
 * queries always re-read the live v2 database fresh (never trust "what the
 * import phases said they did" for the actual outcome), while the "expected"
 * side is derived from v1 data + `ctx.report`'s tallies + the `ids` maps
 * `importArtifacts` already produced — never by re-deriving ownership/drop
 * POLICY (which phase gets to decide who's dropped/archived) here. This is
 * what makes the check meaningful rather than tautological: a bug that
 * silently deletes/corrupts a v2 row after the fact (exactly what the
 * fixture-mismatch tests in reconcile.db.test.ts simulate) is caught because
 * the "expected" side never re-reads the tampered table.
 *
 * ── Row-count formula per entity ────────────────────────────────────────
 * `ok = (v1 - expectedDelta === v2)`; for the three "synthesis" entities
 * (JudgeModel/JudgeModelVersion/ModelEndpoint, which don't have a 1:1 v1
 * counterpart table) `expectedDelta` is always `0` and `v1` IS the computed
 * expected count, so the formula reduces to `ok = (expected === v2)`.
 *
 *   - Project/Rubric/RubricCriterion/Dataset/DatasetSample/Evaluation: the
 *     `ids: IdMaps` param IS the exact bookkeeping of "which v1 rows of this
 *     type survived importArtifacts" (one key per kept v1 id, see
 *     ./artifacts.ts) — `expectedDelta = v1Count - ids.<map>.size`. This is
 *     the most direct source available (no re-derivation of the
 *     public/private/isDefault/archive policy that decided the map's
 *     contents) and, as a side effect, correctly SURFACES the "KNOWN
 *     LIMITATION" ./artifacts.ts's own module doc flags: if two distinct v1
 *     rows collide onto the same v2 row via a content-match key (e.g. two
 *     identically-named root Rubrics), `ids.rubric.size` still counts both
 *     v1 keys, so `expectedDelta` under-counts and this check correctly
 *     flags `ok:false` — that collision class is exactly what row-count
 *     reconciliation exists to catch, not paper over.
 *   - EvaluationRun/ModelJudgment/HumanJudgment: no id-map is threaded this
 *     far (./runs.ts returns `void`), so `expectedDelta = ctx.report`'s own
 *     `dropped` tally for that entity — accurate here because every drop
 *     path for these three entities is a structural cascade (dropped
 *     evaluation -> dropped run -> dropped judgments/human judgment, see
 *     ./runs.ts) that IS tallied under `dropped` with no untallied gap,
 *     unlike User below. (The separate `ModelJudgmentCriteriaScoresMalformed`
 *     / `*CriteriaUnmapped` tallies live under different report keys and
 *     never affect these three entities' own row counts — they degrade a
 *     row's `criteriaScores` field, they don't drop the row.)
 *   - User: NEITHER of the above applies cleanly. `resolveOwners` (see
 *     ./owners.ts) only tallies `User`/`dropped` for an EXPLICIT `'drop'`
 *     ownerMap entry, not for a v1 user simply absent from `ownerMap`
 *     entirely (both are treated identically downstream, but only the
 *     former is tallied) — and multiple v1 users mapped to `'archive'`
 *     collapse onto ONE shared v2 row (cached per `resolveOwners` call), so
 *     a naive `v1UserCount - report.User.dropped` both over-and-under-counts
 *     depending on the data. Instead: `expected = (distinct mapped
 *     (oidcIssuer,oidcSubject) pairs in ctx.ownerMap) + (1 if the archive
 *     user actually exists in v2, else 0)`. The archive-existence check
 *     queries v2 directly (by its well-known email) rather than trying to
 *     infer "was archive needed" from `ownerMap` alone (that would require
 *     re-deriving every phase's public/private fallback policy) — this is
 *     an observation of a fact ("does this one well-known row exist"), not
 *     a re-implementation of who-gets-archived policy.
 *   - ModelConfig: v2 rows are NOT a 1:1 import of v1 ModelConfig at all —
 *     v1 ModelConfig is replaced by JudgeModel/JudgeModelVersion (see
 *     ./judges.ts), and a v2 ModelConfig row is only ever "ensured" (see
 *     ./runs.ts's `ensureModelConfig`) as a byproduct of a SURVIVING
 *     ModelJudgment/HumanJudgment that references it — most v1 ModelConfig
 *     rows never materialize in v2 regardless of their owner's drop status.
 *     `ensureModelConfig` dedupes per distinct v1 ModelConfig id via an
 *     in-call cache, tallying `ModelConfig`/`created` or `/skipped` exactly
 *     ONCE per distinct v1 id ever passed to it — so
 *     `report.ModelConfig.created + report.ModelConfig.skipped` equals
 *     "count of distinct v1 ModelConfig ids referenced by a surviving
 *     judgment", independent of the real-time v2 row count.
 *     `expectedDelta = v1ModelConfigCount - thatSum`. KNOWN LIMITATION
 *     (shared with the collision class above): if two distinct v1
 *     ModelConfig ids resolve to the SAME `(userId, provider, modelId,
 *     endpoint)` ensure-key within one run (e.g. two dropped users' configs,
 *     both referenced, both falling back to the same archive owner, with
 *     identical provider/modelId/endpoint), they legitimately collapse onto
 *     ONE v2 row — indistinguishable, from the tally alone, from an actual
 *     missing row.
 *   - JudgeModel/JudgeModelVersion: one of each per distinct v1
 *     `(provider, modelId, endpoint ?? '')` triple (./judges.ts's own
 *     grouping key, recomputed here directly from `ctx.v1.modelConfig` —
 *     unconditional on ownership, since a triple's JudgeModel/Version is
 *     created even when every owner of that triple is dropped).
 *   - ModelEndpoint: one per distinct (triple, v1 userId) pair whose v1
 *     userId is KEPT — i.e. `ctx.ownerMap[userId]` exists and isn't
 *     `'drop'` (exactly ./judges.ts's own endpoint-creation condition,
 *     recomputed directly from `ctx.v1.modelConfig` + `ctx.ownerMap`,
 *     never from a resolved `owners` map this function isn't handed).
 *
 * ── Spot checks ──────────────────────────────────────────────────────────
 * See the four `spotCheck*` functions below; each is documented at its own
 * definition.
 */
import type { ImportCtx, OwnerMap } from './context';
import type { IdMaps } from './artifacts';
import { ARCHIVE_USER_EMAIL } from './owners';

export interface RowCount {
  entity: string;
  v1: number;
  v2: number;
  expectedDelta: number;
  ok: boolean;
}

export interface SpotCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ReconcileResult {
  rowCounts: RowCount[];
  spotChecks: SpotCheck[];
  ok: boolean;
  /** Non-gating tallies worth surfacing at the go/no-go decision point (e.g.
   * malformed-criteriaScores degradations) — never affects `ok`. */
  warnings: string[];
}

type MappedOwner = Extract<OwnerMap[string], { email: string }>;

function rowCount(entity: string, v1: number, v2: number, expectedDelta: number): RowCount {
  return { entity, v1, v2, expectedDelta, ok: v1 - expectedDelta === v2 };
}

function droppedTally(ctx: ImportCtx, entity: string): number {
  return ctx.report.counts()[entity]?.dropped ?? 0;
}

// ─── Row counts: simple v1-count-minus-dropped-tally entities ─────────────

async function rowCountSimple(
  ctx: ImportCtx,
  entity: string,
  v1Count: () => Promise<number>,
  v2Count: () => Promise<number>
): Promise<RowCount> {
  const [v1, v2] = await Promise.all([v1Count(), v2Count()]);
  return rowCount(entity, v1, v2, droppedTally(ctx, entity));
}

// ─── Row counts: entities with an IdMaps entry from ./artifacts.ts ────────

async function rowCountFromIds(
  entity: string,
  idMapSize: number,
  v1Count: () => Promise<number>,
  v2Count: () => Promise<number>
): Promise<RowCount> {
  const [v1, v2] = await Promise.all([v1Count(), v2Count()]);
  return rowCount(entity, v1, v2, v1 - idMapSize);
}

// ─── Row count: User (see module doc) ──────────────────────────────────────

async function rowCountUser(ctx: ImportCtx): Promise<RowCount> {
  const mappedKeys = new Set<string>();
  for (const mapping of Object.values(ctx.ownerMap)) {
    if (mapping === 'drop' || mapping === 'archive') continue;
    mappedKeys.add(`${mapping.oidcIssuer}|${mapping.oidcSubject}`);
  }

  const [v1, v2, archiveUser] = await Promise.all([
    ctx.v1.user.count(),
    ctx.v2.user.count(),
    ctx.v2.user.findUnique({ where: { email: ARCHIVE_USER_EMAIL } }),
  ]);

  const expectedV2 = mappedKeys.size + (archiveUser ? 1 : 0);
  return rowCount('User', v1, v2, v1 - expectedV2);
}

// ─── Row count: ModelConfig (see module doc) ───────────────────────────────

async function rowCountModelConfig(ctx: ImportCtx): Promise<RowCount> {
  const [v1, v2] = await Promise.all([ctx.v1.modelConfig.count(), ctx.v2.modelConfig.count()]);
  const counts = ctx.report.counts().ModelConfig;
  const referenced = (counts?.created ?? 0) + (counts?.skipped ?? 0);
  return rowCount('ModelConfig', v1, v2, v1 - referenced);
}

// ─── Row counts: JudgeModel / JudgeModelVersion / ModelEndpoint (synthesis) ─

/** Mirrors ./judges.ts's own grouping key exactly. */
function tripleKey(provider: string, modelId: string, endpoint: string | null): string {
  return `${provider} ${modelId} ${endpoint ?? ''}`;
}

async function rowCountsJudgeSynthesis(ctx: ImportCtx): Promise<RowCount[]> {
  const configs = await ctx.v1.modelConfig.findMany({
    select: { provider: true, modelId: true, endpoint: true, userId: true },
  });

  const triples = new Set<string>();
  const keptEndpointPairs = new Set<string>();
  for (const config of configs) {
    const key = tripleKey(config.provider, config.modelId, config.endpoint);
    triples.add(key);

    // Mirrors ./judges.ts's endpoint-creation condition: an owner is "kept"
    // iff its ownerMap entry exists and isn't 'drop' — never re-derives the
    // resolved owners Map itself, just the same yes/no this function's
    // caller already has visible on ctx.ownerMap.
    const disposition = ctx.ownerMap[config.userId];
    const kept = disposition !== undefined && disposition !== 'drop';
    if (kept) keptEndpointPairs.add(`${key}::${config.userId}`);
  }

  const [judgeModelCount, versionCount, endpointCount] = await Promise.all([
    ctx.v2.judgeModel.count(),
    ctx.v2.judgeModelVersion.count(),
    ctx.v2.modelEndpoint.count(),
  ]);

  return [
    rowCount('JudgeModel', triples.size, judgeModelCount, 0),
    rowCount('JudgeModelVersion', triples.size, versionCount, 0),
    rowCount('ModelEndpoint', keptEndpointPairs.size, endpointCount, 0),
  ];
}

// ─── Row counts: entry point ────────────────────────────────────────────────

async function computeRowCounts(ctx: ImportCtx, ids: IdMaps): Promise<RowCount[]> {
  const [userRow, judgeSynthesisRows, modelConfigRow, projectRow, rubricRow, criterionRow, datasetRow, sampleRow, evaluationRow, runRow, judgmentRow, humanJudgmentRow] =
    await Promise.all([
      rowCountUser(ctx),
      rowCountsJudgeSynthesis(ctx),
      rowCountModelConfig(ctx),
      rowCountFromIds('Project', ids.project.size, () => ctx.v1.project.count(), () => ctx.v2.project.count()),
      rowCountFromIds('Rubric', ids.rubric.size, () => ctx.v1.rubric.count(), () => ctx.v2.rubric.count()),
      rowCountFromIds(
        'RubricCriterion',
        ids.criterion.size,
        () => ctx.v1.rubricCriterion.count(),
        () => ctx.v2.rubricCriterion.count()
      ),
      rowCountFromIds('Dataset', ids.dataset.size, () => ctx.v1.dataset.count(), () => ctx.v2.dataset.count()),
      rowCountFromIds(
        'DatasetSample',
        ids.sample.size,
        () => ctx.v1.datasetSample.count(),
        () => ctx.v2.datasetSample.count()
      ),
      rowCountFromIds(
        'Evaluation',
        ids.evaluation.size,
        () => ctx.v1.evaluation.count(),
        () => ctx.v2.evaluation.count()
      ),
      rowCountSimple(ctx, 'EvaluationRun', () => ctx.v1.evaluationRun.count(), () => ctx.v2.evaluationRun.count()),
      rowCountSimple(ctx, 'ModelJudgment', () => ctx.v1.modelJudgment.count(), () => ctx.v2.modelJudgment.count()),
      rowCountSimple(ctx, 'HumanJudgment', () => ctx.v1.humanJudgment.count(), () => ctx.v2.humanJudgment.count()),
    ]);

  const [judgeModelRow, judgeModelVersionRow, modelEndpointRow] = judgeSynthesisRows;

  // Canonical order per the task brief's entity list.
  return [
    userRow,
    judgeModelRow,
    judgeModelVersionRow,
    modelEndpointRow,
    modelConfigRow,
    projectRow,
    rubricRow,
    criterionRow,
    datasetRow,
    sampleRow,
    evaluationRow,
    runRow,
    judgmentRow,
    humanJudgmentRow,
  ];
}

// ─── Spot check 1: judgment provenance completeness ────────────────────────

/** Every v2 ModelJudgment must record which judge version and which prompt
 * template produced it (architecture spec S2: "exactly which judge... which
 * prompt template... produced this score?"). A row missing either means
 * ./runs.ts wrote a judgment without provenance — a hard bug, not a policy
 * edge case (both columns are populated unconditionally by
 * `findOrCreateModelJudgment` for every row it creates). */
async function spotCheckProvenanceComplete(ctx: ImportCtx): Promise<SpotCheck> {
  const count = await ctx.v2.modelJudgment.count({
    where: { OR: [{ judgeModelVersionId: null }, { promptTemplateId: null }] },
  });
  return {
    name: 'judgment-provenance-complete',
    ok: count === 0,
    detail: `${count} v2 ModelJudgment row(s) missing judgeModelVersionId and/or promptTemplateId`,
  };
}

// ─── Spot check 2: criteriaScores criterionId references resolve ──────────

/** No v2 ModelJudgment's `criteriaScores` JSON array may contain a non-null
 * `criterionId` that doesn't correspond to a real RubricCriterion row.
 * Deliberately excludes entries where `criterionId` is null: that's the
 * INTENTIONAL degradation `remapCriteriaScores` (./runs.ts) applies to a v1
 * entry whose criterion didn't survive — a documented, tallied outcome, not
 * a bug. Raw SQL (`jsonb_array_elements` + `LEFT JOIN`) since this predicate
 * has no direct Prisma equivalent over a JSON array column. */
async function spotCheckCriteriaIdsResolve(ctx: ImportCtx): Promise<SpotCheck> {
  const rows = await ctx.v2.$queryRaw<Array<{ count: number }>>`
    SELECT count(DISTINCT mj.id)::int AS count
    FROM "ModelJudgment" mj
    CROSS JOIN LATERAL jsonb_array_elements(mj."criteriaScores") AS elem
    LEFT JOIN "RubricCriterion" rc ON rc.id = (elem->>'criterionId')
    WHERE elem->>'criterionId' IS NOT NULL
      AND rc.id IS NULL
  `;
  const count = rows[0]?.count ?? 0;
  return {
    name: 'criteria-ids-resolve',
    ok: count === 0,
    detail: `${count} v2 ModelJudgment row(s) with a non-null criteriaScores criterionId absent from RubricCriterion`,
  };
}

// ─── Spot check 3: leaderboard aggregate explainability ────────────────────

interface ModelAgg {
  count: number;
  avg: number | null;
}

/** Groups by `(provider, modelId)` — the coarsest identity common to both
 * schemas, avoiding any need to resolve v1 ModelConfig ids to their v2
 * "ensured" shadow-row counterparts (see ./runs.ts's `ensureModelConfig`).
 * Mirrors src/app/api/leaderboard/route.ts's own aggregate formula: average
 * `overallScore` across judgments with `status: 'completed'` and a non-null
 * score. */
function aggregateByProviderModel(
  rows: Array<{ overallScore: number | null; modelConfig: { provider: string; modelId: string } }>
): Map<string, ModelAgg> {
  const sums = new Map<string, { count: number; sum: number }>();
  for (const r of rows) {
    if (r.overallScore === null) continue;
    const key = `${r.modelConfig.provider}/${r.modelConfig.modelId}`;
    const entry = sums.get(key) ?? { count: 0, sum: 0 };
    entry.count += 1;
    entry.sum += r.overallScore;
    sums.set(key, entry);
  }
  const out = new Map<string, ModelAgg>();
  for (const [key, { count, sum }] of sums) {
    out.set(key, { count, avg: count > 0 ? sum / count : null });
  }
  return out;
}

/** "Explainable, not equal" (per the task brief): v2's per-model judgment
 * count can never EXCEED v1's for the same `(provider, modelId)` (v2 only
 * ever drops judgments via structural cascade, never invents new ones), and
 * the aggregate shortfall across ALL models must be covered by the total
 * `ModelJudgment` `dropped` tally (an upper bound — that tally counts every
 * dropped judgment regardless of its own v1 status/score, a strict superset
 * of "completed judgments that dropped out of this aggregate"). Both v1 and
 * v2 numbers are reported in `detail` per model, exactly as the brief asks
 * ("report both numbers") — iterating the UNION of v1's and v2's aggregate
 * keys (not just v2's) so a model whose ENTIRE v1 judgment population
 * vanished (v2 count 0) still gets its own detail line instead of silently
 * disappearing from the report; each line also carries a per-model
 * `drop-explained` flag (that model's own shortfall checked against the
 * same total `dropped` tally used for `totalOk`) so a fully-vanished model
 * reads as accounted-for rather than as an unexplained gap. */
async function spotCheckLeaderboardExplainable(ctx: ImportCtx): Promise<SpotCheck> {
  const where = { status: 'completed' as const, overallScore: { not: null } };
  const select = { overallScore: true, modelConfig: { select: { provider: true, modelId: true } } } as const;

  const [v1Rows, v2Rows] = await Promise.all([
    ctx.v1.modelJudgment.findMany({ where, select }),
    ctx.v2.modelJudgment.findMany({ where, select }),
  ]);

  const v1Agg = aggregateByProviderModel(v1Rows);
  const v2Agg = aggregateByProviderModel(v2Rows);
  const droppedJudgments = droppedTally(ctx, 'ModelJudgment');

  let perModelOk = true;
  const lines: string[] = [];
  const allKeys = new Set<string>([...v1Agg.keys(), ...v2Agg.keys()]);
  for (const key of allKeys) {
    const v1Stat = v1Agg.get(key);
    const v2Stat = v2Agg.get(key);
    const v1Count = v1Stat?.count ?? 0;
    const v2Count = v2Stat?.count ?? 0;
    if (v2Count > v1Count) perModelOk = false;

    const shortfall = v1Count - v2Count;
    const shortfallNote = shortfall > 0 ? ` shortfall=${shortfall} drop-explained=${shortfall <= droppedJudgments}` : '';
    lines.push(
      `${key}: v1(n=${v1Count},avg=${v1Stat?.avg?.toFixed(2) ?? '-'}) v2(n=${v2Count},avg=${v2Stat?.avg?.toFixed(2) ?? '-'})${shortfallNote}`
    );
  }

  const totalV1 = v1Rows.length;
  const totalV2 = v2Rows.length;
  const totalOk = totalV1 - totalV2 <= droppedJudgments;

  const modelSummary = lines.length > 0 ? `${lines.join('; ')}; ` : '';
  return {
    name: 'leaderboard-explainable',
    ok: perModelOk && totalOk,
    detail: `${modelSummary}totals: v1=${totalV1} v2=${totalV2} ModelJudgment.dropped=${droppedJudgments}`,
  };
}

// ─── Spot check 4: no v1 owner leakage ──────────────────────────────────────

const OWNED_TABLES = ['Project', 'Rubric', 'Dataset', 'Evaluation', 'HumanJudgment', 'ModelConfig', 'ModelEndpoint'] as const;

/** Two guards in one check, per the task's binding semantics:
 *   (a) no v2 User row exists with the same email as a "dropped" v1 user —
 *       where dropped means EITHER an explicit `'drop'` ownerMap entry OR a
 *       v1 user simply ABSENT from ownerMap entirely. Both are treated
 *       identically by every downstream import phase (see ./owners.ts: a
 *       missing key is "drop this user's private data / archive their
 *       public data", same as an explicit `'drop'`), and the real cutover
 *       ownerMap is a small, pre-provisioned "kept" allowlist — most v1
 *       users are dropped by absence, not by an explicit entry — so
 *       checking only explicit `'drop'` entries would miss the vast
 *       majority of dropped identities. A dropped user's identity must
 *       never resurface under its own email (which would silently un-drop
 *       it, including via an in-place rename of an unrelated kept v2 row —
 *       this checks by email existence, not by a row-count delta, so a
 *       rename that leaves the total v2 User count unchanged is still
 *       caught).
 *   (b) no row in any user-owned v2 table references a userId outside the
 *       set of {v2 users resolved from a mapped ownerMap entry} ∪ {the
 *       archive user, if it exists} — the only two ways this importer ever
 *       attributes a v2 row to a user (see ./owners.ts). Postgres FK
 *       constraints already guarantee every `userId` references SOME real
 *       User row; this check additionally verifies that row is one of the
 *       importer's own legitimate targets, not an unexpected one. */
async function spotCheckNoOwnerLeakage(ctx: ImportCtx): Promise<SpotCheck> {
  // "Kept" = has a mapped (object) ownerMap entry; "archived" = mapped to
  // 'archive' (collapses onto the shared archive user, a legitimate
  // identity of its own, not a dropped one). Everything else — explicit
  // 'drop' AND absence from ownerMap altogether — is "dropped" for (a).
  const keptV1UserIds = new Set<string>();
  const archivedV1UserIds = new Set<string>();
  for (const [v1UserId, mapping] of Object.entries(ctx.ownerMap)) {
    if (mapping === 'archive') {
      archivedV1UserIds.add(v1UserId);
    } else if (mapping !== 'drop') {
      keptV1UserIds.add(v1UserId);
    }
  }

  const mappedOidcPairs = Object.values(ctx.ownerMap).filter(
    (m): m is MappedOwner => typeof m === 'object'
  );

  // Absence can only be detected against the FULL v1 user table — ownerMap
  // alone can never tell you who it left out.
  const [allV1Users, mappedV2Users, archiveUser] = await Promise.all([
    ctx.v1.user.findMany({ select: { id: true, email: true } }),
    mappedOidcPairs.length > 0
      ? ctx.v2.user.findMany({
          where: { OR: mappedOidcPairs.map((m) => ({ oidcIssuer: m.oidcIssuer, oidcSubject: m.oidcSubject })) },
          select: { id: true },
        })
      : Promise.resolve([]),
    ctx.v2.user.findUnique({ where: { email: ARCHIVE_USER_EMAIL } }),
  ]);

  const droppedEmails = allV1Users
    .filter((u) => !keptV1UserIds.has(u.id) && !archivedV1UserIds.has(u.id))
    .map((u) => u.email);
  const leakedDroppedUsers =
    droppedEmails.length > 0 ? await ctx.v2.user.count({ where: { email: { in: droppedEmails } } }) : 0;

  const validIds = mappedV2Users.map((u) => u.id);
  if (archiveUser) validIds.push(archiveUser.id);

  const leakCounts = await Promise.all([
    ctx.v2.project.count({ where: { userId: { notIn: validIds } } }),
    ctx.v2.rubric.count({ where: { userId: { notIn: validIds } } }),
    ctx.v2.dataset.count({ where: { userId: { notIn: validIds } } }),
    ctx.v2.evaluation.count({ where: { userId: { notIn: validIds } } }),
    ctx.v2.humanJudgment.count({ where: { userId: { notIn: validIds } } }),
    ctx.v2.modelConfig.count({ where: { userId: { notIn: validIds } } }),
    ctx.v2.modelEndpoint.count({ where: { userId: { notIn: validIds } } }),
  ]);

  const totalLeak = leakCounts.reduce((a, b) => a + b, 0);
  const leakedTables = OWNED_TABLES.map((name, i) => (leakCounts[i] > 0 ? `${name}:${leakCounts[i]}` : null)).filter(
    (x): x is string => x !== null
  );

  return {
    name: 'no-v1-owner-leakage',
    ok: leakedDroppedUsers === 0 && totalLeak === 0,
    detail:
      `${leakedDroppedUsers} dropped-user email(s) leaked into v2 User; ` +
      `${totalLeak} owned row(s) reference a user outside the owners∪archive set` +
      (leakedTables.length > 0 ? ` (${leakedTables.join(', ')})` : ''),
  };
}

// ─── Warnings: non-gating tallies worth surfacing at go/no-go ──────────────

/** `./runs.ts`'s `remapCriteriaScores` tallies a malformed (non-JSON, or
 * JSON-but-not-an-array) v1 `criteriaScores` payload under
 * `${entity}CriteriaScoresMalformed`/`dropped` (e.g.
 * `ModelJudgmentCriteriaScoresMalformed`, `HumanJudgmentCriteriaScoresMalformed`)
 * — the row itself is still imported (never dropped), only its
 * `criteriaScores` field is degraded to `[]`/`null`. That's a deliberately
 * NON-gating outcome (the row survives, so no rowCount/spotCheck reflects
 * it), but it's still worth surfacing at the go/no-go decision point rather
 * than only in a `console.warn` line buried in mid-run output — an operator
 * deciding whether to proceed should see it without having to scroll back
 * through the whole import log. */
function computeWarnings(ctx: ImportCtx): string[] {
  const warnings: string[] = [];
  for (const [key, tally] of Object.entries(ctx.report.counts())) {
    const match = key.match(/^(.*)CriteriaScoresMalformed$/);
    if (!match) continue;
    const n = tally.dropped ?? 0;
    if (n > 0) {
      warnings.push(`WARNING: ${n} ${match[1]} rows imported with malformed criteriaScores degraded to []`);
    }
  }
  return warnings;
}

// ─── Entry point ────────────────────────────────────────────────────────────

export async function reconcile(ctx: ImportCtx, ids: IdMaps): Promise<ReconcileResult> {
  const [rowCounts, spotChecks] = await Promise.all([
    computeRowCounts(ctx, ids),
    Promise.all([
      spotCheckProvenanceComplete(ctx),
      spotCheckCriteriaIdsResolve(ctx),
      spotCheckLeaderboardExplainable(ctx),
      spotCheckNoOwnerLeakage(ctx),
    ]),
  ]);

  const ok = rowCounts.every((r) => r.ok) && spotChecks.every((s) => s.ok);
  const warnings = computeWarnings(ctx);
  return { rowCounts, spotChecks, ok, warnings };
}

// ─── Human-readable report table ────────────────────────────────────────────

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function padLeft(value: string, width: number): string {
  return value.length >= width ? value : ' '.repeat(width - value.length) + value;
}

/** Plain-console, aligned-column report of a ReconcileResult — printed by
 * `cli.ts` after an apply-mode run. Pure formatting, no I/O of its own. */
export function formatReconcileReport(result: ReconcileResult): string {
  const lines: string[] = [];
  lines.push('=== Importer Reconciliation Report ===', '');

  lines.push('Row counts:');
  const entityWidth = Math.max(6, ...result.rowCounts.map((r) => r.entity.length));
  lines.push(
    `  ${pad('Entity', entityWidth)}   ${padLeft('v1', 6)}   ${padLeft('v2', 6)}   ${padLeft('ExpDelta', 8)}   OK`
  );
  for (const r of result.rowCounts) {
    lines.push(
      `  ${pad(r.entity, entityWidth)}   ${padLeft(String(r.v1), 6)}   ${padLeft(String(r.v2), 6)}   ` +
        `${padLeft(String(r.expectedDelta), 8)}   ${r.ok ? 'OK' : 'FAIL'}`
    );
  }

  lines.push('', 'Spot checks:');
  const nameWidth = Math.max(4, ...result.spotChecks.map((s) => s.name.length));
  for (const s of result.spotChecks) {
    lines.push(`  [${s.ok ? 'OK  ' : 'FAIL'}] ${pad(s.name, nameWidth)}   ${s.detail}`);
  }

  if (result.warnings.length > 0) {
    lines.push('', 'Warnings:');
    for (const w of result.warnings) {
      lines.push(`  ${w}`);
    }
  }

  lines.push('', `Overall: ${result.ok ? 'OK' : 'FAILED'}`);
  return lines.join('\n');
}
