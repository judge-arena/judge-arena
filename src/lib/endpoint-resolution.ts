/**
 * ─── Which ModelEndpoint row is THE endpoint for (user, judge version)? ──────
 *
 * ONE answer, used by the publisher and by the consumer, because they used to
 * give different ones.
 *
 * ── THE BUG THIS FILE EXISTS TO CLOSE ───────────────────────────────────────
 *
 * `ModelEndpoint` has `@@index([userId])` and `@@index([judgeModelVersionId])`
 * and NO `@@unique([userId, judgeModelVersionId])` (prisma/schema.prisma:295-316),
 * so several rows per (user, version) pair are legal. Two call sites then
 * picked from that set with different rules:
 *
 *   publisher  run-launch.ts `requireOwnedActiveEndpoints`
 *       where { userId, judgeModelVersionId: {in}, isActive: true,
 *               verifiedAt: { not: null } }           -- no ordering at all
 *   consumer   judgment-consumer.ts `resolveEndpoint`
 *       where { judgeModelVersionId, userId, isActive: true }   -- no verifiedAt
 *       orderBy { createdAt: 'asc' }                            -- oldest wins
 *
 * So the web tier could validate a launch against endpoint X while the worker
 * executed it against an older, unverified endpoint Y. Before lanes that was a
 * latent correctness/BYOK problem. WITH lanes it is also a routing problem: the
 * publisher derives the lane from the endpoint it resolved, and if the consumer
 * calls a different server, the judgment is serialized against the wrong box —
 * which is the exact over-subscription (`total_slots: 2`, four dead-lettered
 * items on 2026-08-31) that lanes exist to prevent. A lane computed from a row
 * nobody calls is worse than no lane, because the queue depth says it is
 * working.
 *
 * ── DECISION 1: verifiedAt IS A PREFERENCE HERE, NOT A FILTER ───────────────
 *
 * The obvious fix is to make both sides strict (require `verifiedAt`). I did
 * not, and the reason is that strictness in the CONSUMER refuses work that
 * runs today:
 *
 *   - `verifiedAt` starts NULL on every endpoint (model-catalog.ts:128,
 *     api/models/route.ts:140);
 *   - editing an endpoint CLEARS it (api/models/[id]/route.ts:82), as does a
 *     failed re-verify (api/models/[id]/verify/route.ts:74).
 *
 * So "user launches a run, then edits their endpoint's URL, then the worker
 * dequeues the judgment" is an ordinary sequence that produces an active,
 * unverified row and executes fine right now. A strict consumer turns every
 * one of those into `endpoint: null` — a failed judgment, retried and
 * dead-lettered, for a server that answers. Losing a judgment to a stale
 * verification flag is a worse failure than executing against an endpoint the
 * user has not re-verified since editing it.
 *
 * Instead: verified rows RANK ABOVE unverified ones, and nothing is excluded.
 * That is what actually kills the divergence, because the divergence was never
 * about strictness — it was about the two sides disagreeing on the row. With a
 * total order over the same candidate set, they cannot.
 *
 * ADMISSION CONTROL STAYS STRICT AND STAYS SEPARATE.
 * `requireOwnedActiveEndpoints` still refuses to launch a run unless a VERIFIED
 * active endpoint exists — see its own doc in run-launch.ts. Loosening that
 * would let a run launch against an endpoint that has never once been proven to
 * answer, which is a different (and real) protection. Note the two can never
 * disagree about the row: this ranking puts every verified row above every
 * unverified one, so "the winner is verified" is exactly equivalent to "a
 * verified row exists", which is the condition the gate tests.
 *
 * ── DECISION 2: OLDEST STILL WINS, AND ID BREAKS THE TIE ────────────────────
 *
 * `createdAt: 'asc'` — the consumer's existing rule — is a defensible answer to
 * "which of several endpoints is the real one" only by accident: there is no
 * sense in which the first endpoint a user configured is more current than the
 * one they added yesterday. Newest-first is the better RULE.
 *
 * It is not the better CHANGE. Flipping the order silently re-points every
 * judgment of every user who has more than one row for a pair at a different
 * server, with no migration, no warning, and no way to tell from the outside
 * that it happened. This commit's job is to make two call sites agree, not to
 * re-point live traffic; oldest-wins is therefore PRESERVED so that the row
 * chosen today is the row chosen tomorrow.
 *
 * What is added is a third key, `id: 'asc'`. `createdAt` is a `timestamp(3)` —
 * two rows written in the same millisecond (a seeder, an importer, a
 * double-submitted form) tie, and a tie means the DB's physical row order
 * decides, which is not stable across a VACUUM or a restore. A total order is
 * the whole point of this module, so it must actually be total.
 *
 * Every multi-row pair is logged at WARN when it is resolved (see
 * `rankCandidates`) — that is the "log the divergence loudly" half. The real
 * fix is `@@unique([userId, judgeModelVersionId])`, which needs a migration
 * plus a dedupe backfill for whatever is already out there, and is deliberately
 * not attempted here.
 *
 * ── BATCHING ────────────────────────────────────────────────────────────────
 *
 * Every publish site needs this for N judgments at once and must not issue N
 * queries. All three entry points below are the SAME query and the SAME
 * ranking; `resolveEndpointFor` is literally the batch of one, so a single-row
 * caller (the consumer) and a batched caller (the publishers) cannot drift
 * apart the way the two originals did.
 */
import type { ModelEndpoint } from '@prisma/client';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';

/** A (owner, judge version) pair — the composite identity `ModelEndpoint` is
 *  keyed on in every read path, and the thing the schema does not enforce
 *  uniqueness over. */
export interface EndpointOwnerVersion {
  userId: string;
  judgeModelVersionId: string;
}

