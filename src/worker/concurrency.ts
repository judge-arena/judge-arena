/**
 * ─── How many judgments this worker will have in flight at once ─────────────
 *
 * A HARD CAP, deliberately not a default. Configuration may ask for any value
 * the env schema allows (1-16); this clamps it. Asking for more is not an
 * error and does not fail the boot — the request is simply not honoured.
 *
 * ── WHY, from a real run rather than a principle ────────────────────────────
 *
 * The first production calibration (2026-08-31, 30 items against a local
 * llama.cpp judge) DEAD-LETTERED 4 of 30 items with
 * `timed out after 300000ms`, and the model was not the problem: judgments
 * that completed averaged 94s, well inside the 300s ceiling.
 *
 * The cause was this number. `EVALUATION_MODEL_CONCURRENCY_PER_RUN` was 2 and
 * prefetch was `concurrency * 4` = 8, so the worker held eight unacked
 * messages and issued eight concurrent HTTP requests to a server advertising
 * `total_slots: 2`. Requests three through eight queued INSIDE the inference
 * server while their client-side timeout ran. The clock a provider timeout
 * measures is wall time from request to response, and it does not care that
 * most of that time was spent waiting for a slot. Six of eight requests were
 * therefore racing a deadline that had nothing to do with how fast the model
 * could answer.
 *
 * Over-subscribing an inference server does not make it faster. It converts a
 * queue you can see (RabbitMQ, with depth, retries and a DLQ) into a queue you
 * cannot (the server's internal slot queue, invisible to every metric this
 * cluster has), and then times out against it.
 *
 * ── WHY 1 AND NOT "MATCH THE SERVER'S SLOTS" ────────────────────────────────
 *
 * Because the worker cannot know the slot count. It is a property of whichever
 * endpoint each JudgeModelVersion points at — different per judge, invisible
 * from here, and free to change under us when someone restarts a server with
 * different flags. One in flight is the only value that is safe against every
 * endpoint without asking any of them. It also makes a calibration RUN
 * SEQUENTIALLY, which is what makes a baseline number reproducible: with
 * concurrency the per-judgment latency you measure is a function of how many
 * neighbours it happened to be sharing a server with.
 *
 * ── WHAT TO DO WHEN THIS SHOULD GROW ────────────────────────────────────────
 *
 * Raising the cap is not the fix; per-endpoint concurrency is. The value
 * belongs next to the endpoint that constrains it (a column on ModelEndpoint,
 * or a probe of the server's own advertised slots), with a scheduler that
 * respects it per-endpoint rather than one global number applied to every
 * judge at once. Until that exists, this stays at 1 — a global number cannot
 * be right for a fleet of heterogeneous endpoints, and being wrong costs
 * dead-lettered items that look like model failures.
 */

/** The most judgments this worker will execute concurrently, whatever the
 *  configuration asks for. See the module doc before changing it. */
export const HARD_CONCURRENCY_CAP = 1;

export interface ResolvedConcurrency {
  /** What the configuration asked for, after parsing. */
  requested: number;
  /** What will actually be used. */
  effective: number;
  /** The AMQP prefetch to set. Equal to `effective`: prefetch IS the
   *  concurrency limit here, because the dispatch loop starts a handler for
   *  every message the broker delivers. A prefetch above the intended
   *  concurrency does not queue work politely — it runs it. */
  prefetch: number;
  /** True when the request exceeded the cap and was clamped. Callers log this;
   *  it must not be silent to an OPERATOR, only to the configuration. Someone
   *  who sets 8 and sees no change deserves to know why. */
  capped: boolean;
}

export function resolveWorkerConcurrency(raw: string | undefined): ResolvedConcurrency {
  const parsed = Number(raw ?? '2');
  // A non-numeric or sub-1 value floors to 1 rather than throwing: this runs at
  // module load in the worker entrypoint, and a boot crash over a typo'd env
  // var is a worse failure than quietly doing the safe thing.
  const requested = Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 1;
  const effective = Math.min(requested, HARD_CONCURRENCY_CAP);
  return { requested, effective, prefetch: effective, capped: requested > HARD_CONCURRENCY_CAP };
}
