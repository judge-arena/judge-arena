# L1 complete — handoff for picking up L2

**Written 2026-08-16.** Supersedes `docs/superpowers/plans/2026-08-13-a0-status-and-handoff.md`,
every quantitative claim in which is now stale.
**Revised 2026-08-16 (second pass)** — the rename in §0 is now done, §1's push status was wrong
within hours of being written, §4 gains a seventh defect, and §6's decisions are answered.

> **L2 IS NOW COMPLETE (2026-08-16).** All six tasks landed on `feat/a2-revision-log`
> (`cf23fd7…68f26dc`). Suites moved 493/522/80 → **499 unit / 552 db / 80 integration**, tsc and
> lint clean, 17 migrations. §4 below remains worth reading — it is the record of what was wrong
> with the plan and was corrected in place before execution — and §5's residuals are unchanged by
> L2 except **R6, which is now closed**: `restoreSample` has its first production caller.
>
> **The one thing to raise with the owner rather than let it be discovered** (plan self-review, and
> decision 9 below): **there is still no `restoreDataset`.** A hidden *sample* can now be restored
> through the API; a hidden *dataset* cannot, and `DELETE /api/datasets/[id]` remains one-way. That
> asymmetry is deliberate — un-deleting a dataset belongs with publish/unpublish in Plan B — but it
> is now visible in the product rather than theoretical, because the sample-level verb exists and
> the dataset-level one does not.

---

## 0. The naming collision, and how it was resolved

It used to be that two documents numbered their phases `A0…A5` and did not mean the same thing:
Roadmap A's A1/A2 are *human verification* and *the calibration engine*, while the lifecycle split
used A1/A2 for *the tombstone overlay* and *the revision log*.

**Resolved 2026-08-16: the lifecycle plans are renamed `L1`/`L2`, and `A0…A5` belongs to Roadmap A
alone.**

| Was | Is now |
|---|---|
| Plan A1 — `plans/2026-08-14-a1-tombstone-overlay.md` | **Plan L1** — `plans/2026-08-14-l1-tombstone-overlay.md` |
| Plan A2 — `plans/2026-08-14-a2-revision-log.md` | **Plan L2** — `plans/2026-08-14-l2-revision-log.md` |
| this file — `plans/2026-08-16-a1-complete-a2-handoff.md` | `plans/2026-08-16-l1-complete-l2-handoff.md` |

**The work in scope here was L2, the revision log** — six tasks, now complete (see the banner
above). Roadmap A's A2, the calibration engine, is a different and later piece of work; it is additionally hard-gated on the
rebaseline's T5 (RabbitMQ scrape, alerts and the per-run concurrency cap), which is not done.

**Three classes of artifact keep the old letters permanently, and that is not drift.**

1. **Commit messages.** Everything L1 shipped is prefixed `feat(a1):` / `fix(a1):` in history.
2. **Source comments.** The `MUST NOT BE TOMBSTONE-FILTERED (A1)` markers and the other `(A1)`
   annotations in `src/`. They were left alone deliberately — see below.
3. **`prisma/migrations/20260814120000_v2f_tombstone_overlay/migration.sql`**, whose header says
   "Plan A1". This one is not a choice: the migration is **applied**, Prisma records a checksum of
   the file in `_prisma_migrations`, and editing it makes every subsequent `migrate deploy` /
   `migrate status` fail with a modified-migration error. It can never be renamed.

Because (3) is immovable, renaming (2) would have produced a *three-way* split — docs saying L1,
comments saying L1, and the one unchangeable file saying A1 — which is worse than a clean two-way
one. So the rule is simply: **`(A1)` in code and in history means L1.** The plan bodies were not
swept for the same reason; they quote source text that genuinely carries those letters.

The bodies of `2026-08-14-l1-tombstone-overlay.md` and `2026-08-14-l2-revision-log.md` each carry
this note at the top.

---

## 1. Where the code is

