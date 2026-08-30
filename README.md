# Judge Arena

A **meta-evaluation studio for LLM judges**. Register judge models in a catalog, run them over
datasets through a queue-backed worker, build human-labelled *golden sets*, and calibrate judges
against those labels — inter-annotator agreement, test-retest, position bias.

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
| **Calibration** | `CalibrationRun` stores kappa (Cohen/Fleiss, linear/quadratic), raw agreement, test-retest, position bias, flip-rate vs. the parent set, and a pass/threshold decision. |
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

18 migrations, latest `20260818120000_v2h_human_verification` (verified against production
`_prisma_migrations` on 2026-08-29: 18 applied, 0 unfinished).

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
  top level as a stable build/deploy target. It asserts topology, sets prefetch
  (`EVALUATION_MODEL_CONCURRENCY_PER_RUN * 4`), starts the `judgment.execute` and `run.create`
  consumers on the shared confirm channel, runs the reaper, and serves health on
  `WORKER_HEALTH_PORT` (default 9090). SIGTERM cancels consumers, drains in-flight handlers with a
  30s bound, then closes cleanly. Local: `npm run worker`.
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

---

## Architecture

Regenerated from the actual tree at `14d75f7`, not from memory.

```
judge-arena/
├── prisma/
│   ├── schema.prisma            # 29 models — see Data model below
│   ├── migrations/              # 18 migrations, latest 20260818120000_v2h_human_verification
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
│   ├── lib/                     # ~68 modules; the ones you will actually open:
│   │   ├── db.ts env.ts config.ts logger.ts crypto.ts audit.ts
│   │   ├── auth.ts auth-guard.ts oidc-user.ts permissions.ts account-deletion.ts
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
│   │   │                        # claim, reaper, dispatch-failure
│   └── types/
├── scripts/
│   ├── admin/create-user.ts     # invite CLI (+ create-user-entry.ts, the bundle entry)
│   ├── importer/                # one-shot v1 -> v2 migration (cli, judges, runs, owners, …)
│   ├── datasets/fetch-judgebench.mjs
│   ├── controller.mjs           # npm run ctrl:* task runner
│   └── ci-local.sh              # runs the full CI gate locally
├── tests/                       # 95 test files: lib/, db/, integration/, importer/, admin/
├── docs/
│   ├── runbooks/                # authentik-oidc-setup, studio-manual-verification
│   ├── specs/ plans/            # under docs/superpowers/
│   └── research/
├── deploy/                      # nginx.conf, nginx-lb.conf, pg-init-test-db.sh (compose only)
├── Dockerfile                   # deps -> builder -> prisma-cli -> runner; server.js + worker.js
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

CalibrationRun    JudgeModelVersion x GoldenSet -> kappa, rawAgreement, testRetest,
                  positionBias, biasSensitivityRate, flipRateVsParent, passed/passThreshold
```

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

npx prisma migrate deploy     # apply the 18 migrations
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
