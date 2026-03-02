'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Header } from '@/components/layout/header';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import type { AppStats } from '@/types';

export default function DashboardPage() {
  const [stats, setStats] = useState<AppStats | null>(null);
  const [recentEvaluations, setRecentEvaluations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadDashboard() {
      try {
        const [statsRes, evalsRes] = await Promise.all([
          fetch('/api/stats'),
          fetch('/api/evaluations'),
        ]);
        if (statsRes.ok) setStats(await statsRes.json());
        if (evalsRes.ok) {
          const evals = await evalsRes.json();
          setRecentEvaluations(evals.slice(0, 5));
        }
      } catch (err) {
        console.error('Failed to load dashboard:', err);
      } finally {
        setLoading(false);
      }
    }
    loadDashboard();
  }, []);

  const statCards = [
    {
      label: 'Projects',
      value: stats?.totalProjects ?? 0,
      href: '/projects',
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
      ),
      color: 'text-blue-600 bg-blue-50',
    },
    {
      label: 'Evaluations',
      value: stats?.totalEvaluations ?? 0,
      sub: `${stats?.completedEvaluations ?? 0} completed`,
      href: '/projects',
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 11l3 3L22 4" />
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>
      ),
      color: 'text-emerald-600 bg-emerald-50',
    },
    {
      label: 'Active Models',
      value: stats?.activeModels ?? 0,
      href: '/models',
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2L2 7l10 5 10-5-10-5z" />
          <path d="M2 17l10 5 10-5" />
          <path d="M2 12l10 5 10-5" />
        </svg>
      ),
      color: 'text-purple-600 bg-purple-50',
    },
    {
      label: 'Rubrics',
      value: stats?.totalRubrics ?? 0,
      href: '/rubrics',
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="8" y1="6" x2="21" y2="6" />
          <line x1="8" y1="12" x2="21" y2="12" />
          <line x1="8" y1="18" x2="21" y2="18" />
          <line x1="3" y1="6" x2="3.01" y2="6" />
          <line x1="3" y1="12" x2="3.01" y2="12" />
          <line x1="3" y1="18" x2="3.01" y2="18" />
        </svg>
      ),
      color: 'text-amber-600 bg-amber-50',
    },
  ];

  return (
    <div>
      <Header
        title="Dashboard"
        description="Overview of your LLM evaluation workspace"
        actions={
          <Link href="/projects">
            <Button variant="primary" size="sm">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
              New Project
            </Button>
          </Link>
        }
      />

      <div className="p-6 space-y-6">
        {/* Stats Grid */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {statCards.map((stat) => (
            <Link key={stat.label} href={stat.href}>
              <Card interactive className="h-full">
                <CardContent className="pt-5">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-xs font-medium text-surface-500 uppercase tracking-wider">
                        {stat.label}
                      </p>
                      {loading ? (
                        <Skeleton className="h-8 w-16 mt-1" />
                      ) : (
                        <p className="text-2xl font-bold text-surface-900 mt-1">
                          {stat.value}
                        </p>
                      )}
                      {stat.sub && !loading && (
                        <p className="text-xs text-surface-400 mt-0.5">
                          {stat.sub}
                        </p>
                      )}
                    </div>
                    <div
                      className={`rounded-lg p-2 ${stat.color}`}
                      aria-hidden="true"
                    >
                      {stat.icon}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>

        {/* Quick Actions */}
        <Card>
          <CardContent className="pt-5">
            <h2 className="text-sm font-semibold text-surface-700 mb-3">
              Quick Actions
            </h2>
            <div className="flex flex-wrap gap-2">
              <Link href="/projects">
                <Button variant="outline" size="sm">
                  Create Project
                </Button>
              </Link>
              <Link href="/rubrics">
                <Button variant="outline" size="sm">
                  Build Rubric
                </Button>
              </Link>
              <Link href="/models">
                <Button variant="outline" size="sm">
                  Configure Models
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>

        {/* Recent Evaluations */}
        <Card>
          <CardContent className="pt-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-surface-700">
                Recent Evaluations
              </h2>
              <Link
                href="/projects"
                className="text-xs text-brand-600 hover:text-brand-700 font-medium"
              >
                View all →
              </Link>
            </div>

            {loading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-14 w-full" />
                ))}
              </div>
            ) : recentEvaluations.length === 0 ? (
              <p className="text-sm text-surface-400 py-6 text-center">
                No evaluations yet. Create a project and submit your first text
                for evaluation.
              </p>
            ) : (
              <div className="divide-y divide-surface-100">
                {recentEvaluations.map((evaluation: any) => (
                  <Link
                    key={evaluation.id}
                    href={`/evaluate/${evaluation.id}`}
                    className="flex items-center gap-3 py-3 hover:bg-surface-50 -mx-2 px-2 rounded-lg transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-surface-900 truncate">
                        {evaluation.title || 'Untitled Evaluation'}
                      </p>
                      <p className="text-xs text-surface-400 truncate">
                        {evaluation.project?.name} ·{' '}
                        {new Date(evaluation.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {(() => {
                        const latestRun = (evaluation.runs ?? [])[0];
                        const runCount = (evaluation.runs ?? []).length;
                        const statusVariant =
                          latestRun?.status === 'completed' ? 'success'
                          : latestRun?.status === 'error' ? 'error'
                          : latestRun?.status === 'judging' ? 'info'
                          : 'default';
                        return (
                          <>
                            <Badge variant="default" size="sm">
                              {runCount} run{runCount === 1 ? '' : 's'}
                            </Badge>
                            {latestRun && (
                              <Badge variant={statusVariant} size="sm">
                                {latestRun.status}
                              </Badge>
                            )}
                          </>
                        );
                      })()}
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Getting Started Guide */}
        {!loading && stats && stats.totalEvaluations === 0 && (
          <Card className="border-brand-200 bg-brand-50/50">
            <CardContent className="pt-5">
              <h2 className="text-base font-semibold text-brand-900 mb-2">
                Getting Started with Judge Arena
              </h2>
              <div className="space-y-3 text-sm text-brand-800">
                <div className="flex items-start gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-200 text-brand-800 text-xs font-bold">
                    1
                  </span>
                  <div>
                    <p className="font-medium">Configure your models</p>
                    <p className="text-brand-600 text-xs">
                      Set up API keys and select which LLM models will act as
                      judges.
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-200 text-brand-800 text-xs font-bold">
                    2
                  </span>
                  <div>
                    <p className="font-medium">Create a rubric</p>
                    <p className="text-brand-600 text-xs">
                      Define the criteria and scoring scales for your
                      evaluations.
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-200 text-brand-800 text-xs font-bold">
                    3
                  </span>
                  <div>
                    <p className="font-medium">Submit text for evaluation</p>
                    <p className="text-brand-600 text-xs">
                      Create a project, paste your text, and let models judge it
                      alongside your human evaluation.
                    </p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
