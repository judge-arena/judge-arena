# L2 complete, residuals closed, A1 planned — handoff

**Written 2026-08-17.** Supersedes `2026-08-16-l1-complete-l2-handoff.md`, whose §1 branch table and
§5 residual list are both now stale. That document is still worth reading for §3 (what L1 shipped)
and §8 (method notes), which remain accurate.

**Everything below was verified against the tree and the cluster on 2026-08-17, not carried forward.**

> **UPDATE, later the same day: §4 item 1 is DONE.** A1 was executed in full — all seven tasks,
> `4ff04f4`…`eef73fb`. What that changes in this document:
>
> - **§1 "Where the code is"** — the branch is no longer at `e62501e`/`7afa2ac`; `HEAD` is
>   `eef73fb`, and the latest migration is `20260818120000_v2h_human_verification`, **18 in the
>   chain**, not 17.
> - **§2 "Suites"** — now **578 unit / 633 db / 80 integration** (from 508 / 555 / 80): 533 unit
>   after A1, 578 after A1.5, whose work is all unit-tested library code. §9's "write those numbers
>   down" baseline was observed before starting and matched the table exactly.
> - **§4 "What to do next"** — items 1 AND 2 are closed. A1.5 landed straight after A1
>   (`133cc12`…`05bf29b`), so **item 3, spec A2, is now next** — and it is still gated on T5,
>   which is still open. That gate is now the only thing in front of A2.
> - **§7 "Open decisions and hard gates"** — A2's *A1 gate* is closed: `GoldenLabel` has a writer.
>   The **T5 RabbitMQ gate is untouched** and remains the reason A2 cannot start.
> - **§5's annotator distinction was the right call and is now load-bearing in code**, not just in
>   prose: `agreement()` returns `insufficient-annotators` rather than `0`, and the overlap model,
>   assignment rows and Fleiss path are all built and tested against multi-`User` fixtures exactly as
>   §5 said they should be.
>
> **R4 and R5 are now CLOSED too** — R4 by deleting the inert read, R5 as accepted-and-documented.
> **Still open:** the deploy + seed of the built image,
> roadmap decisions #4 and #7, and `reasoning_content` capture (preflight Stage 5).
>
> §8's method notes are unchanged and were repeatedly vindicated — see the plan's own **"Defects
> found during execution"** table, in which its "a malformed break is not evidence" rule caught the
> plan.

---

## 0. The map — read this before anything else

Fourteen documents govern this work. Here is what each is for, so you do not read the wrong one.

### Roadmaps and platform

| Document | What it is |
|---|---|
| `specs/2026-08-10-judge-training-engine-roadmap.md` | **Roadmap A** — the phase sequence A0…A5. The status table near the top is current. |
| `specs/2026-08-10-benchmark-sharing-roadmap.md` | Roadmap B — the public leaderboard half. Not started. |
| `specs/2026-08-08-north-star-rebaseline-design.md` | The platform foundation both roadmaps inherit — data tiers, retention, cluster constraints, the T-numbered work. |
| `plans/2026-08-10-judge-arena-roadmap-a-preflight.md` | The deployment preflight. Stages 1, 2, 3 and 6 are done; **Stage 5 (capture gaps) is open**. |

### The lifecycle work — complete

| Document | What it is |
|---|---|
| `specs/2026-08-14-dataset-lifecycle-and-tombstone-overlay-design.md` | The design L1 and L2 implement. Status: fully implemented for Plan A. |
| `plans/2026-08-14-l1-tombstone-overlay.md` | **L1** — deletion became non-destructive. Complete. |
| `plans/2026-08-14-l2-revision-log.md` | **L2** — every mutation recorded. Complete; carries its own "Corrections applied" table. |
| `plans/2026-08-16-l1-complete-l2-handoff.md` | The previous handoff. Superseded by this one. |

### What comes next — specced, planned, not implemented

| Document | What it is |
|---|---|
| `specs/2026-08-17-a1-human-verification-design.md` | **A1** design — labelling, assignment, agreement, provenance. |
| `plans/2026-08-17-a1-human-verification.md` | **A1 plan — 7 tasks. This is what to execute next.** |
| `specs/2026-08-17-a1_5-annotation-studio-design.md` | **A1.5** design — the panel shell A2 and A3 also consume. |
| `plans/2026-08-17-a1_5-annotation-studio.md` | **A1.5 plan — 5 tasks.** Independent of A1; either may land first. |
| `specs/2026-08-17-a2-calibration-and-reporting-decisions.md` | **A2 decisions only**, deliberately not a spec — its design takes A1's real label data as an input. |

