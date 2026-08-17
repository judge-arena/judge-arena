'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A1.5 — one box in the studio: title, collapse toggle, drag handle, content.
 *
 * ── THE EMPTY STATE IS REQUIRED, NOT OPTIONAL ──────────────────────────────
 *
 * A panel with no content renders WHY — "no reasoning captured for this
 * model" — rather than a blank box. A blank box is indistinguishable from a
 * rendering bug, and in this product it is usually neither: it means that
 * stage of the pipeline has not run, or that the model does not emit that
 * field at all. `reasoning` is the live example: chain-of-thought is discarded
 * on every model call today (preflight Stage 5), so this panel is
 * structurally thin and CORRECT rather than broken, and it has to say so.
 *
 * That is why `emptyReason` is a required prop when `children` is absent —
 * a caller cannot forget it and get a silent blank.
 */

export type PanelProps = {
  title: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** Absent/empty children render `emptyReason` instead. */
  children?: React.ReactNode;
  emptyReason: string;
  /** Drag affordance. Omitted when reordering is not offered. */
  dragHandleProps?: React.HTMLAttributes<HTMLButtonElement>;
  className?: string;
};

export function Panel({
  title,
  collapsed,
  onToggleCollapse,
  children,
  emptyReason,
  dragHandleProps,
  className,
}: PanelProps) {
  const contentId = React.useId();
  const isEmpty =
    children === undefined || children === null || children === false ||
    (Array.isArray(children) && children.length === 0);

  return (
    <section
      className={cn(
        'rounded-xl border border-surface-200 bg-white shadow-sm dark:border-surface-700 dark:bg-surface-800',
        className
      )}
      aria-label={title}
    >
      <header className="flex items-center gap-2 border-b border-surface-100 px-4 py-2.5 dark:border-surface-700">
        {dragHandleProps && (
          <button
            type="button"
            {...dragHandleProps}
            className="cursor-grab rounded px-1 text-surface-400 hover:text-surface-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:hover:text-surface-200"
            // The handle is a real button so it is reachable by keyboard.
            // Pointer-only reordering would make the layout feature
            // unavailable to anyone not using a mouse — see the runbook's
            // keyboard step.
            aria-label={`Reorder ${title}`}
          >
            ⠿
          </button>
        )}
        <h2 className="flex-1 text-sm font-semibold text-surface-700 dark:text-surface-200">
          {title}
        </h2>
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-expanded={!collapsed}
          aria-controls={contentId}
          className="rounded px-2 py-0.5 text-xs text-surface-500 hover:bg-surface-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:hover:bg-surface-700"
        >
          {collapsed ? 'Expand' : 'Collapse'}
        </button>
      </header>

      {/* `hidden` rather than unmounting: a collapsed panel's content keeps
          its state — a half-typed verdict is not discarded by tidying the
          view away. */}
      <div id={contentId} hidden={collapsed} className="p-4">
        {isEmpty ? (
          <p className="text-sm italic text-surface-500 dark:text-surface-400">{emptyReason}</p>
        ) : (
          children
        )}
      </div>
    </section>
  );
}
