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
 * ── modelConfigId dual-write (temporary — see judge-identity.ts, and
 * run-launch.ts's module doc for the full rationale) ────────────────────────
 * Each `modelSelections` entry carries BOTH `judgeModelVersionId` (the
 * queue/worker identity every `ModelJudgment` needs to run) AND
 * `modelConfigId` (the legacy identity the leaderboard aggregation, run
 * detail page, human-judgment route, and CSV/JSONL export still read).
 * Before this was fixed (Task 9 review), `run.create` only ever carried a
 * bare `judgeModelVersionId[]` — this consumer had no `modelConfigId` to
 * write, so it always set `modelConfigId: null`, silently excluding every
 * bulk/dataset-launched judgment from the leaderboard
 * (`if (j.modelConfig === null) continue`) and never writing a
 * `RunModelSelection` row at all (the run-level "which models were
 * selected" snapshot `launchSingleRun` writes via its own nested
 * `runModelSelections.create`). Both writes now happen here, inside the
 * same transaction as the `ModelJudgment` creation.
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
 */

import type { Channel, ConsumeMessage } from 'amqplib';
import type { RunProtocol } from '@prisma/client';
import { prisma } from '@/lib/db';
import { logger, serializeError } from '@/lib/logger';
import { publishJudgmentExecute, type RunCreateMsg } from '@/lib/queue/publish';

const EVALUATION_MODEL_TIMEOUT_MS = Number(process.env.EVALUATION_MODEL_TIMEOUT_MS ?? '120000');
/** Slack added on top of `judgmentCount * EVALUATION_MODEL_TIMEOUT_MS` when
 * computing `EvaluationRun.deadlineAt` — covers DB round trips, queue
 * publish latency, and finalization overhead that isn't part of any single
 * provider call's own timeout budget. */
const DEADLINE_SLACK_MS = 60_000;

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
      const promptTemplate = await resolveCurrentPromptTemplate(msg.runSpec.protocol);
      if (!promptTemplate) {
        throw new Error(`No PromptTemplate found for protocol "${msg.runSpec.protocol}"`);
      }

      // Dedupe by modelConfigId — the per-model identity for this
      // expansion (mirrors run-launch.ts's launchSingleRun, which is keyed
      // the same way) — defense in depth alongside the active-run dedupe
      // check above; a redelivery of the identical message produces the
      // identical (deduped) list either way.
      const modelSelections = [
        ...new Map(msg.runSpec.modelSelections.map((sel) => [sel.modelConfigId, sel])).values(),
      ];
      if (modelSelections.length === 0) {
        throw new Error('runSpec.modelSelections is empty — nothing to expand');
      }

      const deadlineAt = new Date(
        Date.now() + modelSelections.length * EVALUATION_MODEL_TIMEOUT_MS + DEADLINE_SLACK_MS
      );

      const run = await prisma.$transaction(async (tx) => {
        const createdRun = await tx.evaluationRun.create({
          data: {
            evaluationId: msg.evaluationId,
            rubricId: msg.runSpec.rubricId ?? null,
            protocol: msg.runSpec.protocol,
            status: 'pending',
            deadlineAt,
            triggeredById: msg.runSpec.triggeredById,
          },
        });

        // skipDuplicates: redelivery-safe if this exact transaction were
        // ever somehow re-attempted against the same run — in practice the
        // active-run dedupe check above is what normally prevents that, this
        // is defense in depth (and dedupes duplicate entries within
        // modelSelections, though the `Map` above already handles that case
        // too). Dual-write: modelConfigId (legacy, for the leaderboard/UI/
        // exports/human-judgment matching) AND judgeModelVersionId (the
        // queue/worker identity) — see this file's module doc and
        // run-launch.ts's for why both are still written.
        await tx.modelJudgment.createMany({
          data: modelSelections.map((sel) => ({
            runId: createdRun.id,
            judgeModelVersionId: sel.judgeModelVersionId,
            modelConfigId: sel.modelConfigId,
            promptTemplateId: promptTemplate.id,
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
            modelConfigId: sel.modelConfigId,
          })),
          skipDuplicates: true,
        });

        return createdRun;
      });

      createdRunId = run.id;

      const judgments = await prisma.modelJudgment.findMany({
        where: { runId: run.id },
        select: { id: true },
      });

      // Post-commit: publishing must never happen inside the DB transaction
      // (holding it open across network round trips to RabbitMQ, and
      // rolling back rows whose queue messages the broker already accepted
      // would desync the two systems).
      for (const judgment of judgments) {
        // eslint-disable-next-line no-await-in-loop -- sequential confirmed publishes, one run.create message expands to at most a handful of judge versions; not worth Promise.all's harder-to-reason-about partial-failure semantics here
        await publishJudgmentExecute({ judgmentId: judgment.id, runId: run.id, attempt: 1 });
      }

      ch.ack(raw);
    } catch (error) {
      await recordExpansionFailure(msg, createdRunId, errorMessageOf(error));
      ch.ack(raw);
    }
  }

  return { handle };
}
