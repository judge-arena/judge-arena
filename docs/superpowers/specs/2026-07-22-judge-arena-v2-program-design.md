# Judge Arena v2 — Program Design

**Date:** 2026-07-22
**Status:** Approved (program level); each phase gets its own spec → plan → implementation cycle
**Owner:** Trijeet

---

## 1. Context & current state

Judge Arena is a self-hostable LLM-as-a-Judge data-labelling studio: submit text
artifacts or dataset samples, grade them in parallel with multiple LLM judges
against versioned rubrics, then layer human judgment on top. Live at
**judgearena.com** on Railway (Cloudflare-fronted, healthy, ~99 days uptime),
deployed from GitHub org repo `judge-arena/judge-arena` via GH Actions.

- **Stack:** Next.js 14 (App Router) · TypeScript strict · Prisma 6 → PostgreSQL
  · NextAuth (credentials, open registration) · Tailwind · hand-built UI primitives.
- **Scale of implementation:** 36 API routes, ~15 Prisma models, SSE realtime
  (in-memory bus + optional Redis adapter), datasets w/ HuggingFace import,
  developer API keys, audit log, circuit-breaker resilience layer.
- **History:** 53 commits 2026-02-28 → 2026-04-08 (+4 deploy fixes 2026-04-13);
  dormant since. All feature branches merged; `REVIEW_FINDINGS.md` shows 28/28
  CRITICAL→MEDIUM issues fixed, 6 LOW + 5 features deferred.
- **Known debt:** README documents the early SQLite/no-auth vision, not reality;
  CI is GitHub-Actions-only (GitLab copy stale, will be retired); provider layer
  knows only `anthropic | openai | local`; judge identity is a bare `modelId`
  string with no architecture/revision/quantization capture.

## 2. Goals

1. **Migrate** judgearena.com off Railway onto the homelab cluster (GitOps,
   CNPG, tenant-public ingress, Velero, monitoring) — Railway account closeable.
2. **Critique & harden the design** for vertical *and* horizontal scale:
   stateless web tier + queue-backed judge workers; no >1-replica correctness loss.
3. **Model the judge landscape properly:** a model-class taxonomy and versioning
   system grounded in the actual SOTA (judge quality is highly dependent on the
   underlying model and its architecture), so every judgment row carries full
   provenance.
4. **Meta-evaluate judges in-product:** golden sets, agreement metrics, bias
   probes — every judge model/version earns trust on evidence before use.

### Non-goals

- Open public registration / anonymous sign-up (community tool, invite-gated).
- GPU workloads on the k8s cluster (standing posture: GPU stays on Proxmox
  hosts; the cluster reaches judges over a network seam).
- Preserving Railway user accounts (selective export keeps research artifacts only).
- Multi-region / cloud scale-out. Horizontal scale means N replicas on this cluster.

