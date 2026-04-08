'use client';

import React from 'react';
import { cn, getScoreColor, formatLatency, safeParseJSON, getProviderInfo } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import type { CriteriaScore } from '@/types';

interface ModelJudgmentCardProps {
  mode?: 'respond' | 'judge';
  modelName: string;
  provider: string;
  overallScore: number | null;
  reasoning: string | null;
  criteriaScores: string | null;
  latencyMs: number | null;
  tokenCount: number | null;
  status: string;
  error: string | null;
  isSelected?: boolean;
  onSelect?: () => void;
  /** When true, reasoning is displayed in full without line-clamping */
  expandedReasoning?: boolean;
}

export function ModelJudgmentCard({
  mode = 'judge',
  modelName,
  provider,
  overallScore,
  reasoning,
  criteriaScores: criteriaScoresJson,
  latencyMs,
  tokenCount,
  status,
  error,
  isSelected,
  onSelect,
  expandedReasoning = false,
}: ModelJudgmentCardProps) {
  const criteriaScores = safeParseJSON<CriteriaScore[]>(criteriaScoresJson, []);
  const providerInfo = getProviderInfo(provider);

  const statusVariant =
    status === 'completed'
      ? 'success'
      : status === 'error'
        ? 'error'
        : status === 'running'
          ? 'info'
          : 'default';

  return (
    <div
      className={cn(
        'rounded-xl border bg-white dark:bg-surface-800 transition-all',
        isSelected
          ? 'border-brand-500 ring-2 ring-brand-200 dark:ring-brand-800 shadow-md'
          : 'border-surface-200 dark:border-surface-700 hover:border-surface-300 dark:hover:border-surface-600 shadow-sm',
        onSelect && 'cursor-pointer',
        status === 'running' && 'animate-pulse-subtle'
      )}
      onClick={onSelect}
      role={onSelect ? 'button' : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onKeyDown={
        onSelect
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect();
              }
            }
          : undefined
      }
      aria-pressed={isSelected}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-surface-100 dark:border-surface-700">
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100 truncate">
            {modelName}
          </h3>
          <Badge variant="default" size="sm" className={providerInfo.color}>
            {providerInfo.label}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          {latencyMs !== null && (
            <span className="text-2xs text-surface-400 font-mono">
              {formatLatency(latencyMs)}
            </span>
          )}
          <Badge variant={statusVariant} size="sm">
            {status}
          </Badge>
        </div>
      </div>

      {/* Content */}
      <div className="p-4">
        {status === 'running' && (
          <div className="flex items-center gap-2 text-sm text-surface-500 dark:text-surface-400">
            <svg
              className="h-4 w-4 animate-spin"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle className="opacity-25" cx="12" cy="12" r="10" />
              <path
                className="opacity-75"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                fill="currentColor"
                stroke="none"
              />
            </svg>
            Evaluating...
          </div>
        )}

        {status === 'error' && (
          <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 rounded-lg p-3">
            <p className="font-medium">Error</p>
            <p className="mt-1 text-xs">{error || 'Unknown error occurred'}</p>
          </div>
        )}

        {status === 'completed' && (
          <>
            {/* Overall Score */}
            {mode === 'judge' && overallScore !== null && (
              <div className="mb-3 flex items-baseline gap-2">
                <span
                  className={cn(
                    'text-3xl font-bold font-mono',
                    getScoreColor(overallScore)
                  )}
                >
                  {overallScore.toFixed(1)}
                </span>
                <span className="text-sm text-surface-400">/10</span>
                {tokenCount && (
                  <span className="ml-auto text-2xs text-surface-400">
                    {tokenCount.toLocaleString()} tokens
                  </span>
                )}
              </div>
            )}

            {/* Criteria Scores */}
            {mode === 'judge' && criteriaScores.length > 0 && (
              <div className="mb-3 space-y-2">
                <h4 className="text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase tracking-wider">
                  Criteria Scores
                </h4>
                <div className="space-y-1.5">
                  {criteriaScores.map((cs) => {
                    const ratio = cs.maxScore > 0 ? cs.score / cs.maxScore : 0;
                    return (
                    <div key={cs.criterionId} className="flex items-center gap-2">
                      <span className="text-xs text-surface-600 dark:text-surface-400 flex-1 truncate">
                        {cs.criterionName}
                      </span>
                      <div className="flex items-center gap-1">
                        <div className="w-16 h-1.5 bg-surface-100 dark:bg-surface-700 rounded-full overflow-hidden">
                          <div
                            className={cn(
                              'h-full rounded-full transition-all',
                              ratio >= 0.8
                                ? 'bg-emerald-500'
                                : ratio >= 0.6
                                  ? 'bg-blue-500'
                                  : ratio >= 0.4
                                    ? 'bg-amber-500'
                                    : 'bg-red-500'
                            )}
                            style={{
                              width: `${ratio * 100}%`,
                            }}
                          />
                        </div>
                        <span className="text-xs font-mono text-surface-600 dark:text-surface-400 w-10 text-right">
                          {cs.score}/{cs.maxScore}
                        </span>
                      </div>
                    </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Reasoning */}
            {reasoning && (
              <div>
                <h4 className="text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase tracking-wider mb-1">
                  {mode === 'respond' ? 'Response' : 'Reasoning'}
                </h4>
                <p className={cn(
                  'text-sm text-surface-700 dark:text-surface-300 leading-relaxed whitespace-pre-wrap',
                  !expandedReasoning && 'line-clamp-4'
                )}>
                  {reasoning}
                </p>
              </div>
            )}
          </>
        )}

        {status === 'pending' && (
          <p className="text-sm text-surface-400 italic">
            Waiting to be evaluated...
          </p>
        )}
      </div>

      {/* Selection indicator */}
      {isSelected && (
        <div className="px-4 pb-3">
          <Badge variant="info" size="md">
            ★ Selected as Best
          </Badge>
        </div>
      )}
    </div>
  );
}
