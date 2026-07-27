# Judge Arena 1b — Queue + Providers + Auth + Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Phase 1: horizontal-scale runtime (stateless web + RabbitMQ judge workers + Redis-backed shared state), provider layer v2 (descriptor registry, OpenRouter + vLLM, structured output), auth v2 (Authentik OIDC + public-read/gated-write matrix), and the build/CI rework — ending with the S2 + S4 exit demos runnable via compose.

**Architecture:** Stage A upgrades the platform (Next 15/Node 22) and externalizes shared state to Redis on today's behavior. Stage B replaces the in-process run engine with RabbitMQ per-judgment messages (idempotent claims, leases, FOR-UPDATE finalization, reaper). Stage C rebuilds the provider layer on the JudgeModel/Version/Endpoint identity from 1a and retires ModelConfig from the write path (rows kept for imported provenance). Stage D lands OIDC + the access matrix. Stage E delivers image/compose/CI and the exit demos. Stages must land in order; tasks within a stage are sequential.

**Tech Stack:** Next 15 (App Router), next-auth v4 (P1.1 — v5 deferred), Node 22, Prisma 6, `amqplib` (RabbitMQ), `redis` v5 client, vitest.

## Global Constraints (spec `2026-07-24-judge-arena-v2-architecture-spec.md` governs)

- **next-auth stays v4** (P1.1). Next 15 + Node 22 land in Task 1 *before* any behavior change; all suites green at every task boundary.
- **Redis is mandatory in production**: fail-fast at boot when `REDIS_URL` unset and `NODE_ENV=production`; ongoing Redis/RabbitMQ failure fails *readiness*, not just boot (spec §4). Redis config is `noeviction`. Silent in-memory fallbacks are removed.
- **Ollama is refused for scored runs** (inventory §8.3: 16.6pp stack drift) — registry marks it dev/interactive only.
- **`JudgeModelVersion` stays immutable** — still no update path anywhere.
- **Judgment idempotency key becomes real for pointwise** (1a handoff flag I2): the unique index on `(runId, judgeModelVersionId, pairOrder)` is recreated `NULLS NOT DISTINCT` (PG16) in Task 6 — decided here, not deferred.
- **Message contract excludes credential material** (spec §4): queue messages carry ids only; workers resolve keys/config from DB at execution.
- **No provenance regression**: `ModelConfig` rows are never deleted in 1b (imported judgments reference them); the *write path* stops using them; `ModelJudgment.modelConfigId` becomes nullable.
- Dev environment: no docker on this machine — podman postgres `judge-arena-pg` exists; Tasks add `judge-arena-redis`/`judge-arena-rabbitmq` podman containers (dispatches carry exact commands). Compose files are still authored for CI/other machines.
- Every commit ends with the standard co-author trailer.

**Harnesses:** `npm test` (unit, DB-free) · `npm run test:db` (Postgres) · new `npm run test:integration` (Task 5+: Postgres + Redis + RabbitMQ; serial). Suite counts at 1a close: 137 unit / 101 db.

---

## Stage A — Platform

### Task 1: Next 15 + Node 22 upgrade on existing behavior

**Files:** `package.json`, `package-lock.json`, `next.config.js`, `tsconfig.json`, `Dockerfile:2` (node:22-alpine), `.github/workflows/ci.yml` (NODE_VERSION 22 — mirror-only but keep coherent), and every route/page touched by Next 15's async request APIs.

**Interfaces:** none new — this task must be behavior-neutral. Exit = all suites green on Next 15.

- [ ] Step 1: `npm install next@15 eslint-config-next@15 && npm install -D @types/node@22`; pin engines `"node": ">=22"`.
- [ ] Step 2: Run `npx @next/codemod@latest next-async-request-api .` — Next 15 makes `params`/`searchParams`/`headers()`/`cookies()` async; the codemod converts, then hand-fix stragglers until `tsc --noEmit` is clean. Dynamic route handlers change signature to `{ params }: { params: Promise<{ id: string }> }` — sweep `src/app/api/**/route.ts` + pages.
- [ ] Step 3: next-auth v4 compatibility check: `getServerSession` still works under Next 15; run the auth-touching DB tests. If `next-auth` peer warnings appear, record them (report), do not upgrade.
- [ ] Step 4: Full verification: `npm test` 137, `npm run test:db` 101, `npx tsc --noEmit`, `npm run lint`, `npm run build` (production build must succeed — first time build is exercised in this program).
- [ ] Step 5: Commit `feat(1b): Next 15 + Node 22 platform upgrade (behavior-neutral)`.

### Task 2: Redis foundation — client, fail-fast, rate limiter consolidation

