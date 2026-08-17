# A1.5 — The Annotation Studio: Implementation Plan

> **COMPLETE — executed 2026-08-17**, all five tasks, on `feat/a0-golden-set-substrate`
> (`133cc12`…`05bf29b`), directly after A1. Unit suite **533 → 578**; db and integration unchanged
> at **633** and **80**, as expected — nothing here touches a route or the schema. `tsc --noEmit`
> and `npm run lint` exit 0 with no warnings, and `npm run build` compiles the new route.
>
> **Task 5's manual checklist was WALKED, not deferred.** All 12 rows were run against
> `npm run dev` and local Postgres in a real browser. Row 7 found a defect, which was fixed and
> re-walked before commit. See `docs/runbooks/studio-manual-verification.md` for the recorded run.
>
> **Read "Defects found during execution" below before trusting a snippet here.** One of this
> plan's own test snippets could not pass as written, and five of the discrimination injections it
> prescribes proved nothing until the fixtures behind them were fixed.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A composable panel shell — prompt, options, reasoning, output, verdict — each minimizable and re-orderable, with delta highlighting and a progression rail, so comparison and entry are a first-class product surface rather than a form.

**Architecture:** Every rule that can be silently wrong lives in `src/lib/studio/` as a pure function: span segmentation, the word diff, and layout reconciliation. `src/components/studio/` is presentation only and takes all data as props. A view is a list of panel descriptors plus a renderer per kind, so **adding a box is adding a kind and a renderer, never editing a page**.

**Tech Stack:** Next.js 15 (app router), React 19, TypeScript, vitest (unit suite only — see below).

**Spec:** `docs/superpowers/specs/2026-08-17-a1_5-annotation-studio-design.md` — read "The testable / untestable split" before Task 1.

**Sibling:** A1 (`2026-08-17-a1-human-verification.md`). **Independent.** A1 owns the data and the endpoints; this plan owns the surface. Either may land first — Task 5 is the only place they meet, and it degrades to a static fixture if A1 is not merged yet.

## Global Constraints

- **There is no jsdom.** All three vitest configs are `environment: 'node'`. **Nothing in `src/components/` can be unit-tested in this repo**, which is precisely why the logic lives in `src/lib/studio/`. Do not add a jsdom dependency as part of this plan — that is its own decision with its own review.
- **`src/lib/**` is measured by both coverage configs; `src/components/**` is measured by neither.** If a behaviour can be wrong in a way a reader would not notice, it belongs in `src/lib/studio/`.
- **Never lower a coverage floor.** Floors sit 2pp/3pp below actuals. If actuals move, update only the "Actuals as of" prose.
- **Do not assert an absolute suite count in any task.** Zero failures, and no fewer tests than the previous task left.
- **Demonstrate discrimination, do not assert it.** Break it, observe the specific failure, restore, confirm byte-identical by `sha256sum -c`, and put the observed message in your report.
- **No new runtime dependencies.** The word diff and the FNV hash are ~40 lines each; a diff library is not worth the supply-chain surface for prose comparison.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `src/lib/studio/content.ts` | `SpanText`, normalization, `segment()`. The offsets contract. |
| `src/lib/studio/delta.ts` | Word-level diff over two `SpanText` values. |
| `src/lib/studio/layout.ts` | Panel descriptors, reorder/collapse, and `reconcile()` of untrusted persisted state. |
| `src/components/studio/Panel.tsx` | One box: title, collapse toggle, drag handle, empty state. |
| `src/components/studio/StudioShell.tsx` | Lays out panels, owns interaction, persists layout. |
| `src/components/studio/SpanTextView.tsx` | Renders a `SpanText` through `segment()`. |
| `src/components/studio/DeltaTextView.tsx` | Renders diff runs. |
| `src/components/studio/ProgressionRail.tsx` | The stage strip, including explicit empty stages. |
| `tests/lib/studio/content.test.ts` | Segmentation edge cases. |
| `tests/lib/studio/delta.test.ts` | Diff behaviour. |
| `tests/lib/studio/layout.test.ts` | Reorder, collapse, and untrusted-input reconciliation. |

**Modified**

| File | Change |
|---|---|
| `src/app/golden-sets/[id]/page.tsx` | Links to the labelling view (Task 5). |

---

## The interface contract

