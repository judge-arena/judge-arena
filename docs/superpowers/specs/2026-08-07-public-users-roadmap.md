# Roadmap: from one admin to real public users

**Date:** 2026-08-07 · **Status:** proposed, awaiting owner decisions
**Context:** Judge Arena went live in-cluster today (see the v2 program design and
`docs/runbooks/authentik-oidc-setup.md`). Exactly one account exists: the owner's.

Grounded in a six-area assessment plus three adversarial critiques, all verified
against the live code and cluster. Where a claim is unverified it says so.

---

## The honest shape of the gap

**No stranger can sign up today — and identity was not the biggest problem.**

The core feature had never worked. The RabbitMQ CR was sized `2Gi` against a
`disk_free_limit` watermark of 2.0GB, so a free-disk alarm raised at creation and
was unclearable by construction. RabbitMQ blocks publishers under a disk alarm:
all three nodes alarmed, both app connections in `blocking`, so no judgment could
be published and no evaluation could ever run. Fixed the same day (`size: 4Gi`,
divergence entry 56), verified: no alarms, connections `running`.

That defect is the reason Phase 0 exists and comes first. Everything downstream
had no meaningful exit gate while the product could not execute its one job.

Beyond that, roughly **8–12 focused days across six phases**. The
expensive-sounding items are mostly avoidable: `next-auth@4.24.15` clears all
three advisories, so there is no Auth.js v5 migration; SMTP, PgBouncer, CNPG HA
and Prometheus `/metrics` are all deferrable or unnecessary at this scale.

