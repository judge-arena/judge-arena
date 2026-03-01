# Judge Arena

A production-ready **LLM-as-a-Judge data labelling studio**. Submit text artifacts, grade them with multiple LLM models against structured rubrics, then layer in human judgment to build high-quality evaluation datasets.

Think *LLM Chatbot Arena* — but with configurable rubrics, rubric versioning, parallel multi-model grading, and a first-class human-in-the-loop comparison workflow.

---

## Features

| Area | Details |
|---|---|
| **Multi-model judging** | Run Anthropic Claude (Sonnet 4.5/4.6, Opus 4.5), OpenAI GPT-4o/o1/o3-mini, or any OpenAI-compatible local model (Ollama, vLLM, llama.cpp, LM Studio) in parallel against the same submission. |
| **Structured rubrics** | Define multi-criteria rubrics with per-criterion max scores, weights, and detailed scoring guides. Rubric text is injected verbatim into the LLM judge's system prompt. |
| **Rubric versioning** | Every rubric edit creates a new version (v1 → v2 → …). Evaluations are pinned to a specific version so historical results stay reproducible. |
| **Human judgment** | After models grade, an evaluator scores independently (per-criterion sliders), selects the best model, and provides reasoning. |
| **Comparison views** | Side-by-side model judgment cards + a criteria comparison table surface disagreements between models. |
| **Keyboard-driven** | Vim-style `G+D`, `G+P`, `G+R`, `G+M` navigation; `Ctrl+N` to create; `Ctrl+E` to run models; `?` for the shortcut sheet; `1-9/0` to set human scores. |
| **Zero external UI deps** | All UI primitives (Button, Dialog, Tabs, Tooltip, etc.) are hand-built — no Radix, shadcn, or Headless UI — keeping the project fully MIT-clean. |

---

## Architecture Overview

```
judge-arena/
├── prisma/                 # Database schema + seed data
│   ├── schema.prisma       # 8 models — Project, Rubric, Evaluation, …
│   └── seed.ts             # Default rubric + 3 Anthropic models + sample project
├── src/
│   ├── app/                # Next.js App Router
│   │   ├── api/            # REST API routes (see API section)
│   │   ├── evaluate/[id]/  # Main evaluation workspace page
│   │   ├── models/         # Model configuration management
│   │   ├── projects/       # Projects list + [id] detail
│   │   ├── rubrics/        # Rubric management with versioning
│   │   ├── layout.tsx      # Root layout (AppShell wrapper)
│   │   ├── page.tsx        # Dashboard (stats, quick actions, recent evals)
│   │   └── globals.css     # Tailwind directives + fonts + scrollbar styles
│   ├── components/
│   │   ├── evaluation/     # model-judgment-card, human-judgment-form, submission-viewer
│   │   ├── layout/         # app-shell, sidebar, header, keyboard-shortcuts-dialog
│   │   ├── models/         # model-config-form
│   │   ├── rubric/         # rubric-builder (annotated fields + tooltip help)
│   │   └── ui/             # 13 primitives — button, card, dialog, tooltip, …
│   ├── lib/
│   │   ├── db.ts           # Prisma client singleton (global caching for dev)
│   │   ├── utils.ts        # cn(), formatDate(), getScoreColor(), computeWeightedScore(), …
│   │   └── llm/            # LLM provider abstraction (see below)
│   └── types/
│       └── index.ts        # Shared TypeScript interfaces + type aliases
├── package.json            # "judge-arena" — deps, scripts
├── tailwind.config.ts      # Custom brand/surface color tokens, JetBrains Mono
└── .env.example            # ANTHROPIC_API_KEY, OPENAI_API_KEY, DATABASE_URL
```

### Tech stack

| Layer | Technology |
|---|---|
| Framework | **Next.js 14** (App Router, React Server Components + client components) |
| Language | **TypeScript 5.7** (strict mode) |
| Database | **Prisma 6** + **SQLite** (file: `prisma/dev.db`) |
| Styling | **Tailwind CSS 3.4** with custom `brand-*` and `surface-*` color tokens |
| LLM SDKs | `@anthropic-ai/sdk` ^0.39, `openai` ^4.82 |
| Validation | **Zod** for API request schemas |
| Toasts | **Sonner** |

---

## Data Model

Eight Prisma models form the core domain:

```
Project ─┬── Rubric ──── RubricCriterion
         │     ↑ (version chain via parentId self-relation)
         │     │
         └── Evaluation ─┬── ModelJudgment ── ModelConfig
                         └── HumanJudgment

ApiKeyStore   (per-provider key vault)
```

**Key relationships:**

- A **Project** has one rubric and many evaluations.
- A **Rubric** has ordered criteria and an optional `parentId` pointing to the v1 rubric (enabling version chains).
- An **Evaluation** holds the input text, is pinned to a rubric version (`rubricId`), and collects one `ModelJudgment` per active model + an optional `HumanJudgment`.
- **ModelConfig** stores provider/modelId/endpoint/API key. `isActive` controls which models participate in new evaluations.

### Rubric versioning

```
Rubric (v1, parentId = null, id = "abc")
  └── Rubric (v2, parentId = "abc")
  └── Rubric (v3, parentId = "abc")
```

`parentId` always points to the root (v1). When creating a new version, the API finds the highest version in the family and increments. Evaluations are pinned to a specific version so changing the rubric never alters past scores.

---

## LLM Provider System

The provider abstraction lives in `src/lib/llm/`:

| File | Purpose |
|---|---|
| `provider.ts` | `JudgmentProvider` interface, prompt builders (`buildJudgmentSystemPrompt`, `buildJudgmentUserPrompt`), and response parser (`parseJudgmentResponse`). |
| `anthropic.ts` | `AnthropicProvider` — calls the Anthropic Messages API via `@anthropic-ai/sdk`. |
| `openai-compatible.ts` | `OpenAICompatibleProvider` — calls any OpenAI Chat Completions-compatible endpoint (OpenAI, Ollama, vLLM, llama.cpp, LM Studio). |
| `index.ts` | Provider registry (`getProvider`, `executeJudgment`, `listProviders`). Maps `'anthropic'`, `'openai'`, `'local'` names to provider instances. |

### Judgment flow

```
POST /api/evaluations/[id]/judge
  │
  ├─ Fetch evaluation + project rubric (with criteria)
  ├─ Fetch all active ModelConfigs
  ├─ For each model (in parallel):
  │    ├─ Resolve provider via registry
  │    ├─ Build system + user prompts from rubric criteria
  │    ├─ Call LLM API
  │    ├─ Parse JSON response, normalize scores
  │    └─ Write ModelJudgment row
  └─ Update evaluation status → "completed" | "error"
```

The system prompt injects the rubric name, description, and every criterion (name, description, max score, weight) verbatim. The LLM is instructed to return a JSON object with `overallScore`, `reasoning`, and `criteriaScores[]`. The parser handles responses wrapped in markdown code blocks (`\`\`\`json … \`\`\``).

---

## API Reference

All routes live under `src/app/api/` and follow RESTful conventions.

### Projects
| Method | Route | Description |
|---|---|---|
| `GET` | `/api/projects` | List all projects |
| `POST` | `/api/projects` | Create project `{ name, description?, rubricId? }` |
| `GET` | `/api/projects/[id]` | Get project with evaluations |
| `PATCH` | `/api/projects/[id]` | Update project |
| `DELETE` | `/api/projects/[id]` | Delete project + cascade evaluations |

### Rubrics
| Method | Route | Description |
|---|---|---|
| `GET` | `/api/rubrics` | List all rubrics (with criteria + project count) |
| `POST` | `/api/rubrics` | Create rubric `{ name, description?, criteria[] }` |
| `GET` | `/api/rubrics/[id]` | Get single rubric |
| `PATCH` | `/api/rubrics/[id]` | Update rubric (replaces criteria) |
| `DELETE` | `/api/rubrics/[id]` | Delete rubric |
| `GET` | `/api/rubrics/[id]/versions` | List all versions in rubric family |
| `POST` | `/api/rubrics/[id]/versions` | Create new version `{ name?, description?, criteria[] }` |

### Models
| Method | Route | Description |
|---|---|---|
| `GET` | `/api/models` | List model configs (API keys sanitised) |
| `POST` | `/api/models` | Add model `{ name, provider, modelId, endpoint?, apiKey? }` |
| `GET` | `/api/models/[id]` | Get single model |
| `PATCH` | `/api/models/[id]` | Update model (e.g., toggle `isActive`) |
| `DELETE` | `/api/models/[id]` | Delete model config |

