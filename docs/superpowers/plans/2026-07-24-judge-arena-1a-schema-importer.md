# Judge Arena 1a — Schema v2 + Importer + Correctness Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land schema v2 (immutable judge versioning + provenance + meta-eval tables), the v1→v2 importer, and the four 1a correctness fixes — on the *current* runtime (Next 14 / next-auth v4; the framework upgrade is 1b).

**Architecture:** Additive, staged schema migration: new judge-identity tables land beside `ModelConfig` (which 1b retires); `ModelJudgment.judgeModelVersionId` is **nullable in 1a** (unique idempotency index already in place, NULLs distinct) and tightened to required in 1b when the runtime writes it. The importer reads a restored v1 pg_dump through a frozen v1 Prisma client and writes v2 rows with synthesized provenance. Correctness fixes touch existing v1 routes.

**Tech Stack:** Prisma 6 (+ `prisma migrate` newly adopted, baseline first), PostgreSQL 16, vitest, tsx for importer CLI.

## Global Constraints (from spec `2026-07-24-judge-arena-v2-architecture-spec.md`)

- Runtime stays Next 14 / next-auth v4 / Node 20 in 1a — **no framework upgrades here** (P1.1 work is 1b).
- Provenance FKs are `onDelete: Restrict`; catalog entities and rubrics soft-delete via `retiredAt` (P1.7).
- `JudgeModelVersion` rows are immutable post-creation — no update code path may exist.
- All new JSON columns are **JSONB** (`Json` type); `criteriaScores` converts with a hand-edited `USING "criteriaScores"::jsonb` migration.
- Existing `db push`-managed dev DBs are **wiped** (`docker compose down -v`), never baselined (spec §3.4). Railway prod is read-only to us (importer input only).
- User OIDC identity lives in **our** schema as `(oidcIssuer, oidcSubject)` — the non-destructive-v5 condition (spec §7).
- `trustState` defaults `untrusted` and is informational-only in Phase 1.
- Every commit message ends with the standard co-author trailer.

**DB test harness (used by every task):** `npm run test:db` =
`DATABASE_URL=$TEST_DATABASE_URL npx prisma migrate reset --force --skip-seed && DATABASE_URL=$TEST_DATABASE_URL vitest run tests/db`
with `TEST_DATABASE_URL=postgresql://judge_arena:password@localhost:5432/judge_arena_test` (created in Task 1). DB tests live under `tests/db/`, excluded from the unit run.

---

### Task 1: Adopt prisma migrate — v1 baseline migration + DB test harness

**Files:**
- Create: `prisma/migrations/` (via CLI), `tests/db/helpers.ts`, `tests/db/baseline.test.ts`
- Modify: `package.json` (scripts), `docker-compose.yml:14` (add `judge_arena_test` DB via `POSTGRES_MULTIPLE_DATABASES` init script `deploy/pg-init-test-db.sh`)

**Interfaces:**
- Produces: `tests/db/helpers.ts` exporting `export const db = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } })` and `export async function truncateAll(): Promise<void>` (TRUNCATE all public tables RESTART IDENTITY CASCADE, excluding `_prisma_migrations`). Every later DB test imports these.

- [ ] **Step 1: Wipe dev volumes and create the baseline**

```bash
docker compose down -v && docker compose up -d postgres
npx prisma migrate dev --name v1-baseline   # generates prisma/migrations/<ts>_v1-baseline/ from current schema.prisma
```
Expected: one migration dir containing the full v1 DDL; `migrate status` clean.

- [ ] **Step 2: Add test-DB init script + scripts**

`deploy/pg-init-test-db.sh` (mounted at `/docker-entrypoint-initdb.d/`):
```bash
#!/bin/sh
psql -U "$POSTGRES_USER" -c "CREATE DATABASE judge_arena_test OWNER $POSTGRES_USER" || true
```
`package.json` scripts:
```json
"test:db": "dotenv -e .env.test -- sh -c 'npx prisma migrate reset --force --skip-seed && vitest run tests/db'"
```
with `.env.test` setting `DATABASE_URL` to the test DB.

