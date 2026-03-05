import * as React from 'react';
import { cn } from '@/lib/utils';

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  error?: string;
  label?: string;
  hint?: string;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, error, label, hint, id, type = 'text', ...props }, ref) => {
    const inputId = id || React.useId();

    return (
      <div className="w-full">
        {label && (
          <label
            htmlFor={inputId}
            className="mb-1.5 block text-sm font-medium text-surface-700 dark:text-surface-300"
          >
            {label}
          </label>
        )}
        <input
          id={inputId}
          type={type}
          ref={ref}
          aria-invalid={!!error}
          aria-describedby={
            error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined
          }
          className={cn(
            'flex h-9 w-full rounded-lg border bg-white px-3 py-1 text-sm shadow-sm transition-colors dark:bg-surface-800 dark:text-surface-100',
            'placeholder:text-surface-400 dark:placeholder:text-surface-500',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:border-brand-500',
            'disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-surface-50 dark:disabled:bg-surface-900',
            error
              ? 'border-red-500 focus-visible:ring-red-500'
              : 'border-surface-300 dark:border-surface-600',
            className
          )}
          {...props}
        />
        {error && (
          <p
            id={`${inputId}-error`}
            className="mt-1 text-xs text-red-600 dark:text-red-400"
            role="alert"
          >
            {error}
          </p>
        )}
        {hint && !error && (
          <p id={`${inputId}-hint`} className="mt-1 text-xs text-surface-500 dark:text-surface-400">
            {hint}
          </p>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';

export { Input };
