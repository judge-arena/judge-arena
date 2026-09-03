# Judge Arena

A **meta-evaluation studio for LLM judges**. Register judge models in a catalog, run them over
datasets through a queue-backed worker, build *golden sets*, and calibrate judges against them —
accuracy against the set's ground truth first, with agreement statistics beside it.

> **Correction, 2026-08-31.** This paragraph used to say "build **human-labelled** golden sets, and
> calibrate judges against **those labels**". That described one of the two calibration paths as if
> it were the only one, and it was the path that has never run: `GoldenLabel` is still **0** in
> production. What shipped in A2.1 scores a judge against `GoldenItem.expected` — the answer key
> that arrives with the dataset — and needs no human label at all. The human-vs-model half (E1–E3,
> inter-annotator agreement, test-retest) is still unbuilt data, not just unbuilt code. See
> [Calibration](#calibration).

It is a Next.js 15 application on PostgreSQL with a separate Node worker process, RabbitMQ and
Redis. It runs in production on Kubernetes at <https://judgearena.com>. **If you are here to change
something that ships, read [Deployment](#deployment) before anything else** — CI publishes images,
but nothing deploys them; promotion is a hand edit in another repo.

---

## CORRECTION — what this README said before 2026-08-29

This file described a *different application* for months. It is corrected in place rather than
silently rewritten, because the old claims are still cached in people's heads and in forks:

| It claimed | Reality | Checked with |
|---|---|---|
| SQLite, `file: prisma/dev.db` | PostgreSQL | `prisma/schema.prisma:5-8` — `provider = "postgresql"` |
| Next.js 14 | Next.js 15 (`15.5.22` resolved) | `package.json`, `package-lock.json` |
| "8 Prisma models — Project, Rubric, Evaluation, …" | **29** models | `grep -c '^model ' prisma/schema.prisma` → 29 |
| "13 UI primitives" | 14 | `ls src/components/ui \| wc -l` → 14 (it omitted `brand-icon`) |
| `seed.ts` is the seed: "Default rubric + 3 Anthropic models + sample project" | Half right, and worth saying so rather than scoring it as a miss. The *contents* line survives — 1 rubric with 5 criteria, 3 Anthropic-backed catalog judges (`CATALOG_JUDGES`, `seed-core.ts:84-88`), 1 leaderboard project — but the *location* is wrong and the list is now short. `seed.ts` is a 47-line entry point owning only the client lifecycle and the exit code; the work is in `seed-core.ts` → `seed-prompt-templates.ts` + `seed-judgebench.ts`, and it now also writes a platform system user that cannot log in, prompt templates, and 2 public datasets (LiveCodeBench metadata-only, JudgeBench 620 samples). The "models" are catalog rows only — `JudgeModel` + `JudgeModelVersion`, **never a `ModelEndpoint`**, because keys are BYOK | `wc -l prisma/seed.ts` → 47; `prisma/seed-core.ts:97-259` |
| `Ctrl+N` creates, `Ctrl+E` runs models | **Neither shortcut exists.** `app-shell.tsx:74` returns early on `ctrlKey \|\| metaKey \|\| altKey`, and no page registers either | `grep -rn "addEventListener('keydown'" src/` → 3 handlers, none of which binds a Ctrl chord. The *only* Ctrl binding in the tree is an inline `onKeyDown` for `Ctrl`/`Cmd`+`Enter` in the datasets sample editor (`src/app/datasets/page.tsx:1176,1203`) — see [Keyboard shortcuts](#keyboard-shortcuts) |
| 24 endpoint rows across 5 groups | 49 route files in 13 groups | `find src/app/api -name route.ts \| wc -l` → 49 |
| Anthropic + OpenAI + "local" | 6 serving backends incl. OpenRouter and vLLM | `enum ServingBackend`, `prisma/schema.prisma:31-38` |
| — | Deployed on Kubernetes, behind Authentik OIDC, fed by RabbitMQ | Never mentioned at all. That was the worst of it. |

One thing the old tree got *right* and is kept: `src/app/evaluate/[id]/` is a live route, not a
relic — it now has a `runs/[runId]/` child.

---

## Features

| Area | Details |
|---|---|
| **Judge catalog** | Judges are first-class rows, not connection strings: `JudgeModel` (identity, class, scoring mechanism, license) → `JudgeModelVersion` (weights revision, quantization, serving backend) → `ModelEndpoint` (per-user URL + encrypted key). Catalog rows are immutable once created. |
| **Multi-backend judging** | `anthropic`, `openai`, `openrouter`, `vllm`, `ollama`, `llamacpp`. All but Anthropic share one OpenAI-compatible call path; per-backend behaviour is a descriptor hook, not a forked provider class. |
| **Structured output** | JSON-Schema-constrained judgments where the backend supports it — `response_format: json_schema` generally, plus vLLM's `guided_json` sent alongside for older deployments. A non-conforming response is demoted to a lenient parse with `parseMode: 'fallback'` and a logged warning, never a hard failure. |
| **BYOK** | Credentials live on `ModelEndpoint.apiKeyEnc`, AES-256-GCM at rest (`enc:v1:<iv>:<tag>:<ct>`, `src/lib/crypto.ts`). `OPENROUTER_API_KEY` / `VLLM_API_KEY` in `.env.example` are *operator guidance for what to paste into an endpoint*, never read as credential fallbacks. |
| **Queue-backed runs** | Judgment execution is a RabbitMQ job, not a request handler. Quorum work queues + TTL retry queues + a DLQ; a Redis-backed circuit breaker keyed `backend:endpoint:model`. |
| **Golden sets** | Versioned, forkable, retirable human-labelled sets built from dataset samples. Assignment rows record *who was asked to annotate what*; revoking keeps the row. |
| **Annotation studio** | `/golden-sets/[id]/label` — a served queue, span/delta text views, a progression rail, and a revision log for every edit. |
| **Calibration** | `CalibrationRun` scores a judge against a golden set's ground truth: **accuracy** (stored on the legacy `rawAgreement` column) as the primary number, Cohen/Fleiss kappa beside it with its variant and weighting recorded, and `verdictCount`. **Written for the first time on 2026-08-31** — until A2.1 this table was schema that was only ever *counted*, never inserted into. `testRetest`, `positionBias`, `biasSensitivityRate`, `flipRateVsParent`, `passThreshold` and `passed` are still **NULL** on the only row that exists; they are later phases, not fields that failed to populate. See [Calibration](#calibration). |
| **Tombstones, not deletes** | Samples, items and labels tombstone. Ownership FKs are `SetNull`, so a deleted account anonymises its work instead of destroying it. |
| **Rubric versioning** | Every rubric edit creates a new version pinned by `parentId`. Version creation is transactional with a P2002 retry (`src/lib/rubric-versions.ts`) — two concurrent editors cannot mint the same version number. |
| **Audit log** | `AuditLog` rows for auth and mutation events. Login failures record a machine-readable `reason`, which is how OIDC identity mismatches get diagnosed. |
| **Keyboard-driven** | Vim-style `G`-chords for navigation, `1-9`/`0` for scoring, `?` for the sheet. See [Keyboard shortcuts](#keyboard-shortcuts) — verified against the handlers, unlike the previous version of this table. |
| **Zero external UI deps** | Still true. All 14 primitives in `src/components/ui/` are hand-built — no Radix, shadcn or Headless UI anywhere in `package.json` or `src/` (`grep -rn 'radix\|shadcn\|headlessui' package.json src/` → no hits), keeping the project MIT-clean. Runtime UI packages are `sonner` (toasts), `next-themes`, `clsx`, `tailwind-merge`. |

---

## Deployment

**This is the most important operational fact about the project and the previous README omitted it
entirely.** Judge Arena is not a `npm start` app; it is a Helm release on a Kubernetes cluster, and
its chart lives in a *different repository*.

| Thing | Where |
|---|---|
| Cluster | Cozystack homelab cluster, namespace **`tenant-public`** |
| Public URL | <https://judgearena.com> (Cloudflare Tunnel → tenant ingress) |
| Helm chart | **separate repo `homelab-setup`**, `charts/judge-arena/` |
| Release + backing services | `homelab-setup`, `apps/public/judge-arena/` |
| Image registry | `harbor.cluster.asethi.com/homelab/judge-arena` |
| Image build | this repo, `.gitea/workflows/ci.yml` |

### One image, two roles

The `Dockerfile` produces a single image whose containers differ only by `command`:

- `node server.js` — the Next.js 15 standalone server, port 3000 (`judge-arena-web`)
- `node worker.js` — the AMQP consumer, health on port 9090 (`judge-arena-worker`)

It also bundles two operator entry points, both esbuild bundles of TypeScript that cannot otherwise
run in-cluster (the runner stage ships no TS toolchain):

- `/app/admin-create-user.js` — the break-glass account CLI
- `/app/seed.js` — the seeder

Plus the Prisma CLI at `/opt/prisma-cli` and the `prisma/` tree (schema + migrations), so the same
image can migrate the database it is about to serve.

### Build and promotion — promotion is MANUAL, by design

On a push to `main`, Gitea Actions runs lint, `tsc`, the unit/DB/integration suites and `next build`,
then spawns an **ephemeral kaniko Job in `tenant-builds`** (the act_runner is host-mode with no
container engine, so it cannot build images itself) and pushes
`harbor.cluster.asethi.com/homelab/judge-arena:sha-<short>` plus `:latest`.

**Nothing deploys that image.** The authoritative tag is a hand-edited field:

```
homelab-setup / apps/public/judge-arena/helmrelease.yaml
  spec.values.image.tag        <- THIS is what production runs
```

`charts/judge-arena/values.yaml` also carries an `image.tag` — `sha-ed67eb87bc2a`, the hand-built
first image from 2026-08-07 — but the HelmRelease overrides it. The chart default is stale by design
and is **not** the thing to read; two tags disagreeing here is the expected state, not a bug.

Deployed tag, and the reason to read this line as dated rather than as a constant:

- Earlier on **2026-08-29** production was on `sha-bee1d121ea7d`, one merge behind `main`.
- Later the same day the promote to the `14d75f7` build landed. Verified live:
  `kubectl -n tenant-public get deploy judge-arena-web judge-arena-worker -o jsonpath='{.items[*].spec.template.spec.containers[0].image}'`
  → `harbor.cluster.asethi.com/homelab/judge-arena:sha-14d75f7d46de` on both, matching
  `spec.values.image.tag` in the HelmRelease. Both pods 1/1 Running.
- **2026-08-31 21:23Z: `sha-c6417860027a`** on both Deployments — commit `c641786`, **two commits
  behind `main`**. **SUPERSEDED READING, kept deliberately**: it was correct when taken, and it is
  the reason anything below describes the cap as un-deployed.
- **2026-08-31 21:29Z: `sha-1e7a427d2c48`** on both Deployments — commit `1e7a427`. **The promote
  landed while this section was being written.** Both pods rolled; the worker logged the clamp on
  boot, which is the only proof that matters:

  ```
  {"level":"warn","msg":"EVALUATION_MODEL_CONCURRENCY_PER_RUN clamped to the hard cap",
   "timestamp":"2026-08-31T21:29:24.604Z","requested":2,"effective":1,
   "reason":"concurrent provider calls queue INSIDE the inference server while their client timeout runs"}
  {"level":"info","msg":"judge worker started","timestamp":"2026-08-31T21:29:24.605Z",
   "prefetch":1,"concurrency":1,"healthPort":9090,"consumers":2}
  ```

  Note what that pair shows: the Deployment still sets `EVALUATION_MODEL_CONCURRENCY_PER_RUN=2` and
  the worker runs at **1** anyway, with `prefetch: 1`. **The env var is now documentation of an
  intent, not a control.** Do not read it as the effective concurrency — read the boot log.

Do not treat either sha as current without re-running that command; manual promote means the number
in this file goes stale the moment someone edits the HelmRelease.

Two consequences worth internalising:

- The HelmRelease pins `chart.spec.reconcileStrategy: Revision`, not the default `ChartVersion`.
  Learned the hard way on 2026-08-07: editing `values.yaml` without bumping `Chart.yaml` left every
  Flux status green while the pods kept the old env for 20 minutes. Since the promote flow edits
  `values.image.tag` and never touches `Chart.yaml`, `ChartVersion` would have silently no-op'd
  every future promote too.
- The deployment is `maxUnavailable: 0 / maxSurge: 1`. A wrong tag surges a pod that never becomes
  Ready while the old pod keeps serving — the rollout stalls with the site **up**, rather than
  taking it down. Rollback is `git revert` + `flux reconcile kustomization judge-arena --with-source`.

Manual promote is temporary (`stable.yaml` says "until the Phase-2 promote-PR wiring exists"), and
until it lands the Deployments carry `homelab.asethi.com/build-lag-exclude` so the build-lag
exporter does not alert on a lag that is the intended behaviour.

### Migrations: a pre-upgrade hook Job

`charts/judge-arena/templates/migrations-job.yaml` runs `prisma migrate deploy` as a Helm hook:

```
helm.sh/hook: pre-install,pre-upgrade
helm.sh/hook-weight: "10"
helm.sh/hook-delete-policy: before-hook-creation,hook-succeeded
```

**Pre-, not post-**: Helm waits for pods to be Ready before post-install hooks, which would gate
schema creation behind RabbitMQ coming up. The Job waits for Postgres itself, and its
`activeDeadlineSeconds` is bounded well below the HelmRelease timeout — an interrupted migration
leaves an unfinished `_prisma_migrations` row that wedges every future deploy with P3009.

Because of `before-hook-creation`, **a failed migration Job survives only until the next attempt**,
and `install.remediation.retries: -1` guarantees there is a next attempt. Grab
`kubectl logs job/judge-arena-migrate` promptly.

~~18 migrations, latest `20260818120000_v2h_human_verification`~~ → **19 migrations**, latest
`20260830120000_v2i_calibration_item_link` (re-verified against production `_prisma_migrations` on
**2026-08-31**: **19 applied, 0 unfinished**). v2i is entirely additive — no `DROP`, no `DELETE`, no
column type change, and its one `NOT NULL` addition (`ModelJudgment.promptTruncated`) carries
`DEFAULT false`.

### Seeding is deliberately NOT a hook — promoting does not seed

`grep -rn seed charts/judge-arena/` returns nothing. There is no seed hook of any kind. Seeding is an
explicit operator action:

```bash
kubectl -n tenant-public exec deploy/judge-arena-web -- node /app/seed.js
```

A post-upgrade hook would seed on every chart upgrade, shipping catalog changes as a side effect of
an unrelated image bump. That coupling is exactly what the manual step is protecting against.

> **CORRECTION (2026-08-29).** Earlier operational notes in this repo said: *"run the seeder and read
> its output — a 'Created' line means production was behind."* **That rule is false.**
> `seedPromptTemplates` upserts and then logs `✓ Created prompt template: …` **unconditionally**,
> outside any branch; `seed-judgebench.ts` opens with an unconditional `✓ Created dataset: …`; and
> `seed-core.ts` — the file the old rule named — never prints the word "Created" at all. No log line
> in the seeder is gated on an actual insert. The only line carrying a real delta is the
> parenthetical `${created.count} new samples`.
>
> **Replacement rule:** query the table before and after
> (`select name, version, "createdAt" from "PromptTemplate"`), or read only the lines that report a
> real delta. Note for anyone tempted to fix this in code: `PromptTemplate` has no `updatedAt`
> column, so "branch on `createdAt === updatedAt`" is not implementable — use a `findUnique` before
> the upsert, a `count()` before/after, or `create` with a P2002 catch.
>
> Related: `prisma/seed.ts:29` claims "It is idempotent, so a second run is safe and reports zero new
> rows." True for judgebench; false for prompt templates.

### Backing services

Plain manifests in `homelab-setup/apps/public/judge-arena/`, **not subcharts**, so `helm uninstall`
can never take the Postgres PVC with it:

| File | Provides | Secret |
|---|---|---|
| `cnpg-cluster.yaml` | CloudNativePG cluster `judge-arena-pg`, database **`judge_arena`** | `judge-arena-pg-app` (`uri`) |
| `redis.yaml` | `judge-arena-redis` | — |
| `rabbitmq.yaml` | RabbitMQ `judge-arena` | `rabbitmq-judge-arena-default-user` |

App secrets are SOPS files in the same directory; the Flux Kustomization at
`clusters/homelab/apps/judge-arena.yaml` **must** carry a `decryption` block or they apply still
encrypted.

There is no reaper workload — `startReaper()` runs in-process in every worker replica, serialised by
a Redis lock.

---

## Authentication and accounts

**Authentik OIDC is the production path. Self-service registration is retired.**

- `/register` is a static "accounts are invite-only" notice, kept rather than deleted so a stale
  bookmark fails soft instead of 404ing. `/api/auth/register` no longer exists.
- Accounts are created by an admin invite CLI, `scripts/admin/create-user.ts` (bundled into the
  image as `/app/admin-create-user.js`):

  ```bash
  kubectl -n tenant-public exec deploy/judge-arena-web -- \
    node /app/admin-create-user.js --email=<you@example.com> --admin
  ```

  Omit `--password` to mint an `invitePending` row that the first OIDC sign-in claims (stamping
  `oidcIssuer`/`oidcSubject` and clearing the flag). Use the exact lowercase email Authentik will
  emit in the `id_token`.
- **The two account shapes are mutually exclusive per address.** Passing `--password` creates a
  credentials account with `invitePending=false`, so that email can then never complete an OIDC
  sign-in, and the CLI refuses to create a second row for an existing address. Want a
  password-based break-glass account as well? Give it a different email.
- A **credentials provider** remains, for local development and admin-created direct-login accounts.
  It excludes any row whose `passwordHash` starts with `!` — the sentinels
  (`!oidc-managed`, `!imported-oidc-only`, `!archive-system-user`) can never present a real bcrypt
  hash, and filtering them disambiguates login now that more than one `User` row can share an email.
- Identity key is `@@unique([oidcIssuer, oidcSubject])`. `AUTHENTIK_ISSUER` is therefore *stable
  configuration*: changing it after go-live orphans every existing OIDC user.
- `ALLOW_OIDC_AUTOPROVISION` defaults off and should stay off. Its create path sets no role, so an
  autoprovisioned row lands on the schema default `role = "user"` **and** `invitePending=false` —
  which permanently closes the `--admin` invite path for that email. A denied login costs nothing;
  an autoprovisioned one costs the admin path.

Full provider/application blueprint, including the `grant_types` gotcha and the invite-claim flow:
`docs/runbooks/authentik-oidc-setup.md`.

> **Known trap (verified on production 2026-08-29).** If Authentik has two accounts sharing one email
> and the OAuth2 provider's `sub_mode` is `user_uuid`, the invite is claimed by whichever account was
> signed in at claim time — and every later sign-in as the *other* account resolves to no match and
> is refused, writing `user.login.failed {"reason":"no_match_autoprovision_disabled"}`. The fix is to
> repoint `User.oidcSubject` at the right uuid, or to consolidate the duplicate Authentik accounts.
> Do **not** issue a fresh invite and do **not** enable autoprovision — both mint a second, empty
> `User` row that owns nothing, and the partial unique index
> (`UNIQUE (email) WHERE passwordHash NOT LIKE '!%'`) does not prevent it.

---

## Queue, worker and realtime

Judgment execution does not happen in a request handler.

```
judge.direct  (exchange, direct, durable)
  ├─ judgment.execute     (quorum)   the work queue
  ├─ run.create           (quorum)   run fan-out
  ├─ judge.dlq            (quorum)   dead letters
  ├─ judgment.retry.30s   (classic)  TTL 30s -> DLXs back to judgment.execute
  └─ judgment.retry.5m    (classic)  TTL 5m  -> DLXs back to judgment.execute
```

Every queue is bound with a routing key equal to its own name, so producers and retry re-publishes
always go *through* the exchange, never `sendToQueue`. Retry queues are classic on purpose: they are
short-lived holding pens with no consumer, so replication belongs on the queues judgments are
actually consumed from. See `src/lib/queue/topology.ts`.

- **Worker** — `worker.ts` at the repo root is a thin re-export of `src/worker/main.ts`, kept at the
  top level as a stable build/deploy target. It asserts topology, sets prefetch, starts the
  `judgment.execute` and `run.create` consumers on the shared confirm channel, runs the reaper, and
  serves health on `WORKER_HEALTH_PORT` (default 9090). SIGTERM cancels consumers, drains in-flight
  handlers with a 30s bound, then closes cleanly. Local: `npm run worker`.
- **Concurrency is hard-capped at 1** (`src/worker/concurrency.ts`, `HARD_CONCURRENCY_CAP`).
  `EVALUATION_MODEL_CONCURRENCY_PER_RUN` may ask for anything the env schema allows (1–16); the
  request is **clamped**, the boot does not fail, and the clamp is logged at `warn` with both the
  requested and effective values (`src/worker/main.ts:207-215`) — silent to the configuration,
  never to an operator who sets 8 and sees no change.

  > **CORRECTION 2026-08-31 — this bullet used to read "sets prefetch
  > (`EVALUATION_MODEL_CONCURRENCY_PER_RUN * 4`)". That was accurate, and the behaviour it
  > described was a defect.** Prefetch is not a buffer here: `dispatch` starts a handler for
  > *every* message the broker delivers, so a prefetch of N runs N judgments at once and the `* 4`
  > quadrupled a concurrency nobody had asked for. At concurrency 2 the worker issued **eight**
  > concurrent HTTP requests to a llama.cpp server advertising `total_slots: 2`; requests three
  > through eight queued *inside the inference server* while their 300s client timeout ran, and
  > **4 of 30 items of the first production calibration dead-lettered** with
  > `timed out after 300000ms`. Over-subscribing an inference server does not make it faster; it
  > converts a queue you can see (RabbitMQ, with depth, retries and a DLQ) into one you cannot, and
  > then times out against it — and the ones that *did* finish came in at a median of **265s**
  > against that same 300s ceiling. See [Calibration](#calibration) for the measured latencies and a
  > discrepancy in the numbers currently written into `src/worker/concurrency.ts`.
  >
  > **Why 1 and not "match the server's slots":** the worker cannot know the slot count. It is a
  > property of whichever endpoint each `JudgeModelVersion` points at — different per judge,
  > invisible from here, and free to change when someone restarts a server with different flags.
  > One in flight is the only value safe against every endpoint without asking any of them, and it
  > makes a calibration run **sequentially**, which is what makes a latency baseline reproducible.
  >
  > **Raising the cap is not the eventual fix; per-endpoint concurrency is** — the value belongs
  > beside the endpoint that constrains it (a column on `ModelEndpoint`, or a probe of the server's
  > advertised slots) with a scheduler that respects it per endpoint. A single global number cannot
  > be right for a fleet of heterogeneous endpoints, and being wrong costs dead-lettered items that
  > look like model failures. Read `src/worker/concurrency.ts` before changing it.
- **Redis** — backs the Lua sliding-window rate limiter (one budget shared across replicas, enforced
  at the `requireAuth()` chokepoint in `src/lib/auth-guard.ts`, *not* in middleware — edge middleware
  cannot hold a Redis connection), the circuit breaker, the reaper lock, and the SSE realtime bus.
  `getRedis()` throws at first use if `REDIS_URL` is unset under `NODE_ENV=production`.
- **Realtime** — `GET /api/events` is an SSE stream over the bus in `src/lib/realtime/` (Redis
  streams in production, in-memory under `NODE_ENV=test`).

> **Live defect, open as of 2026-08-29 — not yet fixed in code.** The production pipeline was dead
> from 2026-08-24T17:55Z: all five queues reported `consumer_count=0`. A Cozystack roll recreated
> `judge-arena-pg-1`; the worker logged `Can't reach database server` / SQLSTATE 57P01 twenty-one
> seconds later and emitted nothing since, while staying 1/1 Running with 0 restarts. Its socket
> reconnected; its **AMQP consumers never re-registered**. A worker rollout restores service. The
> underlying defect — the AMQP client must re-register consumers on reconnect, not only on boot — is
> still open.
>
> **Update, later on 2026-08-29 — the outage is over, the defect is not.** The promote to
> `sha-14d75f7d46de` rolled the worker Deployment, which is the "worker rollout" prescribed above,
> and the consumers came back:
> `kubectl -n tenant-public exec rabbitmq-judge-arena-server-0 -c rabbitmq -- rabbitmqctl list_queues name messages consumers`
> → `judgment.execute 0 1`, `run.create 0 1`. (`judge.dlq` and both `judgment.retry.*` queues report
> 0 consumers and always will — they have no consumer by design, so they are not a signal either way;
> the two work queues are.) Nothing about the reconnect path changed, so the next broker or Postgres
> roll can silently do this again.
>
> **Update (2026-09-01) — fixed, by exiting.** The worker no longer outlives a lost consumer set:
> the registry's `onLost` is `createConsumerLossPolicy` (`src/worker/health.ts`), which logs once,
> flushes the fire-and-forget writes with a 2 s bound and `process.exit(1)`s; Kubernetes'
> `restartPolicy` re-runs boot, the only path that registers consumers. In-process re-registration
> was rejected on purpose, and a broker outage now CrashLoops the worker visibly instead of leaving
> a zombie — both explained in CONTRIBUTING.md under "The 2026-08-24 consumer loss". The queue count
> quoted above was true on 2026-08-24; since per-server lanes landed there are ten consumed queues
> (`consumers == expectedConsumers == 10` in the worker's boot log).

---

## Calibration

**New on 2026-08-31 (A2.1).** This is the path from "a judge model and a golden set" to a number,
and the evidence trail underneath it. Before it, nothing in the product paired a `GoldenItem` with a
model's verdict: `ModelJudgment` hangs off `EvaluationRun` → `Evaluation`, and `Evaluation` carries
a `datasetSampleId` but no golden item — so there was no path from a verdict to the `expected` it
should be scored against. `CalibrationRun` existed in the schema and was only ever **counted** (by
`isGoldenSetFrozen`), never written.

### The link is two nullable columns, not a join table

`prisma/migrations/20260830120000_v2i_calibration_item_link/migration.sql` adds
`EvaluationRun.goldenItemId` and `EvaluationRun.calibrationRunId`, plus
`@@unique(calibrationRunId, goldenItemId)`. There is no join table, deliberately:

- **An `EvaluationRun` is already 1:1 with a golden item by construction** — a pairwise run holds
  exactly one candidate pair (`RunCandidate @@unique([runId, position])`, and
  `buildPairwiseUserPrompt` requires exactly two). A join table would model a relationship that the
  schema already enforces.
- **A join table would have carried a stored `preference`, and A0 decision #4 forbids that.** Which
  sample was preferred is **derived** from `(verdict, pairOrder)` at read time. Encoding it turns
  the B/A position-bias sweep into a backfill instead of an insert — the failure the derive-never-
  encode rule exists to prevent.

The unique index deliberately keeps Postgres' default `NULLS DISTINCT`: every ordinary (non-
calibration) run has both columns NULL and they must all coexist, while at most one calibration run
may exist per (calibration, item). That is why this migration needed **zero hand edits**, unlike
`ModelJudgment`'s `NULLS NOT DISTINCT` index — see CONTRIBUTING's *Known migrate-diff pseudo-drift*.

### Accuracy is the primary number; kappa is a labelled secondary

`src/lib/calibration/score.ts` writes accuracy to the legacy `rawAgreement` column and records
`thresholdMetric: 'accuracy'`. The ordering is not a preference:

1. **Ground truth is an answer key, not a peer rater.** Cohen's kappa chance-corrects on *both*
   raters' marginals, which presumes two annotators who could each have been wrong. The corpus is
   not one of those — its marginal is a property of the **set** (17 `A>B` / 13 `B>A` for the target
   set, fixed forever the moment it froze), so discounting a judge's hits against it treats a
   constant as a source of chance.
2. **Kappa is not comparable across sets, and cross-set is the whole point of a leaderboard.**
   Because `pe` depends on the key's class balance, the same judge with the same hit rate scores a
   different kappa on a 17/13 set than on a 15/15 one.

**So why compute it at all?** Because accuracy alone cannot distinguish a judge that learned
something from a judge that answers `A>B` every time. On the target set that degenerate judge scores
**0.5667** accuracy — "better than chance" to the naked eye — and kappa scores it **0.0000**, which
is exactly right. The two fail in opposite directions, so both are stored, and
`kappaVariant`/`kappaWeighting` record what produced the second one. A kappa with no stated method
is a number nobody can check a year from now.

**A2 writes no statistics code.** `src/lib/agreement.ts` is reused unchanged: `raterId` is opaque to
it, so `'ground-truth'` is just another rater — the same trick the human `label-readings` path
already uses for `'round-1'`/`'round-2'`. A `'tie'` counts as a **miss** (the corpus has no ties, so
there is no item a tie could be right about, and crediting it would let a judge raise its score by
refusing to answer), and a judgment that never completed is **not** a wrong answer — only
`status: 'completed'` judgments are loaded, so an in-flight calibration scores what it has rather
than improving as the queue drains.

### THE FIRST REAL NUMBER — and its caveat

Verified directly against production, read-only, on 2026-08-31:

```
kubectl exec -n tenant-public judge-arena-pg-1 -c postgres -- psql -U postgres -d judge_arena -tAc \
  'SELECT id, kappa, "rawAgreement", "verdictCount", "thresholdMetric" FROM "CalibrationRun";'
```

| | |
|---|---|
| Judge | **Qwen3.6-35B-A3B** (`Qwen3.6-35B-A3B-UD-Q3_K_XL.gguf`, `llamacpp` backend, local) |
| Golden set | `cmt057hd001g17y01lhjzgfuj` — *JudgeBenchSample — 30 random*, 30 pairwise items, ground truth **17 `A>B` / 13 `B>A`**, no ties |
| `CalibrationRun` | `cmtgib0xr00016k2r8nlyj1py`, started `2026-08-31 00:35:04`, finished `01:47:46` |
| **Accuracy** | **0.8462** (`rawAgreement = 0.8461538461538461`) — **22 of 26**, not 22 of 30 |
| Kappa | **0.6950** (`cohen`, weighting `none`) |
| `verdictCount` | **26** |
| `passed` / `passThreshold` | **NULL** — no threshold has been set, so nothing has passed or failed |

> **⚠ READ THE DENOMINATOR. This is a 26-item number, not a 30-item one, and the four missing items
> were OUR fault, not the model's.** All four dead-lettered with
> `Provider call to "llamacpp" (Qwen3.6-35B-A3B-UD-Q3_K_XL.gguf) timed out after 300000ms` after 4
> attempts each. The cause was **configuration**: prefetch was `concurrency(2) × 4 = 8`, so eight
> concurrent requests hit a server with `total_slots: 2` and six queued *inside the server* while
> their client timeout ran. Do not read 0.8462 as "the judge failed 4 items"; it never saw them. The
> cap described under [Queue, worker and realtime](#queue-worker-and-realtime) is the fix.

**The measured latencies, and a discrepancy worth resolving before anyone quotes the round number.**

```
kubectl exec -n tenant-public judge-arena-pg-1 -c postgres -- psql -U postgres -d judge_arena -tAc \
 'SELECT count(*), round(avg(mj."latencyMs")), min(mj."latencyMs"), max(mj."latencyMs"),
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY mj."latencyMs")::numeric)
    FROM "ModelJudgment" mj JOIN "EvaluationRun" er ON er.id = mj."runId"
   WHERE er."calibrationRunId" = 'cmtgib0xr00016k2r8nlyj1py' AND mj.status = 'completed';'
→ n=26  avg=232917  min=65774  max=299063  median=265372     (milliseconds)
```

> **⚠ `src/worker/concurrency.ts:12-13` and `1e7a427`'s commit message both state that "judgments
> that completed averaged 94s, well inside the 300s ceiling". The stored `latencyMs` does not say
> that.** The 26 completed judgments average **233s**, with a median of **265s** and a maximum of
> **299,063 ms — 937 milliseconds under the 300,000 ms timeout**. So it is not that four unlucky
> items timed out while the rest were comfortable; **26 of 30 finished within a second of the wall.**
>
> The two figures are not necessarily contradictory, and the difference is the whole point of the
> incident: `latencyMs` is measured around the HTTP call
> (`src/lib/llm/openai-compatible.ts:249` — `Date.now() - startTime` spanning the SDK request), so it
> **includes time the request spent queued inside the inference server**. 94s may well be the
> model's generation time from another source. **It is not recoverable from this database**, and
> nothing in these rows separates generation from queue wait.
>
> **Treat 94s as unverified, and do not quote it as a latency baseline.** The clean sequential re-run
> is what produces a real one: at concurrency 1 there is no in-server queue for `latencyMs` to
> absorb, so its stored value becomes generation time. That run is now in flight (below) — **read
> its latencies before characterising this judge's speed, and do not carry 233s forward either.**

> **IN FLIGHT — the clean sequential re-run, and it is genuinely sequential this time.**
> `CalibrationRun` **`cmthr58r100013s0sykuvn41x`** — same golden set, same judge version — started
> `2026-08-31 21:30:17.101`, **53 seconds after** the capped worker booted at `21:29:24.605Z`.
> Progress at `21:37Z`: **30 runs launched, 9 completed, 1 running, 20 pending**;
> `rawAgreement`, `kappa` and `finishedAt` are all still NULL and `verdictCount` is `0`, because
> scoring happens at the end. **Exactly one judgment in flight is the cap working.**
>
> **This block is a deliberate placeholder. Do not fill it in by guessing, and do not assume the
> re-run will simply reproduce 0.8462 over 30 items.** The four items the first run never saw are
> not a random sample — they are the four that happened to queue behind others — and the sequential
> run also changes the latency distribution the first was measured under. That second change is the
> point: with no in-server queue, `latencyMs` finally means generation time.
>
> ```
> ┌─────────────────────────────────────────────────────────────────┐
> │  RE-RUN RESULT: not yet recorded.                               │
> │  When it lands, record accuracy WITH its denominator, kappa      │
> │  with its variant + weighting, and the calibrationRunId.         │
> └─────────────────────────────────────────────────────────────────┘
> ```

**One inconsistency worth knowing before you query this yourself.** Five `EvaluationRun` rows carry
`status = 'error'` while only **four** `ModelJudgment` rows do. Run
`a0983c08-4548-4663-a40d-0cd56b82f765` is stamped `error` at run grain, but its judgment
**completed** on attempt 6 with `verdict = B` and `latencyMs = 108646`. Scoring reads the *judgment*
status, so that item is inside the 26 — the run-grain status is what is stale. Count judgments, not
runs.

### Running one, end to end

**In the cluster** — the only place that can reach both the production database and a judge
endpoint (a workstation has no route to `judge-arena-pg-rw.tenant-public`). Both entrypoints are
bundled into the image by `Dockerfile` (esbuild, because the runner ships no TypeScript toolchain):

```sh
# 1. Register the judge (creates JudgeModel + JudgeModelVersion + ModelEndpoint through the
#    same createCustomJudgeModel chokepoint POST /api/models uses, so it gets an audit row).
node /app/add-judge.js --name="Qwen3.6-35B-A3B" --backend=llamacpp \
  --base-model="Qwen3.6-35B-A3B-UD-Q3_K_XL.gguf" \
  --endpoint="http://<host>:8001/v1" \
  [--max-tokens=8192] [--temperature=0.3] [--protocol=pairwise] [--dry-run]

# 2. Run and score the calibration. THIS FREEZES THE GOLDEN SET — see below.
node /app/calibration-run.js --golden-set=<goldenSetId> --judge-version=<judgeModelVersionId>

# Re-score an existing run without launching anything (idempotent — every field is a full
# overwrite recomputed from the source rows, nothing increments):
node /app/calibration-run.js --score-only=<calibrationRunId>
```

**Locally**, the same script is `npm run calibration:run -- --golden-set=<id> --judge-version=<id>`.
`--poll-timeout=<seconds>` (default 3600) bounds the wait while the worker drains the queue.

Use `--dry-run` on `add-judge.js` first if you are unsure of the served model id or the `/v1` suffix:
those are the fields that are easiest to mistype and they fail **late**, at judgment time, after a
run has already been launched.

### THE GOLDEN SET IS FROZEN IRREVERSIBLY BY THE FIRST CALIBRATION

There is no `frozenAt` column and there is no unfreeze verb anywhere in the product.
`isGoldenSetFrozen` is defined as `calibrationRun.count({ where: { goldenSetId } }) > 0`
(`src/lib/golden-sets.ts:266-272`), so **the moment the `CalibrationRun` header is committed**, that
set's items, candidates, `protocol` and `expected` are read-only forever. Deleting the calibration
is not a thing anyone can do (`EvaluationRun.calibrationRunId` is `onDelete: Restrict`), and
`retiredAt`/`tombstonedAt` do not release it either. The only way to change a frozen set's content
is `POST /api/golden-sets/[id]/fork`, which makes a new set at version+1.

Because that write is irreversible, `launchCalibrationRun` checks **everything knowable without
touching an item** before writing the header — the set exists, is not tombstoned, is pairwise, has
at least one live item and no more than `MAX_CALIBRATION_ITEMS`; the project and rubric exist; a
pairwise `PromptTemplate` exists; and the caller owns an active, verified `ModelEndpoint` for the
judge version. Each of those would otherwise surface as a per-item failure discovered *after* the
freeze: a golden set pinned forever by a calibration in which all 30 items failed for one reason
that was knowable before any of them ran. `result.frozeGoldenSet` tells a caller whether **this**
call was the one that froze it.

### What is captured, and two honest gaps

`ModelJudgment` now stores what the model was given and what it thought:
`systemPrompt`, `userPrompt`, `userPromptSha256`, `promptTruncated`, `rawResponse`, `reasoning`,
`reasoningContent`, `reasoningSource`, `reasoningTokens`.

**The rendered prompt is STORED, not reconstructed, and that is not redundancy.** `PATCH
/api/rubrics/[id]` `deleteMany`s a rubric's criteria and recreates them on the **same rubric id with
no version bump** (verified), and the pairwise system prompt embeds those criteria verbatim — so
re-rendering a historical judgment from `promptTemplateId` + the item silently produces **today's**
rubric, with nothing anywhere recording that it moved. `userPrompt` is capped at 32 KiB, backed off
to a UTF-8 character boundary so the stored copy cannot end in a `U+FFFD`; `userPromptSha256` is
taken over the **full, pre-cap** text, so a capped copy still identifies the exact bytes the model
saw, and `promptTruncated` says which it is. `reasoningContent` is deliberately **not** merged into
`reasoning`, which is already triple-booked (parsed pointwise rationale, parsed pairwise rationale,
and the entire generated answer in respond mode); merging two channels that carry different content
is unrecoverable once written.

Two fields are null on this data, and both are gaps rather than bugs. **CORRECTION (2026-09-01):**
"gaps rather than bugs" was written when both were treated as by-construction; only the first still
is. The `parseMode` row below describes the pre-2026-09-01 state, and its note says what changed:

| Field | State on all 30 judgments | Why |
|---|---|---|
| `reasoningTokens` | **NULL, 30/30** | Read from `usage.completion_tokens_details.reasoning_tokens` (`src/lib/llm/openai-compatible.ts`). llama.cpp does not emit `completion_tokens_details` in its usage payload at all, so there is nothing to read. It is not dropped on the floor — it was never sent. **CORRECTION (2026-09-01):** this row read as a llama.cpp-only gap. Ollama sends nothing either (NULL on every granite run) and the Anthropic adapter never sets the field, so it is NULL on **every** backend this fleet runs. Decision: keep the column (it is a real measurement wherever the split is emitted), never default it to 0, and stop counting it as a capture failure — the calibration report now labels it usage-reported and instead prints `reasoningContent` length (n / mean / max chars) **for the completed rows and the error rows as two separate lines**. That contrast is what §5.2 of the 2026-09-01 handoff read to identify the repetition loop (failed mean 44,287 vs completed 13,138); a pooled figure over the same run is 18,330 and identifies nothing. |
| `parseMode` | **NULL, 30/30** (on rows written before 2026-09-01) | The pairwise path has **one** parse path. `tryParsePairwiseJudgment` is already fence-tolerant, so — this row used to say — there is no strict-then-lenient demotion and therefore no `parseMode` to persist; the column was meaningful only pointwise. **CORRECTION (2026-09-01):** the demotion *is* observable inside that one path, and pairwise now records it: `'structured'` = a schema was attached to the request (llamacpp/ollama/vllm) **and** the text needed no repair (no fence stripped, no verdict normalisation); `'fallback'` otherwise, including every Anthropic/openai/openrouter pairwise call. Pairwise `'structured'` is weaker than pointwise `'structured'` (extra keys are ignored) — see the schema comment before grouping across protocols. Existing pairwise rows stay NULL (= pre-change, not "fallback"); no backfill. The line reference this row carried (`registry.ts:1005-1007`) was stale; the rule lives in `executePairwiseCall`'s doc comment, cited by symbol. |

`reasoningSource` is `reasoning_content` on all 30 — the extraction order is fixed and recorded
rather than guessed, so a future judge that answers on a different key is distinguishable in the
data instead of silently equivalent. Note also that `systemPrompt` is non-null on **26** of 30: the
four timeouts are transport-level failures with no provider response to carry, so there was nothing
to capture.

> **Storage footprint — deliberately not stated here.** N judges × M items × every re-run, each
> carrying uncapped model text, is the heaviest data this product will hold, and Postgres here is
> `instances: 1` on a single node. The measured per-row cost and the extrapolation to "hundreds of
> models" are being produced as a separate, dedicated measurement; **no figures are recorded in this
> README until they have been verified.** Do not fill this in from memory or from a per-row average
> read off one run.

### Truncation is now a HARD FAILURE

`registry.ts`'s `execute()` refuses to hand a truncated or empty response to a parser at all. One
chokepoint, called immediately after the backend call and **before any parse**, so pointwise,
pairwise and respond all inherit it (`assertUsableContent` in `src/lib/llm/registry.ts`).
`finish_reason: 'length'` (OpenAI-compatible) or `stop_reason: 'max_tokens'` (Anthropic), or an
empty content channel, throws `ProviderError` with `kind: 'non_retryable'`.

**Non-retryable, both cases**, because the token budget is a property of the *request*, not of
provider health: the identical call truncates identically every time, so classifying it retryable
would burn the 3-attempt budget, DLQ the judgment, and count three failures against a circuit
breaker shared with every healthy call on the same endpoint+model.

**What each path did before this, which is why it is worth a section:**

- **Respond mode persisted a truncated answer as `status: 'completed'`.** A generation chopped in
  half — or empty outright — was indistinguishable in the corpus from a finished one. That is the
  failure this rule exists to prevent.
- **Pointwise misclassified it as retryable.** Truncated text reached the parser, whose `JSON.parse`
  guard throws a plain `Error`, and `classify()` has no structural signal for that (no `.status`,
  not an abort, no node `code`), so it fell through to the `retryable` default.
- **Pairwise failed loudly, but only by luck** — the truncated text happened to carry no parseable
  verdict.

It **fails on `'length'` unconditionally, even when the content happens to parse**: a model cut off
mid-reasoning is not a completed judgment for a calibration corpus, however well-formed the prefix
it managed to emit. The error message carries every number needed to size the fix (`max_tokens`,
`completion_tokens`, `reasoning_tokens`, surviving content length) and then **says which of two
things happened**. `src/lib/llm/degeneration.ts` deflates each output channel over 8,000 characters
(reasoning always; content only for judgment calls) and, at a ratio of 5× or more, names the
output a **DEGENERATE REPETITION** loop — for which the advice is a repetition penalty, a different
temperature or a different judge, because a larger budget buys a longer loop. Otherwise the lever
is `samplingDefaults.max_tokens` on a **new ordinal** of the `JudgeModelVersion` (the field is a
provenance pin; it is never edited in place). The measure rides on the error as
`ProviderError.repetition`.

> **CORRECTION (2026-09-01).** This section used to end "names the lever —
> `samplingDefaults.max_tokens` on the `JudgeModelVersion`", and the message said exactly that,
> unconditionally. On calibration run 9 (granite4.2:3b) all five `'length'` failures were a
> repetition loop — 26k–56k reasoning characters deflating at 5.2–29× against 3.0–4.1× for the
> judgments that finished — and that advice would have made them worse. The distinction is now
> measured, not assumed.

**The one deliberate exemption** is `verify.ts`'s connection test, which sets no `mode`: it sends
`max_tokens: 1` on purpose and reads nothing but `servedModelId`, so a healthy provider answers it
with `finish_reason: 'length'` every single time. Guarding it would turn every "test connection"
click on a working endpoint into a truncation error.

A failure now also carries the response that caused it. `ProviderError.callResult` hands the
reasoning channel, the token split and the rendered prompt to `markJudgmentError`, so a judgment
that failed persists the evidence explaining **why** rather than only a message.

---

## Architecture

Regenerated from the actual tree at `14d75f7`, not from memory. **Counts re-verified at `1e7a427`
(2026-08-31)** and the rows A2.1 moved are marked; everything unmarked is unchanged since `14d75f7`.

```
judge-arena/
├── prisma/
│   ├── schema.prisma            # 29 models — see Data model below
│   ├── migrations/              # 19 migrations, latest 20260830120000_v2i_calibration_item_link
│   ├── seed.ts                  # thin entry: client lifecycle + exit code only
│   ├── seed-core.ts             # seedAll(client) — takes a client so DB tests can drive it
│   ├── seed-prompt-templates.ts # judge system-prompt templates
│   ├── seed-judgebench.ts       # JudgeBench dataset, reads data/judgebench.json at RUNTIME
│   ├── data/judgebench.json     # 2.8MB, deliberately not bundled into seed.js
│   └── v1/schema.v1.prisma      # frozen v1 schema, read-only, for the importer
├── src/
│   ├── app/                     # Next.js App Router — 18 pages, 49 API route files
│   │   ├── api/                 # see API reference
│   │   ├── dashboard/           # stats + quick actions
│   │   ├── datasets/            # list + [id] detail (samples, tombstones, revisions)
│   │   ├── evaluate/[id]/       # evaluation workspace + runs/[runId]/
│   │   ├── evaluations/         # evaluation list
│   │   ├── golden-sets/         # list, [id] detail (+ assignment panel), [id]/label studio
│   │   ├── login/               # credentials + "Sign in with Authentik"
│   │   ├── models/              # judge catalog + endpoint management
│   │   ├── projects/            # list, [id], [id]/dataset-runs/[groupKey]
│   │   ├── register/            # static invite-only notice (registration is retired)
│   │   ├── rubrics/             # rubric management with versioning
│   │   ├── settings/            # developer API keys, config import/export
│   │   ├── page.tsx             # `/` — the PUBLIC judge leaderboard landing page
│   │   ├── layout.tsx           # root layout, reads x-nonce for the theme script
│   │   ├── error.tsx not-found.tsx opengraph-image.tsx icon.svg
│   │   └── globals.css
│   ├── middleware.ts            # CSP (per-request nonce), security headers, correlation IDs
│   ├── components/
│   │   ├── auth/                # auth-provider
│   │   ├── evaluation/          # model-judgment-card, human-judgment-form, submission-viewer
│   │   ├── layout/              # app-shell, sidebar, header, keyboard-shortcuts-dialog
│   │   ├── models/              # model-config-form
│   │   ├── rubric/              # rubric-builder
│   │   ├── studio/              # StudioShell, Panel, ProgressionRail, SpanTextView, DeltaTextView
│   │   └── ui/                  # 14 primitives — button, card, dialog, tooltip, brand-icon, …
│   ├── lib/                     # 71 modules; the ones you will actually open:
│   │   ├── db.ts env.ts config.ts logger.ts crypto.ts audit.ts
│   │   ├── auth.ts auth-guard.ts oidc-user.ts permissions.ts account-deletion.ts
│   │   ├── calibration/         # launch.ts (freezes the set), score.ts, readings.ts  [A2.1]
│   │   ├── llm/                 # provider system — see below
│   │   ├── queue/               # connection.ts, publish.ts, topology.ts
│   │   ├── realtime/            # SSE bus: redis-bus, in-memory-bus, factory, ownership
│   │   ├── studio/              # content.ts, delta.ts, layout.ts
│   │   ├── golden-sets.ts golden-set-versions.ts labelling-queue.ts agreement.ts
│   │   ├── assignment-policy.ts label-readings.ts retest.ts
│   │   ├── sample-selection.ts  # first-N vs. server-side random subset (randomCount/randomPercent)
│   │   ├── tombstones.ts sample-revisions.ts dataset-versions.ts
│   │   └── run-launch.ts run-finalizer.ts run-mode.ts rubric-versions.ts
│   ├── worker/                  # main.ts, judgment-consumer, run-create-consumer,
│   │   │                        # claim, reaper, dispatch-failure, health
│   │   └── concurrency.ts       # the hard cap of 1 — read it before raising it  [A2.1]
│   └── types/
├── scripts/
│   ├── admin/create-user.ts     # invite CLI (+ create-user-entry.ts, the bundle entry)
│   ├── admin/add-judge.ts       # judge-registration CLI -> /app/add-judge.js  [A2.1]
│   ├── calibration/run.ts       # npm run calibration:run -> /app/calibration-run.js  [A2.1]
│   ├── importer/                # one-shot v1 -> v2 migration (cli, judges, runs, owners, …)
│   ├── datasets/fetch-judgebench.mjs
│   ├── controller.mjs           # npm run ctrl:* task runner
│   └── ci-local.sh              # runs the full CI gate locally
├── tests/                       # 106 test files: lib/, db/, integration/, importer/, admin/
├── docs/
│   ├── runbooks/                # authentik-oidc-setup, studio-manual-verification
│   ├── specs/ plans/            # under docs/superpowers/
│   └── research/
├── deploy/                      # nginx.conf, nginx-lb.conf, pg-init-test-db.sh (compose only)
├── Dockerfile                   # deps -> builder -> prisma-cli -> runner; bundles server.js,
│                                # worker.js, seed.js, add-judge.js, calibration-run.js
├── docker-compose.yml           # full local stack incl. nginx LB and a migrate service
├── worker.ts                    # root worker entry (re-export of src/worker/main.ts)
├── vitest.config.ts vitest.db.config.ts vitest.integration.config.ts
├── .gitea/workflows/ci.yml      # CANONICAL CI (Gitea)
├── .github/workflows/ci.yml     # mirror check: lint, tsc, unit, build — no DB/integration, no image
└── .env.example
```

The Helm chart, HelmRelease and cluster manifests are **not in this repo** — see
[Deployment](#deployment).

### Tech stack

| Layer | Technology |
|---|---|
| Framework | **Next.js 15.5** (App Router, standalone output), **React 18.3** |
| Language | **TypeScript 5.9** (`strict: true`), Node **≥ 22** |
| Database | **Prisma 6.19** + **PostgreSQL** (CloudNativePG in production, `postgres:16-alpine` locally) |
| Queue | **RabbitMQ** via `amqplib` 2 |
| Cache / limiter / bus | **Redis** via `redis` 5 |
| Auth | **NextAuth 4** — Authentik OIDC + a credentials provider; JWT sessions, no adapter |
| Styling | **Tailwind CSS 3.4**, custom `brand-*` / `surface-*` tokens, JetBrains Mono, `next-themes` |
| LLM SDKs | `@anthropic-ai/sdk` ^0.39, `openai` ^4.82 (the latter for every OpenAI-compatible backend) |
| Validation | **Zod** |
| Tests | **Vitest 3** — unit, DB and integration projects with separate configs and coverage gates |

---

## Data model

29 Prisma models (`grep -c '^model ' prisma/schema.prisma`). The eight-model domain the old README
described is now the *legacy* core; `ModelConfig` in particular is retired on the write path and kept
only for the importer's benefit. The ones that matter now:

**Judge identity chain** — how a judge becomes callable.

```
JudgeModel            identity + taxonomy: slug, judgeClass, scoringMechanism, baseModel,
   │                  paramsB, contextLength, trainingRecipe, license, retiredAt
   └── JudgeModelVersion   ordinal, weightsRevision, quantization, servingBackend, endpointClass
          └── ModelEndpoint    userId + endpoint URL + apiKeyEnc (AES-256-GCM), isActive,
                               verifiedAt / verificationError, archFingerprint
```

`JudgeModel` and `JudgeModelVersion` are **immutable once created**, and that is enforced by absence:
`grep -rn 'judgeModel\.update\|judgeModelVersion\.update' src/ prisma/ scripts/` returns **nothing**.
There are exactly three creation sites, and only one of them serves a request —
`src/lib/model-catalog.ts:102,112` (the request path, `create`), `prisma/seed-core.ts:168,181` (the
seeder, `upsert` with `update: {}`, so a re-seed cannot rewrite a catalog row) and
`scripts/importer/judges.ts:108,139` (the one-shot v1 importer). A user supplies their own key by
creating a `ModelEndpoint`; that is the BYOK story.

**Datasets**

```
Dataset ──── DatasetSample ──── SampleRevision      (edit log)
   └──────── Tombstone                              (overlay: soft-delete without a destructive write)
```

**Golden sets** — the human-labelling substrate.

```
GoldenSet                versioned (parentId/version), forkable, publishable, retirable;
   │                     owner, protocol, retestIntervalItems
   ├── GoldenItem ──┬── GoldenCandidate     (position-ordered options for pairwise/listwise)
   │                ├── GoldenLabel         (annotatorId, overallScore | preference, round,
   │                │                         criteriaScores, reasoning, tombstonedAt)
   │                └── GoldenItemRevision  (what changed, by whom; labels pin the revision they saw)
   └── GoldenAssignment     who was asked to annotate what. goldenItemId NULL = the whole set.
                            DELETE revokes (sets revokedAt) — it never removes the row.
```

**Runs and judgments**

```
Evaluation ─┬── EvaluationModelSelection   which JudgeModelVersions this evaluation runs
            └── EvaluationRun ─┬── RunCandidate       texts a pairwise/listwise run compares
                               ├── RunModelSelection  per-run snapshot of the selection
                               ├── ModelJudgment ──── PromptTemplate  (pinned by (name, version))
                               └── HumanJudgment      one per run — `runId` is @unique

                    EvaluationRun.goldenItemId ────────► GoldenItem       ] v2i, both NULLABLE
                    EvaluationRun.calibrationRunId ────► CalibrationRun   ] and both NULL on an
                                                                          ] ordinary run
                    @@unique(calibrationRunId, goldenItemId)   NULLS DISTINCT, deliberately

CalibrationRun    JudgeModelVersion x GoldenSet (+ rubricId) -> accuracy (in `rawAgreement`),
                  kappa + kappaVariant/kappaWeighting, verdictCount, thresholdMetric.
                  testRetest, positionBias, biasSensitivityRate, flipRateVsParent and
                  passed/passThreshold exist and are NULL — later phases, not lost writes.
```

> **UPDATE 2026-08-31 (v2i).** `CalibrationRun` used to sit in this diagram unattached to anything,
> which was an accurate drawing of a table nothing wrote. The two nullable columns above are the
> link, and **not a join table** — an `EvaluationRun` is already 1:1 with a golden item because a
> pairwise run holds exactly one candidate pair, and a join row would have carried a stored
> `preference`, which A0 decision #4 forbids (preference is *derived* from `(verdict, pairOrder)` at
> read time). See [Calibration](#calibration).

`EvaluationModelSelection` and `RunModelSelection` carry `judgeModelVersionId` **directly** now. The
`modelConfigId` column on both is legacy and is unconditionally `null` for anything the current write
path creates — no back-reference from a version to a `ModelConfig` exists or is derivable. Every
reader is null-guarded and prefers the `judgeModelVersion` join.

**Identity and audit** — `User` (email is *not* DB-unique; identity is
`@@unique([oidcIssuer, oidcSubject])`, with a partial unique index on email for credentials rows
only), `AuditLog`, `DeveloperApiKey` (the raw key is returned once, on creation, and never again).

Remaining legacy/support models: `Project`, `Rubric`, `RubricCriterion`, `ModelConfig`.

### Rubric versioning

```
Rubric (v1, parentId = null, id = "abc")
  ├── Rubric (v2, parentId = "abc")
  └── Rubric (v3, parentId = "abc")
```

`parentId` always points at the root. `POST /api/rubrics/[id]/versions` reads `MAX(version)` and
creates the next version **inside one transaction**, catching P2002 on `@@unique([parentId, version])`
and retrying up to 3 times — the un-transactioned version of this raced. Evaluations are pinned to a
version, so editing a rubric never alters past scores.

---

## LLM provider system

`src/lib/llm/`. The old "provider class per vendor" design is gone; the key space is now the
`ServingBackend` enum.

| File | Purpose |
|---|---|
| `registry.ts` | `ProviderDescriptor` registry keyed by `ServingBackend`. Owns `resolveApiKey()`, prompt rendering from a DB `PromptTemplate`, the timeout budget, and the single-attempt `execute()` primitive. |
| `index.ts` | `executeJudgment` / `executeRespond` — the resilience-wrapped entry points. |
| `provider.ts` | Prompt builders and the judgment response parser, incl. `tryParseStructuredJudgment`. |
| `judgment-schema.ts` | The JSON Schema handed to structured-output backends. |
| `render.ts` | Where the prompt rendering `registry.ts` "owns" actually lives: `renderJudgmentPrompt`, `renderJudgmentSystemPrompt`, `buildJudgmentUserPrompt`, `buildPairwiseUserPrompt`. `registry.ts` only wraps it (`renderJudgmentPromptOrThrow`) to convert a malformed template into a permanent config error. |
| `anthropic.ts` | The one backend with its own call function (Messages API). |
| `openai-compatible.ts` | The shared call path for `openai`, `openrouter`, `vllm`, `ollama`, `llamacpp`. |
| `backends/openrouter.ts` | Adds OpenRouter's `HTTP-Referer` / `X-Title` attribution headers. |
| `backends/vllm.ts` | Adds guided structured output: `response_format` **and** `guided_json`, both carrying the same schema. |
| `backends/llamacpp.ts` | llama.cpp specialisation. |
| `resilience.ts` / `errors.ts` / `breaker-redis.ts` | Taxonomy-driven retry and the Redis circuit breaker. |
| `verify.ts` | Backs `POST /api/models/[id]/verify` — endpoint-keyed, writes `verifiedAt` or `verificationError`. |

Two design decisions worth knowing before you touch this:

- **`prepare*Call` runs OUTSIDE the breaker; only `execute*Call` runs inside it.** `prepare*` only
  fails on permanent *configuration* problems (unset `baseModel`, unresolvable key, a malformed
  template). Before the split, one misconfigured `JudgeModelVersion` could trip the breaker for its
  whole `backend:endpoint:model` key with zero real requests sent, degrading every correctly
  configured call sharing it — including the other mode, since judge and respond share the key.
- **The breaker key is `servingBackend:endpoint:modelId`.** Without the endpoint segment a failing
  local Ollama would open the circuit for the real OpenAI API; without the model segment one bad
  model on OpenRouter would trip every other model routed through the same host.

`resolveApiKey()` will only fall back to an environment variable (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`) when the descriptor is a *known official host* **and** there is no custom endpoint
override. `kind: 'openai_compatible'` descriptors never get an env fallback at all — this is
regression-tested in `tests/lib/registry.test.ts`, and it is why `OPENROUTER_API_KEY` and
`VLLM_API_KEY` are documented as guidance rather than wired up.

### Judgment flow

Two launch paths, and it matters which one you are looking at (`src/lib/run-launch.ts`):

```
SINGLE RUN                                BULK DATASET LAUNCH
POST /api/evaluations/[id]/runs           POST /api/evaluations  (dataset batch)
  launchSingleRun                           launchBulkRunCreates
  │                                         │
  ├─ one $transaction: EvaluationRun        └─ publish run.create, one per evaluation
  │  + RunModelSelection + pending               │
  │  ModelJudgment rows (+ RunCandidate          └─ worker: run-create-consumer
  │  rows for pairwise)                               expands into EvaluationRun +
  │                                                   pending ModelJudgment rows, then
  └─ publish judgment.execute DIRECTLY,               publishes judgment.execute per row
     one per ModelJudgment                            (POINTWISE ONLY)

                          ↓  both converge on  ↓

worker: judgment-consumer
  ├─ claim the ModelJudgment row (status: running)
  ├─ resolveEndpoint — re-checks the acting user owns an active endpoint (defence in depth;
  │                    run-launch already checked at launch time)
  ├─ prepare*Call: resolve descriptor, baseModel, key, render the PromptTemplate
  ├─ breaker.allow() -> execute*Call -> withRetry
  ├─ parse: structured first, lenient fallback with parseMode: 'fallback'
  ├─ write ModelJudgment (completed | error), emit an SSE event
  └─ ack | nack -> judgment.retry.30s | judgment.retry.5m | judge.dlq

run-finalizer: all judgments terminal + >=1 completed -> needs_human (then a guarded
               needs_human -> completed once a human signs off); none completed -> error
```

The transaction always ends **before** any publish: holding a DB connection across N round trips to
RabbitMQ would be bad enough, but a publish failure would also roll back rows whose messages the
broker may already have accepted. If a publish fails, the run is compensated to `status: 'error'`
rather than left `pending` with no worker ever coming for it.

---

## API reference

49 route files under `src/app/api/` (`find src/app/api -name route.ts | wc -l`), in 13 groups
(`ls src/app/api | wc -l`). The per-group counts below sum to 49. Every mutating route goes through
`requireAuth()`, which is also the rate-limit chokepoint.

The `Methods` column is the set of HTTP verbs each `route.ts` actually exports, not the set it looks
like it should export — several routes are deliberately asymmetric (`/api/datasets/[id]/samples` has
no `GET`; `/api/golden-sets/[id]/items` has no `POST`).

### Golden sets (11)
| Methods | Route | Description |
|---|---|---|
| `GET` `POST` | `/api/golden-sets` | List / create. Creation *imports* items from one platform-curated `Dataset`; the selection is one of `sampleIndices`, `limit`, `randomCount` or `randomPercent` (`src/app/api/golden-sets/shared.ts:151-160`), and the random draw is resolved **server-side** from the indices that actually exist, because `DatasetSample.index` is not dense |
| `GET` `PATCH` `DELETE` | `/api/golden-sets/[id]` | Detail / update / tombstone |
| `GET` `PATCH` `DELETE` | `/api/golden-sets/[id]/items` | Items, incl. tombstoning |
| `GET` | `/api/golden-sets/[id]/items/[itemId]/history` | Revision log for one item |
| `POST` | `/api/golden-sets/[id]/items/[itemId]/labels` | Submit a label (pins the revision seen) |
| `GET` | `/api/golden-sets/[id]/queue` | The annotation queue served to the studio |
| `GET` `POST` `DELETE` | `/api/golden-sets/[id]/assignments` | Assign / revoke. Owner projected as `{id,name}` — never the email, `null` for a deleted account |
| `GET` | `/api/golden-sets/[id]/agreement` | Inter-annotator agreement |
| `GET` | `/api/golden-sets/[id]/disagreements` | Items annotators disagree on |
| `POST` | `/api/golden-sets/[id]/fork` | Fork into a new version |
| `POST` | `/api/golden-sets/[id]/retire` | Retire (out of circulation, not deleted) |

> **Missing surface, not a bug:** `GET /api/golden-sets/[id]/agreement` works, but **nothing in
> `src/app/**` or `src/components/**` calls it.** The only "Agreement" in the UI is a hard-coded,
> permanently-empty progression-rail stage at `src/app/golden-sets/[id]/label/page.tsx:87`. To read
> agreement today, navigate a signed-in tab straight to the endpoint and read the JSON.

> **Annotator-facing gap in the studio (verified on production 2026-08-29):** every `GoldenCandidate`
> has `label IS NULL` — `toCandidate()` (`src/lib/golden-sets.ts:179-181`) hard-codes it. The studio
> renders `candidate.label ?? 'Option ' + (position+1)`, so the screen says "Option 1"/"Option 2"
> while the verdict control asks for `A>B` / `tie` / `B>A`. The mapping *is* deterministic in code
> (`toCandidate(0, responseA)`, `toCandidate(1, responseB)`, queue orders by `position asc`) but
> nothing on screen says so, and guessing the other way silently inverts every preference.

### Datasets (10)
| Methods | Route | Description |
|---|---|---|
| `GET` `POST` | `/api/datasets` | List / create |
| `GET` `PATCH` `DELETE` | `/api/datasets/[id]` | Detail / update / tombstone. The `GET` embeds `samples: { take: 100 }` — it is a preview, not a way to read a 620-row corpus |
| `POST` `PUT` `PATCH` `DELETE` | `/api/datasets/[id]/samples` | Sample add / replace / edit / tombstone. **No `GET`** — samples come back on `GET /api/datasets/[id]` |
| `GET` | `/api/datasets/[id]/samples/[sampleId]/revisions` | Per-sample revision log |
| `POST` | `/api/datasets/[id]/samples/[sampleId]/restore` | Untombstone |
| `GET` `POST` | `/api/datasets/[id]/versions` | Dataset versions |
| `POST` | `/api/datasets/[id]/refresh` | Re-pull from source |
| `GET` | `/api/datasets/[id]/export` | Export |
| `GET` | `/api/datasets/huggingface/preview` | HF dataset preview |
| `GET` | `/api/datasets/huggingface/rows` | HF row fetch |

### Evaluations and runs (8)
| Methods | Route | Description |
|---|---|---|
| `GET` `POST` | `/api/evaluations` | List (`?projectId=`) / create. The dataset-batch form is the one path that publishes `run.create` (`launchBulkRunCreates`) |
| `GET` `PATCH` `DELETE` | `/api/evaluations/[id]` | Detail / update / delete |
| `GET` `POST` | `/api/evaluations/[id]/runs` | List runs / launch **one** run. `POST` calls `launchSingleRun` and publishes `judgment.execute` **directly**, one per `ModelJudgment` — it does *not* go through `run.create`. `run.create` is the bulk path, and only `POST /api/evaluations` takes it. See [Judgment flow](#judgment-flow) |
| `GET` | `/api/evaluations/[id]/runs/[runId]` | Run detail with judgments |
| `POST` | `/api/evaluations/[id]/runs/[runId]/human-judgment` | Upsert human judgment on a run |
| `POST` | `/api/evaluations/[id]/judge` | Legacy single-shot judging trigger |
| `POST` | `/api/evaluations/[id]/human-judgment` | Legacy human judgment upsert |
| `GET` | `/api/evaluations/export` | Export |

### Models (4)
| Methods | Route | Description |
|---|---|---|
| `GET` `POST` | `/api/models` | List endpoints / attach an endpoint (`mode: 'catalog'`) or create a custom judge (`mode: 'custom'`) |
| `GET` | `/api/models/catalog` | Browse the shared judge catalog |
| `GET` `PATCH` `DELETE` | `/api/models/[id]` | Endpoint detail / update / delete. Keys are never returned |
| `POST` | `/api/models/[id]/verify` | Live-probe the endpoint; writes `verifiedAt` or `verificationError` |

### Projects (3), Rubrics (3)
| Methods | Route |
|---|---|
| `GET` `POST` | `/api/projects` |
| `GET` `PATCH` `DELETE` | `/api/projects/[id]` |
| `GET` | `/api/projects/[id]/export` |
| `GET` `POST` | `/api/rubrics` |
| `GET` `PATCH` `DELETE` | `/api/rubrics/[id]` |
| `GET` `POST` | `/api/rubrics/[id]/versions` |

### Developer API keys (3), config (2), platform (5)
| Methods | Route | Description |
|---|---|---|
| `GET` `POST` | `/api/api-keys` | List / mint a `DeveloperApiKey` (plaintext shown once) |
| `GET` `PATCH` `DELETE` | `/api/api-keys/[id]` | Detail / update / revoke |
| `GET` | `/api/api-keys/scopes` | Available scopes |
| `GET` | `/api/config/export` | Export judges, rubrics and settings as YAML/JSON |
| `POST` | `/api/config/import` | Import the same, creating catalog entries through `model-catalog.ts` |
| `GET` | `/api/stats` | Dashboard counters — projects, evaluations, active endpoints, rubrics, visible datasets, queue depth |
| `GET` | `/api/leaderboard` | Judge leaderboard |
| `GET` | `/api/events` | SSE stream (run/judgment progress) |
| `GET` | `/api/health` | DB + Redis + RabbitMQ probe. 200 healthy / 503 degraded, unauthenticated, details redacted in production |
| `GET` `POST` | `/api/auth/[...nextauth]` | NextAuth handler (`export { handler as GET, handler as POST }`) |

---

## UI components

All 14 primitives in `src/components/ui/` are self-contained React + Tailwind, no external UI
dependency:

| Component | Key features |
|---|---|
| `Button` | 5 variants (primary, secondary, outline, ghost, danger), 4 sizes, loading spinner |
| `Card` | Compound (Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter) |
| `Dialog` | Focus trap, escape-to-close, backdrop click, 4 sizes |
| `Tabs` | Context-based compound component |
| `Tooltip` | Pure-CSS hover tooltip with arrow, 4 sides; `TooltipIcon` renders a `?` badge |
| `Select` `Input` `Textarea` | Native controls with label / error / hint / a11y wiring |
| `Slider` | Range input with gradient track |
| `Badge` | 6 variants |
| `Skeleton` | Pulse loading placeholder |
| `EmptyState` | Icon + title + description + action |
| `Kbd` | Keyboard shortcut badge |
| `BrandIcon` | The mark. Imported by `/login`, `/register`, the public landing page and `layout/sidebar.tsx` (`grep -rn BrandIcon src/`). **Not** by `opengraph-image.tsx` — that runs on the edge runtime and draws its own mark inline, so the two can drift |

Domain components live in `src/components/studio/` (`StudioShell`, `Panel`, `ProgressionRail`,
`SpanTextView`, `DeltaTextView`), `evaluation/`, `rubric/`, `models/`, `layout/` and `auth/`.

---

## Keyboard shortcuts

Verified against the handlers, not against the shortcut sheet. There are two kinds and both are in
the table below: three global listeners
(`grep -rn "addEventListener('keydown'" src/` → `ui/dialog.tsx`, `evaluation/human-judgment-form.tsx`,
`layout/app-shell.tsx`) plus React `onKeyDown` props bound to individual fields, which that grep does
not find — `grep -n onKeyDown src/app/datasets/page.tsx` is where the last row comes from.

| Shortcut | Action | Registered in |
|---|---|---|
| `?` | Open the shortcuts dialog | `app-shell.tsx` (global) |
| `Esc` | Close dialog / cancel a chord | `app-shell.tsx`, `ui/dialog.tsx` |
| `G` then `D` | Dashboard | `app-shell.tsx` |
| `G` then `P` | Projects | `app-shell.tsx` |
| `G` then `R` | Rubrics | `app-shell.tsx` |
| `G` then `S` | Datasets | `app-shell.tsx` |
| `G` then `G` | Golden sets | `app-shell.tsx` |
| `G` then `M` | Models | `app-shell.tsx` |
| `G` then `E` | Evaluations | `app-shell.tsx` |
| `G` then `L` | Public leaderboard (`/`) | `app-shell.tsx` |
| `1`–`9`, `0` | Set human score 1–9, 10 | `evaluation/human-judgment-form.tsx`, judge mode only |
| `Ctrl`/`Cmd` + `Enter` | In the inline sample editor: collapse this sample and open the next, appending a new one if you were on the last. It does **not** submit | `app/datasets/page.tsx:1174,1202` — inline `onKeyDown` on the two textareas |

Chords time out after 1.2s (`app-shell.tsx:45-48`, `window.setTimeout(..., 1200)`). The focus guard is
close to uniform but not quite, and the exceptions are deliberate:

- `app-shell.tsx:55-59` computes `isInput` from `INPUT` / `TEXTAREA` / `SELECT` / `isContentEditable`
  and gates `?` and every `G`-chord on it (`:74`).
- `Esc` is checked at `:67`, **above** that gate, so it still fires while you are typing — which is
  the point: it is the escape hatch.
- The `1`–`9`/`0` handler (`human-judgment-form.tsx:109-115`) checks `INPUT`/`TEXTAREA`/`SELECT` only.
  It does **not** check `contenteditable`; there is no contenteditable on that page today, so this is
  a latent gap rather than a live bug.

**`Ctrl+N` and `Ctrl+E` do not exist** — the old README listed them, but `app-shell.tsx:74` returns
early on any `ctrlKey`/`metaKey`/`altKey` press and no page registers either. (The `Ctrl`/`Cmd`+`Enter`
row above is not a counter-example: it is a field-scoped `onKeyDown` on two textareas in the datasets
sample editor, not a global chord, which is why the global guard never sees it.) The shortcuts dialog
(`keyboard-shortcuts-dialog.tsx`) also still advertises `←`, `→` and `J` for the evaluation page;
**no handler implements those either.** The dialog is stale in the same direction this README was.

---

## Getting started

### Prerequisites

- **Node.js ≥ 22** (`engines.node` in `package.json`; the image is `node:22-alpine`)
- **PostgreSQL**, **Redis** and **RabbitMQ**. `docker-compose.yml` brings up all three
  (`postgres:16-alpine`, `redis:7-alpine`, `rabbitmq:3.13-management-alpine`) plus the app, worker,
  a migrate service and an nginx LB. Podman works; the CI gate is normally run against podman
  locally.
- At least one judge credential (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, an OpenRouter key, or a
  reachable vLLM/Ollama/llama.cpp endpoint).

### Quick start

```bash
git clone <repo-url> judge-arena && cd judge-arena
npm install

cp .env.example .env
# Required: DATABASE_URL, NEXTAUTH_SECRET, ENCRYPTION_KEY (openssl rand -hex 32).
# REDIS_URL and RABBITMQ_URL default to localhost outside production, but the
# rate limiter, the queue and /api/health all need them actually running.

npx prisma migrate deploy     # apply the 19 migrations
npx prisma generate
npx tsx prisma/seed.ts        # prompt templates, rubric, judge catalog, leaderboard project,
                              # LiveCodeBench (metadata) + JudgeBench (620 samples)

npm run dev                   # http://localhost:3000
npm run worker                # in a second terminal — nothing judges without this
```

`npm run setup` exists and does `install → generate → db push → seed`. Prefer `migrate deploy` over
`db push` for anything that has to match production: `db push` diffs the schema directly and leaves
`_prisma_migrations` empty, so the database it produces is not the database the chart's hook Job
produces.

There is no self-service sign-up. Create the first account with:

```bash
npx tsx scripts/admin/create-user.ts --email=you@example.com --admin --password=<pw>
```

Omit `--password` to mint an OIDC invite instead (see [Authentication](#authentication-and-accounts)).

### Pointing at a local model

Configure it as a `ModelEndpoint`, not an env var. Models → Add Model → custom, pick the serving
backend (`ollama`, `vllm`, `llamacpp`, `openrouter`, …), set the endpoint URL and paste the key.
`VLLM_BASE_URL` supplies a default base URL for `vllm` only; an endpoint's own URL always overrides
it.

### npm scripts

| Script | Description |
|---|---|
| `npm run dev` | Next.js dev server |
| `npm run worker` | `tsx src/worker/main.ts` — the queue consumer |
| `npm run build` | `prisma generate && next build` (standalone output) |
| `npm start` | `node .next/standalone/server.js` — needs a prior build |
| `npm run lint` | ESLint over `src/ prisma/ scripts/ tests/` |
| `npm test` / `test:coverage` | Unit suite (Vitest) |
| `npm run test:db` / `test:db:coverage` | DB suite — resets the test DB from `.env.test`, then runs `vitest.db.config.ts` |
| `npm run test:integration` | Integration suite (needs Postgres + Redis + RabbitMQ) |
| `npm run db:migrate` | `prisma migrate dev` |
| `npm run db:seed` / `db:reseed` | Seed / force-reset + seed |
| `npm run db:studio` | Prisma Studio |
| `npm run admin:create-user` | The invite CLI |
| `npm run calibration:run` | Score a judge against a golden set — `-- --golden-set=<id> --judge-version=<id>`, or `-- --score-only=<calibrationRunId>` to re-score without launching. **Launching freezes the golden set irreversibly.** See [Calibration](#calibration) |
| `npm run import:v1` | One-shot v1 → v2 importer (`db:generate:v1`, `db:push:v1` support it) |
| `npm run ctrl:*` | `scripts/controller.mjs` task runner — `generate`, `seed`, `db`, `full-reset-build` |

---

## Tests and CI

`.gitea/workflows/ci.yml` is canonical. `.github/workflows/ci.yml` is the mirror status check and
runs four steps — `npm run lint`, `npx tsc --noEmit`, `npm test` (unit only) and `npm run build`
(its job is literally named "Lint, typecheck, unit tests, build"). What it does **not** run is the
DB suite, the integration suite, the coverage gates or the image build, so a green tick on GitHub is
not the release gate; that is Gitea's. Unlike the Gitea runner it may use `actions/*` steps, because
GitHub-hosted runners ship Node.

The Gitea runner is `act_runner` in **host mode** with no container engine, so there
are no `uses: actions/*` steps and no Docker `services:` block anywhere — the DB and integration
suites run in a single ephemeral Kubernetes Job in `tenant-builds` whose pod carries
postgres/redis/rabbitmq as native sidecars.

`scripts/ci-local.sh` runs the same gate locally. Counts at merge commit `14d75f7` (2026-08-29), run
against podman Postgres/Redis/RabbitMQ:

| Gate | Result |
|---|---|
| `lint` | 0 |
| `tsc --noEmit` | 0 |
| unit | **594 passed / 43 files** |
| db | **641 passed / 42 files** |
| integration | **80 passed / 10 files** |
| coverage gates (unit + db) | both 0 |
| `next build` | 0 |

The previous recorded baseline, at `bee1d12`, was 578 / 633 / 80. Note that all three `step` banners
inside `scripts/ci-local.sh` are stale — `grep -n expect scripts/ci-local.sh` gives "expect 361
passed" (unit), "expect 281 passed" (db) and "expect 73 passed" (integration), none of which is the
current number. They are echoed strings, not assertions; the suites' own exit codes are the gate.

Coverage thresholds are per-directory (`vitest.config.ts`), deliberately uneven, and ratcheted rather
than aspirational — read the comments there before raising or lowering one.

---

## License

MIT
