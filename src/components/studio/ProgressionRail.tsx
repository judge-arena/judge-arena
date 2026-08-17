import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A1.5 — the stage strip: where this item is in the pipeline.
 *
 * ── AN EMPTY STAGE IS RENDERED, NEVER OMITTED ──────────────────────────────
 *
 * This is the whole point of the component and the exit gate's third clause.
 * Omitting a stage with no data makes the studio LOOK COMPLETE when half the
 * pipeline has not run — the reader sees a tidy rail of finished stages and
 * has no way to know that `model` and `answer` are missing rather than
 * absent-by-design.
 *
 * So there are three states and they are visually distinct:
 *
 *   done     this stage produced something
 *   empty    this stage RAN or is applicable, and produced nothing
 *   pending  this stage has not run yet
 *
 * `empty` and `pending` are deliberately different. "No judgment exists
 * because no calibration has run" and "the model returned no reasoning" are
 * different facts, and collapsing them loses the one that indicates a defect.
 */

export type Stage = {
  key: string;
  label: string;
  state: 'done' | 'empty' | 'pending';
};

const STATE_STYLES: Record<Stage['state'], string> = {
  done: 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-200',
  empty:
    'border-dashed border-surface-300 bg-transparent text-surface-500 dark:border-surface-600 dark:text-surface-400',
  pending: 'border-surface-200 bg-surface-50 text-surface-400 dark:border-surface-700 dark:bg-surface-800/50',
};

const STATE_LABELS: Record<Stage['state'], string> = {
  done: 'complete',
  empty: 'no data',
  pending: 'not started',
};

export function ProgressionRail({ stages, className }: { stages: Stage[]; className?: string }) {
  return (
    <ol
      className={cn('flex flex-wrap items-center gap-2', className)}
      aria-label="Pipeline progression"
    >
      {stages.map((stage) => (
        <li
          key={stage.key}
          className={cn(
            'rounded-full border px-3 py-1 text-xs font-medium',
            STATE_STYLES[stage.state]
          )}
        >
          {stage.label}
          {/* The state is spelled out for assistive tech rather than carried
              only by border style and colour, which is the same argument as
              <ins>/<del> in DeltaTextView. */}
          <span className="sr-only"> — {STATE_LABELS[stage.state]}</span>
          {stage.state === 'empty' && (
            <span aria-hidden="true" className="ml-1.5 opacity-70">
              —
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}
