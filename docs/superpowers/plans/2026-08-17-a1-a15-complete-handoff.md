# A1 and A1.5 complete, deployed and seeded — handoff

**Written 2026-08-17.** Supersedes `2026-08-17-l2-complete-a1-handoff.md`, whose §1 branch table,
§2 suite counts and §4 next-steps are all now stale. That document remains worth reading for its
**§8 method notes**, which are unchanged, were repeatedly vindicated this session, and are the most
transferable thing either handoff contains.

**Everything below was verified against the tree, the remote and the live cluster on 2026-08-17.**
Nothing is carried forward. Two rows in the previous handoff had already moved by the time this one
was written, which is the point.

**Updated 2026-08-29/30, and the update is not cosmetic.** Four things moved, each marked in place
with a dated **CORRECTION** rather than silently overwritten: `gitea/main` advanced to `14d75f7`
(§1); production acquired **2 golden sets, 650 items and still 0 labels** (§2); the reason E1 has
produced no labels turned out to be an **identity mismatch, not a missing person** (§4); and the
assignment UI shipped (§5.1). Text that was true on its 2026-08-17/18 date is kept, dated, next to
what replaced it — the corrections are the most useful part of this revision, because each one is a
claim that read as settled and was not.

---

> **⚠ 2026-08-30: READ `2026-08-30-state-and-next-steps.md` FIRST.** It supersedes this document's
> *status*, and it corrects three things this one stated as verified — including the central claim
> about what blocks E1. The traps in §4 and the method notes remain the reason to come back here.

## 0. Read these, in this order

| # | Document | Why |
|---|---|---|
| 1 | `specs/2026-08-17-integration-release-and-a2-roadmap.md` | **The new one, and the one that matters.** What happens next, why the order is fixed, and the verified state of prod. |
| 2 | This handoff §3 and §4 | What landed, and the traps. |
| 3 | `plans/2026-08-17-l2-complete-a1-handoff.md` **§8** | Method notes. Not superseded. |
| 4 | `plans/2026-08-17-a1-human-verification.md` → "Defects found during execution" | Before reusing anything from that plan. |
| 5 | `plans/2026-08-17-a1_5-annotation-studio.md` → same section | Five injections that proved nothing, and what each exposed. |

Read the roadmap first. **If you read only one section of it, read "The finding that reorders
everything."**

**Then read three sections of this document before you act on any of it: §2's live shape, §4's
first trap (the OIDC one), and §5.1.** Those are what changed after 2026-08-18, and between them
they change what the next action is. **As of `14d75f7`, every other document on every ref described
E1 as un-started and un-blocked.** It is neither — so distrust that description wherever you meet
it. (Several of those documents are being corrected in the same pass as this one; check the file in
front of you rather than assuming either way.)

---

## 1. Where the code is

| Ref | SHA | Note |
|---|---|---|
| `gitea/main` | **`14d75f7`** | **Everything is here.** Merge commit, 2026-08-29 — `feat/assignment-ui-and-random-subset` (`0309a7e`) plus its fixes commit (`ded6e1f`), merged onto `e4164c8`. **Branch from this.** |
| previous `main` | `e4164c8` | PR #13 (code, `bee1d12`) then PR #14 (docs) — A0+L1+L2+R1+R3+A1+A1.5+R4+R5. Still the SHA everything in §3 and earlier was measured at. |
| Deployed image | **`sha-14d75f7d46de`** (the `14d75f7` build) | The promote landed **2026-08-30 01:47Z** — both `judge-arena-web` and `judge-arena-worker` pods were recreated on it and `judgearena.com` answers 200. It read `sha-bee1d121ea7d` an hour earlier, while the promote was in flight. **This row has been wrong twice; read the live image** (§8, first command). |
| `feat/assignment-ui-and-random-subset` | `0309a7e` → `ded6e1f` | Merged as `14d75f7`. Safe to delete on the remote — but it is **checked out in `/root/judge-arena-worktrees/a0`**, which the §8 start block sends you to, so a local `git branch -d` is refused until that worktree moves off it. |
| `feat/a0-golden-set-substrate` | `8397c4a` | Merged. Safe to delete locally and on the remote. |
| PR #13 | **merged** | Merged whole rather than split, and as a **merge commit** on purpose — the docs cite SHAs 44 times across 8 files, and a squash or rebase would dangle every one. `14d75f7` keeps the same rule. |
| `main` (local) | stale | Fetch before using. `gitea/main` is the truth. |

Latest migration: `20260818120000_v2h_human_verification` — **18 in the chain**. `14d75f7` adds
none.

**CORRECTION (2026-08-29), and the shape of it matters more than the SHA.** The 2026-08-18 version
of this table gave `gitea/main` as `e4164c8` and carried a row reading: *"Deployed image
`sha-bee1d121ea7d` — **intentionally behind main by one docs-only commit**. `git diff bee1d12
e4164c8` touches nothing outside `docs/`, so the running image is functionally identical. A
provenance mismatch, not a defect."* That was true when it was written. What made it a trap is that
it invited the reader to stop looking: for ten days (`0309a7e` was authored 2026-08-19, merged
2026-08-29) what `main` was actually missing was
`feat/assignment-ui-and-random-subset` — **finished, pushed, unmerged, and carrying real code**
(the assignment panel, the `toPublicOwner` projection on the assignments API, server-side random
subset selection). **No document on any ref mentioned that the branch existed.** "Behind by docs
only" is a claim to re-derive — `git diff <deployed-sha> gitea/main --stat` — never one to carry
forward, and `git branch -a --no-merged gitea/main` is the command that would have found it.

