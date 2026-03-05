'use client';

import React from 'react';
import { useTheme } from 'next-themes';
import { cn } from '@/lib/utils';

interface ThemeToggleProps {
  collapsed?: boolean;
}

export function ThemeToggle({ collapsed }: ThemeToggleProps) {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => setMounted(true), []);

  if (!mounted) {
    // Prevent hydration mismatch — render a placeholder matching the layout
    return (
      <button
        className={cn(
          'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-surface-500 transition-colors',
          collapsed ? 'justify-center' : ''
        )}
        aria-label="Toggle theme"
      >
        <span className="h-[18px] w-[18px] shrink-0" />
        {!collapsed && <span>Theme</span>}
      </button>
    );
  }

  const isDark = resolvedTheme === 'dark';

  const cycle = () => {
    if (theme === 'system') setTheme('light');
    else if (theme === 'light') setTheme('dark');
    else setTheme('system');
  };

  const label =
    theme === 'system' ? 'System' : theme === 'dark' ? 'Dark' : 'Light';

  return (
    <button
      onClick={cycle}
      className={cn(
        'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
        'text-surface-500 hover:bg-surface-100 hover:text-surface-700 dark:hover:bg-surface-800 dark:hover:text-surface-300',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500'
      )}
      aria-label={`Theme: ${label}. Click to cycle.`}
      title={`Current: ${label}`}
    >
      {/* Sun icon (light) */}
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={cn('shrink-0 transition-all', isDark ? 'hidden' : 'block')}
      >
        <circle cx="12" cy="12" r="5" />
        <line x1="12" y1="1" x2="12" y2="3" />
        <line x1="12" y1="21" x2="12" y2="23" />
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
        <line x1="1" y1="12" x2="3" y2="12" />
        <line x1="21" y1="12" x2="23" y2="12" />
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
        <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
      </svg>

      {/* Moon icon (dark) */}
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={cn('shrink-0 transition-all', isDark ? 'block' : 'hidden')}
      >
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>

      {!collapsed && <span>{label}</span>}
    </button>
  );
}
