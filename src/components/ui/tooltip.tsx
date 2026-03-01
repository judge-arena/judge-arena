'use client';

import React, { useId } from 'react';
import { cn } from '@/lib/utils';

interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
}

export function Tooltip({
  content,
  children,
  side = 'top',
  className,
}: TooltipProps) {
  const id = useId();

  return (
    <div className={cn('relative inline-flex group/tooltip', className)}>
      <div aria-describedby={id}>{children}</div>
      <div
        id={id}
        role="tooltip"
        className={cn(
          'pointer-events-none absolute z-50 px-2.5 py-2',
          'bg-surface-900 text-white text-xs leading-relaxed rounded-lg shadow-lg',
          'w-max max-w-[260px] whitespace-normal',
          'opacity-0 group-hover/tooltip:opacity-100',
          'transition-opacity duration-150',
          side === 'top' && 'bottom-full left-1/2 -translate-x-1/2 mb-2',
          side === 'bottom' && 'top-full left-1/2 -translate-x-1/2 mt-2',
          side === 'left' && 'right-full top-1/2 -translate-y-1/2 mr-2',
          side === 'right' && 'left-full top-1/2 -translate-y-1/2 ml-2'
        )}
      >
        {content}
        <div
          className={cn(
            'absolute border-[5px] border-transparent',
            side === 'top' &&
              'top-full left-1/2 -translate-x-1/2 border-t-surface-900',
            side === 'bottom' &&
              'bottom-full left-1/2 -translate-x-1/2 border-b-surface-900',
            side === 'left' &&
              'left-full top-1/2 -translate-y-1/2 border-l-surface-900',
            side === 'right' &&
              'right-full top-1/2 -translate-y-1/2 border-r-surface-900'
          )}
        />
      </div>
    </div>
  );
}

export function TooltipIcon({
  content,
  side = 'top',
}: {
  content: React.ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  return (
    <Tooltip content={content} side={side}>
      <span
        tabIndex={0}
        className={cn(
          'inline-flex h-4 w-4 cursor-default items-center justify-center rounded-full',
          'bg-surface-200 text-surface-500 text-[10px] font-bold',
          'hover:bg-brand-100 hover:text-brand-700',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
          'transition-colors shrink-0'
        )}
        aria-label="More information"
      >
        ?
      </span>
    </Tooltip>
  );
}
