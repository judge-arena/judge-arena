import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Keyboard shortcut display badge (e.g., shows "⌘K" or "Ctrl+K")
 */
function Kbd({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <kbd
      className={cn(
        'inline-flex items-center justify-center rounded border border-surface-300 bg-surface-50 px-1.5 py-0.5',
        'font-mono text-2xs font-medium text-surface-600',
        'min-w-[1.5rem] text-center',
        className
      )}
    >
      {children}
    </kbd>
  );
}

export { Kbd };
