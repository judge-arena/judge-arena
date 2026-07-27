/**
 * Pure ownership check for a `run:{runId}` realtime subscription (see
 * src/app/api/events/route.ts). A user may subscribe to a run's topic iff
 * they triggered the run themselves, or they own the project the run's
 * evaluation belongs to (covers e.g. an admin/teammate re-viewing a run
 * someone else triggered inside a project the caller owns).
 *
 * Kept pure (no Prisma/DB access) so it's cheaply unit-testable — the route
 * does the `prisma.evaluationRun.findUnique(...)` lookup and passes the
 * result in.
 */

export interface RunOwnershipCheckInput {
  triggeredById: string | null;
  evaluation: {
    project: {
      userId: string;
    };
  };
}

export function userOwnsRun(userId: string, run: RunOwnershipCheckInput): boolean {
  if (run.triggeredById !== null && run.triggeredById === userId) return true;
  return run.evaluation.project.userId === userId;
}
