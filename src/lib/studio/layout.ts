/**
 * A1.5 — the panel model.
 *
 * A view is A LIST OF PANEL DESCRIPTORS plus a renderer per kind, which is what
 * makes "add a box" a matter of adding a kind and a renderer rather than
 * editing a page. The shell knows how to lay panels out and nothing about what
 * is in them.
 *
 * ── `reconcile` IS THE LOAD-BEARING FUNCTION HERE ──────────────────────────
 *
 * Layout is persisted to localStorage, which means the input on the next load
 * is UNTRUSTED: it was written by a different build, possibly a year ago,
 * possibly by a user poking at devtools, possibly truncated by a browser that
 * ran out of quota mid-write. Every one of those has to produce a working
 * studio.
 *
 * The failure this prevents is specific and nasty: a studio that white-screens
 * on a stale localStorage entry is a bug the user cannot diagnose, cannot
 * report usefully, and can only fix by clearing site data — which also throws
 * away everything else the app stored. **`reconcile` never throws.**
 *
 * It is equally not allowed to be a RESET. Silently restoring defaults every
 * time anything looks odd would quietly discard the arrangement someone built,
 * which is the feature. So it repairs what it can and keeps what it can trust.
 */

export type PanelKind = 'prompt' | 'options' | 'reasoning' | 'output' | 'verdict';
export type Panel = { id: string; kind: PanelKind; title: string; collapsed: boolean; order: number };
export type StudioView = 'labelling' | 'diagnosis';

const PANEL_KINDS: readonly PanelKind[] = ['prompt', 'options', 'reasoning', 'output', 'verdict'];

const TITLES: Record<PanelKind, string> = {
  prompt: 'Prompt',
  options: 'Options',
  reasoning: 'Reasoning',
  output: 'Output',
  verdict: 'Verdict',
};

/**
 * The panels a view starts with.
 *
 * `id === kind` for these, and every call site in this repo passes a kind where
 * an id is expected, which works only because of that. The two fields stay
 * DISTINCT IN THE TYPE anyway: a view will eventually want two panels of the
 * same kind (two candidate outputs side by side is the obvious one), and
 * collapsing them now would make that a breaking change to every signature.
 *
 * `'diagnosis'` is in `StudioView` because A3 needs it, and because a
 * single-valued union invites someone to delete the parameter — which would
 * then have to be reintroduced along with every call site. It currently
 * returns the same five panels; A3 is what gives it its own shape.
 *
 * Returns a FRESH array of fresh objects every call. Callers hold these in
 * React state and the module-level defaults must not be shared into it.
 */
export function defaultLayout(view: StudioView): Panel[] {
  void view;
  return PANEL_KINDS.map((kind, order) => ({
    id: kind,
    kind,
    title: TITLES[kind],
    collapsed: false,
    order,
  }));
}

/** Orders renumbered contiguously from 0, in array order. */
function renumber(panels: Panel[]): Panel[] {
  return panels.map((panel, order) => ({ ...panel, order }));
}

/**
 * Move the panel with `id` to `toIndex`, clamped.
 *
 * Never mutates the input: these live in React state, and mutating in place
 * leaves the array reference unchanged, so the re-render never happens and the
 * panel visibly does not move.
 *
 * An unknown id is a NO-OP rather than a drop. A drag event can arrive for a
 * panel another tab's reconcile has just removed, and losing a panel to that
 * race would be a data loss the user cannot undo.
 */
export function applyReorder(panels: Panel[], id: string, toIndex: number): Panel[] {
  const ordered = [...panels].sort((a, b) => a.order - b.order);
  const from = ordered.findIndex((p) => p.id === id);
  if (from === -1) return renumber(ordered);

  const target = Math.max(0, Math.min(Math.trunc(toIndex), ordered.length - 1));
  const [moved] = ordered.splice(from, 1);
  ordered.splice(target, 0, moved);
  return renumber(ordered);
}

/** Set one panel's collapsed flag. Order is untouched — collapsing is not moving. */
export function applyCollapse(panels: Panel[], id: string, collapsed: boolean): Panel[] {
  return panels.map((panel) => (panel.id === id ? { ...panel, collapsed } : { ...panel }));
}

function isPanelKind(value: unknown): value is PanelKind {
  return typeof value === 'string' && (PANEL_KINDS as readonly string[]).includes(value);
}

/**
 * Turn whatever came out of storage into a usable layout.
 *
 * Guarantees, all tested:
 *   - NEVER THROWS, for any input at all.
 *   - Anything that is not an array of objects yields `defaults`.
 *   - Entries whose `kind` this build does not know are dropped — that is the
 *     forward-compatibility path, for a layout saved by a newer build.
 *   - A kind appearing twice is de-duplicated; a kind that is missing is
 *     appended from `defaults` — the backward-compatibility path, for a layout
 *     saved before a panel existed.
 *   - `order` is renumbered contiguously from 0 regardless of what was stored.
 *   - `title` comes from THIS BUILD, never from the blob. A title is code, not
 *     user data; restoring a stale one would let a renamed panel keep its old
 *     label forever on exactly the machines that have used the studio longest.
 *   - `collapsed` is taken from the blob when it is a boolean, because that IS
 *     user data, and defaulted otherwise.
 *
 * IDEMPOTENT: its output is written straight back to storage, so a reconcile
 * that drifted would rewrite the layout slightly differently on every reload.
 */
export function reconcile(persisted: unknown, defaults: Panel[]): Panel[] {
  if (!Array.isArray(persisted)) return defaults.map((p) => ({ ...p }));

  const byKind = new Map<PanelKind, Panel>();
  for (const entry of persisted) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as Record<string, unknown>;
    if (!isPanelKind(candidate.kind)) continue;
    if (byKind.has(candidate.kind)) continue;

    const fallback = defaults.find((d) => d.kind === candidate.kind);
    byKind.set(candidate.kind, {
      id: typeof candidate.id === 'string' ? candidate.id : (fallback?.id ?? candidate.kind),
      kind: candidate.kind,
      title: fallback?.title ?? TITLES[candidate.kind],
      collapsed: typeof candidate.collapsed === 'boolean' ? candidate.collapsed : false,
      // Replaced wholesale by `renumber` below; kept here only so the sort
      // that follows has something numeric to work with.
      order: typeof candidate.order === 'number' && Number.isFinite(candidate.order)
        ? candidate.order
        : Number.MAX_SAFE_INTEGER,
    });
  }

  // Nothing recognisable at all — including an array of the wrong thing
  // entirely — is the same case as "not an array": there is no user intent to
  // preserve, so the defaults are the honest answer.
  if (byKind.size === 0) return defaults.map((p) => ({ ...p }));

  const kept = [...byKind.values()].sort((a, b) => a.order - b.order);
  // Anything this build has and the blob did not, appended in default order.
  const missing = defaults.filter((d) => !byKind.has(d.kind)).map((p) => ({ ...p }));
  return renumber([...kept, ...missing]);
}
