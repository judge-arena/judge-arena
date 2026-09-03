# CI Artifact Assertion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "an image exists in Harbor for this SHA" a thing CI asserts and a thing a human can read from Gitea's own record — and correct every document that blamed the 2026-09-01 false green on an OOM.

**Architecture:** Two bash scripts under `scripts/ci/` (already excluded from the image by `.dockerignore:77`): `assert-harbor-tag.sh` asks Harbor's public API for the artifact and prints an `IMAGE_PUBLISHED` sentinel; `ci-status.sh` reads Gitea's `actions/tasks` and `commits/{sha}/status` endpoints (both 200 unauthenticated) and then runs the Harbor check. `build-push` gains one step calling the first script after the kaniko Job reports Complete. Comment and doc corrections record the verified mechanism: Gitea 1.23.6's built-in `CancelPreviousJobs` cancelled runs 51 and 52 on the next push, act v0.261.10 prints `🏁 Job succeeded` in the runner pod log after a cancel, and Gitea's commit status was never green.

**Tech Stack:** bash, curl, jq (all present on the runner image and on gharial); Gitea Actions YAML (raw `run:` steps only); js-yaml (transitive in node_modules) for structural YAML assertions; shellcheck 0.10.0 on gharial.

**Spec:** handoff `/root/judge-arena/docs/superpowers/plans/2026-09-01-scoreboard-handoff.md` §6 trap 3 (:263-268), trap 4 (:269-273), §7 #6 (:314), §8 step 4 (:354-356); scoreboard spec `/root/judge-arena/docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md` §5.5 (:527-578); register `/root/judge-arena/docs/superpowers/plans/2026-08-30-state-and-next-steps.md` §5.6 item 11 (:448-458); verified map `/tmp/ja-plan-inputs/ci-false-green.json` (its `verify.corrections` override the map); cross-item critique `/tmp/ja-plan-inputs/critique.json` q2 `ci-false-green`, q3, q4 (item "#6 ci-false-green").

**Priority / wave:** Wave 1 / #3 (S, independent — may run in parallel with Wave 1 #1 U3 hard-cap, `2026-09-01-u3-hardcap-escapes-retry.md`, and Wave 1 #2 consumer-loss fail-fast, `2026-09-01-consumer-loss-fail-fast.md`. Shares no source file with either; the one shared file is `CONTRIBUTING.md`, which #2 edits at :1221-1247 and this plan appends after :1382 — disjoint regions, and Task 3 anchors on `old_string`, so the order of landing does not matter. #2 adds tests, which is why the baseline rule in Global Constraints exists.)

**Depends on:** none.

**Owner decisions needed:** none for this plan. Two follow-ups are recorded in "Open questions" at the end (a `workflow_dispatch` input to rebuild a superseded SHA; an out-of-band pushed-not-built exporter in homelab-setup) — neither blocks any task here.

## Global Constraints

- Repo: /root/judge-arena (Next.js 15.5.22, TypeScript, Prisma on Postgres — Json maps to JSONB —, amqplib 2.0.1, vitest). Node >= 22. Always use `git -C /root/judge-arena` (handoff trap 2: a stale `cd` once hard-reset the wrong repo).
- Gates, in this order, all must be clean before every commit: `npm run lint` (0 warnings) → `npx tsc --noEmit` → `npm run test:coverage` (unit; per-glob floors in vitest.config.ts:187-220 — NEVER lower a floor; if a new test import drags a module into a denominator, mock the seam as tests/lib/judgment-consumer-escalation.test.ts:41-69 does) → `npm run test:db:coverage` (RESETS the database at .env.test — verified today to be localhost:5432, the local podman `judge-arena-pg`, NOT the k8s `judge-arena-pg-1`; re-confirm with `grep DATABASE_URL /root/judge-arena/.env.test` before the first run) → `npm run test:integration` → `npm run build`. Baseline on HEAD fc9e936: 869 unit / 55 files; 670 db; 80 integration.
- TDD with an INJECTION step (CONTRIBUTING.md:210-234): every behaviour test must be shown to go RED by a deliberate breakage of the implementation and GREEN again after; a test that stays green after injection is a finding. Each task's steps must include the injection.
- One concern per commit/PR (CONTRIBUTING.md:1560). Wrong statements in docs get an explicit CORRECTION note, never a silent overwrite (CONTRIBUTING.md:1571-1574).
- Commit subject: `type(scope): lowercase summary` (feat/fix/docs/ci; scopes seen: worker, llm, queue, calibration, ci, docker). Body: narrative, then a `Gates: lint 0, tsc 0, <n> unit / <n> db / <n> integration, coverage 0.` line, then EXACTLY these trailers:
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
- Commit LOCALLY only. Never push, never promote; the operator does that (push-to-main fires CI and builds an image; promotion is a separate homelab-setup PR).
- If `git -C /root/judge-arena log --oneline fc9e936..HEAD` is non-empty when Task 1 starts (a sibling Wave-1 plan landed first), the baseline is whatever Task 1 Step 6 observes; substitute those counts for 869 / 670 / 80 in every later Step 6 expectation and every commit body, keeping the exact shape `Gates: lint 0, tsc 0, <n> unit / <n> db / <n> integration, coverage 0.` — the invariant is "unchanged across THIS plan's five commits," not the literal numbers.
- Migration naming: `prisma/migrations/<YYYYMMDDHHMMSS>_v2<letter>_<snake>/migration.sql`, timestamp must sort after 20260901000000 (v2j); narrative `-- v2x — ...` header in the v2i/v2j style; ZERO hand edits (content must equal what `prisma migrate diff` emits), then `npx prisma generate`.
- GREP TRAP live in HEAD: /root/judge-arena/src/lib/calibration/readings.ts:164 and /root/judge-arena/scripts/importer/reconcile.ts:294 contain a deliberate NUL byte; plain grep returns nothing for those files. Use `grep -a`. NEVER remove the NUL.
- Production is sha-d21f31d47c35; main (fc9e936) is 4 docs-only commits ahead. Do not touch homelab-setup from a judge-arena task except where the plan explicitly says "separate PR in /root/homelab-setup".
- Any cluster/DB access in a plan step is READ-ONLY (psql SELECT, kubectl get/logs, rabbitmqctl list_queues). No requeue-peeks of judge.dlq (quorum delivery_limit 20 — every peek burns one).

---

## What was actually verified (read this before Task 1; every doc edit below quotes it)

All of the following were re-checked on 2026-09-01 from gharial, read-only, and the live calls in Tasks 1 and 3 re-verify the parts that can drift.

| fact | evidence |
|---|---|
| The runner pod log printed `❌ Failure - Main Build` / `this step has been cancelled: signal: killed` / `🏁 Job succeeded` for task 4816 (commit 60be6f6, run 51) at 15:42:12-13Z | `kubectl -n tenant-internal logs gitea-runner-0`; spec §5.5 :531-541 quotes it verbatim |
| The same signature recurred on task 4818 (commit 7f0e0cb, job **db-tests**, step "Wait for the DB-test Job" — a kubectl polling loop with no Node process) at 15:56:32Z, 8 s after d21f31d was authored | gitea-runner-1 log; rules out memory without any argument about Next.js |
| `this step has been cancelled: %w` is emitted by act v0.261.10 only inside `select { case <-ctx.Done(): … }` (pkg/container/host_environment.go:367-375) — the step CONTEXT was cancelled; a kernel OOM does not close `ctx.Done()` | act source at the version pinned by act_runner v0.4.1 go.mod:118 |
| Gitea 1.23.6 calls `CancelPreviousJobs(repoID, ref, workflowID, event)` on every push / pull_request_sync before inserting the new run (services/actions/notifier_helper.go:332-343 → models/actions/run.go:197-266 → `StopTask(StatusCancelled)`); act_runner's reporter cancels the job on `RESULT_CANCELLED` (reporter.go:519-521) | `GET /api/v1/version` → 1.23.6 |
| act job_executor.go:157-166 replaces the cancelled ctx with `context.WithTimeout(common.WithLogger(context.Background(),…),5m)`, which has no job-error container, so `common.JobError(ctx)==nil` → `setJobResult(…, true)` → `🏁 Job succeeded` (:188-192). act `main` still has this. | act source |
| Gitea ignored that final report: `UpdateTaskByState` returns early `if task.Status.IsDone()` (models/actions/task.go:367-370) | Gitea source |
| Gitea's record was never green: `GET /api/v1/repos/trij/judge-arena/actions/tasks` (200, no token) has task 4816 `status: cancelled` (run 51) and task 4818 `status: cancelled` (run 52); `commits/60be6f69d37d/status` → `state: failure`, all three contexts "Has been cancelled" | re-run in Task 3 |
| 2c1e85e and 740e7bb **never had a run** — they were pushed in one batch whose head was ba237bd (run 54). Runs 50-55 map to exactly 414e826, 60be6f6, 7f0e0cb, d21f31d, ba237bd, fc9e936. `commits/2c1e85e10145/status` → `state: ""`, `statuses: null` (not `[]`) | re-run in Task 3 |
| Harbor: `sha-d21f31d47c35` → 200 (digest `sha256:867728348e03…`), `sha-60be6f69d37d` → 404. Project `homelab` is public (`metadata.public: "true"`); anonymous GET works | re-run in Task 1 |
| No OOM: gitea-runner-0 restartCount 0, no `lastState.terminated`, same pod since 15:27:13Z; both runners on StatefulSet revision gitea-runner-64b49769bf, generation 6 = observedGeneration 6 | `kubectl -n tenant-internal get pod gitea-runner-0 -o yaml` |
| Nothing in ci.yml swallows a failure: zero `continue-on-error`; every `\|\| true` is on a forensic `kubectl describe/logs` or a jsonpath read inside a poll loop; the only `if: always()` is the reap step (:396), which does not run after a server-side cancel anyway | grep of the file |
| Gitea 1.23.6 has no workflow `concurrency` support (models/actions/run.go at v1.23.6: 0 hits for Concurrency); ci.yml:90-92 is inert. `/actions/runs` and `/actions/workflows/{file}/dispatches` 404 | curl |
| Next 15.5.22 forks `max(1, os.cpus().length−1)` static workers and STRIPS `--max-old-space-size` from them (`isolatedMemory: true`, build/index.js:338 → lib/worker.js:62-65). `NODE_OPTIONS` at ci.yml:107 bounds only the parent process. Irrelevant to this incident; recorded so nobody "fixes" it. | node_modules/next/dist |

