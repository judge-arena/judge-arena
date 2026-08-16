# A1 complete — handoff for picking up A2

**Written 2026-08-16.** Supersedes `docs/superpowers/plans/2026-08-13-a0-status-and-handoff.md`,
every quantitative claim in which is now stale.

---

## 0. First: "A2" is ambiguous in this repo. Read this before anything else.

Two different documents number their phases `A0…A5`, and they do not mean the same thing.

| Label | Roadmap A — `specs/2026-08-10-judge-training-engine-roadmap.md` | Plan split — `specs/2026-08-14-dataset-lifecycle-and-tombstone-overlay-design.md` |
|---|---|---|
| A0 | Make the golden-set substrate reachable | *(not used)* |
| A1 | Human verification and a measured agreement floor | The tombstone overlay |
| A2 | The calibration engine | The revision log |

**The A2 this handoff is about is the revision log** — `docs/superpowers/plans/2026-08-14-a2-revision-log.md`,
six tasks, not started. Roadmap A's A2 (the calibration engine) is a different, later piece of work
and is not in scope.

The collision is real and it will mislead someone. Our completed A0 *does* correspond to Roadmap A's
A0, which makes it natural — and wrong — to read the next plan as Roadmap A's A1. **Recommendation:
rename the lifecycle plans to `L1`/`L2` (lifecycle) and leave `A0…A5` to Roadmap A.** That rename is
not done; it is a decision waiting for you in §6.

---

## 1. Where the code is

Nothing from A1 is pushed anywhere. Verified by `git ls-remote gitea`.

| Ref | SHA | Note |
|---|---|---|
| `feat/a1-tombstone-overlay` | `1ee28df` | HEAD of worktree `/root/judge-arena-worktrees/a0`, clean. **No upstream, no remote ref — this branch name has never left the machine.** |
| `feat/a0-golden-set-substrate` | `1ee28df` | Byte-identical to the above (A1 was a true fast-forward merge). Tracks gitea. |
| `gitea/feat/a0-golden-set-substrate` | `8d65198` | **35 commits behind local.** Head of open **PR #12**. |
| `gitea/main` | `7306c2f` | The de-facto trunk. Local branches are 87 ahead of it. |
| `main` (local) | `a192300` | Badly stale — 94 behind `gitea/main`. Do not use as a base. |

Two other PRs exist and are unrelated: **#11** (`test/config-roundtrip-fidelity`) and **#7**
(`docs/rebaseline-north-stars`). Those head↔branch mappings are verified from `git ls-remote`;
**whether any of #12, #11 or #7 is actually still open is not** — Gitea keeps `refs/pull/N/head`
after a PR closes, so the ref proves existence, not state. Check the web UI before relying on it.
There is no PR template anywhere in the repo.

**The other worktree `/root/judge-arena` is on `feat/1c-deploy-readiness` and has one uncommitted
file — `docs/superpowers/specs/2026-08-07-public-users-roadmap.md`. It is not ours. Do not touch it,
and do not edit that file from here**; a concurrent edit would collide with work in progress there.

Latest migration: `prisma/migrations/20260814120000_v2f_tombstone_overlay` (16 in the chain).

## 2. Suites at `1ee28df`

Run serially. Never run the DB and integration suites concurrently — they share one Postgres and
produce spurious failures.

| Suite | Config | Result |
|---|---|---|
| unit | `vitest.config.ts` | 35 files, **493** tests |
| db | `vitest.db.config.ts` | 37 files, **522** tests |
| integration | `vitest.integration.config.ts` | 10 files, **80** tests |

`npx tsc --noEmit` and `npm run lint` both exit 0. Total 82 files / 1095 tests.

**Caveat worth knowing.** The 522 came from `sh -c 'set -a; . ./.env.test; set +a; npx vitest run
--config vitest.db.config.ts'`, not from `npm run test:db` — the packaged script begins with a
`prisma migrate reset --force`. The counts are the same either way (every `tests/db` file truncates
in `beforeEach`), but the packaged command has not been exercised at this HEAD, and neither has
coverage: no suite was run with `--coverage`, so the threshold blocks are unverified against A1's
actuals. The prose inside `vitest.db.config.ts` still records A0's end-of-branch figure of
"444 tests, 35 files" and is stale.

## 3. What A1 shipped

