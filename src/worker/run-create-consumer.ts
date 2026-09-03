/**
 * ─── run.create Consumer ───────────────────────────────────────────────────
 *
 * Expands a `run.create` message (a v1-legacy-style "launch this evaluation
 * against N selected models" request, used by bulk dataset launches — a
 * single-run web-tier launch (Task 9) is expected to create its
 * `EvaluationRun` + publish `judgment.execute` directly, never through this
 * queue) into one `EvaluationRun` + one `pending` `ModelJudgment` (+ one
 * `RunModelSelection`) per entry in `runSpec.modelSelections`, then
 * publishes one `judgment.execute` per created `ModelJudgment` row.
 *
 * POINTWISE ONLY (A0). `RunCreateMsg.protocol` is a real `RunProtocol` as of
 * Task 12, so a non-pointwise value is representable here even though no
 * producer emits one; `handle()` refuses it up front rather than expanding
 * something it cannot complete — see the guard's own comment for why a
 * pairwise message has no candidate set to expand against and would
 * mis-derive its mode. Pairwise runs are launched by `run-launch.ts`'s
 * `launchSingleRun` instead, which writes `RunCandidate` rows in the same
 * transaction as the run.
 *
 * ── judgeModelVersionId is the identity; modelConfigId is legacy (Task 12) ──
 * Each `modelSelections` entry carries `judgeModelVersionId` (the queue/
 * worker identity every `ModelJudgment` needs to run — see
 * `src/lib/run-launch.ts`'s module doc) and `modelConfigId`, which is
 * ALWAYS `null` for a run launched by the current write path (no
 * `ModelConfig` back-reference exists for a version created via the
 * catalog or a custom-model POST). This consumer still writes whatever
 * `modelConfigId` the message carries (rather than forcing it to `null`
 * itself) in case a future producer resolves one, but does not derive one
 * on its own. `judgeModelVersionId`, NOT `modelConfigId`, is what the
 * dedupe `Map` below is keyed on — every `modelConfigId` can legitimately
 * be `null` now, and a `null`-keyed `Map` would silently collapse every
 * selection into one (Task 9 review fix #1's ORIGINAL bug, closed then by
 * pairing both ids on the message; Task 12 closes the same failure mode
 * again from the opposite direction — modelConfigId going away rather than
 * missing — by re-keying the dedupe on judgeModelVersionId instead).
 * `RunModelSelection` rows are written here too (the run-level "which
 * models were selected" snapshot `launchSingleRun` writes via its own
 * nested `runModelSelections.create`) — this expansion path creates the run
 * first, without models attached, so it needs its own explicit write.
 *
 * ── Redelivery / idempotency (no schema change in this task) ───────────────
 * There is no client-generated idempotency key on `RunCreateMsg`/
 * `EvaluationRun` to de-duplicate a redelivered `run.create` message against
 * — adding one is a schema change, out of scope here. Instead: before doing
 * any work, check for an existing *active* run (`status` in `pending` |
 * `judging`) for the same `evaluationId`. If one exists, this delivery is
 * treated as a duplicate and acked without creating anything.
 *
 * This is real but LIMITED idempotency: it guarantees at most one active
 * bulk-launch run per evaluation at a time, matching v1's own dedupe intent
 * (v1 never let two runs process concurrently for the same evaluation
 * either — see `evaluation-run-manager.ts`'s `activeIds` guard). It does
 * NOT protect against two redeliveries racing each other concurrently
 * before either has committed (a true TOCTOU window) — closing that
 * requires either a DB-level uniqueness constraint or a distributed lock,
 * neither of which this task adds. In practice this window is narrow
 * (single-digit ms, one DB round trip) and RabbitMQ redelivery is driven by
 * ack/nack timing, not concurrent multi-consumer delivery of the same
 * message under normal operation.
 *
 * ── Expansion failure: no silent swallow ────────────────────────────────────
 * If anything between resolving the prompt template and finishing the
 * judgment-row expansion throws, the run is recorded with `status: 'error'`
 * rather than silently disappearing — this is the exact 1a-carried
 * batch-failure gap the brief calls out. Two cases:
 *   - Failure before the create-run-transaction ever committed (no run
 *     row exists yet) -> a NEW `EvaluationRun` row is created directly with
 *     `status: 'error'`, so the evaluationId still gets a visible failure
 *     record instead of nothing.
 *   - Failure after the transaction committed (e.g. publishing
 *     `judgment.execute` for one of the created rows throws) -> the
 *     already-created run is updated to `status: 'error'` in place, rather
 *     than leaving it stuck `pending` forever or creating a duplicate row.
 * Either way the message is acked (not requeued) — retrying a
 * deterministic expansion failure (missing PromptTemplate, empty
 * modelSelections, etc.) would just fail identically forever.
 *
 * ── Mode-conditional prompt template (Task 9b) ──────────────────────────────
 * `RunCreateMsg` carries no mode field of its own (the message contract is
 * ids-only — see queue/publish.ts's module doc), so this consumer re-derives
 * the mode itself via `deriveRunMode` (src/lib/run-mode.ts) off the
 * `Evaluation.responseText` it looks up by `msg.evaluationId`, mirroring
 * `launchBulkRunCreates`' own derivation at publish time (both read the same
 * column — the only way they could disagree is the evaluation's
 * `responseText` changing between publish and consume, which nothing in
 * this codebase does after creation). A `PromptTemplate` is resolved and
 * required ONLY for `'judge'` mode; `'respond'` mode expands with
 * `promptTemplateId: null` on every created `ModelJudgment` — v1 never
 * rendered a rubric template when there is no rubric to render one against.
 */

