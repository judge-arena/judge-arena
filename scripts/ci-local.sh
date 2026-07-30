#!/usr/bin/env bash
# ─── Judge Arena — local CI equivalence (Task 17, 1b plan) ──────────────────
#
# Runs the EXACT shell sequence .gitea/workflows/ci.yml runs, step for step,
# against already-running local podman services (postgres/redis/rabbitmq on
# localhost — see CONTRIBUTING.md's "Development Setup"). The repo isn't
# hosted on Gitea yet (that's Phase 2 of the 1b plan) and the Gitea runner
# itself currently has no Docker/container engine to execute the
# `services:` block the workflow declares (see that file's header comment)
# — so THIS script passing, end to end, from a clean `npm ci`, IS what
# "CI green" means until both of those land.
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

# Docker/Kaniko image build + Harbor push and the docker-compose
# scale-validation smoke check are NOT part of this script — they're
# CI-only steps (.gitea/workflows/ci.yml's `docker` job), both currently
# stubbed with Phase-2 TODO markers there. Task 16 already proved the
# image/compose scale-up locally via podman; this script's job stops at
# `build`, matching the brief's step list exactly.

printf "\n${GREEN}${BOLD}CI-local: ALL GREEN${RESET} — lint, tsc, migrate deploy, v1 db seed, unit, db, integration, and build all passed.\n"
