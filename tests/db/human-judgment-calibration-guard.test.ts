import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { getServerSession } from 'next-auth';
import { db, truncateAll, mkUser } from './helpers';
import { POST as postHumanJudgment } from '@/app/api/evaluations/[id]/runs/[runId]/human-judgment/route';

/**
 * ─── Task 7 / trap T6 ────────────────────────────────────────────────────
 *
 * `HumanJudgment.runId` is `@unique` (prisma/schema.prisma:~578) — one
 * human-judgment slot per run. A permuted calibration now creates TWO
 * `EvaluationRun`s per golden item (pairOrder 'AB' and 'BA') where there was
 * one, so there are now two slots where there was one — and the write path
 * (src/app/api/evaluations/[id]/runs/[runId]/human-judgment/route.ts)
 * checks only run existence, evaluationId match, and ownership.
 * `calibration/launch.ts` sets `EvaluationRun.triggeredById` to the
 * LAUNCHING OPERATOR, and the route's ownership check is
 * `run.evaluation.userId !== session.user.id` — the evaluation itself is
 * also owned by that operator, so the launching operator passes every
 * existing check.
 *
 * This is a PRE-EXISTING hole, not a new one: a human judgment on an
 * UNPERMUTED calibration run (pairOrder 'AB' only, one run per item) was
 * already meaningless before this task — a calibration run measures a
 * judge against a frozen golden-item answer key, not something a human
 * reviewer annotates through this route. The permuted shape just doubles
 * how many meaningless slots exist per item. The route now returns 409 for
 * ANY calibration run (`run.calibrationRunId !== null`), closing both the
 * pre-existing hole and the new doubled one at once.
 */

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(),
}));
vi.mock('next/headers', () => ({
  headers: vi.fn(async () => new Headers()),
}));
// Same fake-limiter pattern as tests/db/access-matrix.test.ts: requireAuth()
// hits a real Redis-backed sliding window shared across every tests/db
// file in one `npm run test:db` run (fileParallelism: false). Fake it to
// always admit so this file's requests never trip that shared budget.
vi.mock('@/lib/rate-limit-redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rate-limit-redis')>();
  return {
    ...actual,
    apiLimiter: { check: vi.fn(async () => ({ ok: true, remaining: 999, resetAt: Date.now() + 60_000 })) },
  };
});

function mockSessionFor(user: { id: string; email: string }) {
  (getServerSession as unknown as Mock).mockResolvedValue({
    user: { id: user.id, email: user.email },
  });
}

let counter = 0;
function uniq(label: string): string {
  counter += 1;
  return `${label}-${counter}`;
}

async function mkProject(userId: string) {
  return db.project.create({ data: { name: uniq('fixture-project'), userId } });
}

async function mkEvaluation(projectId: string, userId: string) {
  return db.evaluation.create({
    data: { projectId, userId, inputText: 'fixture input', responseText: 'fixture response' },
  });
}

/** Minimal CalibrationRun header: a GoldenSet (over a Dataset) and a
 * JudgeModelVersion (over a JudgeModel), mirroring the fixture shapes in
 * tests/db/calibration-link.test.ts's mkDataset/mkGoldenSet/
 * mkJudgeVersionWithEndpoint — no ModelEndpoint needed here since this file
 * never launches a run, only asserts against a CalibrationRun-linked one
 * created directly. */
async function mkCalibrationRun(userId: string) {
  const dataset = await db.dataset.create({
    data: { name: uniq('fixture-dataset'), visibility: 'public', inputType: 'query-response', userId },
  });
  const goldenSet = await db.goldenSet.create({
    data: { name: uniq('fixture-golden-set'), datasetId: dataset.id, protocol: 'pairwise', ownerId: userId },
  });
  const judgeModel = await db.judgeModel.create({
    data: { name: uniq('fixture-judge'), slug: uniq('fixture-judge-slug'), judgeClass: 'prompted_api', scoringMechanism: 'critique_generative' },
  });
  const version = await db.judgeModelVersion.create({
    data: {
      judgeModelId: judgeModel.id,
      ordinal: 1,
      servingBackend: 'openai',
      protocolSupport: { pairwise: ['preference'] },
    },
  });
  return db.calibrationRun.create({
    data: { judgeModelVersionId: version.id, goldenSetId: goldenSet.id },
  });
}

function postRequest(id: string, runId: string, body: Record<string, unknown>) {
  return postHumanJudgment(
    new Request(`http://localhost/api/evaluations/${id}/runs/${runId}/human-judgment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id, runId }) }
  );
}

describe('Human judgment on a calibration run: 409 (trap T6)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('a human judgment on a calibration run returns 409, even for that run\'s own triggering owner', async () => {
    const user = await mkUser();
    const project = await mkProject(user.id);
    const evaluation = await mkEvaluation(project.id, user.id);
    const calibrationRun = await mkCalibrationRun(user.id);

    // Mirrors calibration/launch.ts's actual shape: triggeredById is the
    // LAUNCHING OPERATOR, and evaluation.userId (checked by the route's
    // ownership guard) is also that same operator — the exact shape that
    // would pass every pre-existing check (existence, evaluationId match,
    // ownership).
    const run = await db.evaluationRun.create({
      data: {
        evaluationId: evaluation.id,
        calibrationRunId: calibrationRun.id,
        pairOrder: 'AB',
        triggeredById: user.id,
      },
    });

    mockSessionFor(user);
    const response = await postRequest(evaluation.id, run.id, { overallScore: 7 });

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toMatch(/calibration/i);

    // No HumanJudgment row was ever written — the 409 short-circuits before
    // any upsert, not just after.
    const judgment = await db.humanJudgment.findUnique({ where: { runId: run.id } });
    expect(judgment).toBeNull();
  });

  it('the SAME permuted item\'s OTHER order (pairOrder BA) is also blocked — both slots, not just one', async () => {
    const user = await mkUser();
    const project = await mkProject(user.id);
    const evaluation = await mkEvaluation(project.id, user.id);
    const calibrationRun = await mkCalibrationRun(user.id);

    const baRun = await db.evaluationRun.create({
      data: {
        evaluationId: evaluation.id,
        calibrationRunId: calibrationRun.id,
        pairOrder: 'BA',
        triggeredById: user.id,
      },
    });

    mockSessionFor(user);
    const response = await postRequest(evaluation.id, baRun.id, { overallScore: 4 });

    expect(response.status).toBe(409);
    const judgment = await db.humanJudgment.findUnique({ where: { runId: baRun.id } });
    expect(judgment).toBeNull();
  });

  it('an ORDINARY (non-calibration) run is unaffected — the same caller still gets a 200 and a persisted judgment', async () => {
    const user = await mkUser();
    const project = await mkProject(user.id);
    const evaluation = await mkEvaluation(project.id, user.id);
    const run = await db.evaluationRun.create({ data: { evaluationId: evaluation.id } });

    mockSessionFor(user);
    const response = await postRequest(evaluation.id, run.id, { overallScore: 7 });

    expect(response.status).toBe(200);
    const judgment = await db.humanJudgment.findUnique({ where: { runId: run.id } });
    expect(judgment).not.toBeNull();
    expect(judgment?.overallScore).toBe(7);
  });
});