Deletion became non-destructive. A `Tombstone` table with per-entity nullable `@unique` FK columns
hides rows instead of removing them, under a hand-edited
`CHECK (num_nonnulls("datasetSampleId","datasetId") = 1)` that Prisma's tooling cannot see — hence
its row in `CONTRIBUTING.md`'s pseudo-drift table (five rows; A2's `v2g` needs no hand edit, so it
must stay at five).

`src/lib/tombstones.ts` is the single definition of "hidden" and exports:

```ts
liveSamplesOnly(): Prisma.DatasetSampleWhereInput     // { NOT: {...}, dataset: { NOT: {...} } }
liveDatasetsOnly(): Prisma.DatasetWhereInput          // { NOT: {...} }
tombstoneSample(tx, datasetSampleId, reason?): Promise<void>
tombstoneSamples(tx, datasetSampleIds[], reason?): Promise<number>   // returns a COUNT, not ids
tombstoneDataset(tx, datasetId, reason?): Promise<void>
restoreSample(tx, datasetSampleId): Promise<void>     // updateMany — no-op if never hidden
nextSampleIndex(tx, datasetId): Promise<number>       // max(index) over ALL rows, +1
```

Three things a newcomer gets wrong:

1. **`liveSamplesOnly()` sets two keys**, including a parent arm (`dataset:`). A caller that already
   has a `NOT:` or a `dataset:` key must **merge, not spread**.
2. **The `NOT` formulation is load-bearing.** Prisma compiles it to
   `NOT (isTombstone = $1 AND id IS NOT NULL)`, and the injected `IS NOT NULL` is what makes the
   no-tombstone case work. `tombstone: null` loses every *restored* row; `{ isTombstone: false }`
   loses the entire clean corpus. Both were measured during the A1 review, by capturing emitted SQL
   across 24 query shapes; the record of that lives in `src/lib/tombstones.ts`'s module doc rather
   than in a test, so it is documentation, not an enforced invariant. Do not "simplify" it.
3. **Ordinals are never reused.** `@@unique([datasetId, index])` is deliberately not partial, so a
   hidden row keeps its number forever and `index` is not dense. Anything deriving a position from a
   count, a `length`, or a live-filtered max collides — but only once a hidden row exists, so it
   passes every test written against a clean fixture.

Eleven reads deliberately stay unfiltered, each marked `MUST NOT BE TOMBSTONE-FILTERED (A1)`:
`grep -rn "MUST NOT BE TOMBSTONE-FILTERED (A1)" src/ scripts/` (prints 13 hits — two are
cross-references in `tombstones.ts` itself, not members).

## 4. The A2 plan is NOT safe to execute verbatim

The plan was written before A1 was implemented, and A1 changed shape substantially during execution.

**The plan's line references into `src/app/api/datasets/[id]/samples/route.ts` are stale** — Task 3
locates `PATCH` at `:97` with its lookup at `:120-127` and update at `:133-146`; at HEAD they are
`:212`, `:240` and `:256`, off by 115 to 123 lines. Its four references to *config and test* files
are current and can be trusted: `tests/db/access-matrix.test.ts:94-100`, `CONTRIBUTING.md:407-443`,
and `vitest.db.config.ts:42-73`. Re-anchor route edits by symbol; the plan's *intent* survives
throughout, but its quoted before-images for that route do not.

Defects found by reading the plan against the real code. Fix these as you reach them:

**Wrong module paths — every new route file is affected.**
- `RateLimitedError` lives in `@/lib/auth-guard`, not `@/lib/rate-limit`.
- Test helpers are `tests/db/helpers.ts` exporting `db`, `truncateAll`, `mkUser`. The plan imports
  `./helpers/db` and `./helpers/factories`, which do not exist.

**Snippets that regress A1 if applied literally.**
- Task 4's DELETE snippet writes `tombstoneSamples(tx, sampleIds)` — dropping the `'sample deleted'`
  reason A1 passes, renaming the binding the response body reads (`{ tombstoned, remaining }`), and
  referencing a variable that does not exist (the real one is the *resolved* `samples.map(s => s.id)`,
  deliberately, not `data.sampleIds`).
- Task 4's PUT snippet re-derives `outgoingIds`, dropping A1's `if (outgoing.length > 0)` guard and
  its `'bulk replace'` reason. A1 already computes that list as `outgoing`; reuse it.
