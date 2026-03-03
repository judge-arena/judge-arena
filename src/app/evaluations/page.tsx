'use client';

import React, { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import { Header } from '@/components/layout/header';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { cn, formatDateTime, getScoreColor } from '@/lib/utils';
import { toast } from 'sonner';

// Evaluation run as returned nested inside templates from GET /api/evaluations
interface RunSummary {
  id: string;
  evaluationId: string;
  status: string;
  createdAt: string;
  triggeredBy: { id: string; name: string | null; email: string };
  rubric?: { id: string; name: string; version: number } | null;
  runModelSelections: { modelConfigId: string; modelConfig: { name: string; provider: string } }[];
  modelJudgments: { id: string; status: string; overallScore: number | null; modelConfig: { name: string } }[];
  humanJudgment?: { overallScore: number } | null;
  // injected by the client after flattening
  evaluationTitle: string | null;
  projectId: string;
  projectName: string;
}

const statusConfig: Record<string, { label: string; variant: 'default' | 'success' | 'warning' | 'error' | 'info' }> = {
  pending:     { label: 'Pending',      variant: 'warning' },
  judging:     { label: 'Judging',      variant: 'info' },
  needs_human: { label: 'Needs Human',  variant: 'warning' },
  completed:   { label: 'Completed',    variant: 'success' },
  error:       { label: 'Error',        variant: 'error' },
};

export default function EvaluationsPage() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'pending' | 'needs_human' | 'completed' | 'error'>('all');
  const [search, setSearch] = useState('');
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  // Close export menu on outside click
  useEffect(() => {
    if (!exportMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setExportMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [exportMenuOpen]);

  const handleExportEvaluations = (format: 'csv' | 'jsonl') => {
    const url = `/api/evaluations/export?format=${format}`;
    const link = document.createElement('a');
    link.href = url;
    link.download = '';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast.success(`Exporting all evaluations as ${format.toUpperCase()}…`);
  };

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/api/evaluations');
        if (res.ok) {
          const templates: any[] = await res.json();
          // Flatten all runs from all templates, injecting template/project context
          const flat: RunSummary[] = [];
          for (const template of templates) {
            for (const run of template.runs ?? []) {
              flat.push({
                ...run,
                evaluationTitle: template.title ?? null,
                projectId: template.project?.id ?? '',
                projectName: template.project?.name ?? '',
              });
            }
          }
          // Sort newest first
          flat.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
          setRuns(flat);
        }
      } catch (err) {
        console.error('Failed to load runs:', err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const filtered = runs.filter((run) => {
    // Status filter
    if (filter === 'pending' && run.status !== 'pending' && run.status !== 'judging') return false;
    if (filter === 'needs_human' && run.status !== 'needs_human') return false;
    if (filter === 'completed' && run.status !== 'completed') return false;
    if (filter === 'error' && run.status !== 'error') return false;

    // Text search
    if (search) {
      const q = search.toLowerCase();
      return (
        (run.evaluationTitle ?? '').toLowerCase().includes(q) ||
        run.projectName.toLowerCase().includes(q) ||
        run.id.toLowerCase().includes(q) ||
        (run.rubric?.name ?? '').toLowerCase().includes(q) ||
        (run.triggeredBy?.name ?? run.triggeredBy?.email ?? '').toLowerCase().includes(q)
      );
    }
    return true;
  });

  const counts = {
    all: runs.length,
    pending: runs.filter((r) => r.status === 'pending' || r.status === 'judging').length,
    needs_human: runs.filter((r) => r.status === 'needs_human').length,
    completed: runs.filter((r) => r.status === 'completed').length,
    error: runs.filter((r) => r.status === 'error').length,
  };

  return (
    <div>
      <Header
        title="Evaluation History"
        description="Browse all evaluation runs across your projects."
        actions={
          runs.length > 0 ? (
            <div className="relative" ref={exportMenuRef}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setExportMenuOpen((prev) => !prev)}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                Export All
              </Button>
              {exportMenuOpen && (
                <div className="absolute right-0 top-full mt-1 z-20 w-48 rounded-lg border border-surface-200 bg-white py-1 shadow-lg">
                  <button
                    className="w-full px-3 py-2 text-left text-sm text-surface-700 hover:bg-surface-50 transition-colors"
                    onClick={() => { handleExportEvaluations('csv'); setExportMenuOpen(false); }}
                  >
                    📄 Export as CSV
                  </button>
                  <button
                    className="w-full px-3 py-2 text-left text-sm text-surface-700 hover:bg-surface-50 transition-colors"
                    onClick={() => { handleExportEvaluations('jsonl'); setExportMenuOpen(false); }}
                  >
                    📋 Export as JSONL
                  </button>
                </div>
              )}
            </div>
          ) : undefined
        }
      />

      <div className="p-6 space-y-6">
        {/* ── Filters ── */}
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            placeholder="Search by title, project, rubric, or run ID…"
            className="flex-1 rounded-lg border border-surface-200 bg-white px-3 py-2 text-sm text-surface-900 placeholder:text-surface-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="flex gap-1.5 flex-wrap">
            {(['all', 'pending', 'needs_human', 'completed', 'error'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  filter === f
                    ? 'bg-brand-600 text-white'
                    : 'bg-surface-100 text-surface-600 hover:bg-surface-200'
                }`}
              >
                {f === 'all' ? 'All' : f === 'needs_human' ? 'Needs Human' : f.charAt(0).toUpperCase() + f.slice(1)} ({counts[f]})
              </button>
            ))}
          </div>
        </div>

        {/* ── Content ── */}
        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-28 rounded-xl" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            title={search || filter !== 'all' ? 'No matching runs' : 'No runs yet'}
            description={
              search || filter !== 'all'
                ? 'Try adjusting your search or filter.'
                : 'Open an evaluation template and press "New Run" to get started.'
            }
          />
        ) : (
          <div className="space-y-3">
            {filtered.map((run) => {
              const sc = statusConfig[run.status] ?? statusConfig.pending;
              const completedJudgments = run.modelJudgments.filter(
                (j) => j.status === 'completed' && j.overallScore !== null
              );
              const avgScore =
                completedJudgments.length > 0
                  ? completedJudgments.reduce((s, j) => s + (j.overallScore ?? 0), 0) /
                    completedJudgments.length
                  : null;

              return (
                <Link
                  key={run.id}
                  href={`/evaluate/${run.evaluationId}/runs/${run.id}`}
                  className="block"
                >
                  <Card className="hover:border-brand-300 hover:shadow-sm transition-all cursor-pointer">
                    <CardContent className="p-4">
                      <div className="flex items-start gap-4">
                        {/* ── Main info ── */}
                        <div className="min-w-0 flex-1">
                          {/* Title + status */}
                          <div className="flex flex-wrap items-center gap-2 mb-1">
                            <h3 className="text-sm font-semibold text-surface-900 truncate">
                              {run.evaluationTitle || 'Untitled Evaluation'}
                            </h3>
                            <Badge variant={sc.variant} size="sm">{sc.label}</Badge>
                          </div>

                          {/* Project / rubric / date */}
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-surface-500 mb-2">
                            <span className="flex items-center gap-1">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                              </svg>
                              {run.projectName}
                            </span>
                            {run.rubric && (
                              <span className="flex items-center gap-1">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <path d="M9 11l3 3L22 4" />
                                  <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                                </svg>
                                {run.rubric.name} v{run.rubric.version}
                              </span>
                            )}
                            <span>{formatDateTime(run.createdAt)}</span>
                          </div>

                          {/* Triggered by + model list */}
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs text-surface-500">
                              By{' '}
                              <span className="font-medium text-surface-700">
                                {run.triggeredBy?.name || run.triggeredBy?.email}
                              </span>
                            </span>
                            {run.runModelSelections.slice(0, 4).map((s) => (
                              <Badge key={s.modelConfigId} variant="default" size="sm">
                                {s.modelConfig.name}
                              </Badge>
                            ))}
                            {run.runModelSelections.length > 4 && (
                              <Badge variant="default" size="sm">
                                +{run.runModelSelections.length - 4} more
                              </Badge>
                            )}
                          </div>
                        </div>

                        {/* ── Scores ── */}
                        <div className="flex items-center gap-4 shrink-0">
                          {avgScore !== null && (
                            <div className="text-center">
                              <div className={cn('text-lg font-bold font-mono', getScoreColor(avgScore))}>
                                {avgScore.toFixed(1)}
                              </div>
                              <div className="text-2xs text-surface-400">Model Avg</div>
                            </div>
                          )}
                          {run.humanJudgment && (
                            <div className="text-center">
                              <div className={cn('text-lg font-bold font-mono', getScoreColor(run.humanJudgment.overallScore))}>
                                {run.humanJudgment.overallScore.toFixed(1)}
                              </div>
                              <div className="text-2xs text-surface-400">Human</div>
                            </div>
                          )}
                          {completedJudgments.length > 0 && (
                            <div className="text-center">
                              <div className="text-sm font-medium text-surface-600">
                                {completedJudgments.length}
                              </div>
                              <div className="text-2xs text-surface-400">Judges</div>
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