**One ref that is deliberately not in the table, because it is not merged.**
`docs/productionized-state` (`e9ccf48`) held the 2026-08-18 revision of *this file* — the
"deployed, migrated and seeded" rewrite of §2, the M4 finding, and the permission-classifier record
— and as of `14d75f7` it had **never been merged into `main`**: `git branch -a --contains e9ccf48`
names only `docs/productionized-state` and its remote. This revision carries that content forward,
so §2 below is the `e9ccf48` text plus today's corrections rather than anything freshly invented.

**Other worktrees are not ours.** `/root/judge-arena` is on `feat/1c-deploy-readiness`; `llamacpp`,
`preflight`, `rebaseline`, `roundtrip` are older branches.

## 2. Production is DEPLOYED, MIGRATED and SEEDED — and holds 2 sets and 0 labels

Promoted and migrated 2026-08-17, after a pre-flight blast-radius review.

| | Before | Now |
|---|---|---|
| Image | `sha-70fce84bee11` (a pre-A0 **preflight**-branch build) | **`sha-bee1d121ea7d`** |
| Migrations | 13 | **18** — all five applied, **0 unfinished** |
| Flux (homelab) | `main@5c5c000` | `main@47e0603`, Ready |
| `judgearena.com` | — | **200**, in-cluster and public; both pods `1/1`, 0 restarts |

Verified directly rather than inferred: all three of `v2h`'s hand-edited objects exist in the live
database (the `score_xor_preference` CHECK and both partial unique indexes). **No drift tool can see
those**, so a direct query is the only way to know. A backup
(`judge-arena-pg-preflight-a1-20260818001346`) completed *before* any schema change.

*(The one thing that went wrong in that promote — the migrate Job's logs were lost to
`hook-delete-policy: hook-succeeded`, so **start the `kubectl logs` follow before the reconcile** —
is recorded in full in `specs/2026-08-17-integration-release-and-a2-roadmap.md`, under *"One thing
went wrong and is worth carrying forward: the migrate Job's logs were lost."* The
2026-08-18 rewrite of this section dropped it from here; it is still true, and it will recur.)*

### The live shape, read 2026-08-29/30

Out of pod `judge-arena-pg-1` in `tenant-public`, database **`judge_arena`** (not `judgearena` —
the wrong name is a `FATAL: database ... does not exist`, which reads like a dead pod):

| Table | Rows | |
|---|---|---|
| `_prisma_migrations` | **18** | 0 unfinished; latest `20260818120000_v2h_human_verification` |
| `Dataset` / `DatasetSample` | 2 / **620** | `judgebench-v1`; every sample carries `A>B`/`B>A` ground truth |
| `PromptTemplate` | **2** | `v1-legacy` pointwise, `v1-pairwise` — see the correction below |
| `User` | **2** | the owner (`trijeet@protonmail.com`, admin) and `platform@judgearena.local`, a system row whose `passwordHash` is `!platform-system-user`. So there is exactly **one human account**, and see §4: it has never completed a sign-in |
| **`GoldenSet`** | **2** | **was 0 until 2026-08-19 13:44** |
| `GoldenItem` / `GoldenCandidate` | **650** / **1300** | 620 + 30 items, two candidates each |
| `GoldenAssignment` | **2** | |
| **`GoldenLabel`** | **0** | **ten days later. This is the number that matters.** |
| `GoldenItemRevision`, `CalibrationRun`, `DeveloperApiKey`, `HumanJudgment` | 0 | |

The two sets were created **2026-08-19 13:44**: *"JudgeBench pairwise — full"* (620 items, `createdAt`
13:44:04.753) and *"JudgeBenchSample — 30 random"* (30 items, 13:44:05.028). Both were
**self-assigned by the owner** — `annotatorId` and `assignedById` are the same row — at 13:44:04.995
and 13:44:05.07, i.e. **242 ms and 42 ms after their own sets**, whole-set assignments
(`goldenItemId` NULL), `completedAt` NULL, `revokedAt` NULL. Nothing has been revoked and nothing
has been completed. Those gaps are worth noticing: two sets 275 ms apart, each assigned within a
quarter-second, is a scripted or API-driven sequence, not somebody clicking.

**CORRECTION (2026-08-29) — E1 is PARTIALLY EXECUTED, not un-started.** Every earlier version of
this document, and §7's row, said production held **0 golden sets** and that E1 was "the only step
left, and it needs a person … ~20 min in a browser". Steps 1–3 of E1 — sign in, create a set,
assign it — **were done on 2026-08-19.** Step 4, labelling, produced nothing. The exit gate is
genuinely unmet and A2 is still blocked, so the *status* line was right; the *diagnosis* was wrong,
and a wrong diagnosis here costs a whole session. **"Nobody has taken it" points at the wrong next
action.** Somebody took it, built the corpus and assigned it to themselves, and has not been able to
get in since. See §4's first trap. Creating a third set would change nothing.