## 3. Locked decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D1 | Audience | **Community tool** | Trijeet + invited collaborators; real multi-user isolation and quotas; public read-only leaderboard. Not an open product; not single-user. |
| D2 | Judge classes | **API + local open-weight** | Full research surface: frontier APIs *and* self-hosted generative judges / reward models / classifiers served from the GPU host (gharial, RTX 4000 SFF Ada, 20 GB) via vLLM/Ollama over a network seam. |
| D3 | Identity | **Hybrid** | Authentik OIDC (id.asethi.com) for humans, invite-gated via groups; NextAuth credentials provider retained as fallback/dev login. Open registration disabled. |
| D4 | Data migration | **Selective export** | Keep rubrics, model configs, datasets via the existing slug-based config export/import; keep evaluation runs / judgments / leaderboard history via a **new v1→v2 importer** (Phase 1 deliverable — the app exports runs as denormalized JSONL but has *no* import path for them today). Drop users/accounts; identity restarts on Authentik. |
| D5 | Repo & CI | **Gitea canonical, GitHub mirror** | Canonical dev moves to `tea.asethi.com/trij/judge-arena`; standard Gitea Actions → Kaniko → Harbor → Flux (StablePin) pipeline; push-mirror to the public GitHub org keeps the MIT-public presence. GitLab copy retired. |
| D6 | Judge testing | **In-product meta-eval harness** | Calibration is a product feature, not a notebook: golden sets, per-judge agreement (Cohen's κ + correlation), bias probes, judge-quality leaderboard dimension. |
| D7 | Sequencing | **Research → architecture → migrate** | Taxonomy/schema grounded in SOTA first; critique + schema fold into one v2 spec; the database migrates **once**, onto the corrected schema. Meta-eval harness ships as the first post-migration feature on tables that already exist. |

## 4. Program structure

Four phases. Each phase below states scope, deliverables, and its exit gate.
Phases 1–3 each get their own full spec (brainstorm → spec → Sonnet review gate
→ plan → implementation); this document governs the program.

### Phase R — Judge-model landscape research *(no code)*

Deep-research fan-out (multi-agent, adversarially verified, cited) producing
**`docs/research/2026-07-judge-model-inventory.md`**:

- **Taxonomy of judge classes** the schema must encode:
  (a) prompted frontier-API judges; (b) prompted open-weight generative judges;
  (c) fine-tuned judge LMs (Prometheus-2, SFR-Judge, Atla Selene, CompassJudger
  lineage and successors); (d) sequence-classifier reward models (RewardBench
  leaders); (e) generative reward models; (f) specialized judges (safety,
  factuality/hallucination).
- **Architecture-dependence findings:** generative scoring vs reward heads,
  reasoning/thinking modes, quantization effects on judge quality, calibration
  properties, protocol support (pointwise / pairwise / listwise / rubric).
- **Meta-eval benchmark survey:** RewardBench 2, JudgeBench, RM-Bench and
  successors — what each measures; which metrics Judge Arena adopts in-product.
- **Serving feasibility matrix** for the 20 GB RTX 4000 Ada: which open judges
  fit at fp16 vs quantized; vLLM vs Ollama trade-offs.
- **Inventory table:** model · class · architecture metadata · protocols ·
  VRAM · license · benchmark scores.

**Exit gate:** inventory doc reviewed by Trijeet; taxonomy fields signed off as
the input contract for the Phase 1 schema.

### Phase 1 — Architecture spec v2 (critique + schema + scale)

- **Full design critique** of the current codebase — multi-agent review across
  correctness, security follow-ups (remaining LOW items), and specifically
  **horizontal-scale blockers** already identified: in-process run queue
  (`evaluation-run-manager`), in-memory rate limiting, in-process
  circuit-breaker state (`resilience.ts` — one replica trips while others keep
  hammering a dead endpoint), in-memory SSE bus default, and CNPG
  connection-pool budget (N replicas × Prisma pool size vs pooler limits).
- **Schema v2**, grounded in Phase R taxonomy:
  - `JudgeModel` with architecture metadata and **immutable version pinning**
    (weights revision, quantization, serving backend, endpoint class);
  - judgment **protocol** as a first-class concept;
  - full provenance on every judgment: judge version × prompt-template version
    × rubric version;
  - meta-eval entities (GoldenSet, GoldenLabel, CalibrationRun,
    AgreementMetric) included now so the database migrates once (D7).
- **Scale-out design:** stateless web tier (HPA-ready) split from queue-backed
  judge workers; the existing Redis realtime-bus adapter becomes the mandatory
  default (load-tested, not redesigned); rate limiting and circuit-breaker
  state move to Redis; **job queue = RabbitMQ (AMQP)** — reusing the cluster's
  existing rabbitmq-cluster-operator `bus` pattern rather than an app-private
  queue (BullMQ/pg-boss rejected in favor of cluster-reusable infra; decided
  2026-07-24). Phase 1 codes against AMQP; instance placement (dedicated
  public-tier RabbitMQ CR vs CCNP to an existing bus) is a Phase 2 detail.
  Prerequisite: rework `docker-compose.yml` for `--scale app=N` (drop fixed
  `container_name`/host-port publish, add a dev LB) so the S4 demo is runnable.
- **v1→v2 import tooling** *(named deliverable, gates Phase 2)*: importer
  mapping the denormalized v1 evaluation export (JSONL, one row per judgment)
  into the v2 provenance schema; config import already exists for
  projects/rubrics/models/datasets.
- **Provider layer v2:** OpenRouter aggregator + local vLLM/Ollama seam to
  gharial; model verification captures an architecture fingerprint. The GPU
  seam's transport and auth (mTLS vs token, DNS name) are **decided in this
  spec**, before the seam client is built.
- **Auth v2:** Authentik OIDC + credentials fallback, invite-gated (D3).
  Shape **confirmed 2026-07-24**: **app-level OIDC** (NextAuth as OIDC client
  to Authentik), *not* ingress-level oauth2-proxy — dev API keys and the
  public read-only leaderboard must bypass any ingress gate. Access model
  principle: this is largely **public research data — default to open reads**
  (leaderboard, published datasets/rubrics); **writes and user-created or
  user-uploaded data are gated completely** (ownership + auth on every
  mutation and on private artifacts). The spec enumerates the public
  carve-outs from this principle. Retire or admin-gate `/api/auth/register`.
- README rewrite to match reality lands with this spec's implementation.
- Scope valve: if the spec grows unwieldy, split into **1a** (critique +
  schema + import tooling) and **1b** (scale-out + providers + auth) with
  separate review checkpoints.

**Exit gate:** Sonnet independent review of the spec, then Trijeet approval;
v2 implemented (schema, workers, providers, auth) with S2 + S4 demonstrable
locally via docker-compose before Phase 2 begins.

### Phase 2 — Cluster migration + cutover

- Repo: Gitea canonical + GitHub push-mirror + `homelab-bot` collaborator;
  standard CI (Gitea Actions → Kaniko → Harbor → Flux, StablePin); GitHub
  workflow retired from the canonical path.
- Deploy: tenant-public ingress via CF Tunnel; CNPG Postgres (with
  `policy.cozystack.io/allow-*` labels via inheritedMetadata); Cozystack Redis;
  NetworkPolicies + Cilium CCNP including **GPU-seam egress** to gharial;
  Velero backups; VictoriaMetrics scrape + alerts; runbook.
- Standing footgun checklist applied: `.svc.cozy.local` FQDNs, tenant-public
  ingress class, `proxy-buffer-size: 16k` on auth-url ingresses, SOPS
  `grep ENC\[` before commit, chart-version bump on template change.
- Data: selective export from Railway (config / dataset / evaluation export
  routes) → import into CNPG via the Phase 1 importer (D4). Post-import steps:
  re-enter and re-verify model API keys (exports carry no secrets), and
  pre-provision existing collaborators' Authentik accounts/groups **before**
  cutover so no live user loses access.
- Cutover runbook: write-freeze on Railway → final delta export → import →
  verify (row counts + provenance spot-checks) → repoint judgearena.com DNS at
  Cloudflare to the tunnel. **Soak: 7 days** (lowered from 14, 2026-07-24)
  with Railway kept deployed and warm; rollback = repoint DNS back to Railway.
  Railway decommissioned only after soak passes. Snapshot posture is **light**
  (little user data exists today): one export snapshot up front, then at
  program milestones and before any risky Railway-side change — not a fixed
  weekly cadence.

**Exit gate:** success criteria S1 + S4 verified (below); Railway closeable.

### Phase 3 — Meta-eval harness (first post-migration feature)

- Golden sets with human labels; calibration runs per judge+version; agreement
  metrics (Cohen's κ — the previously deferred F3 — plus rank correlation);
  bias probes (position, verbosity, self-preference); judge-quality leaderboard
  dimension. Feature work only — tables exist from Phase 1 (D7).

**Exit gate:** S3 verified; Sonnet review gate on the feature.

## 5. Success criteria

- **S1.** judgearena.com serves from the cluster; Railway account closeable.
- **S2.** Any judgment row can answer: *exactly which judge — which weights /
  revision / quantization / serving backend, which prompt template, which
  rubric version — produced this score?*
- **S3.** A new judge model (API or local) can be added, calibrated against a
  golden set, and trusted or rejected on evidence, in-product.
- **S4.** The app survives horizontal scale-out (≥2 web replicas, N workers)
  with no correctness loss: rate limits, SSE events, and run-queue semantics
  hold across replicas.

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Railway data model drifts from schema v2, complicating import | Selective export uses the app's *portable* export formats (slugs, not IDs); Phase 1 spec defines the import mapping explicitly. |
| 20 GB VRAM constrains which open judges are servable | Phase R feasibility matrix makes this explicit before schema/product promises; quantized variants are first-class in the versioning model, not a hack. |
| GPU seam couples cluster availability to a single Proxmox host | Judge workers treat local endpoints as degradable: circuit breaker already exists; local-judge outage degrades to API judges, never blocks the web tier. |
| Hybrid auth doubles the attack surface | Credentials provider is fallback-only: no open registration, admin-created accounts only, rate-limited; OIDC is the paved road. |
| In-product meta-eval scope creep | Phase 3 is gated to the metrics named in D6; anything further is a new spec. |
| Dormant deps (Next 14, Prisma 6, NextAuth 4) accrue CVEs during the program | Phase 1 critique includes a dependency audit; upgrades land with the v2 implementation, not ad hoc. |
| Coupled cutover: schema v2 + platform migration land in one step (accepted per D7) | Abort criteria are explicit: full production export must import and verify locally (row counts, provenance spot-checks) before cutover is scheduled; Railway stays warm through the 14-day soak; rollback is a DNS repoint. If local verification fails, cutover is blocked — not patched live. |
| Railway continuity risk over an unbounded program (billing/plan changes, forced migration) | Light snapshot posture (up-front + milestone exports — little user data today); Phases R+1 time-boxed to ~8 weeks to cutover-ready; any forced Railway exit falls back to serving the snapshot-restored app from the cluster early, accepting feature-freeze. |

## 7. Open questions (deferred to phase specs)

- RabbitMQ topology (queues/exchanges, retry/DLQ semantics for judge runs) —
  Phase 1 spec; instance placement (public-tier CR vs CCNP to existing bus) —
  Phase 2.
- Prompt-template versioning granularity (per-protocol? per-judge-family?) —
  Phase 1, informed by Phase R.
- Leaderboard anonymity/read-path caching once behind the tunnel — Phase 2.
- Which meta-eval benchmark items seed the first golden set — Phase 3,
  candidates from Phase R.
