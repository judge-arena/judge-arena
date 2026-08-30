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

/**
 * Resolve the overallScore for a human judgment submission.
 *
 * The route serves two distinct modes and they are NOT resolved the same way:
 * - 'judge' mode: the user scores an existing response against a rubric.
 *   - If overallScore is provided, use it (takes precedence over criteriaScores)
 *   - If overallScore is missing but criteriaScores exists, compute via weighted average
 *   - If both are missing, throw an error (caller should return 400)
 * - 'respond' mode: the user picks the best of several model responses; there
 *   is no scoring concept at all (the form never sends overallScore or
 *   criteriaScores). Resolution is skipped entirely and a placeholder is
 *   returned since the column is non-nullable.
 *
 * @throws Error in 'judge' mode if both overallScore and criteriaScores are missing/empty
 */
export function resolveHumanJudgmentScore({
  mode,
  overallScore,
  criteriaScores,
}: {
  mode: 'judge' | 'respond';
  overallScore: number | undefined;
  criteriaScores: Array<{ score: number; weight: number; maxScore: number }> | undefined | null;
}): number {
  if (mode === 'respond') {
    // respond mode has no scoring concept; 0 is a placeholder, excluded from averages by mode
    return 0;
  }

  // judge mode: if explicit overallScore provided, use it
  if (typeof overallScore === 'number') {
    return overallScore;
  }

  // judge mode: if criteriaScores provided, compute from weights
  if (criteriaScores && Array.isArray(criteriaScores) && criteriaScores.length > 0) {
    return computeWeightedScore(criteriaScores);
  }

  // judge mode, both missing: error
  throw new Error('overallScore or criteriaScores required');
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
    // ServingBackend values (Task 10/12) — a JudgeModelVersion's backend is
    // now the "provider" a lot of UI surfaces pass through here.
    case 'openrouter':
      return { label: 'OpenRouter', color: 'bg-blue-100 text-blue-800' };
    case 'vllm':
      return { label: 'vLLM', color: 'bg-purple-100 text-purple-800' };
    // Indigo, not purple: llama.cpp and vLLM are both self-hosted
    // OpenAI-compatible servers and would otherwise be the same chip, and an
    // operator debugging a bad run needs to tell which of the two boxes
    // answered. Also not teal — that is ollama, the one backend refused for
    // scored runs, so confusing it with llamacpp is the expensive mistake.
    case 'llamacpp':
      return { label: 'llama.cpp', color: 'bg-indigo-100 text-indigo-800' };
    case 'ollama':
      return { label: 'Ollama', color: 'bg-teal-100 text-teal-800' };
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

/** Build consistent rubric version select options */
export function buildRubricVersionOptions(
  rubrics: Array<{
    id: string;
    name: string;
    version?: number;
    parentId?: string | null;
  }>
): Array<{ value: string; label: string }> {
  const latestVersionByFamily = new Map<string, number>();

  for (const rubric of rubrics) {
    const familyId = rubric.parentId ?? rubric.id;
    const version = rubric.version ?? 1;
    const current = latestVersionByFamily.get(familyId) ?? 0;
    if (version > current) {
      latestVersionByFamily.set(familyId, version);
    }
  }

  return [...rubrics]
    .sort((a, b) => {
      const nameCmp = a.name.localeCompare(b.name);
      if (nameCmp !== 0) return nameCmp;
      return (b.version ?? 1) - (a.version ?? 1);
    })
    .map((rubric) => {
      const familyId = rubric.parentId ?? rubric.id;
      const version = rubric.version ?? 1;
      const latestVersion = latestVersionByFamily.get(familyId) ?? version;
      const latestTag = version === latestVersion ? ' (latest)' : '';

      return {
        value: rubric.id,
        label: `${rubric.name} v${version}${latestTag}`,
      };
    });
}