*One loose end, stated as a loose end rather than resolved.* **How that 2026-08-19 session
authenticated is not in the audit trail.** The only `user.login%` rows for that day are two
**failures** — 13:41:29.313 and 13:41:33.14, `no_match_autoprovision_disabled` — three minutes
*before* the first set's `createdAt`, and no successful `user.login` exists on any date (§4). A
still-valid session cookie from the 2026-08-07 invite-claim is the obvious explanation and is
consistent with everything recorded, but it is an inference, not a reading. What *is* verifiable:
`DeveloperApiKey` is 0, so the sets were not created through a minted credential, and the assignment
panel did not exist until `14d75f7`, so the two assignment rows were not created by clicking it.

### M4: the seed is done, and PROMOTING DOES NOT SEED

**M4 (seed) is DONE, as of 2026-08-18** — and it was not a no-op. **That is the finding worth
carrying: promoting does not seed.** The migrate Job is an automatic `pre-upgrade` Helm hook; there
is deliberately **no seed hook**. So a release that adds *seed* content leaves it missing in
production, with nothing failing and nothing reporting it — and `v1-pairwise` is the template a
**pairwise** prompt is built from, which is the protocol this entire phase is about.

```bash
kubectl -n tenant-public exec deploy/judge-arena-web -- node /app/seed.js
```

**CORRECTION (2026-08-29), two of them. The second is the dangerous one.**

*(a) The claim was half false.* This section said the seeder created **two** `PromptTemplate` rows
"that had never existed in production" (`v1-legacy` pointwise, `v1-pairwise` pairwise). Only
**`v1-pairwise`** was new — created 2026-08-18 14:07:31.432. **`v1-legacy` has existed since
2026-08-12 17:42:35.664**, and the proof is in the row itself: its Prisma cuid
`cmsqdn8un00006p142rkwzuw1` encodes the insertion timestamp in base36 at characters 2–9, so the row
cannot have been deleted and re-created by the 08-18 seeder run. The
**promoting-does-not-seed conclusion survives** — `v1-pairwise` alone establishes it — but it rests
on one row, not two, and the difference is worth knowing before quoting it as a pattern.

*(b) The operational rule derived from it is FALSE, and is replaced rather than softened.* The old
text read: **"after any promote that touched `prisma/seed-core.ts`, run the seeder and read its
output; it names what it created, so a 'Created' line means production was behind."** It does not,
and it cannot:

- `seedPromptTemplates` **upserts**, then logs `✓ Created prompt template: …` **unconditionally,
  outside any branch** — `prisma/seed-prompt-templates.ts:120` and `:135`. It prints "Created" on
  every run, forever, including runs that insert nothing.
- `prisma/seed-judgebench.ts:307` likewise opens its line with `✓ Created dataset: …`
  unconditionally.
- **No log line anywhere in the seeder is gated on an actual insert.** The only real delta in the
  entire output is the parenthetical `${created.count} new samples` on that same judgebench line.
- And `prisma/seed-core.ts` — the file the old rule named — **never prints the word "Created" at
  all**: `grep -c Created prisma/seed-core.ts` returns `0`. The rule sent you to a file that could
  not produce the evidence it told you to read.

**Replacement rule: query the table, before and after. The log is a label, not a measurement.**

```bash
kubectl exec -n tenant-public judge-arena-pg-1 -- psql -U postgres -d judge_arena -tAc \
  'select name, version, "createdAt" from "PromptTemplate" order by "createdAt"'
```

Or read *only* the lines that report a real delta (`… N new samples …`) and ignore the rest.

**If you would rather fix the seeder than the rule:** `PromptTemplate` has **no `updatedAt`
column** (`prisma/schema.prisma`), so the obvious "branch on `createdAt === updatedAt`" is not
implementable. Use a `findUnique` before the upsert, a `count()` before and after, or a `create`
with a `P2002` catch. Worth doing in the same pass: `prisma/seed.ts:29` claims "It is idempotent, so
a second run is safe and **reports zero new rows**" — true for judgebench, false for prompt
templates, and that sentence is where the false rule came from.

### How the first golden sets were actually created

**Pre-creating the set was attempted and stopped deliberately** *(recorded 2026-08-18, and correct
on its date)*. Doing it without a browser session means minting a `DeveloperApiKey` — an
authentication credential written into the production database. The permission classifier refused,
and the refusal was **respected rather than worked around**, per §6's rule and the same class of
refusal recorded in the L2 handoff §8. Verified afterwards that nothing partial survived:
`DeveloperApiKey` and `GoldenSet` were both still 0.

**Dated update (2026-08-29).** The *conclusion* of that paragraph is stale — sets exist now — but
the *record* is not, and the record is the reason to keep it. `GoldenSet` is **2**: both sets were
created the next day, **2026-08-19, through the product's own session-authenticated path** rather
than out of band — which is the direction the refusal was pushing toward. `DeveloperApiKey` is
**still 0**, so no credential was ever minted and the refusal held all the way through. (Which
*surface* was used is not recoverable from the data, and the sub-second timings in "The live shape"
above argue against hand-clicking; see the loose end recorded there.) Keep this passage: **how those
two sets came into existence
is recorded nowhere else** — not in a runbook, not in a commit message, not in any other document —
and without it the only available inference from "sets exist" is that something wrote them out of
band.