**On labels.** `L1`/`L2` are the dataset-lifecycle plans. `A0…A5` are Roadmap A phases. They were
renamed apart on 2026-08-16 because both used `A1`/`A2` for different work. **`(A1)` markers in
`src/`, `feat(a1):` commit prefixes, and the `v2f` migration header mean L1** — they predate the
rename and cannot move, because one lives in an applied migration Prisma checksums.

---

## 1. Where the code is

| Ref | SHA | Note |
|---|---|---|
| `feat/a0-golden-set-substrate` | `e62501e` | **A0 + L1 + L2 + R1 + R3 + all specs and plans.** Checked out in worktree `/root/judge-arena-worktrees/a0`. |
| `gitea/feat/a0-golden-set-substrate` | `e62501e` | **In sync** — pushed 2026-08-17. |
| `gitea/feat/a1-tombstone-overlay` | `1dcd73c` | L1's branch, now behind. Nothing outstanding on it. |
| `gitea/main` | `7306c2f` | The de-facto trunk. This branch is far ahead of it. |
| `main` (local) | `a192300` | Badly stale. **Do not use as a base.** |

**PR #12** is at `gitea.lab.asethi.com/trij/judge-arena/pulls/12`. It opened describing **A0 only**
and now carries A0 + L1 + L2 + R1 + R3, so its body is out of date unless the owner has pasted the
replacement. **The prepared body is committed at `../pr-12-body.md`** — not left in a scratchpad,
which does not survive a session. Whether the PR is still open is not verifiable from
`git ls-remote` (Gitea keeps `refs/pull/N/head` after close); check the web UI.

**Two other worktrees are not ours.** `/root/judge-arena` is on `feat/1c-deploy-readiness` with an
uncommitted file; leave it alone. The others (`llamacpp`, `preflight`, `rebaseline`, `roundtrip`) are
older branches.

Latest migration: `20260815120000_v2g_sample_revisions` — **17 in the chain**.

## 2. Suites at `e62501e`

| Suite | Files | Tests |
|---|---|---|
| unit | 37 | **508** |
| db | 39 | **555** |
| integration | 10 | **80** |

`npx tsc --noEmit` and `npm run lint` exit 0. `prisma migrate status` reports 17 migrations and
"Database schema is up to date!".

**Run them serially.** Never run the DB and integration suites concurrently — they share one
Postgres and produce spurious failures.

### The stage ladder

Because none of this stack is on `main`, each stage was verified **on its own tree with its own
migration set**, using the packaged `npm run test:db` so `prisma migrate reset --force` replays
exactly that stage's migrations — which is what makes stepping *backwards* down the ladder safe.

| Stage | migrations | unit | db | integration |
|---|---|---|---|---|
| A0 (`8d65198`) | 15, through `v2e` | 476 / 34 | 444 / 35 | 80 / 10 |
| A0+L1 (`1dcd73c`) | 16, through `v2f` | 493 / 35 | 522 / 37 | 80 / 10 |
| A0+L1+L2 (`53f33e2`) | 17, through `v2g` | 499 / 36 | 552 / 38 | 80 / 10 |
| +R3 (`cb88692`) | 17 | 499 / 36 | 553 / 38 | 80 / 10 |
| +R1 (`96b7c12`) | 17 | 508 / 37 | 555 / 39 | 80 / 10 |

No stage regresses the one before it. Incidentally this confirmed a comment rather than a claim: the
prose inside `vitest.db.config.ts` records "444 tests, 35 files", which is exactly **A0's** figure —
not wrong, just pinned to A0 and never updated as L1 and L2 landed on top.

## 3. What landed in this session

- **L2, all six tasks** (`cf23fd7…68f26dc`) — `SampleRevision`, the writers, `PATCH` before-images,
  the bulk verbs, the restore route, the history route.
- **R3** (`cb88692`) — the config importer's dataset CREATE branch is one transaction. It was the
  last hide-then-write pair in the tree that was not.
- **R1** (`96b7c12`) — `POST …/samples` retries an ordinal collision instead of reporting a bare 500.
- **The L1/L2 rename** (`0cc8bfd`) and the plan re-anchoring (`6e387ed`).
- **A1, A1.5 and A2 documents** (`43ce744`, `7b1ea56`, `e62501e`).

## 4. What to do next, in order

1. **Execute A1** — `plans/2026-08-17-a1-human-verification.md`, 7 tasks. It gives `GoldenLabel` its
   first writer, which is what everything downstream is waiting on.
2. **Execute A1.5** — `plans/2026-08-17-a1_5-annotation-studio.md`, 5 tasks. Independent; can go
   first, second, or in parallel. Its last task is the only place the two meet, and it degrades to a
   static fixture if A1 has not merged.