Defined once. No task may rename or re-shape these.

```ts
// src/lib/studio/content.ts
export type Span = { start: number; end: number; kind: string; id?: string };
export type SpanText = { text: string; spans: Span[] };
export type Run = { text: string; spans: Span[] };
export function toSpanText(raw: string, spans?: Span[]): SpanText;
export function segment(value: SpanText): Run[];

// src/lib/studio/delta.ts
export type DeltaRun = { text: string; change: 'unchanged' | 'added' | 'removed' };
export function delta(before: SpanText, after: SpanText): DeltaRun[];

// src/lib/studio/layout.ts
export type PanelKind = 'prompt' | 'options' | 'reasoning' | 'output' | 'verdict';
export type Panel = { id: string; kind: PanelKind; title: string; collapsed: boolean; order: number };
export type StudioView = 'labelling' | 'diagnosis';
export function defaultLayout(view: StudioView): Panel[];
export function applyReorder(panels: Panel[], id: string, toIndex: number): Panel[];
export function applyCollapse(panels: Panel[], id: string, collapsed: boolean): Panel[];
export function reconcile(persisted: unknown, defaults: Panel[]): Panel[];
```

---

## Task list

| Task | Deliverable |
|---|---|
| 1 | `content.ts` — the offsets contract and `segment()`. |
| 2 | `delta.ts` — the word diff. |
| 3 | `layout.ts` — panels, and `reconcile()` against untrusted input. |
| 4 | The five components. |
| 5 | The labelling view, composed, plus the manual verification checklist. |

---

## Task bodies

### Task 1: `src/lib/studio/content.ts`

**Files:**
- Create: `src/lib/studio/content.ts`
- Test: `tests/lib/studio/content.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Span`, `SpanText`, `Run`, `toSpanText`, `segment` — exactly as in the contract.

**Nothing produces spans yet.** This task exists now anyway, because the offsets contract is the one thing that cannot be retrofitted: every producer written against un-normalized text would need revisiting, and the symptom of getting it wrong is a highlight covering the wrong words with no error anywhere.

- [x] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { segment, toSpanText } from '@/lib/studio/content';

describe('toSpanText — the offsets contract', () => {
  it('normalizes line endings, so a CRLF source does not shift every later offset', () => {
    expect(toSpanText('a\r\nb').text).toBe('a\nb');
  });

  it('normalizes to NFC, so a decomposed accent is one code point not two', () => {
    // 'é' decomposed (e + combining acute) is length 2; composed is length 1.
    // A span computed against one and applied to the other is off by one for
    // the whole remainder of the string.
    const decomposed = 'éclair';
    expect(decomposed).toHaveLength(7);
    expect(toSpanText(decomposed).text).toHaveLength(6);
  });

  it('is idempotent — normalizing twice changes nothing', () => {
    const once = toSpanText('a\r\né');
    expect(toSpanText(once.text).text).toBe(once.text);
  });
});

