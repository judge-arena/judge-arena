# Rebaseline: Judge Arena against two north stars

**Date:** 2026-08-08 · **Revised:** 2026-08-09 with the pinned sharing model
**Revised again:** 2026-08-10 — four-state data model; rubrics immutable; endpoint config admin-only (decision C); deletion is two requests; lossless portability a guarantee; two-product split (Roadmaps A and B); promotion requires manual review
**Status:** decisions A–D resolved; all 9 open questions resolved. Live work is now tracked in Roadmaps A and B.
**Supersedes:** `2026-08-07-public-users-roadmap.md` — that document's *facts* remain
reliable and are cited throughout; its *sequencing* assumed a different goal and is replaced.

## Why this exists

The 08-07 roadmap optimised for one question: *how do we let a stranger sign up without
getting hurt?* The owner has since pinned the product intention and the operating
constraints, which re-ranks nearly every item.

**Product intention (all of it, enabled):** a public **leaderboard** as the front door,
**rubric** authoring, **cheap model runs**, **versioning** of datasets/models/rubrics, and
**BYOK** — users bring their own models and their own keys.

**Two north stars, treated as gates rather than aspirations:**

1. **Backend state stays in good condition** — durability, integrity, recoverability, no
   silent loss of user work.
2. **Cluster hardware, balance and health stay in good condition** — headroom, failure-domain
   spread, no unbounded growth, and failure modes that are observable.

Everything below is verified read-only against the live cluster and the
`feat/1c-deploy-readiness` code line on 2026-08-08.

---

## This document is the platform foundation for two products

Clarified by the owner 2026-08-10: Judge Arena is **two products that close a loop**, and each now
has its own design roadmap. This document stops being the plan for all of it and becomes the
**shared foundation** the rest stands on — data tiers, retention, resilience, cluster constraints,
delivery path, and the board's serving work.

| | Purpose | Roadmap |
|---|---|---|
| **A. The training engine** | Labelling, entry, human verification, distillation — building a **stronger judge** | `2026-08-10-judge-training-engine-roadmap.md` |
| **B. The sharing component** | Standardized benchmarks, review, and a public leaderboard — showing **how that judge performs** | `2026-08-10-benchmark-sharing-roadmap.md` |

The loop is the product: A produces a judge and the labelled ground truth to justify it, B measures
it against a yardstick its trainer did not choose, and the result says whether the training was
worth doing. The stated goal is a product that helps build and train the best LLM judges possible,
so neither half is optional and neither is meaningful alone — A without B is a labelling tool with
no external validity; B without A is a leaderboard for judges someone else trained.

**Two findings from surveying both halves that belong here rather than in either roadmap:**

- **The entire training half is already modelled and has zero code.** `GoldenSet` → `GoldenItem` →
  `GoldenLabel` → `CalibrationRun` → `TrustState` all exist, with real metrics (`kappa`,
  `testRetest`, `positionBias`, `biasSensitivityRate`, `flipRateVsParent`) — and **no API route
  references any of them.** Roadmap A is implementation of an existing design, not new design.
- **There is zero GPU allocatable on all seven nodes** (the `extensions.talos.dev/amdgpu` label is
  present everywhere but allocatable GPU is `none`). So the platform cannot train or distil a model;
  it produces labelled data, a training-set export, and a verdict. That boundary is consistent with
  BYOK and needs stating in product copy rather than being discovered by a user looking for a Train
  button.

---

## The reframing that reorganises the plan

The 08-07 roadmap sequenced *features, then hardening*. Against these north stars that
ordering is wrong, because for every one of the five pinned capabilities, **the capability's
own success is its principal threat**:

| Capability | Its own failure mode at success |
|---|---|
| Public leaderboard | Reads *every* completed judgment, uncached, unthrottled, into a single 1 GiB pod at `replicas: 1` whose readiness probe shares the process. Traffic is the DoS. |
| Cheap model runs | One `POST` can enqueue tens of thousands of messages into a broker at **54% of a publisher-blocking watermark GitOps cannot raise**. |
| Versioning | Append-only growth on `local-3rep` (3× multiplier) into a LINSTOR pool **already under its headroom alert**. |
| BYOK | Arbitrary endpoint URLs *are* the SSRF full-read oracle — **defused by decision C**, which makes endpoint configuration admin-only and leaves BYO-key untouched. Retained in this table because it is the one case where the bound came from narrowing the capability rather than containing it. |
| Rubrics | Unbounded size, and every criterion is rendered into every judgment prompt. |

So the organising principle of this rebaseline is: **each capability ships together with its
bound.** No capability is "done" until the thing that makes its success survivable ships in
the same track. This is not extra scope — it is the same work, re-sequenced so that no track
leaves a north star worse off than it found it.

---

## The data and sharing model

Pinned by the owner, settled 2026-08-10. Model versions are **vendored per account**
(`userX-gpt4o` ≠ `userY-gpt4o`). A leaderboard row is **user/org · model · benchmark · final
score**.

### Four states, two agreements, one review gate

The load-bearing correction, and an earlier draft of this spec got it wrong: **granting data to
the platform is not the same as publishing it.** A second correction followed on 2026-08-10:
**reaching our database is not the same as reaching the leaderboard.** Both collapses were the same
mistake — treating a mechanical fact as if it settled a question of judgement.

| State | What it covers | Who can see it | Governed by |
|---|---|---|---|
| **User-retained** | Everything | Only the user | Default. Logging and organising only, or self-hosted |
| **Platform-granted** | A custom dataset and everything entered alongside it, when hosted compute ran it | The platform | A platform use agreement: compute in exchange for data rights |
| **Candidate** | A hosted run against a *published* benchmark, eligible for the board | The platform, and the submitting user | Mechanical eligibility |
| **Public** | Score, benchmark, model, user/org handle, **and the selection metrics: cost, latency, reliability**. Plus reasoning/responses **only where explicitly opted in** | The world | **Manual review**, then a research-sharing commitment |

**Promotion to the public board requires human review** (owner decision, 2026-08-10). Compute
provenance can be established mechanically; "this number belongs on a research leaderboard" cannot.
Making promotion a human act protects the public tier's value and means a gaming attempt has to get
past a person rather than past a predicate. The review mechanics, the evidence a reviewer needs, and
demotion are specified in Roadmap B (its B2).

The two agreements are different in kind and must be described differently. The public tier
exists so results can be compared and cited — it is deliberately narrow, and widening it later
would be a change of promise, not a feature. The platform tier is consideration for compute: if
you spend our hardware on a custom dataset, the platform gains rights to that data. **It does not
become world-readable.** A user who wants neither has two real options that cost them nothing:
use the product purely to log and version their own work, or self-host.

**What is published is a narrow, fixed set, and it was widened once — deliberately, on the record.**
Revised 2026-08-10: the public tier now also carries the **selection metrics** — cost, latency and
reliability. This is a change of promise rather than a feature, so it is recorded as one. It is a
benign widening because those three are properties of *the judge under test*, derived from the
platform's own execution, and contain no user content. The reason they belong in public is the
product thesis: **how fast, how much and how reliably are the primary axes for choosing a judge
framework**, and a board that hides them cannot serve the decision it exists to inform.

Still never published by default: rubric criteria, dataset samples, `ModelJudgment.reasoning`,
`rawResponse`. Two deliberate exceptions, both narrow:

- **Benchmark publication** converts a `(dataset, rubric)` pair into a public yardstick. An admin act.
- **Opt-in reasoning publication.** The owner contributes their own completed, leaderboard-listed
  evaluations — reasonings and responses — as a public good, and any user **may optionally opt in**
  to contribute theirs. This is opt-*in* and stays opt-in: note the asymmetry with scores, whose
  eligibility follows from compute provenance. Nothing about spending our compute publishes a
  reasoning.

### The schema needs a rights axis the enum cannot express

The existing `Visibility` enum is a **content** axis and its `private` default is correct. But
`private | public` **cannot represent the platform-granted tier at all** — that data is neither
private to the user nor public to the world. Do not stretch the enum to cover it; a rights grant
is a different fact with a different lifetime, and conflating the two is how a user's dataset ends
up on the front page by accident.

Three separate things to record, and they are genuinely independent:

- **`Visibility`** (existing, unchanged default) — is this content world-readable? Only ever set
  to `public` by publishing a benchmark.
- **A data-rights grant** — `Dataset.platformGrantedAt` plus the `termsVersion` in force at the
  moment of the grant. Stamped when hosted compute first runs against that dataset, never
  inferred at read time. A rights transfer has to be evidenced by a record of *when* and *under
  which terms*, not derived from a join.
