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

   **Open `/golden-sets/<id>` and click "Assign to me".** That button is the supported path as of
   `0309a7e`; before it there was no browser route to an assignment at all, which is why this
   section used to hand out raw SQL. Owning a set is NOT enough to be served items from the queue —
   an active assignment row is what the queue reads — and that is the single thing about this
   screen most likely to be misread as a bug.

   <details><summary>SQL fallback, for builds older than <code>0309a7e</code></summary>

   ```sql
   -- whole-set assignment for the signed-in account
   INSERT INTO "GoldenAssignment" ("id","goldenSetId","annotatorId","round","assignedAt")
   VALUES (gen_random_uuid()::text, '<setId>', '<userId>', 1, now());
   ```

   </details>

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

### Golden-set surfaces (added by `0309a7e`)

Same constraint, same reason: `src/app/golden-sets/**` is outside every coverage `include` and has
no DOM test environment to render into. Rows 13–18 cover the two surfaces that commit adds.

| # | Step | Expected |
|---|---|---|
| 13 | On `/golden-sets`, create a set with **All samples** | The set is created with one item per LIVE sample. A tombstoned sample contributes nothing. |
| 14 | Create one with **First N** and one with **Random N** over the same dataset, N identical | Both hold N items. The two index lists are **different** — if Random returns the prefix, the whole point of the mode is gone. This is the browser-level twin of the `sample-selection` injection. |
| 15 | Create one with **Random %** on a dataset with rows hidden | The count is the percentage of the LIVE rows, not of the raw rows. 25% of 40 rows with 20 hidden is **5**. |
| 16 | On `/golden-sets/<id>` as the owner, with no assignment | The assignment panel says owning the set is not enough to label it, and offers **Assign to me**. |
| 17 | Click **Assign to me**, then follow the shortcut into the studio | The queue serves an item instead of "Nothing is assigned to you here". The assignment row lists the annotator as a **name**, never a cuid and never an email. |
| 18 | Click **Revoke**, then reload | The row is gone from the active list. It is revoked, not deleted — the record of what was asked survives in the database. |

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
| 2026-08-29 | `0309a7e` (+ the fixes landed with it) | pre-merge session | **Rows 14, 16, 17 and 18 walked** against `npm run dev` + local Postgres in a real browser, as `walk@judgearena.local`. All four passed. **Rows 13 and 15 were NOT walked** — see below. |

**What the 2026-08-29 walk actually proved.** Row 14 is the one worth recording, because it is the
only browser-level evidence that random selection is not a prefix. Two sets were created over the
same 620-row JudgeBench dataset with N=30:

```
WALK first 30    0,1,2,3,4,5,6,7,8,9,10,…,29
WALK random 30   14,61,62,76,90,121,152,162,165,171,177,179,252,256,261,
                 288,309,328,343,363,366,428,439,441,450,479,496,508,519,529
```

Row 16 rendered the "Owning this set is not enough to label it" copy with **Assign to me**; row 17
assigned, listed the annotator as `Walk Tester · whole set · round 1` — a name, not a cuid, not an
email — and the studio then served an item instead of "Nothing is assigned to you here"; row 18
revoked, the row left the active list, and `revokedAt` plus `revokedReason` survived in the
database, so it is a record and not a delete.

**Rows 13 and 15 were not walked, and neither is a gap in this commit.** Row 13 ("every live
sample") is pre-existing A0 behaviour that 0309a7e does not touch. Row 15's live-vs-raw denominator
needs tombstoned rows to discriminate at all, and it is pinned instead by the DB test
`randomPercent resolves against the LIVE sample count`, which was **rewritten in this commit**
because as originally written it tombstoned nothing and would have passed against either
denominator. Walk them the next time this file is exercised.

**One defect the walk surfaced, and it is NOT in this commit.** In the studio the pairwise
candidates render as "Option 1" / "Option 2" while the verdict control offers `A>B` / `tie` /
`B>A`, with nothing on screen saying which option is A. Every production `GoldenCandidate` has
`label IS NULL`. An annotator can answer the question, but only by assuming the ordering. Tracked
separately — do not read it as a regression from the assignment UI.

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
