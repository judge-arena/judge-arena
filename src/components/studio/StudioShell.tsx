'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import {
  applyCollapse,
  applyReorder,
  defaultLayout,
  reconcile,
  type Panel as PanelDescriptor,
  type PanelKind,
  type StudioView,
} from '@/lib/studio/layout';
import { Panel } from '@/components/studio/Panel';

/**
 * A1.5 — lays panels out, owns the interaction, persists the arrangement.
 *
 * ── ADDING A BOX IS ADDING A KIND AND A RENDERER, NEVER EDITING THIS FILE ──
 *
 * The shell takes `renderers: Record<PanelKind, ReactNode>` and walks the
 * descriptor list in `order`. It knows how to lay panels out and nothing about
 * what is in them, which is what lets A3's diagnosis view reuse it by passing
 * different renderers rather than by forking it.
 *
 * ── THE `JSON.parse` IS IN A `try` FOR A REASON ────────────────────────────
 *
 * `reconcile` guarantees it never throws for any VALUE. It cannot guarantee
 * anything about a string that is not JSON at all — a blob truncated by a
 * browser hitting its storage quota mid-write throws in `JSON.parse`, before
 * `reconcile` is ever called. Without the `try` that is a white screen on
 * every subsequent load, fixable only by clearing site data. This is the
 * seam the two guarantees do not meet across, so it is guarded explicitly.
 *
 * ── WHY LAYOUT LOADS IN AN EFFECT RATHER THAN IN `useState` ────────────────
 *
 * `localStorage` does not exist during the server render. Reading it in a
 * `useState` initialiser makes the server and first client render disagree and
 * React discards the whole tree with a hydration error. So the first paint is
 * always the default layout, and the persisted one is applied immediately
 * after mount.
 */

export type StudioShellProps = {
  view: StudioView;
  /** localStorage key. Distinct per view so the two do not overwrite each other. */
  storageKey: string;
  renderers: Partial<Record<PanelKind, React.ReactNode>>;
  /** Shown in a panel that has no renderer content, per kind. */
  emptyReasons: Record<PanelKind, string>;
  className?: string;
};

export function StudioShell({
  view,
  storageKey,
  renderers,
  emptyReasons,
  className,
}: StudioShellProps) {
  const defaults = React.useMemo(() => defaultLayout(view), [view]);
  const [panels, setPanels] = React.useState<PanelDescriptor[]>(defaults);
  // Until the stored layout has been read, nothing is written back — otherwise
  // the first effect would persist the DEFAULTS over the user's saved layout
  // before it had been loaded.
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    let stored: unknown = null;
    try {
      const raw = window.localStorage.getItem(storageKey);
      stored = raw === null ? null : JSON.parse(raw);
    } catch {
      // Unparseable — treat exactly as "nothing stored". reconcile turns null
      // into the defaults, so there is no separate recovery path to get wrong.
      stored = null;
    }
    setPanels(reconcile(stored, defaults));
    setLoaded(true);
  }, [storageKey, defaults]);

  React.useEffect(() => {
    if (!loaded) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(panels));
    } catch {
      // Quota exceeded, or storage disabled entirely (private mode, or a
      // policy). Losing the arrangement is a far better outcome than losing
      // the studio, so this is swallowed rather than surfaced.
    }
  }, [panels, storageKey, loaded]);

  const ordered = React.useMemo(
    () => [...panels].sort((a, b) => a.order - b.order),
    [panels]
  );

  const move = (id: string, delta: number) => {
    const from = ordered.findIndex((p) => p.id === id);
    if (from === -1) return;
    setPanels((current) => applyReorder(current, id, from + delta));
  };

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {ordered.map((panel, index) => (
        <Panel
          key={panel.id}
          title={panel.title}
          collapsed={panel.collapsed}
          onToggleCollapse={() =>
            setPanels((current) => applyCollapse(current, panel.id, !panel.collapsed))
          }
          emptyReason={emptyReasons[panel.kind]}
          // Keyboard-operable reordering. Arrow keys on the handle, rather
          // than pointer drag only: a mouse-only arrangement feature is
          // unavailable to anyone not using a mouse, and this is the whole
          // interaction the phase is named for.
          dragHandleProps={{
            onKeyDown: (event) => {
              if (event.key === 'ArrowUp' && index > 0) {
                event.preventDefault();
                move(panel.id, -1);
              } else if (event.key === 'ArrowDown' && index < ordered.length - 1) {
                event.preventDefault();
                move(panel.id, 1);
              }
            },
            title: 'Reorder with the up and down arrow keys',
          }}
        >
          {renderers[panel.kind]}
        </Panel>
      ))}
    </div>
  );
}