- **`EvaluationRun.executionTier`** — did this run execute on our compute? This is what makes the
  score publishable and what triggers the grant.

The visibility infrastructure that exists covers the exact *complement* of what is needed:
`Project`, `Rubric`, `Dataset` and `GoldenSet` carry `visibility`/`publishedAt` and are all
content that stays private; the result family (`Evaluation`, `EvaluationRun`, `ModelJudgment`) —
the only thing whose score is ever published — has **no visibility column at all** and is
hard-coded *never public*.

**Score *eligibility* is not an account preference. It is a condition of using the cluster's
compute.** Revised 2026-08-10: the earlier `User.shareToLeaderboard DEFAULT true` opt-out design is
withdrawn. There is no opt-out from a hosted run becoming a candidate — running here is what makes
the result eligible. Pure tracking and organising stays private, indefinitely, with no expiry. What
provenance does *not* do is publish: promotion from candidate to public is the review gate above.

This is a materially better design than the opt-out it replaces, for three reasons: it is
honest (the bargain is legible — you spend our CPU, the result is public), it removes an entire
class of consent bug (there is no default-on toggle that could be flipped for existing users by
a migration), and it is auditable (provenance is a fact about a run, not a mutable preference
that has to be evaluated retroactively).

`EvaluationRun.executionTier` records where the run executed. **There is no external-results path
anywhere in the codebase today**, so `hosted` is the only value that can currently be produced —
and under the self-hosting commitment below, that is now a gap to close rather than a hypothetical.

### Self-hosting is a first-class deployment target

Standing commitment, recorded 2026-08-10: **the product is always buildable and runnable
standalone, so a user can hold and retain all of their own data and publish only final scores if
they choose.** This is what makes the platform tier an honest bargain rather than a captive one —
the alternative to granting data rights has to be a real, supported option, not a theoretical one.

Two consequences, and the second is a genuine new requirement:

1. **No hosted-only coupling may become load-bearing.** Anything the app cannot do without the
   cluster's Authentik, Harbor, RabbitMQ topology or SOPS-managed secrets is a self-hosting
   regression. The existing `docker-compose.yml` and one-shot migration path are the reference
   deployment and must stay working — the scale-validation step that verifies this is currently a
   `TODO(Phase 2)` stub in CI, so nothing enforces it today.
2. **A self-hosted instance needs a way to publish scores to the public board.** "Retain your data
   and publish only the final scores" requires a score-submission path from an external instance,
   which does not exist. That is `executionTier: 'external'`, and it raises a trust question the
   board must answer visibly rather than silently:

**Platform-run scores are verified; self-submitted scores are self-reported.** We executed the
former and did not execute the latter. A research-sharing leaderboard that mixes the two without
labelling them is misleading, and the incentive to inflate a self-reported number is obvious.
So `executionTier` is not merely provenance bookkeeping — it is a **badge on the row**, and the
board should let a reader filter to verified-only. Decide the submission's integrity story
(signed payloads? a claimed benchmark version + rubric content hash that must match the published
one?) when that path is built, not after the first inflated score.

Note this also gives the platform tier a clean boundary: a self-hosted run grants **nothing**,
because no platform compute was spent. The grant is triggered by our CPU, not by our leaderboard.

### Deletion is two requests, not one

Settled 2026-08-10: **a platform grant survives account deletion, and a user may additionally
request data deletion.** These are two independent concepts and must be two independent
mechanisms — conflating them is how you end up either silently keeping data someone asked you to
erase, or silently destroying the granted corpus when someone merely closes their account.

| Request | Removes | Leaves |
|---|---|---|
| **Account deletion** | Identity, access, private user-retained content; public content reassigned to Archive | Platform-granted data; published leaderboard rows |
| **Data deletion** (additional) | The platform-granted corpus for that user | The account, if it still exists; published scores, per the retention class |

The consequence that shapes the implementation: **a data-deletion request must be serviceable
after the requester no longer has an account.** So it cannot be an authenticated in-app flow
only — that path stops existing at exactly the moment it is most likely to be used. It needs an
out-of-band, identity-verifiable channel (this is what makes the `privacy@` Email Routing item
load-bearing rather than cosmetic), an operator runbook, and an audit record of the erasure that
itself survives — because "we deleted it" is a claim that needs evidence.

Offer the data-deletion option *at* the account-deletion moment as well, since that is when most
people will want it and when their identity is still verifiable for free.

### The user-configurable surface, and one inversion to fix

On the hosted instance a user may **only upload and change what is user-configurable**: datasets,
rubrics, their own model vendoring, their own keys, and their **privacy and data settings**.
Configuration is drivable two ways — through the UI, and through the **YAML/JSON config files**,
which are a first-class interface rather than an import convenience.

That makes the config file path a **privacy and authorization surface**, and today it is the wrong
way round:

> **The file-based path must be a strict subset of what the UI path allows. Today it is a
> superset.**

Verified inversions, all in `src/lib/config.ts` and `src/app/api/config/import/route.ts`: the
import schema has **no `.max()` on any string** (`config.ts:127-193`), so it bypasses every length
cap the API routes enforce; `endpoint` is `z.string().optional()` with **no `.url()` at all**,
weaker than the routes' validation; it can set `isDefault` (`config.ts:185`); and it can rewrite a
rubric's criteria in place (`route.ts:193-194`), which is the immutability bypass noted above.

So the rule to implement, and to keep enforced by test: **anything the config importer can write,
a user could have written through the UI, with identical validation.** Concretely — reuse the route
schemas rather than parallel ones, re-run imported slugs through `generateSlug`, gate the endpoint
field on `isAdmin` like every other endpoint write, and drop `isDefault` entirely. A file-driven
path that can do more than the interface it mirrors is a privilege-escalation surface wearing the
costume of a convenience feature.

Privacy and data settings need the same treatment: expressible in the config files, but **never
able to express a state the UI cannot** — and never able to grant or revoke platform rights, which
are established by running on our compute and released only by the deletion process above, not by
a field in a YAML file.

### Portability is a product guarantee, not an import convenience

Confirmed 2026-08-10: **user configuration and config export are the same mechanism.** Try it on
the hosted platform, download your configuration, and move to a self-hosted instance
**losslessly.** This is what makes the platform-grant bargain fair in practice rather than in
principle — portability is *how* the alternative to consenting stays viable, so it inherits the
same standing-commitment status as self-hosting itself.

Current coverage is a decent foundation: the export already stamps `version: '1.0'`
(`config/export/route.ts:50`) and covers projects, rubrics, model endpoints and datasets. Not yet
covered, because they do not exist yet: `Benchmark`, and the privacy/data settings.

**Losslessness and the subset rule are reconciled by role, not by field.** Import is limited to
what *the importing user* could create through the UI *on that instance* — so the endpoint URL,
which is admin-only on hosted, legitimately applies on self-hosted, because there the importer *is*
the admin. The same file therefore applies more on a self-hosted instance than on ours. That is the
portability story working correctly, not a hole — but it means **import validation must be
instance-role-aware rather than schema-fixed**, which is a different shape of code than a single
Zod schema.

**What cannot round-trip, and must be documented as a known boundary rather than discovered:**

- **API keys.** Encrypted with the instance's `ENCRYPTION_KEY`, so ciphertext is useless elsewhere
  and exporting plaintext would be worse than lossy. Re-entered on the target, by design.
- **Verified provenance.** `executionTier: hosted` is a fact about our compute; a self-hosted
  instance cannot inherit verified status for scores we did not run.
- **Platform grants.** An agreement with the platform, not portable state.
- **The public handle.** It lives in the hosted public namespace.

**Settled 2026-08-10: the export carries results history *and* configuration.** An evaluation
history is work, and losing it on migration would make "losslessly" false in the way users would
notice most. Two consequences to plan for rather than discover:

- **Volume.** `ModelJudgment` runs ~25 KiB worst case per row, so a results export cannot be a
  buffered JSON response — it needs streaming or pagination. That is the same failure mode as the
  unauthenticated dataset export which can OOM the 1 GiB web pod, so solve it once for both.
- **The coverage assertion has to grow.** `Evaluation`, `EvaluationRun`, `ModelJudgment` and
  `HumanJudgment` are all unclassified in `tests/db/config-roundtrip-fidelity.test.ts` today,
  because nothing exports them. Adding them is what turns "results are included" from an intention
  into a checked property — and expect it to surface a second round of gaps the way the first round
  surfaced the version-lineage loss.

