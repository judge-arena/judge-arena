# Contributing to Judge Arena

Thanks for your interest! This guide covers the repo layout, conventions, and concrete recipes for the most common types of contributions.

---

## Table of Contents

1. [Development Setup](#development-setup)
2. [Running the Tests](#running-the-tests)
3. [Testing Conventions](#testing-conventions)
4. [Project Structure at a Glance](#project-structure-at-a-glance)
5. [Conventions](#conventions)
6. [Adding a New LLM Provider](#adding-a-new-llm-provider)
7. [Adding a New UI Component](#adding-a-new-ui-component)
8. [Adding a New API Route](#adding-a-new-api-route)
9. [Adding a New Page](#adding-a-new-page)
10. [Extending the Database Schema](#extending-the-database-schema)
11. [API wire-format changes (v2, 1a)](#api-wire-format-changes-v2-1a)
12. [API wire-format changes (v2, 1b Task 12)](#api-wire-format-changes-v2-1b-task-12)
13. [Content Security Policy (CSP) script nonces](#content-security-policy-csp-script-nonces-task-14)
14. [Modifying the Rubric / Evaluation Flow](#modifying-the-rubric--evaluation-flow)
15. [Adding a Keyboard Shortcut](#adding-a-keyboard-shortcut)
16. [Expansion Ideas](#expansion-ideas)
17. [Deployment: production (judgearena.com)](#deployment-production-judgearenacom)
18. [Deployment: Docker Compose v2](#deployment-docker-compose-v2-task-16)
19. [Continuous Integration](#continuous-integration-task-17)
20. [Pull Request Guidelines](#pull-request-guidelines)

*(Entries 12, 13, 16 and 20 were missing from this list until 2026-08-29 — the sections existed,
the contents page did not name them.)*

---

## Development Setup

> **CORRECTION (2026-08-29).** Every previous version of this section said *"The database is SQLite
> (`prisma/dev.db`). You can wipe it and re-seed at any time: `rm prisma/dev.db && npm run db:push
> && npm run db:seed`."* **That has been false since the v2 migration (1a), and it contradicted the
> rest of this same document** — [Extending the Database Schema](#extending-the-database-schema)
> already said the project runs Postgres with checked-in migrations. Checked against the tree:
> `prisma/schema.prisma`'s datasource is `provider = "postgresql"`; `.env.example`, `.env.test` and
> `docker-compose.yml` all carry `postgresql://` URLs; there is no `prisma/dev.db` file and a
> case-insensitive `grep` for `sqlite` across `src/`, `prisma/`, `scripts/` and the workflow files
> returns nothing. **The database is PostgreSQL 16.** The old recipe is not merely dated — running
> `db push` against a migrated database is the wrong verb here (see the schema section).

```bash
git clone ssh://git@10.10.0.211/trij/judge-arena.git judge-arena && cd judge-arena
cp .env.example .env.local    # .env.example's own header says .env.local — see trap (a)
npm install                   # `postinstall` runs `prisma generate` (v2 client) for you
npm run db:generate:v1        # the SECOND Prisma client, for the importer — tsc fails without it
# start the three podman services first — see below
sh -c 'set -a; . ./.env.local; set +a; npx prisma migrate deploy'   # 19 migrations
sh -c 'set -a; . ./.env.local; set +a; npm run db:seed'             # same wrapper — see below
npm run dev                   # http://localhost:3000  (Next.js loads .env.local itself)
```

Fill in, at minimum: `DATABASE_URL` (already correct for the podman container below),
`NEXTAUTH_SECRET` (`openssl rand -base64 32`), `ENCRYPTION_KEY` (`openssl rand -hex 32` — API keys
are AES-256-GCM encrypted at rest) and one provider key. `.env.example` documents the rest inline,
including the Authentik OIDC block.

**`db:seed` needs the same wrapper as `migrate deploy`, for a different reason** — this was wrong in
the first version of this rewritten section, which called it as a bare `npm run db:seed`.
`db:seed` is `npx tsx prisma/seed.ts`, and `prisma/seed.ts` constructs `new PrismaClient()` with no
dotenv loading anywhere in it or in `seed-core.ts`. The Prisma **CLI** loads `.env`; the Prisma
**Client** loads nothing. Verified 2026-08-29 in a checkout that *does* have a `.env`, by running
`env -u DATABASE_URL node -e "…new PrismaClient().$queryRawUnsafe('SELECT 1')"` — it fails
`Environment variable not found: DATABASE_URL.` So a bare `npm run db:seed` straight after
`cp .env.example .env.local` fails, and it fails looking like a database problem rather than a
missing variable. `npm run dev` is the exception: Next.js reads `.env.local` itself.

`npm run setup` still exists — verbatim, `npm install && npx prisma generate && npx prisma db push
&& npx tsx prisma/seed.ts` — and is left in `package.json`, but **prefer the sequence above**:
`setup` ends in `prisma db push`, which lays the schema on directly and never records a row in
`_prisma_migrations`. A database created that way will diverge from every other environment the
first time a migration carries hand-written SQL — and eight of ours do (see [Known migrate-diff
pseudo-drift](#known-migrate-diff-pseudo-drift)).

**Do not read `db:seed`'s output as a report of what it inserted.** `seedPromptTemplates` upserts
and then logs `✓ Created prompt template: …` **unconditionally**, outside any branch;
`seed-judgebench.ts` opens with an unconditional `✓ Created dataset: …` the same way. No log line in
the seeder is gated on an actual insert — only the parenthetical `${created.count} new samples`
carries a real delta. If you need to know whether a row was new, query the table before and after
(`select name, version, "createdAt" from "PromptTemplate"`). Note also that `prisma/seed.ts:29`'s
claim that "a second run … reports zero new rows" is true for judgebench and **false for prompt
templates.**

### The services the test suites need — they are not optional

Two of the three test suites talk to a real Postgres, a real Redis and a real RabbitMQ. Nothing
starts them for you. **If they are not running, `npm run test:db` fails with a connection error that
reads like a code failure. It is not a code failure; it is a missing container.** The local rig is
three podman containers, by these exact names:

| Container | Image | Host port | Needed by |
|---|---|---|---|
| `judge-arena-pg` | `postgres:16-alpine` | `5432` | `npm run test:db`, `npm run dev`, every Prisma command |
| `judge-arena-redis` | `redis:7-alpine` (`--maxmemory-policy noeviction`) | `6379` | `npm run test:integration` — SSE bus, rate limiter, breaker state |
| `judge-arena-rabbitmq` | `rabbitmq:3.13-management-alpine` | `5672` (management UI on `15672`) | `npm run test:integration` — `tests/integration/queue.test.ts` |

```bash
podman run -d --name judge-arena-pg -p 5432:5432 \
  -e POSTGRES_USER=judge_arena -e POSTGRES_PASSWORD=password -e POSTGRES_DB=judge_arena \
  postgres:16-alpine
podman run -d --name judge-arena-redis -p 6379:6379 \
  redis:7-alpine redis-server --maxmemory-policy noeviction
podman run -d --name judge-arena-rabbitmq -p 5672:5672 -p 15672:15672 \
  rabbitmq:3.13-management-alpine
```

The credentials are not arbitrary. `.env.test` and `.gitea/workflows/ci.yml`'s `env:` block both
hard-code `judge_arena:password@localhost:5432`, so a failure reproduces identically on a laptop and
in CI. **Three databases live on that one container:** `judge_arena` (dev), `judge_arena_test`
(`npm run test:db`, dropped and recreated on every run) and `judge_arena_v1` (the frozen v1 scratch
schema the importer's DB tests read — created by `npm run db:push:v1`, which `prisma migrate reset`
never touches because it only knows about `DATABASE_URL`).

`bash scripts/ci-local.sh` opens with a pure-bash TCP probe of all three and fails fast, naming the
unreachable one, rather than letting it surface later as a test failure. When a suite fails
mysteriously, run that first.

### Two traps that have each cost a session here

Both are recorded in `docs/superpowers/plans/2026-08-17-a1-a15-complete-handoff.md` §4 and are
repeated here because a contributor hits them before ever reading a handoff.

**(a) `.env.local` holds a QUOTED `DATABASE_URL`.** So the obvious idiom —

```bash
# WRONG — do not copy this
DATABASE_URL="$(grep -m1 '^DATABASE_URL=' .env.local | cut -d= -f2-)" npx prisma migrate status
```

— hands Prisma a value with its double quotes still attached, and Prisma fails **`P1012`** ("the URL
must start with the protocol `postgresql://`"). **That error reads like schema drift and it is not
— it is a quoting bug.** A bare `npx prisma …` fails the same way for a different reason: the Prisma
CLI auto-loads `.env` and never `.env.local`, and this tree has no `.env`. Source the file instead:

```bash
sh -c 'set -a; . ./.env.local; set +a; npx prisma migrate status'   # 19 migrations, up to date
```

That `set -a` / dot-source / `set +a` wrapper is not an invention for this note — it is exactly what
`package.json`'s `test:db`, `test:db:coverage`, `test:integration` and `db:push:v1` scripts already
do to `.env.test`. Copy the working idiom rather than writing a new one. (Related: `prisma db
execute` needs `--schema` or `--url`; it is not a drop-in for a `psql` one-liner.)

**(b) Local Postgres is the podman container `judge-arena-pg`. PRODUCTION is the Kubernetes pod
`judge-arena-pg-1`, in namespace `tenant-public`.** The names differ by **one character**, and one
of them serves `judgearena.com`. Everything in this guide that touches a database — `migrate
deploy`, `migrate reset`, `db push`, `db:seed`, `psql` — means the local container only.
**Production must never be touched from a development shell**; its schema changes arrive through the
deploy. `npm run test:db` is the sharpest edge, because it runs `prisma migrate reset --force`,
which drops and recreates whatever database it is pointed at. See
[Deployment: production](#deployment-production-judgearenacom) for what is actually up there.

### Creating an account

Self-service registration is retired — accounts are admin-invite-only (spec §7). The CLI is
`scripts/admin/create-user.ts`, wired as an npm script:

```bash
npm run admin:create-user -- --email=alice@example.com --name="Alice" --admin --dry-run
```

With `--password=<pw>` it creates a credentials account (bcrypt, 12 rounds) that can sign in
immediately — that is what you want for local development. Without it, you get an OIDC-pending
invite row that only becomes usable on a matching Authentik sign-in (see
`docs/runbooks/authentik-oidc-setup.md`). `--dry-run` prints what would be created and touches
nothing. The CLI refuses (exit 1) if a `User` row already exists for that email — `email` is not a
DB-unique column, so this is CLI policy, not a database constraint.

---

## Running the Tests

Three suites, three vitest configs, three npm scripts. **There is no `test:unit`** — the unit suite
is plain `npm test`.

| Command | Config | What it covers | Services needed |
|---|---|---|---|
| `npm test` | `vitest.config.ts` | Unit, DB-free. `src/**/*.test.ts(x)` + `tests/**/*.test.ts`, explicitly excluding `tests/db/**`, `tests/importer/**/*.db.test.ts` and `tests/integration/**` | none |
| `npm run test:coverage` | same | **Coverage gate 1.** The unit run plus `coverage.thresholds` | none |
| `npm run test:db` | `vitest.db.config.ts` | `tests/db/**` + `tests/importer/**/*.db.test.ts`. Runs `prisma migrate reset --force --skip-seed` first, replaying the whole migration chain | Postgres |
| `npm run test:db:coverage` | same | **Coverage gate 2.** The DB run plus its own per-glob thresholds | Postgres |
| `npm run test:integration` | `vitest.integration.config.ts` | `tests/integration/**` — RabbitMQ consumers, SSE over real Redis. **No coverage gate** (see [Test coverage](#test-coverage)) | Postgres + Redis + RabbitMQ |
| `npm run lint` | — | `eslint src/ prisma/ scripts/ tests/` | none |
| `npx tsc --noEmit` | — | Type check. Fails `TS2307: Cannot find module '@prisma/v1-client'` unless `npm run db:generate:v1` has been run | none |
| `bash scripts/ci-local.sh` | — | All of the above, in CI's exact order, 11 steps, from a clean `npm ci` | all three |

The two coverage gates are `test:coverage` and `test:db:coverage` — those are the only two commands
that can fail on coverage, and both are run by CI. `test:integration` has no `coverage` block at
all.

**Where the numbers stood at the merge point** (`14d75f7`, 2026-08-29), all run locally against the
podman services above: **lint 0, `tsc` 0, 594 unit / 43 files, 641 db / 42 files, 80 integration /
10 files, both coverage gates 0, `npm run build` 0.** The previous recorded baseline, at `bee1d12`,
was 578 / 633 / 80. Quote a measurement with its commit when you update this; a bare count ages
badly and cannot be checked.

---

## Testing Conventions

Two rules here are unusual enough to be worth stating outright, because neither is discoverable from
reading the test files.

### 1. TDD — and an injection that leaves the suite green is a FINDING, not a formality

Write the failing test first; watch it fail for the reason you expect; then make it pass. The
second half is the part this repo actually holds itself to: once a test is green, **break the code
it covers on purpose and confirm the test goes red.**

If the injection leaves the suite green, **that is a finding. If breaking the code changes nothing,
either the code or the test is decoration** — and your job is to work out which before moving on.

This is not a theoretical hygiene rule; it is written from what it has already caught. Across A1 and
A1.5, five prescribed injections left the suite green, and every one of the five was a real gap: an
unreachable guard, a dead special case, an untested equality check, a clamp test using `-5` (a value
the standard library clamps anyway, so only `-1` discriminates), and a de-dup test asserting a length
that a `Map` gives for free. The write-up is
`docs/superpowers/plans/2026-08-17-a1-a15-complete-handoff.md` §6. The same record carries two
corollaries worth internalising:

- **A green test can be impossible to fail.** One fixture could not pass under any implementation
  (`0 > 0`); another asserted a length that depended on the source file's encoding, where the
  obvious fix — changing a 7 to a 6 — would have made it green while deleting the only thing under
  test. Work the arithmetic by hand before you write the module.
- **A failure message that does not describe the defect is not evidence.** An injection that fails
  with `expected 500 to be 201` because the bad value collided with a unique index has not proved
  your assertion; it has proved that *something* rejected the row. Write a second, cleaner
  injection.

Some of these injections have a browser-level twin. Row 14 of the studio runbook exists precisely
because the `sample-selection` injection needed one: it checks that "Random N" is not returning the
first N.

### 2. Anything that RENDERS cannot be unit-tested here

All three vitest configs declare `environment: 'node'` and none of them loads jsdom
(`vitest.config.ts:7`, `vitest.db.config.ts:12`, `vitest.integration.config.ts:12`). There is no DOM
to render into, so a component cannot be asserted on at all. Three consequences, in the order they
matter:

1. **Put every rule that can be silently wrong into `src/lib/**` so that it *can* be unit-tested.**
   Span segmentation, the word diff, layout reconciliation and sample selection all live under
   `src/lib/studio/` and `src/lib/sample-selection.ts` for exactly this reason. If a manual checklist
   step is checking a *rule* rather than a *rendering*, that rule is in the wrong place — move it.
2. **UI is covered by the browser-walk runbook instead:**
   `docs/runbooks/studio-manual-verification.md`. It is 18 rows today, walked against `npm run dev`
   plus local Postgres in a real browser, and it is the thing a change to the studio or the
   golden-set surfaces is re-run against.
3. **A new UI surface is expected to add rows to that runbook.** This is a real expectation, not an
   aspiration: `0309a7e` shipped the golden-set assignment panel and the random-subset selector and
   added rows 13–18 to cover them, because `src/app/golden-sets/**` sits outside every coverage
   `include` and has no DOM environment either.

Two more things the runbook's own history establishes. **Walk it — do not write it and defer it:**
A1.5's row 7 caught a defect no unit test could have, a progression rail reading "not started"
directly above a message saying a reading had just been recorded (the rule was right and the
*composition* was wrong, which is the whole class the checklist exists for). And **record the run**
in the runbook's dated table at the bottom, with the commit, who walked it, and any row that failed
with what changed — the 2026-08-29 entry recording rows 14/16/17/18 against `0309a7e` is the shape
to copy.

---

## Project Structure at a Glance

> **CORRECTION (2026-08-29).** The tree drawn here until now was the v1 map, and the 2026-08-29
> rewrite of this document did not touch it. It showed **five** API folders (there are 13), no
> `golden-sets/` anywhere, no `worker/` at all, `src/lib/` as three entries (there are ~40 plus four
> subdirectories), and "13 generic primitives" in `ui/` (`ls src/components/ui/ | wc -l` → **14**).
> Everything below is `ls`-verified against the tree at `14d75f7`. Only top-level shape is drawn —
> the point is where a thing *belongs*, not an inventory.

```
src/
├── app/                       # Next.js App Router
│   ├── api/                   # REST API (one folder per resource) — 13 of them
│   │   ├── api-keys/          # DeveloperApiKey CRUD (interactive session only)
│   │   ├── auth/              # NextAuth (credentials + Authentik OIDC)
│   │   ├── config/            # Config export / import
│   │   ├── datasets/          # Datasets: samples, versions, refresh, export, HF import
│   │   ├── evaluations/       # CRUD + /runs + /human-judgment (/judge is a 410 stub)
│   │   ├── events/            # SSE stream (realtime bus)
│   │   ├── golden-sets/       # Sets, items, assignments, queue, agreement, disagreements, fork
│   │   ├── health/            # Liveness/readiness
│   │   ├── leaderboard/       # Public read
│   │   ├── models/            # JudgeModel catalog + ModelEndpoint CRUD (1b Task 12)
│   │   ├── projects/          # CRUD
│   │   ├── rubrics/           # CRUD + /versions
│   │   └── stats/             # Dashboard counters
│   ├── evaluate/[id]/         # Evaluation workspace + runs/[runId] detail
│   ├── golden-sets/           # List, [id] detail (assignment panel), [id]/label (the studio)
│   ├── datasets/ dashboard/ evaluations/ models/ projects/ rubrics/ settings/
│   ├── login/ register/       # Sign-in; registration is retired (admin-invite only)
│   ├── layout.tsx             # Root layout (reads the CSP nonce off x-nonce)
│   └── page.tsx               # Landing
├── components/
│   ├── auth/                  # Sign-in surfaces
│   ├── evaluation/            # Feature components for the evaluation flow
│   ├── layout/                # App shell, sidebar, header, shortcuts dialog
│   ├── models/ rubric/        # ModelConfigForm, RubricBuilder
│   ├── studio/                # A1.5 panel shell (PascalCase filenames — see Conventions)
│   └── ui/                    # 14 generic primitives (button, dialog, …)
├── lib/                       # ~40 modules. Rules live HERE so they can be unit-tested
│   ├── db.ts                  # Prisma singleton
│   ├── auth-guard.ts          # optionalAuth / requireAuth / requireOwnership
│   ├── run-launch.ts          # Transaction, then publish — the web tier's half of a run
│   ├── golden-sets.ts, agreement.ts, labelling-queue.ts, sample-selection.ts, …
│   ├── calibration/           # A2.1: launch.ts (FREEZES the set), score.ts, readings.ts
│   ├── llm/                   # Provider abstraction layer
│   │   ├── provider.ts        #   Interface + prompt builders + response parser
│   │   ├── anthropic.ts       #   Anthropic Messages API
│   │   ├── openai-compatible.ts # OpenAI Chat Completions (+ any compatible)
│   │   └── index.ts           #   Registry: getProvider, executeJudgment
│   ├── queue/                 # RabbitMQ: connection.ts, topology.ts, publish.ts
│   ├── realtime/              # SSE bus: redis-bus, in-memory-bus, factory, ownership
│   └── studio/                # content.ts (spans), delta.ts (word diff), layout.ts
├── worker/                    # The queue consumer process (`npm run worker`)
│   ├── main.ts                #   Boot + consumer registration
│   ├── run-create-consumer.ts #   run.create  → fans out judgment.execute
│   ├── judgment-consumer.ts   #   judgment.execute → provider call → ModelJudgment
│   ├── concurrency.ts         #   the hard cap of 1 — read its header before raising it
│   └── claim.ts reaper.ts dispatch-failure.ts health.ts
├── middleware.ts              # Per-request CSP nonce (Task 14)
└── types/
    └── index.ts               # Shared TypeScript interfaces

scripts/                       # NOT under src/ — bundled into the image by esbuild
├── admin/create-user.ts       # invite CLI          → /app/create-user.js
├── admin/add-judge.ts         # judge registration  → /app/add-judge.js         [A2.1]
└── calibration/run.ts         # calibration runner  → /app/calibration-run.js   [A2.1]
                               #   and `npm run calibration:run` locally
```

> **ADDED 2026-08-31 (A2.1).** `src/lib/calibration/`, `src/worker/concurrency.ts` and the two new
> `scripts/` entrypoints are the only structural additions since the `14d75f7` correction above.
> `scripts/` is a real deployment surface, not developer scratch: `.dockerignore` excluded
> `scripts/calibration/` when the runner first landed, so `e4b9948`'s image built **successfully**
> and shipped without the script it existed to ship (fixed in `c641786`). If you add an entrypoint
> there, check `.dockerignore` and then check the built image — the build log will not tell you.

### Key principles

- **No external UI component libraries.** Every component in `ui/` is self-contained (React + Tailwind). This ensures MIT licensing cleanliness and keeps the bundle small.
- **Prisma is the source of truth.** All data access goes through `src/lib/db.ts`. Never import `PrismaClient` directly — use the singleton.
- **API routes validate with Zod.** Every `POST`/`PATCH` handler defines a Zod schema at the top of the file.
- **Provider pattern for LLMs.** Adding a new LLM backend means implementing one interface — no changes to the evaluation pipeline.

---

## Conventions

### File naming

| Type | Naming | Example |
|---|---|---|
| Pages | `page.tsx` (Next.js convention) | `src/app/projects/page.tsx` |
| API routes | `route.ts` (Next.js convention) | `src/app/api/projects/route.ts` |
| Components | `kebab-case.tsx` | `model-judgment-card.tsx` |
| Components — **exception** | `src/components/studio/**` is `PascalCase.tsx` (`Panel.tsx`, `StudioShell.tsx`, `SpanTextView.tsx`, `DeltaTextView.tsx`, `ProgressionRail.tsx`) — landed that way in A1.5 and left alone rather than renamed mid-flight. Verified by `ls src/components/studio/`. New files outside that directory use kebab-case. | `StudioShell.tsx` |
| Utilities | `kebab-case.ts` | `utils.ts` |
| Types | `index.ts` in `types/` | `src/types/index.ts` |

### TypeScript

- Strict mode is enabled (`"strict": true` in tsconfig).
- Prefer interfaces over type aliases for object shapes.
- Export types from `src/types/index.ts` so they're importable as `@/types`.

### Styling

- Use Tailwind utility classes exclusively — no CSS modules or inline styles.
- Leverage the custom `brand-*` and `surface-*` color tokens defined in `tailwind.config.ts`.
- Use the `cn()` helper from `@/lib/utils` to merge conditional classes.

### Imports

- Use the `@/` path alias (mapped to `src/` in tsconfig).
- Group imports: React/Next → components → lib/utils → types.

---

## Adding a New LLM Provider

This is the most common extension point. Example: adding a Google Gemini provider.

### 1. Create the provider file

Create `src/lib/llm/gemini.ts`:

```typescript
import type { JudgmentProvider, JudgmentRequest, JudgmentResponse, ProviderConfig } from './provider';
import { buildJudgmentSystemPrompt, buildJudgmentUserPrompt, parseJudgmentResponse } from './provider';

export class GeminiProvider implements JudgmentProvider {
  name = 'Google Gemini';

  async judge(request: JudgmentRequest, config: ProviderConfig): Promise<JudgmentResponse> {
    const startTime = Date.now();

    const systemPrompt = buildJudgmentSystemPrompt(
      request.rubricName,
      request.rubricDescription,
      request.rubricCriteria
    );
    const userPrompt = buildJudgmentUserPrompt(request.inputText);

    // Call the Gemini API here using config.apiKey and config.modelId
    // ...

    const latencyMs = Date.now() - startTime;
    return parseJudgmentResponse(rawResponseText, request.rubricCriteria, latencyMs, tokenCount);
  }
}
```

**Key contract:** Your `judge()` method receives `JudgmentRequest` (input text + rubric criteria) and `ProviderConfig` (API key + model ID + optional endpoint). Return a `JudgmentResponse` — or use `parseJudgmentResponse()` to parse a JSON response from the LLM.

### 2. Register the provider

In `src/lib/llm/index.ts`, import and add it to the registry:

```typescript
import { GeminiProvider } from './gemini';

const providers: Record<string, JudgmentProvider> = {
  anthropic: new AnthropicProvider(),
  openai: new OpenAICompatibleProvider('OpenAI'),
  local: new OpenAICompatibleProvider('Local Model'),
  gemini: new GeminiProvider(),   // ← add here
};
```

### 3. Add the provider to the UI

In `src/components/models/model-config-form.tsx`:

- Add to `providerOptions`: `{ value: 'gemini', label: 'Google (Gemini)' }`
- Add to `presetModels.gemini`: preset model IDs (e.g., `gemini-2.5-pro`).

### 4. Add the provider to utils

In `src/lib/utils.ts`, add a case to `getProviderInfo()`:

```typescript
case 'gemini':
  return { label: 'Gemini', color: 'text-blue-600' };
```

### 5. Update the type alias

In `src/types/index.ts`, widen `ModelProvider`:

```typescript
export type ModelProvider = 'anthropic' | 'openai' | 'local' | 'gemini';
```

### 6. Add env variable

In `.env.example`:

```dotenv
GOOGLE_API_KEY=
```

That's it — no changes needed to the evaluation pipeline, API routes, or database.

---

## Adding a New UI Component

All UI primitives live in `src/components/ui/`. They must be:

- Self-contained (no dependencies beyond React + Tailwind + `cn()` from utils)
- Accessible (proper `aria-*` attributes, keyboard handling where applicable)
- MIT-licensed (no copy-paste from Radix, shadcn, or Headless UI)

### Recipe

1. **Create the file** — `src/components/ui/my-widget.tsx`
2. **Forward refs** when wrapping native elements:

```typescript
import React from 'react';
import { cn } from '@/lib/utils';

interface MyWidgetProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'alt';
}

export const MyWidget = React.forwardRef<HTMLDivElement, MyWidgetProps>(
  ({ className, variant = 'default', ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'base-classes',
        variant === 'alt' && 'alt-classes',
        className
      )}
      {...props}
    />
  )
);
MyWidget.displayName = 'MyWidget';
```

3. **Use Tailwind tokens** — prefer `text-surface-700`, `bg-brand-100`, etc. over raw colors.
4. **Export named** — all components use named exports, not default.

### Existing component patterns to follow

| Pattern | Example file |
|---|---|
| Compound component | `card.tsx` (Card + CardHeader + CardTitle + …) |
| Variant map via `cn()` | `button.tsx`, `badge.tsx` |
| Focus trap + escape handling | `dialog.tsx` |
| Hover-triggered overlay | `tooltip.tsx` |
| Controlled + uncontrolled | `tabs.tsx` (context-based) |

---

## Adding a New API Route

### Recipe

1. **Create the route file** at the appropriate path. Use the Next.js App Router convention:

   ```
   src/app/api/<resource>/route.ts          → collection (GET, POST)
   src/app/api/<resource>/[id]/route.ts     → single item (GET, PATCH, DELETE)
   ```

2. **Define a Zod schema** for request validation at the top of the file:

   ```typescript
   import { z } from 'zod';

   const createFooSchema = z.object({
     name: z.string().min(1).max(200),
     // ...
   });
   ```

3. **Use the Prisma singleton** from `@/lib/db`:

   ```typescript
   import { prisma } from '@/lib/db';
   ```

4. **Return proper status codes** — 200 (ok), 201 (created), 400 (validation), 404 (not found), 500 (server error).

5. **Handle errors consistently**:

   ```typescript
   if (error instanceof z.ZodError) {
     return NextResponse.json(
       { error: 'Validation failed', details: error.errors },
       { status: 400 }
     );
   }
   ```

### Existing routes to reference

- Simple CRUD: `src/app/api/projects/route.ts` + `[id]/route.ts`
- Nested resource: `src/app/api/rubrics/[id]/versions/route.ts`
- Complex workflow: `src/app/api/evaluations/[id]/runs/route.ts` → `src/lib/run-launch.ts`
  (auth + rate limit + one transaction + queue publish). **Not** `[id]/judge/route.ts` — that is a
  410 Gone stub since 1b Task 9 and does no work at all; this list pointed at it until 2026-08-29.

### Access control — public reads vs. gated writes (Task 14)

The access model (spec §7 D3): PUBLIC research data defaults to open
**reads** — the leaderboard, and `visibility: 'public'` Rubrics/Datasets/
Projects/GoldenSets. Everything else, and **every** mutation, is fully
**gated** (ownership required, no anonymous access). Use the right
helper from `src/lib/auth-guard.ts`:

- **A resource that CAN be public** (has a `visibility` field): use
  `optionalAuth()` instead of `requireAuth()` for `GET` — it resolves the
  session if one exists but returns `null` instead of a 401 for an
  anonymous caller. Then call `resolveResourceAccess(session, ownerId,
  isPublic)`:
  - `{ error }` → return it directly (401 anonymous+private, 403
    authed-non-owner+private).
  - `{ access: 'owner' }` → return the full row (owner or admin).
  - `{ access: 'public' }` → return the row through the matching
    `src/lib/serializers.ts` function (`toPublicRubric`/`toPublicDataset`/
    `toPublicProject`/`toPublicGoldenSet`) — **never** the raw row with a
    `user: { select: { email: true } }` join on this branch. Add a new
    serializer there (allow-list shape, not a spread) if you add a new
    public-eligible model.
  - List endpoints: anonymous → `where: { visibility: 'public' }` only;
    authed non-admin → `where: { OR: [{ userId }, { visibility: 'public' }] }`;
    admin → everything. Map each row through the owner-vs-public check
    per item (a list can mix your own private rows with someone else's
    public ones).
- **A resource that's NEVER public** (Evaluation, ModelEndpoint — no
  `visibility` field; user-created/uploaded data, spec §7 D3): keep
  `requireAuth()` on `GET` too, not `optionalAuth()`.
- **Every mutation** (`POST`/`PATCH`/`DELETE`), on any resource: keep
  `requireAuth()` (never `optionalAuth()`), and check ownership with
  `requireOwnership(entityName, id, session)` — it 404s if the row
  doesn't exist, 403s if `session` isn't the owner or an admin, and
  `null`s (proceed) otherwise. On `POST`, set `userId: session.user.id`
  directly from the resolved session — **never** trust a client-supplied
  `userId`/`ownerId` field in the request body.
- **API-key management routes** (anything that creates/edits/revokes a
  `DeveloperApiKey`) additionally require `requireInteractiveSession()`
  instead of `requireAuth()` — a developer API key, no matter its scopes,
  must never be usable to mint/edit/revoke keys (see that function's doc
  comment in `auth-guard.ts` for the privilege-escalation history).

See `tests/db/access-matrix.test.ts` for the full table-driven matrix
(every {resource × method × visibility × actor} combination this
codebase currently implements) and `tests/lib/serializers.test.ts` for
the PII-stripping assertions on each public serializer.

---

## Adding a New Page

All pages live in `src/app/` and use the Next.js App Router.

### Recipe

1. **Create the page file** — `src/app/<route>/page.tsx`
2. **Add `'use client'`** at the top if the page uses hooks, event handlers, or browser APIs.
3. **Use the `Header` component** for consistent page headers:

   ```typescript
   import { Header } from '@/components/layout/header';

   <Header
     title="Page Title"
     description="Optional description"
     breadcrumbs={[{ label: 'Parent', href: '/parent' }]}
     actions={<Button>Action</Button>}
   />
   ```

4. **Add to the sidebar** — in `src/components/layout/sidebar.tsx`, add a nav item:

   ```typescript
   { label: 'New Page', href: '/new-page', icon: <YourIcon />, shortcutHint: 'G+X' }
   ```

5. **Register the keyboard shortcut** (see [Adding a Keyboard Shortcut](#adding-a-keyboard-shortcut)).

### Page layout patterns

| Pattern | Example |
|---|---|
| List + create dialog | `projects/page.tsx`, `models/page.tsx` |
| Detail with nested list | `projects/[id]/page.tsx` |
| Multi-pane workspace | `evaluate/[id]/page.tsx` (3-column) |
| Family-grouped cards | `rubrics/page.tsx` (version groups) |

---

## Extending the Database Schema

> **Superseded recipe below the line, kept as a historical record of the
> pre-v2 `db:push` workflow.** Since the v2 migration (1a) the project runs
> Postgres with real, checked-in migrations under `prisma/migrations/` (18
> of them today) — every environment (dev, `test:db`, and CI, which has run
> them for real since 2026-08-12) applies `prisma migrate
> deploy`/`migrate reset`, never `db push`. Use the recipe immediately
> below for any schema change from 1a onward.
>
> **CORRECTION (2026-08-29):** this note used to end *"the old `db push`
> steps still work against a scratch SQLite/`dev.db` setup"*. There is no
> SQLite setup left to work against — `schema.prisma`'s provider is
> `postgresql`, so `db push` today pushes to **Postgres**, and the danger
> is not that it's obsolete but that it silently works while recording
> nothing in `_prisma_migrations`. See [Development
> Setup](#development-setup) for the correction to the SQLite claim that
> stood at the top of this document.

### Recipe (v2, Postgres, migrations — current)

1. **Edit `prisma/schema.prisma`** — add or modify models. If the change
   needs SQL Prisma's schema DSL can't express (e.g. `NULLS NOT DISTINCT`,
   see the pseudo-drift note below), you'll hand-edit the generated SQL in
   step 3.
2. **Generate the diff SQL** against the live dev database:

   ```bash
   npx prisma migrate diff \
     --from-url "postgresql://judge_arena:password@localhost:5432/judge_arena" \
     --to-schema-datamodel prisma/schema.prisma --script
   ```

3. **Create the migration directory** (`prisma/migrations/<timestamp>_<name>/migration.sql`)
   and place the generated SQL there, hand-editing/adding any statements
   Prisma's diff can't produce (raw index recreation, one-time backfill
   `UPDATE`s, etc.) — document every hand edit in a comment block at the top
   of the file, same as `20260728215410_v2b_idempotency_tighten` does.
4. **Apply it to the dev database**:

   ```bash
   sh -c 'set -a; . ./.env.local; set +a; \
     PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION=<approved-plan-id> npx prisma migrate deploy'
   ```

   The consent env var is this environment's gate on agent-run schema
   changes against a real database — use the id approved for the plan/task
   doing the work (dev DB is disposable, but the gate still applies).
   It is Prisma's own check, not a wrapper of ours, and it fires **only when
   the CLI detects it was invoked by an agent** ("Prisma Migrate detected that
   it was invoked by …", the `prisma:migrate:ai-safety` path in prisma 6.19.2).
   That is why the [Development Setup](#development-setup) block shows a bare
   `migrate deploy`: a human never sees this prompt and an agent always does.
   The `set -a` wrapper is not optional: a bare `npx prisma migrate deploy`
   in this tree fails `P1012` because the Prisma CLI loads `.env` and this
   tree has only `.env.local` — see trap (a) in
   [Development Setup](#development-setup). And "the dev database" here
   means the podman container `judge-arena-pg`, never the production pod
   `judge-arena-pg-1` — trap (b), same section.
5. **Regenerate the client**: `npx prisma generate`.
6. **Verify against the test database**: `npm run test:db` runs
   `prisma migrate reset --force --skip-seed` first, replaying the FULL
   migration chain (including every hand-edited statement) from scratch —
   this is the real test that your migration file, not just your `schema.prisma`
   edit, is correct. Never consider a schema change done until this passes.
7. **Update the seed file** if your new model should have default data — `prisma/seed.ts`.
8. **Update TypeScript types** in `src/types/index.ts` to reflect the new shapes.

### Known migrate-diff pseudo-drift

Some SQL a migration needs cannot be expressed by Prisma's schema DSL at
all — the migration file still carries the real SQL (hand-edited per the
recipe above). The natural worry is that a *future* `prisma migrate diff`
(or `db push`) run against a database that has it applied will propose
"fixing" it back to whatever Prisma's own reading of `schema.prisma` would
generate — **verified empirically (Prisma 6.19.2) that this is NOT what
happens**, for a more fundamental reason: Prisma's schema engine has no
internal representation of these attributes at all, so it doesn't
"decide" to leave them alone — it genuinely cannot see them. `prisma db
pull` against a migrated database silently drops the attribute from its
own introspected model; `prisma migrate diff --from-url ...
--to-schema-datamodel prisma/schema.prisma` reports an empty diff; `prisma
db push` reports "already in sync". There is currently nothing to
whitelist in a CI drift check for the cases below — a plain `migrate diff`
gate would pass clean today. Currently eight cases (the count was stale at
"one" while the table already listed two — corrected while landing A0,
incremented again by L1's CHECK below, and by the three v2h adds; keep this
number in step with the rows):

> **Still eight after v2i (2026-08-31), and that is a fact worth stating rather than a row worth
> adding.** `20260830120000_v2i_calibration_item_link` was written with **zero hand edits** — the
> whole migration is what Prisma generated. Its `@@unique([calibrationRunId, goldenItemId])` needs
> no `NULLS NOT DISTINCT` edit (the way `ModelJudgment`'s did) precisely because Postgres' **default
> `NULLS DISTINCT` is what that index wants**: every ordinary run has both columns NULL and they
> must all coexist, while at most one calibration run may exist per (calibration, item). Adding
> `NULLS NOT DISTINCT` there would have made the *first* ordinary run block every subsequent one.
> If you find yourself reaching for a hand edit on a unique index, check first whether the default
> is already the semantics you need.

| Migration | What's really there | Why `schema.prisma` can't say it |
|---|---|---|
| `20260728215410_v2b_idempotency_tighten` | `ModelJudgment_runId_judgeModelVersionId_pairOrder_key` recreated `NULLS NOT DISTINCT` (real pointwise idempotency, 1b Task 6) | `@@unique([runId, judgeModelVersionId, pairOrder])` has no Prisma DSL syntax for `NULLS NOT DISTINCT` (PG15+) |
| `20260729180000_v2b_email_partial_unique` | `User_email_credentials_key`, a unique index on `User(email)` restricted to `WHERE "passwordHash" NOT LIKE '!%'` (real-credentials rows only, 1b Task 13 review fix) | Prisma's schema DSL has no syntax for a partial index (`WHERE` clause) at all — not specific to this predicate |
| `20260812190000_v2d_golden_substrate` | `GoldenSet_ownerId_slug_key` created `NULLS NOT DISTINCT` (ownerless golden sets can't share a slug — A0 step 1) | `@@unique([ownerId, slug])` has no Prisma DSL syntax for `NULLS NOT DISTINCT` (PG15+), same as the idempotency case above. Re-verified empirically on Prisma 6.19.2 against a database with this migration applied: `migrate diff --from-url ... --to-schema-datamodel` reports an empty migration. A partial variant (`... NULLS NOT DISTINCT WHERE "slug" IS NOT NULL`) was tried and REJECTED — it produces REAL drift, with `migrate diff` proposing `CREATE UNIQUE INDEX "GoldenSet_ownerId_slug_key" ON "GoldenSet"("ownerId", "slug");` to "fix" it. A partial unique index does not satisfy a Prisma `@@unique`; the email row above only escapes this because its schema declares no `@unique` at all. |
| `20260813120000_v2e_golden_item_label_tombstones` | `GoldenLabel_goldenItemId_annotatorId_live_key`, a unique index on `GoldenLabel(goldenItemId, annotatorId)` restricted to `WHERE "tombstonedAt" IS NULL` (one LIVE label per annotator per item — A0, tombstone-not-delete ruling) | Prisma's schema DSL has no syntax for a partial index, same as the email row above. Unlike that row, this one REPLACES a declared `@@unique`, which is therefore deleted from `prisma/schema.prisma` — so the Prisma client no longer offers the `goldenItemId_annotatorId` compound where-input (verified unused before landing), and P2002 from this index reports `meta.target` as the index name string rather than a field array. The `NULLS NOT DISTINCT` variant (`@@unique([goldenItemId, annotatorId, tombstonedAt])`) was tried and REJECTED: it equates `annotatorId`'s nulls too, so account deletion's `SetNull` would collide for two deleted annotators on one item. **Superseded by v2h**, which drops this index and recreates it with `round` as a third column; the row is kept because v2e is applied and immutable. |
| `20260814120000_v2f_tombstone_overlay` | `Tombstone_exactly_one_entity`, a table `CHECK` asserting `num_nonnulls("datasetSampleId", "datasetId") = 1` — every tombstone row hides exactly one entity (A1, the tombstone overlay) | Prisma's schema DSL has no syntax for a `CHECK` constraint of any kind — no attribute, no `@@check`, no escape hatch short of raw SQL in the migration. Unlike the four rows above, this one is **not an index**, so `db pull` leaves nothing behind at all: `schema.prisma` can only say that the two FK columns are optional and `@unique`, and Postgres permits unlimited NULLs in a unique index, so without this constraint both-null orphans and both-set rows are both accepted. Re-verified empirically on Prisma 6.19.2 against a database with the migration applied: `migrate diff --from-url ... --to-schema-datamodel` reports an empty migration. The invariant cannot be pinned through the typed client, which has no way to construct a violating row — `datasetSample` and `dataset` are separate optional relation inputs — so it is pinned by raw `INSERT`s in `tests/db/tombstone-check-constraint.test.ts`, run after `npm run test:db` has replayed the full chain. That test is the only thing in this repo that notices if the constraint goes missing; it was itself verified to fail with the constraint dropped. |
| `20260818120000_v2h_human_verification` | `GoldenLabel_score_xor_preference`, a table `CHECK` asserting `num_nonnulls("overallScore", "preference") = 1` — a pointwise label carries a score, a pairwise label carries a preference, and exactly one of the two is set (A1, human verification) | Same class as the v2f row above: no `CHECK` syntax of any kind. `schema.prisma` can only say that both columns are optional, so without this constraint a both-null row and a both-set row are equally acceptable. The typed client cannot construct a violating row either — `overallScore` and `preference` are separate optional inputs — so it is pinned by raw `INSERT`s in `tests/db/golden-label-constraints.test.ts`, verified to fail (`promise resolved "1" instead of rejecting`) with the constraint dropped. |
| `20260818120000_v2h_human_verification` | `GoldenLabel_goldenItemId_annotatorId_round_live_key`, a unique index on `GoldenLabel(goldenItemId, annotatorId, round)` restricted to `WHERE "tombstonedAt" IS NULL` — **it REPLACES the v2e row above**, which is dropped by this migration (A1, test-retest) | No partial-index syntax, same as the v2e row it supersedes. The widening is what makes test-retest possible: two blind readings by one annotator on one item are PEERS, and the two-column index permitted only one live label per (item, annotator). Note `migrate diff` does not emit the `DROP INDEX` either — it cannot see the old index any more than the new one — so **both** the drop and the recreate are hand-written. Pinned by `tests/db/golden-label-constraints.test.ts`, verified to fail (`promise resolved "{ …(13) }" instead of rejecting`) with the index dropped. |
| `20260818120000_v2h_human_verification` | `GoldenAssignment_item_annotator_round_active_key`, a unique index on `GoldenAssignment(goldenItemId, annotatorId, round)` restricted to `WHERE "revokedAt" IS NULL` — one ACTIVE assignment per (item, annotator, round) (A1, assignment) | No partial-index syntax, same as the two rows above. The predicate is load-bearing because `DELETE` on the assignments route **revokes** rather than removing the row: a whole-table unique would let a revoked assignment permanently block reassigning that work to the same annotator. Pinned by `tests/db/golden-label-constraints.test.ts`, verified to fail (`promise resolved "{ …(10) }" instead of rejecting`) with the index dropped. |

The real hazard is the opposite direction from "drift tooling nags you to
revert it": because `schema.prisma` can never re-declare any of these —
neither an index attribute nor a table constraint — the migration file's
raw SQL is the ONLY record of it. If a future migration ever needs to
recreate one of these objects for an unrelated reason (e.g. touching a
column it covers, or rebuilding the table it sits on), that migration must
hand-add the missing clause again — `NULLS NOT DISTINCT`, the partial
`WHERE`, or the whole `CHECK` — and nothing in the toolchain will warn if
it's forgotten, for the same reason nothing warns about drift today:
Prisma can't see any of them either way. The `CHECK` row is the sharpest
case, because it is not an index at all and so leaves nothing behind for
introspection to half-notice. Every row here has an automated guard —
`tests/db/idempotency-tighten.test.ts`, `tests/db/email-partial-unique.test.ts`
and `tests/db/meta-eval.test.ts` cover the four index rows — and the
`CHECK` row's, `tests/db/tombstone-check-constraint.test.ts`, is the only
one that must attempt its violating rows through RAW SQL. Not because the
typed client refuses them — `tombstone.create({ data: {} })` and a `data`
setting both FKs each compile clean, and both reach Postgres and die on
`23514`. Raw SQL is used because a typed create needs real FK rows to
satisfy the foreign keys first, so a typed probe that "fails" proves only
that some constraint fired, not which one. All of them run after
`npm run test:db` has replayed the whole chain. Guarding the constraint
this way is the established convention here, not a novelty — copy it for
the next inexpressible clause, because the drift gate will not do it for
you.
Anyone adding a NEW schema change that also needs a Prisma-inexpressible
SQL clause should add a row to this table and re-verify (`db pull`/`migrate
diff`/`db push` against a database that has the migration applied) rather
than assume the "pseudo-drift" framing without checking — as this section
itself originally did, before being corrected against real `psql`/Prisma
output while landing 1b Task 6.

### Schema conventions

- Use `cuid()` for primary keys.
- Add `createdAt DateTime @default(now())` and `updatedAt DateTime @updatedAt` to every model.
- Add `@@index` on foreign key columns.
- Use `onDelete: Cascade` for owned relations (e.g., criteria belong to rubric).
- JSON payloads use Prisma `Json` (JSONB) columns (criteriaScores et al. migrated in v2); document expected shape in a comment beside the field.

### Recipe (pre-v2, `db:push` — superseded, do not use)

Preserved because it is what this document said for the whole of v1, and because
`npm run setup` still ends in `prisma db push`. It is not how a schema change is made here now.

1. **Edit `prisma/schema.prisma`** — add or modify models.
2. **Push to the dev database**:

   ```bash
   npm run db:push
   ```

3. **Regenerate the client**:

   ```bash
   npm run db:generate
   ```

4. **Update the seed file** if your new model should have default data — `prisma/seed.ts`.
5. **Update TypeScript types** in `src/types/index.ts` to reflect the new shapes.

---

## API wire-format changes (v2, 1a)

The v2 schema migration (`20260725004838_v2_judgment_run_provenance` and the
`HumanJudgment`/`ModelJudgment` column conversions alongside it) changed
`criteriaScores` from a `String` column holding a JSON-encoded string to a
Prisma `Json` (JSONB) column holding the value directly.

This is an intentional, **undocumented-until-now** wire-format change for API
consumers:

- **Before (v1):** `criteriaScores` in API responses was a JSON-encoded
  *string* — clients had to `JSON.parse()` it a second time to get the array
  of `{ criterionId, score, ... }` objects.
- **After (v2):** `criteriaScores` is emitted as a JSON *array* (or `null`)
  directly on the response body — no double-decoding needed.

**Affected routes:** any route returning `ModelJudgment` or `HumanJudgment`
records, notably `GET /api/evaluations/[id]/runs` and
`GET /api/evaluations/[id]/runs/[runId]` (`evaluations:read` scope).

**Who's affected:** `DeveloperApiKey` consumers of the `evaluations:read`
routes that were written against the v1 shape and still call `JSON.parse()`
on `criteriaScores` will now throw (parsing an already-decoded array/object).
They should drop the extra parse step.

Export endpoints (`src/lib/export.ts`) are unaffected by this — they
JSON-stringify `criteriaScores` exactly once when flattening to CSV/JSONL, so
the export file format is unchanged from v1.

---

## API wire-format changes (v2, 1b Task 12)

`/api/models` moves from `ModelConfig` CRUD to `JudgeModel`/`JudgeModelVersion`
catalog + `ModelEndpoint` CRUD. `ModelConfig` itself is NOT dropped from the
schema (existing rows/FKs stay valid and readable), but the runtime write
path stops creating new ones — this route, the evaluation model-selection
routes, and the worker all operate on the catalog/endpoint model from this
task onward.

**`GET /api/models`** — was an array of `ModelConfig` rows (`{ id, name,
provider, modelId, endpoint, isActive, isVerified, verifiedAt,
verificationError, hasApiKey, userId, ... }`). Now an array of the calling
user's `ModelEndpoint` rows (admin sees everyone's), each flattened together
with its `JudgeModelVersion`/`JudgeModel` catalog join:

```jsonc
{
  "id": "...",                    // ModelEndpoint id (was the ModelConfig id)
  "judgeModelVersionId": "...",
  "judgeModelId": "...",
  "name": "Claude Sonnet 4.5",    // JudgeModel.name
  "slug": "claude-sonnet-4-5",
  "judgeClass": "prompted_api",
  "scoringMechanism": "critique_generative",
  "servingBackend": "anthropic",
  "ordinal": 1,
  "baseModel": "claude-sonnet-4-5-20250514",
  "provider": "anthropic",        // alias for servingBackend — legacy field name kept for UI/getProviderInfo() compat
  "modelId": "claude-sonnet-4-5-20250514", // alias for baseModel
  "endpoint": null,
  "isActive": true,
  "isVerified": true,             // derived: verifiedAt !== null (ModelEndpoint has no isVerified column)
  "verifiedAt": "...",
  "verificationError": null,
  "archFingerprint": { "servedModelId": "...", "contextLength": null },
  "hasApiKey": false,
  "userId": "...",
  "createdAt": "...",
  "updatedAt": "..."
}
```

**`POST /api/models`** — was `{ name, provider, modelId, endpoint?, apiKey?,
isActive? }` (created a `ModelConfig`). Now a discriminated union on `mode`:
`{ mode: 'catalog', judgeModelVersionId, endpoint?, apiKey?, isActive? }`
(creates a `ModelEndpoint` against an existing catalog version — see
`GET /api/models/catalog`, new in this task) or `{ mode: 'custom', name,
judgeClass, scoringMechanism, servingBackend, baseModel, endpoint?, apiKey?,
isActive? }` (creates a brand-new `JudgeModel` + `JudgeModelVersion` ordinal
1, then the `ModelEndpoint`).

**`PATCH`/`DELETE /api/models/[id]`** — `[id]` is now a `ModelEndpoint` id,
not a `ModelConfig` id. `PATCH` only accepts `{ endpoint?, apiKey?,
isActive? }` — the catalog identity (name/provider/modelId) is immutable
per-version now; there is no route to edit it (retiring a `JudgeModel` via
`retiredAt` is an admin-only concern, out of this task's scope).

**`POST /api/models/[id]/verify`** — same endpoint-id change; now persists
the returned `archFingerprint` onto `ModelEndpoint.archFingerprint` (closes
a Task 10 carry — previously computed but not persisted anywhere).

**Evaluation model selection** — `POST /api/evaluations`, `PATCH
/api/evaluations/[id]`, and `POST /api/evaluations/[id]/runs` rename their
`modelConfigIds` request field to `judgeModelVersionIds`. Values are
`JudgeModelVersion` ids (from `GET /api/models`'s `judgeModelVersionId`
field), not `ModelEndpoint` ids. Default-model resolution (field omitted)
now sources from the CALLING user's own active+verified `ModelEndpoint`s
only — never another user's (this closes the 1a INFO "global cross-user
defaults" finding; see `src/lib/run-launch.ts` and
`src/app/api/evaluations/route.ts`'s `resolveJudgeVersionIds`).

**Who's affected:** any `DeveloperApiKey` consumer of `models:*` or
`evaluations:write`/`evaluations:run` scopes reading/writing the old
`ModelConfig`-shaped fields. There is no back-compat shim — this is a
breaking change, effective with this task's deploy.

---

## Content Security Policy (CSP) script nonces (Task 14)

`src/middleware.ts` generates a fresh, random nonce on **every** request
and uses it (instead of `'unsafe-inline'`) to allowlist scripts:

```
script-src 'self' 'nonce-<per-request-value>'   (production; no unsafe-inline, no unsafe-eval)
script-src 'self' 'nonce-<per-request-value>' 'unsafe-eval'   (development; HMR needs unsafe-eval)
style-src 'self' 'unsafe-inline'                (KEPT — see below)
```

This follows the official [Next.js 15 App Router CSP
pattern](https://nextjs.org/docs/app/guides/content-security-policy):

1. Middleware sets the nonce on **both** the `Content-Security-Policy`
   response header (what the browser enforces) **and** an `x-nonce`
   request header, propagated via `NextResponse.next({ request: {
   headers } })` — not just the response headers object.
2. Next.js's SSR pipeline reads the nonce back out of that request-header
   CSP value and automatically stamps it onto every script it renders
   itself: the React/Next runtime chunks, page bundles, and any
   `next/script` component that's given a `nonce` prop. **No code is
   needed for this part** — it's automatic once the request header is set
   correctly.
3. `src/app/layout.tsx` reads `(await headers()).get('x-nonce')` and
   passes it to `<ThemeProvider nonce={nonce}>` — the ONE inline
   (`dangerouslySetInnerHTML`) script this app ships is next-themes'
   FOUC-prevention script (sets the light/dark class on `<html>` before
   hydration), and next-themes accepts a `nonce` prop specifically for
   this. If you ever add another genuinely inline script
   (`dangerouslySetInnerHTML` or a literal `<script>` tag, as opposed to
   `next/script src=...`), it needs the same `nonce={nonce}` treatment —
   grep `layout.tsx` for the pattern.

**Why `style-src` still has `'unsafe-inline'`:** CSP's `style-src` also
governs the `style` attribute (not just `<style>` tags), and several
components in `src/**` use inline `style={{...}}` attributes. Tailwind
ships no CSS-in-JS `<style>` injection to nonce instead of allowlisting.
Removing `unsafe-inline` from `style-src` was checked and explicitly
deferred — it isn't part of this task's script-src fix and would need its
own audit of every inline `style` usage.

**Calling `headers()` in the root layout forces dynamic rendering** for
the whole app (a nonce is meaningless on a page prerendered at build
time — no per-request value exists then). This is not a new tradeoff:
every route in `src/app/**` was already dynamically rendered before this
change (session/DB-backed at request time; `next build`'s output shows
every route as `ƒ (Dynamic)` except the static `/icon.svg`).

**Verifying it isn't broken:** `npx next build && npx next start`, then
either `curl -sD - <url>` and confirm the `Content-Security-Policy`
header has `'nonce-...'` and no `unsafe-inline` in `script-src`, or
(more conclusively) load a page in a real browser and check the console
for CSP violation errors — a white-screened app from a wrong nonce
usually shows as either a blank page or React hydration errors in the
console, not an HTTP-level failure. See `tests/lib/csp-nonce.test.ts`
for the header-shape unit tests (nonce present, no `unsafe-inline` in
`script-src` in production, two requests get two different nonces).

---

## Modifying the Rubric / Evaluation Flow

> **CORRECTION (2026-08-29).** The diagram that stood here was the v1 synchronous pipeline and the
> 2026-08-29 rewrite of this document missed it. It told you to `POST /api/evaluations/[id]/judge`,
> which is now an **18-line 410 Gone stub** — `src/app/api/evaluations/[id]/judge/route.ts` says so
> in its own doc comment ("DEPRECATED — use POST /api/evaluations/[id]/runs instead"), so anyone
> following the old step [2] got a 410 and no explanation from this guide. It also had the judge
> route loading "active ModelConfigs" and doing the LLM calls inline, which is the design 1b Task 9
> replaced with a queue. Redrawn below from `src/lib/run-launch.ts`, `src/lib/queue/topology.ts` and
> `src/worker/*` at `14d75f7`.

The evaluation pipeline has several linked components. Here's the data flow and where to make changes:

```
[1] User creates evaluation (projects/[id]/page.tsx)
     │  POST /api/evaluations { projectId, inputText, rubricId? }
     ▼
[2] User launches a run (evaluate/[id]/page.tsx)
     │  POST /api/evaluations/[id]/runs      ← NOT /judge, which is 410 Gone
     ▼
[3] Web tier — src/lib/run-launch.ts (launchSingleRun / launchBulkRunCreates):
     │  a. requireAuth + requireScope, rate-limited by judgeLimiter (Redis)
     │  b. requireOwnedActiveEndpoints — the ACTING user must own an active,
     │     verified ModelEndpoint for every selected JudgeModelVersion. The
     │     worker re-checks this independently at execution time.
     │  c. ONE $transaction writes EvaluationRun + RunModelSelections +
     │     ModelJudgment rows, all `pending`.
     │  d. The transaction COMMITS, and only THEN does it publish, on
     │     exchange `judge.direct`: one `judgment.execute` per selected model
     │     (awaited one at a time, selection capped at 10), or `run.create`
     │     for a bulk dataset launch. Publishing inside the transaction would
     │     hold a DB lock across N broker round trips — don't move it back in.
     │     The first publish failure stops the loop and compensates the run to
     │     `status: 'error'` rather than leaving it `pending` forever.
     ▼
[4] Worker process — src/worker/main.ts (`npm run worker`, its own container):
     │  a. run-create-consumer.ts   — `run.create` → fans out judgment.execute
     │  b. judgment-consumer.ts     — `judgment.execute` → claim → provider call
     │  c. failures re-queue via `judgment.retry.30s` / `judgment.retry.5m`
     │     (message TTL + dead-letter back to judgment.execute), then `judge.dlq`
     │  d. maybeFinalizeRun (src/lib/run-finalizer.ts) closes the run out —
     │     called from judgment-consumer.ts and from reaper.ts
     ▼
[5] Provider (src/lib/llm/provider.ts, called from the WORKER, not the route):
     │  a. buildJudgmentSystemPrompt() — rubric + criteria → system message
     │  b. buildJudgmentUserPrompt()   — input text → user message
     │  c. LLM API call
     │  d. parseJudgmentResponse()     — extract JSON, normalize scores
     ▼
[6] UI catches up two different ways — this is not yet uniform:
     │  · datasets list/detail subscribe to SSE (`new EventSource('/api/events')`)
     │  · evaluate/[id]/runs/[runId]/page.tsx still POLLS, setInterval 2500ms
     ▼
[7] Human evaluator scores (evaluate/[id]/page.tsx → HumanJudgmentForm)
     │  POST /api/evaluations/[id]/human-judgment
     ▼
Done.
```

### Common modifications

| Change | Files to edit |
|---|---|
| **Add a field to rubric criteria** | `prisma/schema.prisma` (RubricCriterion), `src/types/index.ts`, `rubric-builder.tsx`, `provider.ts` (prompt template) |
| **Change the scoring prompt** | `src/lib/llm/provider.ts` → `buildJudgmentSystemPrompt()` |
| **Change how scores are parsed** | `src/lib/llm/provider.ts` → `parseJudgmentResponse()` |
| **Add metadata to judgments** | `prisma/schema.prisma` (ModelJudgment), judge route, `model-judgment-card.tsx` |
| **Change the comparison view** | `evaluate/[id]/page.tsx` (the criteria comparison table section) |

---

## Adding a Keyboard Shortcut

### Global navigation shortcuts

Edit `src/components/layout/app-shell.tsx`. The handler uses a two-key sequence: `G` sets a pending flag, then the next key navigates.

```typescript
// In the keydown handler:
if (pendingG) {
  switch (e.key.toLowerCase()) {
    case 'x':
      router.push('/new-page');
      break;
  }
  setPendingG(false);
}
```

### Page-scoped shortcuts

Add a `useEffect` in the page component:

```typescript
useEffect(() => {
  const handler = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      doSomething();
    }
  };
  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}, []);
```

### Register in the shortcuts dialog

Update `src/components/layout/keyboard-shortcuts-dialog.tsx` — add your shortcut to the appropriate group array so it appears in the `?` help sheet.

---

## Expansion Ideas

Looking for something to work on? Here are high-impact areas:

| Area | Description |
|---|---|
| **CSV/JSON export** | Export evaluation results and inter-annotator agreement metrics. Add a route `GET /api/evaluations/export?projectId=` and a download button on the project page. |
| **Batch evaluations** | Upload a CSV of texts and run all of them against the same rubric in one batch. Requires a new upload UI and a queue system in the judge route. |
| **Inter-annotator agreement** | Compute Cohen's kappa or Krippendorff's alpha between model and human judgments. Add to the stats API and surface on a new analytics page. |
| **Rubric templates** | A library of pre-built rubrics (code review, essay grading, summarisation quality, safety). Ship as seed data + a "clone template" UI action. |
| **Model cost tracking** | Track token usage and compute estimated costs per provider. Add `costUsd` to ModelJudgment and surface totals on the dashboard. |
| **Dark mode** | The Tailwind config already defines tokens. Add `dark:` variants and a toggle in the header. |
| **Auth / multi-user** | Add NextAuth.js with session-based access. Add a `userId` column to evaluations and human judgments. |
| **WebSocket for live updates** | Replace polling in `evaluate/[id]/page.tsx` with a WebSocket or Server-Sent Events stream when judgments complete. |
| **Prompt versioning** | Version the system prompt independently of rubric criteria. Useful for A/B testing different judge instructions with the same rubric. |
| **Additional LLM providers** | Google Gemini, Cohere, Mistral, AWS Bedrock — see [Adding a New LLM Provider](#adding-a-new-llm-provider). |

---

## Deployment: production (judgearena.com)

**This section did not exist before 2026-08-29.** Until then the only deployment this guide
described was the Docker Compose rig below — which is a reference/demo topology and **is not what
serves `judgearena.com`**. A contributor could read the whole document and come away believing
`docker compose up -d` was production. It is not.

Production is the homelab Kubernetes cluster. Verified by `kubectl`/`psql` on 2026-08-29:

| | |
|---|---|
| URL | `https://judgearena.com` — returns 200 |
| Namespace | `tenant-public` |
| Database | CloudNativePG. Pod **`judge-arena-pg-1`**, container `postgres`, database **`judge_arena`** |
| Migrations applied | **19**, 0 unfinished, latest `20260830120000_v2i_calibration_item_link` — the same 19 that `prisma migrate deploy` lays on locally. (Was 18 / `v2h` when this table was written on 2026-08-29; re-verified 2026-08-31.) |
| Image | built by CI as `sha-<12-char commit>` and pushed to Harbor by an ephemeral kaniko `Job` in `tenant-builds` (see `.gitea/workflows/ci.yml`'s `build-push` job) |
| Deployed at the time of writing | `sha-bee1d121ea7d`, with a promote to the `14d75f7` build in flight |
| Deployed **now** (re-checked later the same day) | `sha-14d75f7d46de` — the promote landed. `kubectl get deploy -n tenant-public -o jsonpath=…` shows both `judge-arena-web` and `judge-arena-worker` on `harbor.cluster.asethi.com/homelab/judge-arena:sha-14d75f7d46de`, pods ~2m old. The row above is left as the reading it was. |
| Deployed on **2026-08-31, 21:23Z** | `sha-c6417860027a` — commit `c641786`, **two commits behind `main`**, so the concurrency cap was not yet in production. **SUPERSEDED 6 minutes later**; kept because a reading is a claim about a moment, and this is the pair that shows how fast that claim decays. |
| Deployed on **2026-08-31, 21:29Z** | `sha-1e7a427d2c48` — commit `1e7a427`, both Deployments, pods rolled. The cap is live, and the worker's own boot log is the proof: `{"msg":"EVALUATION_MODEL_CONCURRENCY_PER_RUN clamped to the hard cap","requested":2,"effective":1}` followed by `{"msg":"judge worker started","prefetch":1,"concurrency":1}`. **The Deployment still sets `EVALUATION_MODEL_CONCURRENCY_PER_RUN=2` and the worker runs at 1 anyway** — that env var is now a statement of intent, not a control. Read the boot log, not the manifest. |

**Merging to `main` does not deploy.** judge-arena is a **manual-promote** app (`286da59`; it is
deliberately excluded from the build-lag exporter). A push to `main` builds and publishes an image;
a deploy is a separate, human tag bump in the homelab repo. Flux being green means Flux is doing
what it was told — not that production is running your commit.

**Three names that look interchangeable and are not:**

- **`judge-arena-pg`** — the local podman container.
- **`judge-arena-pg-1`** — the production Kubernetes pod. One character apart from the above. See
  trap (b) in [Development Setup](#development-setup); never aim a local Prisma command at it.
- **`judgearena`** — neither of those. It is the user/database name used *only inside*
  `docker-compose.yml`'s self-contained network. Production's database is `judge_arena`, with the
  underscore, and so is every local one. Do not copy a connection string from `docker-compose.yml`
  and expect it to work anywhere outside compose.

### Running a calibration against production (A2.1, 2026-08-31)

Two entrypoints are bundled into the image (`Dockerfile`, esbuild — the runner ships no TypeScript
toolchain). They must run **inside the cluster**, because that is the only place that can reach both
`judge-arena-pg-rw.tenant-public` and a judge endpoint; a workstation has no route to either.

```sh
# Register a judge. Reuses createCustomJudgeModel — the same chokepoint POST /api/models goes
# through — so the judge gets a `model.create` audit row instead of being invisible to the trail.
kubectl -n tenant-public exec deploy/judge-arena-web -- node /app/add-judge.js \
  --name="<display name>" --backend=llamacpp \
  --base-model="<the id the server actually serves>" \
  --endpoint="http://<host>:8001/v1" [--max-tokens=8192] [--protocol=pairwise] [--dry-run]

# Launch + score. Prints accuracy WITH its denominator, kappa with its method, the raw verdict
# distribution, and every disagreement with the model's own reasoning.
kubectl -n tenant-public exec deploy/judge-arena-web -- node /app/calibration-run.js \
  --golden-set=<goldenSetId> --judge-version=<judgeModelVersionId>

# Re-score without launching (idempotent — full overwrite, nothing increments):
kubectl -n tenant-public exec deploy/judge-arena-web -- node /app/calibration-run.js \
  --score-only=<calibrationRunId>
```

> **THE FIRST COMMAND THAT LAUNCHES FREEZES THE GOLDEN SET, IRREVERSIBLY.** `isGoldenSetFrozen` is
> `calibrationRun.count({ where: { goldenSetId } }) > 0` (`src/lib/golden-sets.ts:266-272`) — there
> is no `frozenAt` column and no unfreeze verb anywhere in the product. Once the `CalibrationRun`
> header commits, that set's items, candidates, `protocol` and `expected` are read-only forever;
> deleting the calibration is not possible (`EvaluationRun.calibrationRunId` is `onDelete: Restrict`)
> and retiring or tombstoning the set does not release it. The only way to change a frozen set's
> content is `POST /api/golden-sets/[id]/fork`, which makes a new set at version+1.
> `launchCalibrationRun` therefore checks **everything knowable without touching an item** before
> writing that header — otherwise the failure shape is a set pinned forever by a calibration in
> which all 30 items failed for one reason that was knowable before any of them ran.

Use `--dry-run` on `add-judge.js` when you are unsure of the served model id, the backend or the
endpoint's `/v1` suffix: those are the fields that are easiest to mistype and they fail **late**, at
judgment time, after a run has already been launched.

Note also what a calibration is **not**: it is not a parallel execution path. `launchCalibrationRun`
creates rows and calls `launchSingleRun` N times; it publishes nothing itself and knows nothing about
providers. A calibration run is an ordinary pairwise run with two extra columns set, drained by the
same `judgment.execute` consumer as everything else. If you are debugging one, debug the normal
pipeline.

### Known open production defect (2026-08-24 →, unfixed)

Worth knowing before you touch the queue layer, because it is a code defect and not a config one:
**the evaluation pipeline was dead from 2026-08-24T17:55Z until the 2026-08-29 promote rolled the
worker** — read the dated update at the end of this subsection before acting on the paragraph that
follows it. At the time it was diagnosed, all five RabbitMQ queues reported
`consumer_count=0`. A Cozystack v1.6.2 roll recreated `judge-arena-pg-1` at 17:54:57Z; 21 seconds
later the worker logged `Can't reach database server` / `terminating connection due to administrator
command` (SQLSTATE `57P01`) and then emitted no log line for five days. The pod was `1/1 Running`
with 0 restarts throughout, which is exactly why this is easy to miss. Its socket reconnected; **its AMQP consumers
never re-registered.** A worker rollout restores service, but the underlying defect — the AMQP
client re-registers consumers only on boot, never on reconnect — is still open in `src/lib/queue/`
and `src/worker/`. If you fix it, the test for it belongs in `tests/integration/` (real broker), and
per [Testing Conventions](#testing-conventions) the injection to try is killing the connection out
from under a live consumer and asserting delivery resumes.

**Update (2026-08-29, later the same day): the outage is over; the defect is not.** Promoting to
`sha-14d75f7d46de` rolled `judge-arena-worker`, which is exactly the "a worker rollout restores
service" path above — nobody fixed anything. `kubectl exec -n tenant-public
rabbitmq-judge-arena-server-0 -c rabbitmq -- rabbitmqctl list_queues name consumers messages` now
reports `run.create` **1** and `judgment.execute` **1**, both with 0 messages. The other three
(`judge.dlq`, `judgment.retry.30s`, `judgment.retry.5m`) still read 0 consumers and always should:
they are the dead-letter and TTL-delay queues from `src/lib/queue/topology.ts`, and nothing
subscribes to them by design — so "5 queues at zero" was the shape of the outage, but "2 queues at
one" is the shape of health. **The reconnect defect is still open**, so the next broker or database
blip reproduces this on a pod that stays `1/1 Running` with 0 restarts.

---

## Deployment: Docker Compose v2 (Task 16)

> **Scope note (2026-08-29).** This is the self-contained demo/reference topology — it is what
> `--scale` experiments and the spec's S4 exit gate run on. It is **not** the production
> deployment; see [Deployment: production](#deployment-production-judgearenacom) above.

`Dockerfile` builds one image with two long-running entrypoints — `server.js`
(web) and `worker.js` (queue consumer, an esbuild bundle of
`src/worker/main.ts`) — plus a third Dockerfile stage (`builder`) that
`docker-compose.yml`'s `migrate` service targets directly for its full
Prisma CLI + `prisma/migrations`. See the Dockerfile's own top-of-file
comment for the three-stage rationale, and `docker-compose.yml`'s top
comment for the service list and usage (`docker compose up -d`, or
`docker compose up -d --scale app=2 --scale worker=2` for the scaled demo
rig).

Three things worth knowing if you're touching either file:

1. **Migrations run exactly once**, in the `migrate` one-shot service — not
   in any `app`/`worker` replica's CMD. Running `prisma migrate deploy` in
   every replica's boot command was the pre-Task-16 shape, and it breaks
   under `--scale app=N`: N replicas starting concurrently all race the
   migration (Prisma's advisory lock serializes the *statements*, but
   replicas can still fail/crash-loop on lock contention). `app`/`worker`
   both `depends_on: migrate: condition: service_completed_successfully`
   instead.

2. **`app`/`worker` are scale-safe by construction**: no `container_name`
   (compose refuses to scale a service with a fixed name — duplicate-name
   error on the 2nd replica) and no static host-port publish (the 2nd
   replica fails to bind the same host port). `nginx`
   (`deploy/nginx-lb.conf`) is the only service that publishes a web-facing
   host port; it round-robins across whatever `app` replicas exist at
   nginx's own startup (Docker Compose's embedded DNS resolves `app` to
   one A record per replica, and nginx's `upstream { server app:3000; }`
   expands that into one peer per address — see that file's header for the
   static-resolution caveat).

3. **Prisma connection-pool budget** (spec §4 — the deps-build critique's
   MAJOR finding: "Prisma connection pool unbounded per replica"). Prisma's
   default pool size is `num_physical_cpus * 2 + 1` *per process* with no
   cap — on any real host that's dozens of connections per replica, and it
   scales with replica count, not with any deliberate budget. Every
   `DATABASE_URL` in `docker-compose.yml` now carries an explicit
   `connection_limit` + `pool_timeout=20` query param instead:

   | Service | `connection_limit` | Why |
   |---|---|---|
   | `app` | `10` | Fixed — the web tier's per-request Prisma usage is short-lived (single query/transaction per API route handler), 10 concurrent connections comfortably covers request bursts without either starving other services or holding connections idle. |
   | `worker` | `EVALUATION_MODEL_CONCURRENCY_PER_RUN × 2` (default `2 × 2 = 4`, via compose's `WORKER_DB_POOL_LIMIT`) | Sized to the worker's own concurrency knob — one connection per in-flight judgment's claim update, one headroom slot so the persist-result write doesn't serialize behind another in-flight claim on the same pool. ~~Raise `EVALUATION_MODEL_CONCURRENCY_PER_RUN` → raise `WORKER_DB_POOL_LIMIT` to match.~~ **See the note below: since 2026-08-31 raising that env var raises nothing.** |
   | `migrate` | `5` | One-shot, transient — Prisma's migration engine doesn't need much, and it never runs concurrently with itself. |

   > **CORRECTION 2026-08-31 — the `worker` row's sizing rule no longer has a knob to follow.**
   > `EVALUATION_MODEL_CONCURRENCY_PER_RUN` is now **clamped to a hard cap of 1**
   > (`src/worker/concurrency.ts`, `HARD_CONCURRENCY_CAP`), so setting it to 8 changes the *pool
   > budget* in this table and changes **nothing** about how many judgments actually run at once.
   > Two things follow: (a) the pool row overshoots harmlessly rather than under-provisioning, so
   > there is nothing urgent to fix here; and (b) **do not treat this row as evidence that the
   > concurrency knob is live.** It is not, and the clamp is logged at `warn` on boot.
   >
   > The cap exists because prefetch is not a buffer in this worker: `dispatch` starts a handler for
   > every message the broker delivers, so `prefetch = concurrency × 4` issued **eight** concurrent
   > provider calls at concurrency 2. Against a llama.cpp server advertising `total_slots: 2`, six of
   > those queued *inside the inference server* while their 300s client timeout ran, and 4 of 30
   > items of the first production calibration dead-lettered at `timed out after 300000ms` — while
   > the 26 that completed had a stored `latencyMs` averaging **233s** — median 265s, max 299,063 ms
   > against the 300,000 ms timeout, i.e. 26 of 30 finished within a second of the wall. (`latencyMs`
   > is measured around the HTTP call in `src/lib/llm/openai-compatible.ts:249`, so it *includes*
   > time queued inside the inference server, which is precisely why it is inflated here.) When this
   > eventually grows, the fix is
   > **per-endpoint** concurrency (a value beside the endpoint that constrains it, with a scheduler
   > that respects it per endpoint), not a bigger global number. Read that module's header before
   > touching either value.

   **The formula to check before scaling further** (also in
   `docker-compose.yml`'s `app` service comment):

   ```
   (app replicas × app connection_limit)
     + (worker replicas × worker connection_limit)
     + migrate's connection_limit
     + admin/psql headroom
   < Postgres max_connections
   ```

   `postgres:16-alpine`'s unmodified default is `max_connections=100`. At
   the defaults above, 4 app + 4 worker replicas budgets to
   `4×10 + 4×4 + 5 + ~10 headroom = 71 < 100` — comfortable up to that
   scale. Past it, either raise Postgres's own `max_connections` (`command:
   postgres -c max_connections=<N>` on the `postgres` service) or front it
   with a connection pooler (CNPG ships pgbouncer built in for the real
   k8s deployment target — see `docs/superpowers/specs/` for that
   architecture). Recompute the sum; don't just bump one service's limit
   in isolation.

---

## Continuous Integration (Task 17)

Two CI files, two different jobs:

| File | Role |
|---|---|
| `.gitea/workflows/ci.yml` | **Canonical, and it runs for real.** Self-hosted Gitea (`gitea` remote, `ssh://git@10.10.0.211/trij/judge-arena.git`). Three jobs: `ci`, `db-tests`, `build-push`. |
| `.github/workflows/ci.yml` | **Demoted mirror.** One job, `mirror-check`: lint + typecheck + unit tests (DB-free) + build. No deploy, no Docker, no DB-backed suites. GitHub is a mirror of this repo, **not a release gate.** |

### What actually gates a merge

`main` lives on the self-hosted Gitea. The three jobs in `.gitea/workflows/ci.yml`, in dependency
order:

| Job | Runs on | What it does | Can it go red? |
|---|---|---|---|
| `ci` | the act_runner host | SSH checkout, install Node 22.23.1, `npm ci`, `npm run db:generate:v1`, `npm run lint`, `npx tsc --noEmit`, the unit suite **with its coverage gate**, `npm run build` | **Yes — this is a real gate.** |
| `db-tests` | an ephemeral k8s `Job` it spawns in `tenant-builds` | `npm run test:db:coverage && npm run test:integration` (so the DB coverage gate and the 5 seed guards run too) | **Yes — this is a real gate.** |
| `build-push` | the act_runner host, `needs: [ci, db-tests]` | On a push to `main`: spawns a kaniko `Job` that publishes **both** `sha-<12-char commit>` **and** `:latest` to Harbor (`git rev-parse --short=12`; see the job's "Report the pushed image" step) — which is why the publish guard is re-asserted inside the spawn step rather than trusted from a step `if:`. On a PR: every step no-ops and it reports success in seconds, having published nothing. | Only on a genuine build failure — or if a future edit breaks a publish guard, which it asserts loudly rather than skipping quietly. |

So **`ci` and `db-tests` are the two that fail a change**, and `build-push`'s `needs: [ci,
db-tests]` is the coupling that keeps a red database layer from ever reaching Harbor as a
deployable-looking image (judge-arena's deploy is a manual tag bump, so a bad image would just sit
there looking fine). The GitHub `mirror-check` job gates nothing.

`build-push` deliberately carries **no job-level `if:`** — it used to, and on a PR Gitea never
transitioned the resulting commit status out of `pending` ("Blocked by required conditions",
observed on PR #9), which was cosmetic only for as long as no branch protection required these
checks and would have deadlocked every merge the moment one did. One thing this document cannot
verify from inside the repo: **whether Gitea branch protection currently marks these checks
*required*.** There is no Gitea CLI or API token available in this working environment, and the
workflow's own comment on `build-push` (`.gitea/workflows/ci.yml`, "That was cosmetic only while no
branch protection required these checks") records that none did when it was written — that is a
comment on the job, not the file header, and it dates from authoring rather than from today.
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

### Why the Gitea workflow is raw shell

> **CORRECTION (2026-08-29).** This subsection used to open *"This repo is not hosted on Gitea yet —
> that migration is Phase 2 of the 1b plan"*, described the `services:` block as **"authored to spec
> but not provably executable"**, and concluded that **"`scripts/ci-local.sh` is what 'CI green'
> means"**. All three statements are now false. The repo IS on Gitea (`git remote -v` lists `gitea`
> as a real remote and `main` is pushed there — `14d75f7`). The `services:` block was **deleted**,
> not left decorative, and the DB and integration suites have run for real in CI since 2026-08-12.
> `scripts/ci-local.sh` is still valuable — it is the fastest local reproduction, and it and the
> `db-tests` job source the *same* `.env.test` so a failure reproduces identically in both places —
> but it is no longer the definition of green. The Gitea run is.

The homelab Gitea Actions runner (`act_runner`, host mode — see `homelab-setup`'s
`apps/internal/gitea-runner/{deployment.yaml,image/Containerfile}`) has two hard constraints baked
into every step of that file:

1. **No JavaScript actions.** The runner executes workflow steps directly
   on its own Alpine 3.20 host (no per-job container, no Docker socket) —
   `uses: actions/checkout@v4`, `actions/setup-node@v4`, etc. all require a
   JS-action runtime this runner doesn't have. Every step is a plain
   `run:` shell block; checkout is a raw `git clone` over SSH (matching
   every other first-party repo's `.gitea/workflows/*.yaml` in this
   homelab — job-ops, homeview, personal-feed).

2. **No Node.js, no container engine, at all, on the runner image.** Node
   22 is installed at the START of every run (a musl-static tarball from
   `unofficial-builds.nodejs.org` — Alpine's own `apk` repos at the pinned
   3.20 release don't carry Node 22 yet, and official nodejs.org builds
   are glibc-only). More importantly, there is **no Docker/Podman/Buildah
   binary on the runner at all** — real OCI builds in this homelab spawn
   ephemeral kaniko `Job`s in the cluster via `kubectl`, never `docker
   build` inline on the runner.

Constraint 2 is why a Docker `services:` block cannot start anything here, and the block that used
to sit in this file **was deleted rather than left in place** — YAML that cannot execute reads to
every future maintainer as coverage that exists. What replaced it (Stage 6, 2026-08-12) is the
`db-tests` job: **one** ephemeral k8s `Job` in `tenant-builds` whose pod carries
postgres/redis/rabbitmq as **native sidecars** (`initContainers` with `restartPolicy: Always`)
alongside the Node test container. Containers in a pod share a network namespace, so `localhost:5432`
works exactly as `services:` intended, and `.env.test` — which already points at `localhost` — is
the single source of connection strings both locally and in CI. `restartPolicy: Always` is
load-bearing, not decoration: a `Job` pod only reaches `Complete` once every entry under
`containers:` terminates, and postgres never exits, so listing the services there would hang every
run to `activeDeadlineSeconds` and report `DeadlineExceeded` whether or not the tests passed. Native
sidecars are excluded from that check.

One more piece of history that is baked into the workflow as an assertion: this file spent its whole
early life failing at `Setup Node` and therefore **ran nothing** — the runner image had no
`libstdc++`, so the musl Node binary died at exec with relocation errors (fixed 2026-08-11, runner
image `0.4.1-kubectl-5`, homelab divergence entry 61). The unit-test step now carries an explicit
"the suite actually ran" assertion, because a red setup step and a red test step look identical in
the run list and mean opposite things about coverage.

**`scripts/ci-local.sh` is the local reproduction of that pipeline**, and the fastest way to
exercise the DB and integration suites before pushing:

```bash
bash scripts/ci-local.sh
```

It runs, in 11 steps against the local podman services from
[Development Setup](#development-setup), the UNION of what the two Gitea jobs run — the workflow
splits that sequence across `ci` (host) and `db-tests` (spawned pod), and this script does the whole
thing in one process, which is why it is a reproduction rather than a literal copy of either job.
Its own header and its per-step "expect N passed" banners were written at Task 17 and still quote
361/281/73; the current numbers are in [Running the Tests](#running-the-tests).
It fails fast with a clear message if a service isn't reachable, and prints `CI-local: ALL GREEN` only if lint, typecheck, `prisma migrate deploy`,
the v1-scratch-DB push, all 3 test suites (with their two coverage gates) and `npm run build` all
pass — in that order, minus the kaniko stage, which is CI-only. It is not a substitute for the
Gitea run; it is how you find out before the Gitea run does.

### Two non-obvious prerequisites this task's authoring surfaced

Both were true before Task 17 (nothing here changes application behavior)
but had never been exercised from a genuinely clean `npm ci` before — CI
authoring is what surfaced them:

- **The importer's `@prisma/v1-client` needs its own generate step.**
  `package.json`'s `postinstall` (`npx prisma generate`) only generates
  the default (v2) client. `scripts/importer/{context,artifacts,runs}.ts`
  and `tests/importer/helpers.ts` import `@prisma/v1-client` directly — a
  *second*, independently-generated client from
  `prisma/v1/schema.v1.prisma`'s custom `output`. Without running `npm run
  db:generate:v1` first, `tsc --noEmit` fails outright with `TS2307:
  Cannot find module '@prisma/v1-client'` in exactly those files
  (reproduced and verified at Task 17 authoring time). Both
  `scripts/ci-local.sh` and `.gitea/workflows/ci.yml` run this
  immediately after `npm ci`, before lint/typecheck.

- **The v1 scratch database needs its own seed step.** `tests/importer/
  *.db.test.ts` (part of the `test:db` suite — 281 tests when this was
  written at Task 17, 641 at `14d75f7`) needs a second
  database (`V1_DATABASE_URL`, seeded with the frozen v1 schema) — `prisma
  migrate reset` (which `npm run test:db` runs internally) only touches
  `DATABASE_URL`/the v2 schema, per `.env.test`'s own comment. The fix is
  `npm run db:push:v1` (a new script — as it stands in `package.json`
  today, `sh -c 'set -a; . ./.env.test; set +a; npx prisma db push --schema
  prisma/v1/schema.v1.prisma --skip-generate'`, the same env-sourcing
  wrapper described in trap (a) above), run once before
  `test:db`. `prisma db push` auto-creates the target database if it
  doesn't exist yet (verified at authoring time by dropping and
  recreating it), and no-ops cleanly (`already in sync`) on repeat runs —
  safe to always run, in CI or locally.

### Test coverage

`npm run test:coverage` (`vitest run --coverage`, `vitest.config.ts`) and
`npm run test:db:coverage` (same, `vitest.db.config.ts`) both gate on
`coverage.thresholds` — a real regression in either run fails the command
(and therefore `scripts/ci-local.sh`; in Gitea it is the `ci` job that carries
the unit gate and the `db-tests` job that carries the DB one, not `ci` for
both — see [What actually gates a merge](#what-actually-gates-a-merge)).
`test:integration`
does **not** carry a coverage gate (see "What isn't measured" below).

**Why 3 separate numbers, not one.** The 3 suites (unit/db/integration)
are 3 separate vitest configs with 3 separate processes — `@vitest/
coverage-v8` doesn't merge coverage across separate CLI invocations, and
merging the raw v8/istanbul JSON output across runs is more tooling than
this task's scope justifies. Instead, coverage is measured **per run**,
against whatever that run's `coverage.include` says, with thresholds set
to that run's own actuals. This isn't a compromise so much as it's the
more informative shape: a given source file's "real" coverage depends on
*which kind of test exercises it* — DB-free unit tests can't touch
anything requiring a live Postgres/Redis/RabbitMQ connection, so a file
that's 0% in the unit run but 95% in the db run is not a gap, it's the
DB-free run correctly reporting that it never touched that file.

**What each run measures** (Task 17 broadened both from the 1a-era
`src/lib/**/*.ts`-only include to also cover `src/worker/**` and
`scripts/importer/**` — the 1b-rewritten subsystems: queue, worker,
providers/llm, auth-guard, importer, realtime):

| Run | `coverage.include` | Where the *rewritten subsystems* actually land |
|---|---|---|
| `test:coverage` (unit, DB-free) | `src/lib/**`, `src/worker/**`, `scripts/importer/**` | `src/lib/llm/**` (heavily unit-tested, ~94% stmts/lines), `src/lib/queue/connection.ts` (unit-tested), `src/lib/realtime/ownership.ts` (unit-tested), `src/worker/dispatch-failure.ts` (unit-tested). Everything else in those 3 directories needs a live service and shows near-0% here — expected, not a regression. |
| `test:db:coverage` (`vitest.db.config.ts`) | same include | `src/lib/auth-guard.ts` (~86%, exercised transitively through real API route handlers under a live DB — `tests/db/access-matrix.test.ts`) and `scripts/importer/**` (~96%, the `*.db.test.ts` files that need both the v1 scratch DB and the v2 test DB). |
| `test:integration` (no coverage gate) | n/a | `src/worker/{claim,main,reaper,run-create-consumer,judgment-consumer}.ts`, `src/lib/queue/{publish,topology}.ts`, and most of `src/lib/realtime/**` (`bus.ts`, `redis-bus.ts`, `factory.ts`, `in-memory-bus.ts`, `events.ts`) run almost exclusively here (RabbitMQ consumers, SSE over real Redis). Pass/fail-verified by `test:integration` (73 tests at Task 17, 80 at `14d75f7`), but genuinely **not coverage-gated** — see below. |

Per-directory thresholds (vitest's glob-keyed `coverage.thresholds` — see
`vitest.config.ts` / `vitest.db.config.ts`) are set **at or a hair below**
each glob's actual measured number as of Task 17 (2026-07-30), so today's
numbers pass and a real regression in that specific subsystem fails —
rather than only being caught (or masked) by the blended, repo-wide
aggregate. The top-level `lines/functions/branches/statements` keys in
each config are a **separate, additional** aggregate check across every
file the `include` glob matches (not a "leftover bucket" for files no
per-directory glob covers) — both checks run independently.

**What isn't measured, honestly.** `test:integration` has no `coverage`
block at all. The subsystems that live almost entirely there (worker
consumers, queue topology/publish, most of the realtime bus) are
correctness-verified by that suite (73 tests at Task 17, 80 at `14d75f7`) but have no regression gate
on *how much* of their code those tests actually exercise. Adding a third
coverage config was in scope for this task's "pragmatic" framing but
judged not worth the added CI time/complexity for suites whose
correctness is already RabbitMQ/Redis-timing-sensitive (see `vitest.
integration.config.ts`'s `fileParallelism: false` comment) — revisit if
`src/worker/**`/`src/lib/queue/**` coverage ever needs tightening beyond
pass/fail.

**Updating thresholds** after a real coverage change: run `npm run
test:coverage` and/or `npm run test:db:coverage`, read the actual
per-file/per-glob numbers from the printed report, and set the
corresponding `coverage.thresholds` entry at or slightly below the new
actual (never above — a threshold above current reality just breaks CI
immediately). Vitest also supports `thresholds: { autoUpdate: true }` to
have it rewrite the config file's numbers for you on a passing run; not
enabled by default here (silently ratcheting thresholds up on every green
run is a footgun for a lightly-staffed repo), but worth reaching for if
this becomes tedious.

---

## Pull Request Guidelines

1. **One concern per PR.** A new provider, a new page, or a bug fix — not all three.
2. **Run the gates before pushing**, not just the build. In CI order:
   `npm run lint` → `npx tsc --noEmit` → `npm run test:coverage` → `npm run test:db:coverage` →
   `npm run test:integration` → `npm run build`, or `bash scripts/ci-local.sh` to get all of them in
   one command. The last three need the podman services from
   [Development Setup](#development-setup) — a connection error there is a missing container, not a
   broken change.
3. **Inject against your own new tests** before you call them done, and treat a still-green suite as
   a finding — see [Testing Conventions](#testing-conventions).
4. **If you touched a rendering surface, walk the runbook and add rows to it.**
   `docs/runbooks/studio-manual-verification.md`; nothing that renders is unit-testable here.
5. **Match existing conventions** — if you're unsure, look at a similar file.
6. **Keep UI components dependency-free** — no new `npm install` for UI primitives.
7. **Update types** — if you change the schema or API shape, update `src/types/index.ts`.
8. **Update this guide** — if your change introduces a new pattern that future contributors should
   follow, document it here. And if you find a claim in here that is wrong, **say that it was wrong
   and what it said** rather than silently overwriting it; the `CORRECTION` notes above are this
   repo's convention, and they are the reason the same mistake isn't made twice.