**Files:** Create `src/lib/redis.ts`, `src/lib/rate-limit-redis.ts`, `tests/integration/rate-limit.test.ts`; Modify `src/lib/env.ts`, `src/middleware.ts` (remove embedded limiter), `src/lib/rate-limit.ts` (retire to interface + test shim), `src/app/api/health/route.ts`, callers of limiters (`auth`/register-era call sites, judge/HF routes), `docker-compose.yml` (redis `noeviction`), `package.json` (redis@5, `test:integration` script).

**Interfaces:**
- `src/lib/redis.ts`: `export function getRedis(): RedisClient` (lazy singleton; **throws at first use in production if REDIS_URL unset**; test/dev may point at localhost), `export async function redisHealthy(): Promise<boolean>` (PING with 500ms timeout).
- `src/lib/rate-limit-redis.ts`: `export function createLimiter(name: string, limit: number, windowSec: number): { check(key: string): Promise<{ ok: boolean; remaining: number; resetAt: number }> }` — atomic Lua sliding window (single EVAL: ZREMRANGEBYSCORE + ZCARD + ZADD + PEXPIRE). Limiters: `auth` 5/min, `api` 120/min, `judge` 10/min, `huggingface` 30/min — wired to the routes the critique flagged as uncovered.
- `/api/health` gains `checks.redis` (readiness-failing when down in production).
- Middleware: **rate limiting removed from Edge middleware entirely** (Edge can't hold a Redis client; the dual in-memory limiter dies here) — middleware keeps CSP/security headers only; limiting happens in route handlers via the shared limiter. `X-Forwarded-For` trust: client IP resolved once in `src/lib/client-ip.ts` honoring `TRUSTED_PROXY` (first untrusted hop), used by all limiters.

- [ ] Step 1: podman: `podman run -d --name judge-arena-redis -p 6379:6379 docker.io/library/redis:7-alpine redis-server --maxmemory-policy noeviction`. `.env.test` gains `REDIS_URL`.
- [ ] Step 2 (TDD): `tests/integration/rate-limit.test.ts` — atomicity: 30 concurrent `check()` against limit 20 → exactly 20 ok (Lua guarantees, no over-admission); window expiry; two limiter instances (simulating two replicas) share one budget. New `test:integration` vitest config (serial, like test:db).
- [ ] Step 3: Implement; replace both in-memory limiters; delete `src/middleware.ts`'s Map + `lastCleanup`; keep `rate-limit.ts` exporting the interface for tests that fake it.
- [ ] Step 4: Verify all suites + `npm run build`; grep: zero `new Map` rate-limit state anywhere.
- [ ] Step 5: Commit `feat(1b): Redis foundation — fail-fast client, Lua rate limiter, middleware consolidation`.

### Task 3: Realtime v2 — Redis-only bus, scoped topics, resume

**Files:** Modify `src/lib/realtime/{factory,redis-bus,events,types}.ts`, `src/app/api/events/route.ts`; Create `tests/integration/realtime.test.ts`; delete silent-fallback paths in `redis-bus.ts`.

**Interfaces:**
- Topics: `user:{userId}` and `run:{runId}` (events: `run.status.changed`, `judgment.completed`, `dataset.summary.updated` retained). `publishEvent(topic: string, event: RealtimeEvent): Promise<void>` — **throws** on Redis failure in production (callers in the worker treat publish failure as retryable-nonfatal: log + continue; the bus never silently downgrades to local).
- SSE endpoint: subscribes only to topics the session's user owns (`user:{self}` + `run:{id}` after ownership check); supports `Last-Event-ID` via a per-topic Redis Stream (XADD maxlen 1000, XRANGE on resume); memory adapter survives only under `NODE_ENV=test`.

- [ ] Step 1 (TDD): integration tests — cross-client delivery via real Redis (publisher client A → subscriber client B); ownership scoping (user B's subscription never receives user A's topic); resume replays events between reconnects.
- [ ] Step 2: Implement bus hardening (init failure in production = boot failure; publish failure = throw), topic scoping in the SSE route, stream-backed resume.
- [ ] Step 3: Verify suites; grep: `in-memory-bus` referenced only from test config.
- [ ] Step 4: Commit `feat(1b): realtime v2 — mandatory Redis bus, ownership-scoped topics, SSE resume`.

### Task 4: Redis circuit breaker + typed error taxonomy

**Files:** Create `src/lib/llm/errors.ts`, `src/lib/llm/breaker-redis.ts`, `tests/integration/breaker.test.ts`; Modify `src/lib/llm/resilience.ts` (retire in-process Map; keep retry/timeout helpers), `src/lib/llm/index.ts` (breaker key: `provider:endpoint:modelId` — aggregator granularity).

**Interfaces:**
- `errors.ts`: `export class ProviderError extends Error { kind: 'retryable' | 'non_retryable' | 'rate_limited'; status?: number; provider: string }` + `export function classify(err: unknown, provider: string): ProviderError` — classification from HTTP status/SDK error types (429→rate_limited; 5xx/timeout/ECONNRESET→retryable; 4xx→non_retryable), **never from message substrings**.
- `breaker-redis.ts`: `export function getBreaker(key: string): { allow(): Promise<'closed'|'open'|'half_open_probe'>; onSuccess(): Promise<void>; onFailure(): Promise<void> }` — state in Redis hash, atomic Lua transitions (threshold 5 failures/60s → open 30s → single half-open probe via `SET NX PX` probe lock — exactly one process probes cluster-wide).

- [ ] Step 1 (TDD): integration — two breaker instances (two "replicas") share state: 5 failures split across both → open for both; only one of N concurrent `allow()` calls during half-open returns `half_open_probe`; success closes for all.
- [ ] Step 2: Implement; wire into `executeJudgment`'s call path; classification replaces the substring matcher (`resilience.ts:231,255` die).
- [ ] Step 3: Verify suites.
- [ ] Step 4: Commit `feat(1b): Redis circuit breaker (shared, atomic, single-probe) + typed error taxonomy`.

## Stage B — Queue

### Task 5: RabbitMQ infrastructure + topology

**Files:** Create `src/lib/queue/{connection,topology,publish}.ts`, `tests/integration/queue.test.ts`; Modify `docker-compose.yml` (rabbitmq:3.13-management, quorum defaults), `package.json` (amqplib + @types), `src/app/api/health/route.ts` (checks.rabbitmq), `src/lib/env.ts` (RABBITMQ_URL).

**Interfaces:**
- `topology.ts`: `export async function assertTopology(ch: Channel): Promise<void>` — exchange `judge.direct` (direct, durable); queues `judgment.execute` (quorum), `run.create` (quorum), `judgment.retry.30s` / `judgment.retry.5m` (TTL 30_000/300_000, DLX back to `judge.direct`), `judge.dlq` (quorum). Bindings by routing key = queue name.
- `publish.ts`: `export async function publishJudgmentExecute(msg: JudgmentExecuteMsg): Promise<void>` / `publishRunCreate(msg: RunCreateMsg)` — publisher-confirms channel, persistent messages. Types: `JudgmentExecuteMsg = { judgmentId: string; runId: string; attempt: number }`, `RunCreateMsg = { evaluationId: string; runSpec: { rubricId?: string; judgeModelVersionIds: string[]; triggeredById: string; protocol: 'pointwise' } }` — **ids only, no credentials, no prompt text**.
- `connection.ts`: lazy singleton with reconnect/backoff; `rabbitHealthy()`.

- [ ] Step 1: podman: `podman run -d --name judge-arena-rabbitmq -p 5672:5672 -p 15672:15672 docker.io/library/rabbitmq:3.13-management-alpine`. `.env.test` gains RABBITMQ_URL.
- [ ] Step 2 (TDD): integration — topology asserts idempotently; publish with confirms; a nacked message with `x-death` routes retry.30s → back to judgment.execute after TTL; third failure → dlq (drive via a throwaway consumer in the test).
- [ ] Step 3: Implement; health endpoint extension.
- [ ] Step 4: Verify suites (unit stays DB/queue-free).
- [ ] Step 5: Commit `feat(1b): RabbitMQ connection, topology (quorum + TTL retry + DLQ), confirmed publishers`.

### Task 6: Schema tightening — real idempotency + finalization fields

**Files:** Modify `prisma/schema.prisma`; Create migration `v2b-idempotency-tighten` (hand-edited), `tests/db/idempotency-tighten.test.ts`.

**Interfaces / migration content:**
- Recreate the judgment unique index **`NULLS NOT DISTINCT`** (raw SQL: `DROP INDEX ...; CREATE UNIQUE INDEX "ModelJudgment_runId_judgeModelVersionId_pairOrder_key" ON "ModelJudgment"("runId","judgeModelVersionId","pairOrder") NULLS NOT DISTINCT;`) — closes 1a flag I2: pointwise (`pairOrder` NULL) now dedupes at the DB.
  **Prisma caveat:** Prisma can't express NULLS NOT DISTINCT — keep `@@unique` in the schema and hand-edit the migration; document that `migrate diff` will show this index as perpetual pseudo-drift and how the CI drift check whitelists it (comment in the migration + note in CONTRIBUTING).
  **Importer interaction:** multiset matching from 1a already creates distinct-version rows only; ADD a pre-flight to the importer reconcile (one query) asserting no two v1 judgments on one run map to the same version with both surviving — if the unique now rejects, the importer must merge-with-report instead of crash: change `runs.ts` create to catch P2002 → tally `'dropped'` + warning (spot-check 3 explains the delta).
- `ModelJudgment.modelConfigId` → `String?` (relation optional; write path stops setting it in Task 9). `EvaluationRun` finalization: no new columns needed (`finalizedAt` exists); **semantic fix (1a flag M4):** finalization (Task 8) sets `finalizedAt` for BOTH `completed` and `needs_human`; importer updated to match (backfill migration statement for imported `needs_human` rows: `UPDATE "EvaluationRun" SET "finalizedAt" = "updatedAt" WHERE status = 'needs_human' AND "finalizedAt" IS NULL`).

- [ ] Step 1 (TDD): db tests — two pointwise judgments same (run, version) now P2002; modelConfigId nullable accepted; needs_human backfill applied.
- [ ] Step 2: Migration via established workflow + hand edits; importer P2002 handling + reconcile pre-flight.
- [ ] Step 3: Verify: test:db green (importer tests still pass — the fixtures use distinct versions), unit green, drift check documented.
- [ ] Step 4: Commit `feat(1b): NULLS NOT DISTINCT idempotency, nullable modelConfigId, finalizedAt semantics`.

### Task 7: Worker — entrypoint, consumers, idempotent claims

**Files:** Create `src/worker/{main,run-create-consumer,judgment-consumer,claim}.ts`, `worker.ts` (root entry compiled alongside), `tests/integration/worker-claims.test.ts`; Modify `package.json` (`"worker": "tsx src/worker/main.ts"` dev script; build wiring in Task 16).

**Interfaces:**
- `claim.ts`: `export async function claimJudgment(judgmentId: string): Promise<'claimed'|'already_done'|'not_found'|'stale_running'>` — single conditional `updateMany({ where: { id, status: 'pending' }, data: { status: 'running', startedAt: now, attemptCount: { increment: 1 } }})`; count 0 → inspect row: `completed`→already_done (ack), `running` with `updatedAt < now - LEASE_MS` → reclaim via `updateMany({ where: { id, status: 'running', updatedAt: { lt: stale } } … })`. `LEASE_MS = EVALUATION_MODEL_TIMEOUT_MS + 30_000`.
- `run-create-consumer.ts`: consumes `run.create` → transactionally creates `EvaluationRun` + pending `ModelJudgment` rows (`createMany({ skipDuplicates: true })` — redelivery-safe) → publishes one `judgment.execute` per created row → ack. Expansion failure → run `status: 'error'` + ack (no silent swallow — the 1a-carried batch-failure finding dies here).
- `judgment-consumer.ts`: claim → load judgment + run + rubric version + JudgeModelVersion + endpoint (worker-side resolution; message carried ids only) → provider call (Stage C seam — until Task 10 lands, calls the existing `executeJudgment` adapted behind an interface `runProviderJudgment(input): Promise<JudgmentResult>`) → persist result → publish `judgment.completed` on `run:{runId}` → finalize hook (Task 8) → ack. `classify()` from Task 4 drives disposition: non_retryable → judgment `error` + ack; retryable/rate_limited → nack to retry queue with attempt cap 3 → dlq.
- `main.ts`: boots topology, prefetch = `EVALUATION_MODEL_CONCURRENCY_PER_RUN * 4`, SIGTERM drain (stop consuming, finish in-flight, ack, exit), health file/port for probes.

- [ ] Step 1 (TDD): integration — duplicate delivery of one judgment message → exactly one provider call (fake provider counter), second delivery acks as already_done; kill-mid-run simulation: claim then abandon (no ack, connection close) → redelivery reclaims after lease; run.create redelivery → no duplicate judgment rows.
- [ ] Step 2–3: Implement; fake provider injected for tests.
- [ ] Step 4: Verify suites; unit suite untouched.
- [ ] Step 5: Commit `feat(1b): judge worker — consumers, conditional claims, lease reclaim, typed retry/DLQ`.

### Task 8: Finalization + reaper + summary recompute

**Files:** Create `src/lib/run-finalizer.ts`, `src/worker/reaper.ts`, `tests/integration/finalization.test.ts`; Modify `src/worker/judgment-consumer.ts` (call finalizer), `src/lib/dataset-evaluation-summary.ts` (recompute on finalization, transactional — kills the 1a-carried lost-update).

**Interfaces:**
- `run-finalizer.ts`: `export async function maybeFinalizeRun(runId: string): Promise<RunStatus | null>` — `$transaction`: `SELECT ... FOR UPDATE` on the run row (`$queryRaw`), recompute judgment aggregate in-tx, guarded transition (`judging → needs_human|error`), set `finalizedAt` (completed AND needs_human per Task 6 semantics), publish `run.status.changed`. Returns null when not yet finalizable. **Dual-completion race test mandated by spec §10**: two concurrent finalizer calls → exactly one transitions (the other observes the row lock + guard).
- `reaper.ts`: interval loop (every 60s) under a Redis `SET NX PX` lock (`reaper:lock`, one runner cluster-wide): (a) runs past `deadlineAt` still `pending|judging` → re-publish unfinished judgment messages (idempotent claims make this safe) or force-finalize as `error` after N sweeps; (b) judgments in stale `running` beyond lease → reclaim-eligible (Task 7 logic reused). Deadline: `deadlineAt = now + judgmentCount × timeout + slack`, set at run creation (Task 7 expansion).
- Summary recompute: finalizer calls `refreshDatasetEvaluationSummaryForEvaluation` variant that recomputes **from the DB inside the finalizer transaction scope** (read-modify-write on JSON dies; compute fresh, single UPDATE).

- [ ] Step 1 (TDD): integration — dual-completion race (spec-mandated); reaper re-queues a stranded run end-to-end (worker completes it); stale-running reclaim; summary matches DB after concurrent finalizations.
- [ ] Step 2–3: Implement.
- [ ] Step 4: Verify; commit `feat(1b): FOR-UPDATE run finalization, cluster reaper, transactional summary recompute`.

### Task 9: Web tier becomes producer — run-manager retirement

**Files:** Modify `src/app/api/evaluations/route.ts` + `src/app/api/evaluations/[id]/judge/route.ts` + `.../runs/route.ts` (publish instead of enqueue), `src/app/api/stats/route.ts` (queue stats from DB counts, not process-local); Delete `src/lib/evaluation-run-manager.ts` (its prompt/exec pieces already relocated); Modify `tests/**` accordingly.

**Interfaces:** Web run-launch = one `$transaction` (create run rows only for single-run launches; bulk dataset launches publish `run.create` per evaluation and return 202 with per-item accepted/failed statuses — swallowed-failure finding closed at the API contract), then `publishRunCreate`/`publishJudgmentExecute` with confirms; publish failure after commit → mark run `error` (compensating update) and surface in response. `judgeModelVersionId` is REQUIRED on the new write path (staged-tightening completes; the nullable column constraint tightens in Phase 2 once no v1-era rows lack it — record as backlog note, not a 1b migration).

- [ ] Step 1 (TDD): integration — launch → rows pending + messages published (consume with a test consumer); bulk launch with one invalid evaluation → 202 with that item failed, others queued; publish-failure path marks run error.
- [ ] Step 2–3: Implement; delete the module-level queue trio; migrate any UI polling that read `getQueueStats`.
- [ ] Step 4: Verify all suites; grep: no `activeIds`, no module-level `queue` arrays anywhere.
- [ ] Step 5: Commit `feat(1b): web tier publishes to RabbitMQ; in-process run engine retired`.

## Stage C — Providers

### Task 10: Descriptor registry + metadata capture + template rendering

**Files:** Create `src/lib/llm/registry.ts`, `src/lib/llm/render.ts`; Modify `src/lib/llm/{provider,anthropic,openai-compatible,verify,index}.ts`, `src/worker/judgment-consumer.ts` (uses registry), `tests/lib/registry.test.ts`, `tests/lib/render.test.ts`.

**Interfaces:**
- `registry.ts`: `export interface ProviderDescriptor { id: ServingBackend; kind: 'api'|'openai_compatible'; defaultBaseUrl?: string; auth: 'bearer'|'x-api-key'; caps: { structuredOutput: 'json_schema'|'tool_use'|'guided'|'none'; samplingParams: boolean; reasoningToggle: boolean }; headers?(cfg): Record<string,string>; scoredRunsAllowed: boolean }`; `export function getDescriptor(backend: ServingBackend): ProviderDescriptor`. Ollama: `scoredRunsAllowed: false`.
- `runProviderJudgment(input: { judgeVersion, endpoint, template, rubric, submission, samplingOverrides? }): Promise<JudgmentResult>` where `JudgmentResult = { overallScore, criteriaScores, reasoning, rawResponse, servedModelId?, finishReason?, inputTokens?, outputTokens?, latencyMs, parseMode: 'structured'|'fallback', samplingParamsUsed }` — every field persisted onto ModelJudgment (columns exist from 1a).
- Key resolution: `resolveApiKey(descriptor, endpoint)` — endpoint's own `apiKeyEnc` (decrypted — the ciphertext-as-key bug dies) else the provider-class env key **only for `kind: 'api'` known hosts** (never sent to arbitrary user URLs); NaN-score normalization fixed in the parse path (reject non-finite, recompute overall from criteria when absent).
- `render.ts`: renders a `PromptTemplate` row (protocol-scoped, from DB) + rubric + submission with delimiter escaping (1a's seeded `v1-legacy` v0 keeps byte-compatibility for the default template).

- [ ] Step 1 (TDD): unit — registry lookups + ollama refusal; render golden test against the v1-legacy template (byte-identical output to v1's builder for same inputs); parse-path NaN rejection; key-resolution matrix (user endpoint never sees env key).
- [ ] Step 2–3: Implement; `verify.ts` folds into registry-driven dispatch and now returns `archFingerprint` (served model id, context length if exposed) persisted to `ModelEndpoint`.
- [ ] Step 4: Verify; commit `feat(1b): provider descriptor registry, metadata capture, DB-templated prompts, scoped key resolution`.

### Task 11: OpenRouter + vLLM backends, structured output

**Files:** Create `src/lib/llm/backends/{openrouter,vllm}.ts`, `tests/lib/backends.test.ts`; Modify registry, `src/lib/llm/openai-compatible.ts` (shared base), `.env.example` (OPENROUTER_API_KEY, VLLM_BASE_URL/VLLM_API_KEY commented).

**Interfaces:** Both are `openai_compatible` descriptors: OpenRouter adds attribution headers (`HTTP-Referer`, `X-Title`) and breaker key granularity `openrouter:{modelId}`; vLLM adds structured output via `guided_json` (schema = the judgment JSON schema) with fallback to `response_format: json_schema`, bearer token + custom CA trust note (deployment doc — cluster seam config lands Phase 2). `parseMode: 'structured'` recorded when guided decoding served the response.

- [ ] Step 1 (TDD): unit with mocked fetch — request-shape assertions (headers, guided_json payload, api key placement); structured response parses without the lenient fallback; fallback path recorded as `parseMode: 'fallback'`.
- [ ] Step 2–3: Implement.
- [ ] Step 4: Verify; commit `feat(1b): OpenRouter + vLLM backends with guided structured output`.

### Task 12: Runtime switches to JudgeModel identity — ModelConfig write-path retirement

**Files:** Modify `src/app/api/models/**` (routes become JudgeModel catalog + ModelEndpoint CRUD), `src/app/models/page.tsx` + `src/components/models/model-config-form.tsx` (UI: pick from catalog or add custom model+version, per-user endpoint/keys), `src/app/api/evaluations/**` (model selection by `judgeModelVersionId`), `src/lib/export.ts`/`config.ts` (export judge identity), seed (catalog seed: the 3 Anthropic defaults as JudgeModel+Version entries), worker consumer (already version-driven from Task 7).

**Interfaces:** `EvaluationModelSelection`/`RunModelSelection` gain `judgeModelVersionId String?` columns (migration; dual-written; old `modelConfigId` kept for existing rows); new selections write version ids only. API response shapes for `/api/models` change (breaking, documented in CONTRIBUTING wire-format section). Default-model resolution becomes per-user endpoints on trusted-or-any versions (1a INFO finding about global cross-user defaults dies).

- [ ] Step 1 (TDD): db tests — selection rows dual-shape; run launch via version ids end-to-end (integration reuses Task 7 harness); export carries judge slug+ordinal.
- [ ] Step 2–3: Implement routes/UI; migration `v2b-selection-version-ids`.
- [ ] Step 4: Verify all suites + build; commit `feat(1b): runtime on JudgeModel/Version/Endpoint; ModelConfig write path retired`.

## Stage D — Auth & access

### Task 13: Authentik OIDC + credentials hardening

**Files:** Modify `src/app/api/auth/[...nextauth]/route.ts` + `src/lib/auth.ts` (add OIDC provider, `(issuer,sub)` linking, remove email-fallback), delete `src/app/api/auth/register/route.ts` + its 5 UI touchpoints (register page → invite-info page), `src/lib/auth-guard.ts` (session resolution via User table only), Create `scripts/admin/create-user.ts` (admin invite CLI: email + optional temp password or OIDC-pending), `tests/db/oidc-linking.test.ts`, docs runbook section.

**Interfaces:** next-auth v4 config: custom OAuth provider `{ id: 'authentik', wellKnown: AUTHENTIK_ISSUER + '/.well-known/openid-configuration', clientId/clientSecret env, profile → { sub, email, name } }`; `signIn` callback links/creates by `(oidcIssuer, oidcSubject)` **only** (no email fallback — spec §7 non-destructive-v5 condition); credentials provider stays for admin-created users; JWT 24h rolling (`maxAge: 86400`, `updateAge: 3600`). Session token carries user id claim only; auth-guard resolves role/email from DB.

- [ ] Step 1 (TDD): db tests — OIDC profile with known (issuer,sub) → same user across sign-ins; same email different sub → **distinct** user (linking hazard closed); credentials login unaffected; register route returns 404 (removed).
- [ ] Step 2–3: Implement; `.env.example` gains AUTHENTIK_* block; runbook: Authentik provider/app blueprint pointers (grant_types explicitly declared — homelab gotcha), invite flow.
- [ ] Step 4: Verify + build; commit `feat(1b): Authentik OIDC via (issuer,sub), registration retired, admin invite CLI`.

### Task 14: Access matrix — public reads, gated writes

**Files:** Modify `src/lib/auth-guard.ts` (add `optionalAuth` + `requireOwnership(entity, id)` helpers), every route under `src/app/api/{leaderboard,rubrics,datasets,projects,evaluations,api-keys}/**` per the matrix, Create `src/lib/serializers.ts` (public PII-stripped shapes), `tests/db/access-matrix.test.ts` (table-driven: route × anonymous/authed/owner → expected status), CSP nonce wiring in middleware + root layout.

**Interfaces:** Matrix (spec §7 + D3 principle): anonymous GET — leaderboard, `visibility: public` rubrics/datasets/projects/golden-sets via `serializers.ts` (never `email`, never `apiKeyEnc`, never private fields); everything else authenticated; every mutation `requireOwnership`; API-key management routes require an interactive session (privilege-escalation fix); `audit()` wired to auth events, key lifecycle, judge-version creation, imports. CSP: `script-src 'self' 'nonce-{per-request}'` in production (unsafe-inline dies), report in CONTRIBUTING.

- [ ] Step 1 (TDD): table-driven access tests (real handlers, mocked session per Task 15 precedent); serializer snapshot excludes PII fields; scoped-key cannot mint keys.
- [ ] Step 2–3: Implement route-by-route (the matrix table in the test file IS the documentation).
- [ ] Step 4: Verify + build; commit `feat(1b): public-read/gated-write access matrix, PII serializers, session-only key management, audit wiring, CSP nonces`.

### Task 15: Deletion/visibility debt — GoldenSet retire, Dataset enum, publishedAt

**Files:** Modify `prisma/schema.prisma` (+ migration `v2b-visibility-cleanup`), `src/lib/account-deletion.ts`, dataset routes/serializers, importer `artifacts.ts` (enum write), `tests/db/` updates.

**Interfaces:** `Dataset.visibility` → `Visibility` enum (migration with `USING visibility::"Visibility"`; zod updated); `publishedAt` added to Dataset + GoldenSet (spec §3.3 completion, 1a flag M1); GoldenSet gains `retiredAt` and account-deletion retires-instead-of-deletes when a CalibrationRun references it (1b-prereq (a) closed); deletion result maps get consistent always-initialized keys (prereq (c)); Dataset version creation gains `@@unique([parentId, version])` + transactional numbering reusing `createRubricVersion`'s pattern via a shared helper (1a flag M5); the 3 untrimmed display sites align (1a flag M3).

- [ ] Step 1 (TDD): db tests — enum round-trip + zod rejection of junk; goldenset-with-calibration deletion retires + user delete completes; dataset version race deterministic.
- [ ] Step 2–3: Migration + implementation.
- [ ] Step 4: Verify; commit `feat(1b): visibility enum + publishedAt, GoldenSet retire path, dataset-version race guard, display-site trim alignment`.

## Stage E — Build, CI, exit demos

### Task 16: Image + compose v2

**Files:** Modify `Dockerfile` (node:22-alpine, standalone-only runner, single `prisma generate`, two entrypoints: `server.js` / `worker.js` via build arg or shared image + command), `docker-compose.yml` (full rework: `migrate` one-shot service, `app` scale-safe — no container_name/host-port pin, `worker`, `nginx` LB service + `deploy/nginx-lb.conf`, `redis` noeviction, `rabbitmq`, profiles), `.dockerignore`, `deploy/`.

- [ ] Step 1: Author Dockerfile: deps stage → build stage (standalone output includes worker bundle: add `worker.ts` to a small esbuild/tsc step emitting `.next/standalone/worker.js`) → runner (`CMD ["node","server.js"]`, worker service overrides command). NO migrations in CMD.
- [ ] Step 2: Compose: `docker compose up --scale app=2 --scale worker=2` must be structurally valid (`docker compose config` in CI validates; no docker locally — authored + CI-verified). **Prisma pool budget (spec §4)**: compose/env set `DATABASE_URL` with explicit `?connection_limit=10&pool_timeout=20` per app replica and `connection_limit=EVALUATION_MODEL_CONCURRENCY×2` per worker; the budget formula (Σ replicas × limit < Postgres max_connections − headroom) documented in CONTRIBUTING + compose comments.
- [ ] Step 3: Verify suites still green (no runtime change); commit `feat(1b): scale-safe image and compose — one-shot migrations, worker service, LB`.

### Task 17: Gitea-ready CI

**Files:** Create `.gitea/workflows/ci.yml` (raw shell only — no JS actions: checkout via git, setup via mise/apt per runner docs), Modify `.github/workflows/ci.yml` (reduce to mirror-badge/no-deploy), `vitest.config.ts` coverage gate extension (queue/providers/auth-guard/importer included; thresholds set to current actuals).

- [ ] Step 1: Author Gitea workflow: services postgres:16 + redis:7 + rabbitmq:3.13; steps: npm ci → lint → tsc → `prisma migrate deploy` (NOT db push) → unit → test:db → test:integration → build → (Kaniko/Harbor push stage stubbed with TODO markers for Phase 2 onboarding — the homelab `onboard` CLI supplies registry wiring then).
- [ ] Step 2: Coverage gate: `vitest --coverage` thresholds per-directory for the rewritten subsystems; document in CONTRIBUTING.
- [ ] Step 3: Verify local equivalents of each CI step pass in sequence from a clean checkout (script `scripts/ci-local.sh` mirrors the workflow — this is what "CI green" means until the repo lands on Gitea).
- [ ] Step 4: Commit `feat(1b): Gitea Actions pipeline (raw shell), coverage gates, GH workflow demoted to mirror`.

### Task 18: S4 + S2 exit demos + README rewrite

**Files:** Create `scripts/demo/s4-demo.sh`, `scripts/demo/s2-provenance.sql`, `docs/runbooks/1b-exit-demo.md`; Rewrite `README.md` (spec: lands with implementation — current architecture, judge identity model, queue runtime, auth, dev setup incl. podman notes, importer usage).

- [ ] Step 1: `s4-demo.sh` (parameterized for podman-local or compose): boots 2 app + 2 worker, launches a 20-judgment dataset run with the fake/stub provider (env-gated), kills one worker mid-run (SIGKILL), asserts: run completes, judgment count exact (no dupes — DB unique proof query), SSE events observed by clients pinned to both app replicas, rate-limit budget shared (30 hits limit-20 across both replicas → exactly 20 ok). Exit code = demo verdict.
- [ ] Step 2: `s2-provenance.sql`: the spec §10 single query — for a judgment id: judge class/revision/quantization/backend, prompt template name+version, rubric version, sampling params, pair order. Runbook documents both demos as the Phase-1 exit gate evidence.
- [ ] Step 3: README rewrite (the stale-README debt from §1 of the program doc dies here).
- [ ] Step 4: Run the demos locally (podman path); paste outputs into the runbook; commit `feat(1b): S4/S2 exit demos + README v2`.

---

## Self-review checklist (run after drafting)

Spec §4 runtime ✅ T2-T4,T7-T9 · §5 topology ✅ T5 · §6 providers ✅ T10-T12 · §7 auth+matrix ✅ T13-T14 (+v5 condition preserved: (issuer,sub)-only linking T13) · §9 build/CI ✅ T16-T17 · §10 demos ✅ T18 · 1b correctness roster (NaN T10, summary lost-update T8, swallowed batch T9) ✅ · 1a handoff flags: I2 ✅ T6, GoldenSet ✅ T15, Dataset enum ✅ T15, publishedAt ✅ T15, M4 finalizedAt ✅ T6/T8, M5 dataset-version race ✅ T15, M3 display sites ✅ T15, staged judgeModelVersionId tightening ✅ T9 (write path; column constraint → Phase 2 backlog) · ModelConfig retirement ✅ T12 (write path only; rows preserved for provenance).

Deferred beyond 1b (explicit): Phase 2 owns cluster manifests/Gitea migration/Harbor wiring/GPU-seam deployment + TLS material; NOT NULL tightening of judgeModelVersionId; Auth.js v5 upgrade (at GA, per approved condition).

## Finding dispositions

The 56 BLOCKER/MAJOR findings assigned to 1b live in
`docs/superpowers/plans/2026-07-27-1b-finding-dispositions.md` — one row each,
mapped to the task above that resolves it.