**The safeguard gap, and it is the reason this section exists.** There is already a round-trip test
— `tests/db/config-import-export.test.ts:199` asserts an exported document "re-imports as a
no-op." That is **idempotency, not fidelity, and it structurally cannot detect loss**: a field the
export drops entirely still re-imports as a no-op, because the importer never sees it and so
changes nothing. So nothing in the suite today would catch export silently losing a column, and
every column added from here is a chance to break a guarantee whose test still passes.

What is needed instead, and the second item is the one that makes it durable:

1. A **fidelity** test — populate every user-ownable field, export, import into a fresh database,
   export again, and compare both the documents and the resulting rows.
2. A **schema-coverage assertion**: every user-ownable column is either present in the export or on
   an explicit exclusion list carrying a stated reason. The exclusion list is what lets the
   guarantee survive a new column, because adding one then fails the check until someone decides
   which side it belongs on.

**Also: the export path currently writes to the database.** `config/export/route.ts:105-119` lazily
backfills `Rubric.slug` when it is null. Two consequences worth fixing while portability is being
made load-bearing: a read-shaped operation that mutates rows is the wrong shape for the mechanism
users are told to trust, and it forces "immutable" to be stated precisely (criteria immutable, slug
backfillable). The in-memory uniqueness pre-check is also per-request, so two concurrent exports
rely on `@@unique([userId, slug])` to reject a collision as an error rather than handling it.
Backfill the slug at creation instead, and let export be genuinely read-only.

Because content publication is now an **explicit user action**, `visibility` writers *are*
needed on `Rubric`/`Dataset`/`Benchmark` — reversing the note in the previous revision, which
assumed nothing would ever be published deliberately. `publishedAt` stops being dead and becomes
the timestamp of that action. `Project` remains a private folder with no publish action.

The board publishes **metadata and a score**, never content: no rubric criteria, no dataset
samples, no `ModelJudgment.reasoning`, no `rawResponse`.

### The comparability problem, and its non-negotiable prerequisite

Private rubrics plus public scores means two rows on the same dataset may have used different
rubrics, so the scores are not comparable. **The resolution is a `Benchmark` entity** binding a
canonical `(dataset, rubric)` pair, published as a unit. A leaderboard row exists only for a
hosted run against a *published* benchmark. Comparability then holds **by construction** rather
than by disclosure — which is how MMLU/HELM/LMArena work — and a user's own working rubrics stay
private, because a benchmark's rubric is a deliberately-published shared yardstick, not whatever
someone happened to run with.

Note this is the mechanism that keeps "private by default" and "running publishes" from
contradicting each other: what a hosted run publishes is a score **against an already-public
yardstick**. A run against a private, unpublished `(dataset, rubric)` pair has nothing comparable
to appear next to — which is precisely what open question 2 has to settle.

This also dissolves the tenancy blocker: nobody writes into a shared project, so no ownership
check is invalidated. Users run in their own projects; the benchmark is the join. `GoldenSet`
(schema:642) is the shape to mirror — it already carries `visibility` + `publishedAt` +
`retiredAt` + `ownerId … onDelete: SetNull` with a documented soft-delete rationale that
`account-deletion.ts` understands. Note `@@unique([datasetId, rubricId])` is load-bearing and
forecloses publishing the same pair under two benchmark names — intended, but say it out loud
before landing, because reversing a unique index after rows exist means picking a winner.

### Rubrics are immutable at creation

Decided 2026-08-10, and it **supersedes the freeze-on-publication design** in the previous
revision. A rubric's criteria can never be edited after creation. Changing a rubric means
creating a **new version, pre-filled from the latest version's values**, which makes versioning
explicit instead of something that silently happens to a score's meaning.

This is strictly simpler *and* stronger than a `frozenAt` guard: every rubric is frozen from
birth, so there is no window in which a rubric is mutable-but-referenced, and no predicate to
get wrong. `Rubric.contentHash` is still worth having for identity and dedup, but it stops being
load-bearing for correctness.

The problem it closes: `PATCH /api/rubrics/[id]` destructively rewrites criteria **in place with
no version bump**, so today an owner can change what a rubric means *after* a score derived from
it exists — retroactively invalidating every comparison, with no record. Under high retention
that is worse rather than better: you would retain numbers that can no longer be interpreted.

**Two paths must close, not one.** Immutability is bypassable if only the obvious one is fixed:

- `src/app/api/rubrics/[id]/route.ts:82-87` — `rubricCriterion.deleteMany` then `rubric.update`.
- `src/app/api/config/import/route.ts:193-194` — the identical `deleteMany` + `update` pair,
  reachable by importing a config that names an existing rubric.

The fork path already exists: `createRubricVersion` in `src/lib/rubric-versions.ts`, with
`RubricVersionConflictError` and a `parentId` + `version` family (`GET
/api/rubrics/[id]/versions` already walks it). So this is mostly deletion plus a redirect, not
new machinery. Wire the **already-defined** `rubric.update` audit action (`src/lib/audit.ts:26`)
to version-creation events so lineage is recorded.

Apply the same rule to `Dataset` — a dataset version fork route already exists at
`src/app/api/datasets/[id]/versions/`. A benchmark's yardstick is `(dataset, rubric)`; both
halves have to be immutable or the guarantee is only half true.

### Per-account vendoring is required, not optional

The board currently aggregates on `JudgeModelVersion.id`, so **two accounts vendoring the same
version collapse into one row** — the target's user column cannot exist without this change.
Of the three catalog tables only `ModelEndpoint` has a `userId`. The migration is small
because the catalog is **empty**: add `JudgeModel.ownerId` (nullable), make `slug`'s global
`@unique` a compound unique with the owner, swap one index. Zero backfill.

Two consequences worth stating: an owner column is exactly what lets `account-deletion.ts`
clean up catalog rows, **which today it provably cannot**; and `GET /api/models/catalog`
currently publishes **every user's custom judge names and `baseModel` strings to every other
user**, which directly violates private-by-default and must be scoped in the same change.

Also confirm whether `trustState` is global per version — if two accounts vendor the same base
model, one account's `CalibrationRun` must not mutate the trust label another account's
leaderboard row rests on.

### Public identity does not exist yet

`User` has no handle, username or slug — only a nullable, **non-unique**, OIDC-derived `name`
with no self-service editor, and `email`, which must never reach a public page. There is **no
Org/Team/Workspace entity anywhere** in the 24-model schema.

Add `User.handle String? @unique` with a charset guard and a reserved-word denylist (it will
appear in URLs). **The fallback for a null handle must not be `name`** — it is non-unique, so
two distinct accounts would render identically on the product's primary surface: that is a
correctness bug, not a cosmetic one. Either block publication until a handle is set, or render
`user-<id-prefix>`. Model `user/org` as a single handle namespace for now; a real Org entity
means an owner-polymorphism decision on ~9 `userId` foreign keys and is its own project.

Per-account vendoring makes user-chosen strings the primary public identity, so public-string
hygiene stops being cosmetic: NFKC-normalise and reject bidi-override, zero-width and other
`Cf`/`Co`/`Cs` codepoints on every field that renders publicly. Two live holes today —
`src/lib/config.ts:127-193` has no `.max()` at all, so **config import bypasses every length
cap the API routes enforce**, and `User.name` reaches the anonymous wire through
`toPublicOwner` with no validation whatsoever. (XSS itself is not reachable: no
`dangerouslySetInnerHTML`, and React escapes JSX text.)

### The specification that has to change is a test table

`tests/db/access-matrix.test.ts` pins `Evaluation`/`EvaluationRun`/`ModelJudgment` as
`expected: 401` for anonymous callers across 8 passing rows, commented *"never public —
user-created data, spec §7 D3."* **That table, not the schema, is the real blocker** — it is
the specification. Extend it with a new `shared` actor dimension rather than editing those rows
in place, so the old guarantee stays asserted for everything still private.

### Consent is a hard ordering constraint, not a late item

The owner's requirement is that the bargain be **upfront**. Because publication is now triggered
by an irreversible act (spending our compute) rather than by a preference someone can change
later, the disclosure has to be attached to that act — not buried in terms nobody reads at
sign-up and never sees again.

**Disclosure lands in two places, and both are required:**

1. **At first sign-in** — `User.termsAcceptedAt`, gated in the app shell. There is no
   registration flow to attach it to (`/register` is a dead-end landing page), so it hangs off
   the OIDC first-login path in `src/lib/oidc-user.ts`.
2. **At the point of launching a run** — an unmissable statement in the launch UI that running
   here publishes the result, shown every time, not once. This is the one that actually
   discharges "upfront," because it is adjacent to the decision it governs.

