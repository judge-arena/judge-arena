# feat: the assignment UI, and true random subset selection

Closes the two gaps that stood between A1/A1.5 and a golden set anyone could actually
label from a browser. Branch: `feat/assignment-ui-and-random-subset`, on top of `e4164c8`.

## What this is

**The assignment UI.** A1 built the assignments API and A1.5 built the studio; nobody built a
surface. `/golden-sets/<id>` now lists active assignments with **Assign to me**, **Revoke**, and a
shortcut into the studio once you hold one. The copy states the thing that is easy to get wrong and
that cost real confusion: *owning a set does not get you items from the queue — an active
assignment row does.* Before this, the only way to create one was a raw `INSERT`, which is exactly
what `docs/runbooks/studio-manual-verification.md` used to hand out.

**The API now matches the UI.** `GET`/`POST` returned raw cuids for `annotatorId` and
`assignedById`. Both are now projected through `toPublicOwner` — `{ id, name }`, never the email.
A deleted account resolves to `null` rather than dropping out of the list, because the row is still
a record of what was asked.

**Random subset selection, resolved server-side.** `DatasetSample.index` is not dense — tombstoning
keeps a row's ordinal — so a client generating numbers in `[0, count)` names rows that do not exist
and silently imports fewer items than asked for. There is no `GET` on dataset samples for it to
enumerate them with. The client sends intent (`randomCount` / `randomPercent`); the server draws
from the live rows it already reads. "First N" is systematically biased on any ordered corpus:
JudgeBench is grouped by source, so its first 30 rows are 30 rows of whichever source sorts first,
and an agreement number computed over that is a number about one source presented as a number about
the benchmark.

## Verification

Every gate the Gitea pipeline runs, run locally against podman Postgres/Redis/RabbitMQ:

| Gate | Result |
|---|---|
| `npm run lint` | exit 0 |
| `npx tsc --noEmit --incremental false` | exit 0 |
| unit (`vitest run`) | **594 passed / 43 files** |
| unit coverage gate | exit 0 |
| db (`npm run test:db`) | **641 passed / 42 files** |
| integration (`npm run test:integration`) | **80 passed / 10 files** |
| `npm run build` | exit 0 |

That exceeds the `bee1d12` baseline of 578 / 633 / 80, and the deltas reconcile exactly to the tests
this branch adds. **No migration** — landing it is a schema no-op.

**Browser walk, 2026-08-29**, recorded in the runbook's table. The row that matters: two sets over
the same 620-row dataset at N=30 gave `0..29` for First and
`14,61,62,76,90,121,…,529` for Random. If random ever returns the prefix, that is the check that
catches it.

## Landed with this branch, not in the original commit

- `handleRevoke` had **no `catch`**. A rejected fetch escaped as an unhandled rejection while
  `finally` re-enabled the button — so a failed revoke looked exactly like a successful one. Now
  mirrors `handleAssignToMe`.
- The `randomPercent` DB test **did not test its own title**: it tombstoned nothing, so live count
  and raw count were equal and the assertion passed under either denominator. It now hides 20 of 40
  rows and asserts 5.
- Three doc blocks that described the world before this commit: `createGoldenSetSchema`'s comment
  still said "two ways" after the refusal was widened to four; `sample-selection.ts`'s docstrings
  described the abandoned client-side design; the runbook still handed out the SQL `INSERT` this
  branch replaces.

## Deliberate scope limits

- The assignment panel is gated on `isOwner`, though the API authorizes owner-or-admin. An admin
  coordinating someone else's set gets no panel. Widening the gate is one line if wanted now.
- The only creation path is **Assign to me**. Assigning *another* user still needs a raw insert;
  that is E3's problem, and E3 is where the policy question actually gets decided.
- The 252 lines of React have no tests and cannot have any — all three vitest configs are
  `environment: 'node'` with no jsdom. That is why the browser walk is the gate instead.

## Known, and NOT introduced here

Pairwise candidates render as "Option 1" / "Option 2" while the verdict control offers `A>B` /
`tie` / `B>A`, and every production `GoldenCandidate` has `label IS NULL`. An annotator can answer
only by assuming the ordering. Pre-existing; tracked separately.