### Evaluations
| Method | Route | Description |
|---|---|---|
| `GET` | `/api/evaluations` | List evaluations (optional `?projectId=`) |
| `POST` | `/api/evaluations` | Create evaluation `{ projectId, title?, inputText, rubricId? }` |
| `GET` | `/api/evaluations/[id]` | Get evaluation with all judgments |
| `DELETE` | `/api/evaluations/[id]` | Delete evaluation |
| `POST` | `/api/evaluations/[id]/judge` | Trigger parallel model judging |
| `POST` | `/api/evaluations/[id]/human-judgment` | Upsert human judgment |

### Stats
| Method | Route | Description |
|---|---|---|
| `GET` | `/api/stats` | Dashboard counters (projects, evaluations, models, rubrics) |

---

## UI Components

All 13 UI primitives in `src/components/ui/` are self-contained, zero-external-dependency components built with React + Tailwind:

| Component | Key features |
|---|---|
| `Button` | 5 variants (primary, secondary, outline, ghost, danger), 4 sizes, loading spinner |
| `Card` | Compound component (Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter) |
| `Dialog` | Focus trap, escape-to-close, backdrop click, 4 sizes (sm/md/lg/xl) |
| `Tabs` | Context-based compound component (Tabs, TabsList, TabsTrigger, TabsContent) |
| `Tooltip` | Pure CSS hover tooltip with arrow, 4 sides. `TooltipIcon` renders a `?` badge. |
| `Select` | Native `<select>` with label/error/hint |
| `Input` | Text input with label, error, hint, a11y attributes |
| `Textarea` | Multi-line input with label, error, hint |
| `Slider` | Range input with gradient track |
| `Badge` | 6 variants (default, info, success, warning, error, brand) |
| `Skeleton` | Pulse loading placeholder |
| `EmptyState` | Icon + title + description + action button |
| `Kbd` | Keyboard shortcut badge |

---

## Keyboard Shortcuts

Shortcuts are registered in `app-shell.tsx` (global) and individual pages (scoped).

| Shortcut | Action | Scope |
|---|---|---|
| `?` | Open keyboard shortcuts dialog | Global |
| `G` then `D` | Navigate to Dashboard | Global |
| `G` then `P` | Navigate to Projects | Global |
| `G` then `R` | Navigate to Rubrics | Global |
| `G` then `M` | Navigate to Models | Global |
| `Ctrl+N` | Create new (project / evaluation) | Projects, Project detail |
| `Ctrl+E` | Run model evaluation | Evaluation page |
| `1`–`9`, `0` | Set human judgment score (1–9, 10) | Evaluation page |

---

## Getting Started

### Prerequisites

- **Node.js** ≥ 18
- **npm** ≥ 9
- At least one LLM API key (Anthropic or OpenAI), or a local model server

### Quick start

```bash
# 1. Clone and install
git clone <repo-url> judge-arena
cd judge-arena
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env — add your ANTHROPIC_API_KEY and/or OPENAI_API_KEY

# 3. Set up database + seed defaults
npm run setup
# (equivalent to: prisma generate → db push → seed)

# 4. Start development server
npm run dev
# Open http://localhost:3000
```

### Using a local model (Ollama example)

```bash
# Start Ollama with an OpenAI-compatible server
ollama serve

# In the Judge Arena UI:
# 1. Go to Models → Add Model
# 2. Select "Local / Self-Hosted" provider
# 3. Enter model ID (e.g., "llama3.1:8b")
# 4. Endpoint auto-fills to http://localhost:11434/v1
# 5. Save — the model is now available for evaluations
```

### npm scripts

| Script | Description |
|---|---|
| `npm run dev` | Start Next.js dev server |
| `npm run build` | Prisma generate + Next.js production build |
| `npm start` | Serve production build |
| `npm run lint` | ESLint |
| `npm run setup` | Full first-time setup (install + db + seed) |
| `npm run db:generate` | Regenerate Prisma client |
| `npm run db:push` | Push schema changes to SQLite |
| `npm run db:migrate` | Create + apply a migration |
| `npm run db:seed` | Re-run seed script |
| `npm run db:studio` | Open Prisma Studio GUI |

---

## License

MIT