**The terms carry three documents' worth of substance, matching the three tiers, and collapsing
them into one undifferentiated page is exactly how users end up misunderstanding the middle one.**
State separately: (1) what becomes **public** — score, benchmark, model, handle, and nothing else;
(2) what becomes **platform-granted** — a custom dataset and everything entered with it, when our
compute runs it, including whether that grant survives account deletion; (3) what stays **the
user's** — logging-only usage and self-hosting, both fully supported, both costing them nothing.
The middle one is the only one that transfers rights, so it is the one that must be impossible to
miss. The run-launch disclosure should name the specific dataset whose rights are about to
transfer, not gesture at a policy.

**Required order: `/terms`, `/privacy`, the run-launch disclosure and a working account-delete
route all land BEFORE the board serves its first published row.** Account deletion *reassigns*
public content to Archive rather than purging it (decision 5), so a row published without
disclosure has no after-the-fact remedy.

One consent hazard from the previous revision is now **eliminated rather than mitigated**: with
no default-on account toggle, there is no migration that could silently opt in existing users,
so the "land it while the DB is empty" constraint disappears. Provenance is a fact about a run at
the moment it executed; it cannot be retroactively changed for runs that already happened.

### The single-project board is deleted, not patched

The old roadmap's "make `isDefault` admin-only" patches the hijack but preserves the
single-tenant board — work the target model throws away. Under a benchmark-keyed board there is
no project axis at all, so `isDefault` should be removed from `projectSchema` and the import
writes and dropped in a follow-up migration. Anonymous project visibility then rests solely on
`Project.visibility`, which is currently unreachable — the correct end state, because under the
target a project is a private folder.

---

## Four blockers the 08-07 roadmap never saw

These were found by a full-cluster baseline and none appears in the previous document.

**1. WAL archiving is configured, reports success, and has no destination.**
CNPG reports `ContinuousArchiving: True`, `archive_mode: on`, and 15 successfully-archived
WAL segments — and there is **no PITR for judge-arena or for any other database in this
cluster.** The safeguard that looks present is a no-op. This is what makes decision 7
("accept a 24h RPO") untenable rather than merely uncomfortable.

**2. No restore has ever been performed in this cluster, by any mechanism, for any
workload.** RTO is unmeasured and unbounded. The only artifact protecting `judge_arena` is a
single 240 MiB hot, non-atomic, file-by-file copy of a running Postgres data directory
(`cnpg-all-daily-20260808080045`, one PodVolumeBackup in its entire history). Consistency on
restore depends on crash recovery that has never been exercised.

**3. The public leaderboard is structurally single-tenant — the product does not exist
yet.** `leaderboard/route.ts:73-80` scopes to `e.projectId = leaderboardProject.id`, and
`POST /api/evaluations` returns 403 unless `project.userId === session.user.id || isAdmin`.
Only that project's owner or an admin can put anything on the board, and **no API can even
create that project.** The board is publicly *readable*; it is not publicly *contributable*.
Everything the old roadmap called "the front page" is a private board with anonymous read.

**4. One commit can permanently destroy the database.** Flux `prune: true` plus CNPG PVC
deletion plus `reclaimPolicy: Delete`, with nothing in between.

Two more, lower but structural: `decryptSafe` returns the **ciphertext as if it were the API
key** when `ENCRYPTION_KEY` does not match, so a key/DB pairing mistake fails silently rather
than loudly; and `POST /api/config/import` destroys an existing dataset's samples **outside
any transaction** — the cheapest real data-loss path in the app.

---

## Corrections to the 08-07 roadmap

Items that must change rather than simply be re-prioritised.

- **"Allowlist the handful of known provider hosts; admin adds anything else" is
  incompatible with the pinned product.** It resolves SSRF by deleting capability (e).
  Demoted to an optional same-day interim. See T4 for the resolution that keeps both.
- **The chart is wrong about its own containment.**
  `charts/judge-arena/templates/networkpolicy.yaml` states the per-app egress policy
  "DOCUMENTS INTENT, IT DOES NOT RESTRICT." Verified false: **Cilium `egressDeny` does
  subtract from the namespace-wide blanket allow.** Network-enforced containment *is*
  expressible here. `values.yaml` also contradicts its own template on this exact fact.
- **"Wire the tile-coverage test into preflight" would ship a guard that never runs.**
  `tests/ingress/homepage-tile-coverage.sh` exits 78 (STUB) unless `kubectl get ingress -A`
  succeeds, and the Gitea runner has no cluster access — so it would report a permanent
  silent skip that reads as a pass. The same trap applies to all 49 cluster-connected
  scripts under `tests/`. (Separately: that script **fails right now** for `judgearena.com`.)
- **"Add an Uptime Kuma monitor" is not a shippable item.** There is no reconciler, no
  CronJob, and `apps/public/uptime-kuma/kustomization.yaml` explicitly does not apply
  monitors. The item is "build the reconciliation path, or do it by hand and say so."
- **Decision 7 flips.** 24h RPO is defensible for leaderboard content, which is reproducible
  by re-running. It is *not* defensible for a rubric someone spent an evening authoring or a
  provider key they re-entered. Enabling exactly the two capabilities the owner wants is what
  converts "accept 24h RPO" into "configure WAL archiving first" (0.5–1 day, existing R2 bucket).
- **"Add an endpoint/user segment to the circuit-breaker key"** — the endpoint segment
  already exists (`src/lib/llm/index.ts:48`). Only the **user** segment is missing.
- **`GET /api/models/catalog` is not an anonymous surface** and *does* filter `retiredAt`.
  The real defect is that `retiredAt` has **zero writers**, so the catalog is append-only
  forever and account deletion provably cannot clean it.
- **`requireScope()` is a no-op for cookie sessions** (`src/lib/auth-guard.ts:192`). Every
  phrase of the form "any user with `models:write`" in the old document means **any signed-in
  user**. Same fixes; higher severity.
- **judge-arena-pg is already backed up** by `cnpg-all-daily` (label-driven, no per-app work).
  The old document's "there is no backup yet" is out of date — but see blockers 1 and 2 for
  why that is thinner protection than it sounds.
- **The orphan problem is twice the recorded size**: five orphaned managed CRs, not one, and
  the `namespace`/`targetNamespace` inversion also orphans `tenant-internal/shared-apps`
  Postgres — the production database for **six** apps. There are also five *unused duplicate*
  managed DB sets burning real capacity, whose removal clears a currently-firing alert.

---

## Cluster-health baseline (the constraint "enable all of it" runs into)

Capacity is not the problem; **failure domain is**, and judge-arena is the workload that
consumed the margin.

- `KubeMemoryOvercommit` has been **firing since 2026-08-07T17:57Z — the judge-arena deploy
  window.** Its expression (total memory requests minus capacity-without-the-largest-node)
  went from −0.92 GiB of margin before the deploy to **+4.48 GiB over** now. judge-arena's own
  requests are 2.72 GiB of a 4.6 GiB swing. **Scaling web/worker to 2 (+896 Mi) is gated on
  restoring this margin first.** The shortfall is accounting, not RAM: w-kestrel requests 86%
  and uses 58%; w-caiman requests 68% and uses 36%. No hardware needed.
- **w-gharial hosts 50 single-pod workloads**, including `vmagent`, `vmalert` and
  `blackbox-exporter`. Losing that node **makes you blind to the outage you are having**, in
  the same instant. It also holds Authentik's only Postgres (the IdP judge-arena signs users
  in with) and `harbor-registry-core`. Multi-replica critical paths *are* correctly spread;
  the entire exposure is the single-pod set.
- **gharial is one physical machine** carrying two k8s nodes, the PVE hypervisor, and the
  operator workstation: 188 GiB total, 130 GiB in use, the two guest kvm processes at 95.2 and
  15.6 GiB RSS. Starting either stopped 32 GiB codebox VM takes the host to 162/188 GiB;
  starting both exceeds physical RAM.
- **judge-arena's anti-affinity keys on `kubernetes.io/hostname`, not zone** — the exact trap
  `apps/managed/workload-spread/README.md` already documents. `cp-gharial` is schedulable, so
  `web: 2` as templated buys **zero** machine redundancy. Its RabbitMQ spread is soft
  (`whenUnsatisfiable: ScheduleAnyway`) and is **not** covered by the workload-spread CronJob,
  whose RBAC is scoped to `resourceNames: [rabbitmq-bus]`.
- **LINSTOR provisionable headroom is already under its alert**: w-gharial 17.5% free,
  w-caiman 17.8%. judge-arena consumed 22.4 GiB on every data node.