3. **Then, and only then, spec A2.** Its decisions are recorded; its design needs A1's real label
   data. It is additionally hard-gated on T5 — see §7.

## 5. The annotator distinction — the thing most likely to be got wrong

Written into the roadmap's A1 section in full. The short version:

**One annotator is a DEVELOPMENT constraint, not a product one.** Exactly one account exists today,
so every inter-annotator statistic is *unavailable* rather than bad — `agreement()` returns
`{ value: null, reason: 'insufficient-annotators' }`, never `0`, because `0` reads as total
disagreement. `testRetest` is the only signal that produces a number at launch.

**But multiple annotators are coming through the owner's backend**, so the overlap model, assignment
rows, Fleiss's kappa and the disagreement queue are real product paths. They are **built and tested
now** using fixtures that create N `User` rows — a DB test does not need the backend to have three
annotators disagree. What waits on API access is only the **annotation-validation code**: how
annotators are provisioned, authenticated and routed work from the external service.

The failure this prevents: building A1 against one annotator, discovering at integration that overlap
was never modelled, and finding the shipped agreement number was computed over an overlap of one —
which is not a floor, and is not detectable from the number itself.

## 6. Decisions made this session

All are recorded in the specs with their reasoning; this is the index.

| # | Decision |
|---|---|
| 1 | Test-retest gets a `round` column; the label partial-unique widens to include it. Two readings are **peers**, not a tombstone and a survivor. |
| 2 | `overallScore` becomes nullable, `preference` is added, under a `CHECK`. A pairwise label is a preference, not a float. |
| 3 | Retest eligibility is **intervening-items only**, `K` stored per set. Accepted limitation: a set smaller than `K` can never produce a retest, so the queue must say so explicitly. |
| 4 | Agreement is **computed on read, recorded at freeze**. |
| 5 | Provenance is item-level: `GoldenItemRevision` + a label FK to the revision it was answered against, **back-filled by the edit**. |
| 6 | Assignment is **explicit `GoldenAssignment` rows**. |
| 7 | **No model relation anywhere on `Golden*`** — reversed from an earlier draft. A golden set is questions, answers and labels; the model enters at evaluation time. |
| 8 | Who may hold an assignment: owner + admin, while one account exists. Mechanism and policy kept separate. |
| 9 | The studio is **A1.5**, split from A1, because A2 and A3 reuse it. |
| 10 | A calibration run produces **two artifacts**: `CalibrationRun` (header, leaderboard-facing, frozen once published) and `EvaluationReport` (item-by-item, a **projection** over stored per-item answers). |
| 11 | Per-item retention is **uncapped for now** — an accepted risk, see §7. |

## 7. Open decisions and hard gates

**Gates on A2, both open:**

- **A1**, for labels. There is no `GoldenLabel` writer today.
- **Rebaseline T5.** Measured 2026-08-17 on `rabbitmq-judge-arena-server-0`: **0.1405 GB against a
  0.2577 GB watermark — 54.5% at idle**, with **zero** VMServiceScrapes and **zero** VMRules covering
  RabbitMQ. Calibration is a burst of judgment work against exactly that broker, and the failure is
  silent: publishers block, no metric moves, and the symptom points at the worker.

**Accepted risks:**

- **Retention is uncapped.** Nothing in `src/` caps `rawResponse` or `reasoning` — verified, not
  assumed. A2's per-item rows are the heaviest data this product will hold. The failure mode is a
  full storage pool on a single-instance Postgres, whose first symptom is *unrelated writes failing*.
  The cheap mitigation when wanted is a documented byte cap with truncation recorded.
- **`reasoning_content` is discarded on every model call** (preflight Stage 5). The studio's
  reasoning panel is structurally thin until this lands. Backlogged deliberately.

**Still-open residuals from L1** (`2026-08-16` handoff §5 — R1 and R3 are now closed):

- ~~**R4**~~ — **CLOSED 2026-08-17.** The inert `_count.samples` is deleted from POST's guard
  select, so there is nothing left to guard. Not a comment-only fix, for the reason this line always
  gave: nothing can test a value no one reads, so the warning could have gone stale with the suite
  green. The one load-bearing fact it carried — a LIVE count is the wrong basis for an ordinal —
  moved to the `nextSampleIndex` call site, which is the only code that depends on it.
- ~~**R5**~~ — **CLOSED 2026-08-17 as ACCEPTED.** Terminality stands and is documented at
  `findGoldenSetsPinningDataset`, the one predicate its four callers share: it follows from two
  rulings that are each correct on their own (a golden set is never destroyed, so it never releases
  its FKs; and this predicate is deliberately not lifecycle-filtered, because filtering it converts
  a clean 409 into the raw P2003 it exists to prevent). Only a purge wave, authorised separately,
  could lift it. The doc warns against the tempting wrong fix.

