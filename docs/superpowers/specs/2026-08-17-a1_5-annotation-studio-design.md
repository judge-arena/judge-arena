# A1.5 — The annotation studio

**Date:** 2026-08-17 · **Status:** approved in brainstorming, not yet planned
**Phase:** Roadmap A, between **A1** and **A2**. Split out of A1 deliberately.
**Sibling:** **A1** (`2026-08-17-a1-human-verification-design.md`) — the labelling routes, the
agreement maths and the assignment model. **The two are buildable in parallel**: A1 owns the data and
the endpoints, A1.5 owns the surface that consumes them.

> **On the label `A1.5`.** A **Roadmap A** phase. The dataset-lifecycle plans once called A1/A2 are
> now L1/L2; `A0…A5` belongs to Roadmap A alone. See
> `../plans/2026-08-16-l1-complete-l2-handoff.md` §0.

---

## Why this is its own phase

The studio is the product. **The whole value is easy interaction for comparison and entry** — a
person looking at a prompt, some options, a chain of reasoning, an output and a verdict, and being
able to see what changed, what mattered, and how the answer progressed.

Three reasons it is separated from A1 rather than bundled into it:

1. **It is reused, not consumed.** A1's labelling view is the first composition of these panels. A3's
   comparative diagnosis — sample-level divergence and two judges' reasoning side by side — is the
   second, and it is the phase the roadmap says "turns a score into a reason". Building the shell
   inside A1 would bury a shared substrate inside one caller.
2. **It is the untestable half.** This repo has no jsdom: all three vitest configs are
   `environment: 'node'`, and UI verification is manual by accepted limitation. Keeping the shell
   separate means the boundary between "tested logic" and "manually verified rendering" is a phase
   boundary rather than a judgement call inside a large diff.
3. **A1 is already large.** It carries a migration with three hand-edited constraints, a statistics
   library, an assignment model and six routes. Bundling a panel system makes both harder to review.

---

## The panel model

A panel is a **descriptor**, not a component:

```ts
type PanelKind = 'prompt' | 'options' | 'reasoning' | 'output' | 'verdict';

type Panel = {
  id: string;
  kind: PanelKind;
  title: string;
  collapsed: boolean;
  order: number;
};
```

A view is a list of panels plus a renderer per kind. **Adding a box is adding a kind and a renderer,
never editing a page** — that is what makes it iterable, and it is the property to protect when the
next kind arrives.

The five kinds and what fills them today:

| Kind | Content | Source |
|---|---|---|
| `prompt` | the question / instruction the annotator or judge saw | `GoldenItem.inputText`, `promptText`; historically via `GoldenItemRevision` |
| `options` | the candidate responses under comparison | `GoldenCandidate` rows (position, responseText). **No model attribution** — a golden set has no model concept; the model under evaluation is named by the evaluation, not the item |
| `reasoning` | chain of thought / stated rationale | `ModelJudgment.reasoning`, `rawResponse`; **empty for now in the CoT sense — see below** |
| `output` | the final answer or score | `ModelJudgment` structured output, `criteriaScores` |
| `verdict` | the decision — human label or judge verdict | `GoldenLabel` (score or preference), `ModelJudgment.status` |

**The `reasoning` panel is knowingly thin at first.** `reasoning_content` is read nowhere in `src/`,
so true chain-of-thought is discarded on every model call (preflight Stage 5, backlogged). The panel
renders the judge's stated `reasoning` and `rawResponse`; for a reasoning model it is structurally
empty of actual CoT, and for a non-reasoning model it is simply empty. **Both are correct rather than
broken**, and the panel says which it is instead of rendering a blank box.

Every panel is **minimizable and re-orderable**.

---

## Span-ready content, before span targeting exists

Span targeting — deciding *which parts mattered* — is deferred. The **content shape is not**, because
retrofitting it would mean touching every producer:

```ts
type Span = { start: number; end: number; kind: string; id?: string };
type SpanText = { text: string; spans: Span[] };
```

With `spans: []` this renders as plain text. A producer written today stays correct when targeting
arrives.

**One thing must be pinned now rather than later: offsets are defined against a normalized string** —
NFC, `\n` line endings. Spans computed against un-normalized text drift the first time a smart quote,
a combining accent or a CRLF appears, and the drift is silent and unrecoverable after the fact:
the highlight simply covers the wrong words, and nothing errors. Normalization is therefore a
property of the content model, applied at construction, not a rendering concern.

`src/lib/studio/content.ts` owns:

- `toSpanText(raw: string): SpanText` — normalizes, spans empty.
- `segment(value: SpanText): Run[]` — splits into runs at span boundaries, each run carrying the
  spans covering it. This is the function that makes highlighting correct or subtly wrong, and it is
  where overlapping spans, zero-length spans, out-of-range offsets and multi-byte characters are
  handled. Pure, and unit-tested against all four.

