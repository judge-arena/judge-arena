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
9. [Modifying the Rubric / Evaluation Flow](#modifying-the-rubric--evaluation-flow)
10. [Adding a Keyboard Shortcut](#adding-a-keyboard-shortcut)

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

### Recipe

1. **Edit `prisma/schema.prisma`** — add or modify models.
2. **Push to the dev database**:

   ```bash
   npm run db:push
   ```

   For production deployments, use `npm run db:migrate` instead.

3. **Regenerate the client**:

   ```bash
   npm run db:generate
   ```

4. **Update the seed file** if your new model should have default data — `prisma/seed.ts`.
5. **Update TypeScript types** in `src/types/index.ts` to reflect the new shapes.

### Schema conventions

- Use `cuid()` for primary keys.
- Add `createdAt DateTime @default(now())` and `updatedAt DateTime @updatedAt` to every model.
- Add `@@index` on foreign key columns.
- Use `onDelete: Cascade` for owned relations (e.g., criteria belong to rubric).
- Store JSON data as `String` with a comment noting the expected shape (e.g., `criteriaScores`).

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

## Pull Request Guidelines

1. **One concern per PR.** A new provider, a new page, or a bug fix — not all three.
2. **Run the build** before pushing: `npm run build`
3. **Match existing conventions** — if you're unsure, look at a similar file.
4. **Keep UI components dependency-free** — no new `npm install` for UI primitives.
5. **Update types** — if you change the schema or API shape, update `src/types/index.ts`.
6. **Update this guide** — if your change introduces a new pattern that future contributors should follow, document it here.
