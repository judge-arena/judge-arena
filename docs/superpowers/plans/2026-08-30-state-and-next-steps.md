# State and next steps — 2026-08-30

**Supersedes the *status* of `2026-08-17-a1-a15-complete-handoff.md`.** That document remains the
right place for the traps (§4) and the method notes; its §1–§3 have been corrected in place rather
than duplicated here. Read it after this.

**Everything below was verified against the tree, the remote or the live cluster on 2026-08-29/30.**
Nothing is carried forward from an earlier document. Three things that every prior handoff asserted
turned out to be false, and they are called out as corrections rather than quietly replaced.

---

## 0. If you read one thing

> **E1 was never blocked by missing code. It is blocked by an identity mismatch, and has been since
> 2026-08-18.** Two golden sets, 650 items and two assignments have existed since 2026-08-19. Zero
> labels have. Every document written before today said the blocker was "a person, in a browser,
> ~20 minutes". A person tried, three times, and was refused at the door.

---

## 1. What changed on 2026-08-29/30

| | |
|---|---|
| `gitea/main` | `e4164c8` → **`14d75f7`** — merged `feat/assignment-ui-and-random-subset` (`0309a7e`) plus a fixes commit (`ded6e1f`) |
| Production image | `sha-bee1d121ea7d` → **`sha-14d75f7d46de`**, promoted via homelab PR **#936** |
| Migrations | **18, unchanged.** `git diff --name-only bee1d12 14d75f7 -- prisma/migrations/` is empty; the migrate hook logged `No pending migrations to apply` |
| Evaluation pipeline | **Dead for 5 days → alive.** See §3 |
| Branches | 22 local + 17 Gitea branches deleted; Gitea went 20 → 3. Local `main` repointed from an April GitLab artifact to `gitea/main` |
| Worktrees | 10 removed across both repos, **~2.5 GB** reclaimed (root fs 94% → 91%) |

**What the merge shipped.** A1 built the assignments API and A1.5 built the studio; nothing let a
person create an assignment from a browser, so a set could be owned and never labelled. There is now
an assignment panel on `/golden-sets/<id>` with **Assign to me** / **Revoke** and a shortcut into the
studio, `annotatorId`/`assignedById` are projected through `toPublicOwner` (`{id, name}`, never the
email, `null` for a deleted account), and subset selection gained `randomCount`/`randomPercent`
**resolved server-side** — because `DatasetSample.index` is not dense once anything is tombstoned and
there is no `GET` on dataset samples for a client to enumerate live ordinals with.

**Gates at the merge point**, run locally against podman Postgres/Redis/RabbitMQ *and* by Gitea CI
in-cluster: lint 0, `tsc` 0, **594 unit / 641 db / 80 integration**, both coverage gates 0, build 0.
Against the `bee1d12` baseline of 578 / 633 / 80, the deltas reconcile exactly to the tests added.

**Two defects were fixed before merging, both found by review rather than by the suite:**
- `handleRevoke` had **no `catch`**. A rejected fetch escaped as an unhandled rejection while
  `finally` re-enabled the button — a *failed* revoke was pixel-identical to a successful one.
- The test named `randomPercent resolves against the LIVE sample count` **tombstoned nothing**, so
  live count and raw count were the same number and it passed under either. It now hides 20 of 40
  and asserts 5.

**And the two new surfaces were walked in a browser**, because `src/app/golden-sets/**` has no DOM
test environment. Runbook rows 13–18, recorded in `docs/runbooks/studio-manual-verification.md`.
The row worth keeping — one 620-row dataset, N=30, two modes:

```
First 30    0,1,2,3,…,29
Random 30   14,61,62,76,90,121,152,162,165,171,177,179,252,256,261,
            288,309,328,343,363,366,428,439,441,450,479,496,508,519,529
```

Rows 13 and 15 were **not** walked and the recording says so.

---

## 2. THE E1 BLOCKER — read this before trying to sign in

judge-arena's `User` row `cmsj951c30000881a4l63sx4b` (`trijeet@protonmail.com`, admin) — the row that
**owns both golden sets and holds both assignments** — has
`oidcSubject = 26f57dc2-77b6-455b-a939-d897dbdad6ee`.

Authentik has **two accounts sharing that email**:

| Authentik user | uuid |
|---|---|
| `akadmin` | `26f57dc2-77b6-455b-a939-d897dbdad6ee` ← the app row points here |
| `trijeet` | `e8b087cc-b38b-492a-bbb3-b34bdfb50c16` ← this is who signs in |

