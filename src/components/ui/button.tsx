import * as React from 'react';
import { cn } from '@/lib/utils';

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
  size?: 'sm' | 'md' | 'lg' | 'icon';
  loading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = 'primary',
      size = 'md',
      loading = false,
      disabled,
      children,
      ...props
    },
    ref
  ) => {
    const baseStyles =
      'inline-flex items-center justify-center font-medium rounded-lg transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-surface-900 disabled:pointer-events-none disabled:opacity-50 select-none';

    const variants: Record<string, string> = {
      primary:
        'bg-brand-600 text-white hover:bg-brand-700 active:bg-brand-800 shadow-sm',
      secondary:
        'bg-surface-100 text-surface-800 hover:bg-surface-200 active:bg-surface-300 border border-surface-200 dark:bg-surface-800 dark:text-surface-200 dark:border-surface-700 dark:hover:bg-surface-700 dark:active:bg-surface-600',
      ghost:
        'text-surface-600 hover:bg-surface-100 hover:text-surface-900 active:bg-surface-200 dark:text-surface-400 dark:hover:bg-surface-800 dark:hover:text-surface-100 dark:active:bg-surface-700',
      danger:
        'bg-red-600 text-white hover:bg-red-700 active:bg-red-800 shadow-sm',
      outline:
        'border border-surface-300 text-surface-700 hover:bg-surface-50 hover:border-brand-300 hover:text-brand-700 active:bg-surface-100 dark:border-surface-600 dark:text-surface-300 dark:hover:bg-surface-800 dark:hover:border-brand-600 dark:hover:text-brand-200 dark:active:bg-surface-700',
    };

    const sizes: Record<string, string> = {
      sm: 'h-8 px-3 text-xs gap-1.5',
      md: 'h-9 px-4 text-sm gap-2',
      lg: 'h-11 px-6 text-base gap-2.5',
      icon: 'h-9 w-9 p-0',
    };

    return (
      <button
        ref={ref}
        className={cn(baseStyles, variants[variant], sizes[size], className)}
        disabled={disabled || loading}
        {...props}
      >
        {loading && (
          <svg
            className="h-4 w-4 animate-spin"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
        )}
        {children}
      </button>
    );
  }
);

Button.displayName = 'Button';

export { Button };
