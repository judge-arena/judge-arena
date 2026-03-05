'use client';

import { useEffect } from 'react';

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[Evaluate] error:', error);
  }, [error]);

  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center px-4">
      <div className="mx-auto max-w-md text-center">
        <h2 className="mb-2 text-lg font-semibold text-surface-900 dark:text-surface-100">
          Failed to load evaluation
        </h2>
        <p className="mb-4 text-sm text-surface-500 dark:text-surface-400">
          {error.message || 'An unexpected error occurred.'}
        </p>
        <button
          onClick={reset}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 transition-colors"
        >
          Try Again
        </button>
      </div>
    </div>
  );
}
