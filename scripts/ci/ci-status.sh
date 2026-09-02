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