**When you create a set, make it ~30 items, not 620.** `retestIntervalItems` defaults to **20** and
retest eligibility is intervening-items-only, so a set of 30 clears K and makes blind re-reads
reachable while a set of ≤20 can never produce one. With a single account `testRetest` is the *only*
reliability number the product can produce, so a set below K produces none at all. *(2026-08-29:
that advice was taken — the 30-item "JudgeBenchSample — 30 random" exists alongside the full 620.
**Label the 30.**)*

## 3. Suites

**Current, at `14d75f7` (2026-08-29)** — every suite run locally against the podman
Postgres/Redis/RabbitMQ:

| Suite | Files | Tests |
|---|---|---|
| unit | 43 | **594** |
| db | 42 | **641** |
| integration | 10 | **80** |

`npm run lint` 0, `npx tsc --noEmit` 0, `npm run build` 0, both coverage gates 0, no floor touched.

**At the A1/A1.5 merge point (`8397c4a` / `bee1d12`)** — the baseline everything in §5 and §6 was
measured against, kept because the deltas are what make the ladder below readable:

| Suite | Files | Tests |
|---|---|---|
| unit | 42 | **578** |
| db | 42 | **633** |
| integration | 10 | **80** |

`npx tsc --noEmit` and `npm run lint` exit 0 **with no warnings**; `npm run build` compiles.
`prisma migrate status`: 18 migrations, up to date. Both coverage configs exit 0, no floor touched.

**Run the DB and integration suites serially.** They share one Postgres and produce spurious
failures concurrently. (This session re-learned a neighbouring version of that: a full DB run picked
up a test file edited *while it was collecting*, and the resulting 4 failures looked like a
regression. If a baseline surprises you, check whether you were editing during it.)

**The stage ladder, extended:**

| Stage | migrations | unit | db | integration |
|---|---|---|---|---|
| +R1 (`96b7c12`) | 17 | 508 / 37 | 555 / 39 | 80 / 10 |
| +A1 (`eef73fb`) | 18 | 533 / 39 | 633 / 42 | 80 / 10 |
| +R4/R5 (`6528b32`) | 18 | 533 / 39 | 633 / 42 | 80 / 10 |
| +A1.5 (`05bf29b`) | 18 | **578 / 42** | 633 / 42 | 80 / 10 |
| +assignment UI (`14d75f7`) | 18 | **594 / 43** | **641 / 42** | 80 / 10 |

A1.5 moves only the unit count, which is the shape you want: it is library and UI work, and it
touches no route and no schema.

The assignment-UI row moves unit **and** db and leaves integration and the migration count alone,
which is likewise the shape of that change: a new library module with its own unit file
(`sample-selection`), server-side selection exercised through the existing golden-set routes against
a real database, **no route added and no migration**. A db-count move with a flat migration count is
the signature of new behaviour on existing tables — if you see the db count move and the migration
count move together, something added schema and you should know what.

## 4. Traps, each of which cost something

- **TWO AUTHENTIK ACCOUNTS SHARE ONE EMAIL, AND ONLY ONE OF THEM CAN SIGN IN.** *(Diagnosed
  2026-08-29. This is the E1 blocker, it is the single most expensive thing in the project right
  now, and before this line it appeared in no document at all.)*
  The judge-arena `User` row `cmsj951c30000881a4l63sx4b` (`trijeet@protonmail.com`, `role=admin`)
  — the row that **owns both golden sets and holds both assignments** — has
  `oidcSubject = 26f57dc2-77b6-455b-a939-d897dbdad6ee`. Authentik holds **two** accounts with that
  same email: **`akadmin`** (uuid `26f57dc2-…`) and **`trijeet`**
  (uuid `e8b087cc-b38b-492a-bbb3-b34bdfb50c16`). The judge-arena OAuth2 provider's `sub_mode` is
  `user_uuid`, so **`sub` IS the uuid**. The 2026-08-07 invite-claim happened while signed in as
  **akadmin**; every attempt since has been as **trijeet**, whose `sub` matches nothing.
  `resolveOidcUser` (`src/lib/oidc-user.ts:69`) therefore falls past branch 1 (known issuer+sub) and
  branch 2 (claimable invite — already claimed, `oidcSubject` is not null) to branch 3, and
  `ALLOW_OIDC_AUTOPROVISION` is absent from the deployment env, so the sign-in is **refused**. Three
  Authentik `authorize_application | trijeet` events (2026-08-18 21:33:35, 2026-08-19 13:41:28 and
  13:41:32) are each followed within a second by a judge_arena `AuditLog`
  `user.login.failed {"method":"oidc","reason":"no_match_autoprovision_disabled"}`. **No successful
  `user.login` has EVER been written to that table.** There is no credentials fallback either: the
  row's `passwordHash` is `!oidc-managed` and `findCredentialsUserByEmail` (`src/lib/auth.ts:47`)
  excludes `!`-prefixed hashes by design.

  **Diagnose it from both sides — it is invisible from either side alone.** From the database:

  ```bash
  kubectl exec -n tenant-public judge-arena-pg-1 -- psql -U postgres -d judge_arena -tAc \
    'select id, email, role, "oidcSubject", "invitePending" from "User"'
  kubectl exec -n tenant-public judge-arena-pg-1 -- psql -U postgres -d judge_arena -tAc \
    "select \"createdAt\", action, metadata from \"AuditLog\" where action like 'user.login%' order by \"createdAt\" desc limit 10"
  ```

  Then in Authentik, list every user holding that email (Directory → Users, filter by the address)
  and compare each account's **uuid** against the `oidcSubject` above. **Two rows there is the bug**
  — the database looks perfectly healthy on its own, and Authentik looks perfectly healthy on its
  own, because it is authenticating a real, enabled account successfully every time.

  **Fix A — fastest, mutates nothing.** Sign in to Authentik as **`akadmin`** (private window, or
  log out of the `trijeet` SSO session first). That `sub` matches the row, and `akadmin` is in
  `users-primary`, the single enabled policy binding on the judge-arena application. E1 can be
  finished inside that session with no change to anything.

  **Fix B — durable, one row, and an owner's decision rather than an agent's:**

  ```sql
  UPDATE "User" SET "oidcSubject" = 'e8b087cc-b38b-492a-bbb3-b34bdfb50c16'
   WHERE id = 'cmsj951c30000881a4l63sx4b';
  ```

  — or consolidate the duplicate Authentik accounts so only one of them carries the email.

  **Do NOT issue a fresh CLI invite, and do NOT set `ALLOW_OIDC_AUTOPROVISION=true`.** Both are the
  obvious move from the error message, and **both make it strictly worse**: each mints a **second,
  empty `User` row** that owns nothing and holds no assignment, so the sign-in then succeeds and the
  labelling queue returns a hard **403** on both sets — the same dead end, now with two rows to
  reconcile, a successful login in the audit trail, and no signal about which identity is the real
  one. The email partial unique index does **not** prevent this: it is
  `UNIQUE (email) WHERE passwordHash NOT LIKE '!%'`, and the existing row's hash starts with `!`,
  so that row is not in the index at all.
