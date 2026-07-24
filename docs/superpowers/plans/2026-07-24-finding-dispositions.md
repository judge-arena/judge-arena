# Finding Dispositions — BLOCKER + MAJOR (1:1)

Generated from the verified critique (workflow `wf_ad08c6a6-24c`). One row per
BLOCKER/MAJOR finding; disposition names the 1a task or 1b spec section that
resolves it ("Obsoleted by P1.5" = the pg_dump importer decision removes the
failure mode). MINOR/INFO items are triaged in the implementation plans.

| # | Dimension | Sev | Finding | Location | Disposition |
|---|---|---|---|---|---|
| 1 | replica-safety | BLOCKER | In-process evaluation run queue — work pinned to one replica, lost on restart, dedup broken across replicas | `src/lib/evaluation-run-manager.ts:67` | 1b — spec §4/§5 (queue/Redis externalization) |
| 2 | replica-safety | BLOCKER | SSE realtime bus defaults to replica-local in-memory delivery | `src/lib/realtime/in-memory-bus.ts:8` | 1b — spec §4/§5 (queue/Redis externalization) |
| 3 | replica-safety | MAJOR | In-memory sliding-window rate limiter multiplies limits by replica count | `src/lib/rate-limit.ts:41` | 1b — spec §4/§5 (queue/Redis externalization) |
| 4 | replica-safety | MAJOR | Circuit-breaker state is a per-process Map — breakers trip and probe independently per replica | `src/lib/llm/resilience.ts:99` | 1b — spec §4/§5 (queue/Redis externalization) |
| 5 | replica-safety | MAJOR | Pod death mid-run leaves EvaluationRun permanently 'judging' — no reconciler or redelivery | `src/lib/evaluation-run-manager.ts:129` | 1b — spec §4/§5 (queue/Redis externalization) |
| 6 | replica-safety | MAJOR | Second, independent in-memory rate limiter in Edge middleware | `src/middleware.ts:17` | 1b — spec §4/§5 (queue/Redis externalization) |
| 7 | replica-safety | MAJOR | Redis bus silently and permanently degrades to replica-local delivery on any init/publish failure | `src/lib/realtime/redis-bus.ts:77` | 1b — spec §4/§5 (queue/Redis externalization) |
| 8 | replica-safety | MAJOR | Lost-update race: evaluation summary merged into dataset.remoteMetadata via unlocked read-modify-write | `src/lib/dataset-evaluation-summary.ts:91` | 1b — spec §4/§5 (queue/Redis externalization) |
| 9 | replica-safety | MAJOR | Prisma connection pool unbounded per replica — N replicas + workers can exhaust a single Postgres | `src/lib/db.ts:9` | 1b — spec §4 (explicit connection_limit vs CNPG pooler budget) |
| 10 | correctness | BLOCKER | In-memory run queue: restarts strand pending runs; no atomic claim allows double-processing across replicas | `src/lib/evaluation-run-manager.ts:67` | 1b — spec §4–§6 |
| 11 | correctness | MAJOR | processRun final status blindly overwrites; races human judgment completed -> needs_human | `src/lib/evaluation-run-manager.ts:251` | 1b — spec §4 (guarded transitions, FOR UPDATE finalization) |
| 12 | correctness | MAJOR | create_and_run dataset batches return 201 'runsQueued' but run creation failures are swallowed in the queue | `src/app/api/evaluations/route.ts:516` | 1b — spec §5 (expansion failures mark runs error) |
| 13 | correctness | MAJOR | Judgment score normalization accepts non-numeric values (NaN) and never recomputes overall from criteria weights | `src/lib/llm/provider.ts:232` | 1b — spec §6 (structured-output parse path) |
| 14 | correctness | MAJOR | Circuit breaker counts non-transient failures on a provider-wide shared key: one bad credential blocks all users | `src/lib/llm/resilience.ts:161` | 1b — spec §6 (typed error taxonomy) |
| 15 | correctness | MAJOR | Rubric version numbering is read-then-create with no transaction and no uniqueness constraint | `src/app/api/rubrics/[id]/versions/route.ts:88` | 1a Task 13 |
| 16 | correctness | MAJOR | Dataset evaluation summary uses non-transactional read-modify-write of remoteMetadata JSON | `src/lib/dataset-evaluation-summary.ts:96` | 1b — spec §4 (transactional recompute on finalization) |
| 17 | correctness | MAJOR | Dataset refresh clobbers stored evaluationSummary and overwrites local sampleCount with HF corpus total | `src/app/api/datasets/[id]/refresh/route.ts:51` | 1a Task 12 |
| 18 | correctness | MAJOR | Missing human overallScore is coerced to 0 and pollutes human-score averages | `src/app/api/evaluations/[id]/runs/[runId]/human-judgment/route.ts:101` | 1a Task 11 |
| 19 | correctness | MAJOR | Dataset version POST silently ignores an invalid samples payload and duplicates old samples | `src/app/api/datasets/[id]/versions/route.ts:77` | 1a Task 15 |
| 20 | correctness | MAJOR | query-response samples with empty 'expected' silently flip to respond mode inside a judge batch | `src/app/api/evaluations/route.ts:500` | 1b — spec §5 (run.create expansion validates sample mode) |
| 21 | correctness | MAJOR | Public leaderboard aggregates every judgment from all historical runs, double-counting re-runs | `src/app/api/leaderboard/route.ts:44` | 1a Task 14 |
| 22 | security-access-model | BLOCKER | All rate limiting is per-process in-memory; breaks at >=2 web replicas | `src/middleware.ts:17` | 1b — spec §4 (Redis Lua sliding window) |
| 23 | security-access-model | MAJOR | Public reads unimplemented: requireAuth precedes visibility check on all dataset/rubric reads | `src/app/api/datasets/[id]/route.ts:21` | 1b — spec §7 access matrix (schema fields land 1a Task 2) |
| 24 | security-access-model | MAJOR | Scoped developer API keys can mint new full-scope keys (privilege escalation) | `src/app/api/api-keys/route.ts:60` | 1b — spec §7 (key mgmt requires session) |
| 25 | security-access-model | MAJOR | SSE /api/events broadcasts every user's realtime events to any authenticated subscriber | `src/app/api/events/route.ts:49` | 1b — spec §4 (ownership-scoped topics) |
| 26 | security-access-model | MAJOR | Model verify sends stored ciphertext as the provider API key (missing decryptSafe) | `src/app/api/models/[id]/verify/route.ts:41` | 1b — spec §6 (key resolution rewrite) |
| 27 | security-access-model | MAJOR | Registration limiter keys on unconditionally-trusted X-Forwarded-For (spoofable bypass) | `src/app/api/auth/register/route.ts:17` | 1b — spec §7 (route removed) + §4 (Redis limiter) |
| 28 | security-access-model | MAJOR | judgeLimiter/apiLimiter/authLimiter are dead code; LLM and HuggingFace routes have no dedicated limits | `src/lib/rate-limit.ts:114` | 1b — spec §4 (one Redis limiter, expensive routes covered) |
| 29 | security-access-model | MAJOR | Rubric has no visibility field — 'published rubrics' cannot exist in the schema | `prisma/schema.prisma:54` | 1a Task 2 |
| 30 | security-access-model | MAJOR | Dataset responses embed owner email — becomes anonymous-facing PII leak under v2 public reads | `src/app/api/datasets/route.ts:76` | 1b — spec §7 (PII-stripped public serializers) |
| 31 | schema-fit | BLOCKER | ModelConfig is mutable-in-place; contract requires immutable versioned JudgeModel | `prisma/schema.prisma:94` | 1a Task 3 (new identity tables) + 1b (ModelConfig retirement) |
| 32 | schema-fit | BLOCKER | ModelJudgment cascades on ModelConfig deletion — judgments do not survive judge deletion | `prisma/schema.prisma:208` | 1a Task 4 (Restrict + judgeModelVersionId Restrict) |
| 33 | schema-fit | MAJOR | User-deletion cascade chain wipes all runs and judgments (triggeredBy, Project->Evaluation->Run) | `prisma/schema.prisma:174` | 1a Task 6 (P1.7 split service) + Task 4 (triggeredById SetNull) |
| 34 | schema-fit | MAJOR | Rubric pin on EvaluationRun is SetNull — rubric deletion silently severs judgment provenance | `prisma/schema.prisma:171` | 1a Task 4 (Restrict) + Task 2 (retiredAt soft-delete) |
| 35 | schema-fit | MAJOR | ModelJudgment lacks all §7 per-judgment provenance fields | `prisma/schema.prisma:209` | 1a Task 4 |
| 36 | schema-fit | MAJOR | Pointwise-only Evaluation shape cannot represent pairwise/listwise protocols | `prisma/schema.prisma:126` | 1a Task 4 (protocol + RunCandidate) |
| 37 | schema-fit | MAJOR | criteriaScores stored as JSON text (String, not JSONB) blocks calibration SQL | `prisma/schema.prisma:212` | 1a Task 4 (JSONB with USING cast) |
| 38 | schema-fit | MAJOR | No unique (runId, modelConfigId) on ModelJudgment — no idempotency key for queue workers | `prisma/schema.prisma:219` | 1a Task 4 (unique(runId, judgeModelVersionId, pairOrder)) |
| 39 | schema-fit | MAJOR | HumanJudgment is 1:1 with run — conflicts with GoldenSet multi-annotator labels | `prisma/schema.prisma:225` | 1a Task 5 (GoldenLabel multi-annotator) |
| 40 | schema-fit | MAJOR | No calibration/trust surface — v1's only trust flag is connectivity verification | `prisma/schema.prisma:98` | 1a Task 3 (trustState) + Task 5 (CalibrationRun) |
| 41 | schema-fit | MAJOR | Leaderboard reads all judgments into JS with no composite index or denormalized project key | `src/app/api/leaderboard/route.ts:44` | 1a Task 14 (latest-run aggregation + indexes) |
| 42 | provider-layer | BLOCKER | Circuit-breaker state is per-process in-memory with non-atomic transitions; cannot move to Redis as designed | `src/lib/llm/resilience.ts:99` | 1b — spec §6 (descriptor registry, structured output, metadata capture) |
| 43 | provider-layer | MAJOR | Provider identity is a closed hardcoded enum duplicated in four places; no descriptor-based registry | `src/lib/llm/index.ts:21` | 1b — spec §6 (descriptor registry, structured output, metadata capture) |
| 44 | provider-layer | MAJOR | Server-wide OPENAI_API_KEY silently sent as Bearer to arbitrary user-configured endpoints | `src/lib/llm/openai-compatible.ts:41` | 1b — spec §6 (descriptor registry, structured output, metadata capture) |
| 45 | provider-layer | MAJOR | Response metadata discarded at the adapter: token split summed, served model id and finish reason dropped | `src/lib/llm/anthropic.ts:60` | 1b — spec §6 (descriptor registry, structured output, metadata capture) |
| 46 | provider-layer | MAJOR | Sampling parameters are hardcoded literals — not per-model configurable, not recorded, and rejected by reasoning models | `src/lib/llm/anthropic.ts:49` | 1b — spec §6 (descriptor registry, structured output, metadata capture) |
| 47 | provider-layer | MAJOR | Judge prompt templates are unversioned inline string literals | `src/lib/llm/provider.ts:83` | 1b — spec §6 (descriptor registry, structured output, metadata capture) |
| 48 | provider-layer | MAJOR | verifyModelConnection returns void — captures no architecture fingerprint despite it being freely available | `src/lib/llm/verify.ts:11` | 1b — spec §6 (descriptor registry, structured output, metadata capture) |
| 49 | provider-layer | MAJOR | Circuit key granularity wrong for an aggregator: all OpenRouter models share one endpoint circuit | `src/lib/llm/index.ts:45` | 1b — spec §6 (descriptor registry, structured output, metadata capture) |
| 50 | provider-layer | MAJOR | No structured-output seam: free-JSON prompting with lenient zero-fill parse, no schema in the provider interface | `src/lib/llm/provider.ts:101` | 1b — spec §6 (descriptor registry, structured output, metadata capture) |
| 51 | queue-readiness | BLOCKER | processRun is not idempotent: redelivery re-executes completed judgments and regresses terminal runs | `src/lib/evaluation-run-manager.ts:134` | 1b — spec §4/§5 (per-judgment messages, leases, FOR UPDATE finalization, reaper) |
| 52 | queue-readiness | BLOCKER | 'evaluation'-type queue items are the only record of requested work — message loss = silently missing runs | `src/lib/evaluation-run-manager.ts:277` | 1b — spec §4/§5 (per-judgment messages, leases, FOR UPDATE finalization, reaper) |
| 53 | queue-readiness | MAJOR | In-memory queue trio is lost on restart with no recovery scan; activeIds dedup has no distributed replacement | `src/lib/evaluation-run-manager.ts:67` | 1b — spec §4/§5 (per-judgment messages, leases, FOR UPDATE finalization, reaper) |
| 54 | queue-readiness | MAJOR | Final run status computed from in-memory counters, not DB aggregate | `src/lib/evaluation-run-manager.ts:245` | 1b — spec §4/§5 (per-judgment messages, leases, FOR UPDATE finalization, reaper) |
| 55 | queue-readiness | MAJOR | completed→needs_human regression race between worker finalization and human-judgment route | `src/app/api/evaluations/[id]/runs/[runId]/human-judgment/route.ts:124` | 1b — spec §4/§5 (per-judgment messages, leases, FOR UPDATE finalization, reaper) |
| 56 | queue-readiness | MAJOR | Error taxonomy flattened to strings — no basis for ack vs nack-with-delay vs DLQ routing | `src/lib/evaluation-run-manager.ts:230` | 1b — spec §4/§5 (per-judgment messages, leases, FOR UPDATE finalization, reaper) |
| 57 | queue-readiness | MAJOR | Circuit-breaker state is a per-process Map — target architecture requires it in Redis | `src/lib/llm/resilience.ts:99` | 1b — spec §4/§5 (per-judgment messages, leases, FOR UPDATE finalization, reaper) |
| 58 | queue-readiness | MAJOR | No run-progress realtime events exist — topic space is a single dataset-summary event | `src/lib/realtime/events.ts:12` | 1b — spec §4/§5 (per-judgment messages, leases, FOR UPDATE finalization, reaper) |
| 59 | queue-readiness | MAJOR | Realtime bus silently degrades to process-local emit — worker-published events would vanish | `src/lib/realtime/redis-bus.ts:59` | 1b — spec §4/§5 (per-judgment messages, leases, FOR UPDATE finalization, reaper) |
| 60 | queue-readiness | MAJOR | SSE endpoint broadcasts all events to any authenticated subscriber — no ownership scoping in topic design | `src/app/api/events/route.ts:50` | 1b — spec §4/§5 (per-judgment messages, leases, FOR UPDATE finalization, reaper) |
| 61 | queue-readiness | MAJOR | Consumer live-reads mutable ModelConfig at execution time — violates judge-version pinning under queue lag | `src/lib/evaluation-run-manager.ts:111` | 1b — spec §4/§5 (per-judgment messages, leases, FOR UPDATE finalization, reaper) |
| 62 | queue-readiness | MAJOR | Dataset summary refresh: unsynchronized read-modify-write of remoteMetadata JSON plus full recompute per run completion | `src/lib/dataset-evaluation-summary.ts:96` | 1b — spec §4/§5 (per-judgment messages, leases, FOR UPDATE finalization, reaper) |
| 63 | deps-build | BLOCKER | container_name on app service blocks --scale app=N | `docker-compose.yml:24` | 1b — spec §9 (Next 15/Node 22, compose rework, worker image, Gitea CI) |
| 64 | deps-build | BLOCKER | Static host-port publish on app prevents a second replica | `docker-compose.yml:27` | 1b — spec §9 (Next 15/Node 22, compose rework, worker image, Gitea CI) |
| 65 | deps-build | BLOCKER | Migrations run in container CMD on every start — N-replica race and role coupling | `Dockerfile:70` | 1b — spec §9 (Next 15/Node 22, compose rework, worker image, Gitea CI) |
| 66 | deps-build | BLOCKER | No prisma/migrations directory — migrate deploy is a no-op and Schema v2 has no baseline | `docker-compose.yml:14` | 1a Task 1 (baseline migration) |
| 67 | deps-build | MAJOR | Next.js 14.2.35 is EOL with unpatched 2026 CVEs | `package.json:38` | 1b — spec §9 (Next 15/Node 22, compose rework, worker image, Gitea CI) |
| 68 | deps-build | MAJOR | node:20-alpine base image and CI Node 20 are past EOL (2026-04-30) | `Dockerfile:2` | 1b — spec §9 (Next 15/Node 22, compose rework, worker image, Gitea CI) |
| 69 | deps-build | MAJOR | No worker entrypoint, AMQP client, or rabbitmq/worker service exists anywhere | `package.json:10` | 1b — spec §9 (Next 15/Node 22, compose rework, worker image, Gitea CI) |
| 70 | deps-build | MAJOR | Runner image ships full dev node_modules over the standalone output | `Dockerfile:59` | 1b — spec §9 (Next 15/Node 22, compose rework, worker image, Gitea CI) |
| 71 | deps-build | MAJOR | Redis allkeys-lru eviction will silently drop rate-limit and circuit-breaker state | `docker-compose.yml:75` | 1b — spec §9 (Next 15/Node 22, compose rework, worker image, Gitea CI) |
| 72 | deps-build | MAJOR | CI pipeline is built on GitHub JS actions the Gitea runner cannot execute | `.github/workflows/ci.yml:25` | 1b — spec §9 (Next 15/Node 22, compose rework, worker image, Gitea CI) |
| 73 | deps-build | MAJOR | CI validates schema with db push and never exercises migrate deploy | `.github/workflows/ci.yml:86` | 1b — spec §9 (Next 15/Node 22, compose rework, worker image, Gitea CI) |
| 74 | deps-build | MAJOR | CI test environment has no Redis or RabbitMQ service | `.github/workflows/ci.yml:66` | 1b — spec §9 (Next 15/Node 22, compose rework, worker image, Gitea CI) |
| 75 | deps-build | MAJOR | @anthropic-ai/sdk pinned at 0.39.0, ~75 minor versions behind | `package.json:32` | 1b — spec §9 (Next 15/Node 22, compose rework, worker image, Gitea CI) |
| 76 | export-import | BLOCKER | Evaluations export carries no owner identity; v2 ownership-gated access model cannot be satisfied | `src/lib/export.ts:87` | 1a Tasks 7–8 (P1.5 pg_dump importer + owner map) |
| 77 | export-import | MAJOR | Config import assigns every entity to the importing user, collapsing multi-user ownership | `src/app/api/config/import/route.ts:57` | 1a Task 8 (owner resolution map) |
| 78 | export-import | MAJOR | Judge identity is a live join to mutable ModelConfig — judgeModelVersionId cannot be reconstructed | `src/app/api/evaluations/export/route.ts:29` | 1a Task 8 (judge synthesis, versions pinned) |
| 79 | export-import | MAJOR | promptTemplateVersion has no v1 source — prompt is built inline and never stored | `src/lib/llm/provider.ts:68` | 1a Task 9 (v1-legacy template v0) |
| 80 | export-import | MAJOR | Rubric coalescing erases pin-vs-fallback provenance and rubric identity is name-only | `src/lib/export.ts:165` | 1a Task 9 (imports from DB, lineage preserved) |
| 81 | export-import | MAJOR | criteriaScores JSON embeds criterion cuids that dangle after config import recreates criteria | `src/app/api/config/import/route.ts:146` | 1a Task 9 (criterion id remap) |
| 82 | export-import | MAJOR | human_selected_best_model is a raw ModelConfig cuid with no resolution path in any export artifact | `src/lib/export.ts:207` | 1a Task 9 (remapped via judges map) |
| 83 | export-import | MAJOR | Human labeler identity is lost — HumanJudgment.userId is not exported | `src/lib/export.ts:168` | 1a Task 9 (owners map on HumanJudgment) |
| 84 | export-import | MAJOR | dataset_sample_index is 1-based while every other surface is 0-based | `src/lib/export.ts:190` | Obsoleted by P1.5 — importer reads the DB, not the export |
| 85 | export-import | MAJOR | No stable dedup key for judgment rows: judgment id and timestamp are not exported and schema allows duplicates | `prisma/schema.prisma:219` | Obsoleted by P1.5 + 1a Task 4 unique key |
| 86 | export-import | MAJOR | Dataset and project references in the data export are display names, but the config import keys by slug | `src/lib/export.ts:187` | Obsoleted by P1.5 — DB ids, not names |