> **CORRECTED 2026-08-16.** The first version of this section said "Nothing from A1 is pushed
> anywhere… this branch name has never left the machine." That was true when written and false
> within hours: `feat/a1-tombstone-overlay` was pushed to gitea at `1dcd73c` — the commit that
> *added this document*. Re-verified by `git ls-remote gitea`. The lesson is the one §8 already
> makes: a fact about a remote decays faster than a fact about the tree, so re-run the command
> rather than trusting the row.

| Ref | SHA | Note |
|---|---|---|
| `feat/a0-golden-set-substrate` | `1161e57` | **A0 + L1 + L2.** L2 was built on `feat/a2-revision-log` and fast-forward merged here on 2026-08-16, after which that branch was deleted. Tracks gitea and is **46 ahead** of it — **not pushed**. Checked out in worktree `/root/judge-arena-worktrees/a0`. |
| `feat/a1-tombstone-overlay` | `1dcd73c` | **Pushed**, and now behind the above by L2's 9 commits. `gitea/feat/a1-tombstone-overlay` is at the same SHA, so nothing is outstanding on it. |
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

Latest migration: `prisma/migrations/20260815120000_v2g_sample_revisions` (17 in the chain, added by
L2 Task 1). L1's `v2f_tombstone_overlay` is the one before it.

## 2. Suites at `1ee28df`

Run serially. Never run the DB and integration suites concurrently — they share one Postgres and
produce spurious failures.

| Suite | Config | Result |
|---|---|---|
| unit | `vitest.config.ts` | 35 files, **493** tests |
| db | `vitest.db.config.ts` | 37 files, **522** tests |
| integration | `vitest.integration.config.ts` | 10 files, **80** tests |

`npx tsc --noEmit` and `npm run lint` both exit 0. Total 82 files / 1095 tests.

> **Re-run 2026-08-16 at `1dcd73c`** — the docs commit sitting on top of `1ee28df` — and every
> number above reproduced exactly: 35/493 unit, 37/522 db, 10/80 integration, tsc and lint clean.
> `npx prisma migrate status` reports 16 migrations and "Database schema is up to date!". These are
> L2's baseline; the plan forbids asserting absolute counts, so each task's contract is zero
> failures and no fewer tests than the previous task left.

**Caveat worth knowing.** The 522 came from `sh -c 'set -a; . ./.env.test; set +a; npx vitest run
--config vitest.db.config.ts'`, not from `npm run test:db` — the packaged script begins with a
`prisma migrate reset --force`. The counts are the same either way (every `tests/db` file truncates
in `beforeEach`), but the packaged command has not been exercised at this HEAD, and neither has
coverage: no suite was run with `--coverage`, so the threshold blocks are unverified against L1's
actuals. The prose inside `vitest.db.config.ts` still records A0's end-of-branch figure of
"444 tests, 35 files" and is stale.

## 3. What L1 shipped

Deletion became non-destructive. A `Tombstone` table with per-entity nullable `@unique` FK columns
hides rows instead of removing them, under a hand-edited
`CHECK (num_nonnulls("datasetSampleId","datasetId") = 1)` that Prisma's tooling cannot see — hence
its row in `CONTRIBUTING.md`'s pseudo-drift table (five rows; L2's `v2g` needs no hand edit, so it
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
   loses the entire clean corpus. Both were measured during the L1 review, by capturing emitted SQL
   across 24 query shapes; the record of that lives in `src/lib/tombstones.ts`'s module doc rather
   than in a test, so it is documentation, not an enforced invariant. Do not "simplify" it.
3. **Ordinals are never reused.** `@@unique([datasetId, index])` is deliberately not partial, so a
   hidden row keeps its number forever and `index` is not dense. Anything deriving a position from a
   count, a `length`, or a live-filtered max collides — but only once a hidden row exists, so it
   passes every test written against a clean fixture.

Eleven reads deliberately stay unfiltered, each marked `MUST NOT BE TOMBSTONE-FILTERED (A1)`:
`grep -rn "MUST NOT BE TOMBSTONE-FILTERED (A1)" src/ scripts/` (prints 13 hits — two are
cross-references in `tombstones.ts` itself, not members).

## 4. The L2 plan is NOT safe to execute verbatim