- Task 3's import line omits `liveDatasetsOnly`, which the real four-name import block includes and
  which PATCH, DELETE and PUT all use. Replacing the block verbatim breaks the file.

**Claims in the plan that are false.**
- "PATCH … is untouched by A1" — A1 filtered both its dataset read and its sample read. The
  substantive point (PATCH still overwrites content with no history) does hold.
- Task 3 Step 3 tells you to replace a `findUnique` that is not there; A1 already made it a filtered
  `findFirst`. The only real edit is widening the `select`.
- Task 2's interface-contract block and its Task 2 Step 3 signature disagree. **Use the union**; the
  contract block is the stale one.

**Two things that will bite later.**
- Task 6's ordering test is likely flaky: it seeds two revisions in one `createMany`, and
  `@default(now())` resolves to the *transaction* timestamp — identical for both rows — so
  `orderBy: { at: 'desc' }` is undefined between them. Seed distinct `at` values. (Task 3's
  two-edit test is safe: separate transactions.)
- Tasks 5/6 say to add rows to `tests/db/access-matrix.test.ts` "following the dataset registry
  entry's shape". Not directly possible: `ResourceHandlers` is `{createTarget, get, patch, del}`
  over a single `id`, and the registry is typed to six fixed resource keys. A POST-only restore route
  and a two-param sub-resource need a harness change or standalone auth tests. Budget for it.

**One good thing:** `tests/db/helpers.ts` derives its TRUNCATE list from `pg_tables` at runtime, so
`SampleRevision` is picked up automatically. No helper edit needed.

## 5. A1's residual findings, re-verified at `1ee28df`

Two were fixed by later waves without the record being updated. That is exactly the drift this
re-verification existed to catch — treat the list below as authoritative over anything older.

| Id | Finding | State at HEAD | Disposition |
|---|---|---|---|
| **R1** | `nextSampleIndex` concurrent-append race; POST has no retry loop | **still true** | Separate branch — A2 never opens POST |
| **R2** | Golden-set replace had no transaction ceiling | **fixed** (`8b7972c`) | Closed |
| **R3** | Importer CREATE branch unatomic; no duplicate-`index` refine | **half fixed** — refine landed (`8b7972c`), atomicity did not | Cheap to fold into A2 Task 4 |
| **R4** | An inert `_count` has no automated guard | **still true** | Delete the `_count` rather than guard it |
| **R5** | Pin-guard 409 is terminal — no purge path | **half fixed** — message honest (`531dc6d`), terminality stands | Accept and document |
| **R6** | `tombstoneSample`/`restoreSample` have no production caller | **still true** | A2 Task 5 gives `restoreSample` its first caller |

Detail worth carrying:

- **R1** is *pinned rather than fixed*. `tests/db/dataset-sample-tombstone.test.ts:2506` asserts the
  losing transaction takes a P2002 — **it is written to fail when the retry loop is added, by
  design.** Whoever lands the retry must flip that test and correct two comments in the same commit.
  Compare `src/lib/dataset-versions.ts` (`isRetryableVersionConflict`, `MAX_ATTEMPTS`) for the shape.
- **R4**: the site is POST's guard read in `src/app/api/datasets/[id]/samples/route.ts`. Nothing
  consumes the value, so no behavioural test can protect it and none does. Deleting `_count` from
  the select removes the thing needing a guard. Do not add a comment-only "fix".
- **R5**: the message no longer prescribes a remedy, because the remedy it used to prescribe
  provably did nothing. It still implies the golden set could cease to exist, which no in-product
  verb achieves.

## 6. Decisions waiting for the owner

None of these are blockers for starting A2, but each will be hit early.