describe('segment', () => {
  it('with no spans returns the whole text as one run', () => {
    expect(segment(toSpanText('hello world'))).toEqual([{ text: 'hello world', spans: [] }]);
  });

  it('splits at span boundaries and marks only the covered run', () => {
    const v = toSpanText('hello world', [{ start: 6, end: 11, kind: 'evidence' }]);
    const runs = segment(v);
    expect(runs.map((r) => r.text)).toEqual(['hello ', 'world']);
    expect(runs[0].spans).toEqual([]);
    expect(runs[1].spans.map((s) => s.kind)).toEqual(['evidence']);
  });

  it('carries BOTH spans on the overlapping region', () => {
    // Overlap is the case a naive implementation silently drops, and the
    // rendered result looks plausible either way.
    const v = toSpanText('abcdef', [
      { start: 0, end: 4, kind: 'x' },
      { start: 2, end: 6, kind: 'y' },
    ]);
    const runs = segment(v);
    expect(runs.map((r) => r.text)).toEqual(['ab', 'cd', 'ef']);
    expect(runs[1].spans.map((s) => s.kind).sort()).toEqual(['x', 'y']);
  });

  it('drops a zero-length span rather than emitting an empty run', () => {
    const runs = segment(toSpanText('abc', [{ start: 1, end: 1, kind: 'x' }]));
    expect(runs.map((r) => r.text)).toEqual(['abc']);
  });

  it('clamps an out-of-range span instead of throwing or emitting phantom text', () => {
    const runs = segment(toSpanText('abc', [{ start: 2, end: 99, kind: 'x' }]));
    expect(runs.map((r) => r.text).join('')).toBe('abc');
    expect(runs.at(-1)!.spans.map((s) => s.kind)).toEqual(['x']);
  });

  it('reassembles to exactly the original text, always', () => {
    // The invariant that makes every other case safe: segmentation may not
    // lose, duplicate or reorder a single character.
    const v = toSpanText('the quick brown fox', [
      { start: 4, end: 9, kind: 'a' }, { start: 0, end: 3, kind: 'b' }, { start: 7, end: 15, kind: 'c' },
    ]);
    expect(segment(v).map((r) => r.text).join('')).toBe(v.text);
  });
});
```

- [x] **Step 2: Run and watch it fail**

```bash
npx vitest run --config vitest.config.ts tests/lib/studio/content.test.ts
```

Expected: FAIL at collection — `Cannot find module '@/lib/studio/content'`.

- [x] **Step 3: Implement**

`toSpanText` replaces `\r\n` and lone `\r` with `\n`, then `.normalize('NFC')`, and returns `{text, spans}` with spans defaulting to `[]`. **Normalization happens before offsets mean anything**, so a caller supplying spans must have computed them against normalized text — say so in the module doc.

`segment` collects every boundary (0, each span's clamped start/end, `text.length`), sorts and de-duplicates them, and emits one run per adjacent pair, attaching every span that covers it. Spans are clamped to `[0, text.length]` and dropped when `start >= end` after clamping.

- [x] **Step 4: Run and watch it pass.**

- [x] **Step 5: Prove the tests discriminate**

```bash
sha256sum src/lib/studio/content.ts > /tmp/content.sha
```

1. Attach only the *first* covering span to each run → the overlap test fails with `expected ['x'] to deeply equal ['x','y']`.
2. Drop the NFC normalize → the decomposed-accent test fails with `expected 7 to be 6`.
3. Emit a run for zero-length spans → the zero-length test fails with an extra `''` run.

Restore after each, then `sha256sum -c /tmp/content.sha` → `OK`.

- [x] **Step 6: Full suites and commit**

```bash
npx tsc --noEmit && npm run lint && npm test
git add src/lib/studio/content.ts tests/lib/studio/content.test.ts
git commit -m "feat(a1.5): the span-ready content model

Nothing produces spans yet, and the offsets contract is still pinned now:
offsets are defined against NFC-normalized, \\n-normalized text, because a
span computed against un-normalized text drifts silently the first time a
smart quote or a CRLF appears and no error is ever raised."
```

---

### Task 2: `src/lib/studio/delta.ts`

**Files:**
- Create: `src/lib/studio/delta.ts`
- Test: `tests/lib/studio/delta.test.ts`

**Interfaces:**
- Consumes: `SpanText`, `toSpanText` from Task 1.
- Produces: `DeltaRun`, `delta(before, after)`.

- [x] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { toSpanText } from '@/lib/studio/content';
import { delta } from '@/lib/studio/delta';

const d = (a: string, b: string) => delta(toSpanText(a), toSpanText(b));
const textOf = (runs: { text: string; change: string }[], change: string) =>
  runs.filter((r) => r.change === change).map((r) => r.text).join('');

describe('delta', () => {
  it('identical input is one unchanged run', () => {
    expect(d('the same words', 'the same words')).toEqual([{ text: 'the same words', change: 'unchanged' }]);
  });

  it('marks an insertion as added and nothing as removed', () => {
    const runs = d('a c', 'a b c');
    expect(textOf(runs, 'added').trim()).toBe('b');
    expect(textOf(runs, 'removed')).toBe('');
  });

  it('marks a deletion as removed and nothing as added', () => {
    const runs = d('a b c', 'a c');
    expect(textOf(runs, 'removed').trim()).toBe('b');
    expect(textOf(runs, 'added')).toBe('');
  });

  it('a replacement is both a removal and an addition', () => {
    const runs = d('the cat sat', 'the dog sat');
    expect(textOf(runs, 'removed')).toContain('cat');
    expect(textOf(runs, 'added')).toContain('dog');
    expect(textOf(runs, 'unchanged')).toContain('the');
  });

  it('reconstructs BOTH sides exactly — unchanged+removed is the before, unchanged+added is the after', () => {
    // The invariant. Without it a diff can look right on screen while having
    // quietly dropped a word.
    const before = 'alpha beta gamma delta', after = 'alpha gamma epsilon delta';
    const runs = d(before, after);
    expect(runs.filter((r) => r.change !== 'added').map((r) => r.text).join('')).toBe(before);
    expect(runs.filter((r) => r.change !== 'removed').map((r) => r.text).join('')).toBe(after);
  });

  it('diffs by WORD, not character — a changed word is one run, not a letter soup', () => {
    const runs = d('configuration', 'configurations');
    expect(runs.filter((r) => r.change !== 'unchanged')).toHaveLength(2);
  });
});
```