**Do NOT** retune the runner (4Gi / capacity 2), change `NODE_OPTIONS`, or add `experimental.cpus` on this evidence. **Do NOT** push rapid-fire commits to main to "test" anything: each push cancels the previous run and leaves that SHA without an image — that is the mechanism, not a side effect.

**What the assert step does and does not close.** It catches "kaniko said Complete but Harbor has no tag" (never observed; cheap). It structurally cannot fire for the two mechanisms that actually left four SHAs without images: a cancelled run never reaches the step, and a non-head commit never gets a run. The durable guard for pushed-not-built is out-of-band: `scripts/ci/ci-status.sh <sha>` (Task 3) before every promote. Say exactly this in every comment and doc; never describe the step as closing trap 3.

---

## File map

| path | action | task |
|---|---|---|
| `scripts/ci/assert-harbor-tag.sh` | create | 1 |
| `.gitea/workflows/ci.yml` | insert one step after :587 (end of "Wait for the build Job"), before :589 ("Report the pushed image") | 2 |
| `scripts/ci-local.sh` | fix stale header (:4-11) and tail comment (:122-127) | 2 |
| `scripts/ci/ci-status.sh` | create | 3 |
| `CONTRIBUTING.md` | CORRECTION + recipe after :1382 (end of the "no Gitea CLI or API token" paragraph, :1372-1382) | 3 |
| `.gitea/workflows/ci.yml` | comment corrections: header (insert after :55), `concurrency:` (:90-92), reap-step comment (:379-394) | 4 |
| `docs/superpowers/plans/2026-09-01-scoreboard-handoff.md` | CORRECTION under trap 3 (:263-268); rewrite §7 #6 (:314) with the old text quoted; insert `ci-status.sh` line above the §8 step-4 skopeo recipe (:354-356) | 5 |
| `docs/superpowers/plans/2026-08-30-state-and-next-steps.md` | CORRECTION under §5.6 item 11 (:448-458) | 5 |
| `docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md` | CORRECTION under §5.5 heading (:527); replace the fix table (:575-578) | 5 |

Line numbers above are the CURRENT tree (HEAD fc9e936). Task 2's insertion is below every range Task 4 edits, so Task 4's anchors do not move; Task 4 and Task 5 use `old_string` anchors, not line numbers.

handoff trap 4 (:269-273) is an input to this plan (see Spec line) only; its invariant — "verify the artifact, not the source tree" — stands unchanged and needs no correction.

Not in scope: `~/.claude/projects/-/memory/judge-arena-green-ci-is-not-an-image.md` (the orchestrator fixes it); anything in `/root/homelab-setup`.

---

### Task 1: `scripts/ci/assert-harbor-tag.sh`

**Files:**
- Create: `/root/judge-arena/scripts/ci/assert-harbor-tag.sh`
- Test: inline bash in Steps 1-6 (no vitest file — the script imports nothing from `src/`, and `npm run lint` = `eslint src/ prisma/ scripts/ tests/` ignores `.sh`)

**Interfaces:**
- Consumes: Harbor API `GET {HARBOR_API}/projects/{HARBOR_PROJECT}/repositories/<repo>/artifacts/<tag>` (default `https://harbor.cluster.asethi.com/api/v2.0`, project `homelab`; anonymous).
- Produces: `bash scripts/ci/assert-harbor-tag.sh <repo> <tag>` — exit 0 and one stdout line `IMAGE_PUBLISHED repo=<repo> tag=<tag> digest=<sha256:…>` on HTTP 200; exit 1 and one `::error::…` line otherwise. Env knobs: `HARBOR_API`, `HARBOR_PROJECT`, `HARBOR_ASSERT_ATTEMPTS` (default 3), `HARBOR_ASSERT_RETRY_SLEEP` (seconds, default 10). Task 2's step and Task 3's script call it exactly this way.

- [ ] **Step 1: Write the failing test**

The "test" for a shell script is the script run against known registry state plus a curl shim. Save nothing to the tree; run these from a shell. Both expected outcomes were verified live on 2026-09-01 (200 / 404).

```bash
# T1a — present tag: sentinel + exit 0
bash /root/judge-arena/scripts/ci/assert-harbor-tag.sh judge-arena sha-d21f31d47c35; echo "exit=$?"
# expected (after Step 3):
#   IMAGE_PUBLISHED repo=judge-arena tag=sha-d21f31d47c35 digest=sha256:867728348e0315972250b5c522b59430a7af48ecd88600377e24a96956b83a04
#   exit=0

# T1b — absent tag: retried, then ::error:: + exit 1 (sleep 0 so it takes seconds, not 20 s)
HARBOR_ASSERT_RETRY_SLEEP=0 bash /root/judge-arena/scripts/ci/assert-harbor-tag.sh judge-arena sha-60be6f69d37d; echo "exit=$?"
# expected (after Step 3):
#   attempt 1/3: HTTP 404 for https://harbor.cluster.asethi.com/api/v2.0/projects/homelab/repositories/judge-arena/artifacts/sha-60be6f69d37d
#   attempt 2/3: HTTP 404 for …
#   attempt 3/3: HTTP 404 for …
#   ::error::no Harbor artifact homelab/judge-arena:sha-60be6f69d37d — the kaniko Job reported Complete but nothing is in the registry
#   exit=1

# T1c — transport failure must NOT abort under `set -e` before the ::error:: line
mkdir -p /tmp/curl-shim && printf '#!/usr/bin/env bash\nexit 7\n' > /tmp/curl-shim/curl && chmod +x /tmp/curl-shim/curl
PATH="/tmp/curl-shim:$PATH" HARBOR_ASSERT_RETRY_SLEEP=0 bash /root/judge-arena/scripts/ci/assert-harbor-tag.sh judge-arena sha-whatever; echo "exit=$?"
# expected (after Step 3):
#   attempt 1/3: HTTP 000 for …
#   attempt 2/3: HTTP 000 for …
#   attempt 3/3: HTTP 000 for …
#   ::error::could not reach Harbor at https://harbor.cluster.asethi.com/api/v2.0/projects/homelab/repositories/judge-arena/artifacts/sha-whatever after 3 attempts (transport failure)
#   exit=1
```

T1a/T1b (and T3a-c in Task 3) depend on registry/Gitea state as of 2026-09-01; if they drift, T1c's
PATH shim is the pattern — point a shim curl at fixture files under `/tmp` (a 200 body
`{"digest":"sha256:x"}`, the 404 body `{"errors":[{"code":"NOT_FOUND"}]}`, and
`{"state":"","statuses":null}`) rather than editing the expected digest or task ids.

- [ ] **Step 2: Run test to verify it fails**

Run: the three commands in Step 1.
Expected: each prints `bash: /root/judge-arena/scripts/ci/assert-harbor-tag.sh: No such file or directory` and `exit=127`.

- [ ] **Step 3: Write minimal implementation**

Create `/root/judge-arena/scripts/ci/assert-harbor-tag.sh` with exactly this content, then `chmod +x` it:

```bash
#!/usr/bin/env bash
# ─── Assert that Harbor holds an artifact for <repo>:<tag> ──────────────────
#
# Why this exists (2026-09-01). The runner POD LOG prints "🏁 Job succeeded"
# after a server-side cancel (Gitea 1.23.6 CancelPreviousJobs on the next
# push; act v0.261.10 job_executor.go swaps in a fresh context and loses the
# job error — see .gitea/workflows/ci.yml's header), and a kaniko Job
# reporting Complete is still one hop away from a tag in the registry. The
# only evidence that an image exists is the registry saying so. On success
# this prints one greppable line:
#
#   IMAGE_PUBLISHED repo=<repo> tag=<tag> digest=sha256:…
#
# and on failure a `::error::` line and exit 1.
#
# Anonymous GET is deliberate: project `homelab` is public, the runner image
# has curl + jq and no skopeo, and the runner's ServiceAccount cannot read
# secrets (homelab-setup clusters/homelab/builds/rbac.yaml). Egress to
# harbor.cluster.asethi.com:443 is allowed for policy-class internal-app.
#
# This is a sentinel, not the closure of pushed-not-built: a run cancelled by
# the next push never reaches this step, and a commit that was not the head
# of its push never gets a run. Assert the tag for the SHA you intend to
# PROMOTE — scripts/ci/ci-status.sh <sha> — before every promote.
#
# Usage: assert-harbor-tag.sh <repo> <tag>
#   HARBOR_API                 default https://harbor.cluster.asethi.com/api/v2.0
#   HARBOR_PROJECT             default homelab
#   HARBOR_ASSERT_ATTEMPTS     attempts before giving up, default 3
#   HARBOR_ASSERT_RETRY_SLEEP  seconds between attempts, default 10
set -euo pipefail

repo="${1:?usage: assert-harbor-tag.sh <repo> <tag>}"
tag="${2:?usage: assert-harbor-tag.sh <repo> <tag>}"
api="${HARBOR_API:-https://harbor.cluster.asethi.com/api/v2.0}"
project="${HARBOR_PROJECT:-homelab}"
attempts="${HARBOR_ASSERT_ATTEMPTS:-3}"
retry_sleep="${HARBOR_ASSERT_RETRY_SLEEP:-10}"

url="${api}/projects/${project}/repositories/${repo}/artifacts/${tag}"
out="$(mktemp)"
trap 'rm -f "$out"' EXIT

code=000
for attempt in $(seq 1 "$attempts"); do
  # `|| code=000` is load-bearing: under `set -e` a curl transport failure
  # (DNS, TLS, timeout — exit 6/7/28/35) inside a command substitution would
  # abort the script here, before the retry and before the ::error:: line.
  code=$(curl -sS --max-time 20 -o "$out" -w '%{http_code}' "$url") || code=000
  if [ "$code" = "200" ]; then
    digest=$(jq -r '.digest' "$out")
    echo "IMAGE_PUBLISHED repo=${repo} tag=${tag} digest=${digest}"
    exit 0
  fi
  echo "attempt ${attempt}/${attempts}: HTTP ${code} for ${url}"
  # A 404 is retried too: this runs seconds after the kaniko Job flips
  # Complete, and Harbor's artifact index can lag the push by a beat.
  if [ "$attempt" -lt "$attempts" ]; then
    sleep "$retry_sleep"
  fi
done

case "$code" in
  404) echo "::error::no Harbor artifact ${project}/${repo}:${tag} — the kaniko Job reported Complete but nothing is in the registry" ;;
  000) echo "::error::could not reach Harbor at ${url} after ${attempts} attempts (transport failure)" ;;
  *)   echo "::error::Harbor returned HTTP ${code} for ${url} after ${attempts} attempts" ;;
esac
exit 1
```

