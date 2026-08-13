# Contributing to Judge Arena

Thanks for your interest! This guide covers the repo layout, conventions, and concrete recipes for the most common types of contributions.

---

## Table of Contents

1. [Development Setup](#development-setup)
2. [Project Structure at a Glance](#project-structure-at-a-glance)
3. [Conventions](#conventions)
4. [Adding a New LLM Provider](#adding-a-new-llm-provider)
5. [Adding a New UI Component](#adding-a-new-ui-component)
6. [Adding a New API Route](#adding-a-new-api-route)
7. [Adding a New Page](#adding-a-new-page)
8. [Extending the Database Schema](#extending-the-database-schema)
9. [API wire-format changes (v2, 1a)](#api-wire-format-changes-v2-1a)
10. [Modifying the Rubric / Evaluation Flow](#modifying-the-rubric--evaluation-flow)
11. [Adding a Keyboard Shortcut](#adding-a-keyboard-shortcut)
12. [Deployment: Docker Compose v2](#deployment-docker-compose-v2-task-16)
13. [Continuous Integration](#continuous-integration-task-17)

---

## Development Setup

```bash
git clone <repo-url> judge-arena && cd judge-arena
cp .env.example .env          # fill in at least one API key
npm install
npm run setup                 # prisma generate → db push → seed
npm run dev                   # http://localhost:3000
```

The database is SQLite (`prisma/dev.db`). You can wipe it and re-seed at any time:

```bash
rm prisma/dev.db
npm run db:push
npm run db:seed
```

---

## Project Structure at a Glance

```
src/
├── app/                       # Next.js App Router
│   ├── api/                   # REST API (one folder per resource)
│   │   ├── evaluations/       # CRUD + /judge + /human-judgment
│   │   ├── models/            # CRUD
│   │   ├── projects/          # CRUD
│   │   ├── rubrics/           # CRUD + /versions
│   │   └── stats/             # Dashboard counters
│   ├── evaluate/[id]/page.tsx # Core evaluation workspace
│   ├── models/page.tsx        # Model management
│   ├── projects/              # Projects list + [id] detail
│   ├── rubrics/page.tsx       # Rubric management + versioning
│   ├── layout.tsx             # Root layout
│   └── page.tsx               # Dashboard
├── components/
│   ├── evaluation/            # Feature components for the evaluation flow
│   ├── layout/                # App shell, sidebar, header, shortcuts dialog
│   ├── models/                # ModelConfigForm
│   ├── rubric/                # RubricBuilder
│   └── ui/                    # 13 generic primitives (button, dialog, …)
├── lib/
│   ├── db.ts                  # Prisma singleton
│   ├── utils.ts               # Shared utilities
│   └── llm/                   # Provider abstraction layer
│       ├── provider.ts        #   Interface + prompt builders + response parser
│       ├── anthropic.ts       #   Anthropic Messages API
│       ├── openai-compatible.ts # OpenAI Chat Completions (+ any compatible)
│       └── index.ts           #   Registry: getProvider, executeJudgment
└── types/
    └── index.ts               # Shared TypeScript interfaces
```

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
- Complex workflow: `src/app/api/evaluations/[id]/judge/route.ts` (parallel LLM calls)

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

> **Superseded recipe below the line, kept for the pre-v2/SQLite `db:push`
> workflow only.** Since the v2 migration (1a) the project runs Postgres
> with real, checked-in migrations under `prisma/migrations/` — every
> environment (dev, `test:db`, CI-to-be per the 1b plan's Task 17) applies
> `prisma migrate deploy`/`migrate reset`, never `db push`. Use the recipe
> immediately below for any schema change from 1a onward; the old `db push`
> steps still work against a scratch SQLite/`dev.db` setup but are not how
> this repo's real databases are changed.

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
   PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION=<approved-plan-id> npx prisma migrate deploy
   ```

   The consent env var is this environment's gate on agent-run schema
   changes against a real database — use the id approved for the plan/task
   doing the work (dev DB is disposable, but the gate still applies).
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
gate would pass clean today. Currently four cases (the count was stale at
"one" while the table already listed two — corrected while landing A0):

| Migration | What's really there | Why `schema.prisma` can't say it |
|---|---|---|
| `20260728215410_v2b_idempotency_tighten` | `ModelJudgment_runId_judgeModelVersionId_pairOrder_key` recreated `NULLS NOT DISTINCT` (real pointwise idempotency, 1b Task 6) | `@@unique([runId, judgeModelVersionId, pairOrder])` has no Prisma DSL syntax for `NULLS NOT DISTINCT` (PG15+) |
| `20260729180000_v2b_email_partial_unique` | `User_email_credentials_key`, a unique index on `User(email)` restricted to `WHERE "passwordHash" NOT LIKE '!%'` (real-credentials rows only, 1b Task 13 review fix) | Prisma's schema DSL has no syntax for a partial index (`WHERE` clause) at all — not specific to this predicate |
| `20260812190000_v2d_golden_substrate` | `GoldenSet_ownerId_slug_key` created `NULLS NOT DISTINCT` (ownerless golden sets can't share a slug — A0 step 1) | `@@unique([ownerId, slug])` has no Prisma DSL syntax for `NULLS NOT DISTINCT` (PG15+), same as the idempotency case above. Re-verified empirically on Prisma 6.19.2 against a database with this migration applied: `migrate diff --from-url ... --to-schema-datamodel` reports an empty migration. A partial variant (`... NULLS NOT DISTINCT WHERE "slug" IS NOT NULL`) was tried and REJECTED — it produces REAL drift, with `migrate diff` proposing `CREATE UNIQUE INDEX "GoldenSet_ownerId_slug_key" ON "GoldenSet"("ownerId", "slug");` to "fix" it. A partial unique index does not satisfy a Prisma `@@unique`; the email row above only escapes this because its schema declares no `@unique` at all. |
| `20260813120000_v2e_golden_item_label_tombstones` | `GoldenLabel_goldenItemId_annotatorId_live_key`, a unique index on `GoldenLabel(goldenItemId, annotatorId)` restricted to `WHERE "tombstonedAt" IS NULL` (one LIVE label per annotator per item — A0, tombstone-not-delete ruling) | Prisma's schema DSL has no syntax for a partial index, same as the email row above. Unlike that row, this one REPLACES a declared `@@unique`, which is therefore deleted from `prisma/schema.prisma` — so the Prisma client no longer offers the `goldenItemId_annotatorId` compound where-input (verified unused before landing), and P2002 from this index reports `meta.target` as the index name string rather than a field array. The `NULLS NOT DISTINCT` variant (`@@unique([goldenItemId, annotatorId, tombstonedAt])`) was tried and REJECTED: it equates `annotatorId`'s nulls too, so account deletion's `SetNull` would collide for two deleted annotators on one item. |

The real hazard is the opposite direction from "drift tooling nags you to
revert it": because `schema.prisma` can never re-declare this attribute,
the migration file's raw SQL is the ONLY record of it. If a future
migration ever needs to recreate this same index for an unrelated reason
(e.g. touching a column it covers), that migration must hand-add `NULLS
NOT DISTINCT` again — nothing in the toolchain will warn if it's
forgotten, for the same reason nothing warns about drift today: Prisma
can't see the attribute either way. Anyone adding a NEW schema change that
also needs a Prisma-inexpressible SQL clause should add a row to this
table and re-verify (`db pull`/`migrate diff`/`db push` against a database
that has the migration applied) rather than assume the "pseudo-drift"
framing without checking — as this section itself originally did, before
being corrected against real `psql`/Prisma output while landing 1b Task 6.

### Schema conventions

- Use `cuid()` for primary keys.
- Add `createdAt DateTime @default(now())` and `updatedAt DateTime @updatedAt` to every model.
- Add `@@index` on foreign key columns.
- Use `onDelete: Cascade` for owned relations (e.g., criteria belong to rubric).
- JSON payloads use Prisma `Json` (JSONB) columns (criteriaScores et al. migrated in v2); document expected shape in a comment beside the field.

### Recipe (pre-v2, SQLite `db:push` — superseded)

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

The evaluation pipeline has several linked components. Here's the data flow and where to make changes:

```
[1] User creates evaluation (projects/[id]/page.tsx)
     │  POST /api/evaluations { projectId, inputText, rubricId? }
     ▼
[2] User clicks "Run Models" (evaluate/[id]/page.tsx)
     │  POST /api/evaluations/[id]/judge
     ▼
[3] Judge route:
     │  a. Loads evaluation + rubric criteria
     │  b. Loads active ModelConfigs
     │  c. For each model → executeJudgment(provider, request, config)
     │  d. Writes ModelJudgment rows
     │  e. Updates evaluation.status
     ▼
[4] Provider (src/lib/llm/provider.ts):
     │  a. buildJudgmentSystemPrompt() — rubric + criteria → system message
     │  b. buildJudgmentUserPrompt()   — input text → user message
     │  c. LLM API call
     │  d. parseJudgmentResponse()     — extract JSON, normalize scores
     ▼
[5] UI polls GET /api/evaluations/[id] every 2s while status === 'judging'
     │  Renders ModelJudgmentCard for each completed judgment
     ▼
[6] Human evaluator scores (evaluate/[id]/page.tsx → HumanJudgmentForm)
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

## Deployment: Docker Compose v2 (Task 16)

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
   | `worker` | `EVALUATION_MODEL_CONCURRENCY_PER_RUN × 2` (default `2 × 2 = 4`, via compose's `WORKER_DB_POOL_LIMIT`) | Sized to the worker's own concurrency knob — one connection per in-flight judgment's claim update, one headroom slot so the persist-result write doesn't serialize behind another in-flight claim on the same pool. Raise `EVALUATION_MODEL_CONCURRENCY_PER_RUN` → raise `WORKER_DB_POOL_LIMIT` to match. |
   | `migrate` | `5` | One-shot, transient — Prisma's migration engine doesn't need much, and it never runs concurrently with itself. |

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
| `.gitea/workflows/ci.yml` | **Canonical.** Full pipeline: lint, typecheck, migrations, all 3 test suites (with coverage gates on 2 of them), build, and a stubbed Docker/Harbor stage. Raw shell only (see below). |
| `.github/workflows/ci.yml` | **Mirror-status only.** Lint + typecheck + unit tests (DB-free) + build. No deploy, no Docker, no DB-backed suites. GitHub is a mirror of this repo, not a release gate — see the repo-shape decision this task's plan documents. |

### Why the Gitea workflow is raw shell, and what "CI green" means today

This repo is not hosted on Gitea yet — that migration is Phase 2 of the 1b
plan. `.gitea/workflows/ci.yml` is authored ahead of that migration, against
the **real, already-provisioned** homelab Gitea Actions runner
(`act_runner`, host mode — see `homelab-setup`'s
`apps/internal/gitea-runner/{deployment.yaml,image/Containerfile}`), which
has two hard constraints baked into every step of that file:

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
   build` inline on the runner. That means the workflow's `services:`
   block (postgres:16 + redis:7 + rabbitmq:3.13-management) and its
   `docker compose up --scale` step are **authored to spec but not
   provably executable on the runner as currently provisioned** — see the
   long comment at the top of `.gitea/workflows/ci.yml` for the full
   detail and the two concrete unblockers (Docker-mode runner group, or
   spawning the 3 services as ephemeral k8s Pods the same way kaniko
   builds already are).

Because of both of the above, **`scripts/ci-local.sh` is what "CI green"
means** until this repo actually lands on Gitea and the runner-capability
gap closes. It runs the exact same shell sequence as the workflow, step
for step, against already-running local podman services (see
`docker-compose.yml` / the Development Setup section above for how to
start postgres/redis/rabbitmq on `localhost`):

```bash
bash scripts/ci-local.sh
```

It fails fast with a clear message if a service isn't reachable, and
prints `CI-local: ALL GREEN` only if lint, typecheck, `prisma migrate
deploy`, the v1-scratch-DB seed, all 3 test suites (with their coverage
gates), and `npm run build` all pass — in that order, matching
`.gitea/workflows/ci.yml` exactly (minus the Docker/Kaniko stage, which is
CI-only and stubbed there regardless).

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
  *.db.test.ts` (part of the 281-test `test:db` suite) needs a second
  database (`V1_DATABASE_URL`, seeded with the frozen v1 schema) — `prisma
  migrate reset` (which `npm run test:db` runs internally) only touches
  `DATABASE_URL`/the v2 schema, per `.env.test`'s own comment. The fix is
  `npm run db:push:v1` (a new script,
  `prisma db push --schema prisma/v1/schema.v1.prisma`), run once before
  `test:db`. `prisma db push` auto-creates the target database if it
  doesn't exist yet (verified at authoring time by dropping and
  recreating it), and no-ops cleanly (`already in sync`) on repeat runs —
  safe to always run, in CI or locally.

### Test coverage

`npm run test:coverage` (`vitest run --coverage`, `vitest.config.ts`) and
`npm run test:db:coverage` (same, `vitest.db.config.ts`) both gate on
`coverage.thresholds` — a real regression in either run fails the command
(and therefore `scripts/ci-local.sh` / the Gitea `ci` job). `test:integration`
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
| `test:integration` (no coverage gate) | n/a | `src/worker/{claim,main,reaper,run-create-consumer,judgment-consumer}.ts`, `src/lib/queue/{publish,topology}.ts`, and most of `src/lib/realtime/**` (`bus.ts`, `redis-bus.ts`, `factory.ts`, `in-memory-bus.ts`, `events.ts`) run almost exclusively here (RabbitMQ consumers, SSE over real Redis). Pass/fail-verified by `test:integration`'s 73 tests, but genuinely **not coverage-gated** — see below. |

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
correctness-verified by that suite's 73 tests but have no regression gate
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
2. **Run the build** before pushing: `npm run build`
3. **Match existing conventions** — if you're unsure, look at a similar file.
4. **Keep UI components dependency-free** — no new `npm install` for UI primitives.
5. **Update types** — if you change the schema or API shape, update `src/types/index.ts`.
6. **Update this guide** — if your change introduces a new pattern that future contributors should follow, document it here.