- **The promote lever is `apps/public/judge-arena/helmrelease.yaml`, not the chart's `values.yaml`.**
  The chart ships a default that the HelmRelease overrides — which is **documented and deliberate**
  (it exists so `helm template` renders standalone). An earlier version of this line called it an
  undocumented trap; that was wrong. **The real defect is that the chart's `required` guard on
  `image.tag` can never fire**, because a non-empty default is always present, so if the HelmRelease
  ever loses its tag the deploy silently pins a months-old image. Recorded as homelab divergence
  **entry 67** (PR #904).
- **Prod was CURRENT as of 2026-08-17** — 18 migrations, `sha-bee1d121ea7d` — and this line went on
  to say: *"But it holds **0 golden sets**, so do not assume the product has ever been used from the
  fact that it is deployed."* **CORRECTION (2026-08-29): it holds 2 golden sets, 650 items, 1300
  candidates, 2 assignments and 0 labels.** The warning does not disappear, it inverts, and the
  inverted form is harder to spot: **do not assume the product has been used from the fact that
  content exists in it.** A set that was created, assigned and never labelled is identical, in every
  count except `GoldenLabel`, to a working annotation programme.
- **judge-arena is manual-promote** (`286da59`, excluded from the build-lag exporter). Nothing
  deploys itself. Flux being green means Flux is doing what it was told, not that the app is current.
- **A quoted `DATABASE_URL`.** `.env.local` holds it quoted, so `grep | cut` yields a quoted string
  and Prisma fails `P1012` — which reads like schema drift. Bare `npx prisma` fails the same way
  because Prisma loads `.env` and this tree has none. Source it:
  `sh -c 'set -a; . ./.env.local; set +a; npx prisma …'`.
- **`prisma db execute` needs `--schema` or `--url`.** It is not a drop-in for a psql one-liner.
- **Local Postgres is the podman container `judge-arena-pg`. Production is the Kubernetes pod
  `judge-arena-pg-1` in namespace `tenant-public` and must never be touched.** The names differ by
  one character. Never `prisma db push`; never `migrate deploy` against anything but local.
- **Backticks in a `git commit -m` shell string get expanded.** One commit message this session lost
  a word to command substitution. Use `-F <file>`.

## 5. What A1 and A1.5 actually shipped

**A1** gave `GoldenLabel` its first writer, and the apparatus that makes the rows mean something:
the `v2h` schema (item revisions, assignments, `round`, `preference`, three hand-edited
constraints), `src/lib/agreement.ts` (Cohen/Fleiss, weighted on value distance), before-image
provenance on item edits, retest eligibility, blinded queue selection, six routes, and reporting
that states its method and its overlap.

**A1.5** gave it a surface: a composable panel shell with layout persisted to localStorage and
reconciled against untrusted input, span-ready content with a normalization contract, a word diff,
and A1's labelling view as the first composition.

**The exit gates of both are met** — A1's four clauses each pinned by a named test, A1.5's five by a
browser-walked checklist.

### The distinction most likely to be got wrong

**One annotator is a DEVELOPMENT constraint, not a product one**, and A1 now enforces it in code
rather than prose: `agreement()` returns `{ value: null, reason: 'insufficient-annotators' }`,
never `0`, because `0` reads as total disagreement — the opposite of "not measurable". `testRetest`
is the only reliability signal that yields a number until a second account exists.

**The overlap model, assignment rows, Fleiss path and disagreement queue are all built and tested
now**, against fixtures creating N `User` rows. What waits on a second account is only *real* data —
which is E3 in the roadmap, and is the first moment the product does the thing it exists to do.

## 5.1 What the assignment UI shipped (`14d75f7`, 2026-08-29)

§5 tells you the studio exists. Read on its own it leaves out the thing a reader most needs: until
this merge **there was no way to get an assignment from a browser at all** — and without an active
assignment the queue serves nothing, so the studio was reachable and empty. (Reachable: A1.5's
**Label** button on `/golden-sets/<id>` predates this merge — `git show
e4164c8:'src/app/golden-sets/[id]/page.tsx'` has it at line 419, ungated on ownership on purpose.
The gap was the *assignment*, not the link. Creating one meant a raw `INSERT` or a hand-made API
call, which is exactly what the runbook used to hand out.) That is half of why the 2026-08-19
session could create two sets and produce zero labels.

`feat/assignment-ui-and-random-subset` (`0309a7e`) plus its fixes commit (`ded6e1f`). **No
migration.**

- **The assignment panel on `/golden-sets/<id>`** (`src/app/golden-sets/[id]/page.tsx`) — *Assign to
  me*, *Revoke*, and a shortcut straight into the studio. **Revoke is a tombstone, not a delete:**
  the row survives in the database and in the API response as a record of what was asked, and the
  panel — not the query — filters it out (`activeAssignments = assignments.filter(a => !a.revokedAt)`,
  `page.tsx:492`). So the row leaves the screen and stays in the record; runbook row 18 is worded
  for exactly that.
- **`toPublicOwner` on the assignments API**
  (`src/app/api/golden-sets/[id]/assignments/route.ts`, projection at `src/lib/serializers.ts:41`):
  an assignee is `{ id, name }`, **never the email**, and `null` for a deleted account — the same
  allow-list every other owner-shaped field in the product already goes through. Assignments are
  coordinator-only at the API, so the GET 403s for a non-owner; that 403 is swallowed rather than
  toasted, and **the panel is gated on `isOwner` and does not render for them at all** — which,
  deliberately, also hides it from an admin coordinating someone else's set, because the client
  session carries no role.
- **Server-side random subset selection** — `randomCount` / `randomPercent` in
  `src/lib/sample-selection.ts`. The client asks for a *size*; **the server draws**.
  `randomPercent` resolves against the **live** sample count, not the raw one, so tombstoned rows do
  not inflate the denominator.
- `ded6e1f` then fixed, on top of it: `handleRevoke`'s **missing `catch`** — twenty-nine lines below
  a `handleAssignToMe` that had one (`0309a7e`: the two handlers open at `:191` and `:220`, and
  `handleRevoke`'s `try` runs straight into `finally` at `:235`), so a rejected fetch fired no toast,
  never refreshed the list, and
  still re-enabled the button in `finally`; **the screen after a failed revoke was indistinguishable
  from a successful one**. It also fixed the `randomPercent` DB test that **tombstoned nothing**, so
  the live count and the raw count were the same number and the assertion held under either
  denominator — the property in its own title was never pinned. And three doc blocks that still
  described the design the commit had abandoned. It added `docs/superpowers/pr-assignment-ui-body.md`
  and rows 13–18 of `docs/runbooks/studio-manual-verification.md`.

**Browser-walked 2026-08-29** (runbook rows 14, 16, 17, 18) — the only way this class of change is
provable, per §6. Row 14 is the one worth keeping: over one 620-row dataset at N=30, *First* gave
`0..29`; *Random* gave
`14, 61, 62, 76, 90, 121, 152, 162, 165, 171, 177, 179, 252, 256, 261, 288, 309, 328, 343, 363, 366, 428, 439, 441, 450, 479, 496, 508, 519, 529`.
**Random is not a prefix** — which is exactly the bias that a "random" subset implemented as
`take: n` would have shipped silently, and the injection that proves it fails with
`expected [0,1,2,…] to not deeply equal [0,1,2,…]`.

### What this merge did NOT fix, and what still blocks a clean E1

- **E1 step 5, "read the agreement panel", has no UI.** `GET /api/golden-sets/[id]/agreement` exists
  and works, but **nothing under `src/app/**` or `src/components/**` ever calls it** —
  `grep -rn agreement src/app src/components` outside `src/app/api/` returns two hits, both prose
  (landing-page copy and a textarea placeholder), and no fetch. The one
  "Agreement" a user can see is a hard-coded, permanently-`empty` progression-rail stage
  (`src/app/golden-sets/[id]/label/page.tsx:87`), deliberately rendered empty rather than omitted so
  the rail cannot read as a complete pipeline. It is a **missing surface, not a bug**. Workaround:
  point the signed-in tab straight at `/api/golden-sets/<id>/agreement` and read the JSON.
- **Nothing on screen says which candidate is A.** All 1300 production `GoldenCandidate` rows have
  `label IS NULL`, because `toCandidate` (`src/lib/golden-sets.ts:179`) hard-codes `label: null`.
  The studio therefore renders `candidate.label ?? 'Option ' + (position + 1)` → *"Option 1"* /
  *"Option 2"*, while the verdict control asks for `A>B` / `tie` / `B>A`. The mapping **is**
  deterministic in code — `toCandidate(0, responseA)`, `toCandidate(1, responseB)`, and the queue
  orders by `position asc` — but **the annotator cannot see that**, and guessing it the other way
  round **silently inverts every preference in the session**, producing a full set of labels that
  are exactly wrong and look exactly right. Read this bullet before answering the first item.

## 6. What this session cost, and what would have prevented it

Additions to the previous handoff's §8, not replacements. In descending order of what they saved.

- **The injections that proved NOTHING were worth more than the ones that worked.** Across A1 and
  A1.5, five prescribed injections left the suite green. Every one was a real gap: an unreachable
  guard, a dead special case, an untested equality check, a clamp test using a value the standard
  library clamps anyway (`-5`, where only `-1` discriminates), and a de-dup test asserting a length
  that a `Map` gives for free. **A passing injection is a finding, not a formality** — if breaking
  the code changes nothing, either the code or the test is decoration.
- **A green test can be impossible to fail.** A1's value-vs-rank fixture could not pass under any
  implementation (`0 > 0`). A1.5's NFC fixture asserted a length that depended on the source file's
  encoding, and the obvious fix — changing the 7 to a 6 — would have made it green while deleting
  the only thing under test. **Work the arithmetic by hand before writing the module.**
- **A failure message that does not describe the defect is not evidence.** A1's round injection
  failed with `expected 500 to be 201` because trusting the client's round collided with a unique
  index rather than writing the wrong round. That surfaced a real bug (a bare 500 on a concurrent
  double-submit, now a 409) but proved nothing about the assertion, which needed a second, cleaner
  injection.
- **Walk the manual checklist; do not write it and defer it.** A1.5's row 7 caught a defect no unit
  test could have: the progression rail read "not started" directly above a message explaining that
  a reading had just been recorded. The rule was right and the *composition* was wrong, which is
  exactly the class the untestable layer's checklist exists for.
- **Verify a cluster fact before writing it down.** This session re-measured T5 rather than quoting
  it (54.6%, unchanged — so the gate is stable rather than a spike), and in doing so found the
  inert-chart-tag trap, the five-migration gap and the empty prod catalog. None of those were
  visible from the repository. *(2026-08-29: the same measurement now reads 46% — 0.1197 GB against
  a 0.2577 GB watermark, no alarms. The 54.6% above is left as the dated reading it was; the shape
  of the finding is unchanged, which is the point of dating it rather than overwriting it.)*
- **`tsc` catches test shortcuts, not just type errors.** A test reached for a property that exists
  on only one branch of a union; the shortest way past it would have been a cast, which erases the
  field under assertion. A whole-object `toEqual` was both correct and stronger.

## 7. Open, and who it is waiting on

| Item | State | Waiting on |
|---|---|---|
| **A1/A1.5 PR** | ✅ merged — #13 (`bee1d12`) | — |
| **Assignment UI + random subset** | ✅ **merged 2026-08-29** as `14d75f7` (`0309a7e` + `ded6e1f`) | — |
| **Promote + migrate** | ✅ done. The `14d75f7` promote **landed 2026-08-30 01:47Z** — `judge-arena-web` and `-worker` both run `sha-14d75f7d46de`, `judgearena.com` 200, 18 migrations (`14d75f7` adds none, so nothing to migrate) | — (re-read the live image anyway, §8) |
| **M4 seed** | ✅ done 2026-08-18 — created the **one** missing `PromptTemplate` row (`v1-pairwise`); see §2's correction | — |
| **OIDC identity mismatch** | **OPEN, and it is the real E1 blocker** — two Authentik accounts share one email; no successful `user.login` has ever been recorded | an owner's decision: §4 Fix A or Fix B |
| **E1 — first real annotation session** | **PARTIALLY DONE.** 2 sets, 650 items, 2 self-assignments — and **0 labels** since 2026-08-19 | the OIDC fix, then ~20 min in a browser |
| **Agreement panel (E1 step 5)** | **no UI exists** — the route works, nothing calls it | a small piece of UI, or the JSON workaround in §5.1 |
| **Candidate A/B labelling** | every prod `GoldenCandidate` has `label IS NULL` → "Option 1"/"Option 2" against an `A>B`/`B>A` control | a fix in `toCandidate`, or a note on the screen |
| **Evaluation pipeline** | **Was DEAD 2026-08-24T17:55Z → 2026-08-30T01:47Z** — all five queues `consumer_count=0` for six days; the worker's AMQP consumers never re-registered after the Cozystack v1.6.2 roll recreated `judge-arena-pg-1`, and the pod stayed 1/1 Running, 0 restarts, silent. **Service restored** as a side effect of the promote, which recreated the worker (`judge worker started` 01:47:29.450Z); `run.create` and `judgment.execute` each report 1 consumer again — the three retry/DLQ queues have none by design | **the code defect is UNFIXED** — the AMQP client must re-register consumers **on reconnect**, not only on boot. Until then any broker or DB blip silently repeats this, and nothing alerts |
| **Real labels** | none exist anywhere | E1 |
| **E3 second annotator / real kappa** | blocked | a second account existing |
| **T5** | zero scrapes, zero rules; **46%** of the memory watermark at idle (54.6% on 2026-08-17) | **independent cluster work — can start now** |
| **A2 spec** | decisions recorded, deliberately unwritten | real label data + T5 |
| **`reasoning_content` capture** | backlogged | preflight Stage 5 |
| **Roadmap decisions #4, #7** | open | settled when A2 is specced |
| **Cross-user annotation policy (#5)** | mechanism built, policy is owner's | a second account existing |
| **homelab divergence entry 67** | ✅ PR **#904 merged** (`gh pr view 904` — state `MERGED`, not a draft). The row above said "waiting on review"; it was not, as of 2026-08-30 | — (the chart's inert `required` guard it documents is still a live divergence) |
| R1–R6 residuals | **all closed** | — |

## 8. Starting the next session

```bash
cd /root/judge-arena-worktrees/a0
git fetch gitea && git checkout -B work gitea/main    # main IS the truth now — 14d75f7
sh -c 'set -a; . ./.env.local; set +a; npx prisma migrate status'   # 18, up to date
npx tsc --noEmit && npm run lint
npm test                                       # 594
npm run test:db                                # 641 — packaged, includes a migrate reset
npm run test:integration                       # 80 — needs Redis :6379 and RabbitMQ :5672
```

Write those numbers down; the plans forbid asserting absolute suite counts, so each task's contract
is zero failures and no fewer tests than the previous task left.

Then re-check production, because **every one of these moved during the sessions that wrote this
document** — which is §6's last note in practice, not in theory:

```bash
# 1. What is actually running. The §1 row for this has now been wrong twice.
kubectl get deploy -n tenant-public judge-arena-web \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
#    On 2026-08-30 01:47Z this began reading sha-14d75f7d46de — the promote landed.
#    sha-bee1d121ea7d would mean the bee1d12 build, two code commits behind main.
#    Read it, do not assume it.

# 1b. The evaluation pipeline. It was silently dead for six days (§7) and the
#     code defect that allowed that is still unfixed, so this is now a standing check.
kubectl exec -n tenant-public rabbitmq-judge-arena-server-0 -- \
  rabbitmqctl list_queues name messages consumers
#    run.create and judgment.execute must each show 1 consumer.
#    0 = the worker is up but consuming nothing; `kubectl rollout restart
#    deploy/judge-arena-worker -n tenant-public` restores it.

kubectl exec -n tenant-public judge-arena-pg-1 -- psql -U postgres -d judge_arena -tAc \
  'select count(*) from "_prisma_migrations"'                       # expect 18

kubectl exec -n tenant-public judge-arena-pg-1 -- psql -U postgres -d judge_arena -tAc \
  'select count(*) from "GoldenSet"'                                # expect 2 — since 2026-08-19 13:44

# THE NUMBER THAT MATTERS. E2, E3 and the whole A2 spec wait on this one and on nothing else.
kubectl exec -n tenant-public judge-arena-pg-1 -- psql -U postgres -d judge_arena -tAc \
  'select count(*) from "GoldenLabel"'                              # 0 on 2026-08-29

kubectl exec -n tenant-public judge-arena-pg-1 -- psql -U postgres -d judge_arena -tAc \
  'select count(*) from "GoldenAssignment"'                         # expect 2, both the owner's

# Has anyone EVER signed in? On 2026-08-29 the answer was no. See §4's first trap.
kubectl exec -n tenant-public judge-arena-pg-1 -- psql -U postgres -d judge_arena -tAc \
  "select action, count(*) from \"AuditLog\" where action like 'user.login%' group by action"

kubectl exec -n tenant-public judge-arena-pg-1 -- psql -U postgres -d judge_arena -tAc \
  'select count(*) from "PromptTemplate"'                           # expect 2 — see §2
```

**CORRECTION (2026-08-29) to this block, and it is worth reading even if you never ran the old
one.** The 2026-08-18 version annotated the `GoldenSet` query `# 0 until E1 happens`. **Run that
exact command today and it returns 2**, and has since 2026-08-19 13:44. Two things about that are
instructive. First, the document was **internally inconsistent rather than uniformly wrong**:
fourteen lines below that comment it already said *"If `GoldenSet` is non-zero, read the labels
first"* — the correct instruction, sitting directly underneath a comment telling you not to expect
the case it covers. When a doc contradicts itself, the conditional branch is usually the surviving
truth and the confident annotation is usually the stale one. Second, and worse: **the old block
never asked for `GoldenLabel` at all** — the one count that had *not* moved, and the only one E1's
exit gate is actually about. A verification block that checks only the numbers you expect to have
changed cannot tell you that the number you care about has stood still for ten days.

**`GoldenSet` is 2 and `GoldenLabel` is 0, so the next move is not "create a set" — it is "be able
to sign in".** Read §4's first trap before anything else: no successful login has ever been
recorded, and the Authentik account you are signing in as is not the one that owns the sets.
Once you are in, nothing needs creating — *"JudgeBenchSample — 30 random"* already exists and is
already assigned to you. Go straight to `/golden-sets/<id>/label` and label it, and read §5.1's
second "did NOT fix" bullet before answering the first item: **Option 1 is candidate `position 0`,
which is A.** Guess it the other way and every preference in the session is inverted.

**Expect the agreement panel to say `insufficient-annotators` rather than a number.** That is
correct, not broken — one account means no inter-annotator statistic exists. `testRetest` is the
only signal that yields a value, and only if the set is larger than `retestIntervalItems` (20).
*(And expect to read it as JSON: as of `14d75f7` there is still no UI that calls the agreement
route — §5.1.)*

**When labels finally exist, read them before writing anything** — that was already the right
instruction in the 2026-08-18 version of this document and it survives unchanged. E2 and E3 are the
next items, and A2's spec can finally be written against real data.