```bash
chmod +x /root/judge-arena/scripts/ci/assert-harbor-tag.sh
```

- [ ] **Step 4: Run test to verify it passes**

Run: the three commands in Step 1.
Expected: T1a prints the `IMAGE_PUBLISHED … digest=sha256:867728348e0315972250b5c522b59430a7af48ecd88600377e24a96956b83a04` line and `exit=0`; T1b prints three `attempt n/3: HTTP 404` lines, the `::error::no Harbor artifact homelab/judge-arena:sha-60be6f69d37d …` line and `exit=1`; T1c prints three `HTTP 000` lines, the `::error::could not reach Harbor …` line and `exit=1`.

Also:

```bash
bash -n /root/judge-arena/scripts/ci/assert-harbor-tag.sh && echo syntax-ok
shellcheck /root/judge-arena/scripts/ci/assert-harbor-tag.sh && echo shellcheck-ok
```

Expected: `syntax-ok`, `shellcheck-ok` (no output from shellcheck itself).

- [ ] **Step 5: Injection**

Injection A — accept a 404 as success:

Break: in `assert-harbor-tag.sh` change `  if [ "$code" = "200" ]; then` to `  if [ "$code" = "200" ] || [ "$code" = "404" ]; then`.
Run: T1b.
Expected: FAIL — prints `IMAGE_PUBLISHED repo=judge-arena tag=sha-60be6f69d37d digest=null` and `exit=0` instead of the `::error::` line and `exit=1`.
Restore the line.

Injection B — drop the transport-failure capture:

Break: change `  code=$(curl -sS --max-time 20 -o "$out" -w '%{http_code}' "$url") || code=000` to `  code=$(curl -sS --max-time 20 -o "$out" -w '%{http_code}' "$url")`.
Run: T1c.
Expected: FAIL — the script aborts on the first attempt with no `attempt 1/3` line and no `::error::` line (only bash's exit propagation), `exit=7`.
Restore the line. Re-run T1a, T1b, T1c: all as in Step 4.

- [ ] **Step 6: Gates**

No TypeScript changed, so every count must equal the baseline. Confirm the DB target first.

```bash
grep DATABASE_URL /root/judge-arena/.env.test      # must be localhost:5432 (podman judge-arena-pg)
cd /root/judge-arena && npm run lint && npx tsc --noEmit && npm run test:coverage && npm run test:db:coverage && npm run test:integration && npm run build
```

Expected: lint 0 warnings; tsc 0; 869 unit / 55 files with coverage thresholds met; 670 db; 80 integration; build succeeds.

- [ ] **Step 7: Commit**

```bash
git -C /root/judge-arena add scripts/ci/assert-harbor-tag.sh
git -C /root/judge-arena commit -F - <<'EOF'
ci(harbor): assert a registry artifact exists for a tag

scripts/ci/assert-harbor-tag.sh <repo> <tag> asks Harbor's public API
for the artifact and prints `IMAGE_PUBLISHED repo=… tag=… digest=…`
on 200, or a `::error::` line and exit 1 after 3 attempts 10 s apart.
Transport failures are captured (`|| code=000`) so `set -e` cannot
abort the script before the retry; a 404 is retried too because the
check runs seconds after the kaniko Job flips Complete.

Anonymous, on purpose: project `homelab` is public, the runner image
has curl + jq and no skopeo, and its ServiceAccount cannot read
secrets. Verified live: sha-d21f31d47c35 → 200, sha-60be6f69d37d → 404.

This is a sentinel for "kaniko said Complete, registry is empty". It
does not close pushed-not-built — a run cancelled by the next push
never reaches it — that is scripts/ci/ci-status.sh, next commit.

Gates: lint 0, tsc 0, 869 unit / 670 db / 80 integration, coverage 0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
EOF
```

---

### Task 2: the `build-push` step, and `scripts/ci-local.sh`'s stale header

**Files:**
- Modify: `/root/judge-arena/.gitea/workflows/ci.yml:585-589` (insert between the end of "Wait for the build Job" and "Report the pushed image")
- Modify: `/root/judge-arena/scripts/ci-local.sh:4-11` and `:122-127`
- Test: inline node (js-yaml is in node_modules transitively) + bash

**Interfaces:**
- Consumes: `scripts/ci/assert-harbor-tag.sh <repo> <tag>` from Task 1; existing step ids `gate` (ci.yml:454) and `tag` (ci.yml:497); the SSH checkout at ci.yml:485-493 that puts `scripts/ci/` in the workspace.
- Produces: a step named `Assert Harbor has ${{ steps.tag.outputs.tag }}` in job `build-push`, positioned immediately after `Wait for the build Job` and before `Report the pushed image`, gated `if: steps.gate.outputs.publish == 'true'`. Task 4's header comment and Task 5's docs name the `IMAGE_PUBLISHED` sentinel this step prints.

- [ ] **Step 1: Write the failing test**

Structural assertion on the parsed workflow (run from `/root/judge-arena` so `require('js-yaml')` resolves):

```bash
cd /root/judge-arena && node -e "
const y = require('js-yaml'); const fs = require('fs');
const d = y.load(fs.readFileSync('.gitea/workflows/ci.yml', 'utf8'));
const steps = d.jobs['build-push'].steps;
const names = steps.map(s => s.name);
const i = names.indexOf('Assert Harbor has \${{ steps.tag.outputs.tag }}');
if (i < 0) { console.error('FAIL: no assert step; steps = ' + names.join(' | ')); process.exit(1); }
if (names[i - 1] !== 'Wait for the build Job' || names[i + 1] !== 'Report the pushed image') { console.error('FAIL: wrong position: ' + names.join(' | ')); process.exit(1); }
if (steps[i].if !== \"steps.gate.outputs.publish == 'true'\") { console.error('FAIL: gate missing: ' + JSON.stringify(steps[i].if)); process.exit(1); }
if (steps[i].env.TAG !== '\${{ steps.tag.outputs.tag }}') { console.error('FAIL: TAG env: ' + JSON.stringify(steps[i].env)); process.exit(1); }
if (!/bash scripts\/ci\/assert-harbor-tag\.sh judge-arena \"\\\$TAG\"/.test(steps[i].run)) { console.error('FAIL: run body: ' + steps[i].run); process.exit(1); }
console.log('PASS: assert step present, positioned, gated');
"
```

And the step body itself, executed exactly as the runner would (this is the same command Task 1 T1a proved):

```bash
cd /root/judge-arena && TAG=sha-d21f31d47c35 bash -c 'set -euo pipefail; bash scripts/ci/assert-harbor-tag.sh judge-arena "$TAG"'; echo "exit=$?"
```

- [ ] **Step 2: Run test to verify it fails**

Run: the node assertion.
Expected: `FAIL: no assert step; steps = Decide whether this run publishes | … | Wait for the build Job | Report the pushed image`, exit 1.

- [ ] **Step 3: Write minimal implementation**

In `/root/judge-arena/.gitea/workflows/ci.yml`, replace this exact text (the tail of "Wait for the build Job" and the head of "Report the pushed image"; `50m deadline exceeded` occurs once in the file):

```yaml
          echo "[$(date -u +%H:%M:%S)] 50m deadline exceeded"
          kubectl describe -n tenant-builds "$JOB" || true
          exit 1

      - name: Report the pushed image
```

with:

```yaml
          echo "[$(date -u +%H:%M:%S)] 50m deadline exceeded"
          kubectl describe -n tenant-builds "$JOB" || true
          exit 1

      # ─── Assert the registry, not the Job ──────────────────────────────
      # `Complete` on the kaniko Job is one hop away from a tag in Harbor.
      # Ask Harbor. Anonymous GET works because project `homelab` is public;
      # the runner has curl + jq (no skopeo) and its ServiceAccount cannot
      # read secrets, so this needs no credentials. On success it prints
      #
      #   IMAGE_PUBLISHED repo=judge-arena tag=sha-<12> digest=sha256:…
      #
      # which is the line to grep for in the runner pod log — NOT
      # "🏁 Job succeeded", which that log prints even after a server-side
      # cancel (see the file header). This is a cheap sentinel, not the
      # closure of pushed-not-built: a run cancelled by the next push to
      # main never reaches this step, and a commit that was not the head of
      # its push never gets a run. Assert the tag for the SHA you intend to
      # PROMOTE — `scripts/ci/ci-status.sh <sha>` from gharial — before
      # every promote.
      - name: Assert Harbor has ${{ steps.tag.outputs.tag }}
        if: steps.gate.outputs.publish == 'true'
        env:
          TAG: ${{ steps.tag.outputs.tag }}
        run: |
          set -euo pipefail
          bash scripts/ci/assert-harbor-tag.sh judge-arena "$TAG"

      - name: Report the pushed image
```

Then `scripts/ci-local.sh`. Replace lines 4-11 (this exact text):

```bash
# Runs the EXACT shell sequence .gitea/workflows/ci.yml runs, step for step,
# against already-running local podman services (postgres/redis/rabbitmq on
# localhost — see CONTRIBUTING.md's "Development Setup"). The repo isn't
# hosted on Gitea yet (that's Phase 2 of the 1b plan) and the Gitea runner
# itself currently has no Docker/container engine to execute the
# `services:` block the workflow declares (see that file's header comment)
# — so THIS script passing, end to end, from a clean `npm ci`, IS what
# "CI green" means until both of those land.
```

with:

```bash
# Runs the shell sequence of .gitea/workflows/ci.yml's `ci` and `db-tests`
# jobs, step for step, against already-running local podman services
# (postgres/redis/rabbitmq on localhost — see CONTRIBUTING.md's "Development
# Setup"). It stops at `npm run build`; the `build-push` job (kaniko in
# tenant-builds + scripts/ci/assert-harbor-tag.sh) has no local mirror
# because it cannot publish from here.
#
# CORRECTION (2026-09-01). This header used to say the repo "isn't hosted on
# Gitea yet (that's Phase 2 of the 1b plan)" and that the runner could not
# execute "the `services:` block the workflow declares". Both were stale:
# Gitea is canonical (CONTRIBUTING.md "Continuous Integration", and its
# own CORRECTION of 2026-08-29), the `services:` block was deleted and
# replaced by the `db-tests` k8s Job, and "CI green" means the Gitea run —
# read from `scripts/ci/ci-status.sh <sha>`, never from the runner pod log.
```

Replace lines 122-127 (this exact text):

```bash
# Docker/Kaniko image build + Harbor push and the docker-compose
# scale-validation smoke check are NOT part of this script — they're
# CI-only steps (.gitea/workflows/ci.yml's `docker` job), both currently
# stubbed with Phase-2 TODO markers there. Task 16 already proved the
# image/compose scale-up locally via podman; this script's job stops at
# `build`, matching the brief's step list exactly.
```

with:

```bash
# The kaniko image build + Harbor push live in .gitea/workflows/ci.yml's
# `build-push` job (live, not stubbed — it publishes on every push to main
# and then asserts the tag with scripts/ci/assert-harbor-tag.sh). They are
# NOT part of this script because nothing here can publish. The
# docker-compose scale-validation smoke check is still CI-less (see that
# file's trailing comment). Task 16 proved the image/compose scale-up
# locally via podman; this script's job stops at `build`.
#
# CORRECTION (2026-09-01): this comment used to call the publish job
# "ci.yml's `docker` job … stubbed with Phase-2 TODO markers". The job is
# `build-push` and it publishes sha-<12> tags on every push to main (Harbor
# holds sha-414e826a3ba3 … sha-fc9e93628149 for the un-cancelled runs).
```

- [ ] **Step 4: Run test to verify it passes**

Run: the node assertion, then the step-body command.
Expected: `PASS: assert step present, positioned, gated`; then `IMAGE_PUBLISHED repo=judge-arena tag=sha-d21f31d47c35 digest=sha256:867728348e0315972250b5c522b59430a7af48ecd88600377e24a96956b83a04` and `exit=0`.

Also `bash -n /root/judge-arena/scripts/ci-local.sh && echo syntax-ok` → `syntax-ok`.

- [ ] **Step 5: Injection**

Break: in the new step, change `        if: steps.gate.outputs.publish == 'true'` to `        if: steps.gate.outputs.publish == 'false'`.
Run: the node assertion.
Expected: FAIL with `FAIL: gate missing: "steps.gate.outputs.publish == 'false'"`, exit 1.
Restore. Second injection — move the step: cut the whole `# ─── Assert the registry …` block plus the step and paste it after "Report the pushed image".
Run: the node assertion.
Expected: FAIL with `FAIL: wrong position: …`. Restore (the step must sit between "Wait for the build Job" and "Report the pushed image"). Re-run: `PASS: …`.

Pipeline-level verification is the operator's, after push: `bash scripts/ci/ci-status.sh <new sha>` (Task 3) must show `build-push` success and the Harbor line `IMAGE_PUBLISHED`; `kubectl -n tenant-internal logs gitea-runner-0 | grep IMAGE_PUBLISHED` (read-only) shows the sentinel. The negative path cannot be exercised on main without deliberately red-flagging a real publish; Task 1's T1b is the coverage for it.

- [ ] **Step 6: Gates**

```bash
grep -q 'localhost:5432' /root/judge-arena/.env.test || { echo 'STOP: .env.test DATABASE_URL is not the local podman judge-arena-pg (localhost:5432)'; exit 1; }
cd /root/judge-arena && npm run lint && npx tsc --noEmit && npm run test:coverage && npm run test:db:coverage && npm run test:integration && npm run build
```

Expected: unchanged from baseline (869 / 670 / 80; lint 0; tsc 0; build ok).

- [ ] **Step 7: Commit**

```bash
git -C /root/judge-arena add .gitea/workflows/ci.yml scripts/ci-local.sh
git -C /root/judge-arena commit -F - <<'EOF'
ci(build-push): assert the Harbor tag after the kaniko Job completes

New step between "Wait for the build Job" and "Report the pushed
image", gated on steps.gate.outputs.publish, running
scripts/ci/assert-harbor-tag.sh judge-arena "$TAG". It prints
`IMAGE_PUBLISHED repo=judge-arena tag=sha-<12> digest=…`, which is the
positive line to grep for in the runner pod log instead of
"🏁 Job succeeded" — that line is printed even after a server-side
cancel (act job_executor.go loses the job error on a cancelled
context; Gitea 1.23.6 CancelPreviousJobs fires on every push).

This is a sentinel for kaniko-said-Complete-but-registry-empty. It
cannot fire for a cancelled run or for a commit that was never the
head of a push, which is what left 60be6f6 / 7f0e0cb / 2c1e85e /
740e7bb without images on 2026-09-01. The pre-promote check is
scripts/ci/ci-status.sh (next commit).

scripts/ci-local.sh: two stale comments corrected (repo "not on
Gitea yet"; publish job called `docker`, "stubbed with Phase-2 TODO").

Gates: lint 0, tsc 0, 869 unit / 670 db / 80 integration, coverage 0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
EOF
```

---

### Task 3: `scripts/ci/ci-status.sh` and the CONTRIBUTING recipe

**Files:**
- Create: `/root/judge-arena/scripts/ci/ci-status.sh`
- Modify: `/root/judge-arena/CONTRIBUTING.md:1372-1382` (append after the paragraph ending "a red job physically blocks the merge button.")
- Test: inline bash against live, public, read-only Gitea + Harbor endpoints

**Interfaces:**
- Consumes: `scripts/ci/assert-harbor-tag.sh` (Task 1; called with `HARBOR_ASSERT_ATTEMPTS=1`); `GET https://gitea.lab.asethi.com/api/v1/repos/trij/judge-arena/actions/tasks?limit=50&page=N` (fields `id, name, head_sha (40 hex), status, run_number, event, run_started_at, updated_at`; `total_count` 127 today); `GET …/commits/<sha>/status` (`state`, `statuses[].context/status/description`; `state: ""` and `statuses: null` for a commit with no run).
- Produces: `bash scripts/ci/ci-status.sh <sha ≥ 12 hex>` — prints the matching tasks, the commit statuses, then the Harbor result; exit 0 image present, 1 image absent, 2 no run for this SHA (prints `NO_RUN sha=…`), 64 bad argument. Task 4's ci.yml header and Task 5's docs cite this command by name.

- [ ] **Step 1: Write the failing test**

```bash
# T3a — cancelled run: task 4816 cancelled, three "Has been cancelled" statuses, no image → exit 1
bash /root/judge-arena/scripts/ci/ci-status.sh 60be6f69d37d; echo "exit=$?"
# expected (after Step 3), verbatim except timestamps:
#   == actions/tasks matching head_sha 60be6f69d37d*
#   4816	run 51	ci	cancelled	push	2026-09-01T15:40:37Z	2026-09-01T15:42:12Z
#   == commits/60be6f69d37d/status
#   state=failure
#   CI / db-tests (push)	failure	Has been cancelled
#   CI / build-push (push)	failure	Has been cancelled
#   CI / ci (push)	failure	Has been cancelled
#   == Harbor
#   (same check by hand: skopeo inspect --no-tags docker://harbor.cluster.asethi.com/homelab/judge-arena:sha-60be6f69d37d)
#   attempt 1/1: HTTP 404 for https://harbor.cluster.asethi.com/api/v2.0/projects/homelab/repositories/judge-arena/artifacts/sha-60be6f69d37d
#   ::error::no Harbor artifact homelab/judge-arena:sha-60be6f69d37d — the kaniko Job reported Complete but nothing is in the registry
#   exit=1

# T3b — never ran (not the head of its push) → NO_RUN, exit 2
bash /root/judge-arena/scripts/ci/ci-status.sh 2c1e85e10145; echo "exit=$?"
# expected:
#   == actions/tasks matching head_sha 2c1e85e10145*
#   (no task — no job for this SHA ever reached a runner)
#   == commits/2c1e85e10145/status
#   state=<none>
#   NO_RUN sha=2c1e85e10145 — this commit was never the head of a push to main (or a PR sync); nothing was built for it
#   exit=2

# T3c — the production image: tasks 4819/4820/4821 success, IMAGE_PUBLISHED, exit 0
bash /root/judge-arena/scripts/ci/ci-status.sh d21f31d47c35; echo "exit=$?"
# expected to contain:
#   4821	run 53	build-push	success	push	…
#   4820	run 53	db-tests	success	push	…
#   4819	run 53	ci	success	push	…
#   state=success
#   IMAGE_PUBLISHED repo=judge-arena tag=sha-d21f31d47c35 digest=sha256:867728348e0315972250b5c522b59430a7af48ecd88600377e24a96956b83a04
#   exit=0

# T3d — short argument refused
bash /root/judge-arena/scripts/ci/ci-status.sh 60be6f6; echo "exit=$?"
# expected: `usage: ci-status.sh <sha> — need 12-40 lowercase hex chars (the Harbor tag is sha-<12>)` and exit=64
```

Note the tasks list is newest-first and paginated at 50; as more runs land, 60be6f6's task moves to a later page — the script walks up to 5 pages (250 tasks), which is why T3a keeps working.

- [ ] **Step 2: Run test to verify it fails**

Run: T3a.
Expected: `bash: /root/judge-arena/scripts/ci/ci-status.sh: No such file or directory`, `exit=127`.

- [ ] **Step 3: Write minimal implementation**

Create `/root/judge-arena/scripts/ci/ci-status.sh`, then `chmod +x`:

```bash
#!/usr/bin/env bash
# ─── Read a commit's CI outcome from Gitea's record, then from Harbor ──────
#
# The runner pod log (`kubectl -n tenant-internal logs gitea-runner-N`)
# prints "🏁 Job succeeded" after a server-side cancel: act v0.261.10's
# job_executor.go swaps in a fresh context.Background() and loses the job
# error. Gitea's own record never lied — it marks the task `cancelled` and
# the commit status "Has been cancelled" (2026-09-01: tasks 4816 and 4818).
# Read THIS, never the pod log. No token is needed: the repo is public.
#
# Surfaces, in order of authority:
#   1. GET /api/v1/repos/trij/judge-arena/actions/tasks — one row per job
#      that reached a runner (id, run_number, status, timestamps). A job that
#      never got a task (build-push behind a cancelled db-tests) is absent
#      here but present in 2.
#   2. GET /api/v1/repos/trij/judge-arena/commits/<sha>/status — per-job
#      commit statuses. EMPTY for a commit that never had a run, which is
#      what a commit that was NOT the head of its push looks like (2c1e85e,
#      740e7bb on 2026-09-01 — they rode inside ba237bd's push).
#   3. Harbor: does judge-arena:sha-<12> exist (assert-harbor-tag.sh).
#
# /actions/runs and /actions/workflows/{file}/dispatches still 404 on Gitea
# 1.23.6, so nothing here can re-run a task or rebuild a superseded SHA;
# only a new push to main (or the web UI's re-run button) does that.
#
# Usage: ci-status.sh <sha>     (12-40 lowercase hex; the tag is sha-<12>)
# Exit:  0 image present · 1 image absent · 2 no run for this SHA · 64 usage
#        any other code = curl/jq failure (Gitea unreachable) — treat as unknown, do not promote
set -euo pipefail

sha="${1:-}"
if ! [[ "$sha" =~ ^[0-9a-f]{12,40}$ ]]; then
  echo "usage: ci-status.sh <sha> — need 12-40 lowercase hex chars (the Harbor tag is sha-<12>)" >&2
  exit 64
fi
gitea="${GITEA_REPO_API:-https://gitea.lab.asethi.com/api/v1/repos/trij/judge-arena}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "== actions/tasks matching head_sha ${sha}*"
task_rows=0
for page in 1 2 3 4 5; do
  body=$(curl -fsS --max-time 20 "${gitea}/actions/tasks?limit=50&page=${page}")
  count=$(jq -r '.workflow_runs | length' <<<"$body")
  [ "$count" -gt 0 ] || break
  rows=$(jq -r --arg sha "$sha" '
    .workflow_runs[]
    | select(.head_sha | startswith($sha))
    | [.id, "run \(.run_number)", .name, .status, .event, (.run_started_at // "-"), .updated_at]
    | @tsv' <<<"$body")
  if [ -n "$rows" ]; then
    printf '%s\n' "$rows"
    task_rows=$((task_rows + $(printf '%s\n' "$rows" | wc -l)))
  fi
done
if [ "$task_rows" -eq 0 ]; then
  echo "(no task — no job for this SHA ever reached a runner)"
fi

echo "== commits/${sha}/status"
status=$(curl -fsS --max-time 20 "${gitea}/commits/${sha}/status")
state=$(jq -r '.state' <<<"$status")
# `.statuses` is null (not []) for a commit that never had a run — verified
# 2026-09-01 on 2c1e85e10145 — hence the `// []`.
status_rows=$(jq -r '(.statuses // [])[] | [.context, .status, .description] | @tsv' <<<"$status")
echo "state=${state:-<none>}"
if [ -n "$status_rows" ]; then
  printf '%s\n' "$status_rows"
fi

if [ "$task_rows" -eq 0 ] && [ -z "$status_rows" ]; then
  echo "NO_RUN sha=${sha} — this commit was never the head of a push to main (or a PR sync); nothing was built for it"
  exit 2
fi

echo "== Harbor"
short="${sha:0:12}"
echo "(same check by hand: skopeo inspect --no-tags docker://harbor.cluster.asethi.com/homelab/judge-arena:sha-${short})"
HARBOR_ASSERT_ATTEMPTS=1 bash "${here}/assert-harbor-tag.sh" judge-arena "sha-${short}"
```

```bash
chmod +x /root/judge-arena/scripts/ci/ci-status.sh
```

Then `CONTRIBUTING.md`. Replace this exact text (the last two lines of the paragraph at :1372-1382):

```markdown
Treat the file's `needs:` chain as the enforced coupling and check the repo settings before assuming
a red job physically blocks the merge button.
```

with:

````markdown
Treat the file's `needs:` chain as the enforced coupling and check the repo settings before assuming
a red job physically blocks the merge button.

> **CORRECTION (2026-09-01).** The sentence above — *"There is no Gitea CLI or API token available
> in this working environment"* — is still true and was still misleading: this repo is public, so
> the read-only Actions endpoints answer **without** a token. Nobody needs the runner pod log to
> read a run's outcome, and the pod log is the one surface that lies (below).

### Reading a run's outcome without a token

```sh
bash scripts/ci/ci-status.sh <sha>      # 12-40 hex; exit 0 image present, 1 absent, 2 no run
```

It reads, in order of authority:

1. `GET https://gitea.lab.asethi.com/api/v1/repos/trij/judge-arena/actions/tasks` — one row per
   job that reached a runner: `id`, `name`, `head_sha`, `status`, `run_number`, timestamps.
   Filter by `head_sha` prefix. **This is the authoritative surface.**
2. `GET …/commits/<sha>/status` — per-job commit statuses. A job that never got a task (e.g.
   `build-push` behind a cancelled `db-tests`) appears here as "Has been cancelled". **Empty
   (`state: ""`, `statuses: null`) means the commit never had a run** — it was not the head of its
   push.
3. Harbor, via `scripts/ci/assert-harbor-tag.sh judge-arena sha-<12>` (anonymous; project
   `homelab` is public). `skopeo inspect --no-tags docker://harbor.cluster.asethi.com/homelab/judge-arena:sha-<12>`
   is the same check by hand.

`/actions/runs` and `/actions/workflows/{file}/dispatches` still 404 on Gitea 1.23.6; re-running a
task is the web UI's button, and rebuilding a superseded SHA takes a new push.

**Rapid successive pushes to `main` cancel each other's runs.** Gitea 1.23.6 calls
`CancelPreviousJobs` on every push to the same ref before it inserts the new run — built in, not
opt-out, and unrelated to the `concurrency:` block in `ci.yml` (inert on this version). The
cancelled run's SHA never gets an image. The runner pod log then prints `this step has been
cancelled: signal: killed` followed by `🏁 Job succeeded` (act v0.261.10 `job_executor.go` swaps in
a fresh context and loses the job error); Gitea's record says `cancelled` throughout. On 2026-09-01
this left `60be6f6` and `7f0e0cb` (cancelled) and `2c1e85e` and `740e7bb` (never the head of a
push) without images. **Before every promote, run `ci-status.sh` on the SHA you intend to promote.**
The in-run `Assert Harbor has sha-<12>` step (`build-push`) is a sentinel for "kaniko said
Complete, registry empty"; it cannot fire for a cancelled run.
````

- [ ] **Step 4: Run test to verify it passes**

Run: T3a, T3b, T3c, T3d.
Expected: as listed in Step 1 (T3a exit 1 with task 4816 `cancelled` and three "Has been cancelled" rows; T3b `NO_RUN`, exit 2; T3c three `success` rows for run 53, `state=success`, `IMAGE_PUBLISHED … digest=sha256:867728348e03…`, exit 0; T3d usage, exit 64).

```bash
bash -n /root/judge-arena/scripts/ci/ci-status.sh && shellcheck /root/judge-arena/scripts/ci/ci-status.sh && echo ok
```

Expected: `ok`.

- [ ] **Step 5: Injection**

Break: in `ci-status.sh` delete the line `    | select(.head_sha | startswith($sha))`.
Run: `bash /root/judge-arena/scripts/ci/ci-status.sh 60be6f69d37d | grep -c $'\trun '`.
Expected: FAIL — `1` before the break (only task 4816's row); `127` today (≥ 50 — every task on every page, e.g. `4817	run 52	ci	success`) after the break, not `1`.
Restore. Second injection: in the `NO_RUN` branch change `  exit 2` to `  exit 0`.
Run: T3b.
Expected: FAIL — `exit=0` instead of `exit=2` (a caller scripting "promote only on 0" would promote a SHA that was never built).
Restore. Third injection: change `status_rows=$(jq -r '(.statuses // [])[] …` back to `status_rows=$(jq -r '.statuses[] …`.
Run: T3b.
Expected: FAIL — `jq: error (at <stdin>:1): Cannot iterate over null (null)` and `exit=5` before the `NO_RUN` line (this is the defect the `// []` exists for; Gitea returns `statuses: null`, not `[]`, for a commit with no run).
Restore. Re-run T3a-T3d: green.

- [ ] **Step 6: Gates**

```bash
grep -q 'localhost:5432' /root/judge-arena/.env.test || { echo 'STOP: .env.test DATABASE_URL is not the local podman judge-arena-pg (localhost:5432)'; exit 1; }
cd /root/judge-arena && npm run lint && npx tsc --noEmit && npm run test:coverage && npm run test:db:coverage && npm run test:integration && npm run build
```

Expected: unchanged from baseline.

- [ ] **Step 7: Commit**

```bash
git -C /root/judge-arena add scripts/ci/ci-status.sh CONTRIBUTING.md
git -C /root/judge-arena commit -F - <<'EOF'
ci(status): read a commit's outcome from Gitea's record, not the pod log

scripts/ci/ci-status.sh <sha> reads GET /actions/tasks (200 without a
token; per-task id/status/run_number, filtered by head_sha prefix,
walking up to 5 pages), then commits/<sha>/status, then asks Harbor
for sha-<12> via assert-harbor-tag.sh. Exit 0 image present, 1
absent, 2 no run (`NO_RUN` — the commit was not the head of its
push), 64 usage.

Verified live: 60be6f69d37d → task 4816 cancelled, three "Has been
cancelled" statuses, Harbor 404; 2c1e85e10145 → no task, empty
statuses, NO_RUN; d21f31d47c35 → run 53 all success, IMAGE_PUBLISHED.

CONTRIBUTING: CORRECTION under "What actually gates a merge" — the
"no Gitea CLI or API token" sentence was true and misleading; the
public read endpoints need neither. Adds the recipe, the rule that
rapid pushes to main cancel each other's runs (Gitea 1.23.6
CancelPreviousJobs, not the inert `concurrency:` block), and the
pre-promote check.

Gates: lint 0, tsc 0, 869 unit / 670 db / 80 integration, coverage 0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
EOF
```

---

### Task 4: `ci.yml` comment corrections (header, `concurrency:`, reap step)

**Files:**
- Modify: `/root/judge-arena/.gitea/workflows/ci.yml` — header (insert after :55, before the `scripts/ci-local.sh` paragraph at :57), `concurrency:` block (:90-92), reap-step comment (:379-394)
- Test: inline grep + js-yaml parse

**Interfaces:**
- Consumes: the step name `Assert Harbor has ${{ steps.tag.outputs.tag }}` and the `IMAGE_PUBLISHED` sentinel (Task 2); `scripts/ci/ci-status.sh` (Task 3).
- Produces: nothing executable. The corrected comments are what the next reader of a cancelled run sees first.

- [ ] **Step 1: Write the failing test**

```bash
cd /root/judge-arena && f=.gitea/workflows/ci.yml && \
  [ "$(grep -c 'CancelPreviousJobs' "$f")" -ge 3 ] && \
  grep -q 'never the pod log' "$f" && \
  grep -q 'INERT on Gitea 1.23.6' "$f" && \
  grep -q 'do NOT run after a server-side cancel' "$f" && \
  ! grep -q '`concurrency.cancel-in-progress: true` is set at the top of this' "$f" && \
  node -e "require('js-yaml').load(require('fs').readFileSync('$f','utf8')); console.log('yaml-ok')" && \
  echo PASS || echo FAIL
```

- [ ] **Step 2: Run test to verify it fails**

Run: the command above.
Expected: `FAIL` (today `CancelPreviousJobs` occurs 0 times; the reap comment still attributes the cancel to `concurrency.cancel-in-progress`).

- [ ] **Step 3: Write minimal implementation**

Edit 1 — header. Replace this exact text (ci.yml:55-57):

```yaml
# things about coverage, and only one of them is a flake.
#
#   `scripts/ci-local.sh` runs the full sequence INCLUDING the DB and
```

with:

```yaml
# things about coverage, and only one of them is a flake.
#
# HOW TO READ A RUN'S OUTCOME — AND THE ONE SURFACE THAT LIES (2026-09-01).
# Gitea 1.23.6 calls CancelPreviousJobs on every push to the same ref
# (services/actions/notifier_helper.go) before it inserts the new run.
# Built in, not opt-out, and nothing to do with the `concurrency:` block
# below. The cancelled task is StopTask'd server-side; act_runner cancels
# the job context; act v0.261.10 then prints, in the RUNNER POD LOG only:
#
#   ❌ Failure - Main <step>
#   this step has been cancelled: signal: killed
#   🏁 Job succeeded
#
# The last line is an act bug (pkg/runner/job_executor.go replaces the
# cancelled context with a fresh context.Background() that has no job-error
# container, so JobError() is nil and the result is logged as success; act
# main still does this). Gitea ignores that report — the task is already
# Done — and its record says `cancelled` / "Has been cancelled" throughout.
# Seen twice on 2026-09-01: task 4816 (60be6f6, `ci`, step Build) and task
# 4818 (7f0e0cb, `db-tests`, a kubectl polling loop — no Node process, so
# not memory). Neither SHA got an image; nor did 2c1e85e / 740e7bb, which
# were never the head of a push and never had a run at all.
#
# So: read a run's outcome from `scripts/ci/ci-status.sh <sha>` (the
# actions/tasks + commit-status APIs, no token) or from the positive
# `IMAGE_PUBLISHED repo=… tag=… digest=…` sentinel the build-push job
# prints — never the pod log's "Job succeeded". And assert the Harbor tag
# for the SHA you intend to promote; a cancelled run never reaches the
# in-run assert step.
#
#   `scripts/ci-local.sh` runs the full sequence INCLUDING the DB and
```

Edit 2 — `concurrency:`. Replace this exact text (ci.yml:88-92):

```yaml
  workflow_dispatch:

concurrency:
  group: ci-judge-arena-${{ github.ref }}
  cancel-in-progress: true
```

with:

```yaml
  workflow_dispatch:

# INERT on Gitea 1.23.6 (2026-09-01): models/actions/run.go at that version
# has no Concurrency field, so this block is parsed and ignored. The
# cancel-on-new-push behaviour this LOOKS like it provides comes from the
# server's built-in CancelPreviousJobs (see the header) and cannot be opted
# out of. Kept because it becomes live on a Gitea upgrade and then asks for
# the same behaviour the server already imposes — do not attribute a
# cancellation to it.
concurrency:
  group: ci-judge-arena-${{ github.ref }}
  cancel-in-progress: true
```

Edit 3 — reap-step comment. Replace this exact text (ci.yml:379-394):

```yaml
      # ─── Reap the Job if we are leaving while it still runs ────────────
      # `concurrency.cancel-in-progress: true` is set at the top of this
      # file, so a second push to the same ref kills this workflow mid-wait
      # — and the spawned Job does NOT die with it. It keeps a pod holding
      # ~1.7Gi of memory requests plus 9.25Gi of ephemeral-storage ceilings
      # in tenant-builds until activeDeadlineSeconds (30m) expires. Same
      # applies to the 25m-deadline path above.
      #
      # ONLY reaps a Job that is still ACTIVE. A Job that finished — passed
      # or failed — is left for ttlSecondsAfterFinished (1h) so its pod
      # stays inspectable; the failure path above dumps logs, but a pod you
      # can still `kubectl describe` is worth more than a log tail.
      #
      # `always()` rather than `failure()`: cancellation is the case this
      # exists for, and a cancelled job runs neither `success()` nor
      # `failure()` steps.
```

with:

```yaml
      # ─── Reap the Job if we are leaving while it still runs ────────────
      # Covers the 25m-deadline path above and any ordinary step failure:
      # the spawned Job does NOT die with the workflow. It keeps a pod
      # holding ~1.7Gi of memory requests plus 9.25Gi of ephemeral-storage
      # ceilings in tenant-builds until activeDeadlineSeconds (30m) expires.
      #
      # ONLY reaps a Job that is still ACTIVE. A Job that finished — passed
      # or failed — is left for ttlSecondsAfterFinished (1h) so its pod
      # stays inspectable; the failure path above dumps logs, but a pod you
      # can still `kubectl describe` is worth more than a log tail.
      #
      # CORRECTION (2026-09-01). This comment used to say the cancel came
      # from `concurrency.cancel-in-progress: true` and that `always()` was
      # chosen because "cancellation is the case this exists for". Both
      # wrong. The cancel is Gitea 1.23.6's built-in CancelPreviousJobs (the
      # `concurrency:` block is inert on that version), and `if: always()`
      # steps do NOT run after a server-side cancel: act SIGKILLs the
      # current step (exec.CommandContext) and goes straight to container
      # cleanup — task 4818's log (7f0e0cb, 2026-09-01 15:56:32Z) shows
      # "Wait for the DB-test Job" killed, then "Cleaning up container",
      # then "🏁 Job succeeded", with no reap line between. So a run
      # cancelled by the next push to main LEAKS its DB-test Job to the 30m
      # activeDeadlineSeconds. There is no in-run fix — SIGKILL cannot be
      # trapped — which is one more reason not to push twice to main within
      # a run's duration. `always()` is still right for the failure paths
      # it does cover.
```

- [ ] **Step 4: Run test to verify it passes**

Run: the Step 1 command.
Expected: `yaml-ok` then `PASS`.

Also re-run Task 2's node assertion (the step must still be present and positioned) → `PASS: assert step present, positioned, gated`.

- [ ] **Step 5: Injection**

Break: in Edit 3 change `steps do NOT run after a server-side cancel` to `steps DO run after a server-side cancel`.
Run: the Step 1 command.
Expected: `FAIL` (the `do NOT run after a server-side cancel` grep misses).
Restore; re-run → `PASS`. This is a documentation task: the injection proves the assertion is anchored to the corrected claim, not that the workflow behaves differently.

- [ ] **Step 6: Gates**

```bash
grep -q 'localhost:5432' /root/judge-arena/.env.test || { echo 'STOP: .env.test DATABASE_URL is not the local podman judge-arena-pg (localhost:5432)'; exit 1; }
cd /root/judge-arena && npm run lint && npx tsc --noEmit && npm run test:coverage && npm run test:db:coverage && npm run test:integration && npm run build
```

Expected: unchanged from baseline.

- [ ] **Step 7: Commit**

```bash
git -C /root/judge-arena add .gitea/workflows/ci.yml
git -C /root/judge-arena commit -F - <<'EOF'
docs(ci): the false green was a cancelled run, not an OOM — say so in ci.yml

Header: how to read a run's outcome, and why "🏁 Job succeeded" in the
runner pod log after "this step has been cancelled: signal: killed"
means a server-side cancel (Gitea 1.23.6 CancelPreviousJobs on the
next push; act v0.261.10 job_executor.go loses the job error on a
cancelled context). Seen on tasks 4816 (60be6f6, Build) and 4818
(7f0e0cb, db-tests' kubectl loop — no Node process). Read
scripts/ci/ci-status.sh or the IMAGE_PUBLISHED sentinel instead.

`concurrency:` annotated as inert on 1.23.6 (no Concurrency field in
models/actions/run.go); kept for a future upgrade.

Reap-step comment CORRECTED: the cancel is not concurrency.cancel-in-
progress, and `if: always()` steps do not run after a server-side
cancel (act SIGKILLs the step and skips to cleanup — task 4818's log
has no reap line), so a cancelled db-tests run leaks its Job to the
30m activeDeadlineSeconds. No in-run fix exists.

Nothing in the workflow swallows failures (no continue-on-error; every
`|| true` is forensic). No runner/NODE_OPTIONS change: restartCount 0,
no OOMKilled lastState, and the second occurrence had no Node process.

Gates: lint 0, tsc 0, 869 unit / 670 db / 80 integration, coverage 0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
EOF
```

---

### Task 5: CORRECTION notes in the handoff, the register and the spec

**Files:**
- Modify: `/root/judge-arena/docs/superpowers/plans/2026-09-01-scoreboard-handoff.md:263-268` (trap 3) and `:314` (§7 #6)
- Modify: `/root/judge-arena/docs/superpowers/plans/2026-08-30-state-and-next-steps.md:448-458` (§5.6 item 11)
- Modify: `/root/judge-arena/docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md:527-529` (§5.5 heading) and `:573-578` (fix table)
- Test: inline grep

**Interfaces:**
- Consumes: `scripts/ci/ci-status.sh` (Task 3), the `Assert Harbor has …` step and `IMAGE_PUBLISHED` sentinel (Task 2).
- Produces: nothing executable.

- [ ] **Step 1: Write the failing test**

```bash
cd /root/judge-arena && \
  h=docs/superpowers/plans/2026-09-01-scoreboard-handoff.md && \
  r=docs/superpowers/plans/2026-08-30-state-and-next-steps.md && \
  s=docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md && \
  [ "$(grep -c 'CORRECTION (2026-09-01)' "$h")" -ge 2 ] && \
  [ "$(grep -c 'CORRECTION (2026-09-01)' "$r")" -ge 1 ] && \
  [ "$(grep -c 'CORRECTION (2026-09-01)' "$s")" -ge 1 ] && \
  grep -q 'CancelPreviousJobs' "$h" && grep -q 'CancelPreviousJobs' "$r" && grep -q 'CancelPreviousJobs' "$s" && \
  ! grep -q '^| make the job fail when a step fails |' "$s" && \
  grep -q 'ci-status.sh' "$h" && \
  echo PASS || echo FAIL
```

- [ ] **Step 2: Run test to verify it fails**

Run: the command above.
Expected: `FAIL` (none of the three files contains `CORRECTION (2026-09-01)` today).

- [ ] **Step 3: Write minimal implementation**

Edit 1 — handoff trap 3. Replace this exact text (handoff :267-269):

```markdown
   pushed-not-built. Marginal rather than systematic — the same build passed 70 minutes earlier and
   again on retry — which is what makes it read as flaky CI.
4. **Verify the artifact, not the source tree.**
```

with:

```markdown
   pushed-not-built. Marginal rather than systematic — the same build passed 70 minutes earlier and
   again on retry — which is what makes it read as flaky CI.

   > **CORRECTION (2026-09-01).** The cause stated above — *"`next build` was OOM-killed against
   > the runner's `limits.memory: 4Gi`"* — is wrong, and so is *"CI reports `🏁 Job succeeded`"*.
   > The run for `60be6f6` (run 51, task 4816) was **cancelled server-side by the next push**:
   > Gitea 1.23.6 calls `CancelPreviousJobs` on every push to the same ref, and `7f0e0cb` was
   > authored 28 s before the kill. `this step has been cancelled: signal: killed` is the string act
   > v0.261.10 prints only when the step's context is cancelled — never on a kernel OOM — and the
   > `🏁 Job succeeded` that follows it appears in the **runner pod log only** (act's
   > `job_executor.go` swaps in a fresh context and loses the job error). Gitea's own record was
   > never green: task `cancelled`, all three commit statuses "Has been cancelled". The runner had
   > `restartCount 0` and no `OOMKilled` state, and the identical signature recurred at 15:56:32Z
   > on task 4818 (`7f0e0cb`, job `db-tests`, a kubectl polling loop with no Node process), 8 s
   > after `d21f31d` was authored (15:56:24Z). `2c1e85e` and `740e7bb` have no image for a different reason:
   > they were never the head of a push and never had a run. "Passed again on retry" is also
   > wrong — `d21f31d` was a new push whose run was simply not cancelled; `60be6f6` was never
   > rebuilt. What stands: a green-looking pod log is not evidence of an image. What changed: read
   > `bash scripts/ci/ci-status.sh <sha>` (tasks + commit-status APIs, no token, then Harbor)
   > before every promote; `build-push` now prints `IMAGE_PUBLISHED …` after asserting the tag.
   > Do not retune the runner or `NODE_OPTIONS` on this evidence. Detail: spec §5.5 correction.
4. **Verify the artifact, not the source tree.**
```

Edit 2 — handoff §7 #6. Replace this exact line (handoff :314):

```markdown
6. **CI's false green** (trap 3). Make the job fail when a step fails *first*; the OOM is secondary.
```

with:

```markdown
6. **CI's false green** (trap 3) — **CORRECTION (2026-09-01)**, same day: the item as written —
   *"Make the job fail when a step fails first; the OOM is secondary"* — assumed a YAML defect and
   an OOM, and there was neither (trap 3 correction). Done as far as this repo can do it. What landed:
   `scripts/ci/assert-harbor-tag.sh` + an `Assert Harbor has sha-<12>` step in `build-push`,
   `scripts/ci/ci-status.sh <sha>` as the pre-promote read, and comment/doc corrections. Still
   open, and not in this repo: nothing watches pushed-not-built out-of-band (a cancelled run never
   reaches the assert step) — a homelab-setup exporter comparing Gitea `main` HEAD to Harbor tags
   would be the shape that catches it.
```

Edit 2b — handoff §8 step 4. Replace this exact text (handoff :354-355):

```sh
# 4. Confirm main has an image in Harbor. Green CI does not mean this. (trap 3/4)
skopeo inspect --no-tags \
```

with:

```sh
# 4. Confirm main has an image in Harbor. Green CI does not mean this. (trap 3/4)
# CORRECTION (2026-09-01): read Gitea's record first — exit 2 = never ran, 1 = ran, no image.
bash /root/judge-arena/scripts/ci/ci-status.sh $(git -C /root/judge-arena rev-parse main)
skopeo inspect --no-tags \
```

Edit 3 — register §5.6 item 11. Replace this exact text (register :457-458):

```markdown
   invariant that closes all three is one `skopeo inspect` asserting a tag for the pushed SHA.
   Detail: scoreboard spec §5.5.
```

with:

```markdown
   invariant that closes all three is one `skopeo inspect` asserting a tag for the pushed SHA.
   Detail: scoreboard spec §5.5.

   > **CORRECTION (2026-09-01).** *"`next build` was OOM-killed"* and *"the job still printed
   > `🏁 Job succeeded`"* — the first is false and the second is true only of the runner pod log.
   > Run 51 (task 4816) was cancelled by Gitea 1.23.6's built-in `CancelPreviousJobs` when
   > `7f0e0cb` was pushed 28 s later; act v0.261.10 prints `this step has been cancelled: signal:
   > killed` only on a cancelled context and then logs a spurious `🏁 Job succeeded` from a fresh
   > context that has lost the job error. Gitea's record said `cancelled` / "Has been cancelled"
   > throughout; the runner never restarted or OOMKilled; the same signature hit task 4818
   > (`7f0e0cb`, `db-tests`, no Node process) at 15:56:32Z. Of the two fixes proposed above, the
   > first was not needed (nothing in `ci.yml` swallows a failure) and the second addresses an
   > event that did not happen. Landed instead: `scripts/ci/assert-harbor-tag.sh` behind a new
   > `build-push` step, `scripts/ci/ci-status.sh <sha>` for the pre-promote read, and this note's
   > siblings in the handoff and spec §5.5.
```

Edit 4 — spec §5.5 heading. Replace this exact text (spec :527-529):

```markdown
## 5.5 CI reported SUCCESS on a build that was OOM-killed, and nothing else would have caught it

Observed 2026-09-01 while trying to promote the §5.3 fix. The runner log, verbatim:
```

with:

```markdown
## 5.5 CI reported SUCCESS on a build that was OOM-killed, and nothing else would have caught it

> **CORRECTION (2026-09-01).** Same day. The heading and the interpretation below are wrong; the
> quoted log is exact. The build was not OOM-killed — the run was **cancelled by the next push**.
> Gitea 1.23.6 calls `CancelPreviousJobs(repo, ref, workflow, event)` on every push to the same ref
> before inserting the new run (`services/actions/notifier_helper.go`); `7f0e0cb` was authored at
> 15:41:44Z and the kill landed at 15:42:12Z. act v0.261.10 emits `this step has been cancelled: %w`
> only inside `select { case <-ctx.Done(): … }` (`pkg/container/host_environment.go`) — a kernel
> OOM does not close `ctx.Done()` — and its `job_executor.go` then replaces the cancelled context
> with a fresh `context.Background()` that carries no job-error container, so `JobError()` is nil
> and `🏁 Job succeeded` is logged. **Only the runner pod log says that.** Gitea ignored the report
> (the task was already Done) and its record for `60be6f6` is task 4816 `cancelled`, run 51, all
> three commit statuses "Has been cancelled". The runner container: `restartCount 0`, no
> `OOMKilled`, same pod since 15:27:13Z. And the identical signature recurred at 15:56:32Z on task
> 4818 — `7f0e0cb`, job `db-tests`, step "Wait for the DB-test Job", a kubectl polling loop with no
> Node process — 8 s after `d21f31d` was authored; that rules out memory without any argument about
> Next.js. `2c1e85e` and `740e7bb` have no image because they were never the head of a push (runs
> 50-55 are exactly 414e826, 60be6f6, 7f0e0cb, d21f31d, ba237bd, fc9e936). "Passed again on retry"
> is also wrong: `d21f31d` was a new push whose run was not cancelled; `60be6f6` was never rebuilt.
> The CPU-count paragraph is true in general and irrelevant here — and Next 15.5.22 strips
> `--max-old-space-size` from its static workers (`isolatedMemory: true`), so `NODE_OPTIONS` never
> bounded them anyway. Neither the runner's 4Gi nor `NODE_OPTIONS` should be retuned on this
> evidence. What is right below: nothing watches pushed-not-built, `BuildPromoteLag` is the wrong
> shape, and the family resemblance to `e4b9948`. The fix table at the end is replaced.

Observed 2026-09-01 while trying to promote the §5.3 fix. The runner log, verbatim:
```

Edit 5 — spec fix table. Replace this exact text (spec :573-578):

```markdown
Two fixes are available and they are not alternatives — the first is the real one:

| fix | what it addresses |
|---|---|
| make the job fail when a step fails | the false-green. Until this lands, a green CI run is not evidence that an image exists. |
| raise the runner limit, or bound Next's build workers | the OOM itself. 4 Gi is marginal on a 16-core node. |
```

with:

```markdown
What was done (2026-09-01; replaces the table that stood here — *"make the job fail when a step
fails"* / *"raise the runner limit, or bound Next's build workers"* — both of which addressed things
that had not happened, per the correction at the top of this section):

| change | what it addresses |
|---|---|
| `scripts/ci/ci-status.sh <sha>` — `actions/tasks` + `commits/<sha>/status` (no token), then Harbor | the reading rule: Gitea's record, never the runner pod log. Exit 2 = never ran (not the head of a push); exit 1 = ran, no image. **Run before every promote.** |
| `scripts/ci/assert-harbor-tag.sh` + the `Assert Harbor has sha-<12>` step in `build-push`, printing `IMAGE_PUBLISHED repo=… tag=… digest=…` | kaniko-said-Complete-but-registry-empty (never observed; cheap). Cannot fire for a cancelled run. |
| `ci.yml` comments: `CancelPreviousJobs` mechanism; `concurrency:` inert on 1.23.6; `if: always()` reap step does not run after a cancel | the next reader of a `signal: killed` / `Job succeeded` pair |
| **not done, out of repo:** an out-of-band pushed-not-built exporter (Gitea `main` HEAD vs Harbor tags) | the only shape that would have caught `60be6f6` |
```

- [ ] **Step 4: Run test to verify it passes**

Run: the Step 1 command.
Expected: `PASS`.

- [ ] **Step 5: Injection**

Break: in Edit 5 change the row `| **not done, out of repo:** …` back to the original `| make the job fail when a step fails | the false-green. …` row.
Run: the Step 1 command.
Expected: `FAIL` (the `! grep -q '^| make the job fail when a step fails |'` guard trips).
Restore; re-run → `PASS`. Documentation task: the injection proves the check is anchored to the replaced claim.

- [ ] **Step 6: Gates**

```bash
grep -q 'localhost:5432' /root/judge-arena/.env.test || { echo 'STOP: .env.test DATABASE_URL is not the local podman judge-arena-pg (localhost:5432)'; exit 1; }
cd /root/judge-arena && npm run lint && npx tsc --noEmit && npm run test:coverage && npm run test:db:coverage && npm run test:integration && npm run build
```

Expected: unchanged from baseline.

- [ ] **Step 7: Commit**

```bash
git -C /root/judge-arena add \
  docs/superpowers/plans/2026-09-01-scoreboard-handoff.md \
  docs/superpowers/plans/2026-08-30-state-and-next-steps.md \
  docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md
git -C /root/judge-arena commit -F - <<'EOF'
docs(ci): correction — the 2026-09-01 false green was a cancelled run, not an oom

Handoff §6 trap 3 and §7 #6, register §5.6 item 11, and spec §5.5 all
recorded "next build was OOM-killed against 4Gi and CI reported
success". Verified instead: Gitea 1.23.6 CancelPreviousJobs cancelled
run 51 (task 4816, 60be6f6) 28 s after 7f0e0cb was pushed and run 52's
db-tests (task 4818) 8 s after d21f31d; act v0.261.10 prints "this
step has been cancelled: signal: killed" only on a cancelled context
and then a spurious "🏁 Job succeeded" from a fresh context, in the
runner pod log only. Gitea's record said cancelled throughout. No
restart, no OOMKilled. 2c1e85e and 740e7bb never had a run (not the
head of their push). "Passed again on retry" was a new push, not a
retry.

Each file keeps its original wording and carries an explicit
CORRECTION note per CONTRIBUTING's convention; the spec's fix table
is replaced with what actually landed (ci-status.sh, the Harbor
assert step, the ci.yml comments) and what remains open out of repo.

Gates: lint 0, tsc 0, 869 unit / 670 db / 80 integration, coverage 0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
EOF
```

---

## After the last commit (operator, not the executor)

1. `git -C /root/judge-arena log --oneline fc9e936..HEAD` → exactly five commits, in the task order above.
2. Push to main is the operator's call. It fires one run; **do not push anything else for ~8 minutes** (ci ~2 min, db-tests ~2.5 min, build-push ~3.5 min today) or the run is cancelled and the new SHA gets no image.
3. Then: `bash /root/judge-arena/scripts/ci/ci-status.sh $(git -C /root/judge-arena rev-parse main)` → three `success` tasks and `IMAGE_PUBLISHED … tag=sha-<12>`, exit 0. Read-only pod-log confirmation: `kubectl -n tenant-internal logs gitea-runner-0 --tail=400 | grep IMAGE_PUBLISHED` (or runner-1 — whichever took the task).
4. Promotion is a separate homelab-setup PR; this plan does not change what runs in production.

## Open questions (recorded, not blocking)

1. **7f0e0cb's db-tests pod sat Pending for 9 minutes** (15:44:23Z → 15:53:27Z, then Running until cancelled at 15:56:32Z). `tenant-builds` has no ResourceQuota or LimitRange and the events have expired. That delay is why a normally-2m32s job was still in flight 12 minutes later and got cancelled. Separate defect from #6; needs a homelab look at scheduling in tenant-builds.
2. **Why was gitea-runner-0 recreated at 15:27:13Z on w-gharial?** Not a rollout (both pods on revision gitea-runner-64b49769bf, generation 6 = observed 6), not a container restart. Divergence entry 64's emptyDir eviction is the plausible candidate; kubelet/node logs, not this repo.
3. **Out-of-band pushed-not-built alert.** The in-run step cannot fire for a cancelled run; only an exporter comparing Gitea `main` HEAD to Harbor tags (extend build-lag-exporter) catches `60be6f6`'s shape. Separate PR in /root/homelab-setup if wanted.
4. **`workflow_dispatch` with an input SHA so a superseded commit can be rebuilt without a new commit.** The gate at ci.yml:459-467 and the re-derived assert at :535-541 both require `event_name == push`; loosening them is a change to the "never publish from a PR" guarantee and wants its own plan and owner decision. Not done here.
5. **Keep the inert `concurrency:` block?** Kept and annotated (Task 4). It becomes live on a Gitea upgrade and then requests the behaviour the server already imposes; harmless.
6. **Memory file** `~/.claude/projects/-/memory/judge-arena-green-ci-is-not-an-image.md` still carries the OOM cause and tells readers to use the pod log — the orchestrator owns that fix; out of scope here.
