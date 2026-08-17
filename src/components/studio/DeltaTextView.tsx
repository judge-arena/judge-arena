import * as React from 'react';
import { cn } from '@/lib/utils';
import { toSpanText } from '@/lib/studio/content';
import { delta, type DeltaRun } from '@/lib/studio/delta';

/**
 * A1.5 — renders a word diff.
 *
 * ── WHY `<ins>` AND `<del>` RATHER THAN STYLED SPANS ───────────────────────
 *
 * Because they carry the MEANING to a screen reader, and "what changed" is
 * this panel's entire purpose. A coloured `<span>` communicates a diff to
 * exactly the users who can see colour; `<ins>`/`<del>` communicate it to
 * everyone. The colour is then redundant reinforcement rather than the only
 * channel — which is also why removals are struck through as well as tinted.
 *
 * The runs come pre-merged from `delta`, so a multi-word edit is ONE `<ins>`
 * rather than a stream of them announced individually.
 */

export function DeltaTextView({
  runs,
  className,
}: {
  runs: DeltaRun[];
  className?: string;
}) {
  return (
    <div className={cn('whitespace-pre-wrap break-words text-sm leading-relaxed', className)}>
      {runs.map((run, i) => {
        if (run.change === 'added') {
          return (
            <ins
              key={i}
              className="bg-emerald-100 text-emerald-900 no-underline dark:bg-emerald-900/40 dark:text-emerald-100"
            >
              {run.text}
            </ins>
          );
        }
        if (run.change === 'removed') {
          return (
            <del key={i} className="bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-100">
              {run.text}
            </del>
          );
        }
        return <React.Fragment key={i}>{run.text}</React.Fragment>;
      })}
    </div>
  );
}

/**
 * The two-version convenience: give it before and after, it diffs and renders.
 *
 * WITH ONLY ONE VERSION IT RENDERS PLAINLY rather than showing everything as
 * added. That is the exit gate's second clause, and it matters because the
 * first time anyone opens this panel there IS no previous version — a screen
 * of solid green "additions" would read as a change nobody made.
 */
export function DeltaOrPlain({
  before,
  after,
  className,
}: {
  before: string | null | undefined;
  after: string;
  className?: string;
}) {
  if (before === null || before === undefined) {
    return (
      <DeltaTextView runs={[{ text: toSpanText(after).text, change: 'unchanged' }]} className={className} />
    );
  }
  return <DeltaTextView runs={delta(toSpanText(before), toSpanText(after))} className={className} />;
}
