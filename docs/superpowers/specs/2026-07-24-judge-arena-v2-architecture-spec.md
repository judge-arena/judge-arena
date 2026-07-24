# Judge Arena v2 — Architecture Spec (Phase 1)

**Date:** 2026-07-24 · **Status:** Draft for review (Sonnet gate → Trijeet approval)
**Inputs:** program design (`2026-07-22-judge-arena-v2-program-design.md`, D1–D7 +
2026-07-24 decisions) · judge-model inventory §7 (schema contract) ·
v1 critique (`docs/research/2026-07-judge-arena-v1-critique.md`, 143 verified findings)
**Exit criteria:** S2 (full judgment provenance) + S4 (≥2-replica correctness)
demonstrable via docker-compose before Phase 2.

---

## 1. Scope

Phase 1 rebuilds judge-arena's core around four seams while keeping the product
behavior recognizable: (a) **schema v2** — immutable judge-model versioning +
full judgment provenance + meta-eval tables; (b) **runtime split** — stateless
web tier + RabbitMQ judge workers + Redis-backed shared state; (c) **provider
layer v2** — descriptor registry, OpenRouter + vLLM, structured output,
metadata capture; (d) **auth v2** — Authentik OIDC + public-read/gated-write
access model. Plus the **v1→v2 importer** (gates Phase 2) and the build/CI
rework. README rewrite lands with implementation.

**Out of scope:** meta-eval harness *features* (Phase 3 — but its tables land
now, D7); cluster manifests/Gitea migration (Phase 2); multi-region; listwise
protocol UI (schema supports it; UI ships pairwise+pointwise only).

## 2. New decisions made in this spec

| # | Decision | Choice | Why |
|---|---|---|---|
| P1.1 | Framework/auth upgrade | **Next 15 + Node 22 LTS; next-auth stays v4** | Next 14.2 EOL with unpatched 2026 CVEs; node:20 past EOL. Auth stays on next-auth v4 (Next-15-compatible) per the deps-build finding's own recommendation — the Authentik OIDC provider works on v4, and coupling an Auth.js v5 migration to the auth rewrite doubles 1b risk; revisit v5 at GA as a standalone upgrade. Prisma stays 6 (defer 7). SDK majors used by rewritten code upgraded (openai, @anthropic-ai/sdk, redis). |
| P1.2 | Queue granularity | **Two message types: `run.create` + `judgment.execute` (one per run × judge-version × pair-order)** | Whole-run messages create long unacked windows and coarse redelivery blast radius (queue-readiness). Per-judgment messages make redelivery idempotent at the judgment unique key. |
| P1.3 | Queue tech shape | **RabbitMQ quorum queues, manual ack, prefetch-bounded, TTL-based delayed retry (bounded attempts) → DLQ** | Program decision (RabbitMQ); topology per §5. |
| P1.4 | GPU-seam transport | **Static bearer token (vLLM `--api-key`) over TLS from the internal CA (`lab-internal-ca`), internal DNS name, CCNP-scoped egress** | Single-tenant seam; mTLS adds cert-rotation machinery without a present threat model. Revisit if the seam ever serves >1 consumer. Token in SOPS-encrypted secret. |
| P1.5 | Importer source | **v1 Postgres snapshot (pg_dump), not the JSONL/config exports** | Export-import findings: JSONL lacks owner identity, judgment ids, dedup keys; criterion cuids dangle after config import. D4's *intent* (keep research artifacts, drop accounts) is preserved — the mechanism reads v1 tables directly. **Flagged for Trijeet sign-off as a D4 mechanism amendment.** |
| P1.6 | Judge identity model | **Three-level: `JudgeModel` (catalog) → `JudgeModelVersion` (immutable pin) → `ModelEndpoint` (user credentials/endpoint)** | §7 requires immutable versions; users still need mutable connection config (key rotation ≠ new judge version). Judgments FK the *version*, `onDelete: Restrict`. |
| P1.7 | Deletion semantics | **Provenance entities never hard-delete: `retiredAt` soft-delete on catalog entities *and* rubrics; user deletion is split — fully-private artifacts Cascade (real purge, per privacy posture), public/leaderboard-visible artifacts anonymize (owner → SetNull)** | schema-fit: v1 user-deletion cascade wipes all runs/judgments; rubric SetNull severs provenance. Blanket anonymize would deny users a true private-data purge — the split honors both provenance and privacy-minimization. |
| P1.8 | Structured output | **Per-provider capability flag; guided/JSON-schema decoding where supported (vLLM guided_choice, OpenAI/OpenRouter json_schema, Anthropic tool-use); lenient parser retained only as explicit fallback, recorded per judgment** | provider-layer: free-JSON + zero-fill parse hides failures; §8.3 of inventory: unconstrained compliance ≤72%. |
| P1.9 | Redis posture | **Mandatory in production; `noeviction`; fail-fast at startup if absent; silent in-memory fallbacks removed** | replica-safety: silent memory fallback on bus; deps-build: allkeys-lru would evict breaker/limiter state. |
| P1.10 | Scope valve | **Exercised: implementation splits 1a (schema + importer + correctness core) / 1b (queue + providers + auth + build)** — single spec, two implementation plans | 143 findings say this is too big for one review cycle. |

