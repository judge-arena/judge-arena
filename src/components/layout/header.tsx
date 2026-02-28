'use client';

import React from 'react';
import { cn } from '@/lib/utils';

interface HeaderProps {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  breadcrumbs?: Array<{ label: string; href?: string }>;
  className?: string;
}

export function Header({
  title,
  description,
  actions,
  breadcrumbs,
  className,
}: HeaderProps) {
  return (
    <header
      className={cn(
        'flex flex-col gap-1 border-b border-surface-200 bg-white px-6 py-4',
        className
      )}
    >
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="mb-1">
          <ol className="flex items-center gap-1.5 text-xs text-surface-500">
            {breadcrumbs.map((crumb, i) => (
              <li key={i} className="flex items-center gap-1.5">
                {i > 0 && (
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden="true"
                  >
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                )}
                {crumb.href ? (
                  <a
                    href={crumb.href}
                    className="hover:text-surface-700 transition-colors"
                  >
                    {crumb.label}
                  </a>
                ) : (
                  <span className="text-surface-700 font-medium">
                    {crumb.label}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      )}
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-surface-900 truncate">
            {title}
          </h1>
          {description && (
            <p className="mt-0.5 text-sm text-surface-500 truncate">
              {description}
            </p>
          )}
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
    </header>
  );
}
