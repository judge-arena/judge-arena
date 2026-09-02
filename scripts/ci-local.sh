#!/usr/bin/env bash
# ─── Judge Arena — local CI equivalence (Task 17, 1b plan) ──────────────────
#
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
#
# Prerequisites (not started by this script — it fails fast with a clear
# message if any are missing):
#   - Postgres 16 on localhost:5432 (user judge_arena / password password —
#     matches .env.test exactly)
#   - Redis 7 on localhost:6379
#   - RabbitMQ 3.13 (AMQP) on localhost:5672
#   podman run commands for all three are in CONTRIBUTING.md's Deployment
#   section / docker-compose.yml.
#
# Usage: bash scripts/ci-local.sh

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

GREEN='\033[0;32m'
RED='\033[0;31m'
BOLD='\033[1m'
RESET='\033[0m'

step_num=0
total_steps=11
step() {
  step_num=$((step_num + 1))
  printf "\n${BOLD}==> [%d/%d] %s${RESET}\n" "$step_num" "$total_steps" "$1"
}

fail() {
  printf "${RED}✗ %s${RESET}\n" "$1" >&2
  exit 1
}

# ─── Preflight: services reachable on localhost ────────────────────────────
# Pure-bash TCP probe (bash's /dev/tcp pseudo-device) — no extra binaries
# required, keeps this script portable to whatever's on PATH.
check_tcp() {
  local host=$1 port=$2 name=$3
  if ! (exec 3<>"/dev/tcp/${host}/${port}") 2>/dev/null; then
    fail "$name not reachable at ${host}:${port}. Start it first — see CONTRIBUTING.md's Development Setup / docker-compose.yml for the podman run commands."
  fi
  exec 3<&- 2>/dev/null || true
  exec 3>&- 2>/dev/null || true
}

step "Preflight: postgres/redis/rabbitmq reachable on localhost"
check_tcp localhost 5432 postgres
check_tcp localhost 6379 redis
check_tcp localhost 5672 rabbitmq
echo "postgres:5432 redis:6379 rabbitmq:5672 all reachable"

# ─── 1. npm ci ──────────────────────────────────────────────────────────────
step "npm ci"
npm ci

# ─── 2. Generate v1 (importer) Prisma client ───────────────────────────────
# Without this, `tsc --noEmit` fails outright — scripts/importer/{context,
# artifacts,runs}.ts and tests/importer/helpers.ts import '@prisma/v1-client'
# directly, and it's a generated-only package (never checked into git,
# node_modules is gitignored, and package.json's `postinstall` only
# generates the DEFAULT (v2) client, not this one). Verified at Task 17
# authoring time: removing the generated client reproduces exactly this
# TS2307 failure in exactly those files.
step "Generate v1 (importer) Prisma client"
npm run db:generate:v1

# ─── 3. Lint ────────────────────────────────────────────────────────────────
step "Lint (eslint)"
npm run lint

# ─── 4. Type check ──────────────────────────────────────────────────────────
step "Type check (tsc --noEmit)"
npx tsc --noEmit

# ─── 5. Migrations ──────────────────────────────────────────────────────────
# `prisma migrate deploy` (NOT `db push`) — the same command
# docker-compose.yml's `migrate` one-shot service runs in production.
step "Prisma migrate deploy (v2 schema — production mechanism)"
sh -c 'set -a; . ./.env.test; set +a; npx prisma migrate deploy'

# The importer's DB-backed tests (tests/importer/*.db.test.ts, part of the
# 281-test test:db suite) need a SECOND database seeded with the frozen v1
# schema — not touched by `prisma migrate reset` (that only knows about
# DATABASE_URL/the v2 schema). `prisma db push` against a URL whose database
# doesn't exist yet auto-creates it (verified at authoring time), and is a
# harmless no-op ("already in sync") on repeat runs — safe to always run.
step "Seed v1 scratch DB (importer DB tests)"
npm run db:push:v1

# ─── 6-8. Tests: unit -> db -> integration ─────────────────────────────────
# Unit + db runs use the *:coverage variants so a real coverage regression
# fails this script the same way it fails CI (vitest.config.ts /
# vitest.db.config.ts thresholds — Task 17's coverage gate). test:integration
# stays plain; see CONTRIBUTING.md's "Test coverage" section for why that
# suite isn't coverage-gated.
step "Unit tests (npm test, + coverage gate) — expect 361 passed"
npm run test:coverage

step "DB tests (npm run test:db, + coverage gate) — expect 281 passed"
npm run test:db:coverage

step "Integration tests (npm run test:integration) — expect 73 passed"
npm run test:integration

# ─── 9. Build ───────────────────────────────────────────────────────────────
step "Build (npm run build)"
DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder" \
NEXTAUTH_SECRET="build-time-placeholder-secret-16" \
NEXTAUTH_URL="http://localhost:3000" \
npm run build

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

printf "\n${GREEN}${BOLD}CI-local: ALL GREEN${RESET} — lint, tsc, migrate deploy, v1 db seed, unit, db, integration, and build all passed.\n"