## 3. Schema v2

### 3.1 Judge identity & provenance (§7 contract)

```
JudgeModel            — catalog entry (name, judgeClass, scoringMechanism, baseModel,
                        paramsB, contextLength, trainingRecipe, license + licenseNote,
                        modality, taxonomyMode?, streamingCapable?, retiredAt?)
JudgeModelVersion     — IMMUTABLE (judgeModelId, semver/ordinal, weightsRevision,
                        quantization {none,fp8,int8,int4}+method, servingBackend
                        {anthropic,openai,openrouter,vllm,ollama}, endpointClass,
                        trainingDataVintage?, parentVersionId?, reasoningMode
                        {none,optional,always}, samplingDefaults JSONB,
                        protocolSupport JSONB {pointwise,pairwise,listwise}×{score,ranking,selection},
                        supportsRubricAnchored, trustState {untrusted,calibrating,trusted,rejected},
                        createdAt; retiredAt?; NO mutable fields post-creation)
ModelEndpoint         — per-user connection (userId, judgeModelVersionId, endpoint?,
                        apiKeyEnc?, isActive, verifiedAt, archFingerprint JSONB)
PromptTemplate        — versioned judge prompt (protocol, body, version, createdAt);
                        seeded with v1-legacy as version 0
```

- **ModelJudgment v2:** + `judgeModelVersionId` (Restrict), `promptTemplateId`
  (Restrict), `samplingParams` JSONB (effective, as-sent), `reasoningEnabled`,
  `pairOrder` (`AB`|`BA`|null), `inputTokens`/`outputTokens` (split),
  `servedModelId`, `finishReason`, `parseMode` (structured|fallback),
  `criteriaScores` → **JSONB**, `updatedAt`, `startedAt`, `attemptCount`;
  **unique (runId, judgeModelVersionId, pairOrder)** — the queue idempotency
  key. *(Listwise, when its UI ships, extends this key with a permutation
  column via a cheap additive migration — acceptable because listwise is
  explicitly out of Phase 1 UI scope.)*
- **EvaluationRun v2:** + `protocol` (pointwise default; pairwise via
  `RunCandidate` rows), `rubricVersionId` Restrict (not SetNull), typed
  status enum, `deadlineAt` (reaper input), `finalizedAt`.
- v1 `ModelConfig` rows migrate to synthesized JudgeModel/Version/Endpoint
  triples (see §8).

### 3.2 Meta-eval tables (Phase 3 features, Phase 1 schema — D7)

```
GoldenSet (visibility, ownerId, description)
GoldenItem (goldenSetId, input/promptText/responseText, protocol, expected?)
GoldenLabel (goldenItemId, annotatorId, criteriaScores JSONB, overallScore)   — multi-annotator
CalibrationRun (judgeModelVersionId, goldenSetId, kappa, rawAgreement,
                testRetest, positionBias, biasSensitivityRate?, flipRateVsParent?,
                verdictCount, startedAt/finishedAt, passed)
```

`trustState` transitions only via CalibrationRun results; version supersession
allowed, never silent (schema-fit finding: v1's only trust flag is
connectivity). **In Phase 1, `trustState` is informational only** (badge in
UI) — ordinary judging remains fully usable while every version sits at
`untrusted`; gating behavior arrives with the Phase 3 harness, opt-in per
project. D6's "earns trust before use" applies from Phase 3 onward.

### 3.3 Access model fields

`visibility {private,public}` + `publishedAt` on **Rubric** (new — schema-fit
MAJOR), Dataset (exists), Project, GoldenSet. Public payload serializers strip
owner PII (email leak finding).

### 3.4 Migration mechanics

