'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { Header } from '@/components/layout/header';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import type { AppStats } from '@/types';

function toList<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (
    payload &&
    typeof payload === 'object' &&
    'data' in payload &&
    Array.isArray((payload as { data: unknown }).data)
  ) {
    return (payload as { data: T[] }).data;
  }
  return [];
}

export default function DashboardPage() {
  const { data: session } = useSession();
  const [stats, setStats] = useState<AppStats | null>(null);
  const [recentEvaluations, setRecentEvaluations] = useState<any[]>([]);
  const [recentProject, setRecentProject] = useState<any | null>(null);
  const [leaderboard, setLeaderboard] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);

  const userName =
    session?.user?.name ||
    session?.user?.email?.split('@')[0] ||
    'there';

  useEffect(() => {
    async function loadDashboard() {
      try {
        const [statsRes, evalsRes, projectsRes] = await Promise.all([
          fetch('/api/stats'),
          fetch('/api/evaluations'),
          fetch('/api/projects'),
        ]);
        if (statsRes.ok) setStats(await statsRes.json());
        if (evalsRes.ok) {
          const evals = toList(await evalsRes.json());
          setRecentEvaluations(evals.slice(0, 5));
        }
        if (projectsRes.ok) {
          const projects = toList(await projectsRes.json());
          // Find the Leaderboard (default) project
          const lb = projects.find((p: any) => p.isDefault);
          setLeaderboard(lb ?? null);
          // Most recent non-default project
          const userProject = projects.find((p: any) => !p.isDefault);
          setRecentProject(userProject ?? null);
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
      iconWrap: 'border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/30',
      iconColor: 'text-blue-700 dark:text-blue-300',
    },
    {
      label: 'Evaluations',
      value: stats?.totalEvaluations ?? 0,
      href: '/projects',
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 11l3 3L22 4" />
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>
      ),
      iconWrap: 'border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30',
      iconColor: 'text-emerald-700 dark:text-emerald-300',
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
      iconWrap: 'border-purple-200 bg-purple-50 dark:border-purple-800 dark:bg-purple-950/30',
      iconColor: 'text-purple-700 dark:text-purple-300',
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
      iconWrap: 'border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30',
      iconColor: 'text-amber-700 dark:text-amber-300',
    },
    {
      label: 'Datasets',
      value: stats?.totalDatasets ?? 0,
      href: '/datasets',
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <ellipse cx="12" cy="5" rx="9" ry="3" />
          <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
          <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
        </svg>
      ),
      iconWrap: 'border-cyan-200 bg-cyan-50 dark:border-cyan-800 dark:bg-cyan-950/30',
      iconColor: 'text-cyan-700 dark:text-cyan-300',
    },
  ];

  return (
    <div>
      <Header
        title={`Welcome Back, ${userName}`}
        description="Overview of your LLM evaluation workspace"
        actions={
          <div className="flex items-center gap-2">
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
                Create Project
              </Button>
            </Link>
            <Link href="/rubrics">
              <Button variant="primary" size="sm">
                Build Rubric
              </Button>
            </Link>
            <Link href="/models">
              <Button variant="primary" size="sm">
                Configure Models
              </Button>
            </Link>
          </div>
        }
      />

      <div className="p-6 space-y-6">
        {/* Stats Grid */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {statCards.map((stat) => (
            <Link key={stat.label} href={stat.href}>
              <Card interactive className="h-full">
                <CardContent className="pt-5 h-full">
                  <div className="flex h-full items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-surface-500 dark:text-surface-400 uppercase tracking-wider whitespace-nowrap">
                        {stat.label}
                      </p>
                      {loading ? (
                        <Skeleton className="h-8 w-16 mt-1" />
                      ) : (
                        <p className="text-2xl font-bold leading-none text-surface-900 dark:text-surface-100 mt-1">
                          {stat.value}
                        </p>
                      )}
                    </div>
                    <div
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border ${stat.iconWrap} ${stat.iconColor}`}
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

        <div className="space-y-6">
          {/* Leaderboard CTA */}
          {!loading && leaderboard && (
            <Link href={`/projects/${leaderboard.id}`}>
              <Card
                interactive
                className="border-blue-200 dark:border-blue-800 bg-gradient-to-r from-blue-50 to-cyan-50 dark:from-blue-950/25 dark:to-cyan-950/20 hover:from-blue-100 hover:to-cyan-100 dark:hover:from-blue-950/35 dark:hover:to-cyan-950/30 transition-colors"
              >
                <CardContent className="pt-5 pb-5">
                  <div className="flex items-center gap-4">
                    <div className="rounded-xl border border-blue-200 dark:border-blue-800 bg-blue-100 dark:bg-blue-900/40 p-3">
                      <svg
                        width="24"
                        height="24"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="text-blue-600 dark:text-blue-300"
                      >
                        <path d="M8 21h8M12 17v4M7 4h10M4 8h16M5 4v4M19 4v4M9 8v3a3 3 0 0 0 6 0V8" />
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <h2 className="text-base font-bold text-surface-900 dark:text-surface-100">
                        Leaderboard
                      </h2>
                      <p className="text-sm text-surface-600 dark:text-surface-400 mt-0.5">
                        Evaluate models against public datasets and benchmark performance
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Badge variant="success" size="sm" className="font-semibold">
                        Public
                      </Badge>
                      <Badge variant="default" size="sm" className="dark:bg-surface-700 dark:text-surface-200 dark:border-surface-600">
                        {leaderboard._count?.evaluations ?? 0} evaluations
                      </Badge>
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="text-surface-400 dark:text-surface-300"
                      >
                        <polyline points="9 18 15 12 9 6" />
                      </svg>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          )}

          <Card>
            <CardContent className="pt-5">
            <div className="flex items-center justify-between gap-3 mb-2.5">
              <h2 className="text-sm font-semibold text-surface-700 dark:text-surface-300">
                Jump back into a project
              </h2>
              <Link
                href="/projects"
                className="text-xs text-brand-600 hover:text-brand-700 font-medium"
              >
                View all projects →
              </Link>
            </div>

            {loading ? (
              <Skeleton className="h-36 w-full rounded-xl" />
            ) : !recentProject ? (
              <div className="rounded-xl border border-dashed border-surface-300 dark:border-surface-600 p-6 text-center">
                <p className="text-sm text-surface-500 dark:text-surface-400 mb-3">
                  No projects yet. Create your first project to start evaluating.
                </p>
                <Link href="/projects">
                  <Button variant="primary" size="sm">
                    Create Project
                  </Button>
                </Link>
              </div>
            ) : (
              <Link
                href={`/projects/${recentProject.id}`}
                className="block rounded-xl border border-surface-200 dark:border-surface-700 p-5 hover:border-brand-300 dark:hover:border-brand-600 hover:bg-brand-50/30 dark:hover:bg-brand-950/20 transition-colors"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-base font-semibold text-surface-900 dark:text-surface-100 truncate">
                      {recentProject.name}
                    </p>
                    {recentProject.description && (
                      <p className="text-sm text-surface-500 dark:text-surface-400 mt-1 line-clamp-2">
                        {recentProject.description}
                      </p>
                    )}
                    <p className="text-xs text-surface-400 mt-2">
                      Last edited {new Date(recentProject.updatedAt).toLocaleDateString()}
                    </p>
                  </div>
                  <Badge variant="default" size="sm" className="dark:bg-surface-700 dark:text-surface-200 dark:border-surface-600">
                    {recentProject._count?.evaluations ?? 0} evaluations
                  </Badge>
                </div>
                <div className="mt-4">
                  <Button variant="primary" size="sm">
                    Jump back into project
                  </Button>
                </div>
              </Link>
            )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-5">
              <div className="flex items-center justify-between mb-2.5">
                <h2 className="text-sm font-semibold text-surface-700 dark:text-surface-300">
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
                <div className="divide-y divide-surface-100 dark:divide-surface-700">
                  {recentEvaluations.map((evaluation: any) => (
                    <Link
                      key={evaluation.id}
                      href={`/evaluate/${evaluation.id}`}
                      className="flex items-center gap-3 py-3 hover:bg-surface-50 dark:bg-surface-800 dark:hover:bg-surface-700 -mx-2 px-2 rounded-lg transition-colors"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-surface-900 dark:text-surface-100 truncate">
                          {evaluation.title || 'Untitled Evaluation'}
                        </p>
                        <p className="text-xs text-surface-400 truncate">
                          {evaluation.project?.name} ·{' '}
                          {new Date(evaluation.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5">
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
                              <Badge variant="default" size="sm" className="dark:bg-surface-700 dark:text-surface-200 dark:border-surface-600">
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
        </div>

        {/* Getting Started Guide */}
        {!loading && stats && stats.totalEvaluations === 0 && (
          <Card className="border-brand-200 dark:border-brand-700 bg-brand-50/50 dark:bg-brand-950/20">
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