1. **Which branch does A2 build on** — `feat/a0-golden-set-substrate` (tracks gitea, carries PR #12)
   or a new `feat/a2-revision-log`? They are the same commit today; picking wrong diverges them.
2. **Push before or after A2?** PR #12 currently shows 52 commits of A0. Pushing makes it an 87-commit
   A0+A1 PR **with an A0-only description** — that body needs rewriting either way.
3. **The `A0…A5` naming collision** (§0). Rename the lifecycle plans, or document the collision and
   live with it.
4. **Account deletion destroys revisions.** `src/lib/account-deletion.ts` hard-deletes a user's
   private datasets, which cascades `DatasetSample` → `SampleRevision`. The spec's "anonymise rather
   than destroy" therefore holds only for revisions on *other people's* samples. A2 has no task
   touching this. Needs a ruling.
5. **`GET …/revisions` exposure**: owner-only or `datasets:read`? Strangers can read public datasets'
   *prior* text if the latter. Is actor identity projected? Is it paginated? Undecided.
6. **Restore/history on a hidden dataset.** Both new routes use a bare `prisma.dataset.findUnique`
   for ownership while every sibling uses `findFirst` + `liveDatasetsOnly()`. As written, a sample
   of a *hidden* dataset can be restored and its history read. Defensible for restore; unstated for
   the GET. Decide deliberately.
7. **`changeType` has no database constraint** — a bare `String`, guarded only by Zod/TS. `v2g` is
   planned to need no hand edit (keeping `CONTRIBUTING.md` at five rows). Confirm that is intended.
8. **A second coverage re-baseline?** `src/lib/sample-revisions.ts` lands inside the `src/lib/**`
   glob in both configs, moving aggregate actuals. Floors sit −2pp/−3pp below actuals with ±0.23pp
   documented jitter. **Never lower a floor to go green** — if a re-baseline is wanted it is a
   deliberate, one-time, all-globs-visible change, as A0 did at `0a17722`.
9. **There is no `restoreDataset`.** A hidden *sample* can be restored; a hidden *dataset* cannot.
   The plan flags this and asks that it be raised rather than discovered. Deferred to Plan B.
10. **Consent id.** `package.json`'s `test:db` bakes in
    `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION=approved-plan-2026-07-24-1a-testdb-only`, while the
    A2 plan uses `approved-plan-2026-08-15-a2-revision-log` for its `migrate dev`. These are
    different ids for different commands; confirm the new one is granted before Task 1 Step 6.

## 7. Starting A2: the first hour

```bash
cd /root/judge-arena-worktrees/a0          # or a fresh worktree, per decision 1
git status                                  # expect clean at 1ee28df
npx prisma migrate status                   # expect "Database schema is up to date!", 16 migrations
npx tsc --noEmit && npm run lint
npm test                                    # 493
sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts'   # 522
npm run test:integration                    # 80 — needs Redis :6379 and RabbitMQ :5672
```

Write those starting numbers down. The A2 plan forbids asserting absolute suite counts — each task's
contract is *zero failures and no fewer tests than the previous task left* — so the baseline has to
be observed, not assumed.

Then read, in this order: the spec's "The overlay and the log" section — the canonical
`SampleRevision` Prisma block is `:98–116`, directly below `model Tombstone` — then "Recording a
mutation"; then §4 above; then Task 1.

**Database safety, every session.** Local Postgres is the podman container `judge-arena-pg` on
`localhost:5432`. **Production is the Kubernetes pod `judge-arena-pg-1` in namespace `tenant-public`
and must never be touched.** The names differ by one character. Never `prisma db push`. Never
`migrate deploy` against anything but local.

## 8. Method notes that paid off, worth keeping

- **Demonstrate discrimination; do not assert it.** For every test: break the thing under test, run
  it, quote the real failure, restore, confirm byte-identical by sha256. This caught a `git checkout`
  that silently discarded four uncommitted source edits, and a projection bug mid-implementation that
  no review had found.
- **Restore with an inverse edit, never `git checkout <file>`** — it reverts to HEAD and takes
  uncommitted work with it.
- **Verify comments against HEAD, not against the commit that wrote them.** Several comments on this
  branch were true when written and falsified by a later commit on the *same* branch; a per-commit
  reading clears them all. This is why the final review landed code first and swept prose afterwards,
  once, against a tree that had stopped moving.
- **A sweep is an enumeration, and enumerations miss.** Three filter sweeps ran; a later review found
  an entire missed *class* — nested relation arguments, invisible to any `findX` grep.
- **Distrust handed-over lists.** A reviewer told to verify a three-item list found nine, and the two
  missing entries were where the real defect lived.
- **Fact-check the handoff too.** This document was checked against the repo before it was committed:
  ~96 discrete claims, of which **two were false** and five were not checkable. One of the false ones
  was an over-generalisation — "every line reference in the A2 plan is stale", inherited from a
  survey's phrasing and true only of one task's — which is the exact failure this section warns
  about, committed while writing the warning. The five unverifiable ones are now labelled as such in
  place rather than quietly asserted.
