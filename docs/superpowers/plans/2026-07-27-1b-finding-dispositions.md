# 1b Finding Dispositions — BLOCKER + MAJOR assigned to 1b (1:1)

Each of the 57 findings (56 unique defects; one breaker finding surfaced in two dimensions) the 1a disposition table assigned to 1b spec sections,
now mapped to the 1b plan task (T1-T18 in
`2026-07-27-judge-arena-1b-queue-providers-auth.md`) that resolves it.

| # | Dimension | Sev | Finding | Location | 1b Task |
|---|---|---|---|---|---|
| 1 | replica-safety | BLOCKER | In-process evaluation run queue — work pinned to one replica, lost on restart, dedup broken across replicas | `src/lib/evaluation-run-manager.ts:67` | T5+T7+T9 |
| 2 | replica-safety | BLOCKER | SSE realtime bus defaults to replica-local in-memory delivery | `src/lib/realtime/in-memory-bus.ts:8` | T3 |
| 3 | replica-safety | MAJOR | In-memory sliding-window rate limiter multiplies limits by replica count | `src/lib/rate-limit.ts:41` | T2 |
| 4 | replica-safety | MAJOR | Circuit-breaker state is a per-process Map — breakers trip and probe independently per replica | `src/lib/llm/resilience.ts:99` | T4 |
| 5 | replica-safety | MAJOR | Pod death mid-run leaves EvaluationRun permanently 'judging' — no reconciler or redelivery | `src/lib/evaluation-run-manager.ts:129` | T8 |
| 6 | replica-safety | MAJOR | Second, independent in-memory rate limiter in Edge middleware | `src/middleware.ts:17` | T2 |
| 7 | replica-safety | MAJOR | Redis bus silently and permanently degrades to replica-local delivery on any init/publish failure | `src/lib/realtime/redis-bus.ts:77` | T3 |
| 8 | replica-safety | MAJOR | Lost-update race: evaluation summary merged into dataset.remoteMetadata via unlocked read-modify-write | `src/lib/dataset-evaluation-summary.ts:91` | T8 |
| 9 | replica-safety | MAJOR | Prisma connection pool unbounded per replica — N replicas + workers can exhaust a single Postgres | `src/lib/db.ts:9` | T16 |
| 10 | correctness | BLOCKER | In-memory run queue: restarts strand pending runs; no atomic claim allows double-processing across replicas | `src/lib/evaluation-run-manager.ts:67` | T7+T9 |
| 11 | correctness | MAJOR | processRun final status blindly overwrites; races human judgment completed -> needs_human | `src/lib/evaluation-run-manager.ts:251` | T8 |
| 12 | correctness | MAJOR | create_and_run dataset batches return 201 'runsQueued' but run creation failures are swallowed in the queue | `src/app/api/evaluations/route.ts:516` | T9 |
| 13 | correctness | MAJOR | Judgment score normalization accepts non-numeric values (NaN) and never recomputes overall from criteria weights | `src/lib/llm/provider.ts:232` | T10 |
| 14 | correctness | MAJOR | Circuit breaker counts non-transient failures on a provider-wide shared key: one bad credential blocks all users | `src/lib/llm/resilience.ts:161` | T4 |
| 15 | correctness | MAJOR | Dataset evaluation summary uses non-transactional read-modify-write of remoteMetadata JSON | `src/lib/dataset-evaluation-summary.ts:96` | T8 |
| 16 | correctness | MAJOR | query-response samples with empty 'expected' silently flip to respond mode inside a judge batch | `src/app/api/evaluations/route.ts:500` | T7 |
| 17 | security-access-model | BLOCKER | All rate limiting is per-process in-memory; breaks at >=2 web replicas | `src/middleware.ts:17` | T2 |
| 18 | security-access-model | MAJOR | Public reads unimplemented: requireAuth precedes visibility check on all dataset/rubric reads | `src/app/api/datasets/[id]/route.ts:21` | T14 |
| 19 | security-access-model | MAJOR | Scoped developer API keys can mint new full-scope keys (privilege escalation) | `src/app/api/api-keys/route.ts:60` | T14 |
| 20 | security-access-model | MAJOR | SSE /api/events broadcasts every user's realtime events to any authenticated subscriber | `src/app/api/events/route.ts:49` | T3 |
| 21 | security-access-model | MAJOR | Model verify sends stored ciphertext as the provider API key (missing decryptSafe) | `src/app/api/models/[id]/verify/route.ts:41` | T10 |
| 22 | security-access-model | MAJOR | Registration limiter keys on unconditionally-trusted X-Forwarded-For (spoofable bypass) | `src/app/api/auth/register/route.ts:17` | T13+T2 |
| 23 | security-access-model | MAJOR | judgeLimiter/apiLimiter/authLimiter are dead code; LLM and HuggingFace routes have no dedicated limits | `src/lib/rate-limit.ts:114` | T2 |
| 24 | security-access-model | MAJOR | Dataset responses embed owner email — becomes anonymous-facing PII leak under v2 public reads | `src/app/api/datasets/route.ts:76` | T14 |
| 25 | provider-layer | BLOCKER | Circuit-breaker state is per-process in-memory with non-atomic transitions; cannot move to Redis as designed | `src/lib/llm/resilience.ts:99` | T4 |
| 26 | provider-layer | MAJOR | Provider identity is a closed hardcoded enum duplicated in four places; no descriptor-based registry | `src/lib/llm/index.ts:21` | T10 |
| 27 | provider-layer | MAJOR | Server-wide OPENAI_API_KEY silently sent as Bearer to arbitrary user-configured endpoints | `src/lib/llm/openai-compatible.ts:41` | T10 |
| 28 | provider-layer | MAJOR | Response metadata discarded at the adapter: token split summed, served model id and finish reason dropped | `src/lib/llm/anthropic.ts:60` | T10 |
| 29 | provider-layer | MAJOR | Sampling parameters are hardcoded literals — not per-model configurable, not recorded, and rejected by reasoning models | `src/lib/llm/anthropic.ts:49` | T10 |
| 30 | provider-layer | MAJOR | Judge prompt templates are unversioned inline string literals | `src/lib/llm/provider.ts:83` | T10 |
| 31 | provider-layer | MAJOR | verifyModelConnection returns void — captures no architecture fingerprint despite it being freely available | `src/lib/llm/verify.ts:11` | T10 |
| 32 | provider-layer | MAJOR | Circuit key granularity wrong for an aggregator: all OpenRouter models share one endpoint circuit | `src/lib/llm/index.ts:45` | T4+T11 |
| 33 | provider-layer | MAJOR | No structured-output seam: free-JSON prompting with lenient zero-fill parse, no schema in the provider interface | `src/lib/llm/provider.ts:101` | T11 |
| 34 | queue-readiness | BLOCKER | processRun is not idempotent: redelivery re-executes completed judgments and regresses terminal runs | `src/lib/evaluation-run-manager.ts:134` | T7 |
| 35 | queue-readiness | BLOCKER | 'evaluation'-type queue items are the only record of requested work — message loss = silently missing runs | `src/lib/evaluation-run-manager.ts:277` | T5+T9 |
| 36 | queue-readiness | MAJOR | In-memory queue trio is lost on restart with no recovery scan; activeIds dedup has no distributed replacement | `src/lib/evaluation-run-manager.ts:67` | T9 |
| 37 | queue-readiness | MAJOR | Final run status computed from in-memory counters, not DB aggregate | `src/lib/evaluation-run-manager.ts:245` | T8 |
| 38 | queue-readiness | MAJOR | completed→needs_human regression race between worker finalization and human-judgment route | `src/app/api/evaluations/[id]/runs/[runId]/human-judgment/route.ts:124` | T8 |
| 39 | queue-readiness | MAJOR | Error taxonomy flattened to strings — no basis for ack vs nack-with-delay vs DLQ routing | `src/lib/evaluation-run-manager.ts:230` | T4 |
| 40 | queue-readiness | MAJOR | Circuit-breaker state is a per-process Map — target architecture requires it in Redis | `src/lib/llm/resilience.ts:99` | T4 |
| 41 | queue-readiness | MAJOR | No run-progress realtime events exist — topic space is a single dataset-summary event | `src/lib/realtime/events.ts:12` | T3 |
| 42 | queue-readiness | MAJOR | Realtime bus silently degrades to process-local emit — worker-published events would vanish | `src/lib/realtime/redis-bus.ts:59` | T3 |
| 43 | queue-readiness | MAJOR | SSE endpoint broadcasts all events to any authenticated subscriber — no ownership scoping in topic design | `src/app/api/events/route.ts:50` | T3 |
| 44 | queue-readiness | MAJOR | Consumer live-reads mutable ModelConfig at execution time — violates judge-version pinning under queue lag | `src/lib/evaluation-run-manager.ts:111` | T7+T12 |
| 45 | queue-readiness | MAJOR | Dataset summary refresh: unsynchronized read-modify-write of remoteMetadata JSON plus full recompute per run completion | `src/lib/dataset-evaluation-summary.ts:96` | T8 |
| 46 | deps-build | BLOCKER | container_name on app service blocks --scale app=N | `docker-compose.yml:24` | T16 |
| 47 | deps-build | BLOCKER | Static host-port publish on app prevents a second replica | `docker-compose.yml:27` | T16 |
| 48 | deps-build | BLOCKER | Migrations run in container CMD on every start — N-replica race and role coupling | `Dockerfile:70` | T16 |
| 49 | deps-build | MAJOR | Next.js 14.2.35 is EOL with unpatched 2026 CVEs | `package.json:38` | T1 |
| 50 | deps-build | MAJOR | node:20-alpine base image and CI Node 20 are past EOL (2026-04-30) | `Dockerfile:2` | T1 |
| 51 | deps-build | MAJOR | No worker entrypoint, AMQP client, or rabbitmq/worker service exists anywhere | `package.json:10` | T5+T7+T16 |
| 52 | deps-build | MAJOR | Runner image ships full dev node_modules over the standalone output | `Dockerfile:59` | T16 |
| 53 | deps-build | MAJOR | Redis allkeys-lru eviction will silently drop rate-limit and circuit-breaker state | `docker-compose.yml:75` | T2+T16 |
| 54 | deps-build | MAJOR | CI pipeline is built on GitHub JS actions the Gitea runner cannot execute | `.github/workflows/ci.yml:25` | T17 |
| 55 | deps-build | MAJOR | CI validates schema with db push and never exercises migrate deploy | `.github/workflows/ci.yml:86` | T17 |
| 56 | deps-build | MAJOR | CI test environment has no Redis or RabbitMQ service | `.github/workflows/ci.yml:66` | T17 |
| 57 | deps-build | MAJOR | @anthropic-ai/sdk pinned at 0.39.0, ~75 minor versions behind | `package.json:32` | T1+T10 |