- [ ] **Step 3: Write `tests/db/helpers.ts` + a baseline smoke test**

```ts
// tests/db/baseline.test.ts
import { db, truncateAll } from './helpers';
it('baseline migration creates v1 tables', async () => {
  await truncateAll();
  const u = await db.user.create({ data: { email: 'a@b.c', passwordHash: 'x' } });
  expect(u.id).toBeTruthy();
});
```

- [ ] **Step 4: Run** `npm run test:db` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(1a): adopt prisma migrate with v1 baseline + DB test harness`

---

### Task 2: Enums, User OIDC identity, visibility/soft-delete fields

**Files:**
- Modify: `prisma/schema.prisma`
- Create: migration `v2-enums-identity-visibility`, `tests/db/identity-visibility.test.ts`

**Interfaces:**
- Produces (Prisma enums used by all later tasks — names verbatim):
  `JudgeClass { prompted_api prompted_open_weight finetuned_judge_lm sequence_classifier_rm generative_rm specialized_safety specialized_factuality }` ·
  `ScoringMechanism { reward_head_scalar token_probability critique_generative }` ·
  `ServingBackend { anthropic openai openrouter vllm ollama }` ·
  `Quantization { none fp8 int8 int4 }` · `ReasoningMode { none optional always }` ·
  `TrustState { untrusted calibrating trusted rejected }` ·
  `RunProtocol { pointwise pairwise listwise }` ·
  `RunStatus { pending judging needs_human completed error }` ·
  `JudgmentStatus { pending running completed error }` · `Visibility { private public }`
- Produces on User: `oidcIssuer String?`, `oidcSubject String?`, `@@unique([oidcIssuer, oidcSubject])`
- Produces on Rubric: `visibility Visibility @default(private)`, `publishedAt DateTime?`, `retiredAt DateTime?`, `@@unique([parentId, version])`
- Produces on Project: `visibility Visibility @default(private)`, `publishedAt DateTime?`

- [ ] **Step 1: Failing test** — create two rubric versions with same `(parentId, version)` → expect P2002; create user with `(issuer, sub)` twice → P2002; `visibility` defaults `private`.
```ts
// tests/db/identity-visibility.test.ts
it('rubric (parentId, version) is unique', async () => {
  const u = await mkUser(); const root = await mkRubric(u.id, { version: 1 });
  await db.rubric.create({ data: { name: 'v2', version: 2, parentId: root.id, userId: u.id } });
  await expect(db.rubric.create({ data: { name: 'dup', version: 2, parentId: root.id, userId: u.id } }))
    .rejects.toMatchObject({ code: 'P2002' });
});
```
(`mkUser`/`mkRubric` fixture helpers added to `tests/db/helpers.ts` — plain `db.create` wrappers with unique emails.)

- [ ] **Step 2: Run — fails** (columns don't exist).
- [ ] **Step 3: Edit schema, generate migration** `npx prisma migrate dev --name v2-enums-identity-visibility`. Existing status String columns are NOT converted yet (Task 4 does Run/Judgment enums with USING casts).
- [ ] **Step 4: Run** `npm run test:db` — PASS.
- [ ] **Step 5: Commit** `feat(1a): v2 enums, user OIDC identity, visibility + rubric version constraint`

---

### Task 3: Judge identity tables + prompt templates + seed

**Files:**
- Modify: `prisma/schema.prisma`, `prisma/seed.ts`
- Create: migration `v2-judge-identity`, `tests/db/judge-identity.test.ts`

**Interfaces (verbatim — later tasks and 1b depend on these):**
```prisma
model JudgeModel {
  id String @id @default(cuid())
  name String
  slug String @unique
  judgeClass JudgeClass
  scoringMechanism ScoringMechanism
  baseModel String?
  paramsB Float?
  contextLength Int?
  trainingRecipe String?   // prompted|sft|dpo|rlvr|mixed
  license String?
  licenseNote String?
  modality String @default("text")
  taxonomyMode String?     // fixed | policy_conditioned
  streamingCapable Boolean @default(false)
  retiredAt DateTime?
  versions JudgeModelVersion[]
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
model JudgeModelVersion {
  id String @id @default(cuid())
  judgeModelId String
  judgeModel JudgeModel @relation(fields: [judgeModelId], references: [id], onDelete: Restrict)
  ordinal Int
  weightsRevision String?
  quantization Quantization @default(none)
  quantMethod String?
  servingBackend ServingBackend
  endpointClass String?
  trainingDataVintage DateTime?
  parentVersionId String?
  parentVersion JudgeModelVersion? @relation("VersionLineage", fields: [parentVersionId], references: [id], onDelete: NoAction, onUpdate: NoAction)
  successors JudgeModelVersion[] @relation("VersionLineage")
  reasoningMode ReasoningMode @default(none)
  samplingDefaults Json?
  protocolSupport Json      // {"pointwise":["score"],"pairwise":["selection"],...}
  supportsRubricAnchored Boolean @default(true)
  trustState TrustState @default(untrusted)
  retiredAt DateTime?
  createdAt DateTime @default(now())
  endpoints ModelEndpoint[]
  judgments ModelJudgment[]
  calibrationRuns CalibrationRun[]
  @@unique([judgeModelId, ordinal])
}
model ModelEndpoint {
  id String @id @default(cuid())
  userId String
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  judgeModelVersionId String
  judgeModelVersion JudgeModelVersion @relation(fields: [judgeModelVersionId], references: [id], onDelete: Restrict)
  endpoint String?
  apiKeyEnc String?
  isActive Boolean @default(true)
  verifiedAt DateTime?
  archFingerprint Json?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@index([userId])
  @@index([judgeModelVersionId])
}
model PromptTemplate {
  id String @id @default(cuid())
  name String
  protocol RunProtocol
  version Int
  body String
  createdAt DateTime @default(now())
  judgments ModelJudgment[]
  @@unique([name, version])
}
```
- Produces: seed rows — PromptTemplate `{ name: 'v1-legacy', protocol: pointwise, version: 0, body: <the exact current system prompt string copied from src/lib/llm/provider.ts:83 buildJudgmentSystemPrompt template> }`.

- [ ] **Step 1: Failing tests** — version immutability is app-level, so DB tests cover: `(judgeModelId, ordinal)` P2002; `JudgeModel.delete` with versions → P2003 (Restrict); seed template exists after `db:seed`.
- [ ] **Step 2: Run — fails.**
- [ ] **Step 3: Schema edit + `migrate dev --name v2-judge-identity` + seed addition.**
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** `feat(1a): judge identity tables (JudgeModel/Version/Endpoint), versioned prompt templates`

---

### Task 4: ModelJudgment v2 + EvaluationRun v2 + RunCandidate + drop ApiKeyStore

**Files:**
- Modify: `prisma/schema.prisma`
- Create: migration `v2-judgment-run-provenance` (hand-edited), `tests/db/judgment-provenance.test.ts`

**Interfaces:**
- ModelJudgment gains (all consumed by importer Task 8 and by 1b):
  `judgeModelVersionId String?` (+relation `onDelete: Restrict`), `promptTemplateId String?` (+relation Restrict), `samplingParams Json?`, `reasoningEnabled Boolean?`, `pairOrder String?`, `inputTokens Int?`, `outputTokens Int?`, `servedModelId String?`, `finishReason String?`, `parseMode String?`, `startedAt DateTime?`, `attemptCount Int @default(0)`, `updatedAt DateTime @updatedAt`; `criteriaScores` → `Json?`; `status` → `JudgmentStatus @default(pending)`; `@@unique([runId, judgeModelVersionId, pairOrder])`.
  **`modelConfigId` relation changes `onDelete: Cascade` → `Restrict`** (provenance BLOCKER) and stays until 1b retires ModelConfig.
- EvaluationRun gains: `protocol RunProtocol @default(pointwise)`, `deadlineAt DateTime?`, `finalizedAt DateTime?`; `status` → `RunStatus @default(pending)`; rubric relation `SetNull` → **`Restrict`**; `triggeredById` becomes `String?` with `onDelete: SetNull` (P1.7 anonymize path).
- New: `model RunCandidate { id String @id @default(cuid()); runId String; run EvaluationRun @relation(fields: [runId], references: [id], onDelete: Cascade); position Int; promptText String?; responseText String?; label String?; @@unique([runId, position]) }`
- `ApiKeyStore` model **deleted** (dead code + plaintext column finding); its one import in `src/lib/llm/index.ts` (if any remains) removed.
- HumanJudgment: `criteriaScores` → `Json?`.

- [ ] **Step 1: Failing tests** — duplicate `(runId, judgeModelVersionId, pairOrder)` → P2002 while two NULL-version rows coexist (NULLs distinct); deleting a rubric pinned by a run → P2003; deleting a user nulls `triggeredById` but keeps the run; `criteriaScores` accepts a JS object and round-trips.
- [ ] **Step 2: Run — fails.**
- [ ] **Step 3: Schema edit + `migrate dev --create-only --name v2-judgment-run-provenance`; hand-edit the generated SQL:** replace the `criteriaScores` column swap with
```sql
ALTER TABLE "ModelJudgment" ALTER COLUMN "criteriaScores" TYPE JSONB USING "criteriaScores"::jsonb;
ALTER TABLE "HumanJudgment" ALTER COLUMN "criteriaScores" TYPE JSONB USING "criteriaScores"::jsonb;
ALTER TABLE "EvaluationRun" ALTER COLUMN "status" TYPE "RunStatus" USING "status"::"RunStatus";
ALTER TABLE "ModelJudgment" ALTER COLUMN "status" TYPE "JudgmentStatus" USING "status"::"JudgmentStatus";
```
then `migrate dev` to apply. Grep the codebase for `JSON.parse(...criteriaScores` / `JSON.stringify` writes to these columns and update the ~6 call sites (`src/lib/export.ts`, `model-judgment-card` API payloads, `human-judgment` routes) to pass objects — Prisma `Json` returns objects now.
- [ ] **Step 4: Run `npm run test:db` AND `npm test` (unit suite catches the JSON call-site changes) — PASS.**
- [ ] **Step 5: Commit** `feat(1a): judgment/run provenance columns, idempotency key, Restrict semantics, JSONB`

---

### Task 5: Meta-eval tables (GoldenSet/GoldenItem/GoldenLabel/CalibrationRun)

**Files:**
- Modify: `prisma/schema.prisma`
- Create: migration `v2-meta-eval`, `tests/db/meta-eval.test.ts`

**Interfaces (verbatim):**
```prisma
model GoldenSet {
  id String @id @default(cuid())
  name String
  description String?
  visibility Visibility @default(private)
  ownerId String?
  owner User? @relation(fields: [ownerId], references: [id], onDelete: SetNull)
  items GoldenItem[]
  calibrationRuns CalibrationRun[]
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
model GoldenItem {
  id String @id @default(cuid())
  goldenSetId String
  goldenSet GoldenSet @relation(fields: [goldenSetId], references: [id], onDelete: Cascade)
  index Int
  inputText String
  promptText String?
  responseText String?
  protocol RunProtocol @default(pointwise)
  expected String?
  labels GoldenLabel[]
  @@unique([goldenSetId, index])
}
model GoldenLabel {
  id String @id @default(cuid())
  goldenItemId String
  goldenItem GoldenItem @relation(fields: [goldenItemId], references: [id], onDelete: Cascade)
  annotatorId String?
  annotator User? @relation(fields: [annotatorId], references: [id], onDelete: SetNull)
  overallScore Float
  criteriaScores Json?
  reasoning String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@unique([goldenItemId, annotatorId])
}
model CalibrationRun {
  id String @id @default(cuid())
  judgeModelVersionId String
  judgeModelVersion JudgeModelVersion @relation(fields: [judgeModelVersionId], references: [id], onDelete: Restrict)
  goldenSetId String
  goldenSet GoldenSet @relation(fields: [goldenSetId], references: [id], onDelete: Restrict)
  kappa Float?
  rawAgreement Float?
  testRetest Float?
  positionBias Float?
  biasSensitivityRate Float?
  flipRateVsParent Float?
  verdictCount Int @default(0)
  passed Boolean?
  startedAt DateTime @default(now())
  finishedAt DateTime?
}
```

- [ ] **Step 1: Failing test** — multi-annotator: two labels on one item by different users OK, same user twice → P2002; deleting a golden set with a CalibrationRun → P2003.
- [ ] **Step 2–4: migrate dev `v2-meta-eval`, run, PASS.**
- [ ] **Step 5: Commit** `feat(1a): meta-eval tables (golden sets, labels, calibration runs)`

---

### Task 6: User-deletion service (P1.7 split) 

**Files:**
- Create: `src/lib/account-deletion.ts`, `tests/db/account-deletion.test.ts`
- Modify: `src/app/api/` — no route exposes this yet (admin flow is 1b); service + tests only.

**Interfaces:**
- Produces: `export async function deleteUserAccount(userId: string, opts: { archiveUserId: string }): Promise<{ purged: Record<string, number>; reassigned: Record<string, number> }>`
  Semantics: in one transaction — private projects/datasets/rubrics/golden-sets (visibility `private`) **hard-delete** (cascades take evaluations/runs/judgments with them: a private artifact's provenance belongs to its owner); `public` artifacts **reassign** `userId/ownerId` to `archiveUserId`; runs' `triggeredById` → null via FK; ModelEndpoints delete (cascade); finally the User row deletes.

- [ ] **Step 1: Failing tests** — user with 1 private + 1 public project: after deletion, private project gone (and its runs), public project owned by archive user, run.triggeredById null, user row gone. Counts returned match.
- [ ] **Step 2: Run — fails (module missing).**
- [ ] **Step 3: Implement** (single `db.$transaction`; deletes ordered private-artifacts → reassigns → user).
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** `feat(1a): account-deletion service — private purge, public anonymize (P1.7)`

---

### Task 7: Importer scaffolding — frozen v1 client + CLI + report mode

**Files:**
- Create: `prisma/v1/schema.v1.prisma` (copy of pre-Task-2 `schema.prisma` with `generator client { provider = "prisma-client-js", output = "../../node_modules/@prisma/v1-client" }` and `datasource db { url = env("V1_DATABASE_URL") }`), `scripts/importer/cli.ts`, `scripts/importer/context.ts`, `tests/importer/cli.test.ts`
- Modify: `package.json` (`"import:v1": "tsx scripts/importer/cli.ts"`, `"db:generate:v1": "prisma generate --schema prisma/v1/schema.v1.prisma"`), `docker-compose.yml` (add `postgres-v1-scratch` service on 5433, dev profile)

**Interfaces:**
- Produces: `context.ts` exports `export interface ImportCtx { v1: V1PrismaClient; v2: PrismaClient; mode: 'report' | 'apply'; ownerMap: OwnerMap; report: ImportReport }`;
  `export type OwnerMap = Record<string, { email: string; oidcIssuer: string; oidcSubject: string } | 'archive' | 'drop'>`;
  `export class ImportReport { add(entity: string, action: 'created'|'skipped'|'dropped', n?: number): void; counts(): Record<string, Record<string, number>>; }`
- CLI: `npm run import:v1 -- --mode=report --owner-map=owners.json` (mode defaults to `report`; `apply` refuses to run if v2 DB has any Project rows unless `--force`).

- [ ] **Step 1: Failing test** — CLI arg parsing: no args → mode report; `--mode=apply` without `--owner-map` → exit error; report object accumulates counts.
- [ ] **Step 2–4: implement, run, PASS** (pure-unit; no DBs needed for this task's tests).
- [ ] **Step 5: Commit** `feat(1a): importer scaffolding — frozen v1 client, CLI, report mode`

---

### Task 8: Importer — judge synthesis + owner resolution

**Files:**
- Create: `scripts/importer/judges.ts`, `scripts/importer/owners.ts`, `tests/importer/judges.test.ts`, `tests/importer/owners.test.ts`

**Interfaces:**
- `owners.ts` produces: `export async function resolveOwners(ctx: ImportCtx): Promise<Map<string, string /* v2 userId */>>` — for each v1 user id in `ownerMap`: mapped entry → find-or-create v2 User by `(oidcIssuer, oidcSubject)` (email set, passwordHash `'!imported-oidc-only'`); `'archive'` → the archive user (find-or-create `archive@judgearena.local`); `'drop'` → absent from map (callers treat missing = drop private / archive public).
- `judges.ts` produces: `export async function synthesizeJudges(ctx: ImportCtx, owners: Map<string,string>): Promise<Map<string, { versionId: string; endpointIdByUser: Map<string,string> }>>` keyed by v1 `ModelConfig.id`. Grouping: distinct `(provider, modelId, endpoint ?? '')` → one JudgeModel (`slug` = slugified `provider-modelId`, `judgeClass`: provider `anthropic|openai` → `prompted_api`, `local` → `prompted_open_weight`; `scoringMechanism: critique_generative`) + one JudgeModelVersion (`ordinal: 1`, `weightsRevision: 'v1-unknown'`, `servingBackend`: provider `local` → `vllm`? **No — honest mapping: `local` → `ollama`** is wrong too; v1 'local' endpoints are unknown OpenAI-compatible servers → `servingBackend: openai`, `endpointClass: 'v1-local-unknown'`, `protocolSupport: {"pointwise":["score"]}`, `samplingDefaults`: the v1 literals `{ temperature: 0.3, max_tokens: 2048 }` from `src/lib/llm/anthropic.ts:49`) + one ModelEndpoint per owning v1 user (apiKeyEnc **not** copied — keys re-entered per Phase 2 runbook; `isActive` carried; `verifiedAt: null`).
- In `report` mode both functions write counts only (no v2 writes) — they consult `ctx.mode` before every create.

- [ ] **Step 1: Failing tests** — fixture v1 rows (three ModelConfigs, two identical `(provider,modelId,endpoint)` across two users) → 2 JudgeModels, 2 Versions, 3 Endpoints; drop-user's endpoint absent; report mode writes nothing (v2 counts stay 0).
- [ ] **Step 2–4: implement, run `npm run test:db -- tests/importer` variant (needs both DBs; fixtures inserted via v1 client against the scratch DB), PASS.**
- [ ] **Step 5: Commit** `feat(1a): importer judge synthesis + owner resolution`

---

### Task 9: Importer — artifacts + runs/judgments mappers

**Files:**
- Create: `scripts/importer/artifacts.ts` (projects, rubrics+criteria, datasets+samples), `scripts/importer/runs.ts` (evaluations, runs, model judgments, human judgments), `tests/importer/artifacts.test.ts`, `tests/importer/runs.test.ts`

**Interfaces:**
- `artifacts.ts`: `export async function importArtifacts(ctx, owners): Promise<IdMaps>` where `export interface IdMaps { project: Map<string,string>; rubric: Map<string,string>; criterion: Map<string,string>; dataset: Map<string,string>; sample: Map<string,string>; evaluation: Map<string,string> }` — v1 id → v2 id. Rubric criteria import **with** their parent rubric (id remap recorded — this is what fixes the dangling-cuid export finding); rubric `parentId`/`version` lineage preserved; unmapped-owner private artifacts dropped (report `dropped`), public → archive user.
- `runs.ts`: `export async function importRuns(ctx, owners, ids: IdMaps, judges): Promise<void>` — every v1 EvaluationRun → v2 with `protocol: 'pointwise'`, status cast, `finalizedAt: updatedAt` for terminal rows; every v1 ModelJudgment → v2 with `judgeModelVersionId` from the judges map, `promptTemplateId` = the `v1-legacy` v0 template id, `samplingParams: { temperature: 0.3, max_tokens: 2048, source: 'v1-defaults' }`, `pairOrder: null`, `criteriaScores`: parse the v1 string then **remap criterionIds through `ids.criterion`**; HumanJudgment with `annotator`-equivalent `userId` through owners (drop-user labels → archive). Stuck v1 rows (`pending`/`judging` older than 24h) import as `error` with `error: 'v1-import: stranded'`.

- [ ] **Step 1: Failing tests** — fixture: 1 project, rubric v1+v2 chain, 1 dataset (2 samples), 2 evaluations, 2 runs (one completed w/ 2 judgments + human judgment, one stranded `judging`), across mapped+dropped users. Assert: id-map completeness, criterion remap inside criteriaScores JSON, stranded→error, judgment unique key holds, report counts match fixture arithmetic.
- [ ] **Step 2–4: implement, run, PASS.**
- [ ] **Step 5: Commit** `feat(1a): importer artifact + run/judgment mappers with provenance defaults`

---

### Task 10: Importer — reconciliation report + verification gate

**Files:**
- Create: `scripts/importer/reconcile.ts`, `tests/importer/reconcile.test.ts`
- Modify: `scripts/importer/cli.ts` (wire phases: owners → judges → artifacts → runs → reconcile; print report)

**Interfaces:**
- `reconcile.ts`: `export async function reconcile(ctx, ids): Promise<ReconcileResult>` with `export interface ReconcileResult { rowCounts: Array<{ entity: string; v1: number; v2: number; expectedDelta: number; ok: boolean }>; spotChecks: Array<{ name: string; ok: boolean; detail: string }>; ok: boolean }`.
  Row counts per entity (v1 count minus reported drops must equal v2 count). Spot checks (each a single SQL/Prisma query): (1) every v2 ModelJudgment has non-null `judgeModelVersionId` + `promptTemplateId`; (2) no criteriaScores JSON contains a criterionId absent from RubricCriterion; (3) leaderboard aggregate diff vs v1 recomputation is explainable by the documented double-count fix (report both numbers); (4) zero v2 rows owned by v1 user ids.
- CLI exit code: `apply` mode exits non-zero if `reconcile().ok === false` — **this is the program-doc abort criterion in code.**

- [ ] **Step 1: Failing tests** — inject one deliberate mismatch (delete a v2 judgment post-import in fixture) → `ok:false` with the right entity row; clean fixture → `ok:true`.
- [ ] **Step 2–4: implement, run, PASS.**
- [ ] **Step 5: Commit** `feat(1a): importer reconciliation gate (row counts + provenance spot-checks)`

---

### Task 11: Correctness — human overallScore null-vs-0

**Files:**
- Modify: `src/app/api/evaluations/[id]/runs/[runId]/human-judgment/route.ts:101`
- Create: `tests/db/human-judgment-score.test.ts`

- [ ] **Step 1: Failing test** — POST payload without `overallScore` but with criteria scores: stored `overallScore` equals the weighted recomputation from criteria (via `computeWeightedScore` from `src/lib/utils.ts`), not `0`; payload with neither → 400, no row.
- [ ] **Step 2: Run — fails (current code coerces to 0).**
- [ ] **Step 3: Fix** — replace the `?? 0` coercion: if `overallScore` absent, compute from `criteriaScores` weights; if both absent, return `NextResponse.json({ error: 'overallScore or criteriaScores required' }, { status: 400 })`.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** `fix(1a): human judgment — recompute missing overallScore, reject empty (critique: correctness)`

---

### Task 12: Correctness — dataset refresh clobber

**Files:**
- Modify: `src/app/api/datasets/[id]/refresh/route.ts:51`
- Create: `tests/db/dataset-refresh.test.ts`

- [ ] **Step 1: Failing test** — dataset with existing `remoteMetadata.evaluationSummary` and local `sampleCount: 5`; refresh with HF fixture reporting corpus total 1000: summary key survives, `sampleCount` stays 5 (local samples are the truth), HF fields updated.
- [ ] **Step 2: Run — fails (wholesale overwrite).**
- [ ] **Step 3: Fix** — merge: `remoteMetadata: { ...freshHfMeta, evaluationSummary: existing?.evaluationSummary }`; drop the `sampleCount` overwrite (derive from `_count.samples`).
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** `fix(1a): dataset refresh preserves evaluation summary and local sample count`

---

### Task 13: Correctness — rubric version numbering under transaction

**Files:**
- Modify: `src/app/api/rubrics/[id]/versions/route.ts:88`
- Create: `tests/db/rubric-version-race.test.ts`

- [ ] **Step 1: Failing test** — fire two concurrent version-create requests (Promise.all on the route handler with same rubric): exactly one gets version N+1, the other N+2 (retry) — no duplicates (the Task-2 `@@unique([parentId, version])` makes the race deterministic).
- [ ] **Step 2: Run — fails intermittently pre-fix (loop 20× in test to force).**
- [ ] **Step 3: Fix** — wrap read-max+create in `db.$transaction`, catch P2002 → retry once with recomputed max (bounded, 3 attempts).
- [ ] **Step 4: Run — PASS (loop stable).**
- [ ] **Step 5: Commit** `fix(1a): rubric version numbering transactional with unique-constraint retry`

---

### Task 14: Correctness — leaderboard latest-run aggregation + indexes

**Files:**
- Modify: `src/app/api/leaderboard/route.ts:44`, `prisma/schema.prisma` (indexes)
- Create: migration `v2-leaderboard-indexes`, `tests/db/leaderboard.test.ts`

**Interfaces:**
- Index: `@@index([evaluationId, createdAt])` on EvaluationRun; `@@index([modelConfigId, status])` on ModelJudgment (1b swaps to judgeModelVersionId when required).
- Aggregation rule (also used by importer reconcile check 3): per evaluation, only the **latest finalized** run's judgments count.

- [ ] **Step 1: Failing test** — evaluation with two completed runs (re-run): model's leaderboard average uses only the newer run's judgment; old-run judgment excluded.
- [ ] **Step 2: Run — fails (all runs counted today).**
- [ ] **Step 3: Fix** — query latest finalized run ids first (`SELECT DISTINCT ON (evaluationId) id ... ORDER BY evaluationId, createdAt DESC` via `$queryRaw` or groupBy+max), then aggregate judgments within those ids; add the migration for indexes.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** `fix(1a): leaderboard counts latest finalized run per evaluation; composite indexes`

---

### Task 15: Correctness — dataset version POST validates samples payload

**Files:**
- Modify: `src/app/api/datasets/[id]/versions/route.ts:77`
- Create: `tests/db/dataset-version-samples.test.ts`

- [ ] **Step 1: Failing test** — POST new version with `samples: "not-an-array"` → 400, no version row created; with valid samples array → new version carries the new samples, not duplicates of the old ones.
- [ ] **Step 2: Run — fails (invalid payload silently ignored, old samples duplicated).**
- [ ] **Step 3: Fix** — zod-validate `samples` (array of `{ input, expected?, metadata? }`) when present → 400 on parse failure; only fall back to copying prior samples when the key is genuinely absent.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** `fix(1a): dataset version creation validates samples payload (critique: correctness)`

---

## Self-review checklist (run after drafting)

Spec §3.1 ✅ Tasks 2–4 · §3.2 ✅ Task 5 · §3.3 ✅ Task 2 · §3.4 ✅ Task 1 (+hand-edited SQL Task 4) · §7 OIDC columns ✅ Task 2 (v5 condition: (issuer,sub) ours) · §8 ✅ Tasks 7–10 · correctness 1a roster ✅ Tasks 11–14 · P1.6 ✅ Task 3 · P1.7 ✅ Tasks 4+6. Deferred to 1b (explicit): status-enum tightening of `judgeModelVersionId` to required, ModelConfig retirement, PII serializers, all queue/provider/auth work.

## Finding dispositions

The literal 1:1 BLOCKER/MAJOR table lives in
`docs/superpowers/plans/2026-07-24-finding-dispositions.md` (generated from the
verified critique JSON; every row names its 1a task or its 1b plan section).