- The two judge-arena components **that fail by silently blocking have zero metrics.**

---

## The tracks

Dependency order is load-bearing where stated and noted where it is not.

### T0 — Delivery path · unblocks every other track · ~1 day

Six independent lanes blocked on the same thing: **CI does not build the image.** The kaniko
step in `.gitea/workflows/ci.yml` is a `TODO(Phase 2)` stub that only echoes, so the live
`sha-ed67eb87bc2a` was hand-built. Every app-side item in T3–T7 needs an image, and the
schema-affecting ones would otherwise ship with weaker provenance than the migrations they carry.

- Wire the real kaniko spawn using `templates/gitea-workflows/build-job.yaml.tmpl` and the
  job-ops/homeview pattern. **Builds must not run on the gharial host** — it has 58 GiB free
  against two guests that have touched nearly all their assigned RAM.
- Add preflight check: local-path HelmReleases must set `reconcileStrategy: Revision`. One
  line, and the highest-value of the four new checks — the silent no-deploy it catches has
  already bitten this app once.

**Gate:** a commit to `feat/1c-deploy-readiness` produces a Harbor tag without human hands.

### T1 — Restore the node-loss budget · before any replica scaling · ~1.5 days

**The resilience arithmetic, now that "high resilience" is pinned.** The full resilience set is
`web 1→2` (+512 Mi), `worker 1→2` (+384 Mi), `CNPG instances 1→2` (+256 Mi) = **+1.125 GiB**,
against a deficit already at **−4.39 GiB**. So you need ~5.52 GiB recovered to fund resilience
*and* clear the alert, or 1.13 GiB merely not to make it worse. **Plainly: the resilience target
is not reachable without right-sizing other apps first.**

- Right-size the genuinely over-requested workloads: `tenant-video/frigate` (4096 Mi requested,
  826 Mi used → ~3.0 GiB) and `tenant-root/seaweedfs-s3` (3072 Mi requested, **49 Mi used** →
  ~2.5 GiB), plus the two `fastforward` deployments (~1.4 GiB). **Gate: the
  `KubeMemoryOvercommit` expression goes negative again.** Two hard caveats: **do not cut the
  `vmstorage` pods** — they look over-requested but are under VPA `Auto` sizing deliberately to
  peak, so cutting them fights the autoscaler and re-inflates; and two workloads are
  *under*-requested and owe ~3.1 GiB back (`curator/grobid` 2048 Mi requested / 3533 Mi used,
  `curator/embed-service` 1024 Mi / 2727 Mi). Net comfortably recoverable ≈3.8 GiB against 5.52
  needed, and it crosses three other apps' ownership — so **stage it, and expect the last
  ~1.7 GiB to need a judgment call** about which target to relax.
- **The single highest-value resilience change costs 0 MiB and is not a scaling change at all:**
  the readiness split in T3. A 30-second Redis or RabbitMQ blip 503s *every* replica
  simultaneously, so no amount of scaling addresses it. Do that before spending any memory.
- Note the storage bill on CNPG `instances: 2`: a second 10 GiB `local-3rep` PVC costs 10 GiB off
  each of three pools, taking w-gharial to ~17.03% free — it deepens a firing alert and cannot be
  undone. Worth it for the drain unblock and real failover, but it is a one-way door.
- **judge-arena is a 3-zone app, not a 4-zone one.** `local-3rep` pins pg and RabbitMQ to
  gharial/caiman/kestrel; w-wasp has no pool. So one machine loss becomes survivable and two do
  not, and that ceiling is set by the storage pool, not by anti-affinity. Also give the reaper a
  Postgres advisory-lock fallback so it tolerates Redis absence rather than needing a second Redis
  (the rate limiter, SSE bus and reaper lock all assume one shared keyspace).
- Put `vmagent`, `vmalert` and `blackbox-exporter` into a second failure domain. Everything
  else on w-gharial degrades *observably*; these three make degradation invisible.
- Change judge-arena's `topologyKey` to `topology.kubernetes.io/zone` (~30 min) and harden the
  RabbitMQ spread — either widen the spread CronJob's RBAC or set the constraint in the chart.
- Delete the five unused duplicate managed DB sets. Clears a firing alert and frees capacity.
- Record the operating rule where it binds: **do not start `codebox`/`codebox-al` while
  judge-arena is public, and do not build images on gharial.**

### T2 — Make the state survivable · before real users author anything · ~2 days

**Retention target, now that "high retention" is pinned: PITR window 14 days, RPO 5 minutes,
base-backup retention 30 days — all off-cluster in R2.** Costed: base backups ≈0.5 GB total;
WAL is the dominant term and is driven by `archive_timeout`, not traffic (an *idle* cluster
forces a 16 MiB segment every 5 min = 4.6 GB/day raw, ~1.4 GB/day gzipped), so a 14-day window
is 19–64 GB → **$0.29–0.96/month**, inside R2's free PUT tier.

**All incremental retention goes to R2; none goes to the LINSTOR pool.** Thick-provisioned
`local-3rep` charges 3 GiB per GiB *immediately*, against a pool already firing at 17.5% free on
w-gharial — and `local-3rep`/ext4 **cannot shrink**, so every on-cluster retention decision is a
one-way door.

- **Point WAL archiving at R2.** Create bucket `homelab-pg-wal` (does not exist), add
  `spec.backup.barmanObjectStore` **plus `retentionPolicy: "30d"`** to
  `apps/public/judge-arena/cnpg-cluster.yaml`, and materialise the R2 credentials into
  `tenant-public` — they currently exist only as a Secret in the `velero` namespace. Two traps:
  it must be **in-tree `spec.backup`, not `spec.plugins`** (operator 1.27.3, no barman CRD
  installed), and landing it *without* `retentionPolicy` keeps WAL in R2 forever. Add a
  `ScheduledBackup` too — WAL alone is not restorable.
- **This is a cluster-wide safeguard escape, not a judge-arena bug.** All 18 CNPG clusters
  report `ContinuousArchiving: True` with `.spec.backup` empty, because CNPG's `wal-archive`
  exits 0 when there is no object store. The healthy and broken states are byte-identical from
  the operator's side, so nothing can detect it — alert on
  `cnpg_collector_last_available_backup_timestamp` staleness instead, and write it up in the
  divergence log.
- Add a judge-arena-specific Velero schedule with a long TTL. The current effective posture is
  24h RPO / 30-day retention from one crash-consistent filesystem copy of a live datadir — not a
  `pg_backup_start`-fenced base backup, and 30 days is below "high" for rows meant to be permanent.
- **Retention by data class**, because one policy cannot serve these obligations at once, and the
  three-tier model makes the classes distinct rather than a spectrum:
  - **Published leaderboard facts** (score, benchmark, model, handle) → indefinite. A leaderboard
    that forgets is not a leaderboard, and these are the research good.
  - **Platform-granted data** → retained under the use agreement, not on the user's timetable.
    This is the class whose retention the *platform* decides, and it is therefore the class whose
    terms must say so explicitly. Its retention is not "until the user asks."
  - **User-retained private content** → deletable on request, age-capped. Nothing about a
    logging-only user's rubrics or datasets needs to survive their asking us to remove it.
  - **Account identity PII** → delete on request.
  - **Audit trail** → retain the *event* indefinitely, **redact the identifiers** (emails, IP,
    user-agent) at a fixed age and immediately on account deletion.
  - **Provider keys** → already `onDelete: Cascade`, correct.

  The distinction that matters operationally: a deletion request has three different correct
  answers depending on which class the data is in, so `deleteUserAccount` cannot be written
  against a single rule. It needs the grant record to decide.
- **Cap what grows before retention makes it permanent.** `rawResponse` and `reasoning` are
  double-stored and never truncated: ~25 KiB/judgment worst case (~420k judgments in the 10 GiB
  PV) and 50–100 KiB of *WAL* per judgment, which archiving would carry off-site forever.
  Truncate `rawResponse` at a documented ceiling with a `rawResponseTruncated` flag, and stop
  storing `reasoning` when it is a substring of it. Free now at 0 rows.
- **Retention and key custody are the same problem.** Backups hold only ciphertext, so retaining
  `ModelEndpoint` rows is worthless if `ENCRYPTION_KEY` is ever regenerated.
- **Rehearse one restore into a scratch namespace — database and `ENCRYPTION_KEY` together.**
  This is the first restore this cluster will have ever done. Write it up as
  `docs/runbooks/judge-arena-restore.md` from the rehearsal, not from theory.
