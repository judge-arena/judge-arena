'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface SelectProps
  extends React.SelectHTMLAttributes<HTMLSelectElement> {
  error?: string;
  label?: string;
  hint?: string;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  placeholder?: string;
}

const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, error, label, hint, id, options, placeholder, ...props }, ref) => {
    const selectId = id || React.useId();

    return (
      <div className="w-full">
        {label && (
          <label
            htmlFor={selectId}
            className="mb-1.5 block text-sm font-medium text-surface-700 dark:text-surface-300"
          >
            {label}
          </label>
        )}
        <select
          id={selectId}
          ref={ref}
          aria-invalid={!!error}
          aria-describedby={
            error
              ? `${selectId}-error`
              : hint
                ? `${selectId}-hint`
                : undefined
          }
          className={cn(
            'flex h-9 w-full rounded-lg border bg-white dark:bg-surface-800 px-3 py-1 text-sm shadow-sm transition-colors appearance-none dark:text-surface-100',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:border-brand-500',
            'disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-surface-50 dark:disabled:bg-surface-900',
            error
              ? 'border-red-500 focus-visible:ring-red-500'
              : 'border-surface-300 dark:border-surface-600',
            className
          )}
          {...props}
        >
          {placeholder && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {options.map((opt) => (
            <option key={opt.value} value={opt.value} disabled={opt.disabled}>
              {opt.label}
            </option>
          ))}
        </select>
        {error && (
          <p
            id={`${selectId}-error`}
            className="mt-1 text-xs text-red-600 dark:text-red-400"
            role="alert"
          >
            {error}
          </p>
        )}
        {hint && !error && (
          <p
            id={`${selectId}-hint`}
            className="mt-1 text-xs text-surface-500 dark:text-surface-400"
          >
            {hint}
          </p>
        )}
      </div>
    );
  }
);

Select.displayName = 'Select';

export { Select };
