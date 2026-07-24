# Judge Arena v1 — Design Critique (Phase 1 input)

**Program:** Judge Arena v2, Phase 1 · **Produced:** 2026-07-24
**Method:** 8-dimension multi-agent review, each dimension adversarially verified
(every cited file:line re-opened; bad citations killed, severities corrected).
**Result:** 143 confirmed findings — 14 BLOCKER · 72 MAJOR · 43 MINOR · 14 INFO; 0 killed in verification.
**Severity:** BLOCKER = breaks the v2 target architecture · MAJOR = must be addressed in the Phase 1 spec · MINOR = address during implementation · INFO = context.

Findings are inputs to `2026-07-24-judge-arena-v2-architecture-spec.md`; every BLOCKER/MAJOR receives a disposition there.

## replica-safety (13 findings: BLOCKER 2 · INFO 2 · MAJOR 7 · MINOR 2)

The codebase is single-process by design in exactly the four suspected places, all confirmed: the in-process evaluation-run queue (with its per-process dedup Set and no crash recovery), the in-memory rate limiter (plus a second, independent in-memory limiter inside Edge middleware), the per-process circuit-breaker Map, and an SSE bus that silently defaults or falls back to in-memory delivery whenever Redis is absent or errors. Beyond the known suspects, the significant unknowns are: a read-modify-write lost-update race on dataset.remoteMetadata (the evaluation summary is merged into a JSON blob with no locking, and the refresh route clobbers it wholesale), an unbounded Prisma connection pool per replica against a single Postgres with no connection_limit anywhere, permanently stuck 'judging' runs on pod death with no reconciler, and a per-replica Next.js filesystem fetch-cache for HuggingFace metadata. Positively: there are zero filesystem writes/uploads/temp files in src, auth sessions are stateless JWT, and the SSE design needs no sticky sessions once the bus is Redis-backed — so the web tier becomes genuinely stateless once the queue moves to RabbitMQ and the three Redis-mandatory stores (bus, rate limit, breaker) are externalized with fail-fast (not silent-fallback) semantics.

### [BLOCKER] In-process evaluation run queue — work pinned to one replica, lost on restart, dedup broken across replicas
`src/lib/evaluation-run-manager.ts:67`

The judge work queue is a module-level array (`queue`, line 67) with a per-process dedup Set (`activeIds`, line 68; checked at line 307) and worker counter (line 69). At 2+ replicas: (a) all LLM judging executes only on the replica that received the POST — a bulk dataset run (src/app/api/evaluations/route.ts:434 and :516 loop enqueueEvaluationRunCreation over potentially thousands of evaluations) pins the entire backlog to one pod with zero load sharing; (b) the 'already queued or in-flight' dedup cannot see other replicas, so the same runId triggered via two replicas is processed twice (duplicate LLM spend, racing modelJudgment writes); (c) queued items vanish on pod restart/rolling deploy, leaving runs in 'pending' forever.

> `const queue: QueueItem[] = [];`

**Fix direction:** Replace with RabbitMQ: web tier publishes run/evaluation messages (publisher-confirms), dedicated judge-worker deployment consumes with prefetch-based concurrency, manual acks, and DB-backed idempotency keyed on runId.
**Verify note:** Verified: queue/activeIds/activeWorkers at lines 67-69, dedup check at 307/316, and both bulk enqueue loops at evaluations/route.ts:434 and :516 confirmed; no external queue or persistence exists.

### [BLOCKER] SSE realtime bus defaults to replica-local in-memory delivery
`src/lib/realtime/in-memory-bus.ts:8`

The in-memory bus holds subscribers in a process-local Map, and the factory selects it whenever REDIS_URL is unset (src/lib/realtime/factory.ts:27 `: 'memory';`) — env.ts:37 even defaults REALTIME_ADAPTER to 'memory'. At 2+ replicas, a `dataset.summary.updated` event published by the replica (or future RabbitMQ worker) that finished a run reaches only SSE connections attached to that same process; every client whose EventSource landed on another replica silently never updates.

> `private listeners = new Map<number, RealtimeListener>();`

**Fix direction:** Make Redis pub/sub the only production adapter: remove the memory default, fail startup fast when REDIS_URL is missing in production, and keep in-memory only for tests/dev.
**Verify note:** Verified: factory.ts:27 falls through to 'memory' when REDIS_URL is unset and env.ts:37 defaults REALTIME_ADAPTER to 'memory'; no production guard forces Redis.

### [MAJOR] In-memory sliding-window rate limiter multiplies limits by replica count
`src/lib/rate-limit.ts:41`

