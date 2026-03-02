'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Header } from '@/components/layout/header';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDate } from '@/lib/utils';

interface Evaluation {
  id: string;
  title: string;
  status: string;
  inputText: string;
  createdAt: string;
  updatedAt: string;
  project: {
    id: string;
    name: string;
  };
  rubric?: {
    id: string;
    name: string;
    version: number;
  } | null;
  modelJudgments: {
    id: string;
    status: string;
    overallScore: number | null;
    modelConfig: {
      name: string;
      provider: string;
    };
  }[];
  humanJudgment?: {
    overallScore: number;
  } | null;
}

const statusConfig: Record<string, { label: string; variant: 'default' | 'success' | 'warning' | 'error' }> = {
  pending: { label: 'Pending', variant: 'default' },
  judging: { label: 'Judging', variant: 'warning' },
  completed: { label: 'Completed', variant: 'success' },
  error: { label: 'Error', variant: 'error' },
};

export default function EvaluationsPage() {
  const [evaluations, setEvaluations] = useState<Evaluation[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'pending' | 'completed' | 'error'>('all');
  const [search, setSearch] = useState('');

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/api/evaluations');
        if (res.ok) {
          setEvaluations(await res.json());
        }
      } catch (err) {
        console.error('Failed to load evaluations:', err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const filtered = evaluations.filter((ev) => {
    if (filter !== 'all' && ev.status !== filter) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        ev.title.toLowerCase().includes(q) ||
        ev.project.name.toLowerCase().includes(q) ||
        ev.inputText.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const counts = {
    all: evaluations.length,
    pending: evaluations.filter((e) => e.status === 'pending' || e.status === 'judging').length,
    completed: evaluations.filter((e) => e.status === 'completed').length,
    error: evaluations.filter((e) => e.status === 'error').length,
  };

  return (
    <div>
      <Header
        title="Evaluation History"
        description="Browse all evaluations across your projects."
      />

      <div className="p-6 space-y-6">
        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            placeholder="Search evaluations..."
            className="flex-1 rounded-lg border border-surface-200 bg-white px-3 py-2 text-sm text-surface-900 placeholder:text-surface-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="flex gap-1.5">
            {(['all', 'pending', 'completed', 'error'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  filter === f
                    ? 'bg-brand-600 text-white'
                    : 'bg-surface-100 text-surface-600 hover:bg-surface-200'
                }`}
              >
                {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)} ({counts[f]})
              </button>
            ))}
          </div>
        </div>

        {/* Content */}
        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            title={search || filter !== 'all' ? 'No matching evaluations' : 'No evaluations yet'}
            description={
              search || filter !== 'all'
                ? 'Try adjusting your search or filter.'
                : 'Create a project and run your first evaluation to see it here.'
            }
          />
        ) : (
          <div className="space-y-3">
            {filtered.map((ev) => {
              const status = statusConfig[ev.status] || statusConfig.pending;
              const completedJudgments = ev.modelJudgments.filter(
                (j) => j.status === 'completed'
              );
              const avgScore =
                completedJudgments.length > 0
                  ? completedJudgments.reduce(
                      (sum, j) => sum + (j.overallScore ?? 0),
                      0
                    ) / completedJudgments.length
                  : null;

              return (
                <Link
                  key={ev.id}
                  href={`/projects/${ev.project.id}/evaluate/${ev.id}`}
                  className="block"
                >
                  <Card className="hover:border-brand-300 hover:shadow-sm transition-all cursor-pointer">
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <h3 className="text-sm font-semibold text-surface-900 truncate">
                              {ev.title}
                            </h3>
                            <Badge variant={status.variant} className="shrink-0">
                              {status.label}
                            </Badge>
                          </div>
                          <div className="flex items-center gap-3 text-xs text-surface-500 mb-2">
                            <span className="flex items-center gap-1">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                              </svg>
                              {ev.project.name}
                            </span>
                            {ev.rubric && (
                              <span className="flex items-center gap-1">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M9 11l3 3L22 4" />
                                  <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                                </svg>
                                {ev.rubric.name} v{ev.rubric.version}
                              </span>
                            )}
                            <span>{formatDate(ev.createdAt)}</span>
                          </div>
                          <p className="text-xs text-surface-400 line-clamp-1">
                            {ev.inputText.substring(0, 150)}
                          </p>
                        </div>

                        {/* Scores */}
                        <div className="flex items-center gap-3 shrink-0">
                          {avgScore !== null && (
                            <div className="text-center">
                              <div className="text-lg font-bold text-brand-600">
                                {avgScore.toFixed(1)}
                              </div>
                              <div className="text-2xs text-surface-400">
                                Model Avg
                              </div>
                            </div>
                          )}
                          {ev.humanJudgment && (
                            <div className="text-center">
                              <div className="text-lg font-bold text-emerald-600">
                                {ev.humanJudgment.overallScore.toFixed(1)}
                              </div>
                              <div className="text-2xs text-surface-400">
                                Human
                              </div>
                            </div>
                          )}
                          {completedJudgments.length > 0 && (
                            <div className="text-center">
                              <div className="text-sm font-medium text-surface-600">
                                {completedJudgments.length}
                              </div>
                              <div className="text-2xs text-surface-400">
                                Judges
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
