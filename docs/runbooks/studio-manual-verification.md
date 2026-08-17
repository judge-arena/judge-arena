# Studio manual verification

**What this is.** `src/components/studio/**` has no automated tests and cannot have any: all three
vitest configs are `environment: 'node'` with no jsdom, so nothing that renders can be asserted on.
This checklist is the substitute, and it is the thing a future change to the studio is re-run
against.

**What this is NOT.** A substitute for the unit tests in `tests/lib/studio/**`. Every rule that can
be silently wrong — span segmentation, the word diff, layout reconciliation — lives in
`src/lib/studio/` precisely so it is covered there instead. If a step below is checking a *rule*
rather than a *rendering*, that rule is in the wrong place.

## Setup

```bash
# Local Postgres is the podman container judge-arena-pg on localhost:5432.
# PRODUCTION is the Kubernetes pod judge-arena-pg-1 in namespace tenant-public
# and must never be touched. The names differ by one character.
sh -c 'set -a; . ./.env.local; set +a; npx prisma migrate status'   # expect "up to date"
npm run dev
```

You need, on the local database:

1. A signed-in account.
2. A golden set owned by it, with at least 3 items — one **pointwise** set and one **pairwise** set,
   because the verdict control differs and only one of them exercises the `options` panel.
3. A `GoldenAssignment` for that account on each set. Without one the queue correctly answers
   `no-assignment`, which is checklist item 9 rather than a way to reach items 1–8.

```sql
-- whole-set assignment for the signed-in account
INSERT INTO "GoldenAssignment" ("id","goldenSetId","annotatorId","round","assignedAt")
VALUES (gen_random_uuid()::text, '<setId>', '<userId>', 1, now());
```

## Checklist

| # | Step | Expected |
|---|---|---|
| 1 | Open `/golden-sets/<id>/label` for a **pointwise** set | All five panels render. The verdict panel shows a numeric **Score** input. |
| 2 | Same for a **pairwise** set | All five panels render. `options` lists the candidates; verdict shows the `A>B` / `tie` / `B>A` radios. |
| 3 | Collapse each panel in turn, then reload | Every collapse survives. A collapsed panel's content is hidden, not unmounted — a half-typed verdict is still there when you expand it. |
| 4 | Reorder two panels with the drag handle's **arrow keys**, then reload | The order survives. Reordering is reachable from the keyboard alone — pointer-only would make it unavailable to anyone not using a mouse. |
| 5 | In devtools, set `studio:labelling:<setId>` to `{` and reload | Defaults render. **No white screen.** This is the `JSON.parse` guard, which `reconcile` cannot cover because it never sees an unparseable string. |
| 6 | Set it to a valid array containing `{"kind":"telepathy",...}` and reload | The unknown panel is gone; the rest are intact and in their saved order. |
| 7 | Look at the progression rail on any item | `Model judgment` and `Agreement` are rendered as **explicitly empty**, not omitted. Their state is announced to a screen reader, not carried by border style alone. |
| 8 | Look at the `reasoning` panel | It shows *why* it is empty — chain-of-thought is not captured on model calls yet — rather than a blank box. |
| 9 | Open the label view for a set you hold **no** assignment on | "Nothing is assigned to you here", not a blank screen or an error toast. |
| 10 | Label every item, then reload the queue | "You have finished this set". |
| 11 | On a set with `retestIntervalItems` larger than its item count, label the only item, then reload | **"Label N more items before this one comes back"**, with a real number. Not a blank screen — this is the accepted limitation of intervening-items-only eligibility, and it must read as informative. |
| 12 | Submit a reading on an item you have already read once (with `retestIntervalItems` at 0) | It advances to the next item and **nothing anywhere says which round it was**. Check the network tab too: the queue response must contain no `round` key. |

## The one that is easiest to get wrong

**Item 12.** Blinding is the entire reliability signal. If any part of this view ever learns the
round — a "you have seen this before" badge, a pre-filled previous score, a differently-shaped
response — test-retest stops measuring consistency and starts measuring memory, and *the number
still looks fine*. The server-side half is pinned by
`tests/db/labelling.test.ts` ("the queue never reveals that an item is a RE-READ"); this row is the
client-side half.

## Recording a run

Append a dated line with the commit, who walked it, and any row that failed with what changed.

| Date | Commit | Walked by | Result |
|---|---|---|---|
| 2026-08-17 | A1.5 Task 5 | implementation session | **All 12 rows walked against `npm run dev` + local Postgres, driving a real browser.** 11 passed as written. Row 7 found a defect and it was fixed before commit — see below. |

**What row 7 caught.** On a set in the `retest-not-yet-eligible` state the rail read
*"Item — not started / Human label — not started"*, directly above a message saying "Label 20 more
items before this one comes back". The queue returns that reason precisely BECAUSE a reading exists
and is too fresh to repeat, so the rail was contradicting the paragraph underneath it. `stagesFor`
now treats `retest-not-yet-eligible` and `set-complete` alike as work recorded. Re-walked: both now
read *"Item — complete / Human label — complete"*.

**Row 12, in detail, because it is the one that matters.** Six consecutive readings were driven
through a 3-item set with `retestIntervalItems: 0`, so every item was served **twice**. The queue
payloads for the first and second serving of each item were compared: identical key sets
(`candidates, inputText, itemId, promptText, protocol, responseText`), no `round`, no
`overallScore`, no `expected`. The seventh call returned `set-complete`. An annotator working
through this queue has nothing available to them that distinguishes a re-read from a first reading.