import type { Channel, ConsumeMessage } from 'amqplib';
import type { RunProtocol } from '@prisma/client';
import { prisma } from '@/lib/db';
import { logger, serializeError } from '@/lib/logger';
import { publishJudgmentExecute, resolveDestinationQueue, type RunCreateMsg } from '@/lib/queue/publish';
import { LANE_FALLBACK_QUEUE } from '@/lib/queue/lanes';
import { resolveEndpointsForVersions } from '@/lib/endpoint-resolution';
import { deriveRunMode } from '@/lib/run-mode';

const ACTIVE_RUN_STATUSES = ['pending', 'judging'] as const;

export interface RunCreateConsumer {
  handle(msg: ConsumeMessage, ch: Channel): Promise<void>;
}

async function resolveCurrentPromptTemplate(protocol: RunProtocol) {
  // "Current" = highest version for this protocol. Resolved once per
  // message so every judgment row created from this run.create message is
  // pinned to the same template snapshot, even if a newer version lands
  // mid-expansion (it won't — this is one synchronous query — but pinning
  // once rather than re-querying per row is the correct intent regardless).
  return prisma.promptTemplate.findFirst({
    where: { protocol },
    orderBy: { version: 'desc' },
  });
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Record an expansion failure as a visible, queryable `EvaluationRun` row
 * in `status: 'error'` — creating a new one if the transaction never
 * committed, or flipping the already-committed run if it did. Best-effort:
 * logs (never throws) if even this write fails, since the caller acks the
 * message regardless (see module doc). */
async function recordExpansionFailure(
  msg: RunCreateMsg,
  existingRunId: string | null,
  reason: string
): Promise<void> {
  logger.error('run.create expansion failed — recording an errored run (no silent swallow)', {
    evaluationId: msg.evaluationId,
    runId: existingRunId,
    reason,
  });

  try {
    if (existingRunId) {
      await prisma.evaluationRun.update({
        where: { id: existingRunId },
        data: { status: 'error' },
      });
    } else {
      await prisma.evaluationRun.create({
        data: {
          evaluationId: msg.evaluationId,
          rubricId: msg.runSpec.rubricId ?? null,
          protocol: msg.runSpec.protocol,
          status: 'error',
          triggeredById: msg.runSpec.triggeredById,
        },
      });
    }
  } catch (writeError) {
    logger.error('run.create: failed to record the errored run', {
      evaluationId: msg.evaluationId,
      runId: existingRunId,
      error: serializeError(writeError),
    });
  }
}

export function createRunCreateConsumer(): RunCreateConsumer {
  async function handle(raw: ConsumeMessage, ch: Channel): Promise<void> {
    const msg = JSON.parse(raw.content.toString()) as RunCreateMsg;

    const active = await prisma.evaluationRun.findFirst({
      where: { evaluationId: msg.evaluationId, status: { in: [...ACTIVE_RUN_STATUSES] } },
      select: { id: true },
    });
    if (active) {
      logger.info('run.create: active run already exists for evaluation — deduping (ack, no create)', {
        evaluationId: msg.evaluationId,
        runId: active.id,
      });
      ch.ack(raw);
      return;
    }

    let createdRunId: string | null = null;

    try {
      // A0: this consumer expands POINTWISE runs only, and refuses anything
      // else up front rather than half-honouring it. `RunCreateMsg.protocol`
      // became a real `RunProtocol` in Task 12, so `'pairwise'`/`'listwise'`
      // are now representable on the wire — but nothing here can expand
      // either one correctly: `RunCreateMsg` carries no candidate set, so a
      // pairwise expansion would produce judgments against a run with zero
      // `RunCandidate` rows and nothing to compare. The mode derivation just
      // below is the reason this must be a refusal and not a best effort —
      // it keys on `Evaluation.responseText`, which a pairwise evaluation
      // does not have, so such a message would silently expand as
      // respond-mode with `promptTemplateId: null`. Thrown (not acked
      // quietly) so `recordExpansionFailure` books it as a visible errored
      // run, exactly like every other expansion failure. Pairwise runs go
      // through `run-launch.ts`'s `launchSingleRun`, which writes
      // `RunCandidate` rows transactionally with the run.
      if (msg.runSpec.protocol !== 'pointwise') {
        throw new Error(
          `run.create expands pointwise runs only — got protocol "${msg.runSpec.protocol}". ` +
            'A pairwise run must be launched through launchSingleRun, which writes its RunCandidate rows.'
        );
      }

      const evaluation = await prisma.evaluation.findUnique({
        where: { id: msg.evaluationId },
        select: { responseText: true },
      });
      const mode = deriveRunMode(evaluation?.responseText);

      // promptTemplateId is null on respond judgments — only judge-mode
      // expansion resolves+requires a PromptTemplate row (see module doc's
      // "Mode-conditional prompt template" section).
      let promptTemplateId: string | null = null;
      if (mode === 'judge') {
        const promptTemplate = await resolveCurrentPromptTemplate(msg.runSpec.protocol);
        if (!promptTemplate) {
          throw new Error(`No PromptTemplate found for protocol "${msg.runSpec.protocol}"`);
        }
        promptTemplateId = promptTemplate.id;
      }

      // Dedupe by judgeModelVersionId — the per-model identity for this
      // expansion (mirrors run-launch.ts's launchSingleRun, which is keyed
      // the same way) — defense in depth alongside the active-run dedupe
      // check above; a redelivery of the identical message produces the
      // identical (deduped) list either way. Task 12: NOT modelConfigId —
      // that field is `null` on every entry a current-write-path launch
      // produces (see queue/publish.ts's RunCreateMsg doc), and a
      // `null`-keyed Map would collapse every selection into one.
      const modelSelections = [
        ...new Map(msg.runSpec.modelSelections.map((sel) => [sel.judgeModelVersionId, sel])).values(),
      ];
      if (modelSelections.length === 0) {
        throw new Error('runSpec.modelSelections is empty — nothing to expand');
      }

      // 2026-09-03: deadlineAt is deliberately OMITTED here — it defaults
      // to null and stays null until src/worker/claim.ts's
      // stampRunStartedAtFirstDequeue sets it at FIRST DEQUEUE, sized on
      // THIS run's own judgment count and measured from the moment a
      // worker actually claims it. This consumer used to compute its own
      // creation-time deadline here, independently of run-launch.ts's
      // (now-also-deleted) formula — the THIRD of three call sites that
      // all had to agree, and the one most likely to be missed exactly
      // because it lived in a different file from the other two.
      const run = await prisma.$transaction(async (tx) => {
        const createdRun = await tx.evaluationRun.create({
          data: {
            evaluationId: msg.evaluationId,
            rubricId: msg.runSpec.rubricId ?? null,
            protocol: msg.runSpec.protocol,
            status: 'pending',
            triggeredById: msg.runSpec.triggeredById,
          },
        });

        // skipDuplicates: redelivery-safe if this exact transaction were
        // ever somehow re-attempted against the same run — in practice the
        // active-run dedupe check above is what normally prevents that, this
        // is defense in depth (and dedupes duplicate entries within
        // modelSelections, though the `Map` above already handles that case
        // too). judgeModelVersionId is the queue/worker identity; modelConfigId
        // is Task 12's legacy field — null for every current-write-path
        // launch (see queue/publish.ts's RunCreateMsg doc), passed through
        // as-is (not forced to null) in case a future caller resolves one.
        await tx.modelJudgment.createMany({
          data: modelSelections.map((sel) => ({
            runId: createdRun.id,
            judgeModelVersionId: sel.judgeModelVersionId,
            modelConfigId: sel.modelConfigId,
            promptTemplateId,
            // A0: pairOrder written EXPLICITLY, never left to a default —
            // unconditionally NULL here, because the guard at the top of
            // `handle()` has already refused every protocol but 'pointwise',
            // and NULL is what pointwise means under the hand-edited NULLS
            // NOT DISTINCT @@unique([runId, judgeModelVersionId, pairOrder]).
            // This is NOT a derivation from `msg.runSpec.protocol`: the only
            // writer that can produce a non-NULL pairOrder is
            // run-launch.ts's launchSingleRun ('AB'), which is also the only
            // one that writes the RunCandidate rows such a judgment needs.
            pairOrder: null,
            status: 'pending' as const,
          })),
          skipDuplicates: true,
        });

        // RunModelSelection — the run-level "which models were selected"
        // snapshot. launchSingleRun writes this via its own EvaluationRun
        // nested `runModelSelections.create`; this expansion path creates
        // the run first (without models attached), so it needs its own
        // explicit createMany here. Before this fix, the bulk/dataset-
        // launch path never wrote these rows at all.
        await tx.runModelSelection.createMany({
          data: modelSelections.map((sel) => ({
            runId: createdRun.id,
            judgeModelVersionId: sel.judgeModelVersionId,
            modelConfigId: sel.modelConfigId,
          })),
          skipDuplicates: true,
        });

        return createdRun;
      });

      createdRunId = run.id;

      const judgments = await prisma.modelJudgment.findMany({
        where: { runId: run.id },
        // v2j: judgeModelVersionId is the key a lane is resolved per.
        select: { id: true, judgeModelVersionId: true },
      });

      // ── Lane routing (v2j), batched ─────────────────────────────────────
      // ONE endpoint query for the whole expansion, not one per judgment: a
      // `run.create` message is single-user by construction
      // (`runSpec.triggeredById` owns every judgment it expands to), so the
      // batch is over the run's DISTINCT judge versions — which is exactly
      // `modelSelections`, already deduped above. `resolveEndpointsForVersions`
      // is the same resolver `judgment-consumer.ts` executes through, so the
      // lane names the server this judgment will actually be sent to.
      //
      // Lane assignment then runs concurrently over those distinct versions
      // (`laneIndexFor` is INSERT .. ON CONFLICT DO NOTHING — built to race),
      // and `resolveDestinationQueue` cannot throw, so nothing here can turn a
      // successful expansion into `recordExpansionFailure`.
      const endpoints = await resolveEndpointsForVersions(
        msg.runSpec.triggeredById,
        modelSelections.map((sel) => sel.judgeModelVersionId)
      );
      // Keyed `string | null`: `ModelJudgment.judgeModelVersionId` is nullable
      // in the schema, so a null-version row misses every key and takes the
      // fallback below instead of needing a sentinel key.
      const laneByVersion = new Map<string | null, string>(
        await Promise.all(
          modelSelections.map(
            async (sel) =>
              [
                sel.judgeModelVersionId,
                await resolveDestinationQueue(
                  endpoints.get(sel.judgeModelVersionId)?.endpoint,
                  sel.judgeModelVersionId
                ),
              ] as const
          )
        )
      );

      // Post-commit: publishing must never happen inside the DB transaction
      // (holding it open across network round trips to RabbitMQ, and
      // rolling back rows whose queue messages the broker already accepted
      // would desync the two systems).
      for (const judgment of judgments) {
        // eslint-disable-next-line no-await-in-loop -- sequential confirmed publishes, one run.create message expands to at most a handful of judge versions; not worth Promise.all's harder-to-reason-about partial-failure semantics here
        await publishJudgmentExecute(
          { judgmentId: judgment.id, runId: run.id, attempt: 1 },
          // Fallback rather than `undefined`: a judgment row can only exist
          // for a version in `modelSelections`, so this is unreachable — but
          // an undefined routing key would be published to the empty string
          // and silently discarded by the direct exchange, which is a lost
          // judgment. The fallback queue is consumed.
          laneByVersion.get(judgment.judgeModelVersionId) ?? LANE_FALLBACK_QUEUE
        );
      }

      ch.ack(raw);
    } catch (error) {
      await recordExpansionFailure(msg, createdRunId, errorMessageOf(error));
      ch.ack(raw);
    }
  }

  return { handle };
}
