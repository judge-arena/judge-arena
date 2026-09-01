/**
 * ─── Queue lanes: which judgments may run at the same time ──────────────────
 *
 * A judgment is serialized against every other judgment that targets THE SAME
 * INFERENCE SERVER, and against nothing else.
 *
 * ── WHY THE SERVER, AND NOT THE MODEL OR THE DATASET ────────────────────────
 *
 * The failure this prevents is a server-slot property. On 2026-08-31 a
 * calibration ran with AMQP prefetch 8 against a llama.cpp box advertising
 * `total_slots: 2`; requests three through eight queued INSIDE the server while
 * their client-side timeout ran, and four of thirty items dead-lettered with
 * `timed out after 300000ms` — while judgments that completed averaged 94s
 * against a 300s ceiling. The model was never slow. The queue was in the wrong
 * place.
 *
 * So the domain is neither the model nor `(dataset, model)`:
 *   - `(dataset_1, model_1)` and `(dataset_2, model_1)` are DIFFERENT keys under
 *     a `(dataset, model)` scheme and would run concurrently — against one
 *     server. That is a regression, not an improvement.
 *   - `granite4.1:3b` and `gemma4:26b` are different MODELS on one Ollama host
 *     (192.168.1.9:11434). Keying per model over-subscribes that host too.
 *
 * It is also not `ModelEndpoint.id`: that row is per-USER (BYOK), so two users
 * pointing at the same box would get two lanes and contend. The normalized
 * ORIGIN is the thing a server actually is.
 *
 * ── WHY A TABLE AND NOT A HASH ──────────────────────────────────────────────
 *
 * Consistent hashing into N shards has a birthday problem, and at this scale it
 * is not a tail risk: with TWO origins and 32 shards there is a ~3% chance both
 * land on the same shard — in which case this entire mechanism ships and
 * changes nothing, silently, permanently, and undetectably from shard depth.
 *
 * The key space is tiny and slow-moving (2 servers today; perhaps 10 in a
 * year), so the assignment is RECORDED rather than computed. `QueueLane.id` is
 * the assignment order and the lane is `(id - 1) % LANE_COUNT`. That buys:
 *   - zero collisions for the first LANE_COUNT origins — always, not usually;
 *   - a nearly-free capacity increase, because `(id-1) % 8 == (id-1) % 32` for
 *     `id <= 8`, so raising LANE_COUNT leaves existing origins on their exact
 *     lane and moves only new ones (a consistent hash reshuffles a fraction of
 *     ALL keys);
 *   - an answer to "what is on lane 5" and "who is starved" that is a SELECT.
 *
 * ── THE CACHE IS SAFE BECAUSE ASSIGNMENT IS PERMANENT ───────────────────────
 *
 * Rows are never updated and never deleted, so a cached `laneKey -> id` can
 * never go stale. That is the property that makes an unbounded process-local
 * Map acceptable here; if rows ever became mutable this cache becomes a bug.
 */
import { prisma } from '@/lib/db';

/**
 * How many lane queues exist. Bounded on purpose: each lane is a durable quorum
 * queue with its own consumer on a single worker replica, and the number is
 * baked into `assertTopology` and into the worker's expected-consumer count, so
 * a mismatch is a boot-time failure rather than a silent gap.
 *
 * Raising it is additive — see the module doc on why existing origins do not
 * move — but it must be raised in the topology and the worker together.
 */
export const LANE_COUNT = 8;

/**
 * Where a judgment goes when its lane cannot be determined: the ORIGINAL
 * `judgment.execute` queue, which is kept and consumed forever.
 *
 * This is deliberate and load-bearing for the migration. Publishers that have
 * not been taught about lanes, messages already in flight when lanes deploy,
 * and any future path that fails to resolve an endpoint all keep working —
 * they simply do not get lane isolation. Retiring this queue would turn every
 * such case into a lost judgment.
 */
export const LANE_FALLBACK_QUEUE = 'judgment.execute';

export function laneQueue(index: number): string {
  return `judgment.execute.lane.${index}`;
}

/** Every lane queue name, in index order. */
export const LANE_QUEUES: readonly string[] = Array.from({ length: LANE_COUNT }, (_, i) => laneQueue(i));

/**
 * The serialization domain for a judge, as a stable string.
 *
 * `null`/empty endpoint means the judge has no self-hosted server — an elastic
 * hosted API (Anthropic, OpenAI, OpenRouter). Those are rate-limited, not
 * slot-limited, so they need no server-level serialization; keying them by
 * version keeps each one in its own lane rather than piling every hosted judge
 * into one shared lane, which would serialize providers that never needed it.
 */
export function laneKeyFor(endpointUrl: string | null | undefined, judgeModelVersionId: string): string {
  const origin = endpointUrl ? normalizeOrigin(endpointUrl) : null;
  return origin ?? `version:${judgeModelVersionId}`;
}

/**
 * Reduce an endpoint URL to the server it names: lowercase scheme and host, an
 * EXPLICIT port, and nothing else.
 *
 * The path is dropped on purpose. `http://h:11434/v1` and `http://h:11434/v1/`
 * and a future `http://h:11434/openai/v1` are all one server with one slot
 * pool, and treating them as different lanes would over-subscribe it — the
 * precise failure this module exists to prevent. The port is made explicit so
 * `http://h` and `http://h:80` cannot become two lanes for one box.
 *
 * Returns `null` for anything unparseable rather than throwing: an
 * unparseable endpoint is a configuration error that belongs to the provider
 * call, which reports it with far more context than a routing helper could.
 */
export function normalizeOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    return `${u.protocol}//${u.hostname.toLowerCase()}:${port}`;
  } catch {
    return null;
  }
}

/** Permanent, so it can never go stale. See the module doc. */
const laneIdCache = new Map<string, number>();

/** Test seam — the cache is process-local and permanent, so tests that assign
 *  lanes against a reset database must be able to clear it. */
export function __resetLaneCacheForTests(): void {
  laneIdCache.clear();
}

/**
 * The lane index for a key, assigning one if this is the first time the key has
 * been seen.
 *
 * The insert is `ON CONFLICT DO NOTHING` followed by a read, so two workers or
 * two concurrent publishes racing the same new key converge on ONE id rather
 * than one of them failing. That matters because the id is the lane: two
 * different answers for one origin would put its judgments on two lanes and
 * run them concurrently against the server.
 */
export async function laneIndexFor(laneKey: string): Promise<number> {
  const cached = laneIdCache.get(laneKey);
  if (cached !== undefined) return (cached - 1) % LANE_COUNT;

  await prisma.$executeRaw`INSERT INTO "QueueLane" ("laneKey") VALUES (${laneKey}) ON CONFLICT ("laneKey") DO NOTHING`;
  const row = await prisma.queueLane.findUnique({ where: { laneKey }, select: { id: true } });
  if (!row) {
    // Cannot happen after a successful upsert-or-noop plus read; if it somehow
    // does, the fallback queue is the safe answer — it is consumed, so the
    // judgment runs, it simply does not get lane isolation.
    return -1;
  }
  laneIdCache.set(laneKey, row.id);
  return (row.id - 1) % LANE_COUNT;
}

/**
 * The queue a judgment should be published to. Returns the fallback queue when
 * the lane cannot be resolved — never throws, because failing to ROUTE a
 * judgment must not fail the run that created it.
 */
export async function laneQueueFor(
  endpointUrl: string | null | undefined,
  judgeModelVersionId: string
): Promise<string> {
  const index = await laneIndexFor(laneKeyFor(endpointUrl, judgeModelVersionId));
  return index < 0 ? LANE_FALLBACK_QUEUE : laneQueue(index);
}
