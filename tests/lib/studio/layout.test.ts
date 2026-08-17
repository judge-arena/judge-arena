import { describe, expect, it } from 'vitest';
import { applyCollapse, applyReorder, defaultLayout, reconcile } from '@/lib/studio/layout';

describe('defaultLayout', () => {
  it('labelling has all five kinds, ordered 0..4', () => {
    const panels = defaultLayout('labelling');
    expect(panels.map((p) => p.kind)).toEqual([
      'prompt',
      'options',
      'reasoning',
      'output',
      'verdict',
    ]);
    expect(panels.map((p) => p.order)).toEqual([0, 1, 2, 3, 4]);
  });

  it('gives each default panel an id equal to its kind, which the callers rely on', () => {
    // applyReorder/applyCollapse take an ID. Every call site in this repo
    // passes a KIND, and that only works because the default layout makes them
    // equal. Pinned so the equivalence is a decision rather than a
    // coincidence — the type keeps them distinct on purpose, because a view
    // will eventually want two panels of the same kind.
    for (const panel of defaultLayout('labelling')) expect(panel.id).toBe(panel.kind);
  });

  it('returns a FRESH array each call — callers mutate their copy', () => {
    const a = defaultLayout('labelling');
    a[0].collapsed = true;
    expect(defaultLayout('labelling')[0].collapsed).toBe(false);
  });
});

describe('applyReorder / applyCollapse', () => {
  it('moving a panel renumbers every order contiguously from 0', () => {
    const moved = applyReorder(defaultLayout('labelling'), 'verdict', 0);
    expect(moved.map((p) => p.kind)).toEqual([
      'verdict',
      'prompt',
      'options',
      'reasoning',
      'output',
    ]);
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

  it('a negative index clamps to the front — -1 means FIRST here, not "from the end"', () => {
    // -1 specifically. Array.prototype.splice interprets a negative index as
    // an offset from the END, so an unclamped -1 inserts the panel
    // second-to-LAST — the opposite of what a drag to the top means. A larger
    // negative like -5 hides this completely, because splice clamps it to 0
    // by itself and an implementation with no clamp at all still passes.
    // Found by injection: removing the clamp broke nothing until this case
    // used -1.
    const moved = applyReorder(defaultLayout('labelling'), 'output', -1);
    expect(moved[0].kind).toBe('output');
    expect(moved.map((p) => p.order)).toEqual([0, 1, 2, 3, 4]);

    const far = applyReorder(defaultLayout('labelling'), 'output', -99);
    expect(far[0].kind).toBe('output');
  });

  it('a fractional index is truncated rather than corrupting the sequence', () => {
    const moved = applyReorder(defaultLayout('labelling'), 'verdict', 1.9);
    expect(moved.map((p) => p.order)).toEqual([0, 1, 2, 3, 4]);
    expect(moved[1].kind).toBe('verdict');
  });

  it('an unknown id is a no-op, not a crash or a silent drop', () => {
    // A drag event can arrive for a panel that has just been removed by
    // another tab's reconcile. Losing a panel because of it would be a data
    // loss the user cannot undo.
    const before = defaultLayout('labelling');
    expect(applyReorder(before, 'nope', 0)).toEqual(before);
    expect(applyCollapse(before, 'nope', true)).toEqual(before);
  });

  it('does not MUTATE the input array', () => {
    // React state. Mutating in place means the reference is unchanged, the
    // re-render never happens, and the panel visibly does not move.
    const before = defaultLayout('labelling');
    const snapshot = JSON.parse(JSON.stringify(before));
    applyReorder(before, 'verdict', 0);
    applyCollapse(before, 'prompt', true);
    expect(before).toEqual(snapshot);
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

  it('survives hostile shapes without throwing', () => {
    for (const junk of [
      [null],
      [{ kind: null }],
      [{ kind: 'prompt', order: 'first' }],
      [{ kind: 'prompt', collapsed: 'yes' }],
      [{ kind: ['prompt'] }],
      { length: 5 },
      true,
    ]) {
      expect(() => reconcile(junk, defaults)).not.toThrow();
      expect(reconcile(junk, defaults).map((p) => p.kind).sort()).toEqual(
        defaults.map((p) => p.kind).sort()
      );
    }
  });

  it('drops a panel kind this build no longer knows', () => {
    const stale = [
      ...defaults.map((p) => ({ ...p })),
      { id: 'x', kind: 'telepathy', title: 'X', collapsed: false, order: 9 },
    ];
    expect(reconcile(stale, defaults).map((p) => p.kind)).toEqual(defaults.map((p) => p.kind));
  });

  it('restores a panel the persisted layout is missing, at the end', () => {
    const missing = defaults.filter((p) => p.kind !== 'verdict').map((p) => ({ ...p }));
    const out = reconcile(missing, defaults);
    expect(out.map((p) => p.kind)).toContain('verdict');
    expect(out).toHaveLength(defaults.length);
  });

  it('de-duplicates a kind that appears twice, keeping the FIRST occurrence', () => {
    // The count alone does not pin this: the accumulator is a Map keyed by
    // kind, so a later duplicate overwrites an earlier one and the length is
    // right either way. What the duplicate-skip actually decides is WHICH copy
    // survives, and first-wins is the user's own ordering — the second copy is
    // the stale one a partial write or a merge left behind. Found by
    // injection: removing the skip changed no length, only the winner.
    const doubled = [
      { ...defaults[0], collapsed: true },
      { ...defaults[0], collapsed: false },
      ...defaults.slice(1).map((p) => ({ ...p })),
    ];
    const out = reconcile(doubled, defaults);
    expect(out).toHaveLength(defaults.length);
    expect(new Set(out.map((p) => p.kind)).size).toBe(defaults.length);
    expect(out.find((p) => p.kind === defaults[0].kind)!.collapsed).toBe(true);
  });

  it('repairs duplicate and missing orders into a contiguous sequence', () => {
    const broken = defaults.map((p) => ({ ...p, order: 0 }));
    expect(reconcile(broken, defaults).map((p) => p.order)).toEqual([0, 1, 2, 3, 4]);
  });

  it('takes the TITLE from this build, not from the persisted blob', () => {
    // A title is code, not user data. Restoring a year-old title would let a
    // renamed panel silently keep its old label forever, on exactly the
    // machines that have used the studio longest.
    const stale = defaults.map((p) => ({ ...p, title: 'ANCIENT' }));
    expect(reconcile(stale, defaults).every((p) => p.title !== 'ANCIENT')).toBe(true);
  });

  it('PRESERVES the user collapse and order it can trust', () => {
    // Reconciliation must not be a reset: the whole point is keeping the
    // layout someone arranged.
    const custom = applyCollapse(applyReorder(defaults, 'verdict', 0), 'options', true);
    const out = reconcile(JSON.parse(JSON.stringify(custom)), defaults);
    expect(out.map((p) => p.kind)).toEqual(custom.map((p) => p.kind));
    expect(out.find((p) => p.kind === 'options')!.collapsed).toBe(true);
  });

  it('is idempotent — reconciling its own output changes nothing', () => {
    // The output is written straight back to storage, so a reconcile that
    // drifted would rewrite the layout a little differently on every reload.
    const custom = applyCollapse(applyReorder(defaults, 'verdict', 0), 'options', true);
    const once = reconcile(custom, defaults);
    expect(reconcile(once, defaults)).toEqual(once);
  });
});
