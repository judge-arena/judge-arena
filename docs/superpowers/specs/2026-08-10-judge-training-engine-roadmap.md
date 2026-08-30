# Roadmap A: the judge training engine

**Date:** 2026-08-10 · **Last verified against the live cluster:** **2026-08-29**
**Status:** **A0, A1 and A1.5 are DONE, merged (PR #13) and DEPLOYED** — production ran
`sha-bee1d121ea7d` at 18 migrations from 2026-08-17, and runs **`sha-14d75f7d46de`** from
**2026-08-30 01:47Z** (`kubectl -n tenant-public get deploy judge-arena-web -o
jsonpath='{.spec.template.spec.containers[*].image}'`; still 18 migrations — `14d75f7` ships no
migration). Preflight cleared, DB-backed CI live.
**A1.5 grew its assignment surface on 2026-08-29**: `feat/assignment-ui-and-random-subset`
(`0309a7e`) plus a fixes commit (`ded6e1f`) merged to `gitea/main` as **`14d75f7`**. No migration.
**What still stands between here and A2 is real label data**, of which there is still none — but
the reason this header used to give was wrong.

> **CORRECTION 2026-08-29 — the false zero.** This header read: *"prod holds **0 golden sets**, so
> the catalog must be seeded and actually annotated."* The seeding half has been done since
> **2026-08-19 13:44**. Verified against `judge_arena` on prod: **2 `GoldenSet`** ("JudgeBench
> pairwise — full", 620 items; "JudgeBenchSample — 30 random", 30 items), **650 `GoldenItem`**,
> **1300 `GoldenCandidate`** and **2 `GoldenAssignment`** rows — both whole-set, both self-assigned
> by the owner in the same breath as the sets were created — set 1 at 13:44:04.753, assigned
> 13:44:04.995; set 2 at 13:44:05.028, assigned 13:44:05.07, so a **242 ms** and a **42 ms** gap,
> not the sub-100 ms an earlier revision of this line claimed (read from `GoldenSet.createdAt` and
> `GoldenAssignment.assignedAt`) — neither revoked, neither completed. The zero
> that is real is **`GoldenLabel` = 0**, ten days later.
>
> So neither the catalog nor the surface is the gap: **the identity the owner signs in with today
> cannot reach that account.** (Stated that way on purpose — somebody plainly *did* have a
> working session on 2026-08-19, or these rows would not exist. What is refused is every
> sign-in attempt on the `trijeet` Authentik identity. See the audit-table note below.) That
> distinction is worth the paragraph, because "seed and curate a golden set" and "repoint one
> `oidcSubject`" are different days of work, and this header pointed at the first. See
> **"The real blocker on the first label"** below.

That plus **T5**, which is **~5% done with its first item untouched** — an earlier version of this
line said "untouched" flat; see the re-measure under blocker 7. The path is
`2026-08-17-integration-release-and-a2-roadmap.md`.
Owner decisions **#3 and #6 were settled 2026-08-12** (weighted kappa with the threshold stored as
data; golden sets immutable once a `CalibrationRun` references them); **#4 and #7 remain open** and
are settled when A2 is specced. **#5** (cross-user annotation) has its mechanism built by A1, a **UI
as of `14d75f7`**, and waits only on a second annotator account.
**Scope:** labelling, entry, human verification, and distillation — everything whose purpose is
**producing a stronger judge.**
**Sibling:** `2026-08-10-benchmark-sharing-roadmap.md` (Roadmap B) measures and publishes the
judge this roadmap produces.
**Platform foundation:** `2026-08-08-north-star-rebaseline-design.md` — the data tiers, retention,
resilience and cluster constraints all roadmaps inherit.

---

## The one thing to know before reading further

**This half of the product is fully modelled in the schema and has zero lines of code.**

> **THAT SENTENCE IS DATED 2026-08-10 AND IS NO LONGER TRUE. Read this section as the starting
> position, not the current one** — it is kept because the argument it makes still governs A2, and
> because deleting it would erase what the phases were built against. As of `14d75f7` (2026-08-29),
> **17 files under `src/app/api/` reference `goldenSet` or `goldenLabel`** — the whole
> `/api/golden-sets/**` tree, including `queue`, `agreement`, `disagreements`, `assignments`,
> `items/[itemId]/labels`, `fork` and `retire` — plus UI routes under `src/app/golden-sets/**` and
> the studio components. Decision #6's freeze guard is real code
> (`src/lib/golden-sets.ts:270`, `calibrationRun.count({ where: { goldenSetId } }) > 0`), and
> `retiredAt` has a writer.
>
> **One clause of it survives, and it is exactly A2's scope: `CalibrationRun` still has no
> producer at all.** `grep -rn "calibrationRun\|CalibrationRun" src/ prisma/*.ts prisma/schema.prisma`
> returns only reads (`tx.calibrationRun.count` in the freeze guard), relation declarations and
> comments — no `.create` anywhere. So the "zero lines of code" claim, narrowed to the
> calibration half, is still accurate.
>
> **CORRECTION 2026-08-30 — an earlier revision of this note also claimed `trustState` "still has
> zero writers … written nowhere". That is false, and the false version was the more dangerous
> one.** `prisma/seed-core.ts:192` writes `trustState: 'trusted'` on the `judgeModelVersion`
> catalog upsert — added 2026-08-11 in `ed4ce67`, i.e. the day *after* the 2026-08-10 sentence
> above was true. The consequence is live and worth stating plainly: prod holds **3
> `JudgeModelVersion` rows and all 3 read `trustState = 'trusted'`**
> (`select "trustState", count(*) from "JudgeModelVersion" group by 1` → `trusted|3`), with
> `CalibrationRun` at 0. Nothing has ever been calibrated; the seeder's own comment says so
> ("a claim about the catalog entry, not about any calibration that has happened"). What A2
> actually gives `trustState` is its first *transition* — the `untrusted → calibrating →
> trusted|rejected` lifecycle — not its first write. It is read at
> `src/app/api/models/catalog/route.ts:46` and typed at
> `src/components/models/model-config-form.tsx:15`.

Five models already exist and describe the entire loop: `GoldenSet` → `GoldenItem` →
`GoldenLabel` → `CalibrationRun` → `JudgeModelVersion.trustState`. `CalibrationRun` already
declares the metrics that matter — `kappa`, `rawAgreement`, `testRetest`, `positionBias`,
`biasSensitivityRate`, `flipRateVsParent`, `verdictCount`, `passed`. `TrustState` already has the
lifecycle: `untrusted → calibrating → trusted → rejected`.

And: **no API route in the codebase references `goldenSet`, `goldenLabel` or `calibrationRun`.**
The only file that mentions calibration at all is `src/lib/account-deletion.ts`, and only to
respect an FK. There is no UI route for labelling, verification or calibration. `trustState` has
zero writers, exactly like `retiredAt`.

So this roadmap is **not** greenfield design. It is implementing a data model somebody already
thought carefully about — which means the first job is to *validate or amend that model*, not to
invent a replacement. Two pieces of evidence that it was thought through:

- `GoldenLabel` is `@@unique([goldenItemId, annotatorId])` — one label per annotator per item.
  That constraint only exists if the intent was **inter-annotator agreement**, which is what
  `kappa` needs.
- `testRetest` is a column. Inter-annotator agreement is impossible with one annotator, and
  test-retest (the same annotator, twice, blind) is the correct single-annotator proxy. The schema
  anticipated launching with one human.

---

## The boundary that shapes everything: everything is an API call

**Owner stance, 2026-08-10: nothing runs in cluster. All model traffic is simulated via API.** The
owner spins models up behind an API, judge-arena judges them, and the results are entered as
product data — **dogfooding is the first data source**, not a later validation step.

This is corroborated by hardware rather than merely permitted by it: **zero GPU allocatable on all
seven nodes** (every node carries the `extensions.talos.dev/amdgpu` label, allocatable GPU is
`none`). So the stance and the constraint agree, which is the comfortable case — but the stance is
the reason, and it would hold even with a GPU.

**Consequences that shape the whole roadmap:**

- **The platform cannot train, fine-tune or distil.** It produces labelled data, a training-set
  export, and a verdict on the model that comes back. "Distillation" here means *export → train
  elsewhere → register the returned model → re-measure*. State that in product copy rather than
  letting a user go looking for a Train button.
- **Cost, latency and reliability are first-class**, not incidental telemetry — they are the
  owner's stated primary axes for choosing a judge framework. If every judge is reached over an API,
  cost-to-serve is a property of the judge under test. A judge that is 2% better and 5× slower is a
  different product decision from one that is 2% better and free, and neither is visible from a
  score. `ModelJudgment` already models `latencyMs`, `tokenCount`, `inputTokens`, `outputTokens` and
  `attemptCount`, so the substrate largely exists; **no price table does**, which is the one real gap
  for cost. Detail in A3.
- **Dogfooding is the seed corpus.** The owner's own API-served models generate the first runs, so
  the labelling and measurement surfaces must be usable by one person on their own data before they
  are usable by strangers. That is a sequencing gift: A0–A3 are all exercisable solo.

What the platform produces, restated:

1. **Labelled data** — a golden set with multi-annotator human labels and a measured agreement
   floor. The expensive, defensible artifact.
2. **A measurement bundle per run** — quality *and* cost, with a chance floor and a real-gain
   estimate (A3).
3. **A training-set export** — that data in a form a fine-tuning run elsewhere can consume.
4. **A verdict** — whether the model that came back is actually better than the one that went in.

*If in-house training is ever wanted, it is a hardware decision first and a roadmap item second —
and note the cluster currently cannot absorb the loss of its largest node (rebaseline T1), so a GPU
worker arrives with a failure-domain conversation attached.*

---

## Before you start: what is actually missing

Asked directly by the owner 2026-08-10 — with the llama.cpp dev server standing up, what blocks
building Roadmap A end to end? Everything below is verified, not inferred.

> **Re-verified end to end 2026-08-12.** Five of the original blockers are cleared and are struck
> through below with what closed them. Three items that were *not* on this list turned out to matter
> more than some that were — they are in "Blockers nobody had written down". Every claim here was
> re-checked against the live cluster and the current tree on that date, not carried forward from
> the 08-10 pass; where a number is quoted it was measured again.

### Status at a glance (2026-08-12, phase status updated 2026-08-16)

> **Naming collision — RESOLVED 2026-08-16, and `A0…A5` now belongs to this roadmap alone.** The
> dataset-lifecycle plans used to be labelled `A1`/`A2` for something else entirely; they are now
> **`L1`** (the tombstone overlay, complete) and **`L2`** (the revision log, not started), in
> `specs/2026-08-14-dataset-lifecycle-and-tombstone-overlay-design.md`. This roadmap's A1 is *human
> verification* (**done and deployed 2026-08-17**) and its A2 is *the calibration engine* (not
> begun). Note that lifecycle
> commit prefixes (`feat(a1):`), `(A1)` comments in `src/`, and the applied `v2f` migration header
> keep the old letters and cannot be changed — so **`(A1)` in code means L1, never this roadmap's
> A1.** See `plans/2026-08-16-l1-complete-l2-handoff.md` §0.

| | Item | State |
|---|---|---|
| 1 | CI builds the image | **done** — Gitea CI runs lint/typecheck/tests/build, kaniko pushes to Harbor. (The "367 tests" this row used to quote was the 2026-08-12 unit figure; at `1ee28df` it is 493 unit / 522 db / 80 integration. Re-measure rather than quoting a number here.) |
| 2 | Seeder | **done** — bundled to `/app/seed.js`, BYOK-safe, idempotent |
| 3 | `llamacpp` descriptor | **done** — merged, verified against the live server |
| 8 | WAL archiving + rehearsed restore (T2) | **done** — 6/6 exit gate verified, RTO measured |
| 9 | `lanEgress` declares the dev endpoint | **done** |
| — | CI cannot run the DB or integration suites | **done 2026-08-12** — ephemeral Job with service sidecars; 286 DB + 74 integration tests green in CI, `build-push` gates on it |
| 7 | RabbitMQ scrape/alerts/cap (T5) | **OPEN — gates A2 (this roadmap's A2, the calibration engine — not the lifecycle plan, which is now L2)** |
| 4,5,6 | `startedAt`, format-compliance, token rollup | OPEN — needed during A |
| — | **A1** | **done 2026-08-17** — `4ff04f4`…`eef73fb` on `feat/a0-golden-set-substrate`. `GoldenLabel` has its first writer; `v2h` adds the item revision log, assignment rows, `round` and `preference`. Exit gate met on all four clauses. Suites 533 unit / 633 db / 80 integration |
| — | **A1.5** | **done 2026-08-17** — `133cc12`…`05bf29b`. The composable panel shell A2 and A3 also consume, plus A1's labelling view as its first composition. Every rule that can be silently wrong lives in `src/lib/studio/**` (100% statements) because this repo has no jsdom; `src/components/studio/**` is verified by `docs/runbooks/studio-manual-verification.md`, whose 12 rows were walked in a browser. **Extended 2026-08-29 by `14d75f7`:** the assignment panel on `/golden-sets/<id>` (Assign to me / Revoke / a shortcut into the studio), a `toPublicOwner` projection returning `{id,name}` and never the email (null for a deleted account), and server-side random subset selection (`randomCount`/`randomPercent`) in `src/lib/sample-selection.ts`. The runbook is now **18 rows, not 12**; rows 14/16/17/18 were walked in a browser on 2026-08-29 |
| — | **A2** | **decisions recorded** (`2026-08-17-a2-calibration-and-reporting-decisions.md`), deliberately not specced — its design takes A1's real label data as an input, and **no real labels exist yet**. Path to it: `2026-08-17-integration-release-and-a2-roadmap.md` |
| — | **Merge, promote, migrate** | **DONE 2026-08-17.** PR #13 merged as `bee1d12`; prod promoted off its pre-A0 image to `sha-bee1d121ea7d`; all 5 pending migrations applied, 0 unfinished. **Seed is DONE** and **end-to-end is PARTIALLY EXECUTED, not un-started** — an earlier version of this row said "prod still holds 0 golden sets", which stopped being true on 2026-08-19. Steps 1–3 (sign in, create a set, assign it) ran that day; step 4 (label the items) has produced **0 `GoldenLabel`** because sign-in is now refused. See `2026-08-17-integration-release-and-a2-roadmap.md` and "The real blocker on the first label" below |
| — | Capturing `reasoning_content` | **OPEN, backlogged.** Chain-of-thought is discarded on every model call, so the studio's reasoning panel is structurally thin until it lands |
| 11 | Golden sets absent from round-trip coverage | **done 2026-08-13** — A0's exit gate; classified in the `COVERAGE` map at `tests/db/config-roundtrip-fidelity.test.ts` |

### The real blocker on the first label (found 2026-08-29)

**It is an identity mismatch, and it was on no list in this document.** The judge-arena `User` row
that owns both golden sets and holds both assignments (`cmsj951c30000881a4l63sx4b`,
trijeet@protonmail.com, role admin) carries `oidcSubject = 26f57dc2-77b6-455b-a939-d897dbdad6ee`.
Authentik has **two accounts on that email**: `akadmin` (uuid `26f57dc2-…`) and `trijeet` (uuid
`e8b087cc-b38b-492a-bbb3-b34bdfb50c16`). The judge-arena OAuth2 provider's `sub_mode` is
`user_uuid`, so `sub` **is** the uuid. The 2026-08-07 invite-claim happened while signed in as
**akadmin**; every attempt since has been as **trijeet**, whose sub matches nothing. `resolveOidcUser`
falls to branch 3, `ALLOW_OIDC_AUTOPROVISION` is absent from the deployment env, and sign-in is
**refused**.

That is a matched pair of records rather than an inference: three authentik
`authorize_application|trijeet` events (2026-08-18 21:33:35, 2026-08-19 13:41:28, 13:41:32) are each
followed within a second by a judge_arena `AuditLog` row
`user.login.failed {"method":"oidc","reason":"no_match_autoprovision_disabled"}`. **No successful
`user.login` has ever been written to that table.** Credentials fallback cannot rescue it either: the
row's `passwordHash` is `!oidc-managed`, and `findCredentialsUserByEmail` excludes `!`-prefixed
hashes by design.

> **Read that last sentence precisely — added 2026-08-30, because the short version over-claims.**
> The whole `AuditLog` table is two actions:
> `user.invite_claimed` × 1 (2026-08-07 19:21:17) and `user.login.failed` × 44 (2026-08-07
> 19:33:55 → 2026-08-19 13:41:33). Two things follow that "no `user.login` row" alone does not
> say. (a) **A successful OIDC sign-in does not always write `user.login`**: `src/lib/auth.ts:157-161`
> writes `user.invite_claimed` when the pass claims an invite and `user.register` when it
> autoprovisions, so the one sign-in we know succeeded is in the table under a different name.
> Absence of `user.login` is evidence about *repeat* sign-ins, not about sign-in as such.
> (b) **Something authenticated on 2026-08-19**: the sets were created at 13:44:04, three minutes
> after the last recorded failure, with no successful sign-in audited that day at all. The
> session config (`src/lib/auth.ts:58`, JWT `maxAge` 24h with `updateAge` 1h) rolls a live
> session forward on activity, so a long-lived akadmin session is a mechanism that fits — but
> that is a hypothesis, not a checked fact, and nothing in the audit trail settles it. **None of
> this changes the prescription**: the `oidcSubject` on the owning row points at `akadmin`, the
> identity in use is `trijeet`, and repointing it is still one row.

- **Fastest path, no mutation:** sign in to Authentik as **`akadmin`** (private window, or log out of
  the `trijeet` SSO session first). That sub matches, and akadmin is in `users-primary` — the single
  enabled policy binding on the judge-arena application.
- **Durable fix — one row, and an admin decision:**
  `UPDATE "User" SET "oidcSubject"='e8b087cc-b38b-492a-bbb3-b34bdfb50c16' WHERE id='cmsj951c30000881a4l63sx4b';`
  or consolidate the duplicate Authentik accounts.
- **Do NOT issue a fresh CLI invite and do NOT enable `ALLOW_OIDC_AUTOPROVISION`.** Both mint a
  **second, empty** `User` row that owns nothing, and the queue would hard-403 it on both sets. The
  email partial unique index (`UNIQUE (email) WHERE passwordHash NOT LIKE '!%'`) does not prevent it.

**Two further things block a clean first label, and the assignment UI fixed neither.**

1. **There is no agreement panel.** `GET /api/golden-sets/[id]/agreement` exists and works, but
   nothing under `src/app/**` or `src/components/**` ever calls it — the only "Agreement" on screen
   is a hard-coded, permanently-empty progression-rail stage at
   `src/app/golden-sets/[id]/label/page.tsx:87`. A1's exit gate is met **at the API**; the phase's
   reporting surface is **missing**, which is a different defect from a wrong number and is not
   visible from the exit gate. Workaround until it is built: point the signed-in tab straight at
   `/api/golden-sets/<id>/agreement` and read the JSON.
2. **Every production `GoldenCandidate` has `label IS NULL`** — 1300 of 1300, because `toCandidate()`
   at `src/lib/golden-sets.ts:180` hard-codes `label: null`. The studio then renders
   `candidate.label ?? 'Option ' + (position + 1)` while the verdict control asks for `A>B` / `tie` /
   `B>A`, so **nothing on screen says Option 1 is A.** The mapping *is* deterministic in code
   (`toCandidate(0, responseA)`, `toCandidate(1, responseB)`, and the queue orders by `position asc`)
   — but the annotator cannot see it, and guessing it the other way inverts every preference in the
   session **silently**. Fix this before the first labelling run rather than after: a session
   labelled under the wrong assumption is indistinguishable, from the data alone, from a correct one.

### The dev endpoint: live, reachable, and missing a descriptor

**`http://192.168.1.164:8001` is up**, serving `Qwen3.6-35B-A3B-UD-Q3_K_XL.gguf` with an
OpenAI-compatible response shape, and it is **reachable from inside the cluster** — verified HTTP 200
from both the judge-arena web pod and the worker pod.

**But no backend descriptor fits it.** `src/lib/llm/registry.ts` declares exactly five — `anthropic`,
`openai`, `openrouter`, `vllm`, `ollama` — and llama.cpp is none of them:

- Registering it as **`openai`** works for transport but that descriptor declares
  `caps.structuredOutput: 'none'`, so judgments fall back to parsing free text. That weakens every
  verdict *and* makes the format-compliance reliability component meaningless before it is built.
- Registering it as **`vllm`** claims `structuredOutput: 'guided'`, but that path emits vLLM's
  `guided_json` field. llama.cpp implements constrained output via `json_schema`/GBNF instead, so the
  request would be wrong rather than merely unsupported.

**So a `llamacpp` descriptor is a small blocking piece** — right transport, right structured-output
mechanism, declared caps that the reliability metric can trust.

> **CLEARED 2026-08-11.** `src/lib/llm/backends/llamacpp.ts` + registry entry, merged to main.
> `response_format: {type: 'json_schema', strict: true}` was verified against the live server rather
> than assumed, so `caps.structuredOutput` is `'json_schema'` and the backend emits `response_format`
> ONLY — never `guided_json`. `scoredRunsAllowed: true`, deliberately unlike the adjacent `ollama`
> descriptor, because llama.cpp *can* constrain output and endpoint writes are admin-gated. The
> load-bearing test asserts llamacpp never emits `guided_json` and differs from the vllm fields in
> exactly that key — the only thing that would catch a well-meaning "both are OpenAI-compatible,
> share the helper" refactor, since neither mistake throws.
>
> Ships an enum migration (`20260810180000_v2c_llamacpp_backend`). **It is not applied to prod yet**
> — prod sits at 12 of 13 migrations. It lands with the deploy described below.

### Hard blockers, in the order they bite

1. ~~**CI does not build the image** (rebaseline T0).~~ **CLEARED 2026-08-11.** Gitea CI now runs
   lint, `tsc --noEmit`, the 367-test unit suite behind a coverage gate, and `next build` on every
   push/PR; a push to main spawns a kaniko Job in `tenant-builds` that pushes
   `harbor.cluster.asethi.com/homelab/judge-arena:sha-<12>` + `:latest`.

   **It had never run at all** — not "ran and was incomplete". The workflow died at `Setup Node` on
   every invocation because the runner image had no `libstdc++`, so a red step that read like a flaky
   download actually meant zero lint and zero tests. Clearing it took four runner-side fixes, none of
   them patchable from inside a workflow: `libstdc++`/`libgcc`; a 1Gi memory limit that capped V8's
   heap at ~512Mi; a 256Mi `home` emptyDir that **evicted the pod** instead of returning ENOSPC; and
   the act work-dir sitting on a 5Gi `local-3rep` PVC. See homelab-setup divergence entries 61–64.

2. ~~**The database is empty and the seeder cannot be used.**~~ **SEEDER CLEARED 2026-08-11 — the
   empty database is NOT.** `prisma/seed.ts` is now a thin entry over `seed-core.ts`, esbuild-bundled
   to `/app/seed.js` so it runs in-image, and it no longer installs what decisions 2 and 4 delete:
   no credentials accounts, no `ModelEndpoint`s at all (BYOK), no sample run. Public artifacts are
   owned by a non-login `platform@judgearena.local`. Everything is idempotent, and five DB tests
   guard the removals so they cannot quietly return.

   **But nothing has run it.** Verified on prod 2026-08-12: `PromptTemplate`, `JudgeModel`,
   `ModelEndpoint`, `Dataset`, `GoldenSet` are **all still 0**, `User` is 1, migrations 12 of 13, and
   the deployment still runs `sha-ed67eb87bc2a` while `sha-70fce84bee11` sits in Harbor. See
   "The two commands" below.

   > **UPDATE 2026-08-29 — the 2026-08-12 snapshot above is left exactly as written, because it was
   > true that day.** Re-verified against `judge_arena` on prod today: migrations are **18 of 18**
   > with 0 unfinished (latest `20260818120000_v2h_human_verification`); `Dataset` is **2** with 620
   > `DatasetSample`; `PromptTemplate` is **2**; `GoldenSet` is **2** with 650 `GoldenItem` and 1300
   > `GoldenCandidate`; `User` is **2**. The seeder has run.
   >
   > **Image, corrected 2026-08-30.** When this block was first written the deployment still ran
   > `sha-bee1d121ea7d` with a promote to the `14d75f7` build *in flight*. That promote has
   > **landed**: both `judge-arena-web` and `judge-arena-worker` now run
   > `harbor.cluster.asethi.com/homelab/judge-arena:sha-14d75f7d46de`, pods created
   > `2026-08-30T01:47:21Z`, `rollout status` reports successfully rolled out. Migration count is
   > unchanged at 18/18 because `14d75f7` ships no migration.
   >
   > **`User` is 2 and the annotator count is still 1.** The second row is the seeder's non-login
   > service principal `platform@judgearena.local`, created with
   > `passwordHash: '!platform-system-user'` (`prisma/seed-core.ts:69-75`) — an `!`-prefixed hash,
   > which `findCredentialsUserByEmail` excludes, so it can neither sign in nor annotate. Do not read
   > that row as "a second annotator exists".

3. ~~**The `llamacpp` descriptor.**~~ **CLEARED 2026-08-11**, above.

### The two commands between here and A0

Everything above is built and merged. Nothing has been deployed. A0 cannot begin against an empty
catalog, and the gap is two deliberate manual steps:

```bash
# 1. homelab-setup — apps/public/judge-arena/helmrelease.yaml (~line 153)
#    tag: "sha-ed67eb87bc2a"  ->  tag: "sha-70fce84bee11"
#    This also applies migration 13/13 (the llamacpp enum) via the chart's
#    pre-install/pre-upgrade migrate hook.

# 2. after it rolls out — idempotent and safe to repeat, but it does NOT
#    "report 0 new rows" on a re-run. See the correction below.
kubectl -n tenant-public exec deploy/judge-arena-web -- node /app/seed.js
```

> **CORRECTION 2026-08-29 — "reports 0 new rows on a re-run" is false**, and so is the same sentence
> at `prisma/seed.ts:29`. The upserts are genuinely idempotent; the **output** is not diagnostic.
> `prisma/seed-prompt-templates.ts:120` and `:135` log `✓ Created prompt template: …`
> **unconditionally** — after the upsert, outside any branch — so a re-run prints "Created" for rows
> that already existed. `prisma/seed-judgebench.ts:307` is the only line carrying a real delta, in its
> `${created.count} new samples` parenthetical, and `seed-core.ts` never prints the word at all.
> **Do not read the seeder's log as evidence of what production was missing** — query the table
> either side instead (`select name, version, "createdAt" from "PromptTemplate"`). For anyone
> tempted to fix the logging: `PromptTemplate` has **no `updatedAt` column**, so branching on
> `createdAt === updatedAt` is not implementable; it needs a `findUnique` before the upsert, a
> `count()` either side, or a `create` with a P2002 catch.

**Both are manual on purpose, and both are worth a decision rather than a habit.** There is no
auto-promote for judge-arena (jobops opens a promote PR; this repo pins `values.image.tag` by hand),
and there is no Helm seed hook. A `post-install,post-upgrade` hook would be *safe* — the seeder is
idempotent — but it would ship catalog changes silently with unrelated deploys. Six phases × a manual
bump each is the cost of not deciding.

### Blockers nobody had written down

Found 2026-08-12 while clearing the list above. None of these were in the original assessment, and
the first is larger than several that were.

12. **CI cannot run the DB or integration suites — and Roadmap A is almost entirely DB code.**
    `test:db` (286 tests, including the five new seeder guards) and `test:integration` need
    postgres/redis/rabbitmq. The Gitea runner is act_runner in **host mode with no container engine
    of any kind**, so Docker-based `services:` sidecars cannot start. The `services:` block that used
    to sit in `ci.yml` started nothing; it was deleted rather than left decorative, because YAML that
    cannot execute reads to every future maintainer as coverage that exists.

    Weigh this against what A0–A5 actually are: `GoldenSet`/`GoldenItem` CRUD, one-label-per-annotator
    constraints, kappa and test-retest math, `CalibrationRun` aggregation, a training export. That is
    ~24 days of work whose correctness lives almost entirely in the database layer — i.e. precisely
    the suite CI cannot run. Unit tests + typecheck will stay green while a uniqueness constraint or
    an aggregation window is wrong.

    > **CLEARED 2026-08-12 (preflight Stage 6).** One ephemeral k8s Job in `tenant-builds` whose pod
    > carries postgres/redis/rabbitmq alongside a `node:22-alpine` test container. Containers in a pod
    > share a network namespace, so `localhost:5432` works exactly as the `services:` block intended.
    > Shipped as `templates/gitea-workflows/db-test-job.yaml.tmpl` in homelab-setup plus a `db-tests`
    > job in `.gitea/workflows/ci.yml`; `build-push` gates on it. The runner can create Jobs in
    > `tenant-builds` but **not** bare Pods (verified), so it had to be a Job.
    >
    > **The word "sidecar" was doing more work than it looked.** They must be `initContainers` with
    > `restartPolicy: Always` — k8s *native* sidecars, GA in 1.33, and this cluster is v1.34.3. As
    > plain `containers:` entries the Job never reaches `Complete`, because that requires every
    > `containers:` entry to terminate and postgres never exits: the run would hang to
    > `activeDeadlineSeconds` and report `DeadlineExceeded` **whether or not the tests passed**. Red
    > on success, on the one suite this item exists to make trustworthy.
    >
    > **Verified by running it, not by dry-run:** against `fc788e1`, Job `Complete` in **100 seconds**,
    > **286/286** DB tests (26 files) and **74/74** integration tests (9 files).
    >
    > **And "available" was not the same as "works".** `linstor-scheduler-admission` fires on every Pod
    > CREATE cluster-wide, is compiled against `k8s.io/api v0.25.6`, and JSON-patch-diffs the pod
    > through that old struct — so it emits a `remove` op for `initContainers[N].restartPolicy` and
    > silently turns native sidecars back into ordinary init containers, wedging the pod at `Init:1/5`.
    > The pod template needs `admission.homelab.asethi.com/skip-linstor-scheduler: "true"`. This is
    > homelab divergence **#24**, already fixed in-repo with a scoping patch and an admission probe —
    > and nothing in this roadmap or the preflight plan found it, because every surface a reader would
    > check says the feature is on: version v1.34.3, schema documents it, feature gate reports enabled,
    > and the Job stores the field. Only the Pod strips it. Same lesson as the barman deprecation.
    >
    > Three smaller corrections worth carrying: it reuses `templates/gitea-workflows/test-job.yaml.tmpl`
    > (PR #635), not the kaniko template — that file already settled the clone/scrub/token posture;
    > **two** databases are required, because `vitest.db.config.ts` also includes
    > `tests/importer/**/*.db.test.ts` which reads `V1_DATABASE_URL` → `judge_arena_v1`; and
    > `envsubst` must be given an explicit variable list, or it expands the shell variables inside the
    > template and disables the guard that keeps `prisma migrate reset --force` pointed at localhost.
    > Plus: `capabilities.drop: [ALL]` crash-loops all three service images, whose entrypoints chown as
    > root before dropping privileges — `baseline` permits the default capability set, `restricted` does not.

13. **`judge-arena-pg` is `instances: 1`, and its PDB permits zero disruptions.** Verified
    2026-08-12: `judge-arena-pg-primary` reports ALLOWED DISRUPTIONS **0**. Two consequences that
    point in different directions and are easy to conflate: w-gharial cannot be drained while it
    runs, *and* the labelling data — A1's first unreproducible artifact — has no replica. WAL
    archiving now bounds the loss (T2 is done), but it does not remove the single point of failure,
    and a restore is minutes of RTO rather than a failover. `judge-arena-web` is also 1 replica.

    The rebaseline gates `instances: 1 -> 2` on the T1 memory work (+256Mi request, +30GiB of
    LINSTOR ledger). That gating is still right; what changed is that A1 is now the thing waiting
    behind it.

14. **The roadmap itself was not on main.** This document, the rebaseline design, the benchmark
    roadmap and the phase-A preflight plan lived only on `docs/rebaseline-north-stars` — 2428 lines
    across 5 files, none of it on the trunk anyone reads. A plan that governs 24 days of work should
    not require knowing which branch to check out. Landed 2026-08-12.

### Needed during A rather than before it

All four re-verified against the tree and cluster on 2026-08-12 — none has moved.

4. **Run-grain `startedAt`** on `EvaluationRun` — without it "how fast" conflates queueing with
   judging (see the selection-metrics section). Confirmed absent: the model carries `createdAt` and
   `finalizedAt` and nothing between them.

   > **Re-verified 2026-08-29 against `prisma/schema.prisma` at `14d75f7`: still absent.** The model
   > carries `deadlineAt`, `finalizedAt`, `createdAt` and `updatedAt`, and no `startedAt`. Worth
   > knowing why a grep misleads here: `startedAt` **does** appear in the schema twice — on
   > `ModelJudgment` (judgment grain) and on `CalibrationRun` (`@default(now())`, run header) — so
   > the column name is present, just never at `EvaluationRun` grain. A2's drain-rate question
   > (decisions doc, open question 6) inherits exactly this: a calibration run can time itself, but
   > it cannot split that elapsed time into queue wait and judging.

5. **A per-judgment format-compliance signal.** No column exists; it is the fourth reliability
   component. Confirmed: no `formatCompliant`/`parseOk`-shaped field anywhere in the schema.
6. **Token aggregation.** Per-judgment capture already works (`ModelJudgment.tokenCount`); nothing
   rolls it up.
7. **RabbitMQ scrape, alerts and the per-run concurrency cap** (rebaseline T5) **before A2.**
   Calibration is a burst of judgment work against a broker sitting at 54% of a publisher-blocking
   watermark that GitOps cannot raise — precisely the workload that finds that limit the invisible way.

   **Re-measured 2026-08-12 and the figure is exact, not approximate:** `rabbitmqctl status` on
   `rabbitmq-judge-arena-server-0` reports **0.1403 GB used against a 0.2577 GB high watermark =
   54.4%** — while completely idle. And the observability half is not partially done, it is absent:
   **no VMServiceScrape/ServiceMonitor targets RabbitMQ, and zero VMRules mention it.** So the
   sequence on the day A2 first runs is: burst → watermark → publishers block → no metric, no alert,
   and a symptom (runs that never start) that points at the worker rather than the broker.

   Treat T5 as a hard gate on A2, not a nice-to-have. It is the one item on this list whose failure
   mode is silent *and* whose blast radius is the whole run pipeline.

   > **UPDATE 2026-08-29 — still the gate; the 2026-08-12 figures above stand as recorded.**
   > Re-measured at idle: **0.1197 GB against the same 0.2577 GB watermark = 46%**, no alarms, and
   > **3.9393 GB** free disk against a **2.0 GB** low watermark. The percentage moved; the shape did
   > not. **T5 itself is ~5% done and item 1 is untouched** — VictoriaMetrics returns
   > `seriesFetched: "0"` for `{__name__=~"rabbitmq_.*"}`, meaning **not one RabbitMQ sample has ever
   > been stored in this cluster**, with zero VMServiceScrapes and zero VMRules matching rabbit or
   > judge.
   >
   > **Everything the scrape needs already works**, which makes item 1 smaller than it reads:
   > `rabbitmq_prometheus 4.2.4` is enabled, both Services publish `prometheus 15692`, the endpoint
   > answers 2818 lines, and the existing `allow-external-communication` CiliumNetworkPolicy already
   > permits cross-namespace scraping — **no NetworkPolicy work is needed.**
   >
   > **Two spec corrections and one new fact, for whoever writes T5.** (a) There are now **two**
   > brokers, not three: `apps/managed/rabbitmq-shared.yaml` was deleted in `6f1a460` and Flux pruned
   > `tenant-root/bus`. (b) A request body size limit **does** exist — at the ingress, at `50m`,
   > nginx's 1m default deliberately raised 50x. (c) **RabbitMQ's default `/metrics` carries no queue
   > label at all**, so the `judgment.execute` backlog and `judge.dlq` depth alerts T5 asks for are
   > **impossible** from it; they need a second scrape of
   > `/metrics/detailed?family=queue_coarse_metrics`, where only the **leader** node emits a depth
   > sample. Plan for two scrape targets, not one.
   >
   > **AND THE PIPELINE WAS DEAD WHEN THIS WAS WRITTEN — not a T5 item, but it bites this same
   > phase.** Every one of the five queues reported `consumer_count=0` from
   > **2026-08-24T17:55Z** (see the 2026-08-30 note below for how that ended). The Cozystack
   > v1.6.2 roll recreated `judge-arena-pg-1` at 17:54:57Z; the worker logged a burst of `Can't reach
   > database server` / `terminating connection due to administrator command` (SQLSTATE 57P01) 21
   > seconds later and has emitted **no log line since**, while sitting 1/1 Running with 0 restarts.
   > Its database socket reconnected; its **AMQP consumers never re-registered**. A worker rollout
   > restores service, but the underlying defect — consumers are registered on boot and not on
   > reconnect — is **unfixed**, and a calibration burst is exactly the workload that would trip it
   > again and then present as a hung run rather than a dead consumer.
   >
   > **RESOLVED INCIDENTALLY 2026-08-30, and the code defect is still not fixed.** The `14d75f7`
   > promote rolled `judge-arena-worker` at `2026-08-30T01:47:21Z`, which is exactly the "worker
   > rollout" this note prescribed — nobody fixed anything, a deploy happened to do it.
   > `rabbitmqctl list_queues name messages consumers` on `rabbitmq-judge-arena-server-0` now
   > reports `run.create 0 1` and `judgment.execute 0 1`; `judge.dlq`, `judgment.retry.30s` and
   > `judgment.retry.5m` remain at 0 consumers, which is their normal state and not the outage.
   > **Read the six-day gap, not the current number:** the pipeline stayed silently dead from
   > 2026-08-24T17:55Z until an unrelated promote, and the reconnect defect that caused it is
   > still in the tree, so the next broker or database blip reproduces it.

### The one to do first, and it is not on the list above

8. **WAL archiving plus one rehearsed restore (rebaseline T2) before the first labelling session.**

   **A1 creates the first genuinely unreproducible data in this product.** Configuration can be
   re-entered. Runs can be re-run. Benchmark scores can be recomputed. **Human labels cannot** — they
   are hours of irreplaceable judgement, and they are the artifact everything downstream rests on:
   `kappa`, PPI's gold sample, the calibration verdict, the training export.

   Today the only thing protecting them would be a single daily Velero filesystem copy of a live
   datadir. There is **no PITR anywhere in this cluster** (WAL archiving reports green with no
   destination, on all 18 CNPG clusters), and **no restore has ever been rehearsed here by any
   mechanism.** So the moment labelling starts, the most expensive artifact in the product begins
   accumulating on top of a 24-hour-RPO path that has never been tested.

   That reorders the rebaseline: T2 was scoped as "before real users author anything." Dogfooding
   *is* authoring. It belongs before A1, not before launch.

   > **CLEARED 2026-08-11 — and verified against the cluster, not the pipeline.** All six exit-gate
   > items pass: `cnpg_collector_last_available_backup_timestamp` is a real timestamp instead of `0`;
   > 23 WAL segments archived with `failed_count 0`; a restore was rehearsed into a scratch namespace
   > with 25 tables and 12/12 `_prisma_migrations` rows; `docs/runbooks/judge-arena-restore.md`
   > records a **measured 60-second RTO**; no orphaned PVs. Weekly `ScheduledBackup` +
   > `retentionPolicy: 30d` to R2.
   >
   > **Read the RTO caveat before quoting it.** 60s was measured against a 9300 kB database with
   > essentially no product rows. It is dominated by pod scheduling and PVC bind, not by data or WAL
   > replay, and **it will not survive a loaded database.** Re-measure after the first labelling
   > sessions — which is exactly when the number starts to matter.
   >
   > **The alert is scoped to judge-arena-pg only, deliberately.** The obvious unscoped rule would
   > fire for all 17 other CNPG clusters, which genuinely have no backups: 6 notification groups,
   > ~34 permanently-open alerta entries, and nothing that clears them without unscheduled work on
   > clusters this repo cannot all reach. That is a ratchet, so it was not shipped. The residual fact
   > to hold onto: **17 CNPG clusters still have zero backups and now have zero alert coverage**, and
   > only 5 of them are fixable from this repo.

### Traps that are not blockers but will bite

9. ~~**`networkPolicy.lanEgress.cidrs` is empty.**~~ **CLEARED 2026-08-11.** `192.168.1.164/32` on
   port 8001 is declared and live in the `judge-arena-egress` CNP. Note what it does *today*:
   nothing. tenant-public's blanket `toEntities: [world]` already permits it. It is declared so that
   T4's `egressDeny` cannot quietly break dogfooding — an undeclared endpoint on that day fails as a
   **silent packet drop**, not an error: judgment timeouts against a server that is plainly up.
10. **Endpoint config is admin-only** (decision C), so the dev endpoint is admin-configured — which is
    exactly the sanctioned "operator's own LAN model" case, and consistent. Worth knowing that a
    non-admin dogfooding account could not add it.
11. **A0's exit gate needs the coverage lists extended** in `tests/db/config-roundtrip-fidelity.test.ts`
    so golden sets are covered by the portability guarantee rather than silently absent from it.
    **Still open, confirmed 2026-08-12** — that file mentions neither `goldenSet` nor `goldenItem`.
    Note the compounding effect with blocker 12: this test is in `tests/db/**`, so even once written
    it will not run in CI until the ephemeral-Job path exists.
12. **JudgeBench is seeded but is not runnable, by construction.** The seeder ships
    `ScalerLab/JudgeBench` (MIT, 620 rows, both splits) as a public `Dataset` with real
    `DatasetSample` rows — deliberately, because A0 imports golden items *from an existing Dataset*
    and this is that substrate. But its items are **pairwise** (question + response_A/B + a
    ground-truth label) and the only seeded `PromptTemplate` is `v1-legacy`, `protocol: pointwise`,
    which scores one submission against a rubric. There is no pairwise judging path yet. A run
    launched against this dataset today judges the question alone and produces a number that means
    nothing. `input` holds the question; the pair lives losslessly in `metadata`. **It is reference
    data until A1/A2 introduce the pairwise protocol** — do not read a green run against it as
    signal.

**Net, as of 2026-08-12:** the three original hard blockers are cleared and the reordering (durability
before the first label) is done and verified. What remains, in the order it bites: **two commands** to
deploy and seed — after which A0 can start — then **CI's inability to run the DB suite** before ~24
days of DB-heavy code, then **T5 as a hard gate on A2**. The four small pieces still land inside the
phases that need them. Two of the six open decisions (#3 canonical agreement statistic, #6 golden-set
immutability) should be settled before A0 is written rather than during it, because both change the
schema-adjacent choices A0 makes.


## Two human-input surfaces that must not be conflated

The schema has two, they mean different things, and treating them as one would quietly corrupt
every agreement metric:

| | `HumanJudgment` | `GoldenLabel` |
|---|---|---|
| Grain | `runId @unique` — **one per run** | `@@unique([goldenItemId, annotatorId])` — one per annotator per item |
| Purpose | A human's rating of a run they launched, plus `selectedBestJudgeModelVersionId` | A curated ground-truth label on a golden item |
| Multi-annotator | No, by construction | Yes, by construction |
| Feeds | Human-agreement reporting (Roadmap B) | `CalibrationRun` metrics, training exports |

`HumanJudgment` is *in-workflow feedback*. `GoldenLabel` is *ground truth*. Only the second can
anchor calibration, because only the second has the annotator dimension agreement requires.
Owner decision 7 (human scores are not part of the leaderboard's final score) applies to
`HumanJudgment`; it does not diminish `GoldenLabel`, which is the substrate of this whole roadmap.

---

## Phases

Each phase ends in something observable, and the ordering is a real dependency chain: you cannot
measure agreement before labels exist, cannot calibrate before agreement is measurable, and
cannot claim a distilled judge is better before calibration works.

### A0 — Make the golden-set substrate reachable · ~3 days

> **DONE (2026-08-13), plus unplanned lifecycle work on top.** All 24 tasks landed (22 planned + 2
> corrective) on `feat/a0-golden-set-substrate`, pushed to gitea at `8d65198` as **PR #12**, not yet
> merged to `main`. The exit gate below is met: golden sets round-trip through export/import and are
> covered in `tests/db/config-roundtrip-fidelity.test.ts`.
>
> Two things this phase description did not anticipate. **Delete became non-destructive** — an owner
> ruling mid-flight replaced every destructive path with a tombstone, first as `tombstonedAt` columns
> on `GoldenItem`/`GoldenLabel` (A0), then as a general `Tombstone` overlay table for datasets and
> samples (plan **L1**, complete, merged locally, and **pushed** to `gitea/feat/a1-tombstone-overlay`
> at `1dcd73c` — an earlier revision of this line said unpushed, which was true for a few hours).
> The consequence worth carrying forward:
> **ordinals are never reused and `index` is not dense.** And **pairwise is not HTTP-reachable** — it
> ships as a library-and-integration capability; no route passes `protocol` or `candidates` to
> `launchSingleRun`. Wiring it is follow-on work that A1 (this roadmap's) will need.
>
> Current state, decisions outstanding, and the next pickup:
> `plans/2026-08-17-l2-complete-a1-handoff.md` (current), which supersedes
> `plans/2026-08-16-l1-complete-l2-handoff.md`.

Nothing exists above the schema. This phase is the API and the UI, with no new modelling.

- CRUD for `GoldenSet` and `GoldenItem`, honouring the existing ownership idiom (`ownerId` with
  `onDelete: SetNull`, plus the `retiredAt` soft-delete whose rationale is already documented in
  the schema).
- Import golden items from an existing `Dataset`, so curation starts from data a user already has
  rather than from a blank set.
- `GoldenItem` carries `inputText`, `promptText`, `responseText`, `protocol` and `expected` —
  confirm the entry UI covers all five, because `promptText`/`responseText` being optional means a
  pointwise item and a pairwise item are the same table with different fields populated.
- Respect `RunProtocol` (`pointwise | pairwise | listwise`) from the start. Retrofitting listwise
  onto a pointwise-only UI is the kind of thing that forces a schema change later.

**Exit gate:** a golden set with items of each protocol exists, created through the UI, and
survives an export/import round trip (which means adding it to the coverage lists in
`tests/db/config-roundtrip-fidelity.test.ts`).

### A1 — Human verification and a measured agreement floor · ~4 days

> **IMPLEMENTED 2026-08-17**, all seven tasks (`4ff04f4`…`eef73fb`). Design:
> `2026-08-17-a1-human-verification-design.md`. Plan:
> `../plans/2026-08-17-a1-human-verification.md` — which carries a **"Defects found during
> execution"** table: three of its own snippets were wrong (one could not have passed under any
> implementation) and two defects in the code were not predicted. Read that before reusing anything
> from it. **Split:** the annotation studio — the panel shell A2 and A3 also consume — is **A1.5**,
> and it landed straight afterwards (`133cc12`…`05bf29b`). A1 owns the data and the endpoints,
> A1.5 owns the surface; they were built in that order but neither depended on the other until
> A1.5's last task, which composes A1's queue and submit routes into the labelling view.
>
> **A1.5's exit gate is met too**, and its five clauses are recorded against a walked browser
> checklist rather than against tests — `src/components/**` cannot be unit-tested in this repo
> (no jsdom), which is why every rule that can be silently wrong lives in `src/lib/studio/**`
> instead. See `docs/runbooks/studio-manual-verification.md`.
>
> **Exit gate, all four clauses met.** A set reports a number with a stated method — statistic,
> weighting, annotator count and the OVERLAP it was computed over. A deliberately inconsistent
> re-label moves `testRetest` down. An item edited after labelling still resolves each label to the
> text that annotator saw. A POST from an unassigned annotator is refused, and re-checked on submit
> rather than trusted from the queue.
>
> **What to expect on day one, and it is not a bug.** With one account the inter-annotator number is
> `insufficient-annotators` — null with a reason, never `0`, which would read as total disagreement.
> `testRetest` is the only signal that yields a value until a second account exists. See the
> annotator distinction below.

The point of this phase is that **a golden set with no agreement measurement is not ground truth,
it is one person's opinion**, and calibrating a judge against it would produce a confidently wrong
number.

#### ONE ANNOTATOR IS A DEVELOPMENT CONSTRAINT, NOT A PRODUCT ONE — read this before writing A1

This distinction is easy to collapse and expensive to collapse wrongly, so state it three ways.

**What is true today.** Exactly one account exists, so exactly one annotator exists. Every
inter-annotator statistic is therefore *unavailable* rather than bad: `agreement()` returns
`{ value: null, reason: 'insufficient-annotators' }`, never `0`, because `0` reads as total
disagreement — the opposite of "not measurable". **`testRetest` is the only reliability signal that
produces a number at launch**, which is precisely what that column was put in the schema for.

> **STILL TRUE 2026-08-29, with two refinements.** Prod now holds **2 `User` rows**, not 1 — but the
> second is the seeder's non-login service principal `platform@judgearena.local`
> (`passwordHash: '!platform-system-user'`, `prisma/seed-core.ts:69-75`), which `findCredentialsUserByEmail`
> excludes and which has no OIDC identity. One human annotator, exactly as this section says.
>
> The sharper refinement: **that one annotator cannot currently sign in** (see "The real blocker on
> the first label"). So the live state is not "one annotator" but **zero readings from one intended
> annotator** — `GoldenLabel` is 0, which means `testRetest`, the signal this section calls the only
> available one, has nothing to compute over either. Both statistics are unavailable today, for two
> different reasons, and only one of them is the one-annotator constraint described here.

**What is NOT true.** That the multi-annotator paths can be deferred. **Multiple annotators will be
available through the owner's backend**, so the overlap model, the assignment rows, Fleiss's kappa
for three or more raters, and the disagreement queue are all real product paths — they are simply
not *exercisable end to end* on this machine yet.

**What follows, concretely.** Multi-annotator behaviour is **built and tested now**, using fixtures
that create N `User` rows — a DB test does not need the backend to have three annotators disagree
about an item. What waits on access is only the **annotation-validation code against those APIs**:
how annotators are provisioned, authenticated and routed work from the external service. That
integration is a later, separate piece, and A1 must not be shaped as though it were the blocker.

The failure mode this warning exists to prevent: building A1 against a single annotator, discovering
at integration time that overlap was never modelled, and finding that the agreement number shipped
for months was computed over an overlap of one — which is not a floor, and not detectable from the
number itself.

- A labelling/verification UI: present an item, collect `overallScore`, optional
  `criteriaScores` and `reasoning`, write one `GoldenLabel` per annotator.
- **Blind re-labelling for test-retest.** With a single annotator this is the *only* available
  reliability signal, and `testRetest` already exists as a column. It needs an interval and a
  presentation order that prevents recognising the item — which is a product design problem, not
  just a query.
- Compute and display inter-annotator agreement (`kappa`, `rawAgreement`) as soon as a second
  annotator exists. Report **which** kappa (Cohen's for two, Fleiss's for more, or a weighted
  variant for ordinal scores) — with numeric scores, an unweighted kappa understates agreement and
  the choice must be recorded rather than implied.
- Surface disagreement as work: items where annotators diverge are the items worth adjudicating.
  This is the feature that makes the engine feel useful rather than clerical.

**Exit gate:** a golden set reports an agreement number with a stated method, and a
deliberately-inconsistent re-label moves `testRetest` in the expected direction.

**Open question — NARROWED 2026-08-17.** Who may annotate whose data? A1 settles the *mechanism*:
explicit `GoldenAssignment` rows, so overlap is designed rather than accidental, plus a policy of
owner + admin only while one account exists. What remains open is the *policy* once annotators
arrive from the backend — whether a granted dataset routes to an annotation queue automatically, and
who may see whose readings. The mechanism does not need redesigning for either answer; that is why
it was built as assignment rows rather than a free-for-all.

### A2 — The calibration engine · ~5 days

> **NOT STARTABLE YET, and the reason is longer than "T5 is open".** A1 and A1.5 are done, but A1
> shipped the ABILITY to produce labels and has not produced any: production has zero golden sets
> and — when this note was written — was five migrations behind. **The migrations landed
> 2026-08-17 and prod is now current; the zero golden sets did not change.** A2's decisions document
> requires *real* label data as an input to
> its design, so the merge → promote → migrate → seed → annotate chain is a genuine gate rather
> than housekeeping. It is written out, with the verified state of prod, in
> **`2026-08-17-integration-release-and-a2-roadmap.md`** — read that before planning A2.
>
> T5 below was re-measured 2026-08-17 rather than quoted: **0.1407 GB against a 0.2577 GB
> watermark, 54.6% at idle, still zero VMServiceScrapes and zero VMRules.** Unchanged, so the gate
> is stable rather than a spike.
>
> **UPDATE 2026-08-29 — still not startable, and the sentence "production has zero golden sets" is
> now wrong.** It was true when written; it stopped being true on **2026-08-19**, when 2 sets (650
> items, 1300 candidates) were created and both self-assigned. The chain got further than this note
> assumed: merge -> promote -> migrate -> **seed -> assign** are all done. It stalls at *annotate*,
> and not for want of a surface — `14d75f7` shipped the assignment UI, and sign-in is refused by an
> OIDC subject mismatch. **`GoldenLabel` is still 0**, so the input A2's design needs is still
> absent and the gate still holds — but the next action is an identity fix, not a curation session.
> T5 re-measured today: **0.1197 GB / 0.2577 GB = 46% at idle**, still zero scrapes and zero rules,
> and the run pipeline itself had **zero AMQP consumers from 2026-08-24 until 2026-08-30**, when
> the `14d75f7` promote rolled the worker and they re-registered — by accident, not by fix; the
> reconnect defect is still in the tree. See blocker 7.

This is the phase that gives `trustState` its first *transition*. (Not its first writer —
`prisma/seed-core.ts:192` stamps `trustState: 'trusted'` on every seeded catalog row, which is
why all 3 production `JudgeModelVersion` rows read `trusted` with `CalibrationRun` at 0. A2 is
what makes that column mean something.)

- Run a `JudgeModelVersion` over a `GoldenSet` and populate `CalibrationRun`: `kappa`,
  `rawAgreement`, `verdictCount`, `passed`.
- **`positionBias`** — for pairwise/listwise items, present the same pair in both orders and
  measure verdict flips. This is the single most diagnostic judge defect and it is invisible to
  pointwise scoring.
- **`biasSensitivityRate`** — perturb inputs in ways that should not change the verdict (length,
  formatting, self-preference cues) and measure how often it does. Define the perturbation set
  explicitly and version it, or the metric is not comparable across runs.
- **Drive `TrustState` transitions from thresholds**, and record the threshold that was in force.
  `untrusted → calibrating` on run start; `→ trusted` or `→ rejected` on the verdict. A judge that
  reaches `trusted` under one threshold and would fail under a later one must be re-derivable,
  which means the threshold is data, not a constant in the code.
- Reuse the existing execution path (`src/lib/llm/*`) rather than a parallel one, so calibration
  inherits the retry, circuit-breaker and BYOK-key behaviour instead of re-implementing it.

**Exit gate:** a judge model version moves `untrusted → calibrating → trusted` from a real
calibration run, with every metric populated and the threshold recorded.

**Cluster note:** calibration is a burst of judgment work over the same broker whose memory
watermark sits at 54% at idle and cannot be raised via GitOps. (**Re-measured 2026-08-29: 46% —
0.1197 GB against the same 0.2577 GB watermark, no alarms.** The figure moved, the argument did
not, and GitOps still cannot raise the watermark.) **The rebaseline's T5 (RabbitMQ
scrape + alerts, and the per-run concurrency cap) is a hard prerequisite for this phase** —
calibration is exactly the workload that would discover the watermark the invisible way.

### A3 — The per-run measurement bundle and comparative diagnosis · ~6 days

Owner requirement, 2026-08-10: every run, associated with its data, should report **PPI, a confusion
matrix, the coin-flip floor, and its position on the leaderboard for the same dataset** — and then
let you diagnose *why* a leaderboard model did better, down to which samples diverged and how their
chains of thought differ.

This is the phase that turns a score into a reason, and it is the loop-closing surface: nothing else
in either roadmap tells you *what to change next*.

**Correcting an earlier draft of Roadmap B:** PPI and the coin-flip measure were modelled there as
candidate *benchmark entities*. They are not benchmarks — they are **per-run measurements** that
apply to any run against any dataset. Benchmarks are the yardsticks; these are how you read a
result. That correction is why this phase exists here rather than in B0.

Four measurements, each with a distinct job:

- **Coin-flip floor** — the chance baseline on this dataset. Establishes what "no skill" scores, so
  a number reads as better-than-random rather than merely high. Cheap, and the highest
  value-per-line item in the bundle: it is the whole difference between "0.72" and "0.72 against a
  floor of 0.5".
- **Confusion matrix** — where the judge is wrong, not just how often. A judge that scores 90% by
  always saying "pass" on a 90%-pass dataset is a different object from one with balanced errors,
  and only the matrix separates them.
- **PPI** (prediction-powered inference) — the real-gain estimate. Combines the small human-labelled
  golden sample with the many model-labelled items to yield a statistically valid estimate *with
  confidence intervals*, instead of a point number of unknown error. This is the metric that answers
  "is the improvement real or is it noise", which a training loop must answer before spending
  another round. It needs a gold sample, which is exactly what A1 produces — so the ordering here is
  a real dependency, not sequencing preference.
- **Leaderboard position on the same dataset** — the external reference, supplied by Roadmap B.

#### The selection metrics: how fast, how much, how reliably

**Owner thesis, 2026-08-10: these are the primary axes for choosing a judge framework.** So they are
not telemetry hung off the side of a quality score — they are co-equal outputs of every run, and they
belong on the public board (see the rebaseline's public tier, widened on the record for exactly this).

The substrate is better than expected. `ModelJudgment` **already models** `latencyMs`, `tokenCount`,
`inputTokens`, `outputTokens`, `attemptCount` and `startedAt`. So *how fast* and the raw inputs to
*how much* exist at the judgment grain today; what is missing is aggregation and one table.

**Cost is reported in units, never in dollars.** Owner decision 2026-08-10, and it is the right call:
price is wildly variable — local inference costs electricity and GPU time, a hosted API costs whatever
that user negotiated, and two users on the same model may pay different amounts. So the platform
reports **per model: API calls, tokens in, tokens out**, and the reader applies their own price.

This **dissolves the price-table gap** an earlier draft of this section called "the one real gap":
there is no price table to build, and no price version to record, because no money is ever stored.
It also removes the stamp-at-execution problem entirely — token counts are facts that do not change
when a provider reprices, so the immutability concern that applies to rubrics simply does not arise.
Publishing `$` would beg the question "whose price?"; publishing units is objective and universal,
which is also what makes it fit the public tier.

**The capture path already works.** `src/lib/llm/openai-compatible.ts:111-122` reads
`response.usage.prompt_tokens` / `completion_tokens` and computes `latencyMs`, writing them through
to `ModelJudgment`. So this is not instrumentation work — what is missing is **aggregation** (nothing
rolls tokens up to the run or model level, which is the grain "how much" is read at) and exposure.

**Reliability is not one number, and three of its four components already have substrate.** Publishing
a single opaque "reliability" score would hide exactly the distinctions a chooser needs:

| Component | Question it answers | Substrate today |
|---|---|---|
| **Availability** | Does the call succeed? | `ModelJudgment.status`, `attemptCount` (retry rate), plus the circuit breaker |
| **Determinism** | Same input, same verdict? | `CalibrationRun.testRetest` |
| **Robustness** | Does an irrelevant change flip it? | `CalibrationRun.positionBias`, `biasSensitivityRate` |
| **Format compliance** | Does it return parseable structured output? | Backend `caps.structuredOutput` in `registry.ts`; **no stored per-judgment signal — needs one** |

Publish the components, and a composite only if the weighting is stated. A judge that is 99%
available and wildly non-deterministic is unreliable in a way an average would conceal.

**Throughput needs one new column.** `EvaluationRun` has `createdAt` and `finalizedAt` but **no
`startedAt`**, so elapsed time currently conflates queue wait with execution time. A judge that is
fast but queued behind others would report as slow, which makes "how fast" unreadable. Add a
run-grain `startedAt` so queue latency and execution latency are separable — small migration, and the
metric is not meaningful without it.

**Comparative diagnosis** is the second half, and the harder one:

- **Sample-level divergence** — which items your judge and the reference judge scored differently,
  ranked by disagreement magnitude. This same set is the highest-information input to the next
  labelling round, which is how A5 closes.
- **Chain-of-thought comparison** — the two judges' `reasoning` side by side on a diverging sample.

**What diagnosis may show, settled 2026-08-10.** Reasoning publication is **strictly opt-in**. The
owner contributes their own completed, leaderboard-listed evaluations — reasonings and responses — as
a public good, and any user **may optionally opt in** to contribute theirs. So the comparison corpus
is: your own runs, the owner's published evaluations, and any opted-in user's.

Two properties of that arrangement worth naming, because they are what make it safe:

- **The asymmetry is deliberate.** A score's eligibility follows mechanically from compute provenance;
  a reasoning's publication never does. Spending our compute does not publish a chain of thought, and
  no default flips that. That keeps decision 6 intact for everyone who does nothing.
- **The corpus grows rather than being provisioned.** An earlier draft of this roadmap proposed
  platform-owned reference judges as the comparison target and treated their existence as a
  prerequisite. That framing is now unnecessary: the owner's own dogfooding runs *are* the seed
  corpus, and opt-in adds to it. The feature is useful on day one with one participant.

The constraint that remains: cross-user CoT comparison is available only where that user opted in.
A "compare me to the leader" affordance must therefore degrade honestly — show the comparison where
the corpus allows and say plainly when it does not, rather than appearing broken.

**Exit gate:** a run reports all four measurements plus throughput and latency, and a diverging
sample can be opened with both reasonings shown against a reference judge.

### A4 — Distillation: export, register, verify · ~4 days

- **Export a training set** from labelled golden items: the input, the human label, and — for
  preference-style training — the pairwise comparison. Version the export format and record its
  hash, because a trained model's provenance is worthless if the training set it names is mutable.
  (The immutability rule from the rebaseline applies here for the same reason it applies to
  rubrics.)
- **Register the returned model** as a `JudgeModelVersion` with `parentVersionId` set to what it
  was distilled from, plus `trainingDataVintage`, `weightsRevision`, `quantization`/`quantMethod`,
  and `JudgeModel.trainingRecipe`. Every one of those columns already exists and has no writer;
  together they are the provenance record, and filling them is most of the work.
- Where the model actually runs: an endpoint, which under decision C is **admin-configured** on
  the hosted instance. A user distilling their own judge and serving it themselves is a
  self-hosting story — which is consistent, and should be said plainly rather than presented as a
  limitation discovered at the last step.

**Exit gate:** a child `JudgeModelVersion` exists whose lineage, training vintage and recipe are
all recorded, and whose training set is identified by an immutable hash.

### A5 — Close the loop · ~2 days

- **`flipRateVsParent`** — the one metric that makes the loop a loop. Run parent and child over the
  same golden set and measure how often they disagree. High agreement means the distillation
  changed nothing; high disagreement means it changed something, and calibration says whether that
  something was an improvement.
- **A promotion gate:** a child may not reach `trusted` unless it beats its parent on the golden
  set. Without this, "we trained a new judge" and "we trained a better judge" stay
  indistinguishable, which is the failure mode this entire product exists to fix.
- Feed the verdict back into what to label next: items where parent and child disagree are the
  highest-information items for the next round.

**Exit gate:** a distilled child is either promoted or rejected on evidence, and the decision plus
its supporting metrics are recorded.

---

## Deliberately not doing (yet)

- **In-house training.** No GPU; see the boundary section. Revisit as hardware, not software.
- **Active learning / uncertainty sampling** to reduce how many labels a human must produce. This
  is the highest-leverage efficiency feature and it is premature before A1 has produced any labels
  to learn from.
- **Crowd annotation / paid annotators.** Multi-annotator support exists in the schema, but a
  labelling marketplace is a different product with its own trust, payment and quality problems.
- **Automatic rubric induction** from labels. Interesting, unproven, and it would undermine the
  immutability guarantee if a rubric could be silently regenerated.

---

## Decisions this roadmap needs

**Which phase each one gates** (added 2026-08-12, so none of these is discovered mid-implementation):

| Decision | Gates | Why it cannot wait |
|---|---|---|
| ~~**#3** canonical agreement statistic + threshold~~ | ~~A0/A1~~ | **RESOLVED 2026-08-12** — weighted kappa, threshold stored as data. See below. |
| ~~**#6** golden set immutable once referenced~~ | ~~A0~~ | **RESOLVED 2026-08-12** — yes, immutable once a `CalibrationRun` references it. See below. |
| **#5** who may annotate whose data | **A1** | **Mechanism settled 2026-08-17** (assignment rows; owner+admin while one account exists), and **given a UI 2026-08-29** by `14d75f7`: Assign to me / Revoke on `/golden-sets/<id>`, with the annotator rendered through a `toPublicOwner` projection that returns `{id,name}` and never the email. The POLICY once backend annotators arrive is still open, and does not require redesigning the mechanism. |
| **#4** `biasSensitivityRate` perturbation set | **A2/A3** | Its value is meaningless without its definition; needs versioning from the first run. |
| **#7** PPI configuration | **A2/A3** | An interval is only worth computing if something acts on it. |
| **#8** throughput/latency percentiles in the verdict | **A3/A4** | Also depends on `startedAt` (item 4) existing first. |

1. **RESOLVED 2026-08-10 — export is the boundary, and nothing runs in cluster.** All model traffic
   is API-simulated; the platform keeps the defensible artifact (labelled data, measurement bundle,
   verdict) and not the commodity one (a fine-tuning run).

2. **RESOLVED 2026-08-10 — an opt-in corpus, not a provisioned reference set.** Reasoning
   publication is strictly opt-in: the owner contributes their own completed, leaderboard-listed
   evaluations as a public good, and users may opt in to contribute theirs. This is better than the
   platform-owned-reference-judges design it replaces, because the corpus seeds itself from
   dogfooding and grows by consent instead of needing to be provisioned before the feature works.
3. **RESOLVED 2026-08-12 — weighted kappa, and the threshold is data, not a constant.** Scores are
   ordinal, so an unweighted kappa treats "4 vs 5" as exactly as wrong as "1 vs 5" and understates
   agreement; the weighted variant is the honest one. Two obligations follow, both on A0/A1:

   - **A1 must name the method it used, per run.** Cohen's for two annotators, Fleiss's for more —
     so the statistic actually computed depends on annotator count and cannot be assumed from the
     column name. Record the variant and the weighting scheme (linear vs quadratic) alongside the
     number, or a later reader cannot compare two `kappa` values.
   - **The pass threshold is stored as a row, not a constant in code.** This is the schema-adjacent
     part A0 decides. A judge that reached `trusted` under one threshold must stay re-derivable when
     the threshold later moves, which is impossible if the value lived only in a released binary.
     `CalibrationRun` should carry the threshold that was in force, the same way it will carry the
     metrics it was judged on.
4. **Define the `biasSensitivityRate` perturbation set.** It is a metric whose value depends
   entirely on its definition, so it needs versioning from the first run.
5. **Who may annotate whose data**, once a second account exists?
6. **RESOLVED 2026-08-12 — yes, a golden set is immutable once a `CalibrationRun` references it.**
   Same argument as rubrics: a retained score is only interpretable if what it measured cannot
   drift, so retention *requires* the freeze — they are one change, not two. What A0 must build:

   - **A write-guard at the API boundary** on `GoldenSet` and `GoldenItem` mutation, conditioned on
     whether any `CalibrationRun` references the set. `CalibrationRun.goldenSetId` is already
     `onDelete: Restrict`, so the schema enforces the *delete* half; this closes the *update* half.
   - **Edit-after-freeze becomes a new version, not an error message.** Curation continues past the
     first calibration run, so the affordance has to be "fork to a new set", or users will work
     around the guard by never calibrating.
   - **`GoldenSet.retiredAt` expresses the soft-retire half** and already exists; give it a writer
     so a frozen set can leave circulation without being deleted.

   Doing this in A0 rather than later is the cheap ordering: finishing it after rows exist means
   migrating sets that were mutable, with no record of what they looked like when they were measured.

7. **How is PPI configured** — what gold-sample size, and does the confidence interval gate anything
   (e.g. a distilled child may not be promoted unless its interval clears its parent's)? An estimate
   with intervals is only worth computing if something acts on the interval.
8. **What throughput/latency percentiles are recorded**, and are they part of the promotion verdict?
   A judge that wins on quality and loses badly on p99 is a real decision, not a footnote.