---

## Delta tooling — what changed

`src/lib/studio/delta.ts`: a word-level diff over two `SpanText` values, returning runs marked
`unchanged | added | removed`. Word-level rather than character-level because the reader is a human
comparing prose, and character diffs of prose are noise.

It has four consumers immediately, which is why it belongs in the shell rather than in one view:

| Comparison | Source |
|---|---|
| prompt revision *N* vs *N+1* | `GoldenItemRevision` (A1) |
| human reading round 1 vs round 2 | `GoldenLabel.round` (A1) |
| two candidate answers | `GoldenCandidate` positions |
| model verdict vs human verdict | `ModelJudgment` vs `GoldenLabel` |

A panel given two versions renders the delta; given one, it renders plainly. The panel does not know
which comparison it is showing — that is the caller's composition.

---

## Progression — prompt → model → answer → human

A stage rail traces one item across the pipeline. For A1 only the **prompt/options** and **human**
stages have data; `model` and `answer` are populated once judgments exist (A2/A3).

**Stages with no data render an explicit empty state and are never omitted.** An omitted stage makes
the studio look complete when half the pipeline has not run — the same failure mode as a reachability
probe reporting healthy against a schema-less database, and the reason `/api/health`'s `SELECT 1` is
called out in this project's own corrections.

---

## Layout persistence

Layout state — collapse and order per view, per user — persists to **localStorage** initially. No
schema, no migration, immediate.

The **model** lives in `src/lib/studio/layout.ts` so moving it to the database later is a storage
swap rather than a rewrite:

- `defaultLayout(view): Panel[]`
- `applyReorder(panels, id, toIndex): Panel[]`
- `applyCollapse(panels, id, collapsed): Panel[]`
- `reconcile(persisted: unknown, defaults: Panel[]): Panel[]`

`reconcile` is the one that matters and the one that is easy to omit: a persisted blob is **untrusted
input**. It may be stale (a panel kind that no longer exists), truncated, hand-edited, or from a
newer version with kinds this build does not know. It must drop unknown panels, add missing ones from
the defaults, and repair duplicate or missing `order` values — never throw. A studio that white-screens
because of a year-old localStorage entry is a bug the user cannot diagnose and can only fix by
clearing site data.

---

## Component inventory

`src/components/studio/`:

| Component | Responsibility |
|---|---|
| `StudioShell` | lays out panels, owns collapse/reorder interaction, persists via the layout model |
| `Panel` | chrome: title, collapse toggle, drag handle, empty state |
| `SpanTextView` | renders a `SpanText` through `segment()`; highlights when spans exist |
| `DeltaTextView` | renders a diff's runs |
| `ProgressionRail` | the stage strip, including explicit empty stages |

A1's labelling view composes these. A3's diagnosis view will compose the same ones differently. No
component reaches into Prisma; all data arrives as props from the route layer.

---

## The testable / untestable split

This is the discipline that keeps a large UI phase honest here:

**Tested** (`src/lib/studio/**`, measured by both coverage configs):
- `segment()` — overlapping spans, zero-length spans, out-of-range offsets, multi-byte characters.
- `toSpanText()` — normalization is idempotent, and offsets computed post-normalization are stable.
- `delta()` — insertion, deletion, replacement, whitespace-only change, identical inputs.
- `reconcile()` — unknown kinds dropped, missing panels restored, duplicate orders repaired, garbage
  input returns the defaults rather than throwing.

**Manually verified** (`src/components/studio/**`): rendering, drag interaction, keyboard flow.

If a behaviour can be wrong in a way a reader would not notice — and silently-wrong highlight offsets
are the clearest example — it belongs in the first list.

---

## Exit gate

- A golden item renders in the studio with all five panel kinds, each collapsible and re-orderable,
  and the layout survives a reload.
- A panel given two versions shows a delta; the same panel given one version shows it plainly.
- The progression rail shows `model` and `answer` as explicitly empty, not absent, before any
  judgment exists.
- A corrupt or stale localStorage layout loads the default view instead of breaking the page.
- `SpanTextView` renders spans correctly when handed them, though nothing produces spans yet.

---

## Out of scope

- **Span targeting itself** — the UI for selecting text and attaching a span, and whatever produces
  spans automatically. The content model is ready for it; the interaction is a later phase.
- **Capturing `reasoning_content`** — backlogged with A1. Until it lands the reasoning panel is
  correct and thin.
- **Database-backed layout persistence** — localStorage first; the model makes the swap cheap.
- **A3's diagnosis view.** This phase ships the shell and one composition (A1's labelling view). The
  comparative view is A3's, built from these same parts.