- Make `decryptSafe` fail loudly on a key mismatch instead of returning ciphertext as the key.
- Guard the Flux-prune → PVC-delete → `reclaimPolicy: Delete` path.
- CNPG `instances: 1 → 2`. Also the only thing that makes `kubectl drain w-gharial` possible:
  the PDB is `minAvailable: 1` with **0 allowed disruptions** today. The network policy already
  pre-declares the replication rule; 7 of 100 connections are in use. Verify the replica lands
  in a different zone.

### T3 — Leaderboard as a real front door · the product's actual gap · ~3 days + 1 decision

Decisions A and B are **resolved** (see the data and sharing model above). This track is now
schema-led, and its internal order is fixed by the consent constraint.

**T3a — freeze, then model, then consent. In that order.**

1. **Rubric and dataset immutability.** Delete the in-place rewrite at `rubrics/[id]/route.ts:82-87`
   *and* at `config/import/route.ts:193-194`, redirect both to `createRubricVersion` pre-filled
   from the latest version, and wire the `rubric.update` audit action. Nothing downstream is sound
   until a published score's meaning cannot change.
2. `Benchmark(dataset, rubric)` with `@@unique([datasetId, rubricId])`, mirroring `GoldenSet`'s
   shape; `EvaluationRun.benchmarkId`; thread it through `run-launch.ts`.
3. `JudgeModel.ownerId` + compound slug uniqueness + scope `GET /api/models/catalog` to the
   caller. `User.handle @unique` + charset guard + reserved denylist, and the explicit
   null-handle fallback decision.
4. `EvaluationRun.executionTier`, `User.termsAcceptedAt`, and `visibility` writers plus
   `publishedAt` on `Rubric`/`Dataset`/`Benchmark` for the explicit share action.
5. `/terms`, `/privacy`, the footer moved into `layout.tsx`, the run-launch disclosure, and the
   wired account-delete route — **all before the board serves its first published row.** Extend
   `access-matrix.test.ts` with a `shared` actor dimension rather than editing the 8 never-public
   rows in place.
