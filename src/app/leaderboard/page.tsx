'use client';

import React, { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

interface LeaderboardModel {
  modelId: string;
  modelName: string;
  provider: string;
  providerModelId: string;
  avgScore: number;
  medianScore: number;
  minScore: number;
  maxScore: number;
  evaluationCount: number;
  completedRuns: number;
}

interface LeaderboardData {
  project: { id: string; name: string; description: string | null } | null;
  models: LeaderboardModel[];
  totalEvaluations: number;
  totalJudgments: number;
  lastUpdated: string | null;
  message?: string;
}

type SortKey = 'rank' | 'avgScore' | 'medianScore' | 'evaluationCount' | 'modelName';

const providerColors: Record<string, string> = {
  anthropic: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  openai: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  local: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
};

function scoreColor(score: number): string {
  if (score >= 8) return 'text-emerald-600 dark:text-emerald-400';
  if (score >= 6) return 'text-amber-600 dark:text-amber-400';
  if (score >= 4) return 'text-orange-600 dark:text-orange-400';
  return 'text-red-600 dark:text-red-400';
}

function rankBadge(rank: number): React.ReactNode {
  if (rank === 1) {
    return <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300 font-bold text-sm">1</span>;
  }
  if (rank === 2) {
    return <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-surface-200 dark:bg-surface-700 text-surface-700 dark:text-surface-300 font-bold text-sm">2</span>;
  }
  if (rank === 3) {
    return <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-orange-100 dark:bg-orange-900/50 text-orange-700 dark:text-orange-300 font-bold text-sm">3</span>;
  }
  return <span className="inline-flex items-center justify-center w-8 h-8 text-surface-500 font-medium text-sm">{rank}</span>;
}

export default function LeaderboardPage() {
  const [data, setData] = useState<LeaderboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>('avgScore');
  const [sortAsc, setSortAsc] = useState(false);

  useEffect(() => {
    fetch('/api/leaderboard')
      .then((res) => res.json())
      .then((d) => setData(d))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortAsc(!sortAsc);
    } else {
      setSortKey(key);
      setSortAsc(key === 'modelName'); // default asc for name, desc for scores
    }
  };

  const sortedModels = data?.models
    ? [...data.models].sort((a, b) => {
        let cmp = 0;
        switch (sortKey) {
          case 'avgScore':
            cmp = a.avgScore - b.avgScore;
            break;
          case 'medianScore':
            cmp = a.medianScore - b.medianScore;
            break;
          case 'evaluationCount':
            cmp = a.evaluationCount - b.evaluationCount;
            break;
          case 'modelName':
            cmp = a.modelName.localeCompare(b.modelName);
            break;
          default:
            cmp = a.avgScore - b.avgScore;
        }
        return sortAsc ? cmp : -cmp;
      })
    : [];

  const SortHeader = ({ label, sortId, className }: { label: string; sortId: SortKey; className?: string }) => (
    <button
      onClick={() => handleSort(sortId)}
      className={cn(
        'flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-surface-500 dark:text-surface-400 hover:text-surface-900 dark:hover:text-surface-200 transition-colors',
        className
      )}
    >
      {label}
      {sortKey === sortId && (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={cn('transition-transform', sortAsc && 'rotate-180')}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      )}
    </button>
  );

  return (
    <div className="min-h-screen bg-surface-50 dark:bg-surface-900">
      {/* Header */}
      <div className="border-b border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800/50">
        <div className="max-w-6xl mx-auto px-6 py-8">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-bold text-surface-900 dark:text-surface-100">
                Leaderboard
              </h1>
              <p className="mt-1 text-sm text-surface-500 dark:text-surface-400">
                {data?.project?.description || 'Model performance rankings from LLM-as-a-Judge evaluations'}
              </p>
            </div>
            {data?.lastUpdated && (
              <div className="text-xs text-surface-400 dark:text-surface-500 mt-1">
                Last updated: {new Date(data.lastUpdated).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </div>
            )}
          </div>

          {/* Stats bar */}
          {data && (
            <div className="flex gap-6 mt-4">
              <div className="text-sm">
                <span className="text-surface-400 dark:text-surface-500">Models: </span>
                <span className="font-semibold text-surface-900 dark:text-surface-100">{data.models.length}</span>
              </div>
              <div className="text-sm">
                <span className="text-surface-400 dark:text-surface-500">Evaluations: </span>
                <span className="font-semibold text-surface-900 dark:text-surface-100">{data.totalEvaluations}</span>
              </div>
              <div className="text-sm">
                <span className="text-surface-400 dark:text-surface-500">Judgments: </span>
                <span className="font-semibold text-surface-900 dark:text-surface-100">{data.totalJudgments}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="max-w-6xl mx-auto px-6 py-6">
        {loading ? (
          <div className="space-y-3">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-16 rounded-lg bg-surface-100 dark:bg-surface-800 animate-pulse" />
            ))}
          </div>
        ) : !data || !data.project ? (
          <div className="text-center py-16">
            <div className="text-surface-400 dark:text-surface-500 text-sm">
              {data?.message || 'No leaderboard data available.'}
            </div>
          </div>
        ) : sortedModels.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-surface-400 dark:text-surface-500 text-sm">
              No model evaluations completed yet. Run evaluations in the leaderboard project to populate rankings.
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 overflow-hidden">
            {/* Table header */}
            <div className="grid grid-cols-[3.5rem_1fr_7rem_5rem_5rem_4.5rem_4.5rem_5rem] gap-4 px-4 py-3 border-b border-surface-100 dark:border-surface-700 bg-surface-50 dark:bg-surface-800/80">
              <SortHeader label="#" sortId="rank" />
              <SortHeader label="Model" sortId="modelName" />
              <span className="text-xs font-semibold uppercase tracking-wider text-surface-500 dark:text-surface-400">Provider</span>
              <SortHeader label="Avg" sortId="avgScore" />
              <SortHeader label="Median" sortId="medianScore" />
              <span className="text-xs font-semibold uppercase tracking-wider text-surface-500 dark:text-surface-400">Min</span>
              <span className="text-xs font-semibold uppercase tracking-wider text-surface-500 dark:text-surface-400">Max</span>
              <SortHeader label="Evals" sortId="evaluationCount" />
            </div>

            {/* Table rows */}
            {sortedModels.map((model, index) => {
              const rank = sortKey === 'avgScore' && !sortAsc ? index + 1 : null;
              return (
                <div
                  key={model.modelId}
                  className={cn(
                    'grid grid-cols-[3.5rem_1fr_7rem_5rem_5rem_4.5rem_4.5rem_5rem] gap-4 px-4 py-3 items-center transition-colors',
                    'hover:bg-surface-50 dark:hover:bg-surface-700/30',
                    index > 0 && 'border-t border-surface-100 dark:border-surface-700/50',
                    rank === 1 && 'bg-amber-50/50 dark:bg-amber-900/10'
                  )}
                >
                  {/* Rank */}
                  <div className="flex justify-center">
                    {rank !== null ? rankBadge(rank) : (
                      <span className="text-sm text-surface-400">{index + 1}</span>
                    )}
                  </div>

                  {/* Model name */}
                  <div className="min-w-0">
                    <div className="font-medium text-sm text-surface-900 dark:text-surface-100 truncate">
                      {model.modelName}
                    </div>
                    <div className="text-xs text-surface-400 dark:text-surface-500 truncate font-mono">
                      {model.providerModelId}
                    </div>
                  </div>

                  {/* Provider */}
                  <div>
                    <span className={cn(
                      'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium capitalize',
                      providerColors[model.provider] || 'bg-surface-100 text-surface-600 dark:bg-surface-700 dark:text-surface-300'
                    )}>
                      {model.provider}
                    </span>
                  </div>

                  {/* Avg score */}
                  <div className={cn('text-sm font-bold tabular-nums', scoreColor(model.avgScore))}>
                    {model.avgScore.toFixed(2)}
                  </div>

                  {/* Median */}
                  <div className={cn('text-sm tabular-nums', scoreColor(model.medianScore))}>
                    {model.medianScore.toFixed(2)}
                  </div>

                  {/* Min */}
                  <div className="text-sm tabular-nums text-surface-500 dark:text-surface-400">
                    {model.minScore.toFixed(1)}
                  </div>

                  {/* Max */}
                  <div className="text-sm tabular-nums text-surface-500 dark:text-surface-400">
                    {model.maxScore.toFixed(1)}
                  </div>

                  {/* Eval count */}
                  <div className="text-sm tabular-nums text-surface-500 dark:text-surface-400">
                    {model.evaluationCount}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Score scale legend */}
        {sortedModels.length > 0 && (
          <div className="flex items-center gap-4 mt-4 text-xs text-surface-400 dark:text-surface-500">
            <span>Score scale: 0-10</span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-emerald-500" /> 8-10 Excellent
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-amber-500" /> 6-8 Good
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-orange-500" /> 4-6 Fair
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-red-500" /> 0-4 Poor
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
