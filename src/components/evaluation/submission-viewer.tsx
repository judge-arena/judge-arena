'use client';

import React from 'react';
import { cn } from '@/lib/utils';

interface SubmissionViewerProps {
  text: string;
  title?: string | null;
  className?: string;
}

export function SubmissionViewer({
  text,
  title,
  className,
}: SubmissionViewerProps) {
  return (
    <div className={cn('rounded-xl border border-surface-200 bg-white', className)}>
      <div className="flex items-center justify-between border-b border-surface-100 px-4 py-3">
        <h3 className="text-sm font-semibold text-surface-900">
          {title || 'Submission'}
        </h3>
        <span className="text-2xs text-surface-400">
          {text.length.toLocaleString()} chars
        </span>
      </div>
      <div className="max-h-[500px] overflow-y-auto p-4">
        <div className="prose prose-sm max-w-none text-surface-700">
          {text.split('\n').map((line, i) => {
            // Basic markdown rendering for headers
            if (line.startsWith('### ')) {
              return (
                <h4 key={i} className="text-sm font-semibold text-surface-800 mt-3 mb-1">
                  {line.slice(4)}
                </h4>
              );
            }
            if (line.startsWith('## ')) {
              return (
                <h3 key={i} className="text-base font-semibold text-surface-900 mt-4 mb-1">
                  {line.slice(3)}
                </h3>
              );
            }
            if (line.startsWith('# ')) {
              return (
                <h2 key={i} className="text-lg font-bold text-surface-900 mt-4 mb-2">
                  {line.slice(2)}
                </h2>
              );
            }
            if (line.startsWith('```')) {
              return null; // Code blocks handled below
            }
            if (line.startsWith('- ')) {
              return (
                <li key={i} className="ml-4 text-sm list-disc">
                  {line.slice(2)}
                </li>
              );
            }
            if (line.trim() === '') {
              return <br key={i} />;
            }
            // Render inline code
            const parts = line.split(/(`[^`]+`)/g);
            return (
              <p key={i} className="text-sm leading-relaxed">
                {parts.map((part, pi) =>
                  part.startsWith('`') && part.endsWith('`') ? (
                    <code
                      key={pi}
                      className="rounded bg-surface-100 px-1 py-0.5 font-mono text-xs text-brand-700"
                    >
                      {part.slice(1, -1)}
                    </code>
                  ) : (
                    <React.Fragment key={pi}>{part}</React.Fragment>
                  )
                )}
              </p>
            );
          })}
        </div>
      </div>
    </div>
  );
}
