# A0 design: the golden-set substrate, as annotated platform corpora

**Date:** 2026-08-12 · **Status:** approved by owner, ready for an implementation plan
**Phase:** Roadmap A, phase A0 (`2026-08-10-judge-training-engine-roadmap.md`)
**Baseline:** `gitea/main` @ `7306c2f`. Every file:line and every row count below was verified
against that tree or against the live `judge-arena-pg` database on 2026-08-12, not carried
forward from the roadmap.

---

## What changed from the roadmap's A0

The roadmap scopes A0 as "the API and the UI, with no new modelling", building CRUD over a
schema somebody already thought through. Two things make that description wrong, and one
owner decision reshapes the phase entirely.

**A0 cannot avoid a migration.** Owner decision #3 requires `CalibrationRun` to carry the pass
threshold that was in force; that table has no such column. Owner decision #6 requires
edit-after-freeze to fork to a new version; `GoldenSet` has no `parentId`, `version` or `slug`
to fork into. Both were settled before A0 was written specifically so A0 could act on them, and
neither is expressible without DDL. All four golden tables hold **zero rows**, so this is the
cheapest moment such a migration will ever be.

**A golden set is not free-form content.** Owner ruling, 2026-08-12: *golden sets are just
annotated, platform-provided datasets.* A set is the annotation layer over exactly one
platform-curated `Dataset`, imported at exactly one protocol. There is no hand-authoring, so
**creation is import** — the two surfaces the roadmap describes separately ("CRUD for GoldenSet
and GoldenItem" and "import golden items from an existing Dataset") collapse into one.

**A0 also ships pairwise execution.** Owner ruling, 2026-08-12. The roadmap leaves pairwise
data-only until A2, but the substrate for it is already built (see below), and a pairwise corpus
that cannot be run is a corpus A1 cannot calibrate against. Scope widened deliberately, with the
`BA` permutation sweep explicitly held back.

---

## Verified starting state

### More exists than the roadmap claims

The roadmap says this half of the product "has zero lines of code". That is true of routes and
UI. It is not true of the boundaries:

| What exists | Where | Consequence for A0 |
|---|---|---|
| `requireOwnership('goldenSet', …)` | `src/lib/auth-guard.ts:381` | Ownership is already wired, and already knows `GoldenSet` keys on `ownerId` rather than the `userId` every other ownable model uses. |
| `resolveResourceAccess(session, ownerId, isPublic)` | `src/lib/auth-guard.ts:357-371` | The public-read decision function, whose own doc comment names golden sets as an intended caller. |
| `toPublicGoldenSet` + `PublicGoldenSet` | `src/lib/serializers.ts:260-305`, tested at `tests/lib/serializers.test.ts:183-218` | The public wire shape is already an allow-list projection with tests. Its header comment says it was written "ahead of whichever future task adds the route." That task is A0. |
| The freeze predicate, in working code | `src/lib/account-deletion.ts` golden branch | `calibrationRun.count({ where: { goldenSetId } }) > 0` → soft-retire, else delete. This is verbatim the predicate decision #6 needs. |
| Fork-under-race, twice | `src/lib/dataset-versions.ts:127-228`, `src/lib/rubric-versions.ts:88-150` | `isRetryableVersionConflict` (`:111-117`) retries P2002 on `version` *or* `slug`, `MAX_ATTEMPTS = 3`, slug derived inside the transaction. A0 copies this rather than inventing it. |

So A0 inherits its ownership model, its public serialization and its freeze predicate. It is not
choosing them.

### The pairwise substrate was built and left unwired

| What exists | Where |
|---|---|
| `ModelJudgment.pairOrder String?` — `"AB"` \| `"BA"` | `prisma/schema.prisma:464` |
| `@@unique([runId, judgeModelVersionId, pairOrder])` **`NULLS NOT DISTINCT`** | `schema.prisma:484`, hand-edited in `20260728215410_v2b_idempotency_tighten` |
| A green test that `AB` and `BA` coexist on one (run, judge version) | `tests/db/idempotency-tighten.test.ts:122` |
| `RunCandidate` — `position`, `promptText`, `responseText`, `label`, `@@unique([runId, position])` | `schema.prisma:417-427`, **zero writers** |
| `EvaluationRun.protocol RunProtocol @default(pointwise)` | `schema.prisma` |
| `PromptTemplate.protocol RunProtocol`, `@@unique([name, version])` | `schema.prisma` |

Whoever designed v2 anticipated pairwise execution and shipped its idempotency semantics,
including a hand-edited `NULLS NOT DISTINCT` index that only makes sense if two orders of the
same pair were meant to coexist. What is missing is the renderer, the verdict shape, and four
hardcoded call sites.

### What genuinely blocks execution today

- `src/lib/llm/render.ts:460` — `renderJudgmentSystemPrompt` **hard-throws** for any protocol
  other than `pointwise`.
- `src/lib/llm/judgment-schema.ts:74` — `required: ['overallScore', 'reasoning', 'criteriaScores']`.
  A pairwise verdict has no representation in it.
- `src/lib/run-launch.ts:172, 302, 468` — `protocol: 'pointwise'` hardcoded.
- `src/lib/queue/publish.ts:56` — `protocol` typed as the **literal** `'pointwise'`.
- `src/worker/judgment-consumer.ts` — no protocol handling at all (zero occurrences).

### The corpus, read from the live database

```
Dataset                       inputType        visibility  owner                     samples
judgebench-v1                 query-response   public      platform@judgearena.local     620
livecodebench-codegen-lite    query-response   public      platform@judgearena.local       0

DatasetSample.input     = the question, alone
DatasetSample.expected  = 'A>B' (336) | 'B>A' (284)
DatasetSample.metadata  = JSON-encoded STRING, keys exactly:
                          split, source, pair_id, original_id, response_model,
                          response_A, response_B
```

`judgebench-v1` is the only platform corpus with data. `livecodebench-codegen-lite` is declared
and empty.

### Two stale claims in the roadmap, corrected

- **Blocker 12 (CI cannot run the DB or integration suites) is closed.** `.gitea/workflows/ci.yml`
  has a working `db-tests` job and `build-push` gates on it. The roadmap's "Net, as of 2026-08-12"
  paragraph still lists it as remaining.
- **"Same argument as rubrics" (decision #6) is not a code precedent.** `PATCH
  /api/rubrics/[id]` does `tx.rubricCriterion.deleteMany` + recreate behind an ownership check
  only; no referenced-by guard exists anywhere in `src/`. A rubric pinned by a finished run can
  be rewritten today. **A0 writes the codebase's first referenced-by write-guard**, and the
  rubric surface carries the identical latent defect — recorded here, not fixed here.

---

## Decisions taken

Six questions were put to the owner on 2026-08-12. All six are settled; the reasoning is
recorded because a later reader will otherwise re-litigate them.

| # | Question | Ruling |
|---|---|---|
| 1 | How much schema does A0 ship? | **Full substrate.** Candidates, lineage, threshold columns, provenance, timestamps — one migration against empty tables. |
| 2 | A0's exit gate depends on a test that is not on main. | **Land `d2c3f3b` first**, as its own PR, before A0 starts. |
| 3 | Pairwise: data-only, or executable? | **Ship the execution path.** JudgeBench becomes runnable at the end of A0. |
| 4 | Where does a pairwise verdict live? | **New `ModelJudgment.verdict String?`**, storing what the model said against the `pairOrder` it was shown. Derive, never encode. |
| 5 | What does a fork do to human labels? | **Copy, except on edited items.** An annotator's judgment is never re-attributed to text they did not see. |
| 6 | What can a golden set be built from? | **One platform-curated `Dataset`, bound in the schema.** Creation is import; no hand-authoring in A0. |

Two further rulings arrived with the approval:

- **Pair order.** A0 emits `AB` only. The `BA` sweep and its side-by-side permutation-difference
  report are wanted, and are held for A2/A3 where `positionBias` lives.
- **Deletion.** Tombstone rather than hard-delete; purge is a later wave. Explicit owner
  rationale: hard deletion may lose data, and there are no existing users, so the urgency is low.

One decision is derived rather than asked, and is called out so it can be objected to:
**`GoldenSet.protocol` is required and the set is homogeneous.** A set arrives from one import at
one protocol; letting its items disagree would make a single `kappa` uninterpretable. Items
validate against the set's protocol.

---

## The migration

One migration, `prisma/migrations/<YYYYMMDDHHMMSS>_v2d_golden_substrate/migration.sql`, authored
via `prisma migrate diff` per `CONTRIBUTING.md:407-443`, with a prose header naming the phase and
every hand edit.

```prisma
model GoldenSet {
  // existing: id, name, description, visibility, publishedAt, retiredAt, ownerId, timestamps
  datasetId    String                                  // NEW — required
  dataset      Dataset     @relation(fields: [datasetId], references: [id], onDelete: Restrict)
  protocol     RunProtocol                             // NEW — required, set is homogeneous
  slug         String?                                 // NEW
  version      Int         @default(1)                 // NEW
  parentId     String?                                 // NEW
  parent       GoldenSet?  @relation("GoldenSetVersions", fields: [parentId], references: [id],
                                     onDelete: NoAction, onUpdate: NoAction)
  versions     GoldenSet[] @relation("GoldenSetVersions")
  tombstonedAt DateTime?                               // NEW — distinct from retiredAt

  @@unique([parentId, version])
  @@unique([ownerId, slug])        // NULLS NOT DISTINCT — hand-edited, see below
  @@index([parentId])
  @@index([visibility])
  @@index([datasetId])
}

model GoldenItem {
  // existing: id, goldenSetId, index, inputText, promptText, responseText, protocol, expected
  sourceDatasetSampleId String                         // NEW — required
  sourceSample          DatasetSample @relation(fields: [sourceDatasetSampleId],
                                                references: [id], onDelete: Restrict)
  candidates            GoldenCandidate[]              // NEW
  createdAt             DateTime @default(now())       // NEW
  updatedAt             DateTime @updatedAt            // NEW

  @@index([sourceDatasetSampleId])
}

model GoldenCandidate {                                // NEW — mirrors RunCandidate:417-427
  id           String     @id @default(cuid())
  goldenItemId String
  goldenItem   GoldenItem @relation(fields: [goldenItemId], references: [id], onDelete: Cascade)
  position     Int
  promptText   String?
  responseText String?
  label        String?

  @@unique([goldenItemId, position])
}

model CalibrationRun {
  passThreshold   Float?                               // NEW — decision #3
  thresholdMetric String?                              // NEW
  kappaVariant    String?                              // NEW — Cohen's | Fleiss's
  kappaWeighting  String?                              // NEW — linear | quadratic
}

model ModelJudgment {
  verdict String?                                      // NEW — 'A' | 'B' | 'tie', raw
}
```

**`GoldenCandidate` is `RunCandidate` field-for-field.** Same shape, different parent. That is
deliberate: the team already accepted this shape once, and A2 will need to compare a golden
item's candidates against a run's candidates.

**`@@unique([ownerId, slug])` needs `NULLS NOT DISTINCT`, hand-edited.** Every other slug
constraint in the schema keys on a non-null `userId`. `GoldenSet.ownerId` is nullable — it is
`onDelete: SetNull` so a set survives its owner's deletion — and under Postgres's default
`NULLS DISTINCT`, two ownerless sets could hold the same slug, which breaks the config
importer's `(owner, slug)` resolution. The repo already knows this trick: migration
`20260728215410_v2b_idempotency_tighten` uses it on `ModelJudgment` and documents why Prisma's
DSL cannot express it. **`CONTRIBUTING.md:446-478`'s pseudo-drift table says "Currently one
case"; A0 makes it two, and must update that table and that sentence.**

**Two consequences of `Restrict` worth stating before they surprise someone.** A `Dataset` with
golden sets cannot be deleted, and a `DatasetSample` referenced by a golden item cannot be
deleted. The second one bites an existing route: `PUT /api/datasets/[id]/samples`
(`src/app/api/datasets/[id]/samples/route.ts:262-291`) deletes every sample and recreates them,
minting new ids. Once a golden set exists over a dataset, that PUT must fail. **This is the
intended behaviour** — the same argument as decision #6, a corpus somebody has annotated must
not drift under the annotation — but it must fail as a deliberate 409 with a message naming the
golden sets that pinned it, not as a raw P2003.

The seeder is unaffected: `prisma/seed-judgebench.ts` `upsert`s the dataset and `createMany`s
samples. It never deletes.

---

## Creation is import

`POST /api/golden-sets { datasetId, protocol, name, description?, sampleIndices? }` creates the
set, its items and their candidates in one transaction. There is no blank-item form and no
separate import route.

`sampleIndices` is the curation affordance: an optional array of `DatasetSample.index` values
selecting a subset of the corpus. Omitted, every sample is imported — 620 items and up to 1240
candidates for JudgeBench, in one transaction. Present, only the named samples are, in the order
given, and `GoldenItem.index` is assigned 0..n-1 over the selection rather than inherited from
the sample. Subsetting is how a user makes a labelling session finite; A1 will want it before it
wants anything else.

**Source restriction:** `datasetId` must name a `Dataset` with `visibility: 'public'` owned by
the platform user. Widening this later — to any dataset a user can read — is dropping a check,
not a migration.

**Access is decided by `resolveResourceAccess` on `visibility === 'public'`, not by ownership.**
`src/app/api/evaluations/route.ts:522` guards its dataset read by ownership; copying that here
would make the seeded 620-row corpus unimportable for every non-admin, because JudgeBench is
owned by `platform@judgearena.local`.

**Samples are read server-side** via `prisma.datasetSample.findMany`. The client must never read
them through `GET /api/datasets/[id]`, which takes `samples: { take: 100 }` — that path imports
100 of 620 rows, errors nothing, and looks like it worked.

**The importer branches on target protocol, never on `dataset.inputType`.** JudgeBench carries
`inputType: 'query-response'`, and `evaluations/route.ts:538-546` maps that to
`inputText = sample.expected || sample.input`. Reusing that mapping yields `inputText = 'A>B'` —
a judge scoring a two-character string against a rubric. Every row imports; every row is garbage.

### The three mappings

```
sample.input    = question
sample.expected = 'A>B' | 'B>A'
JSON.parse(sample.metadata) -> { response_A, response_B, split, source, pair_id, ... }

pointwise   inputText  = question
            candidates = [ { position: 0, responseText: response_A } ]
            expected   = NULL

pairwise    inputText  = question
            candidates = [ { position: 0, responseText: response_A },
                           { position: 1, responseText: response_B } ]
            expected   = 'A>B' | 'B>A'

listwise    inputText  = question
            candidates = [ { position: 0, responseText: response_A },
                           { position: 1, responseText: response_B } ]
            expected   = '0,1'  (A>B)  |  '1,0'  (B>A)
```

**A pointwise import of JudgeBench has no ground truth, and this is correct rather than broken.**
JudgeBench's label is a *preference* between two responses, not a score for one. So a pointwise
set arrives with `expected = NULL` on all 620 items, awaiting A1's human scores. The UI must say
so rather than rendering an empty column, and such a set is not calibration-ready until labelled.

`metadata` is a **String holding JSON**, not a Json column — `JSON.parse(x ?? '{}')`. The
importer must not treat it as an object.

---

## Freeze and fork

**The predicate has one definition,** in `src/lib/golden-sets.ts`, imported by both the routes
and `account-deletion.ts`, so the two cannot drift:

```
frozen(goldenSetId) := calibrationRun.count({ where: { goldenSetId } }) > 0
```

**What freezes:** item content — items, candidates, `protocol`, `expected`, and the set's
`datasetId`. **What does not:** `name`, `description`, `visibility`, `retiredAt`. Renaming a set
changes nothing a calibration run measured; refusing a typo fix is hostile and buys nothing.

**The count and the mutation share one transaction.** Separated, a calibration run started
between them measures a set that changed underneath it — retention silently broken, verdict
silently uninterpretable, and nothing logs.

**`finishedAt` is not consulted.** `CalibrationRun` has no status enum, only `startedAt` and
`finishedAt`, so "still running" and "crashed" are the same state. Excluding unfinished runs
would let a crashed run's set drift.

**Fork** (`POST /api/golden-sets/[id]/fork`) copies `src/lib/dataset-versions.ts:127-228`
structurally: `rootId = existing.parentId ?? existing.id`, max-version read + create + nested
child create in one `client.$transaction`, slug derived inside it, bounded retry on P2002 whose
`meta.target` includes `version` or `slug`. The fork inherits `datasetId` and `protocol`.

**Labels follow their item unless the fork edited that item's content.** `GoldenLabel` cascades
off `GoldenItem`, so new item ids mean labels vanish by default — A0 decides this whether or not
it notices. Copying preserves A1's agreement work through a typo fix; dropping on edited items
means an annotator's score is never attributed to text they did not see. Content comparison is
over `inputText`, `promptText`, `responseText`, `expected` and the candidate list.

---

## Pairwise execution

Scope: **pointwise and pairwise execute. Listwise is storable and annotatable, not runnable.**

- `prisma/seed-core.ts` — a `v1-pairwise` `PromptTemplate` (`@@unique([name, version])` is on
  name+version, so the distinct name is what separates it from `v1-legacy`).
- `src/lib/llm/render.ts` — a pairwise branch in `renderJudgmentSystemPrompt` and an A-vs-B
  branch in `buildJudgmentUserPrompt`. Candidate order presented follows `pairOrder`.
- `src/lib/llm/judgment-schema.ts` — a pairwise verdict schema requiring `verdict` and
  `reasoning`, and **not** `overallScore` or `criteriaScores`. Plus the matching parse path.
- `src/lib/run-launch.ts:172, 302, 468` — protocol resolved from the run rather than hardcoded;
  `resolveCurrentPromptTemplate` queries by protocol; `RunCandidate` rows written for pairwise.
- `src/lib/queue/publish.ts:56` — `protocol` widened from the literal to `RunProtocol`.
- `src/worker/judgment-consumer.ts`, `src/worker/run-create-consumer.ts` — branch on protocol.

**`pairOrder` is written explicitly on every judgment, never left NULL** — `'AB'` for the single
order A0 emits, and NULL reserved for pointwise as the existing unique index assumes. That is
what makes the `BA` sweep additive: A2 adds a second judgment per pair with no migration, no
backfill, and no ambiguity about what the existing rows measured.

**A0 does not emit `BA`.** Running both orders doubles inference cost and exists to serve
`positionBias`, which the roadmap assigns to A2. The side-by-side permutation-difference report
the owner asked for belongs with that work.

---

## API surface

`/api/golden-sets` — hyphenated, matching `api-keys`, and the segment propagates to the UI route,
the access-matrix registry key and the config document key.

| Route | Methods | Notes |
|---|---|---|
| `golden-sets/route.ts` | GET, POST | GET is `optionalAuth` public-read, paginated `{data, pagination}` (the datasets/projects shape, not the bare array `/api/rubrics` returns). POST is create-by-import. |
| `golden-sets/[id]/route.ts` | GET, PATCH, DELETE | GET decides via `resolveResourceAccess` → owner gets the raw row, public gets `toPublicGoldenSet`. PATCH is freeze-guarded on content fields. |
| `golden-sets/[id]/items/route.ts` | **GET**, PATCH, DELETE | No POST — items only arrive by import. DELETE re-indexes survivors 0..n-1 inside a `$transaction`, because `@@unique([goldenSetId, index])`. |
| `golden-sets/[id]/fork/route.ts` | POST | |
| `golden-sets/[id]/retire/route.ts` | POST | The first `retiredAt` writer with a product meaning. |
| `golden-sets/shared.ts` | — | zod schemas and Prisma includes. Next 15 rejects non-allowlisted named exports from `route.ts` (`src/app/api/models/shared.ts:1-8`). |

**The items route gets a GET that `datasets/[id]/samples/route.ts` does not have.** That omission
is exactly why a client-side import would fall back to the 100-capped detail route.

**New scopes `golden-sets:read` / `golden-sets:write`** in `src/lib/permissions.ts`, plus
`SCOPE_GROUPS` and the non-Full-Access presets. Reusing `datasets:*` would silently grant every
existing Dataset Manager key write access to ground-truth data.

**`CONTRIBUTING.md:260-350`'s "Adding a New API Route" recipe never mentions `requireScope`.**
Following it literally ships a route where a key holding only `stats:read` can read and mutate
every golden set. A0 does not follow it literally.

---

## Deletion: tombstone

`GoldenSet.tombstonedAt` is distinct from `retiredAt`:

- `retiredAt` — out of circulation, still valid ground truth. A product verb.
- `tombstonedAt` — pending purge. An account-lifecycle verb.

`src/lib/account-deletion.ts` already soft-retires golden sets pinned by a `CalibrationRun`
(module doc, lines 30-36 — "1b-prereq (a), closed by Task 15"). It hard-deletes only *unpinned
private* sets. **A0 extends the soft path to cover that case too**, writing `tombstonedAt`
instead of deleting. Nothing is destroyed, so the P2003 abort that `parentId` would otherwise
introduce cannot arise, and no child-version guard is needed.

`RESULT_CATEGORIES` (`account-deletion.ts:65`) keeps `goldenSets`, and
`tests/db/account-deletion.test.ts`'s exact-key-set assertion is unchanged. That test gains a
case it currently lacks: an account holding a **forked child** set.

**Every read path filters `retiredAt: null, tombstonedAt: null`** — list, detail, config export,
and future calibration-eligibility queries — with an `?includeRetired` escape. Without the
readers, a retire button is a no-op the user cannot see; nothing in `src/` filters `retiredAt`
on golden sets today.

Purge is a follow-on wave, deliberately.

---

## Config document and the round trip

Prerequisite: **land `d2c3f3b` (`test/config-roundtrip-fidelity`) first**, as its own PR. It
rebases clean on `7306c2f` (1 ahead, 16 behind) and is a single 394-line test file. Its
`COVERAGE` map is driven off `Prisma.dmmf.datamodel.models` and classifies every scalar column as
`exported` / `excludedByDesign` / `knownGaps`, asserting the exact gap set — so an unclassified
new column fails the test automatically. That is the mechanism A0's exit gate needs, already
built.

A0 then touches, and all of these are load-bearing:

- `src/lib/config.ts` — `ConfigDocument` (:117-125), `configDocumentSchema` (:188-199), a
  `goldenSetSchema`, a `dbGoldenSetToConfig`, and `DiffItem['type']` (:341).
- `src/app/api/config/export/route.ts` — **both** the `sections` array (`:41-43`, currently
  `['projects','rubrics','models','datasets']`) **and** the `config: ConfigDocument` literal
  immediately below it, plus a new section block scoped `where: { ownerId: userId }`.
- `src/app/api/config/import/route.ts` — a fifth loop, ordered after datasets.
- `src/app/settings/page.tsx:20, 362-367` — the locally re-declared `DiffItem['type']` union and
  the `typeIcon` map, or the diff row renders with no icon.

**Items are always embedded**, asymmetric with datasets (whose samples sit behind
`?includeSamples=true`, default off). A golden set exported without its items round-trips
vacuously.

**A fork on import is reported as a `create`**, not a new `DiffAction`. Adding a value changes
`ImportDiffReport.summary`'s three-key shape, the settings page's `actionVariant`, and every
`expect(body.summary).toEqual({create, update, skip})` assertion — too much blast radius for a
rare path.

**Labels are `excludedByDesign`**, with the reason recorded in the COVERAGE map: `annotatorId`
is a real `User` FK under `@@unique([goldenItemId, annotatorId])` with no portable
representation, and the importer re-attributes everything to `session.user.id`
(`config/import/route.ts:104`), which would forge attributions. `publishedAt`, `retiredAt` and
`tombstonedAt` are likewise `excludedByDesign` with their reasons stated — `ConfigDataset`
already drops `publishedAt` — so that a re-import silently resurrecting a retired set is a
recorded decision rather than an accident.

---

## UI

Two pages, following the codebase's conventions exactly: a single `'use client'` page file,
`<Header title description actions breadcrumbs />` over `<div className="p-6 space-y-6">`,
create in a `<Dialog>` (there is no `/new` or `/edit` route anywhere in this codebase),
`window.confirm()` for destructive actions, `toast.success` / `toast.error(data.error || …)`,
explicit `dark:` classes, inline SVG icons, no external UI libraries (`CONTRIBUTING.md:82`).

- `/golden-sets` — list, plus a create dialog whose dataset picker offers only platform corpora
  and whose protocol selector drives the mapping.
- `/golden-sets/[id]` — detail: the set's dataset and protocol, its items with their source
  sample, per-item `expected` editing, candidate display, retire, and fork-when-frozen.

Three coordinated nav edits (`CONTRIBUTING.md:377-383`): `navItems` in
`src/components/layout/sidebar.tsx`, the G-chord switch in `src/components/layout/app-shell.tsx`,
and `shortcutGroups` in `src/components/layout/keyboard-shortcuts-dialog.tsx`. Taken second keys
are `d p r s m e l`; **`G g`** is free and mnemonic.

**There is no UI test harness.** All three vitest configs are `environment: 'node'`; there is no
jsdom, no testing-library, no playwright, and zero `.test.tsx` files. "Created through the UI" is
a manual check, and A0 reports it as one. The owner has accepted this, and asked for a dedicated
follow-on roadmap covering UI/UX for human judging, data entry, and custom rubric/prompt
variations — see below.

---

## Tests

- `tests/db/golden-sets.test.ts` — route-level CRUD, following `tests/db/model-endpoint-crud.test.ts`.
- `tests/db/golden-set-import.test.ts` — the three mappings against real JudgeBench rows;
  asserts 620, not 100; asserts a pointwise import yields `expected: null`.
- `tests/db/golden-set-fork.test.ts` — freeze, fork, and the label-copy rule including the
  edited-item case.
- `tests/db/access-matrix.test.ts` — a `registry` entry and `ACCESS_MATRIX` rows, plus the
  sub-route rows for `/fork` and `/retire`.
- `tests/db/config-roundtrip-fidelity.test.ts` — `GoldenSet`, `GoldenItem`, `GoldenCandidate`
  added to `COVERAGE`; the exact-gap assertion updated.
- `tests/db/account-deletion.test.ts` — a forked-child case; tombstone assertions.
- `tests/db/dataset-sample-freeze.test.ts` — `PUT /api/datasets/[id]/samples` 409s once a golden
  set pins the dataset.
- `tests/lib/golden-sets.test.ts` — the pure mapping and freeze predicate.
- `tests/lib/render-pairwise.test.ts` — the pairwise prompt and verdict schema.
- Integration — a pairwise run end to end against a stubbed backend, asserting `verdict` and
  `pairOrder: 'AB'`.

**Placement and coverage, both load-bearing:**

`tests/db/<topic>.test.ts` — plain `.test.ts`; `.db.test.ts` is reserved for `tests/importer/**`.
`truncateAll()` introspects `pg_tables`, so `GoldenCandidate` needs no registration.

`src/app/api/**` is outside every vitest coverage `include`; `src/lib/**` is inside both. There
are two floors to clear, and **the tighter one is not the aggregate**.

*The aggregate* (`vitest.config.ts:103`): `lines 33 / functions 63 / branches 81`, actual
`35.20 / 65.00 / 83.06` (recorded at `:96-102`). At 1960/5568 lines, roughly **371 uncovered
lines** can be added before it breaches. A large `src/lib/golden-sets.ts` exercised only by DB
tests eats that alone, turning `npm run test:coverage` red for reasons that look unrelated to A0.

*The per-glob floor on the directory the pairwise work lands in* (`vitest.config.ts:118`):

```
'src/lib/llm/**': { statements: 90, functions: 94, branches: 80, lines: 90 }
        actual:     93.97 / 85.07 / 97.36 / 93.97
```

**That is ~4pp of line headroom and ~3.4pp of function headroom, in the exact directory
`render.ts` and `judgment-schema.ts` live in.** The pairwise renderer, the pairwise verdict
schema and its parse path must arrive with near-complete unit tests — not "covered by the
integration run", which this gate does not see. This is the single easiest way for A0 to go red
on a green test suite.

Also worth knowing before touching the worker: `'src/worker/**'` carries
`{ functions: 80, branches: 80 }` against an actual of `100/100` that the config itself labels a
**not-imported artifact** (`:112-115`). Adding protocol branching to `judgment-consumer.ts` is
harmless; adding a unit test that *imports* it makes those two numbers real for the first time
and can drop them below 80 in a way that looks like the test broke something.

Hence: transactional logic in `src/lib/`, pure parts unit-tested in `tests/lib/`, and the LLM
work unit-tested to the standard its directory already holds. Per the policy in
`vitest.db.config.ts:42-73`, if A0 moves the actuals, re-baseline the floors **upward** and
update the "Actuals as of" comment blocks. Never lower a number to go green.

**Any new unawaited write must be wrapped in `trackBackgroundWrite`**, or it re-creates the
40P01 TRUNCATE deadlock fixed in `5a76ef3` — which reproduced on the *second* CI run only, and
surfaced as an unrelated flaky test in someone else's file.

---

## Sequencing

0. Land `d2c3f3b` (round-trip fidelity) as its own PR.
1. Migration + schema, including the `CONTRIBUTING.md` pseudo-drift entry **and the
   dataset-sample freeze 409**.
2. `src/lib/golden-sets.ts`, `src/lib/golden-set-versions.ts` + `tests/lib/`.
3. Routes + `tests/db/`.
4. Pairwise execution path + tests.
5. Config export/import + `COVERAGE` extension.
6. UI.
7. Tombstone + retire readers.

**The 409 belongs in step 1, not later.** `sourceDatasetSampleId` is `Restrict`, so the moment
the migration lands, `PUT /api/datasets/[id]/samples` starts failing on any annotated dataset —
as a raw P2003 until the handler exists. The guard and the constraint that necessitates it ship
together, or there is a window where a real behaviour change surfaces as a Prisma error code.

Steps 2–4 are where the correctness lives, and all three are covered by the `db-tests` CI job
that now gates `build-push`.

---

## Exit gate

Seven things that can fail:

1. Three golden sets over `judgebench-v1` — one pointwise, one pairwise, one listwise — created
   through the UI.
2. Export → import on a fresh instance reproduces the rows, **asserted on imported rows**, never
   on `res.status` or `body.summary`. `configDocumentSchema` is a plain `z.object` with no
   `.strict()`, so an unknown `goldenSets` key is silently stripped: ship the export side without
   the import side and the round trip goes green having lost everything, with no 400 and no error.
3. `COVERAGE` classifies every `Golden*` column; the gap set asserted exact.
4. A calibrated set rejects item edits and offers a fork; the fork carries labels except on items
   it edited.
5. A pairwise run against a golden set completes with `verdict` and `pairOrder: 'AB'` populated.
6. Account deletion tombstones rather than deletes, with a forked child present.
7. `PUT /api/datasets/[id]/samples` returns a 409 naming the pinning golden sets.

---

## Deliberately not doing

- **The `BA` permutation sweep and its side-by-side report.** Wanted, and held for A2/A3 where
  `positionBias` lives. `pairOrder` is written explicitly so this is additive.
- **Listwise execution.** Storable and annotatable in A0; runnable when a listwise renderer
  exists.
- **Hand-authored golden items.** Golden sets are annotated platform corpora. Data entry is a
  follow-on roadmap.
- **Purging tombstoned rows.** A later wave.
- **Fixing the rubric surface's missing referenced-by guard.** Real, recorded above, out of scope.
- **Widening golden sets to user-owned datasets.** A dropped check when wanted, not a migration.
- **UI test infrastructure.** No harness exists; see the follow-on roadmap.

---

## Follow-on documents this phase owes

1. **A UI/UX roadmap** — human judging surfaces, entering more data, and running custom rubrics
   and prompt variations. Requested by the owner on 2026-08-12, to be written as a sibling spec.
2. **The `BA` permutation sweep**, recorded as an A2 dependency with the note that it needs no
   migration and no backfill.

---

## What would make A0 look done while being wrong

- **The export-only round trip.** Green, and every golden set lost. Assert on rows.
- **`'goldenSets'` missing from the hard-coded `sections` array.** Unknown section names are
  silently ignored, so `?include=all` omits golden sets and every manual check passes.
- **Importing 100 of 620 rows** by reading the detail route client-side.
- **Reusing the evaluations dataset mapping**, producing `inputText = 'A>B'` on all 620 rows.
- **A retire or tombstone writer with no reader.** Nothing filters `retiredAt` on golden sets
  today; the button would do nothing visible.
- **Freeze without a transaction.** A run started between the count and the mutation measures a
  set that changed under it.
- **A missing migration.** `npm run test:db` runs `prisma migrate reset --force --skip-seed`,
  replaying only committed migrations — a schema edit without one runs the whole DB suite against
  the old schema and surfaces as a confusing P2022.
- **An unscoped route**, per `CONTRIBUTING.md`'s incomplete recipe.
- **Coverage-gate breach with zero test failures**, from a `src/lib/` module tested only by DB
  tests.
- **A new unawaited write** outside `trackBackgroundWrite`, reintroducing the 40P01 deadlock.
- **Claiming UI coverage.** There is no harness. It is a manual check.
