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