Adopt `prisma migrate` with a **baseline migration** (none exists today —
deps-build BLOCKER); Postgres enums for status/class fields; migrations run as
a **one-shot Job/compose service**, never in container CMD (deps-build
BLOCKER); leaderboard composite indexes + latest-run-per-evaluation semantics
(correctness: double-counted re-runs). Transition note: existing
`db push`-managed dev/CI databases are **wiped** (volumes recreated) rather
than baselined with `migrate resolve` — nothing durable lives in them; the
Railway production DB is never migrated in place (it is only ever *read* via
the §8 importer, and the cluster DB starts fresh from migrations).

## 4. Runtime topology

```
                    ┌─ web (Next 15, N replicas, stateless) ── SSE ⇦ Redis pub/sub
 client ─ ingress ──┤
                    └─ POST /judge → tx: create run+judgment rows (pending)
                          → publish judgment.execute × M (publisher-confirms)
 RabbitMQ (quorum) ── judge-worker (K replicas, same image, worker entrypoint)
                          → claim judgment (status guard) → provider call
                          → persist result → publish progress event (Redis)
                          → finalize run from DB aggregate (transactional guard)
 reaper (worker-embedded, Redis-lock singleton) ── re-queues/errors runs past deadlineAt
```

- **Shared state → Redis (P1.9):** realtime bus (only production adapter;
  memory adapter test-only), rate limiting (atomic Lua sliding window, one
  limiter — the middleware's second in-memory limiter is deleted), circuit
  breaker (Lua transitions, single half-open probe lock).
- **Idempotency:** `judgment.execute` redelivery hits the unique key + status
  guard — claim is a conditional update (`pending→running`, sets `startedAt`,
  increments `attemptCount`); completed judgments ack-and-skip. **Stale-claim
  reclaim:** a judgment in `running` whose `updatedAt` is older than the
  judgment lease threshold (provider timeout + grace) is reclaimable by the
  same conditional-update path — covering consumer crash *after* claim but
  before persist. `run.create` expansion is on-conflict-safe (`createMany
  skipDuplicates` / P2002 → ack-and-skip), so its redelivery is also
  idempotent. **Run finalization is transactional and race-proof:** the
  finishing worker takes `SELECT … FOR UPDATE` on the run row, recomputes the
  judgment aggregate inside the transaction, and applies a guarded status
  transition — two concurrently-finishing judgments serialize on the row lock,
  exactly one finalizes (dual-completion race test in §10);
  `completed → needs_human` regression fixed by the same guards. The reaper
  covers both levels: run `deadlineAt` and judgment-lease staleness.
- **Retry/DLQ:** typed error taxonomy (retryable / non-retryable /
  rate-limited) from status codes, not message substrings; retryable → TTL
  delay queue (capped attempts); non-retryable (bad rubric, invalid config,
  auth) → judgment `error` + ack; poison cap → DLQ with alert.
- **Message contract excludes credential material** (queue-readiness INFO):
  workers resolve keys from DB/env at execution, judge-version pinned data
  from `JudgeModelVersion`, never live `ModelConfig` reads.
- **SSE v2:** topics scoped `user:{id}` + `run:{id}` (ownership enforced at
  subscribe — today every authenticated user receives all events);
  `Last-Event-ID` resume window via Redis stream (replica-safety MINOR).
- **Prisma pool:** explicit `connection_limit` per replica sized against CNPG
  pooler budget (formula in implementation plan).
- **Correctness roster** (folded from critique; 1a/1b assignment explicit to
  prevent double-work): **1a** — human overallScore null-vs-0; dataset refresh
  clobber; rubric version numbering under transaction + unique constraint;
  leaderboard latest-run-per-evaluation aggregation (+ indexes). **1b**
  (entangled with the queue/provider rewrite) — NaN score normalization
  (provider parse path); dataset summary lost-update (recomputed
  transactionally on run finalization); swallowed batch-run failures
  (surfaced by `run.create` expansion, each failure marks its run `error`).
- **Health/readiness:** `/api/health` (web) and the worker health probe extend
  to Redis and RabbitMQ liveness — an ongoing bus/queue failure fails
  *readiness* (k8s stops routing), not just boot (per the critique's
  Redis-bus fix direction).

## 5. RabbitMQ topology

- Exchange `judge.direct` (direct). Queues: `judgment.execute` (quorum),
  `judgment.retry.30s` / `.5m` (TTL dead-letter back), `judge.dlq` (quorum).
- Publisher confirms on; consumer prefetch = worker LLM concurrency;
  manual ack after DB persist.
- `run.create` for bulk dataset launches: web tier creates evaluation rows
  transactionally then publishes one `run.create` per evaluation; worker
  expands to judgment messages (bulk-launch failures no longer swallowed —
  each expansion failure marks its run `error`).
- Placement (dedicated public-tier RabbitMQ CR vs CCNP to existing bus):
  Phase 2, per program doc.

## 6. Provider layer v2

- **Descriptor registry** (single source: id, kind, baseURL scheme, auth
  scheme, capability flags {structuredOutput, samplingParams, reasoningToggle,
  logprobs}, headers hook for OpenRouter attribution) — replaces the
  4-site hardcoded enum; `verify.ts` folded into the registry (drift finding).
- **Backends:** anthropic (tool-use structured), openai, openrouter
  (OpenAI-compatible + attribution headers; **circuit key = endpoint+model**,
  not endpoint — aggregator finding), vllm (guided_choice/json for the GPU
  seam, P1.4 auth), ollama (interactive/dev only; scored runs refuse it —
  inventory §8.3: 16.6pp stack drift, silent truncation).
- **Key resolution scoped per provider class** — server env keys never sent to
  arbitrary user endpoints (MAJOR: OPENAI_API_KEY leak to user-configured
  URLs); model verify path decrypts before send (MAJOR: ciphertext-as-key).
- **Metadata capture:** served model id, finish reason, token split, latency →
  ModelJudgment columns (§3.1). `verifyModelConnection` returns an
  **architecture fingerprint** (served id, context length, quantization hint
  where the endpoint exposes it) stored on ModelEndpoint.
- **Prompt building** from versioned PromptTemplate rows; submission delimiter
  escaping fixed (MINOR).

## 7. Auth v2 & access matrix

- **Auth.js v5**: Authentik OIDC (primary, invite via Authentik groups) +
  credentials provider (admin-created accounts only; no self-serve).
  `/api/auth/register` **removed**; its 5 UI/infra touchpoints replaced by an
  admin invite flow documented in the runbook. Account linking by OIDC `sub`
  only — the email-fallback session resolution is removed (linking hazard
  finding). JWT sessions: 24h with rolling refresh (closes LOW-35).
- **Non-destructive v5 upgrade path (Trijeet condition, 2026-07-24):** the
  auth design must make the eventual next-auth v4 → Auth.js v5 migration a
  zero-data-loss, re-login-at-worst event, retaining all test and real user
  accounts and their artifacts. Concretely: (a) OIDC identity persisted in
  **our schema** as `(issuer, sub)` on the User record — re-linking under any
  auth library is deterministic, never inferred from adapter internals or
  email; (b) JWT session strategy only — no session rows exist to migrate
  (v5's cookie rename forces re-login, nothing more); (c) `auth-guard`
  resolves users exclusively through our User table (token carries only the
  user id claim) — no v4-internal token-shape coupling in app code;
  (d) credentials users are untouched (`passwordHash` is app-owned).
  Acceptance check in §10: a v5 spike branch logs in as an existing OIDC user
  *and* an existing credentials user with zero schema/data migration.
- **Access matrix** (the D3/2026-07-24 principle, route-by-route in the
  implementation plan): anonymous GET — leaderboard, `visibility: public`
  rubrics/datasets/projects/golden-sets (PII-stripped serializers);
  authenticated + ownership — everything else; every mutation ownership-checked
  via one `auth-guard` path. SSE subscribe ownership-scoped (§4).
- **API keys:** key management requires an interactive session (never a
  scoped key — privilege-escalation finding); scopes enforced on every
  developer-API route.
- `audit()` actually wired to: auth events, key lifecycle, judge-version
  creation/trust transitions, imports (dead-code finding).
- CSP: drop `unsafe-inline` scripts in production via nonces (re-opened item 19).

## 8. v1 → v2 importer (gates Phase 2)

Reads a **v1 pg_dump restored to a scratch database** (P1.5); writes v2 via
Prisma. The v1 side is read through a **frozen `prisma/schema.v1.prisma` with
its own generated client** (separate output dir) — the app's v2 client never
touches the scratch DB. Mapping highlights (full field table in
implementation plan):

- **Judge synthesis:** distinct v1 `(provider, modelId, endpoint)` triples →
  JudgeModel + JudgeModelVersion (`weightsRevision: 'v1-unknown'`,
  `quantization: none`, vintage null, `trustState: untrusted`) + ModelEndpoint
  per owning user. All v1 judgments pin to these synthesized versions —
  honest provenance: *recorded as v1-era, details unknown*.
- **Prompt template:** all v1 judgments → `v1-legacy` PromptTemplate v0.
  Sampling params: the v1 hardcoded literals, recorded explicitly.
- **Protocol:** all v1 runs `pointwise`, `pairOrder: null`.
- **Ownership:** operator-supplied mapping `v1 userId → Authentik identity`
  for kept artifacts (small set — pre-provisioned per Phase 2 runbook);
  unmapped users' private artifacts are dropped (D4), public/leaderboard
  artifacts transfer to a designated archive owner.
- **Verification gate (program doc abort criterion):** row-count
  reconciliation per entity + provenance spot-checks + leaderboard
  before/after diff (allowing the documented double-count fix delta).

## 9. Build, deploy, CI

- **One image, two entrypoints** (`server.js` / `worker.js`), standalone
  output only (dev node_modules dropped from runner — MAJOR); single
  `prisma generate`; Node 22 base.
- **Compose v2** (the S4 demo rig): no `container_name`/static ports on `app`;
  nginx LB in front; `--scale app=2 --scale worker=2`; services: postgres,
  redis (`noeviction`), rabbitmq (management), migrate (one-shot), app,
  worker, nginx. Host-port exposure of postgres/redis removed from the
  production profile.
- **CI (Gitea Actions, raw shell — no JS actions):** lint → typecheck →
  `prisma migrate deploy` against service Postgres (not `db push`) → vitest
  (services: postgres, redis, rabbitmq) → build → Kaniko → Harbor. Coverage
  gate extended to the rewritten subsystems (queue, providers, auth-guard,
  importer). GH workflow retired to mirror-only status.

## 10. Testing & verification

- **Unit:** score normalization (NaN paths), error taxonomy, breaker Lua
  transitions, template rendering, importer mappers, serializer PII-stripping.
- **Integration (compose services in CI):** judgment lifecycle
  (publish→claim→persist→finalize), redelivery idempotency (duplicate +
  mid-run kill + stale-claim reclaim), **concurrent dual-completion
  finalization race** (two judgments finish simultaneously → exactly one
  finalizer wins the row lock, run reaches a terminal state), reaper (both
  run-deadline and judgment-lease levels), SSE ownership scoping + resume,
  rate-limit atomicity across two app replicas, access matrix
  (anonymous/authed/owner × route).
- **S4 demo (exit gate):** compose at `app=2, worker=2`; kill a worker
  mid-run → run completes via redelivery, no duplicate judgments (unique-key
  proof); rolling-restart app → SSE clients on both replicas receive events;
  rate limit holds at configured value (not ×N).
- **S2 demo:** for any judgment row, a single query returns judge version
  (class/revision/quantization/backend), prompt template version, rubric
  version, sampling params, pair order.
- **GPU-seam smoke:** vLLM on gharial (token+TLS), CompassJudger-2-7B bf16,
  guided_choice scoring against a seeded rubric.

## 11. Finding dispositions

All **14 BLOCKERs** land in Phase 1: run-queue → §4/§5 (×3 across dimensions);
in-memory SSE default → §4/P1.9; per-process rate limiting → §4; breaker →
§4/§6; ModelConfig mutability + judgment cascade → §3.1/P1.6/P1.7;
processRun idempotency + queue-items-as-only-record → §4/P1.2; compose
container_name/ports/migrations-in-CMD/no-baseline → §9/§3.4; export owner
identity → §8/P1.5. All 72 MAJORs map to §3–§9 work items. The implementation
plan carries a **literal 1:1 finding→disposition table** (one row per
BLOCKER/MAJOR, independently auditable — not prose buckets);
deferred-with-reason allowed only for MINOR/INFO. Remaining LOW items from v1: 30 (client reuse — §6 registry),
32/36 (dashboard refresh — implementation), 33 (updatedAt — §3.1), 35 (JWT —
§7); 31/34 closed as intended/stale.

## 12. Risks specific to Phase 1

| Risk | Mitigation |
|---|---|
| Next 15 upgrade tangles with the auth/OIDC work | 1b sequences the framework upgrade first on existing behavior (tests green), then the OIDC provider work on next-auth v4 (P1.1 — v5 explicitly deferred). |
| Per-judgment messages amplify RabbitMQ ops for huge dataset runs | Prefetch bounds + run-level `run.create` expansion throttle; quorum queues sized in Phase 2; compose rig load-tested with a 1k-judgment run. |
| Importer meets dirty v1 data (dangling cuids, duplicate judgments) | Importer runs in report-only mode first; reconciliation report is a gate artifact. |
| Scope: 143 findings | P1.10 split; MINOR/INFO triaged into implementation-plan backlog with explicit deferrals. |
