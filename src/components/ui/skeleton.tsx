import * as React from 'react';
import { cn } from '@/lib/utils';

function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'animate-pulse rounded-md bg-surface-200',
        className
      )}
      aria-hidden="true"
      {...props}
    />
  );
}

export { Skeleton };