Each limiter's window store is a module-level Map (plus a per-process cleanup setInterval at line 44), and the file's own header (lines 4-5) says 'For single-process deployments'. Behind a round-robin LB with N replicas, every configured limit becomes ~N× (registration's 3/hour per IP, consumed at src/app/api/auth/register/route.ts:20, becomes 3/hour/replica), counters reset per-pod on every rolling deploy, and 429 behavior is nondeterministic depending on which replica a request hits — defeating the brute-force protection the limiter exists for.

> `const windows = new Map<string, WindowEntry>();`

**Fix direction:** Redis-backed limiter (atomic Lua sliding-window or INCR+EXPIRE fixed window) behind the existing RateLimiter interface; v2 declares Redis mandatory for rate limiting.
**Verify note:** All citations verified (Map at 41, setInterval at 44, header lines 4-5, register check at line 20); downgraded from BLOCKER — limits degrade to ~N× but remain bounded per replica, so the control weakens rather than breaks.

### [MAJOR] Circuit-breaker state is a per-process Map — breakers trip and probe independently per replica
`src/lib/llm/resilience.ts:99`

Circuit state lives in a module-level Map keyed by provider:endpoint. With N web replicas (and, post-Phase-1, M queue workers), each process must independently accrue failureThreshold=5 failures before opening — effective threshold is ~5×N against a failing provider — and each process sends its own half-open probe, multiplying load on a recovering vLLM/OpenRouter endpoint; getCircuitState/resetCircuit (lines 180-189) only observe/reset the local replica, so operational resets are per-pod. The v2 target explicitly names circuit-breaker state as Redis-mandatory.

> `const circuits = new Map<string, CircuitBreakerState>();`

**Fix direction:** Move breaker state (state, failure timestamps, lastOpenedAt) to Redis with atomic Lua transitions and a single distributed half-open probe lock; scope keys per provider-class/endpoint from the schema-v2 judge-model inventory.
**Verify note:** Verified: Map at line 99, failureThreshold=5 at line 87, circuitKey(providerName, endpoint) in llm/index.ts:44, getCircuitState/resetCircuit at 180-189; downgraded from BLOCKER — per-process breakers still protect, protection is diluted (~5×N threshold, N probes) not disabled.

### [MAJOR] Pod death mid-run leaves EvaluationRun permanently 'judging' — no reconciler or redelivery
`src/lib/evaluation-run-manager.ts:129`

processRun writes status 'judging' to the DB then performs up-to-120s LLM calls in-process; the catch-all at line 253 only covers in-process exceptions, not SIGTERM/OOM/node failure — which are routine for a 2+ replica tier doing rolling deploys. There is no startup scan or periodic reaper for stale 'pending'/'judging' rows, so killed runs are stuck forever and the stats endpoint counts them as active indefinitely (src/app/api/stats/route.ts:36 `status: { in: ['pending', 'judging'] }`).

> `data: { status: 'judging' },`

**Fix direction:** Spec must pair the RabbitMQ move with manual acks + redelivery on consumer death, an idempotent processRun (safe to re-run per-judgment), and a periodic reaper that re-queues or errors runs stuck in 'judging' beyond a deadline.
**Verify note:** Verified: 'judging' write at 129, catch-all at 253 handles only in-process errors, stats route line 36 confirmed, and a repo-wide grep found no reaper/startup-recovery for stale pending/judging rows.

### [MAJOR] Second, independent in-memory rate limiter in Edge middleware
`src/middleware.ts:17`

Middleware maintains its own module-level rate-limit Map (with lazy cleanup via `let lastCleanup` at line 37), separate from lib/rate-limit.ts — so the auth (5/min) and general-API (120/min) per-IP limits are also per-replica (N× effective). Worse for the Phase 1 spec: this runs in the Edge runtime, which cannot hold a TCP Redis client, so 'move it to Redis' is not a drop-in — enforcement must move out of middleware.

> `const rateLimitMap = new Map<string, { count: number; resetAt: number }>();`

**Fix direction:** Relocate rate limiting to Node route handlers (shared Redis limiter) and/or the ingress tier (nginx limit_req on tenant-public class); keep middleware for security headers only.
**Verify note:** Verified: Map at 17, lastCleanup at 37, 5/min auth limit at line 130 and 120/min API limit at line 147; the file's own header (lines 9-10) confirms it runs in the Edge runtime.

### [MAJOR] Redis bus silently and permanently degrades to replica-local delivery on any init/publish failure
`src/lib/realtime/redis-bus.ts:77`

If the dynamic `import('redis')` fails, the bus marks itself initialized with a permanent local-only fallback; if a publish throws, the event is emitted only to local listeners (lines 58-61 'Falling back to local emit'). In a single process this is graceful degradation, but at 2+ replicas it converts a Redis outage into silent cross-replica event loss with no health signal — clients on other replicas just stop updating, violating the v2 contract that Redis is mandatory for the SSE bus.

> `this.initialized = true; // Permanent fallback — no Redis available`

**Fix direction:** Remove local-emit fallbacks in production: retry publish with backoff, surface Redis-bus health in /api/health (fail readiness), and treat missing redis module as a boot error.
**Verify note:** Verified at line 77; one nuance — connection failures do retry (initPromise reset at line 107), but missing-module init is permanent and every publish failure silently drops cross-replica delivery for that event, so the claim stands.

### [MAJOR] Lost-update race: evaluation summary merged into dataset.remoteMetadata via unlocked read-modify-write
`src/lib/dataset-evaluation-summary.ts:91`

refreshDatasetEvaluationSummary reads remoteMetadata, JSON-parses it, merges evaluationSummary, and writes the whole blob back (lines 93-101) with no transaction or row lock. Every finished run calls this (evaluation-run-manager.ts:264); with concurrent runs of the same dataset completing on different replicas/workers, two refreshes interleave and one whole metadata write is silently lost (last-writer-wins on the entire JSON). Separately, datasets/[id]/refresh (route.ts, `remoteMetadata: JSON.stringify(meta)`) rewrites the column wholesale, dropping evaluationSummary entirely.

> `const metadata = parseMetadata(dataset.remoteMetadata);`

**Fix direction:** Schema v2: move evaluationSummary out of remoteMetadata into dedicated columns/table written idempotently from aggregates, or use a SELECT ... FOR UPDATE transaction / Postgres jsonb_set to make the merge atomic.
**Verify note:** Verified: read at line 32/parse at 91/write at 93-101 with no transaction, caller at evaluation-run-manager.ts:264, and refresh/route.ts:51 rewrites remoteMetadata from fetched HF metadata, dropping evaluationSummary; race also exists single-process given queue concurrency 4.

### [MAJOR] Prisma connection pool unbounded per replica — N replicas + workers can exhaust a single Postgres
`src/lib/db.ts:9`

PrismaClient is constructed with no pool configuration and DATABASE_URL carries no connection_limit anywhere (prisma/schema.prisma:7 is bare `url = env("DATABASE_URL")`; no override in .env.example or deploy/). Prisma's default pool is num_physical_cpus*2+1 per process — on a 16-core homelab worker that is 33 connections per pod; 2+ web replicas plus the new RabbitMQ judge-worker deployment (each worker holding connections during 120s LLM calls) can blow past a CNPG default max_connections=100, producing P2024 pool-timeout errors under load.

> `new PrismaClient({`

**Fix direction:** Spec an explicit per-tier connection budget: connection_limit + pool_timeout in DATABASE_URL for web and worker deployments, and/or front Postgres with pgbouncer (transaction pooling) sized to CNPG max_connections.
**Verify note:** Verified: PrismaClient at db.ts:9 takes only a log option, schema.prisma:7 is bare env("DATABASE_URL"), and .env.example line 7 has no connection_limit parameter.

### [MINOR] HuggingFace metadata cached in per-replica Next.js filesystem data cache
`src/lib/huggingface.ts:81`

fetchHuggingFaceDatasetInfo uses Next's fetch data cache with revalidate: 3600; in `output: 'standalone'` (next.config.js:3) this cache is filesystem-backed under .next/cache per pod. Replicas cache and expire independently, so two replicas can serve divergent dataset metadata for up to an hour, and under a read-only rootfs (restricted PSA) the cache write path needs a writable emptyDir mount or it degrades noisily.

> `next: { revalidate: 3600 }, // cache for 1 hour`

**Fix direction:** Either switch these fetches to cache: 'no-store' (HF metadata is cheap) or add a Redis-backed Next cacheHandler; mount .next/cache as emptyDir if any ISR/data cache is kept.
**Verify note:** Verified: revalidate: 3600 at huggingface.ts:81 and output: 'standalone' at next.config.js:3; impact correctly scoped as MINOR (stale-read divergence only).

### [MINOR] SSE stream cannot resume — events between reconnects are silently dropped
`src/app/api/events/route.ts:49`

The route emits `id:` fields (encodeSseChunk, line 16) but ignores the Last-Event-ID header on reconnect — a new subscription starts from 'now'. Rolling deploys of a 2+ replica web tier and LB connection resets make reconnects routine; any dataset.summary.updated events fired during the gap are lost and the client (src/app/datasets/[id]/page.tsx:220, refetch-on-event) shows stale summaries until the next unrelated event fires.

> `const unsubscribe = subscribeRealtime((event: RealtimeEnvelope) => {`

**Fix direction:** On (re)connect, push a snapshot event (current summary state) after 'ready', or back the bus with Redis Streams and replay from Last-Event-ID; at minimum have clients refetch on the 'ready' event.
**Verify note:** Verified: id emitted at line 16, subscription at line 49 starts from 'now', no Last-Event-ID handling anywhere in the route, and the client EventSource at page.tsx ~220 only refetches when an event arrives.

### [INFO] Sessions are stateless JWT — auth tier is already replica-safe, no sticky sessions needed
`src/lib/auth.ts:7`

NextAuth uses the JWT session strategy with no server-side session store, so authentication works identically on any replica; combined with a Redis-backed SSE bus, no LB session affinity is required anywhere. The Phase 1 Authentik OIDC + credentials-fallback design should preserve this (JWT strategy, shared NEXTAUTH_SECRET across replicas) rather than introduce DB/memory session state.

> `session: { strategy: 'jwt', maxAge: 30 * 24 * 60 * 60 }, // 30 days`

**Fix direction:** Record in spec: keep stateless JWT sessions across the NextAuth-Authentik migration; identical NEXTAUTH_SECRET/AUTH_SECRET on all replicas.
**Verify note:** Verified: JWT strategy at auth.ts:7 with a Credentials provider and no adapter/session store in the options.

### [INFO] Benign module-level state: env cache; and no filesystem writes/uploads exist in src
`src/lib/env.ts:65`

The remaining module-level mutables are replica-safe: cachedEnv is an immutable-after-boot parse of process.env (identical across replicas given identical config), db.ts's globalThis Prisma memo is dev-only hot-reload plumbing, and DEFAULT_CLAUDE_MODEL_IDS (models/[id]/verify/route.ts:7) is a constant. A sweep for fs/writeFile/createWriteStream/tmpdir across src found zero filesystem writes — datasets, samples, exports, and config import/export are all DB-backed or streamed — so the web tier needs no shared volume.

> `let cachedEnv: Env | null = null;`

**Fix direction:** No action; note in spec that the container can run with read-only rootfs except Next's .next/cache path (see fetch-cache finding).
**Verify note:** Verified: cachedEnv at env.ts:65, db.ts:13 gates the globalThis memo to non-production, DEFAULT_CLAUDE_MODEL_IDS is a never-mutated const Set at verify/route.ts:7, and an independent grep for fs/writeFile/createWriteStream/tmpdir across src returned zero hits.

## correctness (19 findings: BLOCKER 1 · INFO 1 · MAJOR 11 · MINOR 6)

The run-execution path is the weakest area: the queue, dedupe set, and worker pool are all process-local module state with no atomic DB claim on runs, so restarts strand 'pending' runs forever and a second replica can double-process the same run — the RabbitMQ migration must be specified as claim-based, not a drop-in queue swap. Score handling trusts the judge model's self-reported overallScore (never recomputed from criteria weights; computeWeightedScore is dead code server-side) and coerces non-numeric scores into NaN/0 while marking judgments 'completed', which feeds directly into the public leaderboard that also double-counts superseded runs. Several multi-step Prisma writes lack transactions (rubric/dataset version numbering, dataset summary read-modify-write into remoteMetadata, sample index assignment), each with a concrete concurrent trigger. Error handling still swallows user-visible failures: create_and_run batches return 201 with runsQueued while run creation silently fails in the queue, and the dataset-version endpoint silently ignores an invalid samples payload. Prior fixes for REVIEW_FINDINGS items 5, 7, 13, 15, 16, and 26 each left a residual gap documented below.

### [BLOCKER] In-memory run queue: restarts strand pending runs; no atomic claim allows double-processing across replicas
`src/lib/evaluation-run-manager.ts:67`

The queue, activeIds dedupe set, and worker counters are module-level state in the web process. A run is created with status 'pending' (201 returned) and only ever processed if the same process stays alive; a deploy/crash between create and processRun leaves it 'pending' forever with no startup requeue or reaper (the item-5 catch-all only covers in-process errors). processRun also claims work with an unconditional update to 'judging' (line 127) rather than a guarded transition, so with >=2 replicas (or a re-enqueue) the same run is processed twice, firing duplicate paid LLM calls and interleaved judgment writes.

> `const queue: QueueItem[] = [];`

**Fix direction:** Phase 1 spec: RabbitMQ delivery with ack/redelivery PLUS a DB-level atomic claim (updateMany where status='pending' -> 'judging', rowcount-checked), idempotent judgment writes keyed on (runId, modelConfigId), and a stale-run reaper for orphaned pending/judging states.
**Verify note:** Verified: queue/activeIds/activeWorkers are module-level (lines 67-69); createEvaluationRun writes status 'pending' (line 388); processRun claims with an unguarded update to 'judging' (lines 127-130); no startup requeue exists anywhere in the module.

### [MAJOR] processRun final status blindly overwrites; races human judgment completed -> needs_human
`src/lib/evaluation-run-manager.ts:251`

The human-judgment route explicitly allows submitting while a run is 'judging' and sets status 'completed'; processRun then finishes and unconditionally writes finalStatus ('needs_human' or 'error'), reverting a completed run to needs_human even though a HumanJudgment row exists — lost update with no guard on the current state.

> `data: { status: finalStatus },`

**Fix direction:** Spec state transitions as guarded compare-and-set (updateMany where status='judging') and define the legal state machine, including human-judgment-during-judging semantics.
**Verify note:** Verified: human-judgment route comment at line 123 documents 'judging -> completed' as a supported transition and updates status when != 'completed' (lines 124-129); processRun's update at 249-252 has no where-status guard.

### [MAJOR] create_and_run dataset batches return 201 'runsQueued' but run creation failures are swallowed in the queue
`src/app/api/evaluations/route.ts:516`

For a query-response dataset batch created without rubricId (schema marks it optional), the API returns 201 with runsQueued=N, then each queued createEvaluationRun throws HttpError 400 'No rubric assigned' inside processQueueItem, which pumpQueue only logs — zero EvaluationRun records are ever created and no error reaches the user or any persisted status (residual gap of item 16, which only added logging).

> `enqueueEvaluationRunCreation(evaluation.id, session.user.id);`

**Fix direction:** Validate rubric/model preconditions synchronously before returning 201, and persist queue failures as error-status run records (or evaluation-level error state) surfaced via SSE.
**Verify note:** Verified: rubricId optional in createBatchSchema (line 21); query-response samples get responseText set (lines 498-501) making createEvaluationRun's judge-mode rubric check throw (manager lines 343-351) before any run row is created; pumpQueue catch only console.errors (manager lines 292-295).

### [MAJOR] Judgment score normalization accepts non-numeric values (NaN) and never recomputes overall from criteria weights
`src/lib/llm/provider.ts:232`

A model returning "overallScore": "8.5/10" or a criterion score of "N/A" produces Math.min(Math.max(0, NaN), 10) = NaN, stored on a 'completed' judgment and poisoning every downstream average (dataset summary, public leaderboard); a model that omits overallScore but returns valid criteriaScores is recorded as 0. computeWeightedScore in lib/utils.ts is never called server-side, so the stored overallScore is always the model's unverified self-report and rubric weights never affect the recorded score.

> `overallScore: Math.min(Math.max(0, (parsed.overallScore as number) ?? 0), 10),`

**Fix direction:** Spec strict numeric validation (Number coercion + isFinite reject-or-error), and make the server recompute overallScore from validated criteriaScores via the weighted formula, flagging divergence from the model's self-report.
**Verify note:** Verified: string values pass the ?? check and coerce to NaN through Math.max/min (line 232, criterion path line 224); grep confirms computeWeightedScore (utils.ts:45) has zero call sites in the entire codebase; ModelJudgment.overallScore is Float? so NaN (typeof number) is persisted on a 'completed' row.

### [MAJOR] Circuit breaker counts non-transient failures on a provider-wide shared key: one bad credential blocks all users
`src/lib/llm/resilience.ts:161`

Every error — 401 from a revoked per-model API key, model-not-found, or JSON parse failures — pushes into cb.failures for the shared key ('anthropic' for all endpoint-less Anthropic models, per circuitKey in llm/index.ts:45). One user's 5-judgment batch with a revoked key opens the circuit within the 120s window and all other users' Anthropic judgments fail with CircuitOpenError for 60s, re-opened on each probe failure; distinct from fixed item 7 (endpoint scoping), and the blast radius becomes cluster-wide once CB state moves to Redis in v2.

> `cb.failures.push(Date.now());`

**Fix direction:** Spec: only count transient/provider-health errors (isTransientError) toward the breaker, and scope Redis CB keys by provider+credential-hash+endpoint.
**Verify note:** Verified: withCircuitBreaker's catch (lines 160-171) counts every error with no isTransientError filter; circuitKey (llm/index.ts:44-46) returns bare providerName when config.endpoint is unset, so all users' Anthropic models share one circuit; threshold 5 within 120s window (DEFAULT_CB).

### [MAJOR] Rubric version numbering is read-then-create with no transaction and no uniqueness constraint
`src/app/api/rubrics/[id]/versions/route.ts:88`

Two concurrent POSTs to /versions both read the same max version and both create rubrics with identical version numbers in the family — schema.prisma has no @@unique([parentId, version]) — corrupting version identity (buildRubricVersionOptions renders two 'vN (latest)' entries) exactly where schema v2's judge-model class/versioning contract needs deterministic lineage; the dataset versions route has the identical pattern.

> `const nextVersion = (familyVersions[0]?.version ?? 0) + 1;`

**Fix direction:** Schema v2: @@unique([parentId, version]) on Rubric and Dataset plus transaction-wrapped (or retry-on-P2002) version allocation.
**Verify note:** Verified: read at lines 82-86 and create at line 90 are separate untransacted calls; schema.prisma Rubric (lines 54-74) has only @@unique([userId, slug]), no (parentId, version) constraint; dataset versions route repeats the pattern at its line 51.

### [MAJOR] Dataset evaluation summary uses non-transactional read-modify-write of remoteMetadata JSON
`src/lib/dataset-evaluation-summary.ts:96`

The derived evaluationSummary is spliced into the remoteMetadata JSON string via read-parse-spread-write with no transaction or row lock; two runs of the same dataset completing concurrently (queue concurrency 4 in one process, or two replicas/workers in v2) interleave with each other and with the refresh route, last-writer-wins clobbering either the summary or the HF metadata.

> `remoteMetadata: JSON.stringify({`

**Fix direction:** Schema v2: promote evaluationSummary to dedicated columns/table updated atomically (or computed on read), removing derived state from the remoteMetadata blob.
**Verify note:** Verified: dataset read at line 32, metadata parse at line 91, write at lines 93-101 — no transaction; processRun calls this after every run and RUN_QUEUE_CONCURRENCY defaults to 4, so concurrent same-dataset completions are the normal case.

### [MAJOR] Dataset refresh clobbers stored evaluationSummary and overwrites local sampleCount with HF corpus total
`src/app/api/datasets/[id]/refresh/route.ts:51`

POST /refresh writes remoteMetadata = JSON.stringify(meta), discarding the evaluationSummary key maintained by dataset-evaluation-summary.ts, and sets sampleCount = meta.sampleCount (the full HF split total, e.g. 50k) even though the local samples table still holds only the imported subset (e.g. 10) — after one refresh the dataset reports no evaluation results and a wildly wrong sample count.

> `remoteMetadata: JSON.stringify(meta),`

**Fix direction:** Preserve app-owned keys on refresh (merge, or move summary out of remoteMetadata per the previous finding) and keep local sampleCount authoritative, storing HF's total under a separate field.
**Verify note:** Verified: line 51 serializes only the fresh HF meta (no merge with existing remoteMetadata), and line 52 sets sampleCount = meta.sampleCount, which huggingface.ts:169-172 computes as the sum of num_examples across ALL splits — while import stores only hfRows.length local samples.

### [MAJOR] Missing human overallScore is coerced to 0 and pollutes human-score averages
`src/app/api/evaluations/[id]/runs/[runId]/human-judgment/route.ts:101`

overallScore is optional in the zod schema but HumanJudgment.overallScore is a non-nullable Float, so respond-mode submissions (which only select a best model) and judge-mode submissions with criteria-only scoring are stored as overallScore=0; dataset-evaluation-summary counts every non-null value, so averageHumanScore is dragged toward 0 by judgments that carry no score at all. criteriaScores are also accepted without upper-bound (score vs maxScore) or rubric-membership validation.

> `typeof data.overallScore === 'number' ? data.overallScore : 0;`

**Fix direction:** Schema v2: nullable HumanJudgment.overallScore (absent means unscored, excluded from aggregates); validate criteriaScores against the run's rubric criteria and clamp to maxScore.
**Verify note:** Verified: zod marks overallScore optional (line 9), coercion to 0 at lines 100-101, schema.prisma HumanJudgment.overallScore is non-nullable Float (line 227), and dataset-evaluation-summary.ts lines 77-79 include every non-null value (0 included) in averageHumanScore; criteriaScores zod has score min(0) only, no maxScore or rubric cross-check.

### [MAJOR] Dataset version POST silently ignores an invalid samples payload and duplicates old samples
`src/app/api/datasets/[id]/versions/route.ts:77`

The body parse and zod validation are wrapped in a try/catch whose catch falls through to 'duplicate existing samples as-is', so a user submitting edited samples where one row fails validation (e.g. empty input) gets a 201 new version containing the OLD samples — their edits are silently discarded and the version lineage records wrong data.

> `// No body or invalid body — duplicate existing samples as-is`

**Fix direction:** Distinguish empty/absent body (legitimate duplicate) from present-but-invalid body (return 400 with zod details).
**Verify note:** Verified: try block at lines 55-75 wraps both request.json() and schema.parse; the bare catch at lines 76-78 swallows ZodError identically to a missing body, and creation proceeds with existing.samples returning 201.

### [MAJOR] query-response samples with empty 'expected' silently flip to respond mode inside a judge batch
`src/app/api/evaluations/route.ts:500`

For a query-response dataset, responseText is sample.expected || undefined; any sample whose expected field is empty (common in real HF imports, where String(row[col] ?? '') yields '') produces an evaluation with no responseText, which processRun's isJudgeMode check (Boolean(responseText?.trim())) routes to respond mode — that sample gets model-generated answers instead of rubric judgments, with no rubric error and no warning, silently mixing labelling semantics within one batch and skewing per-dataset score coverage.

> `? sample.expected || undefined`

**Fix direction:** Validate per-sample completeness at batch creation for query-response datasets: reject the batch or explicitly mark incomplete samples as skipped, never silently switch modes.
**Verify note:** Verified: quote at line 500 (dataset mode; same pattern at line 418 for remote-dataset); HF import coerces missing cells to '' via String(row[col] ?? '') at line 354; processRun (manager line 117) and createEvaluationRun (line 343) both derive mode solely from responseText truthiness.

### [MAJOR] Public leaderboard aggregates every judgment from all historical runs, double-counting re-runs
`src/app/api/leaderboard/route.ts:44`

The query selects all completed ModelJudgments in the project with no latest-run-per-evaluation restriction, so re-running an evaluation adds another score row per model — models on frequently re-run evaluations are over-weighted and superseded runs are never excluded; 'evaluationCount: sorted.length' actually reports judgment count. This is the flagship public-read surface of the v2 access model, and it also ignores judge-model version identity.

> `const judgments = await prisma.modelJudgment.findMany({`

**Fix direction:** Spec latest-run-per-(evaluation, model) aggregation keyed on the schema v2 judge-model class/version identity (inventory doc section 7), with explicit staleness rules for superseded runs.
**Verify note:** Verified: where clause (lines 45-53) filters only status/score/projectId with no run-recency restriction, unlike dataset-evaluation-summary which takes runs[0] only; evaluationCount is set to sorted.length (per-model judgment count) at line 117.

### [MINOR] resolveModelIds omits the isActive filter that createEvaluationRun enforces
`src/app/api/evaluations/route.ts:165`

Evaluation creation validates models with only isVerified:true, while createEvaluationRun requires isVerified AND isActive (evaluation-run-manager.ts:374), so selecting a verified-but-deactivated model creates the evaluation successfully and then every run attempt fails with 'missing, inactive, or not verified' — for create_and_run dataset batches the failure is additionally swallowed in the queue, leaving permanently runless evaluations.

> `where: { id: { in: selectedModelIds }, isVerified: true },`

**Fix direction:** Unify model-eligibility predicates in one shared helper used by both creation and run paths.
**Verify note:** Verified: line 165 checks isVerified only; manager line 374 requires isVerified AND isActive and throws HttpError 400 when counts mismatch, which the batch queue path only logs.

### [MINOR] Queue dedupe silently drops legitimate re-run requests for in-flight evaluations
`src/lib/evaluation-run-manager.ts:316`

enqueueEvaluationRunCreation keys dedupe on eval:<id> and returns silently when present, so triggering create_and_run on the same dataset twice while the first batch is still draining (plausible: N samples at worker concurrency 4) drops run creation for every still-active evaluation while the API response claims runsQueued for all of them — the flip side of the item-15 dedupe fix.

> `if (activeIds.has(key)) return; // already queued or in-flight`

**Fix direction:** Return queued/skipped per item to the caller (or allow re-enqueue with generation counters); in the RabbitMQ design, make dedupe explicit and observable rather than a silent no-op.
**Verify note:** Verified: line 316 returns void with no signal to the caller; the evaluations route (lines 514-518) unconditionally reports runsQueued = evaluations.length regardless of dedupe drops. Note: batch mode creates NEW evaluation rows per POST so the exact repro needs re-triggering runs on existing evaluations (e.g. via a re-run path), which the silent-void API makes indistinguishable — claim stands.

### [MINOR] Half-open circuit probe still runs with full retry because state is read before the open->half-open transition
`src/lib/llm/resilience.ts:207`

resilientCall reads getCircuitState before withCircuitBreaker performs the open->half-open transition, so on the first call after resetTimeoutMs the state reads 'open', maxAttempts stays 3, and the recovering service receives up to 3 probe requests — contradicting the documented single-probe contract and partially undoing the item-26 fix.

> `const circuitState = getCircuitState(providerKey);`

**Fix direction:** Move retry-suppression inside the breaker (pass probe-mode into fn) or expose a claimProbe() that atomically performs the transition; carry this into the Redis-backed CB design.
**Verify note:** Verified: line 207 reads state before withCircuitBreaker's open->half-open transition (lines 136-139), so the first post-timeout call sees 'open' and keeps default maxAttempts 3, contradicting the docstring at lines 199-200 promising a single probe.

### [MINOR] Retryability classified by substring-matching error messages that embed LLM response text
`src/lib/llm/resilience.ts:231`

isTransientError greps the error message, and parse failures from parseJudgmentResponse embed a 200-char preview of the LLM's own output (provider.ts:197-201) — a judged submission or model response containing 'timeout', '429', or 'network' makes a deterministic parse failure spuriously retryable, while a genuinely malformed-JSON generation (often fixed by a re-ask) is deliberately never retried; classification depends on judged content.

> `const msg = error.message.toLowerCase();`

**Fix direction:** Classify on typed errors / SDK status codes instead of message text, and add an explicit bounded re-ask policy for malformed-JSON judgments.
**Verify note:** Verified: isTransientError substring-matches at lines 231-264; parseJudgmentResponse throws with a 200-char lowercasable response preview embedded in the message (provider.ts lines 197-201), so retry classification is a function of LLM output content.

### [MINOR] Concurrent sample POSTs collide on the (datasetId, index) unique constraint
`src/app/api/datasets/[id]/samples/route.ts:60`

startIndex is read from _count.samples outside the create transaction, so two concurrent POSTs compute identical start indexes and the second violates @@unique([datasetId, index]) (P2002), surfacing as a generic 500 'Failed to add samples'; the subsequent sampleCount update is also outside the transaction so a partial failure leaves the count drifted.

> `const startIndex = dataset._count.samples;`

**Fix direction:** Compute max(index)+1 inside the same interactive transaction as the creates and the count update (or serialize per-dataset writes).
**Verify note:** Verified: _count read at lines 45-48 precedes the $transaction at line 61; schema.prisma DatasetSample has @@unique([datasetId, index]) (line 340); catch handles only ZodError specially, so P2002 falls to generic 500; sampleCount update at lines 76-79 is a separate statement.

### [MINOR] Run with zero surviving model selections finishes as needs_human with no judgments
`src/lib/evaluation-run-manager.ts:247`

Deleting a ModelConfig while its run is queued cascades away RunModelSelection and ModelJudgment rows (onDelete: Cascade), so processRun iterates zero selections, completedCount=0 and errorCount=0, and the ternary (error only when errorCount > 0) marks the run 'needs_human' — a judgment-less run presented to the human labeller instead of an error.

> `: 'needs_human';`

**Fix direction:** Treat zero-selection / zero-judgment completion as 'error' with an explanatory message; schema v2 should snapshot model identity into the run rather than cascading it away.
**Verify note:** Verified: schema.prisma RunModelSelection (line 193) and ModelJudgment (line 208) both cascade on modelConfig deletion; with zero selections the chunk loop is skipped and finalStatus ternary (lines 244-247) yields 'needs_human' since errorCount is 0.

### [INFO] Default model resolution selects the first 10 verified models globally, across users
`src/app/api/evaluations/route.ts:151`

When modelConfigIds is omitted, resolveModelIds picks the 10 oldest active+verified ModelConfigs with no userId filter, and explicit IDs are likewise validated without ownership — evaluations can silently execute against other users' model configs and their stored (encrypted) API keys; recorded here as correctness context since it also makes 'default models' nondeterministic per deployment, with the access-control fix belonging to the auth-v2 ownership-check mandate.

> `where: { isActive: true, isVerified: true },`

**Fix direction:** Scope model resolution to session.user.id (plus explicitly shared/system models) as part of the v2 ownership-on-every-mutation rule.
**Verify note:** Verified: default lookup (lines 149-157) and explicit-ID validation (lines 163-171) both lack a userId predicate; ModelConfig has a required userId owner with per-model apiKey (schema lines 89-112), so cross-user execution against others' stored keys is real.

## security-access-model (20 findings: BLOCKER 1 · INFO 4 · MAJOR 8 · MINOR 7)

Route inventory: 33 of 37 route files consistently use requireAuth + per-record ownership checks (userId !== session.user.id && !isAdmin) — no classic IDOR survives (items 9/10 fixes hold); the only unauthenticated endpoints are /api/health, /api/leaderboard, /api/api-keys/scopes, and /api/auth/register, all intentional. The central v2 contradiction is the opposite direction: every dataset/rubric read runs requireAuth BEFORE the visibility check, so 'public' datasets are not publicly readable, and Rubric has no visibility field at all — the v2 public-reads model is unimplementable without schema and route-ordering changes. Horizontal scale is broken today: all rate limiting (middleware Edge Map + rate-limit.ts) is per-process in-memory, and the three pre-built limiters (judge/api/auth) are dead code, leaving LLM-spend and HuggingFace-proxy routes behind only a generic spoof-sensitive 120/min IP limit. Secrets: ModelConfig.apiKey is encrypted on every write path, redacted from every response, excluded from config export, and never logged — but models/[id]/verify passes the raw ciphertext to the provider (missing decryptSafe), and scoped developer API keys can mint new full-scope keys (privilege escalation). Deferred LOW items 30, 32, 33, 35, 36 re-verified still real; 31 remains intentional; 34's 'no health endpoint exists' note is stale (endpoint now exists with correct prod redaction).

### [BLOCKER] All rate limiting is per-process in-memory; breaks at >=2 web replicas
`src/middleware.ts:17`

Both the Edge middleware limiter and every limiter in src/lib/rate-limit.ts (line 41 `const windows = new Map(...)`) keep state in a process-local Map, so in the v2 stateless >=2-replica web tier limits multiply by replica count, reset on every deploy/restart, and diverge per pod; nothing Redis-backed exists despite v2 declaring Redis mandatory for rate limiting, and the middleware runs in the Edge runtime where a TCP Redis client cannot be used.

> `const rateLimitMap = new Map<string, { count: number; resetAt: number }>();`

**Fix direction:** Spec must move rate limiting out of Edge middleware into Redis-backed per-route (Node runtime) guards or the ingress layer, keyed per-user/per-key not just per-IP, and mandate TRUSTED_PROXY=true behind ingress-nginx.
**Verify note:** Quote at middleware.ts:17 and windows Map at rate-limit.ts:41 confirmed; repo grep shows Redis only in the realtime bus, and v2 spec line 112-113 explicitly requires 'rate limiting and circuit-breaker state move to Redis' for the stateless web tier.

### [MAJOR] Public reads unimplemented: requireAuth precedes visibility check on all dataset/rubric reads
`src/app/api/datasets/[id]/route.ts:21`

GET /api/datasets/[id] (and datasets list, datasets/[id]/export, datasets/[id]/versions, all rubric reads, /api/stats) returns 401 to anonymous callers before the `dataset.visibility !== 'public'` check at line 58 ever runs, so datasets marked public are only visible to logged-in users — directly contradicting the v2 model of public reads for published research data; /api/leaderboard is currently the only public research read.

> `const session = await requireAuth();`

**Fix direction:** Phase 1 spec: define an optionalAuth() guard for read routes that resolves session-if-present, serves visibility='public' records anonymously via a public serializer, and keeps 401/403 for private records and all writes.
**Verify note:** Confirmed: requireAuth at line 21 returns 401 before the visibility check at lines 55-59; repo-wide scan shows only leaderboard/health/scopes/nextauth/register lack requireAuth, and v2 spec line 131-133 requires public reads for 'leaderboard, published datasets/rubrics'.

### [MAJOR] Scoped developer API keys can mint new full-scope keys (privilege escalation)
`src/app/api/api-keys/route.ts:60`

POST /api/api-keys calls only requireAuth (no requireScope — and no api-keys:* scope exists in permissions.ts), and requireAuth accepts Bearer vgk_ API keys (auth-guard.ts:95), so a stolen key scoped to e.g. only datasets:read can create a brand-new key with ALL scopes; GET /api/api-keys and PATCH/DELETE /api/api-keys/[id] are equally scope-unchecked, defeating the entire scope model.

> `const session = await requireAuth();`

**Fix direction:** Spec: API-key management endpoints must reject API-key-authenticated callers (session-only), or introduce a dedicated admin-only scope that keys can never grant to other keys.
**Verify note:** Confirmed: no requireScope in api-keys/route.ts or api-keys/[id]/route.ts (lines 13/57/168 use requireAuth+isAdmin only), PERMISSION_SCOPES has no api-keys entry, and requireAuth tries authenticateApiKey first at auth-guard.ts:95.

### [MAJOR] SSE /api/events broadcasts every user's realtime events to any authenticated subscriber
`src/app/api/events/route.ts:49`

The SSE handler subscribes to the global bus with only client-chosen topic/datasetId filters and no ownership filter, so any authenticated user (or key with just evaluations:read) receives dataset.summary.updated events for ALL users' private datasets — leaking dataset IDs, sample counts, and average model/human scores cross-tenant; the RealtimeEnvelope carries no ownerId, so the planned Redis SSE bus cannot filter without an envelope schema change.

> `const unsubscribe = subscribeRealtime((event: RealtimeEnvelope) => {`

**Fix direction:** Spec the v2 Redis SSE envelope with ownerId/visibility fields and server-side per-subscriber filtering (owner, admin, or public-visibility events only).
**Verify note:** Confirmed: subscribe callback at line 49 filters only on client-supplied topic/datasetId; realtime/types.ts RealtimeEnvelope has id/type/topic/timestamp/payload only, and DatasetSummaryUpdatedPayload carries datasetId, sampleCount, and average scores.

### [MAJOR] Model verify sends stored ciphertext as the provider API key (missing decryptSafe)
`src/app/api/models/[id]/verify/route.ts:41`

POST /api/models/[id]/verify passes model.apiKey straight to verifyModelConnection, but the stored value is the `enc:v1:...` AES-GCM ciphertext (encrypted at write in models/route.ts:74); verify.ts:13 uses `input.apiKey || process.env.ANTHROPIC_API_KEY`, so verification always fails for any model with a per-model key and the ciphertext blob is transmitted to the third-party provider as a bearer credential — the only call site that bypasses decryptSafe (evaluation-run-manager.ts:176/207 decrypt correctly).

> `apiKey: model.apiKey || undefined,`

**Fix direction:** Wrap in decryptSafe() like evaluation-run-manager does; Phase 1 provider layer v2 should centralize key decryption in one resolver so OpenRouter/vLLM paths cannot repeat this.
**Verify note:** Confirmed: models/route.ts:74 calls encryptIfNeeded on write, verify route line 41 passes model.apiKey raw with no crypto import, verify.ts:13 falls back to env, and evaluation-run-manager.ts:176/207 are the only decryptSafe call sites.

### [MAJOR] Registration limiter keys on unconditionally-trusted X-Forwarded-For (spoofable bypass)
`src/app/api/auth/register/route.ts:17`

The route-level 3/hour registration limiter derives its key from the raw x-forwarded-for header without the TRUSTED_PROXY gating that fixed item 1 in middleware.ts:57, so an attacker sends a random XFF value per request and bypasses the hourly cap entirely (falling back to only the middleware 5/min limit), enabling mass account creation on the live deployment.

> `const clientIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()`

**Fix direction:** Reuse the middleware getClientIp/TRUSTED_PROXY logic (or retire the route per Auth v2); spec a single shared client-IP resolver so the fixed pattern cannot regress route-by-route.
**Verify note:** Confirmed: line 17 reads raw XFF first-element with no TRUSTED_PROXY gate, unlike middleware.ts:56-69 getClientIp; per-request random XFF yields a fresh `register:` limiter key.

### [MAJOR] judgeLimiter/apiLimiter/authLimiter are dead code; LLM and HuggingFace routes have no dedicated limits
`src/lib/rate-limit.ts:114`

grep confirms judgeLimiter, apiLimiter, and authLimiter are imported nowhere (only registrationLimiter is wired), so POST /api/evaluations/[id]/runs (real LLM spend per call) and /api/datasets/huggingface/{preview,rows} (outbound fetch proxy, up to 100 rows/request) are protected only by the generic 120/min-per-IP middleware limiter — no per-user or per-key quota exists for the most expensive operations.

> `export const judgeLimiter = createRateLimiter({`

**Fix direction:** Phase 1 spec: Redis-backed per-user quotas on run-creation (and queue-depth caps in the RabbitMQ worker design) plus per-user limits on the HuggingFace proxy routes; delete or wire the dead limiters.
**Verify note:** Confirmed: repo grep shows only registrationLimiter imported (register/route.ts:5); runs and huggingface routes use requireAuth/requireScope only, no limiter references.

### [MAJOR] Rubric has no visibility field — 'published rubrics' cannot exist in the schema
`prisma/schema.prisma:54`

Only Dataset carries `visibility String @default("private")` (line 282); the Rubric model has no visibility/published column and rubrics/[id]/route.ts:48 hard-forbids any non-owner non-admin read, so the v2 requirement 'public reads for published rubrics' has no data-model support — this must land in the schema-v2 migration alongside the judge-model class/versioning work.

> `model Rubric {`

**Fix direction:** Add visibility (or publishedAt) to Rubric in schema v2 with an index, plus a public read serializer; decide whether Evaluation/leaderboard artifacts need the same flag.
**Verify note:** Confirmed: schema grep shows visibility only at Dataset line 282 (+index 323), Rubric model at line 54 has none, rubrics/[id] returns 403 for non-owner/non-admin, and v2 spec line 133 names 'published datasets/rubrics' as public reads.

### [MAJOR] Dataset responses embed owner email — becomes anonymous-facing PII leak under v2 public reads
`src/app/api/datasets/route.ts:76`

The dataset list (visible to all authenticated users for visibility='public' rows via the OR at line 62) and GET /api/datasets/[id] (line 30) both include the owner's email in the response; today that leaks every publisher's email to any logged-in user, and once v2 makes published-dataset reads anonymous it exposes emails to the open internet.

> `user: { select: { id: true, name: true, email: true } },`

**Fix direction:** Spec a public serializer exposing owner display name/id only; email never leaves owner/admin-scoped responses.
**Verify note:** Confirmed: identical email-including select at datasets/route.ts:76 and datasets/[id]/route.ts:30, with the public-visibility OR at list lines 62-65.

### [MINOR] CSP still allows 'unsafe-inline' scripts in production despite item 19 marked fixed
`src/middleware.ts:81`

The production script-src branch retains 'unsafe-inline' (only unsafe-eval was removed), neutralizing CSP as an XSS mitigation; additionally connect-src (line 86) hard-codes huggingface/anthropic/openai hosts and the Railway domain env var, which is stale for the k8s migration and for provider layer v2 (OpenRouter/vLLM are server-side and need no CSP entry).

> `? "script-src 'self' 'unsafe-inline'"`

**Fix direction:** Phase 1: nonce-based CSP via Next.js middleware-generated nonce, and parameterize allowed origins for the k8s ingress instead of RAILWAY_PUBLIC_DOMAIN.
**Verify note:** Confirmed: prod branch at line 81 keeps 'unsafe-inline', connect-src with RAILWAY_PUBLIC_DOMAIN at line 86, and REVIEW_FINDINGS.md line 26 shows item 19 checked off.

### [MINOR] Email-fallback session resolution is an account-linking hazard for Authentik OIDC
`src/lib/auth-guard.ts:116`

When the JWT's user id is not found, requireAuth silently re-resolves the session by email; benign with only the credentials provider, but once Auth v2 adds the Authentik OIDC provider, an OIDC identity presenting a matching (potentially attacker-controlled or unverified) email claim would be bound to the existing credentials account — a classic cross-provider account-takeover vector.

> `const dbUserByEmail = await prisma.user.findUnique({`

**Fix direction:** Auth v2 spec must define explicit account-linking policy: verified-email-only linking, stable provider-subject mapping (Account table), and removal of the silent email fallback.
**Verify note:** Confirmed: fallback at lines 115-121 resolves by email whenever the JWT user id lookup misses; only CredentialsProvider exists today so severity MINOR is right as a forward-looking hazard.

### [MINOR] JWT sessions last 30 days with no rotation (LOW item 35 still real, now Auth-v2 scope)
`src/lib/auth.ts:7`

Item 35 re-verified: session maxAge remains 30 days with no rotation or revocation path; since Phase 1 rebuilds auth around Authentik OIDC + credentials fallback, session lifetime/rotation should be resolved there rather than remaining a deferred LOW.

> `session: { strategy: 'jwt', maxAge: 30 * 24 * 60 * 60 }, // 30 days`

**Fix direction:** Fold into Auth v2 spec: shorter session maxAge with sliding refresh, and rely on Authentik session revocation for the OIDC path.
**Verify note:** Confirmed verbatim at auth.ts:7; JWT strategy with no revocation mechanism elsewhere in the file.

### [MINOR] audit() is defined but never called from any route
`src/lib/audit.ts:49`

A full audit framework exists (AuditLog model at schema.prisma:346, action taxonomy, and AuthSession.apiKeyId documented 'for audit logging') but grep shows zero call sites — no mutation, login, or API-key operation writes an audit entry, so the v2 ownership-gated write model has no audit trail despite the plumbing being ready.

> `export function audit(entry: AuditEntry): void {`

**Fix direction:** Phase 1: wire audit() into all mutations and auth events (or drop the dead model), and route worker-side mutations through it too.
**Verify note:** Confirmed: audit() at line 49 with a 23-action taxonomy, AuditLog model at schema.prisma:346, and repo grep finds zero call sites outside audit.ts.

### [MINOR] Dead ApiKeyStore model stores provider keys in a plaintext column
`prisma/schema.prisma:243`

ApiKeyStore (global per-provider key, `apiKey String`) has zero references anywhere in src/ — it predates the encrypted per-ModelConfig key path and, if ever revived, would bypass crypto.ts entirely since nothing encrypts writes to it.

> `apiKey    String`

**Fix direction:** Drop ApiKeyStore in the schema-v2 migration; provider-level defaults belong in env/secret-manager, not an unencrypted table.
**Verify note:** Confirmed: model ApiKeyStore at line 240 with plain `apiKey    String` at 243; grep -rn ApiKeyStore over src/ returns nothing.

### [MINOR] Realtime bus silently falls back to in-memory when REDIS_URL is unset
`src/lib/realtime/factory.ts:27`

createRealtimeBus defaults to the in-memory adapter when REDIS_URL is missing and REALTIME_ADAPTER is unset, so a misconfigured k8s deploy would boot green while SSE events published on one replica (or the future RabbitMQ workers) never reach subscribers on another — contradicting v2's 'Redis mandatory' posture which implies fail-fast.

> `: 'memory';`

**Fix direction:** Spec: in production, missing REDIS_URL is a boot failure (env.ts validation), with memory adapter allowed only in dev/test.
**Verify note:** Confirmed: adapter ternary at lines 20-27 falls through to 'memory'; env.ts:36-37 marks REDIS_URL optional with default 'memory', and v2 spec line 111-112 makes the Redis adapter 'the mandatory default'.

### [MINOR] /api/auth/register retirement blast radius: 5 UI/infra touchpoints and no replacement provisioning path
`src/middleware.ts:127`

Retiring registration touches: the route itself (src/app/api/auth/register/route.ts), the page src/app/register/page.tsx, links at src/app/login/page.tsx:121 and src/app/page.tsx:132/171/258/410, the publicPaths entry at src/components/layout/app-shell.tsx:10, this middleware rate-limit branch, registrationLimiter (rate-limit.ts:120), and the unused 'user.register' audit action; no tests or scripts reference it, but scripts/ contains no user-provisioning tool, so with register gone the v2 credentials fallback has no way to create its break-glass users except direct DB writes.

> `pathname.startsWith('/api/auth/register') ||`

**Fix direction:** Phase 1: remove all eight touchpoints, make Authentik the sole signup path, and ship an operator CLI/seed script for provisioning credentials-fallback accounts.
**Verify note:** Confirmed: quote at middleware.ts:127; spot-checked login/page.tsx:121, page.tsx 132/171/258/410, app-shell.tsx:10 publicPaths, register/page.tsx exists, and scripts/ holds only add-dark-mode.mjs, controller.mjs, test-api-keys.ts.

### [INFO] LOW item 34 status is stale — health endpoint now exists (with correct prod redaction)
`REVIEW_FINDINGS.md:43`

The note 'N/A (no health endpoint exists)' is outdated: src/app/api/health/route.ts:19 now implements GET /api/health, unauthenticated (appropriate for k8s probes), redacting DB errors to 'unavailable' in production (line 34); it publicly exposes version and uptime, which is acceptable but worth an explicit call in the spec.

> `- [ ] 34. Health endpoint leaks error messages — N/A (no health endpoint exists)`

**Fix direction:** Update the ledger entry; v2 spec should add Redis/RabbitMQ dependency checks to the same endpoint for k8s readiness probes.
**Verify note:** Confirmed: ledger quote at line 43; health route exists, unauthenticated, with isProd ? 'unavailable' redaction of DB errors.

### [INFO] LOW item 30 still real: new provider SDK client per call
`src/lib/llm/anthropic.ts:36`

Re-verified: a new Anthropic client is constructed on every judge/verify call (also line 82, and openai-compatible.ts:50/105); tolerable today but the v2 queue-backed workers hitting local vLLM and OpenRouter should reuse clients/connections, so provider layer v2 is the natural place to fix it.

> `const client = new Anthropic({ apiKey });`

**Fix direction:** Provider layer v2: per-(provider,endpoint,keyHash) client cache in the worker process.
**Verify note:** Confirmed: new Anthropic at anthropic.ts:36 and 82 (plus verify.ts:18), new OpenAI at openai-compatible.ts:50 and 105.

### [INFO] LOW items 32/36 still real: dashboard fetches once, no 401 handling or refresh
`src/app/dashboard/page.tsx:39`

Re-verified: the dashboard loads /api/stats, /api/evaluations, /api/projects exactly once in a mount-only useEffect; non-ok responses (e.g. 401 for logged-out users) are silently ignored leaving an empty-zeros dashboard (item 32), and data never refreshes (item 36) — both remain deferred UX items, unchanged by v2.

> `useEffect(() => {`

**Fix direction:** Keep deferred; optionally fold into the v2 SSE work (dashboard subscribes to the realtime bus instead of polling).
**Verify note:** Confirmed: useEffect at line 39 with empty dep array at line 68; each fetch guarded only by `if (res.ok)` with no error branch.

### [INFO] LOW item 33 still real: ModelJudgment and DatasetSample lack updatedAt
`prisma/schema.prisma:217`

Re-verified: ModelJudgment (model at line 203) has only createdAt, and DatasetSample (line 327, createdAt at 337) likewise has no updatedAt — since schema v2 already migrates these tables for judge-model classes/versioning, adding updatedAt there is nearly free and useful for the judgment-audit story.

> `createdAt      DateTime      @default(now())`

**Fix direction:** Include updatedAt @updatedAt on both models in the schema-v2 migration; item 31 (keyboard 0 = 10/10, human-judgment-form.tsx:122) re-verified as intentional, no action.
**Verify note:** Confirmed: ModelJudgment (line 203) createdAt-only at 217, DatasetSample (327) createdAt-only at 337; the 0-key handler is at src/components/evaluation/human-judgment-form.tsx:122 (singular 'evaluation' dir, line number exact).

## schema-fit (16 findings: BLOCKER 2 · INFO 1 · MAJOR 9 · MINOR 4)

The v1 schema is a single-user labelling-tool shape and the v2 contract is a provenance-first research-registry shape; the gap is structural, not cosmetic. Two genuine conflicts require restructures with data migration: (1) mutable-in-place ModelConfig must be split into JudgeModel + immutable JudgeModelVersion with every existing ModelJudgment backfilled to a synthesized version pin, and (2) criteriaScores JSON-text must become relational (or at least JSONB) rows for calibration queries to be computable in SQL. A third restructure is conditional: the Evaluation/ModelJudgment shape is pointwise-only, so pairwise/listwise protocol support (pairOrder, position-bias measurement) needs a candidate-response entity. The onDelete graph is the most dangerous part — cascades from User/ModelConfig and SetNull on rubric pins silently destroy exactly the provenance the contract says must survive — but the fixes are cheap schema flips (Restrict + soft-delete) once the semantics are decided. Everything else (JudgeModel metadata fields, GoldenSet/GoldenLabel/CalibrationRun tables, idempotency unique key, leaderboard composite indexes, native enums) is clean-extend. Recommended migration sequencing: fix onDelete semantics first (no data movement), then freeze ModelConfig writes and snapshot each config into a seed JudgeModelVersion, backfill judgment pins, then parse-and-migrate criteriaScores; the pairwise entity can land as a v2-only shape with v1 rows grandfathered as pointwise.

### [BLOCKER] ModelConfig is mutable-in-place; contract requires immutable versioned JudgeModel
`prisma/schema.prisma:94`

CONFLICT/RESTRUCTURE: ModelConfig has no version, parentVersionId, or immutability — name/provider/modelId/endpoint are freely editable while historical ModelJudgment rows keep pointing at the same row, so editing a config silently rewrites the meaning of every past judgment. The §7 contract requires a versioned JudgeModel where any change to weightsRevision/quantization/servingBackend/endpointClass mints a new version. Migration must split ModelConfig into JudgeModel (identity + credentials) and JudgeModelVersion (immutable snapshot), synthesize one seed version per existing config, and backfill all judgments.

> `modelId              String                     // e.g. 'claude-sonnet-4-5-20250514'`

**Fix direction:** Introduce JudgeModel + immutable JudgeModelVersion tables; migrate each ModelConfig to a seed version and repoint judgments; keep ModelConfig only as user-facing credential/endpoint wrapper.
**Verify note:** Confirmed: ModelConfig (lines 89-112) has no version/parent/immutability fields and ModelJudgment.modelConfigId (line 207) points at the mutable row; the Rubric model shows the codebase knows the versioning idiom but ModelConfig lacks it.

### [BLOCKER] ModelJudgment cascades on ModelConfig deletion — judgments do not survive judge deletion
`prisma/schema.prisma:208`

CONFLICT: deleting a ModelConfig hard-deletes every judgment it ever produced via onDelete: Cascade, directly violating the contract requirement that judgments survive judge deletion (leaderboard and calibration history are built from these rows). Same cascade fires transitively when a User is deleted (User -> ModelConfig cascade at line 102).

> `modelConfig    ModelConfig   @relation(fields: [modelConfigId], references: [id], onDelete: Cascade)`

**Fix direction:** v2: judgments reference immutable JudgeModelVersion with onDelete: Restrict; judge retirement is a soft-delete (archivedAt/supersededBy) never a row delete.
**Verify note:** Confirmed: onDelete: Cascade at line 208 exactly as quoted; User->ModelConfig cascade at line 102 also verified, so user deletion transitively wipes all judgments by their judges.

### [MAJOR] User-deletion cascade chain wipes all runs and judgments (triggeredBy, Project->Evaluation->Run)
`prisma/schema.prisma:174`

CONFLICT: EvaluationRun.triggeredBy is onDelete: Cascade, and the parallel chain User->Project(44)->Evaluation(121)->EvaluationRun(169)->ModelJudgment(206) is Cascade end-to-end, so deleting one user account destroys leaderboard judgments that v2 exposes as public research data. HumanJudgment.user (line 233) is also Cascade, destroying the future golden-label source.

> `triggeredBy        User                @relation(fields: [triggeredById], references: [id], onDelete: Cascade)`

**Fix direction:** Phase 1 spec must define account-deletion semantics: anonymize (SetNull to nullable triggeredById) for runs feeding public/leaderboard data; Cascade only for fully private artifacts.
**Verify note:** Confirmed: quote exact at line 174; verified every link in the cited chain (lines 44, 121, 169, 206) is onDelete: Cascade and HumanJudgment.user at line 233 is Cascade too.

### [MAJOR] Rubric pin on EvaluationRun is SetNull — rubric deletion silently severs judgment provenance
`prisma/schema.prisma:171`

CONFLICT: the comment on line 170 calls rubricId a 'rubric version pinned at run time', but onDelete: SetNull means deleting the rubric nulls the pin on completed runs — the contract requires rubricVersionId provenance on every judgment and judgments must survive rubric deletion with provenance intact, not with a NULL hole. RubricCriterion rows are additionally Cascade-deleted with the rubric (line 79), leaving criterionId references inside criteriaScores JSON dangling.

> `rubric             Rubric?             @relation(fields: [rubricId], references: [id], onDelete: SetNull)`

**Fix direction:** Restrict rubric-version deletion once referenced by any run; rubric retirement becomes soft-delete; completed runs must require non-null rubricId at the application/constraint level.
**Verify note:** Confirmed: SetNull at line 171 and the 'rubric version pinned at run time' comment at line 170 both exact; RubricCriterion Cascade at line 79 verified, and criteriaScores JSON (line 212) embeds criterionId that would dangle.

### [MAJOR] ModelJudgment lacks all §7 per-judgment provenance fields
`prisma/schema.prisma:209`

CLEAN-EXTEND: ModelJudgment carries only score/reasoning/rawResponse/latency/tokens — none of the contract's provenance fields: judgeModelVersionId (immutable pin), promptTemplateVersion (no prompt-template table or version string exists anywhere in the schema, the judge prompt lives only in code), sampling params (temperature/top_p/seed), reasoningEnabled (actual per-run state), pairOrder. Columns are addable, but promptTemplateVersion needs a home (new versioned table or pinned hash) decided in the Phase 1 spec.

> `overallScore   Float?`

**Fix direction:** Add judgeModelVersionId FK, promptTemplateVersion (hash or FK to new PromptTemplate table), samplingParams JSONB, reasoningEnabled Boolean, pairOrder enum — all NOT NULL for new rows, nullable-grandfathered for v1 rows.
**Verify note:** Confirmed: ModelJudgment (lines 203-221) has exactly the fields listed and nothing else; grep verified zero PromptTemplate references in prisma/ or src/, and judge prompts live in src/lib/llm/{provider,anthropic,openai-compatible}.ts.

### [MAJOR] Pointwise-only Evaluation shape cannot represent pairwise/listwise protocols
`prisma/schema.prisma:126`

RESTRUCTURE: Evaluation holds exactly one candidate (responseText) and ModelJudgment scores that single artifact; there is no candidate/response entity, so the contract's protocol matrix {pointwise, pairwise, listwise} x {score, ranking, selection} and pairOrder (AB vs BA, needed for position-bias |P(A)-0.5| in CalibrationRun) are unrepresentable — grep confirms zero pairwise concepts in the codebase. HumanJudgment.selectedBestModelId compares judges, not candidate responses.

> `responseText    String?                    // optional response/output to evaluate against rubric`

**Fix direction:** Introduce a Candidate/Response child entity of Evaluation (ordered, N>=1) and make judgments target candidate-sets with protocol + pairOrder fields; migrate v1 rows as single-candidate pointwise.
**Verify note:** Confirmed: quote exact at line 126; independently re-ran grep for pairwise/pairOrder/listwise across src/ and prisma/ — zero hits; selectedBestModelId (line 230-231) FKs to ModelConfig, not any response entity.

### [MAJOR] criteriaScores stored as JSON text (String, not JSONB) blocks calibration SQL
`prisma/schema.prisma:212`

RESTRUCTURE: criteriaScores on ModelJudgment (and HumanJudgment line 229) is a plain text column round-tripped via JSON.stringify (evaluation-run-manager.ts:189), so CalibrationRun computations (per-criterion kappa, raw agreement, test-retest consistency) cannot be expressed in SQL and require full-table app-side parsing; the embedded criterionName/maxScore/weight copies also drift from RubricCriterion rows.

> `criteriaScores String?       // JSON: Array<{ criterionId, criterionName, score, maxScore, weight, comment? }>`

**Fix direction:** Promote to a relational JudgmentCriterionScore table (judgmentId, criterionId, score, comment) with a parse-and-backfill migration; keep rawResponse as the only free-text blob.
**Verify note:** Confirmed: quote exact at line 212, HumanJudgment twin at line 229, and JSON.stringify(result.criteriaScores) verified at src/lib/evaluation-run-manager.ts:189.

### [MAJOR] No unique (runId, modelConfigId) on ModelJudgment — no idempotency key for queue workers
`prisma/schema.prisma:219`

CLEAN-EXTEND (with dedupe migration): ModelJudgment has only single-column indexes and no uniqueness over (runId, modelConfigId); rows are nested-created at run creation (evaluation-run-manager.ts:394). Under v2 RabbitMQ at-least-once delivery, worker retries that create rather than claim rows will duplicate judgments and double-count the leaderboard. The model also lacks updatedAt/startedAt/attempts, so a redelivered message cannot distinguish a stale in-flight row from a dead one.

> `@@index([runId])`

**Fix direction:** Add @@unique([runId, modelConfigId]) (widened with pairOrder/attempt if repeats become first-class), plus updatedAt, startedAt, attemptCount, and a lease/worker-id column as the queue-consumer claim protocol.
**Verify note:** Confirmed: line 219 has only @@index([runId])/@@index([modelConfigId]) with no @@unique (sibling RunModelSelection at line 196 has the composite unique, proving the omission is real); nested create verified at evaluation-run-manager.ts:393-397; model has createdAt only, no updatedAt.

### [MAJOR] HumanJudgment is 1:1 with run — conflicts with GoldenSet multi-annotator labels
`prisma/schema.prisma:225`

CONFLICT: runId @unique permits exactly one human judgment per run, but the contract's GoldenSet/GoldenLabel entities and CalibrationRun kappa computation require multiple independent human labels per item (inter-annotator agreement is the denominator of judge-vs-human kappa). If HumanJudgment is meant to seed golden labels, the 1:1 constraint must be lifted or GoldenLabel built as a separate table with HumanJudgment rows migrated in as first annotations.

> `runId               String        @unique`

**Fix direction:** Build GoldenSet/GoldenLabel as new tables keyed (goldenSetId, itemId, annotatorId); migrate existing HumanJudgment rows as seed labels; drop or scope the 1:1 constraint for the arena UI only.
**Verify note:** Confirmed: quote exact at line 225 and EvaluationRun.humanJudgment is a singular optional relation (line 177), enforcing exactly one human label per run schema-wide.

### [MAJOR] No calibration/trust surface — v1's only trust flag is connectivity verification
`prisma/schema.prisma:98`

CLEAN-EXTEND: GoldenSet, GoldenLabel, and CalibrationRun tables are entirely absent, and the contract's product rule ('a judge version with no passing CalibrationRun is untrusted; supersession never silent') needs a trust-state and supersededBy/supersededAt on JudgeModelVersion — v1's closest analog is isVerified, which only records that the endpoint answered a ping, not that the judge is calibrated.

> `isVerified           Boolean                    @default(false)`

**Fix direction:** Phase 1 schema must include CalibrationRun (judgeModelVersionId x goldenSetId, kappa, rawAgreement, testRetest, positionBias, BSR, passed) plus trustState + supersededById on JudgeModelVersion, even though Phase 3 populates them.
**Verify note:** Confirmed: quote exact at line 98; full schema read verifies no GoldenSet/GoldenLabel/CalibrationRun models exist, and isVerified/verifiedAt/verificationError (lines 98-100) are connectivity-check fields, per run-manager gating only on isVerified && isActive.

### [MAJOR] Leaderboard reads all judgments into JS with no composite index or denormalized project key
`src/app/api/leaderboard/route.ts:44`

The public leaderboard fetches every completed judgment through a double nested join (judgment->run->evaluation.projectId) and aggregates avg/median in JS; ModelJudgment has no composite index covering (modelConfigId, status), no createdAt index for freshness windows, and no denormalized projectId/judgeModelVersionId, so the v2 public-read leaderboard (per-judge-version aggregation is mandatory once versions exist) will table-scan and re-sort on every anonymous request.

> `const judgments = await prisma.modelJudgment.findMany({`

**Fix direction:** v2: composite index (judgeModelVersionId, status, createdAt) plus either DB-side groupBy or a materialized leaderboard aggregate refreshed by the worker tier; aggregate by judge version, not mutable config.
**Verify note:** Confirmed: quote exact at line 44; unbounded findMany with run.evaluation.projectId nested filter, JS avg/median at lines 100-119, endpoint explicitly unauthenticated (comment line 5), and schema.prisma lines 219-220 show only single-column runId/modelConfigId indexes with no status/createdAt coverage.

### [MINOR] Stringly-typed enums throughout — provider list already stale for v2 backends
`prisma/schema.prisma:93`

CLEAN-EXTEND: every enumeration (provider, role, statuses, visibility, source, inputType) is a bare String with a comment, so nothing stops invalid states at the DB layer; the contract requires real enums for judgeClass, scoringMechanism, trainingRecipe, reasoningMode, quantization, and servingBackend (anthropic/openai/openrouter/vllm/ollama), and ApiKeyStore.provider (line 242, @unique, commented 'anthropic' | 'openai') must extend to openrouter/vllm credentials.

> `provider             String                     // 'anthropic' | 'openai' | 'local'`

**Fix direction:** Adopt native Prisma/Postgres enums for all v2 contract enumerations and migrate existing string columns; keep servingBackend distinct from billing-provider.
**Verify note:** Confirmed: quote exact at line 93; verified zero `enum` blocks in the schema — role (17), statuses (172, 215), visibility (282), source (281), inputType (283), and ApiKeyStore.provider (242, @unique) are all comment-typed Strings.

### [MINOR] RubricCriterion rows mutable and cascade-deleted under versioned rubrics
`prisma/schema.prisma:79`

CONFLICT (mitigated): criteria of an already-judged rubric version can be edited in place (no version column, no immutability guard) and are Cascade-deleted with the rubric, leaving criterionId references inside historical criteriaScores JSON dangling; the JSON snapshot of name/maxScore/weight partially self-describes, which is why this is not MAJOR, but rubric-anchored calibration (supportsRubricAnchored) needs criteria to be as immutable as the rubric version they belong to.

> `rubric      Rubric @relation(fields: [rubricId], references: [id], onDelete: Cascade)`

**Fix direction:** Freeze criteria once a rubric version has any run (app + trigger/constraint); criterion edits force a new rubric version, matching the JudgeModelVersion immutability rule.
**Verify note:** Confirmed: quote exact at line 79; RubricCriterion (76-87) has no version/immutability fields, and criteriaScores JSON (line 212) references criterionId that dangles after cascade.

### [MINOR] Dataset JSON-string columns and localData duplication
`prisma/schema.prisma:298`

CLEAN-EXTEND: remoteMetadata (294), splits/features/tags (303-305), DatasetSample.metadata (334), DeveloperApiKey.scopes (257), and AuditLog.metadata (353) are JSON-in-text columns that should become Json (JSONB) for queryability (tags/visibility filtering on the v2 public dataset browser wants a GIN index); localData additionally duplicates DatasetSample rows as one inline JSON string, a drift risk that should be dropped in v2 with samples as the single source of truth.

> `localData  String?          // JSON string of inline sample data`

**Fix direction:** Convert JSON-text columns to Json/JSONB in the v2 migration; delete localData after verifying sample-row parity.
**Verify note:** Confirmed: quote exact at line 298 and all six cited companion lines (294, 303-305, 334, 257, 353) verified as String columns holding JSON per their own comments.

### [MINOR] Token accounting too coarse for v2 multi-backend cost tracking
`prisma/schema.prisma:214`

CLEAN-EXTEND: a single tokenCount Int cannot support v2 cost/efficiency reporting across OpenRouter (per-token billing, prompt vs completion priced differently) and local vLLM (throughput accounting), nor the contract's reasoningEnabled dimension where reasoning tokens dominate cost for reasoningMode=always judges.

> `tokenCount     Int?`

**Fix direction:** Split into promptTokens/completionTokens/reasoningTokens plus computed costMicroUsd on ModelJudgment.
**Verify note:** Confirmed: quote exact at line 214; tokenCount is the only token field on ModelJudgment and is written as one number in evaluation-run-manager.ts:191.

### [INFO] Rubric lineage is flat root-pointer, not a supersession chain
`prisma/schema.prisma:60`

v1's versioning idiom (parentId always points at the root rubric, per its own comment) records membership in a family but not orderied succession; the contract's parentVersionId lineage plus 'supersession never silent' for JudgeModel implies a chain (each version points at its predecessor) with explicit supersededBy/supersededAt — reusing the rubric idiom verbatim for JudgeModelVersion would lose the lineage the contract cites [F13, F14].

> `parentId       String?           // null for v1; root rubric id for later versions`

**Fix direction:** JudgeModelVersion.parentVersionId must point at the immediate predecessor version (chain), with supersededById set on the old version at promotion time.
**Verify note:** Confirmed: quote exact at line 60; the comment itself documents flat root-pointer semantics ('root rubric id for later versions') rather than predecessor chaining, and no supersededBy/At fields exist.

## provider-layer (14 findings: BLOCKER 1 · MAJOR 8 · MINOR 5)

The provider layer is a clean but minimal two-adapter design (Anthropic SDK + OpenAI-compatible SDK) whose extension points are all closed: provider identity is a hardcoded three-value enum duplicated across the registry, the type union, verify.ts, and the verify route; ProviderConfig carries only {apiKey, endpoint, modelId} with no seam for OpenRouter attribution headers, per-provider body params, sampling overrides, or a response JSON schema. Nearly all provenance the section-7 schema contract requires is discarded at the adapter boundary: temperature/max_tokens are hardcoded literals, prompt/completion tokens are irreversibly summed, and the served model id, finish/stop reason, and system fingerprint are dropped; prompt templates are unversioned inline literals so promptTemplateVersion has nothing to point at. verify.ts is a void connectivity ping that duplicates dispatch logic and captures no architecture fingerprint despite vLLM and OpenRouter exposing context length and served-model metadata for free. The resilience layer is the one true blocker: circuit state lives in a module-level Map with synchronous non-atomic transitions, which contradicts the mandated Redis-backed breaker for a multi-replica web tier plus queue workers, and its endpoint-granularity key would let one broken OpenRouter model open the circuit for every OpenRouter judgment. Structured output is prompt-begged free JSON with lenient zero-filling parse — the interface has no schema parameter, so per-provider constrained decoding (vLLM guided_json, OpenAI/OpenRouter json_schema, Anthropic forced tool_choice) needs a new request contract co-versioned with the prompt template.

### [BLOCKER] Circuit-breaker state is per-process in-memory with non-atomic transitions; cannot move to Redis as designed
`src/lib/llm/resilience.ts:99`

Breaker state lives in a module-level Map, so with >=2 web replicas plus AMQP judge workers each process gets an independent breaker (effective failure threshold multiplied by replica count, open/closed state inconsistent across pods), directly contradicting the v2 mandate that breaker state move to Redis; moreover the design assumes synchronous local mutation — the open->half-open transition (lines 136-147), the failures-array read-modify-write, and the sync getCircuitState() consumed by resilientCall (line 207) are check-then-act sequences that are not liftable to a remote store without redesigning to atomic operations, and even in-process the half-open gate lets N concurrent calls all probe simultaneously.

> `const circuits = new Map<string, CircuitBreakerState>();`

**Fix direction:** Spec a Redis breaker: atomic failure counting (INCR+EXPIRE or Lua rolling window), SET NX single-probe token for half-open, async getCircuitState; call-site signatures are already async so the seam survives.
**Verify note:** Quote exact at line 99; v2 spec line 113 mandates 'circuit-breaker state move to Redis'; half-open gate only checks state==='open' so concurrent callers all probe — every sub-claim verified.

### [MAJOR] Provider identity is a closed hardcoded enum duplicated in four places; no descriptor-based registry
`src/lib/llm/index.ts:21`

Adding OpenRouter and vLLM per section 7's servingBackend enum (anthropic/openai/openrouter/vllm/ollama) requires synchronized edits to the registry literal (index.ts:21-25), the ModelProvider union (src/types/index.ts:278), the VerifyModelInput union (verify.ts:5), and the cast in the verify route (src/app/api/models/[id]/verify/route.ts:38) — and today's 'local' key cannot distinguish vLLM from Ollama, which the schema contract requires; there is no single provider descriptor carrying id, adapter, default endpoint, header policy, or capability flags.

> `const providers: Record<string, JudgmentProvider> = {`

**Fix direction:** Define one provider-descriptor registry (id, display name, SDK adapter, canonical endpoint, header policy, capability flags: structuredOutput/reasoning/temperatureAllowed) from which the TS union, verify dispatch, and the Prisma servingBackend enum all derive.
**Verify note:** All four cited locations verified verbatim; servingBackend enum confirmed in docs/research/2026-07-judge-model-inventory.md section 7.

### [MAJOR] Server-wide OPENAI_API_KEY silently sent as Bearer to arbitrary user-configured endpoints
`src/lib/llm/openai-compatible.ts:41`

The key-fallback chain applies process.env.OPENAI_API_KEY before the endpoint-specific 'not-needed' placeholder, so a ModelConfig with a user-supplied endpoint (user-writable field) and no per-model key sends the operator's OpenAI credential to that arbitrary endpoint — a credential-exfiltration vector that worsens in v2 when OpenRouter and vLLM share this same adapter, and it also produces confusing 401s when an OpenRouter model lacks a key (the OpenAI env key is sent to openrouter.ai instead of failing fast).

> `process.env.OPENAI_API_KEY ||`

**Fix direction:** Scope env-key fallback per provider id and only to that provider's canonical endpoint (e.g. OPENROUTER_API_KEY for openrouter.ai, none for user-supplied URLs); fail fast with a clear config error otherwise.
**Verify note:** Fallback chain confirmed at lines 39-42 (and duplicated 94-97); endpoint is user-writable via z.string().url() in src/app/api/models/route.ts:14 with no allowlist.

### [MAJOR] Response metadata discarded at the adapter: token split summed, served model id and finish reason dropped
`src/lib/llm/anthropic.ts:60`

Both adapters collapse prompt/completion tokens into a single tokenCount (anthropic.ts:59-61, openai-compatible.ts:77-80), which is irreversible and blocks OpenRouter cost accounting (input/output priced differently per model), and both discard response.model (the actual served/routed model — OpenRouter returns the routed upstream, vLLM the served model name, i.e. the model-snapshot field section 7 requires), stop_reason/finish_reason (so a judgment truncated at the hardcoded max_tokens=4096 surfaces only as an undiagnosable JSON parse failure), and system_fingerprint; JudgmentResponse (provider.ts:19-26) structurally cannot carry any of this.

> `(response.usage?.input_tokens || 0) +`

**Fix direction:** Widen JudgmentResponse/RespondResponse to {promptTokens, completionTokens, servedModelId, finishReason, providerMeta} and persist them on ModelJudgment per the section-7 provenance contract.
**Verify note:** Summation confirmed in both adapters; JudgmentResponse interface (provider.ts:19-26) has only tokenCount?: number — no fields for served model, finish reason, or token split.

### [MAJOR] Sampling parameters are hardcoded literals — not per-model configurable, not recorded, and rejected by reasoning models
`src/lib/llm/anthropic.ts:49`

temperature (0.3 judge / 0.4 respond) and max_tokens (4096) are inline literals in both adapters (anthropic.ts:48-49, openai-compatible.ts:66-71), so section 7's required per-judgment sampling params have no source of truth to record, effective temperature cannot be attested per judgment, and whole model classes break once OpenRouter is added: OpenAI o-series/reasoning models reject non-default temperature and require max_completion_tokens instead of max_tokens, so hardcoded params yield 400s with no per-provider translation layer.

> `temperature: 0.3,`

**Fix direction:** Move sampling params into ProviderConfig with provider-descriptor capability gating (temperatureAllowed, maxTokensParamName), echo the effective values in JudgmentResponse, and persist them on ModelJudgment.
**Verify note:** Literals confirmed at anthropic.ts:48-49/89-90 and openai-compatible.ts:66/71/116/121; inventory doc section 7 requires sampling params on ModelJudgment.

### [MAJOR] Judge prompt templates are unversioned inline string literals
`src/lib/llm/provider.ts:83`

buildJudgmentSystemPrompt/buildJudgmentUserPrompt render from anonymous template literals with no template id, version, or hash, so section 7's required promptTemplateVersion on ModelJudgment has nothing to reference — any edit to the literal silently changes judge behavior for all subsequent runs and corrupts cross-time leaderboard comparability with zero provenance trail; the rendered prompt itself is also never persisted (only rawResponse is).

> `return `You are an expert evaluator acting as an impartial judge. Your task is to evaluate a submission according to a specific grading rubric.`

**Fix direction:** Extract prompts into a versioned template registry (id + semver + content hash), pass the resolved version through JudgmentRequest, return it in JudgmentResponse, and persist promptTemplateVersion plus rendered-prompt hash per judgment.
**Verify note:** Quote exact at line 83; promptTemplateVersion is an explicit required ModelJudgment field in inventory doc section 7; JudgmentResponse carries only rawResponse.

### [MAJOR] verifyModelConnection returns void — captures no architecture fingerprint despite it being freely available
`src/lib/llm/verify.ts:11`

Verification fires a 1-token completion and discards the entire response, and the verify route persists only booleans (isVerified/verifiedAt), yet the section-7 starred fields (weightsRevision/model snapshot, quantization, contextLength) are directly obtainable at verify time: response.model gives the served model id (vLLM reports the actual served name, often embedding AWQ/GPTQ/GGUF as a quantization hint), vLLM's GET /v1/models returns max_model_len, and OpenRouter's /models returns context_length, pricing, and supported_parameters per model.

> `export async function verifyModelConnection(input: VerifyModelInput): Promise<void> {`

**Fix direction:** Return a VerificationReport {servedModelId, contextLength?, quantizationHint?, supportedParameters?} and persist it as the fingerprint on the JudgeModel version row created at verify time.
**Verify note:** Promise<void> confirmed; verify route persists only isVerified/verifiedAt/verificationError; v2 program spec explicitly says 'model verification captures an architecture fingerprint'.

### [MAJOR] Circuit key granularity wrong for an aggregator: all OpenRouter models share one endpoint circuit
`src/lib/llm/index.ts:45`

The breaker key is provider:endpoint, which fixed the Ollama-vs-OpenAI collision but is wrong for OpenRouter where hundreds of models share https://openrouter.ai/api/v1 — one model's upstream outage, model-specific 429s, or a deprecated-model 404 burst opens the circuit for every OpenRouter judgment across the whole deployment, exactly the failure isolation the aggregator was added to avoid.

> `return config.endpoint ? `${providerName}:${config.endpoint}` : providerName;`

**Fix direction:** Make breaker-key policy a provider-descriptor property: aggregators key on (provider, endpoint, modelId); single-model backends (vLLM, Anthropic) keep endpoint or provider granularity.
**Verify note:** Quote exact at line 45; the endpoint-scoping was REVIEW_FINDINGS item 7's fix, and modelId is indeed absent from the key.

### [MAJOR] No structured-output seam: free-JSON prompting with lenient zero-fill parse, no schema in the provider interface
`src/lib/llm/provider.ts:101`

The output contract is begged in prose inside the system prompt and recovered by regex code-fence extraction plus fuzzy criterion matching that silently zero-fills unmatched criteria (provider.ts:224), while JudgmentProvider.judge (provider.ts:47) accepts no JSON schema — so swapping to schema-constrained decoding (vLLM guided_json/guided_choice, OpenAI/OpenRouter response_format json_schema with per-model structured_outputs support, Anthropic forced tool_choice) requires a new request contract carrying a schema derived from the rubric criteria plus a per-provider capability flag with prompt-based fallback, and the 'MUST respond with valid JSON' instruction block must be co-versioned with the decoding mode since it conflicts with constrained decoding.

> `You MUST respond with valid JSON in exactly this format:`

**Fix direction:** Add an outputSchema field to JudgmentRequest (built from rubric criteria with criterionId as enum), a structuredOutput capability flag per provider descriptor, per-provider translation to guided_json/json_schema/tool_choice, and record which decoding mode produced each judgment.
**Verify note:** Quote exact at line 101; zero-fill on unmatched criteria confirmed at line 224 (score: found ? ... : 0); judge() signature carries no schema.

### [MINOR] Transient-error classification by message substring will misclassify under new providers
`src/lib/llm/resilience.ts:255`

Retryability is decided by substring matching on error.message — '500'/'503' match any numeric run inside token counts, millisecond durations, or request ids embedded in provider messages, and OpenRouter's distinct error codes (402 payment-required, model-specific 404, moderation 403) need explicit non-retryable handling; both the Anthropic and OpenAI SDKs already expose typed APIError classes with a numeric .status that should be authoritative.

> `if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504')) {`

**Fix direction:** Classify on SDK APIError.status (and error.code) first, fall back to substrings only for raw network errors; add an explicit OpenRouter/vLLM status-code map.
**Verify note:** Quote exact at line 255; isTransientError operates purely on error.message with no status-code check anywhere in the function.

### [MINOR] verify.ts duplicates provider dispatch outside the registry and has already drifted
`src/lib/llm/verify.ts:12`

Verification re-implements provider selection as a hand-rolled if/else independent of the registry — 'openai' and 'local' are indistinguishable in this path, the placeholder key is 'dummy-key' here versus 'not-needed' in openai-compatible.ts:42 (drift already present), and every new provider (openrouter, vllm) must be wired in two places or verification silently exercises the wrong code path.

> `if (input.provider === 'anthropic') {`

**Fix direction:** Add verify() to the JudgmentProvider interface (or provider descriptor) and route the verify endpoint through getProvider() so dispatch, key fallback, and header policy are single-sourced.
**Verify note:** Quote exact at line 12; 'dummy-key' (verify.ts:32) vs 'not-needed' (openai-compatible.ts:42) drift confirmed; getProvider() is unused in verify.ts.

### [MINOR] Submission delimiter not escaped — embedded </submission> breaks containment
`src/lib/llm/provider.ts:142`

User-controlled promptText/responseText/inputText is interpolated raw between <submission> tags in all three buildJudgmentUserPrompt branches, so a submission containing a literal </submission> closes the container early and promotes the remainder of the attacker text to instruction position, partially undoing the prompt-injection hardening added as REVIEW_FINDINGS item 6 (which only added the ignore-instructions clause).

> `${promptText}`

**Fix direction:** Escape or strip the delimiter sequence from submission text, or use a per-call randomized boundary tag referenced by name in the system prompt.
**Verify note:** Raw interpolation confirmed in all three branches (lines 142/145/157/170); REVIEW_FINDINGS item 6 exists and the system-prompt hardening (lines 119-122) does not escape delimiters.

### [MINOR] Verification request params rejected by reasoning-model endpoints reachable via OpenRouter
`src/lib/llm/verify.ts:42`

The OpenAI-compatible verification call hardcodes max_tokens: 1 and temperature: 0, both of which are rejected with 400 by OpenAI o-series/reasoning models (which require max_completion_tokens and default temperature) — once OpenRouter is added, verifying a perfectly healthy reasoning-model config will fail and mark it isVerified=false.

> `max_tokens: 1,`

**Fix direction:** Drive verification params from the provider descriptor's capability flags (maxTokensParamName, temperatureAllowed), or prefer a GET /v1/models/{id} metadata probe over a completion where the backend supports it.
**Verify note:** Quote exact at line 42 with temperature: 0 at line 43; failure path in verify route persists isVerified=false with the provider error message.

### [MINOR] ProviderConfig has no seam for OpenRouter attribution headers or per-provider extra params
`src/lib/llm/provider.ts:39`

ProviderConfig is only {apiKey?, endpoint?, modelId} and the OpenAI client is constructed with just apiKey+baseURL (openai-compatible.ts:50-53), so there is no way to send OpenRouter's HTTP-Referer/X-Title attribution headers, its provider-routing/body preferences, or usage-accounting opt-in, nor to pass vLLM extra_body params — OpenRouter works degraded without them but the v2 spec needs a defaultHeaders/extraBody channel to add the aggregator properly.

> `export interface ProviderConfig {`

**Fix direction:** Extend ProviderConfig with headers, extraBody, and sampling-override fields populated from the provider descriptor plus per-ModelConfig settings.
**Verify note:** Confirmed but downgraded MAJOR->MINOR: attribution headers are degraded-mode-only by the finding's own admission, and the extra_body/guided-decoding gap is already covered by the MAJOR structured-output finding.

## queue-readiness (17 findings: BLOCKER 2 · INFO 1 · MAJOR 10 · MINOR 4)

The run engine is a single-process in-memory work queue (queue/activeIds/activeWorkers) whose consumer, processRun, is written assuming exactly-once, uninterrupted execution: it has no status guards, recomputes terminal state from in-memory counters, and re-executes every model judgment on re-entry, so at-least-once RabbitMQ delivery would duplicate provider spend and regress completed runs. The batch path is worse: 'evaluation'-type queue items are the only record of requested work (the run row is created inside the consumer), so a lost message silently loses work with no DB trace to reconcile. Error handling flattens everything to strings, discarding the transient/permanent distinction the resilience layer already computes, which blocks any principled ack/nack/DLQ design; circuit-breaker state is a per-process Map. The realtime layer has no run-progress topics at all (only 'dataset.summary.updated'), falls back to a process-local bus that would silently drop worker-emitted events, and broadcasts events to any authenticated subscriber without ownership checks. The good news: modelJudgment rows are pre-created at run creation with per-row status, which is exactly the substrate a per-judgment message granularity + DB CAS claim design needs.

### [BLOCKER] processRun is not idempotent: redelivery re-executes completed judgments and regresses terminal runs
`src/lib/evaluation-run-manager.ts:134`

processRun has no run-status guard and builds its work list from ALL modelJudgments regardless of status, then unconditionally sets each to 'running' (line 153) and the run to 'judging' (line 127). Under RabbitMQ at-least-once delivery, a duplicate or crash-redelivered message re-bills every LLM call, overwrites completed judgment rows, and flips a run that a human already marked 'completed' back to 'judging' then 'needs_human'.

> `run.modelJudgments.map((judgment) => [judgment.modelConfigId, judgment.id])`

**Fix direction:** Spec CAS-guarded transitions: run pending→judging via updateMany({where:{id,status:'pending'}}) with count check, per-judgment claim via updateMany({where:{id,status:'pending'}}), and a terminal-state early-return at the top of the consumer.
**Verify note:** Quote exact at line 134; only guard before the unconditional 'judging' write (127-130) is the rubric check at 119, judgments set 'running' at 153-159 with no status filter, and the final write at 249-252 is unconditional, so a human-'completed' run regresses to 'needs_human'.

### [BLOCKER] 'evaluation'-type queue items are the only record of requested work — message loss = silently missing runs
`src/lib/evaluation-run-manager.ts:277`

Batch endpoints enqueue {type:'evaluation'} items (evaluations/route.ts:434,516) and the EvaluationRun row is only created inside the consumer via createEvaluationRun. The client is told runsQueued:N (evaluations/route.ts:447) but no DB row exists until consumption, so a lost/dropped message is unrecoverable — no reconciler can ever find the missing work. createEvaluationRun also throws HttpError(400/404) inside the consumer, turning validation failures into poison messages with the user-facing error lost.

> `const run = await createEvaluationRun({
    evaluationId: item.evaluationId,
    triggeredById: item.triggeredById,`

**Fix direction:** Eliminate the 'evaluation' item type: producer creates all EvaluationRun rows (status 'pending') transactionally with the evaluations, validates before commit, and publishes messages carrying only runId; DB rows are the source of truth.
**Verify note:** Quote exact at 277-279; both batch paths in evaluations/route.ts call enqueueEvaluationRunCreation and report runsQueued, and createEvaluationRun throws HttpError(404) at 341/359 and HttpError(400) at 346/366 inside the consumer path.

### [MAJOR] In-memory queue trio is lost on restart with no recovery scan; activeIds dedup has no distributed replacement
`src/lib/evaluation-run-manager.ts:67`

queue, activeIds, and activeWorkers (lines 67-69) all evaporate on deploy/crash, stranding runs in 'pending' forever — there is no startup or periodic reclaim today. Post-split, RabbitMQ replaces the queue and prefetch replaces activeWorkers, but the dedup role of activeIds (enqueueRunProcessing line 307) has no RabbitMQ equivalent, and publish-after-commit can still fail, so the spec needs both a DB-status-based dedup (CAS claim) and a reconciler that re-publishes stale 'pending' runs (which also covers lost messages).

> `const queue: QueueItem[] = [];
const activeIds = new Set<string>();
let activeWorkers = 0;`

**Fix direction:** Spec: DB row state machine is authoritative; dedup via status CAS not queue-level tracking; periodic reconciler sweeps pending/judging runs older than a threshold and re-publishes or fails them.
**Verify note:** Quote exact at 67-69; activeIds dedup check at line 307 confirmed and no startup/periodic reclaim exists anywhere in the module.

### [MAJOR] Final run status computed from in-memory counters, not DB aggregate
`src/lib/evaluation-run-manager.ts:245`

completedCount/errorCount live only in the processRun closure; after a worker crash and resume (or with per-judgment message granularity) the counters restart from zero and the terminal status is wrong. Fan-in must be derived from the modelJudgment rows themselves.

> `completedCount === 0 && errorCount > 0
        ? 'error'
        : 'needs_human';`

**Fix direction:** On each judgment reaching terminal state, run a transaction that counts remaining non-terminal judgments for the run and CAS-finalizes the run status from the DB aggregate when the count hits zero.
**Verify note:** Quote exact at 245-247; counters are closure-local (declared 137-138) and the final status write at 249-252 never consults judgment rows.

### [MAJOR] completed→needs_human regression race between worker finalization and human-judgment route
`src/app/api/evaluations/[id]/runs/[runId]/human-judgment/route.ts:124`

The human-judgment route does check-then-set on a run fetched earlier in the request (line 45), and the worker's finalization (evaluation-run-manager.ts:249-252) is an unconditional update. With the worker in a separate process the window widens: worker sets 'needs_human' after the human set 'completed', or the route's stale read resurrects an old status. Run-status transitions are not transactional anywhere.

> `if (run.status !== 'completed') {`

**Fix direction:** Define the run state machine with allowed-from sets and implement every transition as updateMany({where:{id,status:{in:allowedFrom}}}) inside the same transaction as the payload write (humanJudgment upsert).
**Verify note:** Quote exact at line 124; run fetched at line 45, upsert at 104 and status update at 125-128 are separate non-transactional statements, and the worker-side write at evaluation-run-manager.ts:249-252 is unconditional.

### [MAJOR] Error taxonomy flattened to strings — no basis for ack vs nack-with-delay vs DLQ routing
`src/lib/evaluation-run-manager.ts:230`

The per-judgment catch stores only error.message and marks the judgment 'error', discarding the transient/permanent classification that resilience.ts isTransientError (line 228) already computes. A CircuitOpenError from a 60-second provider blip permanently fails every queued judgment for that provider with zero real attempts, and a malformed rubric is indistinguishable from a network timeout. RabbitMQ retry/DLQ semantics cannot be built on string matching.

> `const errorMessage = error instanceof Error ? error.message : 'Unknown error';`

**Fix direction:** Provider layer v2 must throw typed errors (Transient, CircuitOpen, PermanentValidation, PermanentProvider); consumer maps transient/circuit-open → nack to a TTL+DLX delay queue with attempt cap, permanent → DLQ with structured reason persisted on the judgment row.
**Verify note:** Quote exact at 230; executeJudgment/executeRespond route through resilientCall (llm/index.ts:58,71) so CircuitOpenError (resilience.ts:141) genuinely reaches this catch and is persisted as an opaque string; isTransientError at resilience.ts:228 confirmed.

### [MAJOR] Circuit-breaker state is a per-process Map — target architecture requires it in Redis
`src/lib/llm/resilience.ts:99`

With N worker replicas each holds an independent circuit: failure thresholds take N× longer to trip, an open circuit on one worker doesn't protect the others, and half-open 'single probe' semantics (line 208) become N concurrent probes hammering a recovering provider. The v2 target explicitly makes Redis mandatory for circuit-breaker state.

> `const circuits = new Map<string, CircuitBreakerState>();`

**Fix direction:** Move circuit state (state, failure timestamps, lastOpenedAt) to Redis keyed by the existing endpoint-scoped circuitKey, with a Redis lock/token so exactly one worker performs the half-open probe.
**Verify note:** Quote exact at line 99; half-open single-probe logic at 207-209 confirmed, and the v2 program design doc (lines 99, 111-112) explicitly flags per-replica circuit state and makes Redis the mandatory default.

### [MAJOR] No run-progress realtime events exist — topic space is a single dataset-summary event
`src/lib/realtime/events.ts:12`

The entire event map is one event on one topic ('dataset.summary.updated' → 'datasets'; RealtimeTopic union in realtime/types.ts:1 has one member). Run status and per-judgment progress are only observable by polling, and single-text (non-dataset) runs emit nothing at all because refreshDatasetEvaluationSummaryForEvaluation early-returns without a datasetId (dataset-evaluation-summary.ts:117). The worker split makes a run-scoped topic taxonomy (run.status.changed, judgment.started/completed/failed) a hard requirement, not a nicety.

> `'dataset.summary.updated': 'datasets',`

**Fix direction:** Spec a topic taxonomy: per-run and per-evaluation topics with judgment-level and run-transition events published by workers; SSE route subscribes by topic pattern; keep dataset summary as a derived/debounced event.
**Verify note:** Quote exact at line 12; RealtimeTopic = 'datasets' is a single-member union (types.ts:1) and the datasetId early-return at dataset-evaluation-summary.ts:117 confirms non-dataset runs emit no events.

### [MAJOR] Realtime bus silently degrades to process-local emit — worker-published events would vanish
`src/lib/realtime/redis-bus.ts:59`

On Redis publish failure the bus falls back to emitting into the local in-memory bus, and the factory defaults to the memory bus entirely when REDIS_URL is unset (factory.ts:25-27). In the split architecture SSE subscribers live only on web-tier processes, so a worker falling back to local emit drops every progress event silently — the fallback is only correct in the current single-process world.

> `console.error('Redis publish failed. Falling back to local emit:', error);`

**Fix direction:** For worker processes Redis must be fail-hard (crash or surface unhealthy, no memory fallback); restrict the in-memory adapter to explicit dev mode, per the 'Redis mandatory' target.
**Verify note:** Quote exact at line 59; additional silent fallbacks exist at lines 51-54 (no publisher client) and 76-78 (redis module missing marks permanent fallback), and factory.ts defaults to memory when REDIS_URL is unset.

### [MAJOR] SSE endpoint broadcasts all events to any authenticated subscriber — no ownership scoping in topic design
`src/app/api/events/route.ts:50`

The subscriber filter is only topic equality plus optional datasetId equality — any user with 'evaluations:read' scope can subscribe and receive summary payloads for private datasets they don't own. When run-progress topics are added for the worker split, per-run events would leak other users' activity unless the topic design carries ownership/ACL, contradicting the 'user-created data fully gated' access model.

> `if (topic && event.topic !== topic) return;`

**Fix direction:** Envelope must carry ownerId/visibility; SSE route resolves the subscriber's permitted resource set at connect time (and on event) and filters server-side — topic names alone must never be capability tokens.
**Verify note:** Quote exact at line 50; the only filters are topic and datasetId equality (lines 50-58) with no ownership check, while datasets are per-user resources gated by 403 checks in REST routes.

### [MAJOR] Consumer live-reads mutable ModelConfig at execution time — violates judge-version pinning under queue lag
`src/lib/evaluation-run-manager.ts:111`

processRun re-fetches runModelSelections with the live modelConfig row, so provider/modelId/endpoint/apiKey edits between enqueue and consume silently change what executes versus what was requested. RunModelSelection snapshots only the FK, not the config. The schema contract (judge-model-inventory §7) requires an immutable judgeModelVersionId pin per judgment; queue lag makes the current live-read materially wrong, and provenance on the judgment row cannot be reconstructed.

> `include: { modelConfig: true },`

**Fix direction:** Pin judgeModelVersionId (immutable versioned row per §7) on modelJudgment at run creation; the worker resolves execution parameters from the pinned version, never the mutable ModelConfig head.
**Verify note:** Quote exact at line 111; execution reads model.provider/modelId/apiKey/endpoint live (lines 164-177, 198-208), and docs/research/2026-07-judge-model-inventory.md §7 (line 192) does specify judgeModelVersionId as an immutable pin.

### [MAJOR] Dataset summary refresh: unsynchronized read-modify-write of remoteMetadata JSON plus full recompute per run completion
`src/lib/dataset-evaluation-summary.ts:96`

Every run completion triggers a full-dataset recompute (evaluation-run-manager.ts:264) ending in a non-transactional parse-merge-write of dataset.remoteMetadata. A 500-sample batch fanned out across concurrent workers produces a stampede of full-dataset scans and racing JSON merges where a concurrent writer's metadata keys can be clobbered (read at line 91, write at 93-101).

> `remoteMetadata: JSON.stringify({`

**Fix direction:** Move the summary out of the remoteMetadata JSON blob into dedicated columns, and make refresh a debounced single-flight per dataset (Redis lock/marker or a dedicated coalescing queue) instead of per-run-completion.
**Verify note:** Quote exact at line 96; read at 91 and write at 93-101 are separate statements with no transaction or lock, and evaluation-run-manager.ts:264 calls the refresh unconditionally after every run.

### [MINOR] Whole-run message granularity creates long unacked processing windows and coarse redelivery blast radius
`src/lib/evaluation-run-manager.ts:140`

One queue item processes up to 10 models in chunks of MODEL_CONCURRENCY_PER_RUN=2, each call bounded by 120s (line 9) but wrapped in resilientCall's 3 attempts with up-to-30s backoff (resilience.ts:23-28) — worst case ~35+ minutes of unacked processing, past RabbitMQ's default 30-minute consumer_timeout, which closes the channel and redelivers the message while the first worker is still running it.

> `const modelChunks = chunkArray(run.runModelSelections, Math.max(1, MODEL_CONCURRENCY_PER_RUN));`

**Fix direction:** Make the message unit one (runId, modelConfigId) judgment — the pre-created modelJudgment rows (lines 393-398) are the natural claim records — with DB fan-in for run completion; bound total per-message wall time below the broker ack timeout.
**Verify note:** Downgraded MAJOR→MINOR: quote exact at 140 and the 10-model cap is real, but the ~35-min math misreads withTimeout — Promise.race (line 89) caps each call's observed wall time at 120s regardless of resilientCall's internal retries, so worst case is ~ceil(10/2)×120s ≈ 10 min, under the default 30-min consumer_timeout; the coarse-granularity/long-unacked-window concern still stands for lower configured timeouts and redelivery blast radius.

### [MINOR] Rubric-missing path leaves judgments 'pending' forever and is an unclassified poison case
`src/lib/evaluation-run-manager.ts:119`

When a judge-mode run's rubric is gone at consume time (possible via Rubric onDelete: SetNull, schema.prisma:171 — a race whose window grows with queue lag), the run is set to 'error' but its pre-created modelJudgment rows stay 'pending' indefinitely, an inconsistent terminal state; this is also the canonical 'malformed input' poison class that should route to DLQ with a persisted reason rather than a bare status flip.

> `if (isJudgeMode && !run.rubric) {`

**Fix direction:** On permanent validation failure, transactionally fail the run AND all non-terminal judgments with a structured reason, and ack (DLQ) rather than requeue.
**Verify note:** Quote exact at line 119; the early-return at 120-125 updates only the run status, and schema.prisma:171 confirms EvaluationRun.rubric is onDelete: SetNull.

### [MINOR] withTimeout races but never aborts the underlying provider call
`src/lib/evaluation-run-manager.ts:89`

Promise.race abandons the operation without cancellation, so a timed-out LLM request keeps running and billing in the background; combined with message redelivery after a consumer timeout, the same judgment can be executing two or three times concurrently against the provider.

> `const result = await Promise.race([operation(), timeoutPromise]);`

**Fix direction:** Provider layer v2 should thread an AbortSignal end-to-end (both SDK and fetch paths) so timeout and consumer shutdown actually cancel in-flight provider requests.
**Verify note:** Quote exact at line 89; no AbortSignal is threaded anywhere in withTimeout or the executeJudgment call chain, and resilientCall's background retries continue after the race rejects.

### [MINOR] getQueueStats is process-local and becomes meaningless with replicas
`src/lib/evaluation-run-manager.ts:322`

pending/activeWorkers/concurrency reflect one process's memory; with a stateless web tier and N workers this reports zeros or per-pod fragments. Queue observability must be redefined for the split.

> `export function getQueueStats() {`

**Fix direction:** Spec observability as RabbitMQ queue depth/consumer counts (management API or metrics exporter) plus DB counts grouped by run status; delete the in-process stats function.
**Verify note:** Quote exact at line 322; the function reads only module-level queue.length and activeWorkers.

### [INFO] Worker path decrypts provider API keys — message contract must exclude credential material
`src/lib/evaluation-run-manager.ts:176`

Judgment execution decrypts model.apiKey inline, meaning post-split workers require both DB access and the ENCRYPTION_KEY. This is fine, but it constrains the design: queue messages must carry only IDs (never keys or decrypted config), and worker deployment inherits the crypto-secret distribution requirement — relevant for the vLLM/GPU-host network seam where the worker, not the web tier, holds provider credentials.

> `apiKey: model.apiKey ? decryptSafe(model.apiKey) : undefined,`

**Fix direction:** Spec the message schema as IDs-only (runId or runId+modelConfigVersionId); workers fetch and decrypt credentials at execution time; document ENCRYPTION_KEY as a worker-tier secret.
**Verify note:** Quote exact at line 176 (repeated at 207 for respond mode); decryptSafe is imported from @/lib/crypto and runs in the consumer path.

## deps-build (22 findings: BLOCKER 4 · INFO 2 · MAJOR 9 · MINOR 7)

The deploy surface is single-instance by construction: container_name, a fixed host-port publish, and a migrate-on-boot CMD each independently break `--scale app=N`, and the repo has no prisma/migrations directory at all (schema state is db-push-managed), which is incompatible with the Schema v2 versioned-migration contract. Version currency carries two hard security items — Next 14.2.35 is EOL (Oct 2025, final patch Dec 2025) with unpatched 2026 CVEs including an 8.6 SSRF, and node:20-alpine passed EOL on 2026-04-30 — plus a stale @anthropic-ai/sdk (0.39 vs 0.114) that predates the provider-layer v2 needs. The runner image ships the full dev node_modules tree over the Next standalone output, and no worker entrypoint, AMQP client, or rabbitmq/worker compose service exists anywhere, so the shared web/worker image is a green-field spec item. CI is built on GitHub JS actions and gha build cache that cannot carry to the raw-shell Gitea runner, never exercises `migrate deploy`, and its test env lacks the Redis/RabbitMQ services that v2 makes mandatory; the coverage gate explicitly excludes exactly the subsystems (llm/, realtime/, evaluation-run-manager) Phase 1 rewrites into workers.

### [BLOCKER] container_name on app service blocks --scale app=N
`docker-compose.yml:24`

docker compose refuses to scale a service with a fixed container_name (duplicate-name error), so the stateless >=2-replica web tier cannot be exercised in compose at all.

> `container_name: judge-arena-app`

**Fix direction:** Drop container_name from the app (and future worker) services; rely on compose-generated names.
**Verify note:** Quote exact at line 24; compose does error on --scale when container_name is set, so the claim is technically accurate.

### [BLOCKER] Static host-port publish on app prevents a second replica
`docker-compose.yml:27`

Publishing host port ${APP_PORT:-3000} directly on the app service means the second scaled replica fails with 'port is already allocated'; deploy/nginx.conf is a host-level config with a single hardcoded upstream (127.0.0.1:3000), not a compose service, so there is no LB path for N replicas.

> `- "${APP_PORT:-3000}:3000"`

**Fix direction:** Move port publishing to a proxy service (nginx/traefik) inside the compose network that load-balances across app replicas via service-name DNS; app exposes 3000 internally only.
**Verify note:** Quote exact at line 27; verified deploy/nginx.conf upstream block is exactly one server 127.0.0.1:3000 (lines 22-25) and nginx is not a compose service.

### [BLOCKER] Migrations run in container CMD on every start — N-replica race and role coupling
`Dockerfile:70`

Every app replica runs `prisma migrate deploy` at boot, so N replicas starting concurrently race on migrations (Prisma's advisory lock serializes but replicas can fail/crash-loop on lock contention or partial failure), and the hardcoded `node server.js` tail means the image cannot serve as a shared web/worker image with a parameterized command.

> `CMD ["sh", "-c", "node node_modules/prisma/build/index.js migrate deploy --schema=prisma/schema.prisma 2>&1 && node server.js"]`

**Fix direction:** Extract migration into a dedicated one-shot migrate service/Job (compose depends_on: service_completed_successfully; k8s Job or initContainer on a single runner); make CMD/entrypoint parameterizable so the same image runs web (server.js) or worker (worker entrypoint).
**Verify note:** Quote exact at line 70; migrate-on-boot plus fixed server.js tail confirmed, and no alternate entrypoint exists in the image.

### [BLOCKER] No prisma/migrations directory — migrate deploy is a no-op and Schema v2 has no baseline
`docker-compose.yml:14`

prisma/ contains only schema.prisma and seed.ts (no migrations/), so the documented first-run bootstrap and the Dockerfile CMD both invoke migrate deploy with zero migrations to apply — the schema is never actually created by this path, and real state is managed by `db push` (CI, Railway); Schema v2's judge-model classes/versioning rollout across live replicas requires a baselined, versioned migration history.

> `#   docker compose exec app npx prisma migrate deploy`

**Fix direction:** Phase 1 spec must include creating a baseline migration from the current schema (prisma migrate diff --from-empty), switching all environments from db push to migrate deploy, and defining the v2 schema changes as ordered migrations.
**Verify note:** Verified ls of prisma/: only schema.prisma and seed.ts exist; CI uses db push (ci.yml:86); nuance — Railway (railway.toml builder=DOCKERFILE) runs the CMD's no-op migrate deploy rather than db push, which makes the schema-never-created defect worse, not better.

### [MAJOR] Next.js 14.2.35 is EOL with unpatched 2026 CVEs
`package.json:38`

Next 14 reached EOL 2025-10-26 with a final backport (14.2.35) in Dec 2025; 2026 CVEs affecting 14.2 (CVE-2026-44578 SSRF via WebSocket upgrade CVSS 8.6, CVE-2026-44573 middleware bypass, CVE-2026-27980 image-optimizer DoS, CVE-2026-29057 request smuggling) will not receive 14.x fixes — untenable for a public-reads deployment; note eslint-config-next and next-auth peer ranges move with it.

> `"next": "^14.2.23",`

**Fix direction:** Spec the Next 15 (minimum) upgrade as a Phase 1 prerequisite — App Router pulls React 19, next-auth v4.24.11+ declares Next 15 peer support, and serverExternalPackages config already matches the 15.x shape.
**Verify note:** Quote exact at line 38; EOL date matches Vercel's 2-year policy (14.0 released 2023-10-26) and next.config.js:5 confirms the serverExternalPackages 15.x-shape claim; the specific 2026 CVE IDs are unverifiable offline but do not change the EOL-major-on-public-deployment core.

### [MAJOR] node:20-alpine base image and CI Node 20 are past EOL (2026-04-30)
`Dockerfile:2`

Node.js 20 exited maintenance on 2026-04-30, so the runtime base image (all three stages) and CI's NODE_VERSION '20' (ci.yml:17) no longer receive security patches.

> `FROM node:20-alpine AS deps`

**Fix direction:** Move Dockerfile stages and CI to node:22-alpine / Node 22 LTS (supported to 2027) as part of Phase 1.
**Verify note:** Quote exact at line 2; all three stages (lines 2, 18, 35) use node:20-alpine and ci.yml:17 sets NODE_VERSION '20'; Node 20 EOL 2026-04-30 matches the published release schedule.

### [MAJOR] No worker entrypoint, AMQP client, or rabbitmq/worker service exists anywhere
`package.json:10`

The repo defines exactly one runtime entrypoint (the Next standalone server); there is no amqplib (or equivalent) in dependencies, no worker source file, and docker-compose's service inventory is app/postgres/redis only — and a worker is not part of the Next standalone bundle, so the shared image needs a separate bundling path (esbuild/tsc) for the worker entry, since tsx is devDependency-only.

> `"start": "node .next/standalone/server.js",`

**Fix direction:** Spec: add amqplib dependency, a worker entrypoint bundled outside the Next build, a rabbitmq compose/k8s service (management image, rabbitmq-diagnostics -q ping healthcheck, durable volume), and a worker service reusing the app image with a different command plus a non-HTTP liveness check (worker has no HTTP server for the wget healthcheck).
**Verify note:** Quote exact at line 10; grep across src/ and scripts/ finds zero amqp/rabbitmq references (only in-process activeWorkers counters in evaluation-run-manager.ts), no amqplib in dependencies, tsx is devDependency-only (line 61), and compose defines only app/postgres/redis.

### [MAJOR] Runner image ships full dev node_modules over the standalone output
`Dockerfile:59`

The deps stage runs a full `npm ci` (dev included: typescript, vitest, eslint, tailwind, tsx) and that entire tree is copied into the production runner on top of the pruned .next/standalone tree — defeating standalone output's size benefit, inflating the CVE/scan surface, and making the documented seed flow (`npx tsx prisma/seed.ts`) silently depend on devDependencies being present in prod.

> `COPY --from=deps /app/node_modules ./node_modules`

**Fix direction:** Add an `npm ci --omit=dev` prune stage (or copy only @prisma/client + engines) for the runner; move migration/seed tooling to the dedicated migrate job image instead of the web/worker runtime.
**Verify note:** Quote exact at line 59; deps stage runs `npm ci --ignore-scripts` with no --omit=dev (line 14) and the copy lands after the standalone output (line 55); compose line 15 documents the tsx seed flow inside the app container.

### [MAJOR] Redis allkeys-lru eviction will silently drop rate-limit and circuit-breaker state
`docker-compose.yml:75`

v2 makes Redis mandatory for rate limiting, circuit-breaker state, and the SSE bus, but the compose config caps it at 128mb with allkeys-lru — under memory pressure Redis evicts arbitrary keys, resetting rate limits and closing open breakers with no error surfaced.

> `command: redis-server --save 60 1 --loglevel warning --maxmemory 128mb --maxmemory-policy allkeys-lru`

**Fix direction:** Spec noeviction (or volatile-ttl with mandatory TTLs on all correctness-bearing keys) plus an alert on evicted_keys/used_memory; size maxmemory for the SSE bus fanout.
**Verify note:** Quote exact at line 75; compose header (line 6) confirms Redis is used for rate limiting and realtime events, and app env sets REALTIME_ADAPTER=redis (line 33), so eviction of correctness-bearing keys is a real failure mode.

### [MAJOR] CI pipeline is built on GitHub JS actions the Gitea runner cannot execute
`.github/workflows/ci.yml:25`

Every job depends on JS actions (actions/checkout@v4, setup-node@v4, upload-artifact@v4, docker/setup-buildx@v3, build-push-action@v5) but the homelab Gitea runner executes raw shell only — the entire workflow must be re-expressed as shell steps (token clone with homelab-bot read access, node from the runner image, mktemp-based artifact handling, plain docker build/push to Harbor) for the Gitea Actions migration.

> `- uses: actions/checkout@v4`

**Fix direction:** Phase 1 spec: define the Gitea workflow as raw-shell equivalents of quality/test/build/docker jobs, using user-level CI secrets and the existing runner conventions (30m zombie-task timeout, $HOME/.local/bin).
**Verify note:** Quote exact at line 25; verified all four jobs use JS actions (checkout, setup-node, upload-artifact, buildx, login-action, build-push-action), which matches the documented Gitea-runner no-JS-actions constraint.

### [MAJOR] CI validates schema with db push and never exercises migrate deploy
`.github/workflows/ci.yml:86`

The test job applies the schema via `prisma db push --skip-generate` while production applies `migrate deploy`, so CI can go green while the migration history is broken or drifted from schema.prisma — fatal once Schema v2 introduces real migrations.

> `run: npx prisma db push --skip-generate`

**Fix direction:** Once migrations exist, CI must run `prisma migrate deploy` against a clean Postgres plus a drift check (`prisma migrate diff` between applied migrations and schema.prisma), replacing db push.
**Verify note:** Quote exact at line 86; production path is migrate deploy via Dockerfile CMD (line 70), so the CI/prod divergence is real.

### [MAJOR] CI test environment has no Redis or RabbitMQ service
`.github/workflows/ci.yml:66`

The test job provisions only Postgres and its env sets only DATABASE_URL/auth secrets; with Redis mandatory (SSE bus, rate limiting, breaker state) and RabbitMQ added, integration tests for the queue/worker/realtime paths cannot run in CI — meaning the core v2 subsystems ship untested.

> `DATABASE_URL: postgresql://test:test@localhost:5432/judgearena_test`

**Fix direction:** Spec redis and rabbitmq service containers (or shell-managed docker run on Gitea) plus REDIS_URL/AMQP_URL in the test env, with health-wait steps before vitest.
**Verify note:** Quote exact at line 66; services block (lines 50-63) contains only postgres and the test env (lines 65-69) has no REDIS_URL or AMQP_URL.

### [MAJOR] @anthropic-ai/sdk pinned at 0.39.0, ~75 minor versions behind
`package.json:32`

Current @anthropic-ai/sdk is 0.114.x (July 2026); 0.39.0 (early 2025) predates newer model IDs, streaming/tool-use helpers, and request-option changes the provider layer v2 (OpenRouter + vLLM seam) will build against, and pre-1.0 minor bumps are breaking so the jump should be scheduled deliberately, not absorbed mid-feature.

> `"@anthropic-ai/sdk": "^0.39.0",`

**Fix direction:** Bump to current @anthropic-ai/sdk at the start of provider-layer v2 and re-run provider integration tests against the real API surface.
**Verify note:** Quote exact at line 32; exact current version (0.114.x) unverifiable offline, but ^0.39.0 dates to early 2025 and the pre-1.0 breaking-minor risk for a provider-layer rework is accurate.

### [MINOR] next-auth v4 vs Auth.js v5 must be an explicit Phase 1 decision
`package.json:39`

next-auth 4.24.13 is in minimal-maintenance mode while Auth.js v5 remains beta (5.0.0-beta.x); the Authentik OIDC + credentials-fallback design works on v4 (custom OAuth provider, CredentialsProvider), and v4.24.11+ supports Next 15 peers — but v5 changes config shape, cookie/session handling, and middleware integration, so deferring the choice until mid-implementation would churn the auth layer twice.

> `"next-auth": "^4.24.13",`

**Fix direction:** Spec recommendation: stay on next-auth v4 for the Authentik OIDC work (lower disruption, Next 15 compatible), record Auth.js v5 migration as a post-Phase-1 item gated on v5 GA.
**Verify note:** Quote exact at line 39; downgraded MAJOR to MINOR — this is a decision-record item, not a defect (nothing is broken and the finding itself recommends staying on v4), unlike the genuine EOL/security MAJORs.

### [MINOR] openai SDK v4 is two majors behind (v6 current)
`package.json:41`

openai 4.104.0 still works for the OpenRouter aggregator and vLLM (both are baseURL-compatible chat-completions), but openai-node is at v6 with breaking changes accumulating, so the longer v4 persists the larger the eventual migration in the provider layer.

> `"openai": "^4.82.0",`

**Fix direction:** Fold the openai v4→v6 bump into the provider-layer v2 rework where the call sites are already being touched.
**Verify note:** Quote exact at line 41; openai-node v5 shipped mid-2025 so being at least one-plus majors behind is certain even if 'v6 current' is unverifiable offline.

### [MINOR] node-redis v4 is two majors behind current
`package.json:44`

redis@4.7.0 works but node-redis is at v6; since v2 promotes Redis from optional to mandatory (SSE bus, rate limiting, breaker state), Phase 1 is the natural point to take the v4→v5/v6 API changes (client API, RESP3, typed commands) once rather than retrofitting later.

> `"redis": "^4.7.0",`

**Fix direction:** Bump node-redis alongside the mandatory-Redis refactor; verify pub/sub duplicate-connection and reconnect semantics for the SSE bus under the new major.
**Verify note:** Quote exact at line 44; node-redis v5 GA'd in 2025 so at least one major behind is certain; timing argument (bump during the mandatory-Redis refactor) is sound.

### [MINOR] Prisma generate runs three times per image build
`Dockerfile:31`

prisma generate runs in the deps stage (line 15), again in the builder stage (line 31), and a third time inside `npm run build` (package.json build script: 'npx prisma generate && next build') — redundant work that slows builds and blurs which generated client actually ships.

> `RUN npx prisma generate`

**Fix direction:** Generate once in the deps stage (after npm ci --ignore-scripts) and strip the duplicate invocations from the builder stage and the build script for the containerized path.
**Verify note:** Quote exact at line 31; verified all three invocations — Dockerfile lines 15 and 31, plus package.json:9 build script.

### [MINOR] Postgres and unauthenticated Redis published to the host in production compose
`docker-compose.yml:79`

The production compose publishes Redis 6379 (no requirepass) and Postgres 5432 to the host, and the app's DATABASE_URL falls back to a 'changeme' password (line 31) — unnecessary attack surface that conflicts with the minimize-exposure posture and will not translate to the k8s default-deny model.

> `- "${REDIS_PORT:-6379}:6379"`

**Fix direction:** Remove host port publishing for postgres/redis (compose-network-internal only), add requirepass to Redis, and drop the changeme default so a missing POSTGRES_PASSWORD fails loudly.
**Verify note:** Quote exact at line 79; postgres publish at line 61, changeme fallback at lines 31 and 56, and the redis-server command has no requirepass — all confirmed.

### [MINOR] Coverage gate excludes exactly the subsystems Phase 1 rewrites
`vitest.config.ts:29`

The coverage thresholds (60/70/50/60) only measure src/lib/** minus an exclude list containing src/lib/llm/**, src/lib/realtime/**, and evaluation-run-manager.ts — precisely the code becoming the queue-backed worker, provider layer v2, and Redis SSE bus — so the CI coverage gate will assert nothing about the new architecture's core unless re-scoped.

> `'src/lib/llm/**',`

**Fix direction:** Phase 1 spec: worker/queue/provider/realtime modules enter coverage include with their own thresholds, using the CI redis/rabbitmq services for integration-level tests.
**Verify note:** Quote exact at line 29; realtime/** at line 30, evaluation-run-manager.ts at line 24, and thresholds 60/70/50/60 at lines 32-37 all confirmed.

### [MINOR] eslint 8 has been EOL since October 2024
`package.json:56`

eslint 8.57.1 is end-of-life (no fixes), and eslint-config-next is version-locked to the Next major — the Next 15 upgrade forces eslint-config-next 15, which supports eslint 9 flat config; the repo already has eslint.config.mjs so the jump is mostly mechanical.

> `"eslint": "^8.57.0",`

**Fix direction:** Bundle eslint 9 + eslint-config-next@15 into the Next upgrade commit rather than as a separate effort.
**Verify note:** Quote exact at line 56; eslint-config-next ^14.2.23 at line 57 and eslint.config.mjs present in repo root both confirmed; eslint 8 EOL 2024-10-05 is correct.

### [INFO] Prisma 6 vs 7 should be decided at the Schema v2 baseline moment
`package.json:33`

Prisma 7 went GA Nov 2025 (Rust-free client, new generator layout, prisma.config.ts) and 6.19.2 is late-6.x; since Phase 1 already creates the first real migration baseline and touches the generated-client packaging in Docker, that is the cheapest point to either commit to 7 or explicitly pin 6.x with a revisit date — mid-Phase upgrade would re-touch the same Dockerfile/CI layers twice.

> `"@prisma/client": "^6.19.2",`

**Fix direction:** Record an explicit spec decision: stay on Prisma 6.x for Phase 1 (lower risk) with Prisma 7 as a follow-up, or take 7 now while the Docker/CI prisma layering is already being rebuilt.
**Verify note:** Quote exact at line 33; prisma ^6.19.2 also in devDependencies (line 59); INFO framing appropriate for a decision-record item.

### [INFO] GitHub-specific build cache and :latest tagging won't carry to Gitea/Harbor
`.github/workflows/ci.yml:150`

The docker job uses type=gha buildx cache (GitHub-hosted, nonexistent on Gitea) and pushes a mutable :latest tag alongside the sha tag — on the k8s target, deploying by mutable tag risks the known same-tag rebuild kubelet-cache staleness, so the Gitea pipeline should use registry-backed cache and immutable sha tags as the deploy reference.

> `cache-from: type=gha`

**Fix direction:** Gitea spec: buildx registry cache (type=registry on Harbor) or plain layer cache, push sha-<commit> as the only deploy tag, keep :latest at most as a human convenience never referenced by manifests.
**Verify note:** Quote exact at line 150; :latest and ${{ github.sha }} tags at lines 148-149 and cache-to type=gha at line 151 confirmed.

## export-import (22 findings: BLOCKER 1 · INFO 3 · MAJOR 10 · MINOR 8)

The importer is FEASIBLE for a single-owner migration, but only with (a) a pre-cutover export patch on Railway and (b) an explicit synthesis table in the Phase 1 spec. The evaluations export identifies every foreign entity by non-unique display name (dataset_name, rubric_name+version, model name/provider/modelId, triggered_by name-or-email) while the config import keys everything by slug, and it emits a 1-based sample index against a 0-based store — so hierarchy reconstruction (evaluation→run→judgment, judgment→rubric-criterion, judgment→judge-version) currently rests on fragile name joins with no stable dedup key (ModelJudgment.id is not exported and the schema permits duplicate (runId, modelConfigId)). Fields section 7 requires that v1 never captured — sampling params, prompt template version, judge version pin, reasoningMode, pairOrder — are cleanly synthesizable (constants are hardcoded in provider code; v1 is pointwise-only), provided every backfilled JudgeModel version is marked untrusted per the section 7 no-passing-CalibrationRun rule. The genuinely blocking gap is ownership: no export artifact carries owner identity and config import collapses all entities onto the importing user, which is incompatible with v2's ownership-gated access model for any multi-user cutover — either the export patch adds owner emails and import becomes per-user, or evaluation DATA migrates via DB dump and the export/import path is scoped to config replication only. Recommended split: export patch adds ids/slugs/owner-email/judgment_id/run_mode/error/pin-flag columns (cheap, additive); importer synthesizes sampling params, template version 'v1-legacy', judge versions per distinct (provider, modelId, endpoint), protocol=pointwise.

### [BLOCKER] Evaluations export carries no owner identity; v2 ownership-gated access model cannot be satisfied
`src/lib/export.ts:87`

EvaluationExportRow has no field for Evaluation.userId or owner email; the only user-ish column is triggered_by (run trigger, display string, empty for zero-run evaluations). v2 gates all private artifacts on ownership, so imported evaluations/runs/judgments cannot be assigned owners for any multi-user dataset, and Auth v2 (Authentik OIDC) account linking needs stable emails, not name-or-email strings.

> `export interface EvaluationExportRow {`

**Fix direction:** Pre-cutover export patch adds owner_user_id + owner_email columns (and triggered_by_email); alternatively scope export/import to config only and migrate evaluation data via DB dump.
**Verify note:** Verified: interface at lines 87-117 has no owner columns; triggered_by is name||email (line 168) and hardcoded '' for zero-run rows (line 270).

### [MAJOR] Config import assigns every entity to the importing user, collapsing multi-user ownership
`src/app/api/config/import/route.ts:57`

Admin config export spans all users (where = admin ? undefined : {userId}) but the config document has no per-entity owner field, and import unconditionally writes userId = session.user.id — a Railway-to-k8s cutover via admin export+import merges every user's projects/rubrics/models/datasets into one account, breaking v2 ownership checks.

> `const userId = session.user.id;`

**Fix direction:** Phase 1 spec: config document v2 gains per-entity ownerEmail; importer resolves/creates users or runs per-user; admin cross-user import explicitly rejected otherwise.
**Verify note:** Verified both halves: config/export/route.ts uses `admin ? undefined : { userId }` for all four sections; every create/update in import writes the importer's userId; ConfigProject/Rubric/Model/Dataset carry no owner field.

### [MAJOR] Judge identity is a live join to mutable ModelConfig — judgeModelVersionId cannot be reconstructed
`src/app/api/evaluations/export/route.ts:29`

Export emits modelConfig name/provider/modelId as they exist at export time, not at judgment time; ModelConfig is mutable (name, modelId, endpoint editable) and judgments store no snapshot, so section 7's immutable judgeModelVersionId pin is unrecoverable for history — any config edited between judgment and export silently misattributes all its past judgments. endpoint (needed to infer servingBackend/endpointClass for provider 'local') is absent from data rows entirely.

> `select: { id: true, name: true, provider: true, modelId: true },`

**Fix direction:** Importer synthesizes one JudgeModel version per distinct observed (provider, modelId, endpoint) tuple, provenance=backfilled and untrusted per section 7 product rule; export patch adds model_config_id, model_slug, model_endpoint columns.
**Verify note:** Verified: ModelJudgment (schema lines 203-221) stores only modelConfigId FK with no identity snapshot; config import route mutates name/provider/modelId/endpoint in place; endpoint not selected or exported.

### [MAJOR] promptTemplateVersion has no v1 source — prompt is built inline and never stored
`src/lib/llm/provider.ts:68`

The judgment system prompt is generated by buildJudgmentSystemPrompt from rubric fields with no version stamp, and the actual prompt sent is not persisted on ModelJudgment (only rawResponse is), so section 7's promptTemplateVersion cannot be derived from data — only from code archaeology.

> `* Build the system prompt for LLM-as-a-Judge evaluation`

**Fix direction:** Define a frozen 'v1-legacy' PromptTemplate version pinned to the v1 repo git SHA of provider.ts; importer stamps all migrated judgments with it.
**Verify note:** Verified: prompt interpolates mutable rubric name/description/criterion descriptions (lines 70-119); run manager persists only scores/reasoning/rawResponse/criteriaScores — sent prompt is unrecoverable once rubric criteria are edited (config import deleteMany+recreate mutates them in place).

### [MAJOR] Rubric coalescing erases pin-vs-fallback provenance and rubric identity is name-only
`src/lib/export.ts:165`

The export coalesces run.rubric ?? evaluation.rubric into one rubric_name/rubric_version pair, so v2's per-judgment rubricVersionId cannot distinguish a run-pinned rubric from a null run rubric falling back to the evaluation default; additionally rubric identity is (name, version) with no id or slug, while config import keys rubrics by slug and names are not unique per user.

> `const runRubric = run.rubric ?? evaluation.rubric;`

**Fix direction:** Export patch adds rubric_id, rubric_slug, and run_rubric_pinned boolean; importer maps to rubricVersionId via slug.
**Verify note:** Verified: only rubric_name/rubric_version emitted (lines 195-196) despite rubric id being selected in the include; Rubric uniqueness is @@unique([userId, slug]) with name unconstrained.

### [MAJOR] criteriaScores JSON embeds criterion cuids that dangle after config import recreates criteria
`src/app/api/config/import/route.ts:146`

model_criteria_scores/human_criteria_scores contain Array<{criterionId, criterionName, ...}> with v1 RubricCriterion cuids, but config import deletes and recreates criteria with fresh cuids (and criterion ids appear nowhere in the config document), so per-criterion score attribution must fall back to criterionName matching within the resolved rubric.

> `await prisma.rubricCriterion.deleteMany({ where: { rubricId: existing.id } });`

**Fix direction:** Spec the importer to resolve criteria by (rubricSlug, criterionName) with collision detection; config export patch adds stable criterion slugs.
**Verify note:** Verified: criteriaScores JSON shape includes criterionId (schema.prisma comments at lines 212/229); ConfigCriterion carries name/description/maxScore/weight/order only — no id.

### [MAJOR] human_selected_best_model is a raw ModelConfig cuid with no resolution path in any export artifact
`src/lib/export.ts:207`

The column exports selectedBestModelId (a ModelConfig primary key) while model identity everywhere else is name/provider/modelId and the config export contains no entity ids — so the human preference signal (the closest thing v1 has to section 7 selection-protocol data) cannot be joined to a judge model from the export bundle alone.

> `human_selected_best_model: human?.selectedBestModelId ?? '',`

**Fix direction:** Export patch resolves the FK and emits selected model name/provider/modelId (plus model_config_id for exact join).
**Verify note:** Verified: raw FK emitted at line 207; ConfigModel (config.ts:75-82) has slug/name/provider/modelId only — no database id anywhere in the bundle to join against.

### [MAJOR] Human labeler identity is lost — HumanJudgment.userId is not exported
`src/lib/export.ts:168`

HumanJudgment.userId (who labeled) can differ from run.triggeredById (who ran models), yet only triggered_by is exported, and as a display string (name || email) that drops the email whenever name is set — section 7's GoldenLabel entities need stable labeler identity to seed golden sets from migrated human judgments.

> `run.triggeredBy?.name || run.triggeredBy?.email || '';`

**Fix direction:** Export patch adds human_judge_email (and human_judgment_created_at); importer maps to v2 user ids for GoldenLabel provenance.
**Verify note:** Verified: HumanJudgment.userId is a distinct field (schema line 232) and is loaded via humanJudgment:true in the export route, but the flatten type and rows never emit it.

### [MAJOR] dataset_sample_index is 1-based while every other surface is 0-based
`src/lib/export.ts:190`

The evaluations export emits index+1 while the dataset export (flattenDatasetSample, export.ts:78), the config export samples, and the DB unique key (datasetId, index) are all 0-based — joining evaluation rows to imported samples without subtracting 1 silently shifts every evaluation onto the wrong sample.

> `? String(evaluation.datasetSample.index + 1)`

**Fix direction:** Spec pins index base = 0 across all v2 artifacts; the v1 importer must document and apply the -1 correction for the evaluations file only.
**Verify note:** Verified: +1 at lines 190 and 257; flattenDatasetSample emits raw index (line 78); config samples use s.index unmodified; DB has @@unique([datasetId, index]).

### [MAJOR] No stable dedup key for judgment rows: judgment id and timestamp are not exported and schema allows duplicates
`prisma/schema.prisma:219`

ModelJudgment has only indexes — no @@unique([runId, modelConfigId]) — and the export omits ModelJudgment.id and createdAt, so the only dedup key is (run_id, model_name, model_provider, model_id); ModelConfig names are not unique per user, so two configs with the same name+provider+modelId selected on one run produce indistinguishable rows and re-imports cannot be idempotent.

> `@@index([runId])`

**Fix direction:** Export patch adds model_judgment_id and judgment_created_at columns; v2 importer uses judgment id as the natural key for idempotent re-import.
**Verify note:** Verified: ModelJudgment (lines 203-221) has only @@index entries (RunModelSelection has the unique, ModelJudgment does not); EvaluationExportRow omits judgment id/createdAt; ModelConfig name has no uniqueness constraint.

### [MAJOR] Dataset and project references in the data export are display names, but the config import keys by slug
`src/lib/export.ts:187`

Evaluation rows reference datasets by name only (no id, no slug) and projects by v1 cuid + name, while the config document carries neither entity ids nor a name-uniqueness guarantee — slug collisions get a -${id.slice(0,6)} suffix at config-export time (config export route line 71) that is not reproducible from the data export, so cross-file linking of evaluations to imported datasets/projects is a heuristic name join.

> `dataset_name: evaluation.dataset?.name ?? '',`

**Fix direction:** Export patch adds dataset_id/dataset_slug/project_slug columns to data rows and entity ids to the config document, making the (config, data) pair a self-consistent bundle.
**Verify note:** Verified: dataset id is selected in the include but never emitted; suffix logic confirmed at config/export/route.ts line 71 (and mirrored for rubrics/models/datasets); config doc has no ids.

### [MINOR] Sampling params are hardcoded in provider code, never persisted per judgment
`src/lib/llm/anthropic.ts:49`

Section 7 requires sampling params on ModelJudgment; v1 hardcodes temperature 0.3 / max_tokens 4096 for judge calls (0.4 for respond calls, same constants in openai-compatible.ts:66-71) and stores nothing, so no export patch can recover them — but they are constants, so backfill is exact if keyed to the deployed code version.

> `temperature: 0.3,`

**Fix direction:** Spec a synthesis rule: migrated judge-mode judgments get {temperature:0.3, maxTokens:4096}, respond-mode {temperature:0.4, maxTokens:4096}, flagged samplingParamsSource=backfilled-constant.
**Verify note:** Facts verified (0.3/4096 judge at anthropic.ts:48-49, 0.4 respond at line 90; openai-compatible.ts judge 66/71 and respond 116/121 match). Downgraded MAJOR→MINOR: values are compile-time constants so backfill is exact and lossless, as the claim itself concedes — a synthesis-rule spec item, not unrecoverable data loss.

### [MINOR] Judge-mode vs respond-mode rows are indistinguishable in the export
`src/lib/evaluation-run-manager.ts:117`

Run mode is derived at execution time from evaluation.responseText being non-empty; respond-mode runs store the generated answer in ModelJudgment.reasoning with null scores, so exported model_reasoning is semantically either a judge critique or a model response, with mode only inferable from response_text non-emptiness — which breaks if the evaluation template was edited after runs executed.

> `const isJudgeMode = Boolean(run.evaluation.responseText?.trim());`

**Fix direction:** Export patch adds run_mode column (judge|respond); v2 importer routes respond-mode rows to a response/completion entity, not ModelJudgment.
**Verify note:** Core confirmed: respond mode writes result.responseText into reasoning with null scores (lines 214-225) and no run_mode is exported. Downgraded MAJOR→MINOR: the escalating edit scenario is not realizable — the only evaluation mutation path (PATCH /api/evaluations/[id]) accepts solely rubricId/modelConfigIds, so responseText is immutable post-create and mode inference from response_text is deterministic; this is a documented-inference-rule item.

### [MINOR] ModelJudgment.error is dropped from the export
`prisma/schema.prisma:216`

Rows with model_judgment_status='error' export with empty score/reasoning columns and no error message even though the DB stores one — v2 judgment provenance (and any circuit-breaker/error-taxonomy analysis on migrated data) loses the failure cause.

> `error          String?`

**Fix direction:** Export patch adds model_error column; importer maps to v2 judgment failure metadata.
**Verify note:** Verified: error is written on failure (evaluation-run-manager.ts lines 231-237) but EvaluationExportRow has no error column.

### [MINOR] JSONL export stringifies all numerics and double-encodes nested JSON
`src/lib/export.ts:234`

Every field including scores, latency, and token counts is pre-coerced to string (and criteriaScores stays a JSON-in-a-string), with '' conflating null and empty — the v2 importer must define per-column parsers and a ''-means-null rule rather than trusting JSONL types.

> `judgment.overallScore != null ? String(judgment.overallScore) : '',`

**Fix direction:** Spec the importer's column-type table (parse-float, parse-int, parse-embedded-JSON, empty-string-as-null); v2's own export should emit native JSON types.
**Verify note:** Verified: EvaluationExportRow declares every field as string and toJsonl serializes rows as-is, so JSONL inherits the stringified values.

### [MINOR] Config export drops Rubric.parentId and Dataset version lineage required by section 7
`src/lib/config.ts:232`

dbRubricToConfig emits slug/name/version/criteria but not parentId (schema.prisma:60), and ConfigDataset omits Dataset.version/parentId — each version imports as an unrelated slug (-v2 suffix), so section 7's parentVersionId lineage chains cannot be rebuilt from the config document.

> `export function dbRubricToConfig(rubric: any): ConfigRubric {`

**Fix direction:** Config export patch adds parentSlug on rubrics and datasets; v2 importer links version chains via slug references.
**Verify note:** Verified: Rubric.parentId at schema line 60, Dataset.version/parentId at lines 286-288; neither ConfigRubric nor ConfigDataset carries lineage; -v{version} slug suffix at config/export/route.ts line 110.

### [MINOR] Config export omits Dataset.inputType (and format/splits/features/remoteMetadata)
`src/lib/config.ts:93`

ConfigDataset has no inputType field, so on import every dataset re-defaults to 'query-response' (schema.prisma:283) — 'query'-type datasets are misclassified, which changes the judge-vs-respond behavior of evaluations later created from them.

> `export interface ConfigDataset {`

**Fix direction:** Add inputType (and optionally format/splits/features) to ConfigDataset and the import writes.
**Verify note:** Verified: import creates datasets without inputType so the schema default applies; batch evaluation creation branches responseText on dataset.inputType, which drives isJudgeMode.

### [MINOR] Import skips sample replacement when content changed but count is identical
`src/app/api/config/import/route.ts:261`

The update-path change detection compares only sample counts, and samples are replaced only inside the changes.length>0 branch — a config with the same number of samples but different input/expected content diffs as 'skip' and the drifted samples are never written.

> `if (configDataset.samples && configDataset.samples.length > 0 && existing._count.samples !== configDataset.samples.length) {`

**Fix direction:** v2 importer compares a content hash of samples (and replaces samples even when only sample content differs).
**Verify note:** Verified: when no scalar field differs and counts match, changes stays empty, action='skip', and the deleteMany/createMany at lines 286-295 is never reached.

### [MINOR] Config model provider enum excludes v2 providers
`src/lib/config.ts:145`

The zod schema pins provider to ['anthropic','openai','local'], while Provider layer v2 adds openrouter and vllm — the v2 importer must accept a superset and define the mapping of legacy 'local' rows to servingBackend (vllm vs ollama) via endpoint inspection, since v1 has no servingBackend field.

> `provider: z.enum(['anthropic', 'openai', 'local']),`

**Fix direction:** Spec the provider mapping table: anthropic/openai pass through, 'local' maps to servingBackend by endpoint URL heuristic with manual confirmation.
**Verify note:** Verified in-repo half: enum at line 145 and ModelConfig has no servingBackend field; the v2 provider list is a spec-side premise taken as given for this dimension.

### [INFO] token_count is input+output combined; v2 cannot split it
`src/lib/llm/anthropic.ts:60`

tokenCount sums input and output tokens before storage, so migrated judgments can never report prompt/completion token split — v2 schema should model tokenCount as nullable split fields plus a combined legacy field rather than pretending precision exists.

> `(response.usage?.input_tokens || 0) +`

**Fix direction:** v2 ModelJudgment stores inputTokens/outputTokens nullable + legacyCombinedTokens for migrated rows.
**Verify note:** Verified; line corrected 59→60. Same summing in respond (lines 99-101) and in openai-compatible.ts with prompt/completion tokens.

### [INFO] pairOrder and reasoningMode have no v1 source — v1 is pointwise-only
`src/lib/export.ts:116`

v1's only comparative signal is the unordered human best-model selection; there are no pairwise AB/BA presentations and no reasoning-mode toggle anywhere in the run pipeline, so section 7's pairOrder [F12] and reasoningEnabled [F15] must be synthesized (protocol=pointwise, pairOrder=null, reasoningEnabled per judge class) and the importer must not fabricate pairwise records from best-model selections.

> `human_selected_best_model: string;`

**Fix direction:** Synthesis table entry: all migrated judgments get protocol=pointwise+rubric-anchored, pairOrder=N/A; best-model selections map to a selection-protocol human label, not a pairwise judgment.
**Verify note:** Verified: run pipeline is judge/respond only (evaluation-run-manager.ts); no pairwise or reasoning-toggle constructs exist in schema or providers.

### [INFO] Config export GET mutates the database and dedupes slugs across users
`src/app/api/config/export/route.ts:71`

Export writes generated slugs back to the DB during a GET (non-idempotent read; a pre-cutover 'read-only' export changes Railway data), and for admin exports the in-request slugs array dedupes across ALL users even though uniqueness is per-(userId, slug) — user B's project can get a -suffix slug because user A claimed the name first, changing B's stable identifier at export time.

> `const uniqueSlug = slugs.includes(slug) ? `${slug}-${project.id.slice(0, 6)}` : slug;`

**Fix direction:** Freeze slugs via a one-time backfill migration before the cutover export; v2 export must be strictly read-only and slug-dedupe per owner.
**Verify note:** Verified: prisma.project.update inside the GET (lines 72-75), mirrored for rubrics/models/datasets; admin where=undefined feeds one shared slugs array despite @@unique([userId, slug]).
