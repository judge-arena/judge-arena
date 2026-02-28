import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge Tailwind classes with conflict resolution */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format a date for display */
export function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Format a date with time */
export function formatDateTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Format milliseconds as readable duration */
export function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

/** Truncate text with ellipsis */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

/** Generate a weighted average score from criteria scores */
export function computeWeightedScore(
  criteriaScores: Array<{ score: number; weight: number; maxScore: number }>
): number {
  const totalWeight = criteriaScores.reduce((sum, c) => sum + c.weight, 0);
  if (totalWeight === 0) return 0;

  const weightedSum = criteriaScores.reduce(
    (sum, c) => sum + (c.score / c.maxScore) * c.weight,
    0
  );

  return (weightedSum / totalWeight) * 10; // Normalize to 0-10 scale
}

/** Status badge color mapping */
export function getStatusColor(status: string): string {
  switch (status) {
    case 'pending':
      return 'bg-amber-100 text-amber-800 border-amber-200';
    case 'judging':
    case 'running':
      return 'bg-blue-100 text-blue-800 border-blue-200';
    case 'completed':
      return 'bg-emerald-100 text-emerald-800 border-emerald-200';
    case 'error':
      return 'bg-red-100 text-red-800 border-red-200';
    default:
      return 'bg-gray-100 text-gray-800 border-gray-200';
  }
}

/** Score color based on value (0-10 scale) */
export function getScoreColor(score: number, maxScore: number = 10): string {
  const normalized = score / maxScore;
  if (normalized >= 0.8) return 'text-emerald-600';
  if (normalized >= 0.6) return 'text-blue-600';
  if (normalized >= 0.4) return 'text-amber-600';
  return 'text-red-600';
}

/** Provider display name and icon */
export function getProviderInfo(provider: string): {
  label: string;
  color: string;
} {
  switch (provider) {
    case 'anthropic':
      return { label: 'Anthropic', color: 'bg-orange-100 text-orange-800' };
    case 'openai':
      return { label: 'OpenAI', color: 'bg-green-100 text-green-800' };
    case 'local':
      return { label: 'Local', color: 'bg-purple-100 text-purple-800' };
    default:
      return { label: provider, color: 'bg-gray-100 text-gray-800' };
  }
}

/** Safely parse JSON string */
export function safeParseJSON<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

/** Generate a unique ID (client-side) */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** Keyboard shortcut display formatter */
export function formatShortcut(shortcut: string): string {
  const isMac =
    typeof navigator !== 'undefined' && navigator.platform?.includes('Mac');
  return shortcut
    .replace(/mod/gi, isMac ? '⌘' : 'Ctrl')
    .replace(/alt/gi, isMac ? '⌥' : 'Alt')
    .replace(/shift/gi, isMac ? '⇧' : 'Shift');
}
