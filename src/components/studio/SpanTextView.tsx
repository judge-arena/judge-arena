import * as React from 'react';
import { cn } from '@/lib/utils';
import { segment, type SpanText } from '@/lib/studio/content';

/**
 * A1.5 — renders a `SpanText` through `segment()`.
 *
 * NOTHING PRODUCES SPANS YET, so the only path exercised today is the
 * no-spans one: a single plain run. The component exists now because the
 * offsets contract does (see src/lib/studio/content.ts), and because rendering
 * is the half that reveals whether the contract was honoured.
 *
 * ALL THE LOGIC THAT CAN BE WRONG IS IN `segment`, deliberately: this repo has
 * no jsdom, so nothing in src/components/ can be unit-tested at all. This file
 * maps runs to elements and does not decide anything.
 *
 * `whitespace-pre-wrap` is not cosmetic — model output is newline-significant,
 * and collapsing it would silently reflow the exact text an annotator is being
 * asked to judge.
 */

/** Class per span kind. An unknown kind renders unstyled rather than crashing. */
const SPAN_CLASSES: Record<string, string> = {
  evidence: 'bg-brand-100 dark:bg-brand-900/40 rounded-sm',
  error: 'bg-red-100 dark:bg-red-900/40 rounded-sm',
  note: 'underline decoration-dotted underline-offset-2',
};

export function SpanTextView({ value, className }: { value: SpanText; className?: string }) {
  const runs = segment(value);

  return (
    <div className={cn('whitespace-pre-wrap break-words text-sm leading-relaxed', className)}>
      {runs.map((run, i) => {
        if (run.spans.length === 0) return <React.Fragment key={i}>{run.text}</React.Fragment>;
        return (
          <mark
            key={i}
            // A run can be covered by more than one span — that is the whole
            // reason segment() attaches all of them — so every kind's class
            // applies, not just the first.
            className={cn('bg-transparent text-inherit', run.spans.map((s) => SPAN_CLASSES[s.kind]))}
            data-span-kinds={run.spans.map((s) => s.kind).join(' ')}
          >
            {run.text}
          </mark>
        );
      })}
    </div>
  );
}