**The two things that must not slip** are the SSRF hole in
`ModelEndpoint.endpoint` (verified TCP-reachable from the live pod to Authentik's
Postgres, Authentik's Redis, Gitea, and 192.168.1.1) and the fact that every rate
limit is currently void because the limiter keys on a client-suppliable header.

---

## Owner decisions

| # | Question | Recommendation | Why |
|---|---|---|---|
| 1 | Which public identity provider? | **GitHub only** | `@@unique([oidcIssuer, oidcSubject])` deliberately forbids email-based linking and there is no NextAuth adapter or `Account` table. Two providers means "I clicked the other button and my projects are gone" with no fix short of building linking. |
| 2 | Who pays for inference? | **BYOK only — and delete the fallback** | BYOK is true today only by accident: `resolveApiKey` returns `process.env.ANTHROPIC_API_KEY`/`OPENAI_API_KEY` for *any* user whose endpoint has no key, with no role gate. It is unset on both live Deployments — one `extraEnv` away from funding every stranger's inference. |
| 3 | Invite-capped beta, or open? | **Capped beta of 10–20, then open** | Invites reduce volume, not capability. An invited stranger has the same SSRF reach and the same unbounded writes, so Phase 2 must land before *any* non-owner account. |
| 4 | Keep `CredentialsProvider`? | **Delete it** | Zero credentials accounts exist (the one user's `passwordHash` is the `!oidc-managed` sentinel), so deleting breaks nothing. It is currently the only unthrottled auth endpoint — `authLimiter` has zero call sites. It is also live on the apex right now. |
| 5 | On deletion, purge or reassign public content? | **Keep reassign-to-Archive** | Already implemented carefully with 15 DB-backed tests. Full purge would break leaderboard provenance, which is the product. State it in the terms. |
| 6 | Should a Redis/RabbitMQ outage take the site down? | **Degrade, not fail** | `allHealthy = db && redis && rabbit` is wired as the readiness probe at `replicas: 1`, so a Redis restart pulls the only endpoint and 503s *everything* — including the intentionally-public leaderboard. |
| 7 | Is a 24h RPO acceptable? | **Accept at launch; revisit when a user has real work invested** | The honest current answer is worse: there is no backup yet. `judge-arena-pg` was created after the daily schedule ran, so the first snapshot lands tomorrow 08:00Z. |

---

## Phase 0 — Unblock the product and prove one run

**Goal:** make the core function work, and demonstrate one evaluation end-to-end.

- [x] Raise the RabbitMQ PV above the watermark (`size: 4Gi`) — **done 2026-08-07**
- [ ] Add a timeout/`AbortSignal` to `publishConfirmed`, and subscribe to amqplib's
      `connection.blocked`/`unblocked` events. Without this, a blocked broker
      presents as a hung request until nginx's 3600s read timeout rather than an error.
- [ ] Seed `PromptTemplate`s; confirm the seeded catalog contains no keyless
      anthropic/openai entries. **Note:** neither seed script can run in the
      deployed image — `prisma/seed.ts` needs a TS toolchain the runner does not
      ship. Bundle it the way `admin-create-user.js` is bundled, or run it as a Job
      from the builder stage.
- [ ] Trigger an on-demand Velero backup of `judge-arena-pg` and verify with
      `velero backup describe --details` that it actually contains items.
- [ ] **Cluster-wide, beyond this app:** `tenant-internal/bus` and `tenant-root/bus`
      have the identical `2Gi`-vs-2GB alarm. Verified: all three `bus` nodes alarmed.
      Latent only because nothing is connected — the next app to publish there gets
      silently blocked exactly as this one was.

**Exit gate:** `rabbitmq-diagnostics -q alarms` empty on all 3 nodes and
`list_connections` shows `running`; one evaluation launched from the browser
reaches a completed `ModelJudgment` with a score.

---

## Phase 1 — A second human can log in (sign-up still closed)

**Goal:** build the identity plumbing and prove it with an owner-controlled test
account. Autoprovision stays OFF; this creates the door, it does not open it.

- [ ] Bump `next-auth` to **4.24.15** (clears GHSA-x445-f3h2-j279 and two others).
      This matters *before* adding a second provider: the advisory is that OAuth
      state/nonce/PKCE cookies are not bound to the provider that set them — inert
      with one provider, live with two.
- [ ] Add the GitHub provider plus a provider→issuer map, replacing the module-level
      `AUTHENTIK_ISSUER` const.
- [ ] Override GitHub's `profile()` to require a **verified** email.
- [ ] Scope invite claims to an issuer (`--issuer=` on the admin CLI, plus an
      `oidcIssuer` predicate on the claim query). Today an invite is claimable by
      the first matching email from *any* issuer.
- [ ] Replace the global autoprovision flag with **per-provider** policy, so GitHub
      can self-provision while Authentik stays deny-by-default permanently.
- [ ] Delete `CredentialsProvider`; add a custom NextAuth error page; rewrite
      `/login` and `/register`.

**Exit gate:** a test GitHub account signs in unaided via an issuer-scoped invite
and lands on an empty private workspace; the owner's Authentik login still resolves
to the same admin row; `/api/auth/providers` no longer lists `credentials`.

---

## Phase 2 — Close what a stranger could reach

**MUST precede any non-owner account.** Invite-gating is not a substitute.

- [ ] **SSRF guard on `ModelEndpoint.endpoint`.** Verified reachable from the live
      web pod: Authentik's Postgres, Authentik's Redis, Gitea, 192.168.1.1.
      *Critique, adopted:* do not scope this as feature-preserving hardening with
      resolve-then-check and DNS-rebinding re-checks — that is a days-long
      arms race. **Allowlist the handful of known provider hosts** and require an
      admin to add anything else. Strangers do not need arbitrary endpoint URLs.
- [ ] **Re-key the rate limiters.** `client-ip.ts` trusts `X-Forwarded-For` with
      `TRUSTED_PROXY=true`, so any client can forge its own bucket and **every rate
      limit is void**. Use `CF-Connecting-IP` pre-auth and user id post-auth.
- [ ] Make `isDefault` admin-only in `POST /api/config/import` — today any
      authenticated user with `config:write` can take the front-page leaderboard.
- [ ] Delete the operator env-key fallback in `resolveApiKey` and the
      `NO_AUTH_PLACEHOLDER_KEY` path.
- [ ] Hard caps on dataset samples, input/expected lengths, rubric sizes.
- [ ] Apply `judgeLimiter` to the bulk launch path.
- [ ] Add an endpoint/user segment to the circuit-breaker key, so one user's failing
      endpoint cannot open the breaker for everyone.
- [ ] **Own the global model catalog** *(critique, adopted — absent from the original)*.
      `JudgeModel`/`JudgeModelVersion` have **no owner column**, are returned
      unfiltered by `GET /api/models/catalog`, are writable by any user with
      `models:write`, are never retired, and are the one thing account deletion
      cannot clean up. Make writes admin-only for now; that is a one-line gate
      versus a schema migration.
- [ ] **Bound the unauthenticated export path** *(critique, adopted)*.
      `GET /api/datasets/[id]/export` uses `optionalAuth()` and can be made to
      materialise a large response — an unauthenticated request can OOM the single
      1Gi web pod.

**Exit gate:** a scripted probe suite run as a non-admin test account fails closed
on all of it — endpoints at `10.x`/`127.0.0.1`/`*.cozy.local`/`http://` rejected at
create; a forged `X-Forwarded-For` does not buy extra quota; `isDefault` rejected;
an endpoint with no key errors instead of silently using an operator key.

---

## Phase 3 — What you owe a stranger

**Goal:** the obligations that make asking a stranger for their provider key legitimate.

- [ ] Wire `deleteUserAccount` to `POST /api/account/delete` plus a settings
      affordance, and provision the Archive user as part of deploy. The service is
      well-tested but **currently unreachable from the UI**.
- [ ] Fix the mixed-visibility dataset abort in `account-deletion.ts` (bare
      `deleteMany` on private datasets with no child-version check).
- [ ] Stop writing email addresses into `AuditLog.metadata`; add retention pruning
      and expiry on `invitePending` rows.
- [ ] `/privacy` and `/terms` plus a footer contact link. Must state that content is
      transmitted to the user's own provider account, and that public content is
      reassigned rather than purged on deletion.
- [ ] Cloudflare Email Routing for `abuse@` and `privacy@`.

**Exit gate:** a test account deletes itself from the UI — private datasets gone,
public ones show the Archive owner, human judgments survive, no email of theirs
remains in `AuditLog`.

---

## Phase 4 — See it break before a user tells you

**Goal:** a signal for every failure a stranger would experience, using
infra-level scrapes that need no app change.

- [ ] Uptime Kuma monitor on `/api/health` with `type: keyword, keyword: healthy`.
- [ ] Homepage tile; wire the tile-coverage test into preflight.
- [ ] `VMServiceScrape` for `rabbitmq-judge-arena` on the existing `:15692`
      prometheus port, and a `redis_exporter` sidecar plus scrape.
- [ ] `charts/judge-arena/templates/vmrules.yaml`. **PAGE:** external probe down;
      `judgment.execute` backlog sustained; **RabbitMQ alarm active** (entry 56 — the
      state structurally invisible to every probe). **TICKET:** `judge.dlq` depth > 0
      (no consumer by design, so it is purely an operator surface).
- [ ] **Split readiness so a dependency blip degrades rather than 503s the site.**
      *Critique, partially rejected:* do **not** add a schema-version check. The
      migrate hook is now `pre-install`, which structurally prevents the
      schema-missing condition, and a schema-aware readiness probe would introduce a
      new outage mode. Gate on Postgres reachability only; keep Redis/RabbitMQ in the
      response body and in per-route 503s.
      *Also:* `/api/health` shares the Prisma singleton and event loop with every
      request, so under connection pressure the probe fails and turns capacity
      pressure into a total outage. Give it its own budget.
- [ ] `docs/runbooks/judge-arena-restore.md` that restores the **database and
      `ENCRYPTION_KEY` together**, rehearsed into a scratch namespace. A DB restore
      without that key yields undecryptable provider keys.

**Exit gate:** force-delete the worker mid-run and get a push within 10 minutes;
scale Redis to 0 and the public leaderboard still returns 200.

---

## Phase 5 — Open the door

- [ ] Enable autoprovision for **GitHub only**, via the per-provider policy.
- [ ] Cloudflare WAF rate-limit rule on `/api/auth/*`.
- [ ] Cache the public leaderboard at the CF edge.
- [ ] Invite 10–20 named people, watch for a week, then remove the cap.

**Exit gate:** 10+ strangers hold accounts, each on their own provider key; the
operator's Anthropic and OpenAI dashboards show **zero** spend attributable to the
app; no cross-user visibility incident.

---

## Deliberately not doing

Scope discipline matters more than completeness here. Each of these was considered
and declined, with the reason:

- **Auth.js v5 migration** — `4.24.15` exists and clears every advisory. Hours, not weeks.
- **Credentials registration with email verification** — needs a transactional
  provider, SPF/DKIM/DMARC, an egress policy, and five routes. The four unused
  `emailVerified`/`resetToken` columns are dead code, not a head start. Delegating
  recovery to GitHub is what makes launch possible without any of it.
- **Public enrollment in the homelab Authentik** — `users-primary` also gates the
  owner's Gitea source repos and home portal. It cannot send mail, and it fronts
  everything else in the cluster.
- **Content moderation infrastructure** — report queues, flagging, quarantine. Real
  at scale; premature at 10 users. Revisit when public datasets exist.
- **Per-user cost accounting and budgets** — tokens are stored per judgment and never
  aggregated. BYOK makes this the user's problem, which is the point.
- **PgBouncer** — measured 97 usable connections; the budget is spent by replica
  count, not load. Not the constraint yet.
- **CNPG HA and WAL/PITR** — real data-plane changes; revisit with decision 7.
- **`next@16`** for postcss/sharp — the only prod advisories needing a major bump,
  and neither is reachable (postcss is build-time; sharp is unused at runtime).
- **Prometheus `/metrics`** — weeks of app instrumentation. Infra-level scrapes
  (RabbitMQ, Redis, CNPG, blackbox) cover the launch questions.
- **Provider account linking** — ship one provider and the problem does not exist.
- **An off-cluster status page** — a Kuma page rides the same cluster and tunnel it
  would report on.

---

## Corrections to earlier claims in this program

- **`/api/health` is not a schema check.** Its database probe is `SELECT 1`, which
  succeeds against a schema-less database. This is exactly how the Railway instance
  sat green while every table was missing, and it is why "healthy" was reported for a
  deployment whose broker was blocking every publish. Reachability is the easy thing
  to measure and almost never the thing that matters.
- **The documented rollback of "repoint DNS back to Railway" is fiction.** Railway's
  database has no tables. Real rollback is removing the CF Tunnel hostname.
- **The Phase 2 data workstream (D4, the v1→v2 importer as a cutover dependency) is
  moot.** Production's tables were dropped with no surviving snapshot, and the owner
  confirmed no evaluations existed.