The plan was written before L1 was implemented, and L1 changed shape substantially during execution.

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

**Snippets that regress L1 if applied literally.**
- Task 4's DELETE snippet writes `tombstoneSamples(tx, sampleIds)` — dropping the `'sample deleted'`
  reason L1 passes, renaming the binding the response body reads (`{ tombstoned, remaining }`), and
  referencing a variable that does not exist (the real one is the *resolved* `samples.map(s => s.id)`,
  deliberately, not `data.sampleIds`).
- Task 4's PUT snippet re-derives `outgoingIds`, dropping L1's `if (outgoing.length > 0)` guard and
  its `'bulk replace'` reason. L1 already computes that list as `outgoing`; reuse it.
- Task 3's import line omits `liveDatasetsOnly`, which the real four-name import block includes and
  which PATCH, DELETE and PUT all use. Replacing the block verbatim breaks the file.

**Claims in the plan that are false.**
- "PATCH … is untouched by L1" — L1 filtered both its dataset read and its sample read. The
  substantive point (PATCH still overwrites content with no history) does hold.
- Task 3 Step 3 tells you to replace a `findUnique` that is not there; L1 already made it a filtered
  `findFirst`. The only real edit is widening the `select`.
- Task 2's interface-contract block and its Task 2 Step 3 signature disagree. **Use the union**; the
  contract block is the stale one.

**A defect the first pass of this document missed — every `DATABASE_URL` command in Task 1 fails.**
Steps 4, 6 and 7 all build the URL as
`DATABASE_URL="$(grep -m1 '^DATABASE_URL=' .env.local | cut -d= -f2-)"`. The value in `.env.local` is
**double-quoted**, and `cut` keeps the quotes, so Prisma receives `"postgresql://…"` with literal
quote characters and dies:

```
Error code: P1012
error: Error validating datasource `db`: the URL must start with the protocol `postgresql://` or `postgres://`.
```

Reproduced 2026-08-16. Use the same sourcing idiom the DB-suite commands already use —
`sh -c 'set -a; . ./.env.local; set +a; npx prisma …'` — which strips the quotes correctly. Worth
noting *why* it was not caught by review: the line is quoted verbatim from L1's plan, where it
worked, because L1 was written before `.env.local` was rewritten with quoted values.

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

## 5. L1's residual findings, re-verified at `1ee28df`

Two were fixed by later waves without the record being updated. That is exactly the drift this
re-verification existed to catch — treat the list below as authoritative over anything older.

| Id | Finding | State at HEAD | Disposition |
|---|---|---|---|
| **R1** | `nextSampleIndex` concurrent-append race; POST has no retry loop | **still true** | Separate branch — L2 never opens POST |
| **R2** | Golden-set replace had no transaction ceiling | **fixed** (`8b7972c`) | Closed |
| **R3** | Importer CREATE branch unatomic; no duplicate-`index` refine | **half fixed** — refine landed (`8b7972c`), atomicity did not | Cheap to fold into L2 Task 4 |
| **R4** | An inert `_count` has no automated guard | **still true** | Delete the `_count` rather than guard it |
| **R5** | Pin-guard 409 is terminal — no purge path | **half fixed** — message honest (`531dc6d`), terminality stands | Accept and document |
| **R6** | `tombstoneSample`/`restoreSample` have no production caller | **CLOSED for `restoreSample`** (L2 Task 5, `92ccf24`) — `tombstoneSample` (singular) still has none; the verbs all use `tombstoneSamples` | Done |

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

None of these are blockers for starting L2, but each will be hit early. **Four were answered by the
owner on 2026-08-16 and are marked RESOLVED below; the rest are still open.**

1. ~~**Which branch does L2 build on**~~ — **RESOLVED: a new `feat/a2-revision-log`**, branched from
   `1dcd73c`. (The branch name keeps the `a2` spelling: it was created before the §0 rename, and
   renaming a branch that L2's commits already sit on buys nothing. The plan it implements is L2.)
   Rationale: it keeps L2 reviewable on its own and leaves the already-pushed A0/A1 branches
   untouched.
2. ~~**Push before or after L2?**~~ — **PARTLY OVERTAKEN BY EVENTS.** `feat/a1-tombstone-overlay` is
   already pushed (§1), so the "nothing has left the machine" framing no longer applies. What
   remains true and undecided: `gitea/feat/a0-golden-set-substrate` is still 36 behind, and **PR
   #12's body still describes A0 only**. Whoever advances that PR rewrites the body.
3. ~~**The `A0…A5` naming collision**~~ — **RESOLVED: renamed to `L1`/`L2`.** Done 2026-08-16; see
   §0, including the three classes of artifact that keep the old letters permanently.
4. **Account deletion destroys revisions.** `src/lib/account-deletion.ts` hard-deletes a user's
   private datasets, which cascades `DatasetSample` → `SampleRevision`. The spec's "anonymise rather
   than destroy" therefore holds only for revisions on *other people's* samples. L2 has no task
   touching this. Needs a ruling.
5. ~~**`GET …/revisions` exposure**~~ — **RESOLVED: owner-only** (plus admin, matching every sibling
   route), as the plan already drafted it. The log names who made each change and carries pre-edit
   text, which is not public data even on a public dataset. Actor identity **is** projected, to
   `{ id, name }` only. Pagination stays undecided — item 11 below.
6. ~~**Restore/history on a hidden dataset**~~ — **RESOLVED: filter both** with `liveDatasetsOnly()`,
   so a hidden dataset 404s on the restore route and on the history route alike. This follows the
   spec's Decision 15 (a hidden dataset is closed to writes) and Decision 16 (samples inherit their
   parent's hidden state), and it matches the sibling idiom — a bare `findUnique` for ownership was
   the one thing in these two routes that diverged from every other handler.
   **Note the asymmetry this leaves standing, deliberately:** the sample's *own* tombstone is still
   not filtered by either route. That is the point of them — restoring a hidden sample and reading
   its history are exactly the operations that need to see a hidden row. It is only the *parent*
   dataset that must be live. With no `restoreDataset` (decision 9), un-hiding one sample beneath a
   hidden dataset would not have made it visible anyway.
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
    L2 plan uses `approved-plan-2026-08-15-a2-revision-log` for its `migrate deploy`. These are
    different ids for different commands; confirm the new one is granted before Task 1 Step 6. Left
    spelled `a2` to match the branch name, for the same reason — it is an identifier, not a label.
11. **Is `GET …/revisions` paginated?** It is not, as drafted: the route returns a sample's entire
    history in one array. Unbounded in principle, though bounded in practice by how many times a
    human edits one row. Left as-is for L2 and recorded here so it is a choice rather than an
    oversight.

## 7. Starting L2: the first hour

> **Two corrections, both reproduced 2026-08-16.** `npx prisma migrate status` **does not work bare**
> in this repo: Prisma auto-loads `.env`, this tree has only `.env.local` / `.env.test` / `.env.example`,
> and with no `DATABASE_URL` in the environment it fails `P1012` — which reads like schema drift and
> is not. Source the file. The same applies to every `prisma` invocation in Task 1; see §4. And the
> starting SHA is `1dcd73c`, not `1ee28df` — the latter is one commit behind, before this document
> was added.

```bash
cd /root/judge-arena-worktrees/a0          # already on feat/a2-revision-log, per decision 1
git status                                  # expect clean at 1dcd73c
sh -c 'set -a; . ./.env.local; set +a; npx prisma migrate status'   # 16 migrations, "up to date!"
npx tsc --noEmit && npm run lint
npm test                                    # 493
sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts'   # 522
npm run test:integration                    # 80 — needs Redis :6379 and RabbitMQ :5672
```

Write those starting numbers down. The L2 plan forbids asserting absolute suite counts — each task's
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
  was an over-generalisation — "every line reference in the L2 plan is stale", inherited from a
  survey's phrasing and true only of one task's — which is the exact failure this section warns
  about, committed while writing the warning. The five unverifiable ones are now labelled as such in
  place rather than quietly asserted.