6. Delete `isDefault` from `projectSchema` and the import writes; drop the column in a follow-up.
   (The old roadmap's "make `isDefault` admin-only" is work this model discards — drop that item.)

**T3b — serve it.**

- Rewrite the board as **one SQL aggregation** keyed on `(user, model, benchmark)`, filtered on
  `benchmark.publishedAt IS NOT NULL AND run.executionTier = 'hosted'`.
  Today it fetches every judgment row into Node and aggregates in a `Map`, which does not survive
  a public board. Add the covering/partial indexes by hand-written SQL and follow the repo's
  documented "known migrate-diff pseudo-drift" pattern, or CI will flag drift forever.
- Add `owner {handle, name}` and `benchmark` to the leaderboard row **and to the serializer
  allow-list** — `toPublicLeaderboardEntry` is an allow-list, so fields not added there are
  silently dropped. Two of the target's four columns do not exist in the response shape today.
- Give the board **its own `/leaderboard` route**, so the cacheable JSON stops sharing a URL
  with HTML that is structurally uncacheable (per-request CSP nonce). Then edge-cache
  `/api/leaderboard` with `s-maxage` + `stale-if-error`, and **ship the "as of `lastUpdated`"
  age indicator in the same change** so a stale board is honest rather than misleading.
- Push aggregation into SQL, add the missing index on the hot predicate, drop the dead one,
  and stop passing every finalized run id back as bind parameters.
- **Split readiness:** probe Postgres only; keep Redis/RabbitMQ in the `/api/health` body and
  in per-route 503s. Give `rabbitHealthy()` its own short-lived channel so a broker rolling
  restart stops taking the front door down. Give the probe its own connection budget.
- Rate-limit the board — it calls neither `optionalAuth()` nor any limiter today.
- Bound `GET /api/datasets/[id]/export`; unauthenticated, it can OOM the 1 GiB web pod and
  take the leaderboard with it.

### T4 — BYOK without the oracle · ~1 day, de-scoped by decision C · ~1 day

**Decision C resolved 2026-08-10: endpoint configuration is admin-only on the hosted instance,
permanently. Self-hosting is the configuration escape hatch.**

**This collapses what both previous revisions called the central conflict**, and it is worth being
explicit that the conflict was an artefact of a wrong premise rather than a real tension. Both
earlier revisions assumed "bring your own model" required strangers to supply arbitrary endpoint
URLs. It does not: on the hosted instance users bring their own **key**, and endpoint URLs are
operator-configured. Someone who genuinely needs a self-hosted vLLM or a LAN Ollama runs their own
instance, where they are the admin and the network is theirs. So BYO-**key** and SSRF containment
were never actually in conflict; only BYO-**endpoint** and containment were, and BYO-endpoint is
not a hosted capability.

The practical effect: the ~3-day socket-level connect-time guard is **no longer the primary
mechanism and can be dropped from the hosted critical path.** What replaces it is a handful of
admin gates — cheap, obvious, and testable:

- **Gate every endpoint-URL write on `isAdmin`** (`src/lib/auth-guard.ts:223`). Exactly four
  user-reachable sites write the URL: `src/lib/model-catalog.ts:121`,
  `src/app/api/models/route.ts:123`, `src/app/api/config/import/route.ts:299`, and
  `src/app/api/models/[id]/route.ts:87`. (The two writes in `models/[id]/verify/route.ts` set only
  `verifiedAt`/`verificationError`, never the URL.) Note `requireScope` is a no-op for cookie
  sessions, so this must be an `isAdmin` check, not a scope.
- **Still sanitise the verify error body.** The oracle is reachable by the admin account, which
  holds every other capability, so a compromised admin session should not also be an
  arbitrary-HTTP-response-read primitive. Cheap, and independent of who can set the URL.
- **Keep the Cilium `egressDeny` as defence in depth** — it is inexpensive, it protects against
  exactly the compromised-admin case, and it corrects a chart comment that is actively wrong.
  Still stage it after the readiness split.
- **Do not build the socket-level guard for hosted.** Retain it as a documented option for anyone
  who wants to *offer* BYO-endpoint to untrusted users later; that is when it becomes necessary.

Residual risk, stated plainly: the admin account remains able to point the app at anything the pod
can reach, and the admin account is the operator's own. That is a deliberate, bounded acceptance
rather than an oversight — and it is the same trust the operator already has over the cluster.

<details><summary>Superseded approach, retained for the reasoning</summary>

The prior revision made connect-time public-IP enforcement the primary control, on the grounds
that a write-time URL check is structurally insufficient: `node-fetch` follows 20 redirects and
reuses the agent, and `PATCH /api/models/[id]` lets a verified endpoint be repointed at any time.
That reasoning is still correct **and still applies to any future BYO-endpoint-for-users
feature** — it is sound in this codebase rather than racy, because both SDKs are `node-fetch@2`
over a real Node `http.Agent` with exactly two construction sites. It is simply unnecessary while
only admins can set a URL.

- **Was primary:** connect-time public-IP enforcement at the two agent sites — reject RFC1918,
  loopback, link-local, CGNAT and ULA on the address actually connected to, surviving
  redirects and rebinding.

</details>

Still in scope, and unchanged by decision C:

- **Cilium `egressDeny`** as above (it *does* work — correct the chart's header and `values.yaml`
  while you are there). Use entities and endpoint selectors, not CIDRs, for anything in-cluster or
  on the node network. **Stage after T3's readiness split** — a mis-scoped deny fails as a silent
  packet drop, and with Redis in the readiness probe that is a total outage of the public front
  door. Rehearse in a scratch namespace. `networkPolicy.lanEgress.cidrs` (empty today) is where
  operator-declared LAN targets go.
- **Sanitise the verify error body.** Today the raw upstream body is returned verbatim,
  persisted to `verificationError`, and re-readable via `GET /api/models/[id]` — a full-read
  exfiltration primitive plus a port scanner. Replace with a shape-only message.
- Fix rate-limiter keying: flip `requireAuth()` to resolve identity *first*, then key on
  `user:<id>` — the correct pattern already exists 120 lines away in `optionalAuth()`. Apply
  `judgeLimiter` to the bulk launch path. **Do not** reach for the ingress fix here: adding
  `proxy-real-ip-cidr` changes real-IP resolution for Ghost, authentik, umami, linkwarden and
  matrix in the same instant, and the two annotations that cause the forgery are deliberately
  re-applied every 10 minutes to stop Ghost redirect loops (divergence #40). Treat the ingress
  repair as its own reviewed change with its own blast-radius pass.
- Delete the operator env-key fallback in `resolveApiKey` and the `NO_AUTH_PLACEHOLDER_KEY`
  path. BYOK is now policy, not an accident of unset env vars.
- Segment the circuit breaker by user — one BYOK user's bad key currently opens it for everyone.

### T5 — Cheap runs with a ceiling · observability strictly first · ~2 days

**Hard ordering:** the RabbitMQ scrape and alerts must land **before** any concurrency
increase. You cannot raise throughput toward a publisher-blocking watermark you cannot observe,
and the watermark is computed from a chart-injected
`total_memory_available_override_value` that GitOps cannot raise. The app-side cap is the only
lever that exists.

- `VMServiceScrape` on `:15692` for all three brokers — the prerequisite for everything below.
  **No RabbitMQ metrics exist anywhere in this cluster today.**
- Alerts, each with a stated self-clearing condition: disk-watermark alarm active; memory-
  watermark alarm active; publishers blocked; `judgment.execute` backlog sustained. **`judge.dlq`
  depth ships at `info` severity, not warning** — it has zero consumers by design, so only an
  operator clears it, and at warning severity it is a ratchet. Put the purge command in the
  annotation.
- Cap bulk enqueue: samples per run, a request body size limit (there is none anywhere), and
  `judgeLimiter` on the local-dataset path.
- `judge.dlq` needs a TTL and a max-length; truncate the persist-failure envelopes, which
  currently carry full untruncated LLM responses.
- Rubric size caps — unbounded today, and every criterion enters every judgment prompt.
- Move the two judgment retry queues from single-node classic to quorum, matching every other queue.

### T6 — Versioning that neither wedges nor eats the pool · ~2 days

- **Forbid mixed visibility inside a version family at the API boundary** (hours). Today
  `deleteUserAccount` hard-deletes private datasets with no child-version check while
  `Dataset.parentId` is `onDelete: NoAction`, so a user with v1 private and v2 public **can
  never be deleted** — and publishing v2 of a private dataset is a single unprivileged PATCH.
  The more someone uses the versioning feature, the more likely their account becomes
  permanently undeletable. `Dataset` has no `retiredAt`, so the soft-retire pattern used for
  `Rubric` needs a migration; the API guard is the cheap correct first move.
- Wrap `POST /api/config/import`'s dataset-sample replacement in a transaction.
- Give `retiredAt` a writer, so the catalog stops being append-only forever.
- `JudgeModelVersion.ordinal` is hardcoded to 1 — versioning is real for two entities and
  schema-only for the rest. Decide which entities genuinely version.
- `Rubric.visibility` has readers but no writer: rubrics can never be made public today.
- Decide where sample blobs live **before** growth, not after: `local-3rep` costs 3 GiB of
  committed pool per GiB, against a pool already under its headroom alert. Growing
  judge-arena-pg 10Gi → 100Gi would take w-gharial to 13.0% provisionable free. The
  alternative is metadata in Postgres and blobs on `nfs-bulk` (1×), which the code cannot do today.
- Add child-version guards to destructive routes so versioning stops turning ordinary deletes
  into opaque 500s.

### T7 — Obligations, then open · ~2 days

- Wire `deleteUserAccount` to `POST /api/account/delete` plus a settings affordance, and
  provision the Archive user in deploy (it exists today only as an artifact of the one-shot
  v1→v2 importer, which never ran against prod). Fix both transaction aborts first.
- Stop writing emails into `AuditLog.metadata` — the table is **already 97.6% PII** (40 of 41
  rows), all from the *unauthenticated* failed-login path, with attacker-authored IPs. Add
  retention pruning and `invitePending` expiry.
- `/privacy`, `/terms`, and **move the footer into `layout.tsx`** — it lives only on the
  landing page, so a contact link as scoped would be invisible to every signed-in user.
- Bump `next-auth` to `4.24.15` **in the lockfile** (`Dockerfile` builds with `npm ci`, so
  `package.json`'s existing caret changes nothing). Clears GHSA-x445-f3h2-j279 plus two others,
  **plus a fourth the old roadmap missed** — the transitive `uuid@8.3.2`
  (GHSA-w5hq-g745-h8pq); 4.24.15 moves it to `^11.1.1`. This must land **before** the second
  provider, not after.
- Add the GitHub provider with a verified-email `profile()` override, a provider→issuer map,
  per-provider autoprovision policy, and issuer-scoped invite claims. Note the verified-email
  gap is **not** GitHub-specific: the existing Authentik `profile()` does not check
  `email_verified` either, and that email is what invite claims match on.
- Delete `CredentialsProvider` — still live on the apex, and `authLimiter` still has **zero
  call sites**, so it is the one unthrottled auth endpoint.
- Then open sign-up.

---

## Seeding — the item that blocks the very first demo

Nothing can run: `PromptTemplate = 0`, and also `JudgeModel = JudgeModelVersion =
ModelEndpoint = Rubric = Project = Dataset = 0`. `ModelJudgment` has **never** been non-zero.
The old roadmap scoped this as "seed PromptTemplates"; the real blocker is an empty catalog
with nothing for the UI to select.

**`prisma/seed.ts` must not be run as-is.** It installs precisely what decisions 2 and 4
delete: two `CredentialsProvider` accounts with default passwords (`admin123`/`demo1234`), and
three keyless anthropic `ModelEndpoint`s that function *only* via the `ANTHROPIC_API_KEY`
operator fallback — marked `verifiedAt` so they pass `requireOwnedActiveEndpoints`.

It also cannot run in the deployed image, for **three** reasons, not the one recorded: no TS
runner, `bcryptjs` absent from the standalone tree, and no `prisma.seed` key. Bundling with
esbuild — the existing `admin-create-user.js` precedent at `Dockerfile:97` — fixes the first
two. Note that after seeding, `EvaluationRun > 0` is **not** evidence of a real run: the
seeder creates a sample run at status `pending`.

---

## Conflicts register

Kept explicit, because each is a place where serving one north star costs the other and a
future reader will otherwise re-litigate it.

| Conflict | The honest tradeoff |
|---|---|
| BYOK vs. containment | Any user-supplied endpoint is an unvetted destination dialled from a pod holding `ENCRYPTION_KEY`, `NEXTAUTH_SECRET`, `PG_URI` and more. Keeping the feature means the boundary is code plus a Cilium deny you must maintain. The allowlist removes the risk by removing the feature — coherent, and rejected only because the feature is pinned. |
| Shared catalog vs. hygiene | A shared catalog is required for comparable rankings and is exactly what has no owner. `JudgeModel.slug` is globally unique and collisions mint a **new** model, so N users configuring `gpt-4o` produce N leaderboard identities with no merge path. Per-user scoping fixes hygiene and destroys comparability. |
| Edge cache vs. CSP nonce | The front-page HTML is structurally uncacheable (per-request nonce). Caching `/` shares one nonce across viewers, making nonce-CSP worthless. Resolution: keep the nonce, split the route, cache only the JSON. |
| Cache freshness vs. liveness | `s-maxage=60` delays a new judgment by up to a minute; `stale-if-error` can show day-old data during a Postgres outage with no visual cue. Ship the age indicator *with* the header. |
| Error sanitisation vs. BYOK support | The upstream body is the single most useful signal when a user's self-hosted server is misconfigured. Sanitising it moves that cost onto the operator, per support case. |
| Cilium deny vs. availability | The strongest containment control is also the change most capable of a total outage. Sequence it after the readiness split; rehearse it. |
| Ingress repair vs. blast radius | The two annotations causing rate-limit forgery are deliberately enforced to stop Ghost redirect loops. Fixing real-IP resolution touches five unrelated public apps at once. There is no judge-arena-scoped version at the ingress layer. |
| Orphan adoption vs. coupling | Adopting the orphaned managed CRs is right for backend-state, but the `managed` Kustomization is `wait: true` — the naive fix couples six apps' production Postgres to harbor's and seaweedfs's health. Use a separate Kustomization with `prune: false`. |
| DLQ alert vs. alert hygiene | `judge.dlq` has no consumer by design, so only an operator clears it. It must ship at `info`, despite representing lost judgments. |
| High retention vs. interpretability | Retaining a score forever is only meaningful if its rubric cannot drift. Today a rubric can be rewritten in place after publication, so high retention would preserve numbers that can no longer be interpreted. Retention *requires* the freeze; they are one change, not two. |
| Compute-for-rights vs. an honest exit | The bargain only stays fair while self-hosting is genuinely viable, so self-hosting stops being a nice-to-have and becomes load-bearing for the *ethics* of the platform tier, not just its architecture. That is a permanent maintenance obligation: every hosted-only coupling added later quietly narrows the user's alternative to consenting. |
| Lossless portability vs. every future column | The guarantee is easy to state and decays silently — each new user-ownable column can break it while the existing round-trip test still passes, because that test proves idempotency rather than fidelity. The cost of keeping the promise is a coverage assertion that fails on every new column until someone classifies it, which is friction on purpose. |
| Portability vs. the subset rule | Import must be a subset of what the user could do in the UI, yet a config exported from hosted must apply *more* fully on self-hosted, where the importer is the admin. Both are correct, so validation has to be role-aware per instance rather than one fixed schema — more code than a single Zod parse, and the place a mistake would silently re-open the endpoint-write hole. |
| A verified board vs. an open one | Letting self-hosted instances publish scores is what makes "retain your data, publish only results" real — and it admits numbers we did not compute. Mixing verified and self-reported rows without labelling them makes the research good less trustworthy than a smaller closed board would be. The resolution is a visible badge and a verified-only filter, not exclusion. |
| High resilience vs. the memory budget | The resilience set costs +1.125 GiB against a −4.39 GiB deficit, and the recoverable slack (~3.8 GiB net) sits in three other apps. Full resilience is not self-funding; the last ~1.7 GiB needs a relaxed target or someone else's app right-sized. |
| Private-by-default vs. a shared catalog surface | `GET /api/models/catalog` publishes every user's custom judge names and `baseModel` strings to every other user. Per-account vendoring makes that a privacy defect rather than a quirk, and scoping it is part of the same migration. |
| Spread vs. somewhere to spread to | w-gharial has 49 GiB of request headroom; w-kestrel has 3.5 GiB and cp-caiman 1.75 GiB. The scheduler will keep concentrating judge-arena on the node whose loss the cluster cannot absorb. Spreading requires right-sizing first. |

---

## Decisions required

**A. Leaderboard tenancy — RESOLVED 2026-08-09.** Benchmark-keyed board, not a curated project.
The single-project design is deleted rather than patched.

**B. Catalog ownership — RESOLVED 2026-08-09.** Per-account vendoring (`userX-gpt4o` ≠
`userY-gpt4o`). This lands better than the admin-curated option originally recommended here:
comparability comes from the benchmark axis while attribution comes from the user column, so no
globally-merged catalog is needed — and the owner column is what finally lets account deletion
clean up catalog rows.

**D. Retention — RESOLVED 2026-08-09.** High retention, so WAL archiving lands before users, and
all incremental retention goes to R2 rather than the pool.

**C. Endpoint configuration — RESOLVED 2026-08-10.** Admin-only on the hosted instance,
permanently; self-hosting is the configuration escape hatch. On the public instance a user can
only upload and change what is user-configurable. This de-scopes T4 from ~3 days to ~1 (see T4),
because BYO-**key** and containment were never in conflict — only BYO-**endpoint** was, and that
is not a hosted capability.

### Open questions the sharing model raises

Each is cheap to answer now and expensive after rows exist.

1. **RESOLVED 2026-08-10 — user-as-org is sufficient for v1.** One `User.handle @unique` namespace;
   no Organization/Team entity. A real Org later can claim a handle from the same table, and the
   owner-polymorphism work across ~9 `userId` foreign keys stays deferred.
2. **RESOLVED 2026-08-10 — score, benchmark and model only.** Custom data never becomes public; it
   becomes *platform-granted*, which is a different tier. The proprietary-data hazard raised in the
   previous revision is dissolved by that distinction rather than mitigated: the exposure is to the
   platform under an agreement the user accepted, not to the world. No per-dataset "not
   publishable" flag is needed, because nothing publishes a dataset except benchmark publication.
3. **RESOLVED 2026-08-10 by implication of the four-state model — no row.** Candidacy requires a
   *published* benchmark, and benchmarks are admin-published, so a hosted run against anything else
   is platform-granted and private. Recorded as an inference rather than an explicit ruling: say so
   if you meant otherwise. It usefully means a user can spend hosted compute and appear nowhere, and
   the terms should state that plainly rather than leave it to be inferred.
4. **RESOLVED 2026-08-10 — the grant survives account deletion, and data deletion is a separate
   request on top of it.** Two independent concepts, and the mechanics are in "Deletion is two
   requests" above.
5. **RESOLVED 2026-08-10 — admin-only.** Benchmarks are created and published by an admin; user
   proposition is deferred. A later update seeds the standard benchmark set (JudgeBench, RankJudge).
   Note the taxonomy correction: **PPI and the coin-flip floor are per-run measurements, not
   benchmarks** — they live in Roadmap A's A3, so `Benchmark` is strictly a `(dataset, rubric)` pair.
6. **RESOLVED 2026-08-10 — no.** Settled by the owner's statement that the only things published
   are the score, the benchmark and the model. `reasoning`, `rawResponse` and `criteriaScores` stay
   owner-only with no public serializer, and the terms say so.
7. **RESOLVED 2026-08-10 — no.** Human judgements are not part of the final score. Note this is
   also a category correction: `HumanJudgment` is `runId @unique` (one per run) and so is not
   attributable to a specific judge model version, whereas `ModelJudgment` is per (run, model).
   Human input surfaces instead as **human agreement** in Roadmap A, via `GoldenLabel` — a
   different and more useful axis, and the one `kappa` was designed for.
8. **RESOLVED 2026-08-10 — both.** Exports carry results history *and* configuration. That widens
   the lossless guarantee rather than adding a side-channel, with two consequences to plan for:
   volume (results run ~25 KiB/judgment, so the export needs streaming or pagination rather than a
   buffered response — the same failure mode as the unauthenticated dataset export), and the
   coverage assertion in `tests/db/config-roundtrip-fidelity.test.ts` must grow to cover
   `Evaluation`, `EvaluationRun`, `ModelJudgment` and `HumanJudgment`, all of which are currently
   unclassified because nothing exports them yet.
9. **RESOLVED 2026-08-10 — never published.** `Rubric.contentHash` is admin-internal and
   instance-specific, not displayed. The confirmation-oracle risk is therefore closed by
   construction. One knock-on: it cannot serve as the cross-instance verification token for
   self-hosted score submissions, because two instances will not agree on it — that needs a
   separately published canonical digest computed by a documented, unsalted algorithm. Recorded in
   Roadmap B's B4.

**Also worth an explicit call:** whether to ship the interim provider-host allowlist at all.
It is code written to be deleted by T4, and its only justification is closing a live blocker
while T0 lands. Given that exactly one account exists and `ALLOW_OIDC_AUTOPROVISION` is not
set on the live Deployment, *recommendation: skip the interim and do T0 first.*

---

## Status rebaseline of the 08-07 decisions

| # | Old decision | Now |
|---|---|---|
| 1 | GitHub only | **Stands.** Unchanged reasoning. |
| 2 | BYOK only; delete the fallback | **Stands, and promoted** from security fix to product policy. |
| 3 | Capped beta of 10–20, then open | **Superseded by intent** — "enable all of it." The gate is T3–T5 landing, not an invite count. |
| 4 | Delete `CredentialsProvider` | **Stands.** Also delete it from `prisma/seed.ts`. |
| 5 | Keep reassign-to-Archive | **Stands**, but it is unreachable until T7 wires a route and provisions the Archive user. |
| 6 | Degrade, not fail | **Stands, and elevated to a blocker** — it now gates the product's front door. |
| 7 | Accept a 24h RPO | **Flipped.** See decision D. |

---

## Deliberately not doing

Carried forward from 08-07 and still declined: Auth.js v5, credentials registration with
email verification, public enrollment in the homelab Authentik, content moderation
infrastructure, PgBouncer, `next@16`, app-level Prometheus instrumentation, provider account
linking, an off-cluster status page.

Newly declined here:

- **Per-user cost accounting.** There is no token or cost accounting of any kind — "cheap" is
  whatever `baseModel` string the user typed. BYOK makes spend the user's problem, which is
  the point. Revisit only if the operator ever funds inference.
- **Moving verify off the web pod** into enqueue-then-poll. It is the correct end state and
  removes the last path where `judge-arena-web` dials a user-controlled address, but it costs
  ~1 extra day plus a UI change and lands on the exact flow a new BYOK user hits first. The
  socket guard plus the Cilium deny reduces the residual enough to defer.
- **Repairing the shared ingress real-IP configuration** as part of this program. Correct, but
  it is a cluster-wide change to five unrelated apps and belongs in its own review.
- **Blob storage abstraction for dataset samples.** Needed if versioning grows past the pool's
  headroom; not needed at 0 rows. Named in T6 as a decision point, not built.