/**
 * Lookup over a batch that was already fetched. Returns `null` for a pair with
 * no eligible endpoint AND for a pair that was never asked for — callers treat
 * both the same way (no endpoint resolved), and a lookup that threw on an
 * unknown key would turn a routing decision into an exception, which
 * `laneQueueFor`'s whole contract exists to avoid.
 */
export type EndpointLookup = (
  userId: string | null | undefined,
  judgeModelVersionId: string
) => ModelEndpoint | null;

/** Composite map key. Both halves are cuids (`[a-z0-9]+`), so a `|` separator
 *  cannot appear inside either half and cannot make two different pairs
 *  collide on one key. */
function pairKey(userId: string, judgeModelVersionId: string): string {
  return `${userId}|${judgeModelVersionId}`;
}

/**
 * THE selection rule, in one place. Verified before unverified; then oldest;
 * then lowest id so the order is total and stable (see DECISION 2).
 *
 * Mutates nothing — `candidates` is a fresh array per pair from `groupByPair`,
 * and the sort runs on a copy regardless.
 */
function rankCandidates(candidates: ModelEndpoint[]): ModelEndpoint | null {
  if (candidates.length === 0) return null;

  if (candidates.length > 1) {
    // The schema permits this and nothing warns about it anywhere else. It is
    // also the ONLY input under which the publisher and the consumer could
    // ever have disagreed, so it is worth a line in the log even now that they
    // cannot: it is the signal that the missing
    // @@unique([userId, judgeModelVersionId]) is being exercised in the wild.
    logger.warn(
      'endpoint-resolution: several active endpoints for one (user, judge version) — ' +
        'the schema permits it and there is no unique constraint; picking deterministically',
      {
        userId: candidates[0].userId,
        judgeModelVersionId: candidates[0].judgeModelVersionId,
        candidateCount: candidates.length,
      }
    );
  }

  const sorted = [...candidates].sort((a, b) => {
    const aUnverified = a.verifiedAt !== null ? 0 : 1;
    const bUnverified = b.verifiedAt !== null ? 0 : 1;
    if (aUnverified !== bUnverified) return aUnverified - bUnverified;
    const byCreated = a.createdAt.getTime() - b.createdAt.getTime();
    if (byCreated !== 0) return byCreated;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });

  return sorted[0];
}

function groupByPair(rows: ModelEndpoint[]): Map<string, ModelEndpoint[]> {
  const grouped = new Map<string, ModelEndpoint[]>();
  for (const row of rows) {
    const key = pairKey(row.userId, row.judgeModelVersionId);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(row);
    else grouped.set(key, [row]);
  }
  return grouped;
}

/**
 * Resolve endpoints for arbitrary (user, version) pairs in ONE query.
 *
 * The query is the CROSS PRODUCT of the distinct users and the distinct
 * versions, narrowed back to the requested pairs in memory. That over-fetches
 * by definition, and it is still the right shape here: the alternative is an
 * `OR` of N pair predicates, which grows the statement with the batch. The
 * over-fetch is bounded by rows a user actually owns (a handful), the callers
 * batch over one sweep or one run, and surplus rows are discarded before
 * ranking so they cannot influence any answer.
 */
export async function resolveEndpointsForPairs(pairs: EndpointOwnerVersion[]): Promise<EndpointLookup> {
  const wanted = new Set(pairs.map((p) => pairKey(p.userId, p.judgeModelVersionId)));
  if (wanted.size === 0) return () => null;

  const rows = await prisma.modelEndpoint.findMany({
    where: {
      userId: { in: [...new Set(pairs.map((p) => p.userId))] },
      judgeModelVersionId: { in: [...new Set(pairs.map((p) => p.judgeModelVersionId))] },
      isActive: true,
    },
  });

  const grouped = groupByPair(
    rows.filter((row) => wanted.has(pairKey(row.userId, row.judgeModelVersionId)))
  );
  const resolved = new Map<string, ModelEndpoint | null>();
  for (const [key, candidates] of grouped) resolved.set(key, rankCandidates(candidates));

  return (userId, judgeModelVersionId) => {
    if (!userId) return null;
    return resolved.get(pairKey(userId, judgeModelVersionId)) ?? null;
  };
}

/**
 * One user, many versions — the shape both publishers need (a run and a
 * `run.create` expansion are single-user by construction).
 *
 * Every requested id is present in the returned map, with `null` where nothing
 * resolved, so a caller can iterate the map instead of remembering to
 * null-check a missing key.
 */
export async function resolveEndpointsForVersions(
  userId: string | null | undefined,
  judgeModelVersionIds: string[]
): Promise<Map<string, ModelEndpoint | null>> {
  const ids = [...new Set(judgeModelVersionIds)];
  const resolved = new Map<string, ModelEndpoint | null>(ids.map((id) => [id, null]));
  if (!userId || ids.length === 0) return resolved;

  const lookup = await resolveEndpointsForPairs(ids.map((id) => ({ userId, judgeModelVersionId: id })));
  for (const id of ids) resolved.set(id, lookup(userId, id));
  return resolved;
}

/**
 * The single-pair entry point — what `src/worker/judgment-consumer.ts`'s
 * `resolveEndpoint` becomes.
 *
 * `userId` is nullable on purpose: `EvaluationRun.triggeredById` is nullable,
 * and a run with no owner has by definition no "their own" endpoint, so this
 * returns `null` immediately rather than falling back to somebody else's — the
 * Task 12 no-cross-user-borrow rule, preserved exactly.
 */
export async function resolveEndpointFor(
  userId: string | null | undefined,
  judgeModelVersionId: string
): Promise<ModelEndpoint | null> {
  const resolved = await resolveEndpointsForVersions(userId, [judgeModelVersionId]);
  return resolved.get(judgeModelVersionId) ?? null;
}
