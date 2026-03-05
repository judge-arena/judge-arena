import * as React from 'react';
import { cn } from '@/lib/utils';

/* ---------- Card ---------- */
const Card = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { interactive?: boolean }
>(({ className, interactive, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      'rounded-xl border border-surface-200 bg-white shadow-sm dark:border-surface-700 dark:bg-surface-800',
      interactive &&
        'transition-shadow hover:shadow-md cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:hover:shadow-surface-900/50',
      className
    )}
    tabIndex={interactive ? 0 : undefined}
    role={interactive ? 'button' : undefined}
    {...props}
  />
));
Card.displayName = 'Card';

/* ---------- CardHeader ---------- */
const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn('flex flex-col space-y-1 p-5 pb-3', className)}
    {...props}
  />
));
CardHeader.displayName = 'CardHeader';

/* ---------- CardTitle ---------- */
const CardTitle = React.forwardRef<
  HTMLHeadingElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h3
    ref={ref}
    className={cn('text-base font-semibold text-surface-900 dark:text-surface-100', className)}
    {...props}
  />
));
CardTitle.displayName = 'CardTitle';

/* ---------- CardDescription ---------- */
const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p
    ref={ref}
    className={cn('text-sm text-surface-500 dark:text-surface-400', className)}
    {...props}
  />
));
CardDescription.displayName = 'CardDescription';

/* ---------- CardContent ---------- */
const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('px-5 pb-5', className)} {...props} />
));
CardContent.displayName = 'CardContent';

/* ---------- CardFooter ---------- */
const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      'flex items-center px-5 py-3 border-t border-surface-100 dark:border-surface-700',
      className
    )}
    {...props}
  />
));
CardFooter.displayName = 'CardFooter';

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
