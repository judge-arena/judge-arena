/**
 * A1 — WHO MAY HOLD AN ANNOTATION ASSIGNMENT.
 *
 * Deliberately its own module, and deliberately not folded into the route.
 * `GoldenAssignment` is the MECHANISM (design decision 6); this is the POLICY
 * over it (decision 8), and the two are separate concerns on purpose:
 *
 *   - With exactly one account, "owner + admin" collapses to "the owner", so
 *     the two read as the same rule today and are easy to conflate.
 *   - Multiple annotators are coming through the owner's backend. When they
 *     arrive, WIDENING this predicate is the entire change — no new table, no
 *     new route, no re-derivation of who can be given work.
 *
 * Written in `src/lib/**` rather than inline in the handler for the reason the
 * whole phase is laid out this way: `src/app/api/**` is outside every coverage
 * `include`, so a rule that lives in a route is a rule no coverage number
 * describes.
 *
 * NOTE THIS IS NOT THE SAME QUESTION as "who may CALL the assignments route".
 * That is owner-or-admin on the set, enforced by the handler. This is who may
 * appear as the `annotatorId` ON a row. Without it a coordinator could queue
 * work onto an account that has no path to ever see it, and the assignment
 * would sit there looking like outstanding work forever.
 */

export type AssignmentHolder = {
  id: string;
  role: string;
};

/**
 * True when `user` may be given annotation work on a set owned by `ownerId`.
 *
 * Today: the set's owner, or any admin. Roadmap decision 5 revisits the
 * cross-user case when a second account exists — at which point this is where
 * the collaborator/organisation check goes.
 */
export function mayHoldAssignment(user: AssignmentHolder, ownerId: string | null): boolean {
  return user.id === ownerId || user.role === 'admin';
}