**Also open:** the deploy + seed of the built image (prod still runs an old tag with an empty
catalog), and roadmap decisions #4 (perturbation set) and #7 (PPI config), both of which gate A2/A3.

## 8. What this session cost, and what would have prevented it

Method notes, in descending order of what they actually saved.

- **A green test proves nothing until you have seen it fail.** Two tests in this session passed while
  proving nothing. R3's atomicity test used `version: '2.0'` and was rejected at the schema with a
  400, never reaching the branch under test. L2's importer test edited sample *text*, but the replace
  is gated on a diff that compares dataset fields and sample *count* — so it was a skip. **Both were
  caught by printing the actual status rather than trusting the pass.** When a test passes on its
  first run, that is the moment to be suspicious, not satisfied.
- **A malformed break is not evidence.** Proving R1's retry discriminated, the first attempt replaced
  the call with a closure that was never invoked; the tests failed with "0 times" — a failure for the
  wrong reason. Restoring and breaking it *correctly* gave `expected 500 to be 201`, the real defect.
  If the failure message does not describe the defect you meant to inject, you have not demonstrated
  anything.
- **Test statistics against a published oracle, never against your own output.** A snapshot of what
  an implementation returns proves it is stable, not correct, and a wrong kappa is the archetypal
  confidently-plausible number. A1's plan carries hand-worked fixtures for this reason — and the
  self-review caught that the fixture's own prose claimed κ = 0.4915 for arithmetic yielding 0.40.
- **A fact about a remote decays faster than a fact about the tree.** The previous handoff said L1's
  branch "has never left the machine". It was pushed within hours. Re-run `git ls-remote`; do not
  trust the row.
- **A handoff instruction can be confidently wrong.** That handoff said the test pinning the ordinal
  collision "is written to fail when the retry loop is added" and must be flipped. It does not fail,
  and must not be flipped: it calls `nextSampleIndex` directly, so it pins the *function* — still
  unserialised, still true — not the route. **Verify an inherited instruction by running it** before
  acting on it.
- **Anchor plan edits by symbol, never by line.** L2's plan had route line references 115–123 lines
  stale by execution — the single most expensive defect in it. Eleven defects were fixed in that plan
  before execution and three more were found during it.
- **`tsc` catches test shortcuts that hide missing coverage.** L2's plan cast a mock to `never`; that
  compiles, and it also erases the property being asserted, so nothing checks it still exists.
  Declaring the spy's argument type kept the assertions genuinely typed.
- **Two environment traps that read as something else.** `.env.local` holds a **quoted**
  `DATABASE_URL`, so `grep | cut` yields a quoted string and Prisma fails `P1012` — which reads like
  schema drift. And bare `npx prisma` fails identically: Prisma loads `.env`, and this tree has none.
  Source the file: `sh -c 'set -a; . ./.env.local; set +a; npx prisma …'`.
- **`prisma format` reformats files you did not touch.** It re-aligned `Dataset` and `GoldenSet`
  while L2 added one field. Those hunks were reverted so the commit showed the three real edits.
- **Ask before working around a blocked capability.** Reading a cluster secret to update the PR body
  was refused by the permission classifier. The right move was to stop and offer the options, not to
  find another route to the same credential.

## 9. Starting A1: the first hour

```bash
cd /root/judge-arena-worktrees/a0
git status                                    # expect clean at e62501e
sh -c 'set -a; . ./.env.local; set +a; npx prisma migrate status'   # 17 migrations, up to date
npx tsc --noEmit && npm run lint
npm test                                      # 508
npm run test:db                               # 555 — packaged, includes a migrate reset
npm run test:integration                      # 80 — needs Redis :6379 and RabbitMQ :5672
```

Write those numbers down. **A1's plan forbids asserting absolute suite counts** — each task's
contract is zero failures and no fewer tests than the previous task left — so the baseline has to be
observed, not assumed.

Then read, in this order: the roadmap's **A1 section** (especially the annotator distinction), the
A1 **design** ("The layering this phase sits in" and "Decisions"), and then **Task 1** of the plan.

**Database safety, every session.** Local Postgres is the podman container `judge-arena-pg` on
`localhost:5432`. **Production is the Kubernetes pod `judge-arena-pg-1` in namespace `tenant-public`
and must never be touched.** The names differ by one character. Never `prisma db push`. Never
`migrate deploy` against anything but local.

**One thing to expect that looks like a bug and is not.** A1's agreement panel will report
`insufficient-annotators` rather than a number for as long as one account exists. That is correct —
see §5 — and the UI must read as informative rather than broken.