- [x] **Step 2: Run and watch it fail.**

- [x] **Step 3: Implement** a standard LCS over word tokens (split on whitespace, **keeping the whitespace attached** so reconstruction is exact), emitting `unchanged`/`removed`/`added` runs and merging adjacent runs of the same change.

- [x] **Step 4: Run and watch it pass.**

- [x] **Step 5: Prove it discriminates.** Split on whitespace and discard it (`.split(/\s+/)`). Re-run.
Expected: FAIL on the reconstruction test — the rebuilt string loses its spaces. Restore and verify by sha256. **This is the bug that makes a diff look fine and be wrong**, which is why the invariant is tested rather than the appearance.

- [x] **Step 6: Full suites and commit.**

---

### Task 3: `src/lib/studio/layout.ts`

**Files:**
- Create: `src/lib/studio/layout.ts`
- Test: `tests/lib/studio/layout.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PanelKind`, `Panel`, `StudioView`, `defaultLayout`, `applyReorder`, `applyCollapse`, `reconcile`.

- [x] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { applyCollapse, applyReorder, defaultLayout, reconcile } from '@/lib/studio/layout';

describe('defaultLayout', () => {
  it('labelling has all five kinds, ordered 0..4', () => {
    const panels = defaultLayout('labelling');
    expect(panels.map((p) => p.kind)).toEqual(['prompt', 'options', 'reasoning', 'output', 'verdict']);
    expect(panels.map((p) => p.order)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('applyReorder / applyCollapse', () => {
  it('moving a panel renumbers every order contiguously from 0', () => {
    const moved = applyReorder(defaultLayout('labelling'), 'verdict', 0);
    expect(moved.map((p) => p.kind)).toEqual(['verdict', 'prompt', 'options', 'reasoning', 'output']);
    expect(moved.map((p) => p.order)).toEqual([0, 1, 2, 3, 4]);
  });

  it('collapsing does not reorder', () => {
    const before = defaultLayout('labelling');
    const after = applyCollapse(before, 'reasoning', true);
    expect(after.map((p) => p.kind)).toEqual(before.map((p) => p.kind));
    expect(after.find((p) => p.kind === 'reasoning')!.collapsed).toBe(true);
  });

  it('reordering to an out-of-range index clamps instead of producing holes', () => {
    const moved = applyReorder(defaultLayout('labelling'), 'prompt', 99);
    expect(moved.map((p) => p.order)).toEqual([0, 1, 2, 3, 4]);
    expect(moved.at(-1)!.kind).toBe('prompt');
  });
});

describe('reconcile — persisted layout is UNTRUSTED INPUT', () => {
  const defaults = defaultLayout('labelling');

  it('garbage returns the defaults rather than throwing', () => {
    // A studio that white-screens on a year-old localStorage entry is a bug
    // the user cannot diagnose and can only fix by clearing site data.
    for (const junk of [null, undefined, 42, 'nonsense', {}, [1, 2, 3], [{ nope: true }]]) {
      expect(reconcile(junk, defaults)).toEqual(defaults);
    }
  });

  it('drops a panel kind this build no longer knows', () => {
    const stale = [...defaults.map((p) => ({ ...p })), { id: 'x', kind: 'telepathy', title: 'X', collapsed: false, order: 9 }];
    expect(reconcile(stale, defaults).map((p) => p.kind)).toEqual(defaults.map((p) => p.kind));
  });

  it('restores a panel the persisted layout is missing, at the end', () => {
    const missing = defaults.filter((p) => p.kind !== 'verdict').map((p) => ({ ...p }));
    const out = reconcile(missing, defaults);
    expect(out.map((p) => p.kind)).toContain('verdict');
    expect(out).toHaveLength(defaults.length);
  });

  it('repairs duplicate and missing orders into a contiguous sequence', () => {
    const broken = defaults.map((p) => ({ ...p, order: 0 }));
    expect(reconcile(broken, defaults).map((p) => p.order)).toEqual([0, 1, 2, 3, 4]);
  });

  it('PRESERVES the user collapse and order it can trust', () => {
    // Reconciliation must not be a reset: the whole point is keeping the
    // layout someone arranged.
    const custom = applyCollapse(applyReorder(defaults, 'verdict', 0), 'options', true);
    const out = reconcile(JSON.parse(JSON.stringify(custom)), defaults);
    expect(out.map((p) => p.kind)).toEqual(custom.map((p) => p.kind));
    expect(out.find((p) => p.kind === 'options')!.collapsed).toBe(true);
  });
});
```

- [x] **Step 2: Run and watch it fail.**

- [x] **Step 3: Implement.** **`defaultLayout` assigns `id === kind`** for the panels it creates — the
tests above call `applyReorder(defaults, 'verdict', 0)` and `applyCollapse(defaults, 'reasoning', true)`
passing a kind where an id is expected, and that only works because the default layout makes them
equal. Keep the two fields distinct in the type anyway: a view will eventually want two panels of the
same kind, and collapsing them now would make that a breaking change.

`reconcile` must: return `defaults` for anything that is not an array of objects; keep only entries whose `kind` is a known `PanelKind`; de-duplicate by kind; append any default whose kind is missing; and renumber `order` contiguously from 0 in the resulting sequence. **It never throws.**

- [x] **Step 4: Run and watch it pass.**

- [x] **Step 5: Prove it discriminates.** Make `reconcile` return `persisted as Panel[]` unchanged when it is an array. Re-run.
Expected: FAIL on the unknown-kind test with `expected [… 'telepathy'] to deeply equal […]`, and on the garbage test for `[1,2,3]`. Restore and verify by sha256.

- [x] **Step 6: Full suites and commit.**

---

### Task 4: The components

**Files:**
- Create: `src/components/studio/Panel.tsx`, `StudioShell.tsx`, `SpanTextView.tsx`, `DeltaTextView.tsx`, `ProgressionRail.tsx`

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces: the five components. **All data arrives as props. No component imports Prisma or fetches.**

**None of this is unit-testable in this repo** — there is no jsdom. Verification is Task 5's manual checklist. That is exactly why Tasks 1–3 came first and hold every rule that can be wrong.

- [x] **Step 1: `SpanTextView`** — maps `segment(value)` to spans, applying a class per `span.kind`. With no spans it renders one plain run, which is the only path exercised until span targeting exists.

- [x] **Step 2: `DeltaTextView`** — maps `DeltaRun[]` to `<ins>`/`<del>`/plain. Use real `<ins>`/`<del>` elements rather than styled `<span>`s: they carry the meaning to a screen reader, and "what changed" is the panel's entire purpose.

- [x] **Step 3: `Panel`** — title, collapse toggle, drag handle, children, and an **explicit empty state** taking a reason string. A panel with no content renders *why* ("no reasoning captured for this model") rather than a blank box.

- [x] **Step 4: `ProgressionRail`** — takes `stages: {key, label, state: 'done'|'empty'|'pending'}[]` and renders every stage including empty ones. **An empty stage is rendered, never omitted** — omitting it makes the studio look complete when half the pipeline has not run.

- [x] **Step 5: `StudioShell`** — holds `Panel[]` state, loads via `reconcile(JSON.parse(localStorage.getItem(key) ?? 'null'), defaultLayout(view))`, persists on change, and renders panels in `order` through a `renderers: Record<PanelKind, ReactNode>` prop. **The `JSON.parse` goes in a `try`** — a truncated blob throws before `reconcile` ever sees it, and `reconcile`'s guarantees do not cover a parse error.

- [x] **Step 6: Typecheck, lint, commit**

```bash
npx tsc --noEmit && npm run lint
git add src/components/studio
git commit -m "feat(a1.5): the studio components

Presentation only — every rule that can be silently wrong lives in
src/lib/studio, because this repo has no jsdom and nothing here can be
unit-tested. Empty states are explicit: a panel with no content says why,
and an empty progression stage is rendered rather than omitted, so the
studio cannot look complete when half the pipeline has not run."
```

---

### Task 5: The labelling view, composed

**Files:**
- Create: `src/app/golden-sets/[id]/label/page.tsx`
- Modify: `src/app/golden-sets/[id]/page.tsx` — a link to the labelling view
- Create: `docs/runbooks/studio-manual-verification.md`

**Interfaces:**
- Consumes: all five components; A1's `GET …/queue` and `POST …/items/[itemId]/labels` when they exist.
- Produces: the first composition of the shell.

- [x] **Step 1: Build the view against A1's queue endpoint.** Protocol-aware content: pointwise renders a score input in the `verdict` panel; pairwise renders the candidates in `options` and a preference control in `verdict`. `reasoning` and `output` render their empty states until judgments exist.

**If A1 has not merged**, drive the view from a static fixture module and leave a single clearly-marked `TODO(a1)` at the fetch call site — the composition is the deliverable here, not the data.

- [x] **Step 2: Handle the queue's non-item states.** `retest-not-yet-eligible` renders *"label N more items before this one comes back"* using `labelsUntilRetest`; `set-complete` and `no-assignment` each render their own message. **A blank screen for any of these is the failure this step exists to prevent** — with intervening-items-only eligibility, a small set legitimately has nothing to serve.

- [x] **Step 3: Write the manual verification checklist** to `docs/runbooks/studio-manual-verification.md` — the substitute for the tests this layer cannot have, and the thing a future change is re-run against:

```markdown
1. All five panels render for a pointwise item; all five for a pairwise item.
2. Collapse each panel; reload; the collapse survives.
3. Reorder two panels; reload; the order survives.
4. In devtools, set the layout key to `{`; reload. The view renders defaults and does not white-screen.
5. In devtools, set it to a valid array containing an unknown `kind`; reload. The unknown panel is gone, the rest are intact.
6. A model/answer stage with no judgment shows an explicit empty state, not a gap.
7. A retest-not-yet-eligible queue shows the "label N more" message with a real number.
8. Submitting a reading advances to the next item without revealing whether it was a re-read.
```

- [x] **Step 4: Walk the checklist and record the result** in the task report — including anything that failed and what you changed.

- [x] **Step 5: Typecheck, lint, full suites, commit.**

---

## Defects found during execution

### One snippet that could not pass as written

| Task | What the plan said | What is true |
|---|---|---|
| 1 | The NFC test writes the decomposed form as a plain literal `'éclair'` and asserts `toHaveLength(7)`. | A literal typed into a source file is whatever that file's ENCODING holds, and here it arrived composed — so the assertion failed at 6. The trap is the obvious fix: changing the 7 to a 6 turns it green while deleting the only thing under test, because both sides of the assertion are then the composed form and `normalize('NFC')` could be removed without failing anything. Both literals are now explicit `\u` escapes, which no editor, formatter or copy-paste can quietly normalize. |

### Five injections that proved nothing, and what each exposed

**This is the real yield of the phase.** Every one was a case where the code looked fine, the test
looked fine, and breaking the code on purpose changed nothing.

| Task | Injection that did not discriminate | What it exposed |
|---|---|---|
| 2 | Removing the empty-run guard in `delta`'s accumulator | The guard was **unreachable**: `tokenize` cannot yield an empty token. Deleted rather than commented — the same call R4 made about an inert read. |
| 2 | Collapsing `keyOf`'s whitespace special-case | It was **dead**. The byte-equality check in `delta` already covers a paragraph break not matching a space. Simplified to `token.trim()`. |
| 2 | Forcing the byte-equality check to `true` | **No fixture had two tokens with the same word and different whitespace.** Two cases added — an internal whitespace-only change, and leading whitespace, the only place `keyOf`'s empty key is reachable at all. |
| 3 | Removing the reorder clamp | The test used `-5`, which `Array.prototype.splice` clamps to 0 by itself. **The discriminating value is `-1`**, where splice's offset-from-the-end semantics insert the panel second-to-LAST — the opposite of dragging to the top. |
| 3 | Removing the duplicate-kind skip | The test asserted only the resulting LENGTH, which a `Map` keyed by kind gives for free. The skip decides **which copy survives**; now pinned as first-wins. |

### One defect the manual walk found

Task 5, checklist row 7. On a set in the `retest-not-yet-eligible` state the progression rail read
*"Item — not started / Human label — not started"* directly above the message *"Label 20 more items
before this one comes back"*. The queue returns that reason precisely BECAUSE a reading exists and
is too fresh to repeat, so the rail contradicted the paragraph under it. **This is exactly what the
untestable layer's checklist is for** — no unit test could have caught it, because the rule was
right and the composition was wrong.

### Additions beyond the plan

| Where | Addition | Why |
|---|---|---|
| Task 1 | A lone-`\r` case, a wholly-out-of-range/inverted span, empty text segmenting to no runs, and an astral character never split | Each is a SILENT-corruption path rather than an error path. A boundary inside a surrogate pair renders as a replacement glyph — visible corruption from an invisible cause. |
| Task 4 | `<ins>`/`<del>` rather than styled spans; stage state spelled out for assistive tech; a keyboard-operable drag handle | All three are correctness rather than polish: a colour communicates a diff only to users who can see colour, and a pointer-only arrangement feature is unavailable to anyone not using a mouse — which is the interaction this phase is named for. |
| Task 4 | Layout loads in an effect, not a `useState` initialiser | `localStorage` does not exist during the server render; reading it there makes the two renders disagree and costs the whole tree to a hydration error. A first write is held back until the load completes, or the defaults would be persisted over the saved layout before it was read. |
| Task 5 | The Label entry point is not gated on ownership | An assigned annotator need not own the set. Gating it would make assignment unusable for the multi-annotator case it exists to serve; the queue does the real gating. |

### Coverage

Both configs exit 0 and **no floor was touched.**

| | actual | floor | margin |
|---|---|---|---|
| unit, `src/lib/studio/**` | **100** stmts / 96.42 branches / **100** funcs / **100** lines | — | — |
| unit, all-files | 41.39 / 87.20 / 70.64 / 41.39 | passes | — |
| db, all-files statements & lines | **53.55** | 47 | 6.55pp |
| db, all-files branches | **79.24** | 77 | 2.24pp |
| db, all-files functions | **62.43** | 60 | 2.43pp |

**The db aggregate DIPPED, from 54.52 after A1 to 53.55, and that is expected rather than a
regression.** `vitest.db.config.ts` includes `src/lib/**`, so the three new studio modules are in
its denominator — but the db suite drives API routes and never imports them, so they contribute
nothing to its numerator. They are fully covered by the UNIT run instead, at 100%. The margin is
still 6.55pp against a 2pp policy, so nothing needed doing; recorded here so the next reader does
not read the dip as a loss of coverage.

`src/lib/studio/**` is measured by both configs; `src/components/studio/**` by neither, which is
the split the whole plan is shaped around.

## Self-review notes

**Spec coverage.** Panel model → Tasks 3 and 4. Span-ready content and the normalization contract → Task 1. Delta tooling → Task 2. Progression rail → Task 4 Step 4. Layout persistence and untrusted reconciliation → Tasks 3 and 4 Step 5. The testable/untestable split → the whole shape of the plan. Exit gate: the five clauses map to Task 5's checklist items 1–2, the delta behaviour proven in Task 2, checklist item 6, checklist items 4–5, and `SpanTextView` in Task 4 Step 1.

**Deliberately not covered.** Span targeting itself — the interaction that *produces* spans. The content model is ready for it and nothing here creates one. Capturing `reasoning_content`, backlogged with A1. Database-backed layout persistence: localStorage first, and the model in `src/lib/studio/layout.ts` makes the swap a storage change rather than a rewrite. A3's diagnosis view, which composes these same parts differently.

**One thing to raise rather than discover.** `defaultLayout` takes a `StudioView` and this plan only ever builds `'labelling'`. `'diagnosis'` is in the type because A3 needs it and because a single-valued union invites someone to delete the parameter — which would then have to be reintroduced along with every call site. If it is still unused when A3 starts, that is the moment to confirm it rather than now.