The provider's `sub_mode` is `user_uuid`, so `sub` **is** the uuid. The 2026-08-07 invite-claim
happened as `akadmin`; every attempt since has been as `trijeet`, matching nothing.
`resolveOidcUser` falls to branch 3, `ALLOW_OIDC_AUTOPROVISION` is absent from the deployment env,
and sign-in is refused. Three `authorize_application|trijeet` events (2026-08-18 21:33:35,
2026-08-19 13:41:28, 13:41:32) are each followed within a second by
`user.login.failed {"reason":"no_match_autoprovision_disabled"}`.

Credentials fallback is impossible: the row's `passwordHash` is `!oidc-managed`, and
`findCredentialsUserByEmail` excludes `!`-prefixed hashes.

- **Fastest path, mutates nothing:** sign in to Authentik as **`akadmin`** — private window, or log
  out of the `trijeet` SSO session first. That sub matches, and akadmin is in `users-primary`, the
  single enabled policy binding on the judge-arena application.
- **Durable fix, one row, an owner decision:**
  `UPDATE "User" SET "oidcSubject"='e8b087cc-b38b-492a-bbb3-b34bdfb50c16' WHERE id='cmsj951c30000881a4l63sx4b';`
  — or consolidate the two Authentik accounts.

> **DO NOT issue a fresh CLI invite, and DO NOT enable `ALLOW_OIDC_AUTOPROVISION`.** Both mint a
> **second, empty** `User` row that owns nothing and gets a hard 403 from the queue on both sets. The
> partial unique index you would expect to prevent it —
> `UNIQUE (email) WHERE "passwordHash" NOT LIKE '!%'` — does not, because the existing hash starts
> with `!`. `docs/runbooks/authentik-oidc-setup.md` recommended exactly these two remedies until
> today; it now leads with this case.

---

## 3. The pipeline was dead for five days, and the code defect is still live

All five queues reported `consumer_count=0` from **2026-08-24T17:55Z until the 2026-08-30 promote**.

The Cozystack v1.6.2 roll recreated `judge-arena-pg-1` at 17:54:57Z. Twenty-one seconds later the
worker logged a burst of `Can't reach database server` and `57P01 terminating connection due to
administrator command`, and then **emitted no log line for five days**. Its socket reconnected — the
AMQP connection was `running` on `server-1` with one channel — but its **consumers never
re-registered**. The pod stayed `1/1 Running` with **0 restarts** throughout. Nothing looked wrong;
nothing alerted.

Rolling the Deployment fixed it: `run.create` and `judgment.execute` are back to `consumers 1`.
(`judge.dlq` and the two `judgment.retry.*` queues sit at 0 **by design** — do not read those three
zeroes as a fault.)

**The defect is not fixed.** The AMQP client re-subscribes only on boot, not on reconnect. Until
that changes, **any** roll of a broker node reproduces this silently. That matters immediately:

> **homelab PR #932** (judge-arena broker zone spread) bounces `server-1`, which is where both AMQP
> connections are homed. **#932 will re-break the consumers and must be followed by a worker
> restart** — or, better, by fixing the reconnect path first.

---

## 4. Corrections to things earlier documents stated as verified

1. **"The M4 seeder created two `PromptTemplate` rows that had never existed in production."**
   Half false. Only **`v1-pairwise`** was new (2026-08-18 14:07:31.432). `v1-legacy` has existed
   since **2026-08-12 17:42:35.664** — its Prisma cuid `cmsqdn8un00006p142rkwzuw1` embeds that
   insertion time, which proves it was not deleted and re-created. *PROMOTING DOES NOT SEED survives
   on `v1-pairwise` alone.*
2. **The operational rule built on it was false and is withdrawn.** "Run the seeder and read its
   output — a 'Created' line means production was behind" does not work: `seedPromptTemplates`
   `upsert`s and then logs `✓ Created prompt template: …` **unconditionally**, and
   `seed-judgebench.ts` opens with `✓ Created dataset: …` the same way. **No log line in the seeder
   is gated on an actual insert.** Only the parenthetical `${created.count} new samples` carries a
   real delta — and `seed-core.ts`, the file the rule named, never prints "Created" at all.
   Use `select name,version,"createdAt" from "PromptTemplate"` before and after instead.
   *(If you fix the seeder: `PromptTemplate` has **no `updatedAt`**, so "branch on
   `createdAt === updatedAt`" is not implementable. Use a `findUnique` first, a `count()` either
   side, or `create` with a P2002 catch.)*
