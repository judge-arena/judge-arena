import * as React from 'react';
import { cn } from '@/lib/utils';

/** Simple empty state component */
function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center py-12 text-center',
        className
      )}
    >
      {icon && (
        <div className="mb-4 text-surface-300" aria-hidden="true">
          {icon}
        </div>
      )}
      <h3 className="text-base font-semibold text-surface-700">{title}</h3>
      {description && (
        <p className="mt-1.5 max-w-sm text-sm text-surface-500">
          {description}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export { EmptyState };