3. **`stable.yaml` had drifted three promotes** and would have rolled production back to a pre-A0
   image from three weeks earlier, across five migrations. Its own header warned about exactly this.
   Fixed and backfilled in homelab PR #936. The general form: **manual promotion is two steps and
   only one is load-bearing at deploy time** — `helmrelease.yaml` changes what runs, `stable.yaml`
   changes what a rollback returns to.

---

## 5. What to do next, in order

### Immediate — unblock E1 (minutes)
Sign in as `akadmin` per §2, or make the one-row `oidcSubject` fix. Then walk E1 against the
**30-item** set (`JudgeBenchSample — 30 random`), not the 620-item one: `retestIntervalItems`
defaults to 20 and eligibility is intervening-items-only, so 30 clears K and makes blind re-reads
reachable while ≤20 can never produce one. With a single account `testRetest` is the only
reliability number the product can produce.

**Two things will look like bugs and are not:**
- **E1 step 5, "read the agreement panel", has no UI.** `GET /api/golden-sets/[id]/agreement` works,
  but nothing in `src/app/**` calls it. Navigate the signed-in tab straight to that URL and read the
  JSON. It is a missing surface, and it deserves its own work item.
- **Every `GoldenCandidate` has `label IS NULL`** (1300 of 1300), so the studio shows
  "Option 1"/"Option 2" while the verdict control asks for `A>B`/`tie`/`B>A`, with nothing on screen
  saying Option 1 is A. It **is** deterministic — `toCandidate(0, responseA)`, `toCandidate(1,
  responseB)`, queue orders by `position asc` — but an annotator who guesses the other way inverts
  every preference in the session and the corruption is silent. Fix `toCandidate` to stamp `A`/`B`,
  or have the studio letter them.

### Next — the two defects this session found but did not fix
1. **AMQP consumers must re-register on reconnect** (§3). Highest value: it is a silent
   total-loss-of-function that no probe sees.
2. **`toCandidate` should stamp `A`/`B`** for pairwise/listwise, plus a backfill for the 1300
   existing rows.

### Then — T5, which gates A2 and is ~5% done
Not one RabbitMQ sample has **ever** been stored in this cluster — VictoriaMetrics returns
`seriesFetched: "0"` for `{__name__=~"rabbitmq_.*"}`, with zero `VMServiceScrape`s and zero
`VMRule`s. Everything the scrape needs already works: `rabbitmq_prometheus 4.2.4` is enabled, both
Services publish `prometheus 15692`, the endpoint answers 2818 lines, and the existing
`allow-external-communication` policy already permits cross-namespace scraping — **no NetworkPolicy
work is needed.** Three corrections to T5 as written: there are **two** brokers now, not three; a
request body size limit **does** exist at the ingress (`proxy-body-size: 50m`); and the default
`/metrics` **carries no queue label**, so the `judgment.execute` backlog and `judge.dlq` depth alerts
are impossible from it — they need `/metrics/detailed?family=queue_coarse_metrics`, where only the
**leader** emits a depth sample.

Interim thresholds, until T5 lands: `homelab-setup:docs/runbooks/backpressure-watchlist.md`.

### Only then — A2
Unchanged: **do not write the A2 spec until E1–E3 have produced real labels.** One question is worth
settling cheaply first — whether `agreement()` is reusable for human-vs-model. It takes
`Reading[] = {itemId, raterId, category}[]`, and a model is just another `raterId`. If that holds,
**A2 writes no statistics code at all**, which is a large enough scope difference to settle before
planning rather than after.

---

## 6. Repo state

- `gitea/main` = `14d75f7`. **Branch from this.** Local `main` now tracks `gitea/main` correctly.
- Gitea holds **three** branches: `main`, `docs/productionized-state` (superseded — its durable
  content was folded into these docs, corrected, and it can be deleted), and
  `docs/rebaseline-north-stars` (content-dead: `main` is strictly *ahead* on every file it touches,
  but `git cherry` cannot see that, so it was left rather than deleted on an unverifiable check).
- Recovery record for the branch cleanup: `/root/judge-arena-worktrees/gitea-branch-shas-before-cleanup.txt`.
- `railway.toml` and `Procfile` are gone — PaaS artifacts from before the cluster migration. The
  `ctrl:*` scripts they referenced live on in `package.json`.
- `.gitignore` no longer ignores `.github/`. It did, under a "Local env files" heading, which meant
  any **new** workflow file was silently unstageable — precisely the trap someone restoring the
  GitHub mirror would have hit. The mirror has been frozen since 2026-08-07 and has no push
  automation in either workflow file; that is still open.
